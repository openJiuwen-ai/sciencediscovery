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
 * Deferred-tool discovery for the Node-native loop.
 *
 * Tools flagged `deferred` (large-schema MCP tools) are withheld from model
 * binding until discovered: the model sees their names in
 * `<available-deferred-tools>`, fetches full schemas via the synthetic
 * `tool_search` tool (which promotes them for the rest of the run), and
 * operator routing hints can auto-promote keyword-matched tools up front.
 * Calls to a still-hidden tool are rejected with a retryable error result.
 */

import { createHash } from "node:crypto";

import type { AgentTool } from "./types.js";

export const TOOL_SEARCH_NAME = "tool_search";
const MAX_RESULTS = 5;
const AUTO_PROMOTE_TOP_K = 3;

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function compileQueryRegex(pattern: string): RegExp {
  // Queries come from the model: an invalid regex degrades to a literal match.
  try {
    return new RegExp(pattern, "i");
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
}

function countMatches(pattern: string, haystack: string): number {
  try {
    return [...haystack.matchAll(new RegExp(pattern, "gi"))].length;
  } catch {
    const literal = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return [...haystack.matchAll(new RegExp(literal, "gi"))].length;
  }
}

function openAiFunctionSchema(tool: AgentTool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as unknown as Record<string, unknown>,
  };
}

export class DeferredToolCatalog {
  readonly names: ReadonlySet<string>;
  readonly hash: string;

  constructor(readonly tools: readonly AgentTool[]) {
    this.names = new Set(tools.map((tool) => tool.name));
    const canonical = [...tools]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((tool) => ({ name: tool.name, schema: openAiFunctionSchema(tool) }));
    this.hash = createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16);
  }

  search(rawQuery: string): AgentTool[] {
    const query = rawQuery.trim();
    if (!query) return [];

    if (query.startsWith("select:")) {
      // No cap: explicit selection must not silently drop requested schemas.
      const wanted = new Set(query.slice(7).split(",").map((name) => name.trim()));
      return this.tools.filter((tool) => wanted.has(tool.name));
    }

    if (query.startsWith("+")) {
      const parts = query.slice(1).split(/\s+/).filter(Boolean);
      if (!parts.length) return [];
      const required = (parts[0] ?? "").toLowerCase();
      const rest = parts.slice(1).join(" ");
      const candidates = this.tools.filter((tool) => tool.name.toLowerCase().includes(required));
      if (rest) {
        candidates.sort((a, b) =>
          countMatches(rest, `${b.name} ${b.description}`) - countMatches(rest, `${a.name} ${a.description}`));
      }
      return candidates.slice(0, MAX_RESULTS);
    }

    const regex = compileQueryRegex(query);
    const scored: Array<{ score: number; tool: AgentTool }> = [];
    for (const tool of this.tools) {
      if (regex.test(`${tool.name} ${tool.description}`)) {
        scored.push({ score: regex.test(tool.name) ? 2 : 1, tool });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_RESULTS).map((entry) => entry.tool);
  }
}

export interface DeferredToolState {
  catalog: DeferredToolCatalog;
  promoted: Set<string>;
}

export function buildDeferredToolState(tools: Iterable<AgentTool>): DeferredToolState | undefined {
  const deferred = [...tools].filter((tool) => tool.deferred);
  if (!deferred.length) return undefined;
  return { catalog: new DeferredToolCatalog(deferred), promoted: new Set() };
}

export function hiddenDeferredNames(state: DeferredToolState | undefined): Set<string> {
  if (!state) return new Set();
  return new Set([...state.catalog.names].filter((name) => !state.promoted.has(name)));
}

/** Run tool_search: promote matches and return the model-facing result text. */
export function runToolSearch(state: DeferredToolState, query: string): string {
  const matched = state.catalog.search(query);
  if (!matched.length) return `No tools found matching: ${query}`;
  for (const tool of matched) state.promoted.add(tool.name);
  return JSON.stringify(matched.map(openAiFunctionSchema), null, 2);
}

export function blockedDeferredToolResult(name: string): string {
  return `Error: Tool '${name}' is deferred and has not been promoted yet. Call tool_search first to expose and promote this tool's schema, then retry.`;
}

/** Auto-promote operator-hinted tools whose keywords match the user request. */
export function autoPromoteFromRouting(state: DeferredToolState | undefined, tools: Iterable<AgentTool>, userText: string): string[] {
  if (!state || !userText) return [];
  const haystack = userText.toLowerCase();
  const matched: Array<{ name: string; priority: number }> = [];
  for (const tool of tools) {
    if (!state.catalog.names.has(tool.name)) continue;
    const routing = tool.routing;
    if (!routing || routing.mode !== "prefer" || !routing.keywords.length) continue;
    if (routing.keywords.some((keyword) => keyword && haystack.includes(keyword.toLowerCase()))) {
      matched.push({ name: tool.name, priority: routing.priority });
    }
  }
  matched.sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
  const promoted = matched.slice(0, AUTO_PROMOTE_TOP_K).map((entry) => entry.name);
  for (const name of promoted) state.promoted.add(name);
  return promoted;
}

export const TOOL_SEARCH_SPEC = {
  description: [
    "Fetches full schema definitions for deferred tools so they can be called.",
    "Deferred tools appear by name in <available-deferred-tools> in the system prompt.",
    "Until fetched, only the name is known. This tool matches a query against the",
    "deferred tools and returns the matched tools complete schemas; once returned,",
    "a tool becomes callable.",
    "Query forms:",
    '  - "select:Read,Edit" -- fetch these exact tools by name',
    '  - "notebook jupyter" -- keyword search, up to max_results best matches',
    '  - "+slack send" -- require "slack" in the name, rank by remaining terms',
  ].join("\n"),
  name: TOOL_SEARCH_NAME,
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, description: "Tool name or keyword query. Use select:tool_a,tool_b for exact names." },
    },
    required: ["query"],
  },
} as const;

export function deferredToolsPromptSection(state: DeferredToolState | undefined): string {
  if (!state || !state.catalog.names.size) return "";
  const names = [...state.catalog.names].sort().map((name) => escapeHtml(name)).join("\n");
  return `<available-deferred-tools>\n${names}\n</available-deferred-tools>`;
}

function formatKeywordList(keywords: string[]): string {
  if (keywords.length === 1) return keywords[0] ?? "";
  return `${keywords.slice(0, -1).join(", ")}, or ${keywords[keywords.length - 1] ?? ""}`;
}

export function routingHintsPromptSection(tools: Iterable<AgentTool>, deferredNames: ReadonlySet<string>): string {
  const hints: Array<{ keywords: string[]; name: string; priority: number }> = [];
  for (const tool of tools) {
    const routing = tool.routing;
    if (!routing || routing.mode !== "prefer" || !routing.keywords.length) continue;
    hints.push({
      keywords: routing.keywords.map((keyword) => escapeHtml(String(keyword))),
      name: tool.name,
      priority: routing.priority,
    });
  }
  if (!hints.length) return "";
  hints.sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
  const lines = ["<mcp_routing_hints>"];
  for (const hint of hints) {
    const escapedName = escapeHtml(hint.name);
    lines.push(`When the user's request involves ${formatKeywordList(hint.keywords)}:`);
    lines.push(hint.name && deferredNames.has(hint.name)
      ? `  use \`tool_search\` to fetch \`${escapedName}\`, then prefer that MCP tool.`
      : `  prefer the \`${escapedName}\` tool.`);
  }
  lines.push("</mcp_routing_hints>");
  return lines.join("\n");
}
