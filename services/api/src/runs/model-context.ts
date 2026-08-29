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

import type { AgentHistoryMessage } from "@sciencediscovery/orchestration";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assistantToolCallIds(message: AgentHistoryMessage): string[] {
  if (message.role !== "assistant") return [];
  const ids = new Set<string>();
  for (const raw of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (isRecord(raw) && typeof raw.id === "string" && raw.id) ids.add(raw.id);
  }
  for (const raw of Array.isArray(message.response_items) ? message.response_items : []) {
    if (isRecord(raw) && raw.type === "function_call" && typeof raw.call_id === "string" && raw.call_id) {
      ids.add(raw.call_id);
    }
  }
  return [...ids];
}

/** Keep only protocol-closed assistant/tool segments. If a provider/runtime
 * ends with an assistant tool call that has no matching result, dropping that
 * assistant and everything dependent on it is safer than replaying a request
 * shape that OpenAI-compatible and Anthropic endpoints reject. */
export function closedModelContext(messages: readonly AgentHistoryMessage[]): AgentHistoryMessage[] {
  let segmentStart = -1;
  const pending = new Set<string>();
  for (const [index, message] of messages.entries()) {
    const ids = assistantToolCallIds(message);
    if (ids.length) {
      if (pending.size) return structuredClone(messages.slice(0, segmentStart));
      segmentStart = index;
      ids.forEach((id) => pending.add(id));
      continue;
    }
    if (!pending.size) continue;
    if (message.role !== "tool") return structuredClone(messages.slice(0, segmentStart));
    if (typeof message.tool_call_id === "string") pending.delete(message.tool_call_id);
    if (!pending.size) segmentStart = -1;
  }
  return structuredClone(pending.size ? messages.slice(0, segmentStart) : [...messages]);
}
