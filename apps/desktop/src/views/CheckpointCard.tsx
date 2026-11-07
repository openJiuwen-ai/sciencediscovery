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

import { createContext, useContext, useId, useState } from "react";

import type { EvolveCheckpoint } from "../evolve/checkpoint.js";
import { MarkdownProse } from "../MarkdownProse.js";
import { TEXT } from "../text.js";

/**
 * What a checkpoint's buttons can do to the conversation.
 *
 * A context rather than a prop because the card is drawn by `Markdown`, which
 * is used by the transcript, the document preview and a subagent's detail. Only
 * the shell that owns the composer can answer a card, and passing a callback
 * through every markdown renderer would make three of them carry a parameter
 * they cannot use. Absent — as in those other places, and in server-rendered
 * snapshots — a card still draws its content; it just has no buttons.
 */
export interface CheckpointReply {
  /** The assistant is still answering: a card that could be pressed while the
   *  composer is blocked would send a message into a live run. */
  busy: boolean;
  /** Send this as the reader's message. */
  reply: (text: string) => void;
}

const CheckpointReplyContext = createContext<CheckpointReply | undefined>(undefined);

export const CheckpointReplyProvider = CheckpointReplyContext.Provider;

export function useCheckpointReply(): CheckpointReply | undefined {
  return useContext(CheckpointReplyContext);
}

/**
 * Whether the card is already part of the past.
 *
 * Folding is decided by the transcript, not by the card: a card is answered
 * once a later turn exists, which only the conversation can see. A card that
 * was answered keeps its header — the question and the title — and puts its
 * body behind a click, so a conversation that walked four checkpoints reads as
 * four lines instead of four screens. An unanswered card is shown in full:
 * it is the thing the reader is being asked to act on.
 */
const CheckpointAnsweredContext = createContext(false);

export const CheckpointAnsweredProvider = CheckpointAnsweredContext.Provider;

export function useCheckpointAnswered(): boolean {
  return useContext(CheckpointAnsweredContext);
}

/**
 * One checkpoint of a design conversation.
 *
 * It is the checkpoint, not a decoration next to it: the title is the question
 * the step asks and the body is the few lines a person waves through, so the
 * conversation around it stays short. The pace decides the shape — `confirm`
 * offers the two answers the flow expects, `auto` says the run was started
 * with `--no-confirm` and this is a record of a step that did not wait. The
 * last checkpoint is a record either way: it is written after the run started.
 *
 * The label is read at render time, like every other string: `TEXT` is a proxy
 * over the language store, and a label captured at import would stay in the
 * language the window opened in.
 */
