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

import { createContext, useContext } from "react";

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
  /** Put this text in the composer without sending it, for a change the reader
   *  is about to describe. */
  draft: (text: string) => void;
  /** Send this as the reader's message. */
  reply: (text: string) => void;
}

const CheckpointReplyContext = createContext<CheckpointReply | undefined>(undefined);

export const CheckpointReplyProvider = CheckpointReplyContext.Provider;

export function useCheckpointReply(): CheckpointReply | undefined {
  return useContext(CheckpointReplyContext);
}

/**
 * One checkpoint of a design conversation.
 *
 * It is the checkpoint, not a decoration next to it: the title is the question
 * the step asks and the body is the few lines a person waves through, so the
 * conversation around it stays short. The pace decides the shape — `confirm`
 * offers the two answers the flow expects, `auto` says the run was started
 * with `--no-confirm` and this is a record of a step that did not wait.
 *
 * The label is read at render time, like every other string: `TEXT` is a proxy
 * over the language store, and a label captured at import would stay in the
 * language the window opened in.
 */
export function CheckpointCard({ checkpoint }: { checkpoint: EvolveCheckpoint }) {
  const reply = useCheckpointReply();
  const text = TEXT.evolve.checkpoint;
  const label = text.eyebrow(checkpoint.step, checkpoint.total);
  const auto = checkpoint.pace === "auto";
  return (
    <section
      aria-label={label}
      className={`evolve-checkpoint is-${checkpoint.pace}`}
      data-pace={checkpoint.pace}
      data-step={checkpoint.step}
    >
      <header className="evolve-checkpoint-head">
        <span className="evolve-checkpoint-step">{label}</span>
        <span className="evolve-checkpoint-pace">{auto ? text.auto : text.waiting}</span>
      </header>
      {checkpoint.title === undefined ? null : (
        <h4 className="evolve-checkpoint-title">{checkpoint.title}</h4>
      )}
      {checkpoint.body === "" ? null : (
        <div className="evolve-checkpoint-body text">
          <MarkdownProse>{checkpoint.body}</MarkdownProse>
        </div>
      )}
      {auto || reply === undefined ? null : (
        <div className="evolve-checkpoint-actions">
          <button
            className="evolve-checkpoint-confirm"
            disabled={reply.busy}
            onClick={() => reply.reply(text.confirmReply)}
            title={reply.busy ? text.busy : undefined}
            type="button"
          >
            {text.confirm}
          </button>
          <button
            className="evolve-checkpoint-adjust"
            disabled={reply.busy}
            onClick={() => reply.draft(text.adjustDraft)}
            title={reply.busy ? text.busy : undefined}
            type="button"
          >
            {text.adjust}
          </button>
        </div>
      )}
    </section>
  );
}
