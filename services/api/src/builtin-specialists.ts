// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
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

import type { Specialist } from "@science-agent/schema";

/**
 * Built-in specialists seeded by the application. Each mirrors one of the
 * science-research-team role skills and is dispatched by name from the
 * orchestrator skill via the `task` tool's specialistId.
 *
 * Every field except `enabled` is intentionally fixed (read-only): the store
 * rejects edits to instructions/description/name/connectorIds/enabledSkillIds
 * on built-in specialists. The only user-facing mutation is toggling the
 * specialist's own `enabled` field (via the normal PUT /api/specialists/:id
 * path). Built-ins are seeded without an `enabled` key so they default to
 * enabled; a persisted `enabled: false` is honored on reload. Disabled
 * built-ins are filtered out of the task tool's specialistId enum, so the
 * leader will not dispatch a disabled role.
 *
 * `enabledSkillIds` points at the bundled skill of the same name so the role's
 * methodology (SKILL.md) is injected alongside these instructions. Only
 * literature-searcher mounts MCP connectors (the literature databases its
 * scripts also call directly).
 *
 * ids are stable strings (not UUIDs): catalog migration keys off them, so
 * they must not change across runs.
 */
export const BUILTIN_SPECIALISTS: readonly Specialist[] = Object.freeze([
  {
    builtIn: true,
    connectorIds: ["pubmed", "arxiv", "europe-pmc", "biorxiv", "medrxiv"],
    createdAt: "1970-01-01T00:00:00.000Z",
    description:
      "Literature retrieval agent: searches academic sources across arXiv, PubMed, and CrossRef and returns deduplicated source packages.",
    enabledSkillIds: ["literature-searcher"],
    id: "builtin-literature-searcher",
    instructions:
      "You are literature-searcher, the academic retrieval specialist for the research workflow.\n"
      + "Use the literature-searcher skill to retrieve verified academic source lists and produce deduplicated literature packages with coverage notes.\n"
      + "Search sources only. Do not read full papers deeply, extract evidence, evaluate results, coordinate other agents, or write final reports.\n"
      + "Prefer available scripts and real API calls when possible, document search queries and coverage limitations, and deliver outputs that evidence-extractor can consume.",
    name: "literature-searcher",
    updatedAt: "1970-01-01T00:00:00.000Z",
  },
  {
    builtIn: true,
    connectorIds: [],
    createdAt: "1970-01-01T00:00:00.000Z",
    description:
      "Evidence extraction agent: mines structured, source-grounded evidence from literature-searcher source packages.",
    enabledSkillIds: ["evidence-extractor"],
    id: "builtin-evidence-extractor",
    instructions:
      "You are evidence-extractor, the evidence mining specialist for the research workflow.\n"
      + "Use the evidence-extractor skill to extract structured claims, findings, statistics, methods, limitations, confidence, strength, and source citations from provided source packages.\n"
      + "Extract from known sources only. Do not search for new literature, coordinate agents, synthesize final conclusions, or write reports.\n"
      + "Preserve source anchors and identify extraction gaps clearly.\n"
      + "When the next step is to create, edit, inspect, verify, or write an evidence package, call the appropriate tool immediately. Do not stop after saying \"I will write\", \"Let me create\", or similar future-intent text.\n"
      + "For multi-source extraction, write evidence_items.json and any summary files via bash/write_file instead of composing large JSON inline in the chat response.\n"
      + "Before final delivery, verify required files exist with ls/read_file/bash as appropriate.",
    name: "evidence-extractor",
    updatedAt: "1970-01-01T00:00:00.000Z",
  },
  {
    builtIn: true,
    connectorIds: [],
    createdAt: "1970-01-01T00:00:00.000Z",
    description:
      "Code engineering agent: writes and executes reproducible Python/R analysis code with methodology documentation.",
    enabledSkillIds: ["code-engineer"],
    id: "builtin-code-engineer",
    instructions:
      "You are code-engineer, the executable analysis specialist for the research workflow.\n"
      + "Use the code-engineer skill to inspect data, write and run Python/R code, debug failures, and deliver reproducible computational results with complete methodology documentation.\n"
      + "Produce scripts, logs, outputs, statistics, dependency notes, random seeds, and environment information as required.\n"
      + "When the next step is to create, edit, run, inspect, or verify code, call the appropriate tool immediately. Do not stop after saying \"I will write\", \"Let me create\", or similar future-intent text.\n"
      + "Before final delivery, verify required files and outputs exist with ls/read_file/bash as appropriate.\n"
      + "Do not perform literature search, evidence extraction, result evaluation, or report synthesis.",
    name: "code-engineer",
    updatedAt: "1970-01-01T00:00:00.000Z",
  },
  {
    builtIn: true,
    connectorIds: [],
    createdAt: "1970-01-01T00:00:00.000Z",
    description:
      "Result evaluation agent: audits analysis outputs for reliability, methodology quality, and acceptance or revision decisions.",
    enabledSkillIds: ["result-evaluator"],
    id: "builtin-result-evaluator",
    instructions:
      "You are result-evaluator, the quality review specialist for the research workflow.\n"
      + "Use the result-evaluator skill to evaluate analysis results for accuracy, completeness, robustness, relevance, methodology quality, reproducibility, and source reliability.\n"
      + "Decide ACCEPT_AND_PROCEED or REVISE_AND_RETRY with concrete revision guidance.\n"
      + "Do not perform new analysis, modify results, search literature, or write final reports.",
    name: "result-evaluator",
    updatedAt: "1970-01-01T00:00:00.000Z",
  },
  {
    builtIn: true,
    connectorIds: [],
    createdAt: "1970-01-01T00:00:00.000Z",
    description:
      "Report writing agent: synthesizes domain summaries into the requested final report format without adding new findings.",
    enabledSkillIds: ["report-writer"],
    id: "builtin-report-writer",
    instructions:
      "You are report-writer, the final synthesis specialist for the research workflow.\n"
      + "Use the report-writer skill to receive integrated Domain Summaries, identify SUPPORTS/CONTRADICTS/INFORMS/INDEPENDENT relationships, surface contradictions verbatim, and produce the user's requested output format.\n"
      + "If the user did not specify a format, use the default report structure from the skill.\n"
      + "Do not perform new research, run analysis, evaluate results, resolve contradictions, or invent missing findings.",
    name: "report-writer",
    updatedAt: "1970-01-01T00:00:00.000Z",
  },
]);

export const BUILTIN_SPECIALIST_IDS: readonly string[] = Object.freeze(
  BUILTIN_SPECIALISTS.map((specialist) => specialist.id),
);
