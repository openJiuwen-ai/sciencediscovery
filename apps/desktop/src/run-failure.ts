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

import type { RunFailureCode } from "@sciencediscovery/schema";

import type { ChatMessage } from "./api/types.js";
import type { RunStreamState } from "./run-stream/model.js";
import type { RunReplay } from "./run-stream/replay.js";

import { TEXT } from "./text.js";

const FAILURE_MESSAGE_KEYS: Record<RunFailureCode, keyof typeof TEXT.runFailure> = {
  "invalid-tool-call": "invalid-tool-call",
  "rate-limited": "rate-limited",
  "semantic-error": "semantic-error",
  "server-error": "server-error",
  timeout: "timeout",
  "transport-error": "transport-error",
  unauthorized: "unauthorized",
};

/** Translate a stable failure code into a user-facing, actionable summary.
 *  The active language is resolved at render time through `TEXT`.
 *  Accepts `string` because the streamed error state stores the code as a plain
 *  string; any value that is not a recognised code falls back to the unknown
 *  message. */
export function formatRunFailure(code: RunFailureCode | string | undefined): string {
  const key =
    code && Object.hasOwn(FAILURE_MESSAGE_KEYS, code)
      ? FAILURE_MESSAGE_KEYS[code as RunFailureCode]
      : undefined;
  return key ? TEXT.runFailure[key] : TEXT.runFailure.unknown;
}

/** Old timeout messages have no run id. Only merge when both the originating
 * user turn and the diagnostic agree with exactly one displayed failure.
 * Unmatched/ambiguous notices remain visible; all merged diagnostics survive. */
export function coalesceTimeoutNotices(
  messages: readonly ChatMessage[],
  replays: readonly RunReplay[],
  run: RunStreamState,
): { hiddenNoticeIds: ReadonlySet<string>; replays: RunReplay[]; run: RunStreamState } {
  const candidates = replays.map(replay => ({ anchor: replay.userMessageId, state: replay.state }));
  if (run.error && !replays.some(replay => replay.runId === run.runId)) {
    const anchor = messages.findLast(message => message.role === "user" &&
      (run.startedAt === undefined || Date.parse(message.createdAt) <= run.startedAt));
    candidates.push({ anchor: anchor?.id, state: run });
  }
  const hiddenNoticeIds = new Set<string>();
  const diagnostics = new Map<RunStreamState, string[]>();
  let anchor: string | undefined;
  for (const message of messages) {
    if (message.role === "user") anchor = message.id;
    if (message.kind !== "timeout_notice" || anchor === undefined) continue;
    const matching = candidates.filter(candidate => {
      if (candidate.anchor !== anchor || !candidate.state.error) return false;
      const raw = candidate.state.error.message.trim();
      const reason = message.timeout?.reason.trim();
      return reason ? raw.includes(reason) : raw.length > 0 && message.content.includes(raw);
    });
    if (matching.length !== 1) continue;
    const state = matching[0]?.state;
    if (!state) continue;
    hiddenNoticeIds.add(message.id);
    const entries = diagnostics.get(state) ?? [];
    entries.push(message.content);
    diagnostics.set(state, entries);
  }
  const merge = (state: RunStreamState): RunStreamState => {
    const entries = diagnostics.get(state);
    if (!entries || !state.error) return state;
    const messages = [...new Set([state.error.message, ...entries])];
    return { ...state, error: { ...state.error, message: messages.join("\n\n") } };
  };
  return {
    hiddenNoticeIds,
    replays: replays.map(replay => ({ ...replay, state: merge(replay.state) })),
    run: merge(run),
  };
}
