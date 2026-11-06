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
 * Carry a no-confirm design past the card its turn ended on.
 *
 * With `--no-confirm` the skill is told to do all four steps in one pass and
 * to write each checkpoint as a record on the way. The model usually does the
 * first half of that and then ends its turn on the card — a card with no
 * buttons, in a conversation nobody is typing into, so the design stops at
 * step 1 and looks broken. The client is the only participant that can start
 * the next turn, so it does: one message, once per step.
 *
 * It refuses to guess. A run that did not complete (failed, cancelled, lost
 * its stream), an answer that ends on anything but a non-final auto card, or a
 * step that was already carried forward all leave the conversation alone.
 */

import { useEffect, useRef } from "react";

import type { RunStreamState } from "../run-stream/model.js";
import { TEXT } from "../text.js";

import { trailingAutoStep } from "./checkpoint.js";
import { isEvolveCommand } from "./command.js";

/** The text a finished turn ended with: the persisted answer when the server
 *  sent one, otherwise the last non-empty response the stream assembled. */
export function lastAnswer(run: RunStreamState): string | undefined {
  if (run.finalContent !== undefined) return run.finalContent;
  for (let turn = run.turns.length - 1; turn >= 0; turn -= 1) {
    const responses = run.turns[turn]!.responses;
    for (let index = responses.length - 1; index >= 0; index -= 1) {
      const content = responses[index]!.content;
      if (content.trim() !== "") return content;
    }
  }
  return undefined;
}

/** What one carried-forward ending is remembered by: the session it ended in,
 *  the design it belongs to, and the step it stopped on.
 *
 *  The step alone is not enough. A second no-confirm design in the same
 *  conversation can end on the same step number — both stop at "checkpoint
 *  1/4" — and a watermark that only knew the step would read that as a card
 *  already answered, leaving the new design stalled on a card with nothing to
 *  press.
 *
 *  The answer is not enough either, which is why it is not in the key. Keying
 *  on it made the two designs distinguishable, but it also made every
 *  *reworded* repeat of the same step a new ending: a model that ends its turn
 *  on the same card with a different number in it is answered again, and again,
 *  for as long as it keeps rewording — an unattended loop of paid turns that
 *  never advances. The design is the anchor that does not move: `${design}:1`
 *  names one step of one design, whatever words it was written with, and a new
 *  `/evolve-design` names a different one.
 */
export function autoContinueKey(
  sessionId: string | undefined,
  design: string | undefined,
  step: number,
): string {
  return `${sessionId ?? ""}\u0000${design ?? ""}\u0000${step}`;
}

/** The anchor of the design the open Session is on, from the Session itself.
 *
 *  Counted rather than named: the anchor is only ever compared with the
 *  previous one, so all it has to be is stable within a design and different
 *  between designs — a count of the `/evolve-design` commands in the
 *  transcript is both, and, unlike a counter kept by this window, it cannot
 *  outlive the Session or disagree with a design another client started.
 *
 *  `pending` is the message being sent right now. A design's first turn can
 *  end on an auto card while its command is still only that pending message —
 *  the transcript is refreshed when the turn settles — so without it the
 *  design's first ending would be keyed against the previous design's number,
 *  and a first turn that stopped on a step the previous design had already
 *  carried would be refused: the pace switch failing silently.
 *
 *  The two cannot double-count: the transcript is not refreshed while a turn
 *  streams, and `pending` is cleared in the same settle that writes the
 *  command into it.
 */
export function designAnchor(
  messages: ReadonlyArray<{ content: string; role: string }>,
  pending?: string,
): string | undefined {
  const persisted = messages.filter(
    (message) => message.role === "user" && isEvolveCommand(message.content),
  ).length;
  const count = persisted + (pending !== undefined && isEvolveCommand(pending) ? 1 : 0);
  return count === 0 ? undefined : `design-${count}`;
}

export interface AutoContinueInput {
  /** Which design conversation this is, as `designAnchor` derives it: the
   *  count of design commands the Session holds, plus the one being sent. It
   *  is what a carried step is remembered against, so a reworded repeat of
   *  step 1 is refused while a second design's step 1 is not. Absent only
   *  before any design is known, when the check is per-session and per-step. */
  design?: string;
  /** Whether a turn is in flight. The transition to `false` is the signal that
   *  one just ended. */
  running: boolean;
  /** The run that just ended — the answer it wrote lives here. */
  run: RunStreamState;
  send: (text: string) => void;
  sessionId?: string;
}

export function useAutoContinue({ design, running, run, send, sessionId }: AutoContinueInput): void {
  const wasRunning = useRef(false);
  /** The ending already carried forward, as `autoContinueKey` spells it. A
   *  model that ends on the same step twice — reworded or not — is not
   *  answered twice, which would be a loop with a paid model call in it,
   *  while a new design that happens to stop on the same step number still
   *  is. */
  const carried = useRef<string | undefined>(undefined);
  // Read at fire time so a new `send` identity does not re-run the check.
  const latestSend = useRef(send);
  useEffect(() => {
    latestSend.current = send;
  }, [send]);

  useEffect(() => {
    const was = wasRunning.current;
    wasRunning.current = running;
    // Only the moment a turn ends. Opening a session, or a run still going,
    // must not send anything.
    if (!was || running) return;
    // A run that failed or was stopped has no step to continue from, even if
    // its last text happened to end with a card.
    if (run.status !== "completed") return;
    const answer = lastAnswer(run);
    if (answer === undefined) return;
    const next = trailingAutoStep(answer);
    if (next === undefined) return;
    const key = autoContinueKey(sessionId, design, next.step);
    if (carried.current === key) return;
    carried.current = key;
    latestSend.current(TEXT.evolve.checkpoint.autoContinue(next.step, next.total));
  }, [design, run, running, sessionId]);
}
