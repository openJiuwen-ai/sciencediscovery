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

import type { TimeoutKind } from "@sciencediscovery/schema";

import type { ChatMessage } from "./api/types.js";
import type { RunStreamState } from "./run-stream/model.js";
import type { RunReplay } from "./run-stream/replay.js";

import { TEXT } from "./text.js";

type FailureTimeout = { kind: TimeoutKind; timeoutMs: number };

function isRunFailureCode(code: string | undefined): code is keyof typeof TEXT.runFailure.titles {
  return code !== undefined && Object.hasOwn(TEXT.runFailure.titles, code);
}

/** The live error frame carries no timeout metadata. Recognize only the
 * stable producer diagnostics; other timeout messages get generic guidance. */
function timeoutFromDiagnostic(message: string): FailureTimeout | undefined {
  const patterns: Array<[TimeoutKind, RegExp]> = [
    ["gateway_idle", /\bno gateway progress for (\d+) ms\b/i],
    ["gateway_turn", /\bgateway turn exceeded (\d+) ms\b/i],
    ["permission_wait", /\bpermission wait timed out after (\d+) ms\b/i],
    ["runner_exec", /\b(?:execution|evaluation) timed out after (\d+) ms\b/i],
    ["kernel_idle", /\bkernel idle timeout after (\d+) ms\b/i],
  ];
  for (const [kind, pattern] of patterns) {
    const match = pattern.exec(message);
    if (match) return { kind, timeoutMs: Number(match[1]) };
  }
  return undefined;
}

type FailureScope = "run" | "notice";

export function formatRunFailureTitle(
  code: string | undefined,
  message = "",
  timeout?: FailureTimeout,
  scope: FailureScope = "run",
): string {
  if (code === "timeout") {
    const detail = timeout ?? timeoutFromDiagnostic(message);
    if (detail && Object.hasOwn(TEXT.runFailure.timeoutTitles, detail.kind)) {
      return TEXT.runFailure.timeoutTitles[detail.kind];
    }
    if (scope === "notice") return TEXT.runFailure.timeoutNoticeTitle;
  }
  return isRunFailureCode(code) ? TEXT.runFailure.titles[code] : TEXT.runFailure.title;
}

/** Read the active language at render time. Prefer persisted timeout metadata
 * over diagnostics and never invent a duration for unknown/malformed errors. */
export function formatRunFailure(
  code: string | undefined,
  message = "",
  timeout?: FailureTimeout,
  scope: FailureScope = "run",
): string {
  if (code === "timeout") {
    const detail = timeout ?? timeoutFromDiagnostic(message);
    if (detail && Number.isFinite(detail.timeoutMs) && detail.timeoutMs > 0 &&
      Object.hasOwn(TEXT.runFailure.timeouts, detail.kind)) {
      return TEXT.runFailure.timeouts[detail.kind](detail.timeoutMs / 1000);
    }
    if (scope === "notice") return TEXT.runFailure.timeoutNotice;
  }
  return isRunFailureCode(code) ? TEXT.runFailure[code] : TEXT.runFailure.unknown;
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
  const diagnostics = new Map<RunStreamState, { messages: string[]; timeout?: ChatMessage["timeout"] }>();
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
    const entries = diagnostics.get(state) ?? { messages: [], timeout: undefined };
    entries.messages.push(message.content);
    entries.timeout ??= message.timeout;
    diagnostics.set(state, entries);
  }
  const merge = (state: RunStreamState): RunStreamState => {
    const entries = diagnostics.get(state);
    if (!entries || !state.error) return state;
    const messages = [...new Set([state.error.message, ...entries.messages])];
    return { ...state, error: { ...state.error, message: messages.join("\n\n"), timeout: state.error.timeout ?? entries.timeout } };
  };
  return {
    hiddenNoticeIds,
    replays: replays.map(replay => ({ ...replay, state: merge(replay.state) })),
    run: merge(run),
  };
}
