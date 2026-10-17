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

import type { ToolTrace } from "@sciencediscovery/schema";

/** Only promote deliberately short task fields, never raw prompts or workspace paths. */
export function researchLabel(trace: Pick<ToolTrace, "args" | "input" | "name">): string {
  let args = trace.args;
  if (!args && trace.input) {
    try { args = JSON.parse(trace.input) as Record<string, unknown>; } catch { /* Legacy prose stays in details. */ }
  }
  for (const key of ["description", "query"]) {
    const value = args?.[key];
    if (typeof value === "string" && value.trim()) return compactStatus(value);
  }
  return trace.name;
}

export function compactStatus(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 160 ? text.slice(0, 157) + "…" : text;
}

/** Five physical lines, with head/tail retained; never a replacement for stored output. */
export function evidencePreview(value: string): string {
  const lines = value.split("\n").map(line => line.length > 160 ? line.slice(0, 80) + "…" + line.slice(-77) : line);
  return (lines.length > 5 ? [...lines.slice(0, 2), "…", ...lines.slice(-2)] : lines).join("\n");
}

/** Only deliberate Markdown headings become reasoning status, never deliberation prose. */
export function reasoningStatus(value: string): string | undefined {
  const headings = [...value.matchAll(/(?:^|\n)\s*(?:\*\*([^*\n]+)\*\*|#{1,6}\s+([^\n]+))/g)];
  const last = headings.at(-1);
  return last ? compactStatus(last[1] ?? last[2] ?? "") : undefined;
}

export function isExploration(name: string): boolean {
  return /(?:^|[_.-])(?:read|search|list|find|glob|grep)(?:$|[_.-])/i.test(name);
}

/** Explicit failure text is evidence, not an inferred tool lifecycle transition. */
export function reportedFailure(value: string): string | undefined {
  const line = value.split("\n").find(line => /^(?:error|failed|failure|source unavailable|network error|connection refused|permission denied)\b/i.test(line.trim()));
  return line ? compactStatus(line) : undefined;
}

/** Count returned literature records, never a provider's total-hit estimate or duplicate calls. */
export function returnedPaperCount(value: string): number | undefined {
  try {
    const result = JSON.parse(value) as { sourceId?: unknown; toolId?: unknown; records?: unknown } | null;
    return result && ["arxiv", "pubmed", "europe-pmc"].includes(String(result.sourceId))
      && result.toolId === "search" && Array.isArray(result.records) ? result.records.length : undefined;
  } catch { return undefined; }
}
