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

import type { Subagent } from "@science-agent/schema";
import { MAX_SUBAGENT_TIMEOUT_SECONDS } from "@science-agent/agent-runtime";

export const SUBAGENT_PARENT_TIMEOUT_MARGIN_MS = 60_000;

/**
 * A task tool call remains inside its parent AgentRun. Keep that AgentRun alive
 * long enough for the largest allowed child deadline to fire first.
 */
export function subagentCapableParentRunTimeoutMs(
  maxSubagentTimeoutSeconds = MAX_SUBAGENT_TIMEOUT_SECONDS,
): number {
  return maxSubagentTimeoutSeconds * 1_000 + SUBAGENT_PARENT_TIMEOUT_MARGIN_MS;
}

export function classifySubagentFailure(
  error: unknown,
  options: { maxTurns: number; maxTurnsExceeded: boolean; parentAborted: boolean },
): { error: string; status: Extract<Subagent["status"], "cancelled" | "failed" | "timed_out"> } {
  const message = options.maxTurnsExceeded
    ? `Subagent exceeded maxTurns=${options.maxTurns}`
    : error instanceof Error ? error.message : "Subagent failed";
  if (options.maxTurnsExceeded || /timeout/i.test(message)) {
    return { error: message, status: "timed_out" };
  }
  if (options.parentAborted || /cancelled/i.test(message)) {
    return { error: message, status: "cancelled" };
  }
  return { error: message, status: "failed" };
}
