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
 * Carry a no-confirm design past the turn it ended on.
 *
 * With `--no-confirm` the skill is told to do all four steps in one pass and
 * to write each checkpoint as a record on the way. The model usually does the
 * first half of that and then ends its turn on the card — a card with no
 * buttons, in a conversation nobody is typing into, so the design stops at
 * step 1 and looks broken. The client is the only participant that can start
 * the next turn, so it does: one message, once per step.
 *
 * The same stall has a second shape. Some turns end with nothing at all — no
 * card, no `create_evolve_run`, no search — and the model, watched live, spent
 * its remaining turns re-checking the evaluator instead of submitting it. That
 * ending is answered once per design, with a sentence that names the one thing
 * the turn owed.
 *
 * It refuses to guess. A run that did not complete (failed, cancelled, lost
 * its stream), a design started with pauses, a Session that already has a
 * search, an answer that ends on anything but a non-final auto card, or a
 * step that was already carried forward all leave the conversation alone.
 */

import { useEffect, useRef, useState } from "react";

import type { EvolveCheckpointMode } from "@sciencediscovery/schema";

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
  /** The pace the design was started with, from its `/evolve-design` command.
   *  Only an `auto` design — nobody waiting at the checkpoints — may be pushed
   *  forward by this client. */
  checkpointMode?: EvolveCheckpointMode;
  /** Whether *this design* already has a search — one created after its
   *  `/evolve-design` command, not the Session's whole run history. A turn
   *  that ran after the design's own search exists is not a stalled design,
   *  and continuing it would be a paid call answering nothing; a search an
   *  earlier design started says nothing about this one, and reading it as if
   *  it did would leave a second no-confirm design stalled with no push. */
  searchStarted?: boolean;
  /** Whether a turn is in flight. The transition to `false` is the signal that
   *  one just ended. */
  running: boolean;
  /** The run that just ended — the answer it wrote lives here. */
  run: RunStreamState;
  send: (text: string) => void;
  sessionId?: string;
}

/** The step number a stall is remembered by. Zero is not a real checkpoint —
 *  they start at 1 — so one design can be carried past a card and then, once,
 *  past a turn that ended with nothing at all. */
const STALLED_STEP = 0;

/** Why the client is no longer moving an unattended design forward.
 *
 *  `stopped` is the ending that came back after it was carried once: pushing
 *  it again would be a paid turn answering a step that has already been
 *  answered. `unstarted` is a turn that called `create_evolve_run` and still
 *  produced no search — the call did not go through, and the answer in the
 *  conversation holds the reason. Both are endings that leave the design
 *  idle, and both need the reader to know it. */
export interface AutoContinueNotice {
  reason: "stopped" | "unstarted";
}

/** What the hook did to the conversation, for the transcript to draw.
 *
 *  One step is state a card cannot read for itself. The client carries a
 *  no-confirm design past an auto card once; when the same step comes back a
 *  second time it stops, because pushing again would be a paid turn answering
 *  a card that was already answered. `refusedStep` is that stop, and the card
 *  with that number is the only place it can be said: the turn ended, nothing
 *  else will move, and a record with nothing to press otherwise reads as a
 *  design that hung.
 *
 *  Some endings have no card to say it on. A checkpoint written as prose, or
 *  a turn that ends after a refused `create_evolve_run`, leaves nothing on
 *  screen to carry a badge, so the stop is a `notice` the transcript draws
 *  itself — the search has not started, and the sentence that continues the
 *  design is written out in the conversation. */
export interface AutoContinueState {
  notice?: AutoContinueNotice;
  refusedStep?: number;
}

/** Something the client wrote about one design, possibly before the
 *  transcript named it. `design === undefined` means the design anchor was
 *  not readable yet: the auto-continue's own push invalidates the settle that
 *  would have written the design's command into the transcript, so the turn
 *  after that push can end with an empty transcript. The record is bound to
 *  the anchor when it first appears, and dropped for a different one. */
interface Anchored<T> {
  design?: string;
  value: T;
}

function lastTurnCalled(run: RunStreamState, name: string): boolean {
  return (run.turns.at(-1)?.tools ?? []).some((tool) => tool.trace.name === name);
}

