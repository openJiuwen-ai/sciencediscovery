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

import type { AutoContinueNotice } from "../evolve/use-auto-continue.js";
import { TEXT } from "../text.js";

/**
 * An evolve design that ended without the search it owed.
 *
 * The client carries a no-confirm design past its checkpoints itself, and says
 * so on the card when it stops. Some endings have no card: the model wrote the
 * checkpoint as prose, its `evolve-checkpoint` fence did not parse, or the
 * turn called `create_evolve_run` and the call did not create anything. In all
 * of them the conversation simply stops, and a transcript with nothing to
 * press reads as a design that hung.
 *
 * So the stop is said here, in the conversation rather than on a card: the
 * search has not started, why the client is not going to move it again, and
 * the exact sentence that continues it — the same sentence the client sends
 * when it can. The button is that sentence, so the reader does not have to
 * retype it; it is disabled while a turn is running, which is the same rule
 * the checkpoint card follows.
 *
 * The labels are read at render time: `TEXT` is a proxy over the language
 * store, and a string captured at import would stay in the language the window
 * opened in.
 */
export function EvolveStallNotice({ busy, notice, onSend }: {
  /** The assistant is still answering: a press would send into a live run. */
  busy: boolean;
  /** Absent when no design is stalled; the block draws nothing then. */
  notice?: AutoContinueNotice;
  onSend: (text: string) => void;
}) {
  if (notice === undefined) return null;
  const text = TEXT.evolve.stall;
  const sentence = TEXT.evolve.checkpoint.autoResume;
  return (
    <section className="evolve-stall" data-reason={notice.reason} role="status">
      <p className="evolve-stall-title">{text.title}</p>
      <p className="evolve-stall-detail">
        {notice.reason === "stopped" ? text.stopped : text.unstarted}
      </p>
      <p className="evolve-stall-send">
        <span>{text.send}</span>
        <code>{sentence}</code>
      </p>
      <button
        className="evolve-stall-action"
        disabled={busy}
        onClick={() => onSend(sentence)}
        title={busy ? TEXT.evolve.checkpoint.busy : undefined}
        type="button"
      >
        {text.action}
      </button>
    </section>
  );
}
