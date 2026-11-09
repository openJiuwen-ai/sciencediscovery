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

import { memo } from "react";

import type { ComposerReference } from "./api/types.js";
import { splitEvolveCheckpoints } from "./evolve/checkpoint.js";
import { MarkdownProse } from "./MarkdownProse.js";
import { CheckpointCard } from "./views/CheckpointCard.js";

interface Props {
  children: string;
  /** Opens the memory card for a chip in a final report. Without one the
   *  citation still renders as a chip, but it cannot be pressed: a report
   *  shown somewhere with no card surface would otherwise look interactive
   *  and do nothing. */
  onReferenceClick?: (reference: ComposerReference) => void;
  /**
   * The aliases a report cites, from the version's own `references`.
   *
   * Plain Markdown has no way to know that `[evidence1]` is a citation; the
   * map is what makes the alias a link at all. Every other Markdown surface
   * in the app renders without this and is unchanged.
   */
  references?: ComposerReference[];
}

/**
 * The assistant's prose, with evolve's checkpoints drawn as cards.
 *
 * A design conversation pauses four times, and a checkpoint is a step the
 * reader answers rather than a paragraph they read — so it is drawn as a card
 * with its own buttons, not as more text under the answer. The model marks one
 * with a fenced `evolve-checkpoint` block; everything else is ordinary
 * markdown and goes to `MarkdownProse` untouched.
 *
 * The split happens at render time, per answer, because that is the only form
 * the card survives in: stored transcripts keep the text, not events, so a
 * card built from a transient tool call would be gone after a reload. See
 * `evolve/checkpoint.ts` for the fence and its parsing rules.
 */
export const Markdown = memo(function Markdown({ children, onReferenceClick, references }: Props) {
  const segments = splitEvolveCheckpoints(children);
  // The common answer has no fence at all, and then this is exactly the plain
  // renderer — no extra wrapper, no keys the transcript has to carry.
  if (segments.length === 1 && segments[0]!.kind === "markdown") {
    return (
      <MarkdownProse onReferenceClick={onReferenceClick} references={references}>
        {segments[0]!.text}
      </MarkdownProse>
    );
  }
  return (
    <>
      {segments.map((segment, index) => (
        segment.kind === "checkpoint"
          ? <CheckpointCard checkpoint={segment.checkpoint} key={`checkpoint-${index}`} />
          : (
            <MarkdownProse key={`prose-${index}`} onReferenceClick={onReferenceClick} references={references}>
              {segment.text}
            </MarkdownProse>
          )
      ))}
    </>
  );
});
