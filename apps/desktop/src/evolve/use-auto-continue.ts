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
  /** The (session, step) already carried forward. Keyed by session so opening
   *  another conversation does not inherit this one's watermark, and by step so
   *  a model that ends on the same card twice is not answered twice — that
   *  would be a loop with a paid model call in it. */
  const carried = useRef<{ sessionId?: string; step?: number }>({});
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
    const next = answer === undefined ? undefined : trailingAutoStep(answer);
    if (next === undefined) return;
    if (carried.current.sessionId !== sessionId) carried.current = { sessionId };
    if (carried.current.step === next.step) return;
    carried.current.step = next.step;
    latestSend.current(TEXT.evolve.checkpoint.autoContinue(next.step, next.total));
  }, [run, running, sessionId]);
}
