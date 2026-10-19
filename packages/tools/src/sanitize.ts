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
 * Neutralize prompt-injection control tokens in untrusted remote tool results.
 *
 * Remote content the agent fetches (web page bodies, search snippets) is
 * attacker-influenceable, yet it enters the model context as a tool result. A
 * page could embed a forged `<system-reminder>` block (or a
 * `--- END USER INPUT ---` boundary marker) and have it reach the model as
 * authoritative framework context.
 *
 * Only results of the remote-content tools are neutralized: framework tags are
 * HTML-escaped and boundary markers are replaced with inert look-alikes. Local
 * tool output (shell, file reads) is left untouched so legitimate code and logs
 * are never mangled.
 */

/** Tools whose results are attacker-influenceable remote content. */
export const REMOTE_CONTENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "web_capture",
  "web_fetch",
  "web_search",
  "image_search",
]);

/**
 * Framework authority blocks this product injects into model input, plus
 * generic injection-tag patterns. Forged in fetched content, any of them mimics
 * trusted framework context.
 *
 * The framework half of this list is pinned by
 * `sanitize.test.ts` → "denylist covers every framework authority block", which
 * scans the prompt sources. Add the tag here when a new block is introduced;
 * that test fails otherwise.
 */
export const BLOCKED_TAG_NAMES: ReadonlySet<string> = new Set([
  // Blocks this product emits into model input.
  "available-deferred-tools",
  "available_skills",
  "durable_context_data",
  "mcp_routing_hints",
  "plan_state",
  "run_contract",
  "skill_system",
  "subagent_system",
  "system-reminder",
  "system_reminder",
  // Generic authority/injection patterns.
  "analysis",
  "current_date",
  "ignore",
  "important",
  "instruction",
  "memory",
  "override",
  "prompt",
  "role",
  "system",
  "think",
]);

const BLOCKED_TAG_PATTERN = new RegExp(
  `<\\s*/?\\s*(?:${[...BLOCKED_TAG_NAMES]
    .sort()
    .map((name) => name.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
    .join("|")})\\b[^>]*>?`,
  "gi",
);

const USER_INPUT_BEGIN = "--- BEGIN USER INPUT ---";
const USER_INPUT_END = "--- END USER INPUT ---";
const NEUTRALIZED_BEGIN = "[BEGIN USER INPUT]";
const NEUTRALIZED_END = "[END USER INPUT]";

/** Escape blocked framework tags and replace user-input boundary markers. */
export function neutralizeUntrustedTags(text: string): string {
  const escaped = text.replaceAll(BLOCKED_TAG_PATTERN, (match) =>
    match.replaceAll("<", "&lt;").replaceAll(">", "&gt;"));
  return escaped.replaceAll(USER_INPUT_BEGIN, NEUTRALIZED_BEGIN).replaceAll(USER_INPUT_END, NEUTRALIZED_END);
}

/** True when this tool's result is attacker-influenceable remote content. */
export function isRemoteContentTool(toolName: string): boolean {
  return REMOTE_CONTENT_TOOL_NAMES.has(toolName);
}

// ---------------------------------------------------------------------------
// Untrusted-result fencing (nonce-boundary markers, OpenDDE-style)
// ---------------------------------------------------------------------------

/**
 * Tools whose results are fenced as untrusted before entering the model
 * context: remote content (attacker-influenceable by the page author) plus
 * `task` (subagent returns — model-generated but influenced by whatever
 * untrusted content the subagent read).
 *
 * This is the LEGACY name-based list. New untrusted sources should declare
 * `untrustedCategory` on the AgentTool instead (see resolveUntrustedCategory)
 * so dynamic-name tools (MCP connectors) and whole tool families (knowledge
 * engine) are covered without name enumeration.
 */
export const UNTRUSTED_FENCED_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...REMOTE_CONTENT_TOOL_NAMES,
  "task",
]);

// Bounded: a real fence marker is ~45 chars; the {0,80} bound stops a stray
// opener from swallowing everything up to the next "]" anywhere later.
const FENCE_SHAPED_PATTERN = /\[\s*(?:BEGIN|END)\s+UNTRUSTED\b[^\]]{0,80}\]?/gi;

/** Fence category for MCP connector tools (auto-marked via the `mcp` field). */
export const MCP_UNTRUSTED_CATEGORY = "remote";

/**
 * Resolve the untrusted-fence category for a registered tool. Priority:
 * explicit `untrustedCategory` on the tool > legacy name list > `mcp`
 * auto-mark (connector results are remote content by definition). Undefined
 * means the result enters the model context unfenced.
 */
export function resolveUntrustedCategory(tool: {
  mcp?: unknown;
  name: string;
  untrustedCategory?: string;
}): string | undefined {
  if (tool.untrustedCategory) return tool.untrustedCategory;
  if (UNTRUSTED_FENCED_TOOL_NAMES.has(tool.name)) return tool.name === "task" ? "subagent" : "remote";
  if (tool.mcp) return MCP_UNTRUSTED_CATEGORY;
  return undefined;
}

/**
 * Wrap content in a run-scoped nonce fence under an explicit category:
 * `[BEGIN UNTRUSTED <category> #<nonce>]…[END UNTRUSTED #<nonce>]`.
 *
 * The per-run nonce makes the closing marker unforgeable by the fenced
 * content: an injection written before the run cannot know it, so it cannot
 * close the fence early and pose as trusted framework text after it. Any
 * fence-shaped text INSIDE the content is neutralized to an inert look-alike
 * so a fake boundary never appears inside a real one.
 */
export function fenceUntrustedContent(content: string, category: string, nonce: string): string {
  const safe = content.replaceAll(FENCE_SHAPED_PATTERN, "[UNTRUSTED fence marker neutralized]");
  return `[BEGIN UNTRUSTED ${category} #${nonce}]\n${safe}\n[END UNTRUSTED #${nonce}]`;
}

/**
 * Legacy name-based fencing entry point. Prefer resolveUntrustedCategory +
 * fenceUntrustedContent at call sites that have the AgentTool at hand.
 */
export function fenceUntrustedResult(toolName: string, content: string, nonce: string): string {
  const category = resolveUntrustedCategory({ name: toolName });
  return category ? fenceUntrustedContent(content, category, nonce) : content;
}
