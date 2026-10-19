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

/**
 * Search-result index (phase V, V2-C5 — SA search-result-index.ts adapted):
 * a run-scoped memory of every retrieval the agent already ran, injected as
 * context so a post-compaction model does not re-run the same searches. The
 * index lives in the contributor (not the history), so it survives history
 * compaction by construction; the section explicitly tells the model to go
 * deeper or change angle instead of repeating.
 */

import type { AgentScope, ContextContribution, ContextContributor } from "./contributor.js";
import type { RuntimeMessage, RuntimeToolCall } from "@sciencediscovery/runtime-core";

/** Retrieval tools whose results are worth remembering as "already searched". */
const INDEXED_TOOLS: ReadonlySet<string> = new Set([
  "concept_explore",
  "deep_dive",
  "doc_grep",
  "entity_unified_search",
  "kb_expand",
  "kb_search",
  "web_fetch",
  "web_search",
]);

const MAX_ENTRIES = 100;
const MAX_TITLES_PER_ENTRY = 3;
const MAX_SECTION_ENTRIES = 30;
const MAX_SECTION_CHARS = 4_000;
const MAX_TITLE_CHARS = 80;

interface IndexEntry {
  hitSummary: string;
  query: string;
  resultCount: string;
  tool: string;
}

function clipText(text: string, max: number): string {
  const clean = text.replaceAll(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function queryOf(call: RuntimeToolCall): string {
  const args = call.args as Record<string, unknown>;
  for (const key of ["query", "pattern", "url", "entity", "anchorId", "claim"]) {
    if (typeof args[key] === "string" && args[key]) return clipText(args[key] as string, 100);
  }
  return clipText(JSON.stringify(args), 100);
}

/** Best-effort hit count + top titles out of a tool result payload. */
function summarizeContent(content: string): { failed: boolean; resultCount: string; hitSummary: string } {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    // A structured failure is not a completed retrieval — the tool's own
    // contract invites a corrected retry (invalid regex, not-found), and the
    // index must not tell the model to skip it (review P2).
    if (typeof parsed.error === "string" || parsed.found === false) {
      return { failed: true, hitSummary: "", resultCount: "" };
    }
    for (const key of ["hits", "results", "matches", "sections", "documents", "neighbors", "evidence", "candidates"]) {
      const list = parsed[key];
      if (Array.isArray(list)) {
        const titles = list
          .slice(0, MAX_TITLES_PER_ENTRY)
          .map((item) => {
            if (item && typeof item === "object") {
              const record = item as Record<string, unknown>;
              for (const titleKey of ["docTitle", "title", "docName", "name", "docId", "section", "id"]) {
                if (typeof record[titleKey] === "string" && record[titleKey]) {
                  return clipText(record[titleKey] as string, MAX_TITLE_CHARS);
                }
              }
            }
            return undefined;
          })
          .filter((title): title is string => Boolean(title));
        const truncated = parsed.truncated === true ? "+" : "";
        return {
          failed: false,
          hitSummary: titles.length ? ` (top: ${titles.join(" | ")})` : "",
          resultCount: `${list.length}${truncated}`,
        };
      }
    }
    // The web broker envelope double-encodes its payload: {content: string,
    // invocation} — content holds the results JSON (web_search) or readable
    // text (web_fetch) (review P2).
    if (typeof parsed.content === "string") {
      try {
        const inner = JSON.parse(parsed.content) as Record<string, unknown>;
        const results = inner.results;
        if (Array.isArray(results)) {
          const titles = results
            .slice(0, MAX_TITLES_PER_ENTRY)
            .map((item) => (item && typeof item === "object" && typeof (item as Record<string, unknown>).title === "string"
              ? clipText((item as Record<string, unknown>).title as string, MAX_TITLE_CHARS)
              : undefined))
            .filter((title): title is string => Boolean(title));
          return {
            failed: false,
            hitSummary: titles.length ? ` (top: ${titles.join(" | ")})` : "",
            resultCount: `${results.length}`,
          };
        }
      } catch { /* readable text, not JSON — fall through to the size note */ }
      return { failed: false, hitSummary: "", resultCount: `${Math.round(parsed.content.length / 100) / 10}k chars` };
    }
    return { failed: false, hitSummary: "", resultCount: "payload" };
  } catch {
    // Non-JSON content (e.g. a guard-truncated payload): record its size only.
    return { failed: false, hitSummary: "", resultCount: `${Math.round(content.length / 100) / 10}k chars` };
  }
}

export class SearchResultIndex {
  private readonly entries: IndexEntry[] = [];

  /** Feed every tool result; non-retrieval tools are ignored, errors skipped. */
  observe(call: RuntimeToolCall, content: string, isError: boolean): void {
    if (isError || !INDEXED_TOOLS.has(call.name)) return;
    const { failed, hitSummary, resultCount } = summarizeContent(content);
    if (failed) return;
    this.entries.push({ hitSummary, query: queryOf(call), resultCount, tool: call.name });
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
  }

  get size(): number {
    return this.entries.length;
  }

  /** The context section, or undefined while nothing was searched yet. */
  section(): string | undefined {
    if (!this.entries.length) return undefined;
    const shown = this.entries.slice(-MAX_SECTION_ENTRIES);
    // Total section budget (review P2): older entries in the window drop
    // their title lists first — the (tool+query → count) anti-repeat core
    // is what must survive.
    const lines: string[] = [];
    let used = 0;
    for (let index = 0; index < shown.length; index += 1) {
      const entry = shown[index]!;
      const compact = index < shown.length - 10;
      const line = `${index + 1}. ${entry.tool}(${entry.query}) → ${entry.resultCount}${compact ? "" : entry.hitSummary}`;
      if (used + line.length > MAX_SECTION_CHARS && lines.length > 0) break;
      lines.push(line);
      used += line.length;
    }
    const omitted = this.entries.length - lines.length;
    return [
      "## Search history this run (already retrieved — do NOT repeat the same tool+query/anchor; go deeper with kb_expand/doc_grep on the hits, or change the angle/tool)",
      ...lines,
      ...(omitted > 0 ? [`… plus ${omitted} earlier retrievals`] : []),
    ].join("\n");
  }
}

/** Contributes the search index as a working-context section each turn it has entries. */
export class SearchIndexContributor<TMessage extends RuntimeMessage = RuntimeMessage>
implements ContextContributor<TMessage> {
  readonly id = "runtime.search-result-index";
  /** Awareness-only: never blocks a turn. */
  readonly required = false;

  constructor(
    private readonly index: SearchResultIndex,
    readonly scopes: readonly AgentScope[],
  ) {}

  async contribute(): Promise<ContextContribution<TMessage>> {
    const section = this.index.section();
    if (!section) return {};
    return {
      systemSections: [{
        content: section,
        id: this.id,
        protected: false,
        slot: "working_context" as const,
      }],
    };
  }
}
