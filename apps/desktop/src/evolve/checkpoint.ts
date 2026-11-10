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

/**
 * How many checkpoints a design asks the reader to answer.
 *
 * `total` counts the steps the model writes, and the last of them is the record
 * of the run starting — it is drawn as a record and nobody confirms it. So a
 * design numbered 1 to 4 asks three questions, and every number the card prints
 * or sends has to be counted this way: the badge and the sentence under it are
 * one line apart, and a card that says 「2/3」 over a button that answers
 * 「2/4」 reads as a bug, which it was.
 */
export function askedCheckpoints(total: number | undefined): number | undefined {
  return total === undefined ? undefined : Math.max(1, total - 1);
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
const FENCE = /^```/u;
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
 * Where the card opened at `open` ends, or `-1` if it has not ended yet.
 *
 * The first bare fence is the obvious answer and the wrong one whenever the
 * card's own body contains a code block: ` ```text ` opens one, and the bare
 * fence that closes it would cut the card in half. So a fence carrying an info
 * string is treated as a nested opener and skipped with its close, the way
 * CommonMark would.
 *
 * The harder shape is a body that opens a **bare** fence by mistake — the one
 * fence the parser cannot tell from the card's own close. Such a block is
 * supposed to be paired, so an odd count of bare fences left after the
 * candidate means the candidate was itself an opener and the last fence is the
 * card's real end. That is how a message which forgot to close the card still
 * renders as a card followed by its prose instead of a card that stops at the
 * first line of a code block.
 */
function findClose(lines: string[], open: number): number {
  let depth = 0;
  let candidate = -1;
  let nextCard = lines.length;
  for (let cursor = open + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]!;
    // A second card at depth 0 is the boundary: whatever this one left open
    // belongs to this message, not to the next card's body.
    if (depth === 0 && OPEN.test(line)) {
      nextCard = cursor;
      break;
    }
    if (!FENCE.test(line)) continue;
    // Past the candidate the only thing left to find is the next card; the
    // fences in between are what the count below measures.
    if (candidate !== -1) continue;
    if (depth > 0) {
      if (CLOSE.test(line)) depth -= 1;
      continue;
    }
    if (CLOSE.test(line)) {
      candidate = cursor;
      continue;
    }
    depth += 1;
  }
  if (candidate === -1) {
    // A body that opens a block it never closes — observed live: the model
    // tagged a ```yaml block and then used the card's own fence to end it, so
    // the depth never returned to zero. The last fence in the message is the
    // card's end; the block inside stays open and renders as code to the end
    // of the body, which is what the model meant by it.
    for (let cursor = nextCard - 1; cursor > open; cursor -= 1) {
      if (CLOSE.test(lines[cursor]!)) return cursor;
    }
    return -1;
  }
  const remaining = lines
    .slice(candidate + 1, nextCard)
    .filter((line) => CLOSE.test(line))
    .length;
  if (remaining % 2 === 1) {
    for (let cursor = nextCard - 1; cursor > candidate; cursor -= 1) {
      if (CLOSE.test(lines[cursor]!)) return cursor;
    }
  }
  return candidate;
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
    const close = findClose(lines, index);
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

/** The step an answer ended on, when the design still has steps to run.
 *
 *  An auto card is a record — nothing to press — and the skill asks the model
 *  to go on with the next step in the same turn. Models end the turn on a
 *  formatted block often enough that "asks for nothing" turned into "the whole
 *  design stops at step 1", so the desktop reads this and carries the flow
 *  forward itself. Only an answer that *ends* on a non-final auto card counts:
 *  a card with prose after it, a confirm card, or the last step (the search is
 *  already running) means the turn ended for a reason.
 */
export function trailingAutoStep(text: string): { step: number; total?: number } | undefined {
  const last = splitEvolveCheckpoints(text).at(-1);
  if (last?.kind !== "checkpoint") return undefined;
  const { pace, step, total } = last.checkpoint;
  if (pace !== "auto") return undefined;
  if (total !== undefined && step >= total) return undefined;
  return { step, total };
}
