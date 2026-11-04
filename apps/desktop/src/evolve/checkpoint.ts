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

import type { EvolveCheckpointMode } from "@sciencediscovery/schema";

/**
 * One checkpoint of the design conversation, as the assistant wrote it.
 *
 * The card is drawn from the answer text rather than from a run event because
 * the answer is the thing that survives: a stored `ChatMessage` holds the
 * markdown and nothing else, so a card built from a transient tool call would
 * disappear the moment the session was read back.
 *
 * The fence is deliberately not JSON. A client that does not draw cards — the
 * web app, any other Markdown reader — falls back to showing the block as
 * code, and a header of `step: 1` lines over the checkpoint's own prose still
 * reads, where an escaped JSON object does not. See
 * `skills/evolve-design/SKILL.md` for the contract the model writes.
 */
export interface EvolveCheckpoint {
  /** The lines under the header. Markdown, because the model writes prose. */
  body: string;
  /** Who the checkpoint is waiting on. `auto` means the run was started with
   *  `--no-confirm`: the card is a record, not a prompt. */
  pace: EvolveCheckpointMode;
  /** Which of the four it is. */
  step: number;
  /** A one-line question: "what better means", "the scoring", "the size". */
  title?: string;
  /** How many checkpoints this design has. Absent when the model did not say,
   *  in which case the card prints only the step. */
  total?: number;
}

/** One piece of an answer: the prose, or a card standing between two runs of
 *  it. Splitting is what lets the card be a real block element instead of a
 *  `<pre>` with a section smuggled inside it. */
export type CheckpointSegment =
  | { checkpoint: EvolveCheckpoint; kind: "checkpoint" }
  | { kind: "markdown"; text: string };

// The block's own name, and the skill's. A model told where the card comes
// from reaches for `evolve-design` about as often as for the literal tag, and
// the two are the same record: refusing the second only costs the reader a
// card. Anything else stays a code block.
const OPEN = /^```(?:evolve-checkpoint|evolve-design)[ \t]*$/u;
const CLOSE = /^```[ \t]*$/u;
const FIELD = /^([A-Za-z]+)[ \t]*:[ \t]*(.*)$/u;

/**
 * Read one fenced block's body, or nothing.
 *
 * The block is a small front matter — `step`, `total`, `pace`, `title` — a
 * `---` line, then the checkpoint's prose. Anything malformed returns
 * `undefined` so the caller can leave the fence in the answer as a plain code
 * block: a model that writes a broken card mid-run should not make its words
 * vanish. The same path covers a fence that has not finished streaming — the
 * next card's opening line, a frame before its content — and it appears as a
 * code block for that moment.
 */
export function parseEvolveCheckpoint(raw: string): EvolveCheckpoint | undefined {
  const lines = raw.split("\n");
  const divider = lines.findIndex((line) => line.trim() === "---");
  const header = divider === -1 ? lines : lines.slice(0, divider);
  const body = (divider === -1 ? [] : lines.slice(divider + 1)).join("\n").trim();

  const fields = new Map<string, string>();
  for (const line of header) {
    const match = FIELD.exec(line.trim());
    if (match) fields.set(match[1]!.toLowerCase(), match[2]!.trim());
  }

  const step = Number(fields.get("step"));
  if (!Number.isInteger(step) || step < 1) return undefined;
  const totalText = fields.get("total");
  const total = totalText === undefined ? undefined : Number(totalText);
  if (total !== undefined && (!Number.isInteger(total) || total < step)) return undefined;
  const title = fields.get("title")?.trim() || undefined;
  // A card with neither a title nor a body would be a blank box. Keep the
  // fence visible instead, where at least the reason is on screen.
  if (title === undefined && body === "") return undefined;
  return {
    body,
    pace: fields.get("pace") === "auto" ? "auto" : "confirm",
    step,
    title,
    ...(total === undefined ? {} : { total }),
  };
}

/**
 * Cut an answer into prose and checkpoints.
 *
 * Line-based rather than a regex over the whole string: the closing fence has
 * to be found before the block can be parsed, and a fence with no close yet is
 * not an error — it is the middle of a streamed answer, and it stays in the
 * prose so it renders as the code block CommonMark makes of an unclosed fence.
 */
export function splitEvolveCheckpoints(text: string): CheckpointSegment[] {
  const segments: CheckpointSegment[] = [];
  const prose: string[] = [];
  const flush = () => {
    const joined = prose.join("\n");
    if (joined.trim() !== "") segments.push({ kind: "markdown", text: joined });
    prose.length = 0;
  };

  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!OPEN.test(line)) {
      prose.push(line);
      continue;
    }
    let close = -1;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (CLOSE.test(lines[cursor]!)) {
        close = cursor;
        break;
      }
    }
    if (close === -1) {
      prose.push(...lines.slice(index));
      break;
    }
    const checkpoint = parseEvolveCheckpoint(lines.slice(index + 1, close).join("\n"));
    if (checkpoint === undefined) {
      prose.push(...lines.slice(index, close + 1));
      index = close;
      continue;
    }
    flush();
    segments.push({ checkpoint, kind: "checkpoint" });
    index = close;
  }
  flush();
  return segments;
}
