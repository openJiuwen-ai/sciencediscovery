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

/**
 * Splits a tool result text into displayable I/O sections. Execution tools
 * (`run_python`, shell) emit a labeled summary (`stdout:` / `stderr:` /
 * `created files:` / `produced artifacts:`), while other tools return plain
 * text or a JSON envelope. Anything the parser cannot attribute to a labeled
 * section lands in a residual Result section so no text is ever dropped.
 */
export type ToolResultSectionId = "created-files" | "produced-artifacts" | "result" | "stderr" | "stdout";

export interface ToolResultSection {
  /** Section body — exactly what the per-section copy button copies. */
  content: string;
  id: ToolResultSectionId;
  label: string;
}

const SECTION_MARKERS: Array<{ id: ToolResultSectionId; label: string; pattern: RegExp }> = [
  { id: "stdout", label: "stdout", pattern: /^stdout:[ \t]?(.*)$/ },
  { id: "stderr", label: "stderr", pattern: /^stderr:[ \t]?(.*)$/ },
  { id: "created-files", label: "Created files", pattern: /^created files:[ \t]?(.*)$/ },
  { id: "produced-artifacts", label: "Produced artifacts", pattern: /^produced artifacts:[ \t]?(.*)$/ },
];

/** Placeholder bodies the runner emits for an absent stream — carry no data. */
const EMPTY_BODY = /^\(empty\)$|^none$/;

/** Fields that typically carry a tool's primary human-meaningful input text. */
const PRIMARY_INPUT_FIELDS = ["code", "command", "query", "path", "url", "prompt", "content", "text", "input"];

function compactValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}

/**
 * Raw text for the Input section — the tool's meaningful argument text without
 * decorative re-serialization. Single-field args show the bare value; a known
 * primary text field (code / command / …) is shown verbatim with any remaining
 * fields listed compactly; otherwise fall back to the original serialized
 * input, or a compact (never pretty-printed) args payload.
 */
export function formatToolInput(trace: ToolTrace): string | undefined {
  const args = trace.args;
  if (!args || Object.keys(args).length === 0) return trace.input;
  const entries = Object.entries(args);
  if (entries.length === 1) {
    const only = entries[0];
    return only ? compactValue(only[1]) : trace.input;
  }
  const primary = PRIMARY_INPUT_FIELDS.find((field) => typeof args[field] === "string");
  if (primary !== undefined) {
    const head = args[primary] as string;
    const rest = entries
      .filter(([key]) => key !== primary)
      .map(([key, value]) => `${key}: ${compactValue(value)}`)
      .join("\n");
    return rest ? `${head}\n${rest}` : head;
  }
  return trace.input ?? JSON.stringify(args);
}

function matchSectionMarker(line: string): { id: ToolResultSectionId; inline: string; label: string } | undefined {
  for (const marker of SECTION_MARKERS) {
    const match = marker.pattern.exec(line);
    if (match) return { id: marker.id, inline: match[1] ?? "", label: marker.label };
  }
  return undefined;
}

function resultLabel(status: ToolTrace["status"]): string {
  return status === "failed" ? "Error" : "Result";
}

export function parseToolResultSections(text: string, status: ToolTrace["status"]): ToolResultSection[] {
  const labeled: ToolResultSection[] = [];
  const preamble: string[] = [];
  let current: { id: ToolResultSectionId; label: string; lines: string[] } | undefined;

  const flush = (): void => {
    if (!current) return;
    labeled.push({ content: current.lines.join("\n").replace(/\n+$/, ""), id: current.id, label: current.label });
    current = undefined;
  };

  for (const line of text.split("\n")) {
    const marker = matchSectionMarker(line);
    if (marker) {
      flush();
      current = { id: marker.id, label: marker.label, lines: marker.inline ? [marker.inline] : [] };
      continue;
    }
    if (current) current.lines.push(line);
    else preamble.push(line);
  }
  flush();

  const kept = labeled.filter((section) => {
    const body = section.content.trim();
    if (body === "") return false;
    // "stdout: (empty)" / "created files: none" are runner placeholders, not data.
    if (EMPTY_BODY.test(body)) return false;
    return true;
  });

  const residual = preamble.join("\n").trim();
  if (kept.length > 0) {
    return residual
      ? [{ content: residual, id: "result" as const, label: resultLabel(status) }, ...kept]
      : kept;
  }

  // Nothing segmentable: one residual section holds the whole raw text (no loss,
  // and no decorative pretty-print rewrite of e.g. JSON error envelopes).
  if (residual) return [{ content: residual, id: "result", label: resultLabel(status) }];
  // Every labeled section was an empty placeholder (e.g. "stdout: (empty)"):
  // fall back to the raw text so the card never renders a silent void.
  if (text.trim()) return [{ content: text, id: "result", label: resultLabel(status) }];
  return [];
}