export function useAutoContinue({
  checkpointMode, design, running, run, searchStarted, send, sessionId,
}: AutoContinueInput): AutoContinueState {
  const wasRunning = useRef(false);
  /** The ending already carried forward, as `autoContinueKey` spells it. A
   *  model that ends on the same step twice — reworded or not — is not
   *  answered twice, which would be a loop with a paid model call in it,
   *  while a new design that happens to stop on the same step number still
   *  is. */
  const carried = useRef<string | undefined>(undefined);
  /** The step whose push was refused, for the card to show. State, not a ref:
   *  the transcript has to re-render for the reason to be on screen. */
  const [refusedStep, setRefusedStep] = useState<number | undefined>(undefined);
  const refused = useRef<Anchored<number> | undefined>(undefined);
  /** The stop no card can carry. State for the same reason: it is read by a
   *  block of the transcript, which only exists once this re-renders. */
  const [notice, setNotice] = useState<AutoContinueNotice | undefined>(undefined);
  const noticed = useRef<Anchored<AutoContinueNotice> | undefined>(undefined);
  /** The pace this Session's design was last seen to have.
   *
   *  The hook decides at the instant a turn ends, and at that instant the
   *  transcript can still be empty: the message this client sent to carry the
   *  previous step bumped `sendEpoch`, so the settle for the turn before it
   *  was dropped rather than written (`use-workspace.ts`). The design's
   *  `/evolve-design` command is then in neither `messages` nor `pending`, and
   *  `checkpointMode` reads as unknown — which used to silence the cardless
   *  continuation for a design this client had itself been carrying. The last
   *  observed pace is the one piece of that answer the client still has. It is
   *  scoped to the Session, so another conversation cannot inherit it. */
  const observedPace = useRef<{ pace: EvolveCheckpointMode; sessionId?: string } | undefined>(undefined);
  const remembered = observedPace.current;
  const pace = checkpointMode ?? (remembered !== undefined && remembered.sessionId === sessionId
    ? remembered.pace
    : undefined);

  const writeRefused = (step: number | undefined, forDesign?: string) => {
    refused.current = step === undefined ? undefined : { design: forDesign, value: step };
    setRefusedStep(step);
  };
  const writeNotice = (next: AutoContinueNotice | undefined, forDesign?: string) => {
    noticed.current = next === undefined ? undefined : { design: forDesign, value: next };
    setNotice(next);
  };

  /** Keep an anchored stop attached to the design it describes: bind it when
   *  the transcript first names that design, drop it when the transcript names
   *  a different one. */
  const bindAnchor = <T,>(record: { current: Anchored<T> | undefined }, write: (value: T | undefined) => void) => {
    const current = record.current;
    if (current === undefined) return;
    if (current.design === undefined) {
      if (design !== undefined) current.design = design;
    } else if (design !== undefined && design !== current.design) {
      write(undefined);
    }
  };

  // A stop belongs to one Session. Opening another one must not leave the
  // previous "已停止自动续跑" on whatever card happens to share its step number.
  useEffect(() => {
    writeRefused(undefined);
    writeNotice(undefined);
  }, [sessionId]);
  // Read at fire time so a new `send` identity does not re-run the check.
  const latestSend = useRef(send);
  useEffect(() => {
    latestSend.current = send;
  }, [send]);
  useEffect(() => {
    if (checkpointMode !== undefined) observedPace.current = { pace: checkpointMode, sessionId };
  }, [checkpointMode, sessionId]);

  /** A search this design owns ends the stall, wherever that is learned from.
   *  It can arrive after the settle that clears the live run — the run list is
   *  re-read from `evolve_run.created` — and then there is no ending left to
   *  re-decide. A notice that waited for one would keep claiming the search
   *  had not started while it was already running. */
  useEffect(() => {
    if (searchStarted === true || run.evolveRunsCreated > 0) writeNotice(undefined);
  }, [searchStarted, run.evolveRunsCreated, sessionId]);

  useEffect(() => {
    const was = wasRunning.current;
    wasRunning.current = running;
    // The design may only be named by the settle that lands after this turn,
    // so binding happens on every render, not only on the ending.
    bindAnchor(refused, (step) => writeRefused(step));
    bindAnchor(noticed, (next) => writeNotice(next));
    // Only the moment a turn ends. Opening a session, or a run still going,
    // must not send anything.
    if (!was || running) return;
    // A run that failed or was stopped has no step to continue from, even if
    // its last text happened to end with a card.
    if (run.status !== "completed") return;
    const answer = lastAnswer(run);
    const next = answer === undefined ? undefined : trailingAutoStep(answer);
    if (next !== undefined) {
      const key = autoContinueKey(sessionId, design, next.step);
      if (carried.current === key) {
        // The step came back after it was already carried. Pushing it again is
        // a paid turn answering the same card, so the client stops here — and
        // says so, because otherwise the design is a folded record with
        // nothing to press and no sign of why it stopped.
        writeNotice(undefined);
        writeRefused(next.step, design);
        return;
      }
      writeRefused(undefined);
      writeNotice(undefined);
      carried.current = key;
      latestSend.current(TEXT.evolve.checkpoint.autoContinue(next.step, next.total));
      return;
    }
    // The same stall, one shape later: the turn ended with no card to continue
    // from and no search to show for it. Nothing in the conversation can move
    // it — the design is unattended, and the search it was drawing up does not
    // exist — so the client sends one sentence, once per design, and only for
    // a design that was started without pauses.
    if (pace !== "auto") return;
    if (searchStarted === true || run.evolveRunsCreated > 0) {
      // The search this design owed exists now; nothing is stalled.
      writeNotice(undefined);
      return;
    }
    if (answer === undefined) return;
    if (lastTurnCalled(run, "create_evolve_run")) {
      // The search tool ran in this turn and no search exists, so the call did
      // not go through. Sending the same instruction again would repeat it
      // blindly; the answer already holds the reason it was refused. What is
      // missing is a sign that the design is idle and what to send next.
      writeNotice({ reason: "unstarted" }, design);
      return;
    }
    // The answer is evidence on its own: `finalContent` is the persisted
    // message and arrives with `run.completed`, while `turns` is assembled
    // from deltas that a dropped frame can leave empty. A turn whose turns
    // were lost still ended, and the design is still stalled.
    //
    // A turn that called tools and then ended is still stalled — the search is
    // what it owed — and a turn that called nothing at all is the shape seen
    // most often. Both are answered the same way, once.
    const key = autoContinueKey(sessionId, design, STALLED_STEP);
    if (carried.current === key) {
      // The step came back after it was carried once. There is no card to
      // carry the badge, so the stop is said in the conversation instead.
      writeNotice({ reason: "stopped" }, design);
      return;
    }
    carried.current = key;
    writeNotice(undefined);
    latestSend.current(TEXT.evolve.checkpoint.autoResume);
  }, [checkpointMode, design, run, running, searchStarted, sessionId]);

  return { notice, refusedStep };
}
