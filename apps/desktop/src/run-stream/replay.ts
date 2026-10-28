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

import type { ChatMessage, SessionRun, SessionRunEvent } from "../api/types.js";
import { emptyRunStream, hasVisibleAnswer, isTerminalRunStatus, type RunStreamState } from "./model.js";
import { closeRunStream, reduceRunStream } from "./reducer.js";

/**
 * One finished run of the open session, rebuilt from its own event log.
 *
 * A session holds as many runs as it took turns, and each is replayed
 * separately: they are separate states, not one folded together. The reducer
 * keys a turn by the number the *event* carries, and those numbers restart at
 * 1 for every run — folding two runs into one state would silently merge the
 * second run's first turn into the first run's.
 */
export interface RunReplay {
  /** The persisted answer this run wrote, which the reconstruction replaces.
   *  Absent when the run was cancelled before the server recorded one. */
  messageId?: string;
  runId: string;
  state: RunStreamState;
  /** The persisted message the run was started from — the user's own, or the
   *  runtime notice of an automatic wake. It is the anchor of last resort for a
   *  run that has no answer to take the place of. */
  userMessageId?: string;
}

/**
 * Fold a run's whole event log into the state a live stream would have left.
 *
 * The reducer is the live path's own, so a replayed run and a streamed one are
 * the same thing by construction rather than by agreement. `closeRunStream` is
 * the other half: it is what the live path calls when its response ends, and a
 * replay that skipped it would leave every response unsettled and every cursor
 * turning — and, because `terminal` would stay false, would hand a long-finished
 * run's authorization cards back to the user as clickable.
 *
 * The server writes these in `sequence` order, but the sort is not redundant: a
 * `?after=` cursor is what a reader is expected to resume from, and a caller
 * that passed one would get a suffix that starts wherever the cursor was.
 */
export function foldRunRecords(records: readonly SessionRunEvent[]): RunStreamState {
  const ordered = [...records].sort((left, right) => left.sequence - right.sequence);
  return closeRunStream(
    ordered.reduce(
      (state, record) => reduceRunStream(state, record.event, record.sequence),
      emptyRunStream(),
    ),
  );
}

/** Where each reconstruction goes, keyed by the persisted message it attaches
 *  to. The transcript renders the three in that order: a replacement in a
 *  message's place, anything following it after it, and the leftovers at the
 *  end. */
export interface ReplayPlacement {
  /** Renders after this message. */
  following: Map<string, RunReplay[]>;
  /** Renders in this message's place. */
  replacing: Map<string, RunStreamState>;
  /** Renders after the transcript. */
  trailing: RunReplay[];
}

/**
 * Whether a reconstruction has anything to show at all.
 *
 * An empty log — a run recorded before the server wrote events, or one whose
 * events were pruned — folds to a state with nothing in it, and holding it
 * would hang an empty turn in the transcript. But "nothing to show" is more
 * than "no turns": a run that failed or was cancelled before it said anything
 * has only its status line to show, and that line is the entire account of what
 * became of it. Dropping those would leave a failed run invisible.
 */
export function hasReplayContent(state: RunStreamState): boolean {
  return (
    state.turns.length > 0 ||
    state.finalContent !== undefined ||
    state.error !== undefined ||
    state.cancelledReason !== undefined ||
    isTerminalRunStatus(state.status)
  );
}

/**
 * Build the replay of one finished run — or nothing, if its log has no form to
 * render.
 *
 * Two decisions live here, and they are not the same one. Whether to hold the
 * reconstruction at all is `hasReplayContent`. Whether it may take the persisted
 * answer's place is `hasVisibleAnswer`: only an answer can stand in for an
 * answer, so a run that failed before saying anything keeps its status line
 * *after* the stored message rather than hiding it.
 */
export function replayRun(run: SessionRun, state: RunStreamState): RunReplay | undefined {
  if (!hasReplayContent(state)) return undefined;
  return {
    messageId: hasVisibleAnswer(state) ? run.assistantMessageId : undefined,
    runId: run.id,
    state,
    userMessageId: run.userMessageId,
  };
}

/**
 * Decide which persisted message each reconstruction attaches to.
 *
 * The run's own answer is the anchor that puts a replay exactly where that run
 * happened, so it is tried first. A run that was cancelled before the server
 * wrote an answer has none, and its start message is the next best thing —
 * anchoring there is what keeps an interrupted run from being dumped at the end
 * of a conversation it did not come last in. Only a run that matches neither
 * (a wake whose notice was itself rolled back, say) is left over.
 *
 * This is deliberately more forgiving than the previous frontend's rule, which
 * anchors on the start message alone and drops a run that has none.
 */
export function placeReplays(
  replays: readonly RunReplay[],
  messages: readonly ChatMessage[],
): ReplayPlacement {
  const present = new Set(messages.map((message) => message.id));
  const placement: ReplayPlacement = { following: new Map(), replacing: new Map(), trailing: [] };
  for (const replay of replays) {
    if (replay.messageId !== undefined && present.has(replay.messageId)) {
      placement.replacing.set(replay.messageId, replay.state);
      continue;
    }
    if (replay.userMessageId !== undefined && present.has(replay.userMessageId)) {
      const bucket = placement.following.get(replay.userMessageId);
      if (bucket) bucket.push(replay);
      else placement.following.set(replay.userMessageId, [replay]);
      continue;
    }
    placement.trailing.push(replay);
  }
  return placement;
}
