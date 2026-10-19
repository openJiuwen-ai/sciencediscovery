// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * Resident-summary context contributor: injects a deterministic, size-capped
 * digest of each knowledge base's entity graph into the agent's working
 * context, so the model knows which KBs exist (and their maturity) before it
 * ever calls a tool. Depth scales with engine maturity (early/mid/converged)
 * inside each per-KB summary; this wrapper caps the total across KBs.
 */

import {
  ContextSectionContributor,
  type ContextContributorFactory,
} from "@sciencediscovery/context";
import { buildAntiHallucinationBrief } from "@sciencediscovery/knowledge-engine";
import type { RuntimeMessage } from "@sciencediscovery/runtime-core";

import type { KnowledgeEngineToolPort } from "./tools.js";

/** At most this many KB digests per turn (largest graphs first). */
const MAX_KBS_PER_TURN = 3;
/** Total section cap across all KB digests. */
const TOTAL_CAP_CHARS = 7_200;

export const KE_RESIDENT_SUMMARY_CONTRIBUTOR_ID = "knowledge-engine.resident-summary";
export const KE_ANTI_HALLUCINATION_SECTION_ID = "knowledge-engine.anti-hallucination";

/** KB names are user-supplied — never let one break the XML-ish markup. */
function escapeAttr(value: string): string {
  return value.replace(/[<>"&]/g, (char) => `&#${char.codePointAt(0)};`);
}

export function createKeResidentSummaryFactory<TMessage extends RuntimeMessage>(
  tools: KnowledgeEngineToolPort,
): ContextContributorFactory<TMessage> {
  return {
    id: KE_RESIDENT_SUMMARY_CONTRIBUTOR_ID,
    create({ scope }) {
      return new ContextSectionContributor<TMessage>({
        id: KE_RESIDENT_SUMMARY_CONTRIBUTOR_ID,
        scopes: [scope],
        // Awareness-only: a store hiccup must degrade to a diagnostic, never
        // fail the turn.
        required: false,
        contribute: async () => {
          const kbs = await tools.listKnowledgeBases();
          const withGraph = kbs
            .filter((kb) => kb.stats.entities > 0)
            .sort((a, b) => b.stats.entities - a.stats.entities)
            .slice(0, MAX_KBS_PER_TURN);
          if (withGraph.length === 0) return {};

          const parts: string[] = [];
          let used = 0;
          for (const kb of withGraph) {
            const summary = await tools.residentSummary(kb.id);
            if (!summary) continue;
            const block = `<knowledge_base id="${escapeAttr(kb.id)}" name="${escapeAttr(kb.name)}" stage="${summary.stage}">\n${summary.section}\n</knowledge_base>`;
            if (used + block.length > TOTAL_CAP_CHARS) break; // drop whole KB blocks, never mid-block
            parts.push(block);
            used += block.length;
          }
          if (parts.length === 0) return {};

          // W9 three-tier injection: the uncertain signals (open conflicts,
          // single-source entities) of the same tracked KBs, plus the
          // non-negotiable rules. Awareness-only like the digest above —
          // a store hiccup must degrade to skipping the section.
          const sections = [
            {
              content: [
                "<knowledge_engine>",
                "The following knowledge bases are available. Query them with concept_explore / deep_dive / entity_unified_search (entity lookup with verbatim evidence), validate_entities (check names before citing), kb_search (passage search) + kb_expand (read the anchor's context), doc_grep (regex), gap_candidates (structural research gaps), novelty_check / verify_citation (anti-hallucination checks), evidence_ledger (record the claims you will assert).",
                ...parts,
                "</knowledge_engine>",
              ].join("\n"),
              id: KE_RESIDENT_SUMMARY_CONTRIBUTOR_ID,
              protected: false,
              slot: "working_context" as const,
            },
          ];
          try {
            const brief = buildAntiHallucinationBrief(
              await Promise.all(withGraph.map((kb) => tools.kbRiskSignals(kb.id))),
            );
            if (brief) {
              sections.push({
                content: brief,
                id: KE_ANTI_HALLUCINATION_SECTION_ID,
                protected: false,
                slot: "working_context" as const,
              });
            }
          } catch {
            // The digest alone is still valid context.
          }
          return { systemSections: sections };
        },
      });
    },
  };
}
