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

import type { AgentToolResult } from "./types.js";

/**
 * The arguments a call cannot run without, in the order they are reported.
 *
 * A required argument counts as present when the model sent a non-empty value
 * for it. A tool's schema says the same thing; this list is what a run
 * enforces before the tool runs, so a call that omits one is answered with an
 * invalid-arguments result the model can act on, instead of a failure raised
 * deep inside the tool.
 */
export function missingRequiredArguments(
  args: Record<string, unknown>,
  required: readonly string[],
): string[] {
  return required.filter((name) => {
    const value = args[name];
    if (typeof value === "string") return value.trim().length === 0;
    return value === undefined || value === null;
  });
}

/**
 * The tools that cannot run without one of their arguments, by tool name.
 *
 * The run's model gateway withholds a call that leaves one out and asks the
 * model to re-issue it, so the run never shows a failed tool card for a call
 * that was never executable. Only tools that declare the requirement are
 * listed; a tool without one keeps its own argument handling.
 */
export function requiredArgumentsOf(
  tools: readonly { name: string; requiredArguments?: readonly string[] }[],
): Record<string, readonly string[]> {
  const required: Record<string, readonly string[]> = {};
  for (const tool of tools) {
    if (tool.requiredArguments?.length) required[tool.name] = tool.requiredArguments;
  }
  return required;
}

/**
 * The result a tool returns when its arguments cannot be used.
 *
 * It carries the same shape as the registry's answer to unparseable
 * arguments: a machine-readable code, and the retryable flag that tells the
 * model the call can be re-issued.
 */
export function invalidToolArguments(message: string): AgentToolResult {
  const details = { ok: false, error: { attempts: 1, code: "INVALID_TOOL_ARGUMENTS", retryable: true,
    message: message.slice(0, 1_000) } };
  return { content: [{ type: "text", text: JSON.stringify(details) }], details, isError: true };
}
