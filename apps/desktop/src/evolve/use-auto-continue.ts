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
 *  the step it stopped on, and the words it stopped with.
 *
 *  The step alone is not enough. A second no-confirm design in the same
 *  conversation can end on the same step number — both stop at "checkpoint
 *  1/4" — and a watermark that only knew the step would read that as a card
 *  already answered, leaving the new design stalled on a card with nothing to
 *  press. The answer is what makes the two endings different events; the same
 *  card written twice is still one reply, and is still refused.
 */
export function autoContinueKey(
  sessionId: string | undefined,
  step: number,
  answer: string,
): string {
  return `${sessionId ?? ""}\u0000${step}\u0000${answer}`;
}

export interface AutoContinueInput {
  /** Whether a turn is in flight. The transition to `false` is the signal that
   *  one just ended. */
  running: boolean;
  /** The run that just ended — the answer it wrote lives here. */
  run: RunStreamState;
  send: (text: string) => void;
  sessionId?: string;
}

export function useAutoContinue({ running, run, send, sessionId }: AutoContinueInput): void {
  const wasRunning = useRef(false);
  /** The ending already carried forward, as `autoContinueKey` spells it. A
   *  model that ends on the same card twice is not answered twice — that
   *  would be a loop with a paid model call in it — while a new design that
   *  happens to stop on the same step number still is. */
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
    const key = autoContinueKey(sessionId, next.step, answer);
    if (carried.current === key) return;
    carried.current = key;
    latestSend.current(TEXT.evolve.checkpoint.autoContinue(next.step, next.total));
  }, [run, running, sessionId]);
}