export function CheckpointCard({ checkpoint }: { checkpoint: EvolveCheckpoint }) {
  const reply = useCheckpointReply();
  const answered = useCheckpointAnswered();
  const text = TEXT.evolve.checkpoint;
  const auto = checkpoint.pace === "auto";
  /**
   * The last checkpoint reports a run that is already going. Even if the model
   * labelled it `confirm`, there is nothing left to wait for: the press would
   * arrive after the search started, and the transcript then shows a question
   * whose answer changes nothing. So it is drawn as a record — the same shape
   * as `auto` — and never offers the buttons.
   */
  const final = checkpoint.total !== undefined && checkpoint.step === checkpoint.total;
  const record = auto || final;
  const shade = record ? "auto" : checkpoint.pace;
  // The band names the state, the counter names the step: a record is not a
  // checkpoint — nobody is being asked to approve it — so it says "step", and
  // the number sits at the right of the band as the handoff draws it.
  const headline = record ? text.headerStep : text.headerWaiting;
  // A folded card is past tense: it says the answer arrived. A record has
  // nothing to be answered, so it keeps calling itself a step.
  const folded = record ? text.headerStep : text.headerAnswered;
  /** The last step is written after the run started and never asks; it is a
   *  record, not one of the checkpoints the reader answers. So the counter
   *  counts only the ones that do — four steps, three checkpoints. */
  const asked = checkpoint.total === undefined ? undefined : Math.max(1, checkpoint.total - 1);
  /** A record prints no counter at all: nobody is being asked which question
   *  of how many it is. */
  const count = record ? undefined : text.count(checkpoint.step, asked);
  const label = record
    ? text.stepEyebrow(checkpoint.step)
    : text.eyebrow(checkpoint.step, asked);
  const noteId = useId();
  /** 需要调整 opens the note in the card instead of handing the composer a
   *  sentence: the change is described where the step is, and sending it does
   *  not take the reader's eyes or the caret down to the bottom of the window. */
  const [adjusting, setAdjusting] = useState(false);
  const [note, setNote] = useState("");
  const closeAdjust = () => {
    setAdjusting(false);
    setNote("");
  };
  const sendAdjustment = () => {
    const change = note.trim();
    if (change === "" || reply === undefined || reply.busy) return;
    // The prefix is what tells the model this is a revision of the step rather
    // than a new instruction; the reader's own words follow it unchanged.
    reply.reply(`${text.adjustDraft}${change}`);
    closeAdjust();
  };
  const body = checkpoint.body === "" ? null : (
    <div className="evolve-checkpoint-body text">
      <MarkdownProse>{checkpoint.body}</MarkdownProse>
    </div>
  );
  // A card the conversation has moved past folds to its header; opening it
  // shows what the step said, never the buttons — that step already has an
  // answer below it, and a second press would send it twice.
  if (answered) {
    return (
      <details
        aria-label={label}
        className={`evolve-checkpoint is-${shade} is-answered`}
        data-pace={checkpoint.pace}
        data-step={checkpoint.step}
      >
        <summary className="evolve-checkpoint-head">
          <CheckpointGlyph />
          <span className="evolve-checkpoint-step">{folded}</span>
          {checkpoint.title === undefined ? null : (
            <span className="evolve-checkpoint-title">{checkpoint.title}</span>
          )}
          {count === undefined ? null : (
            <span className="evolve-checkpoint-count">{count}</span>
          )}
          <span aria-hidden="true" className="collapse-chev">›</span>
        </summary>
        {body}
      </details>
    );
  }
  return (
    <section
      aria-label={label}
      className={`evolve-checkpoint is-${shade}${adjusting ? " is-adjusting" : ""}`}
      data-pace={checkpoint.pace}
      data-step={checkpoint.step}
    >
      <header className="evolve-checkpoint-head">
        <CheckpointGlyph />
        <span className="evolve-checkpoint-step">{headline}</span>
        {count === undefined ? null : (
          <span className="evolve-checkpoint-count">{count}</span>
        )}
      </header>
      <div className="evolve-checkpoint-main">
        {checkpoint.title === undefined ? null : (
          <h4 className="evolve-checkpoint-title">{checkpoint.title}</h4>
        )}
        {body}
      </div>
      {record || reply === undefined ? null : adjusting ? (
        <form
          className="evolve-checkpoint-adjust-form"
          onSubmit={(event) => {
            event.preventDefault();
            sendAdjustment();
          }}
        >
          <div className="evolve-checkpoint-adjust-body">
            <label className="evolve-checkpoint-adjust-label" htmlFor={noteId}>{text.adjustLabel}</label>
            <textarea
              autoFocus
              className="evolve-checkpoint-note"
              id={noteId}
              onChange={(event) => setNote(event.target.value)}
              onKeyDown={(event) => {
                // Enter writes a second line; the shortcut sends, the way it does
                // in the composer. A bare Enter here would make a half-written
                // change impossible to check before it went.
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  sendAdjustment();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  closeAdjust();
                }
              }}
              placeholder={text.adjustPlaceholder}
              rows={2}
              value={note}
            />
          </div>
          <div className="evolve-checkpoint-actions">
            {/* One answer, as the handoff draws it: the note is the change, and
                confirming it is what sends it. Escape closes the form. */}
            <button
              className="evolve-checkpoint-confirm"
              disabled={reply.busy || note.trim() === ""}
              title={reply.busy ? text.busy : undefined}
              type="submit"
            >
              {text.confirm}
            </button>
          </div>
        </form>
      ) : (
        <div className="evolve-checkpoint-actions">
          <button
            className="evolve-checkpoint-adjust"
            disabled={reply.busy}
            onClick={() => setAdjusting(true)}
            title={reply.busy ? text.busy : undefined}
            type="button"
          >
            {text.adjust}
          </button>
          <button
            className="evolve-checkpoint-confirm"
            disabled={reply.busy}
            onClick={() => reply.reply(text.confirmReply(checkpoint.step, checkpoint.total))}
            title={reply.busy ? text.busy : undefined}
            type="button"
          >
            {text.confirm}
          </button>
        </div>
      )}
    </section>
  );
}

/** The card's mark: a sheet of paper with a folded corner and two lines. It is
 *  drawn here rather than imported because it is the card's own chrome and
 *  takes its colour from the band; at 10×12 it is a stroke and nothing else. */
function CheckpointGlyph() {
  return <svg
    aria-hidden="true"
    className="evolve-checkpoint-icon"
    fill="none"
    height="12"
    viewBox="0 0 10 12"
    width="10"
  >
    <path
      d="M.5 1.5a1 1 0 0 1 1-1h5.1l2.9 2.9v7.1a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1z"
      stroke="currentColor"
      strokeLinejoin="round"
      strokeWidth="1"
    />
    {/* The dog-ear: the fold's inner corner, and the two lines the page holds. */}
    <path d="M6.6.9v1.7a.6.6 0 0 0 .6.6h2.3" stroke="currentColor" strokeLinejoin="round" strokeWidth="1" />
    <path d="M2.5 5.6h2.8M2.5 8.1h4" stroke="currentColor" strokeLinecap="round" strokeWidth="1" />
  </svg>;
}
