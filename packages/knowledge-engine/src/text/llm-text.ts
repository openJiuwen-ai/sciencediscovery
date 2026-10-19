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
 * Text utilities for LLM pipeline output.
 *
 * Reasoning models (e.g. MiniMax-M3) embed `<think>…</think>` blocks in the
 * visible content — and those blocks contain square brackets, so a naive
 * first-`[` to last-`]` JSON salvage silently parses the wrong span (a hard
 * lesson from the DeepAnalyze pipeline). Every JSON extraction from a
 * pipeline model response must strip thinking first.
 */

/** Remove <think>…</think> blocks (and an unclosed trailing one) from content. */
export function stripThinkingProcess(content: string): string {
  let result = content.replace(/<think>[\s\S]*?<\/think>/g, "");
  const unclosed = result.indexOf("<think>");
  if (unclosed !== -1) {
    result = result.slice(0, unclosed);
  }
  return result;
}

/**
 * Salvage the first JSON value from a model response: prefer a fenced
 * ```json block, then the first `{…}` / `[…]` balanced span. Returns null
 * when no plausible JSON is present. Callers should still expect
 * JSON.parse to throw on malformed content — this is a locator, not a fixer.
 */
export function salvageJson(content: string): string | null {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(content);
  const candidate = fenced?.[1] ?? content;
  const start = candidate.search(/[{[]/);
  if (start === -1) {
    return null;
  }
  const opener = candidate[start]!;
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < candidate.length; index += 1) {
    const char = candidate[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === opener) {
      depth += 1;
    } else if (char === closer) {
      depth -= 1;
      if (depth === 0) {
        return candidate.slice(start, index + 1);
      }
    }
  }
  return null;
}
