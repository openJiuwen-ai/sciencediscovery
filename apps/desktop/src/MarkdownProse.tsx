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

import { memo, useMemo } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

import type { ComposerReference } from "./api/types.js";
import {
  buildChipIndex,
  referenceNodeLabel,
  referencesByUrl,
  remarkGraphChips,
} from "./app/memory-chips.js";
import { TEXT } from "./text.js";

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

/** Let graph:// chip URLs through unchanged (the custom `a` renderer turns
 *  them into buttons); apply the default safety transform to everything else
 *  so javascript: and other unsafe protocols stay stripped. */
function preserveGraphChipUrls(url: string): string {
  return url.startsWith("graph://") ? url : defaultUrlTransform(url);
}

/**
 * Markdown, with nothing taken out of it.
 *
 * This is the renderer a checkpoint card's own body uses: `Markdown` splits an
 * answer and draws the cards, so a card that called `Markdown` again would
 * look for checkpoints in its own body. Keeping the plain renderer here also
 * means the two cannot drift apart — the prose outside a card and the prose
 * inside one are the same element.
 *
 * GitHub-flavoured Markdown is on because tables and task lists are how the
 * model reports most results. Math is not: the prototype renders formulas and
 * the full app bundles KaTeX for them, but carrying that in the first version
 * buys a font and a stylesheet for a case the plain renderer already degrades
 * to readable text.
 *
 * Links open outside the app. Inside an Electron window an unhandled `target`
 * would put a second window on screen, so the shell is configured to hand
 * these to the system browser; in a plain browser this is an ordinary new tab.
 *
 * A table comes out wrapped in a scroller because a table is the one thing here
 * that cannot be made narrower: its columns are as wide as their content, and
 * the widths are the model's, not ours. The workspace panel can be dragged down
 * to 280px, and a table that does not fit has to scroll — its parent clips, so
 * without this the columns on the right would simply be gone.
 *
 * Report citations (`[evidence1]`) become chips: a small button that opens the
 * memory card for the node it names. The chip keeps the alias the report wrote
 * and adds no vocabulary of its own — the reader already sees whether it is
 * evidence or an artifact from the word itself. It is a button rather than a
 * link because it opens a dialog, not a document.
 */
export const MarkdownProse = memo(function MarkdownProse({ children, onReferenceClick, references }: Props) {
  const chipIndex = useMemo(() => buildChipIndex(references), [references]);
  const byUrl = useMemo(() => referencesByUrl(references), [references]);
  const chipReady = onReferenceClick !== undefined;

  return (
    <ReactMarkdown
      components={{
        a: ({ children: label, href }) => {
          if (href?.startsWith("graph://")) {
            const reference = byUrl.get(href);
            const nodeLabel = reference === undefined ? undefined : referenceNodeLabel(reference.kind);
            return (
              <button
                aria-label={reference === undefined ? undefined : String(label).replace(/^\[|\]$/g, "")}
                className={`graph-chip is-${reference?.kind ?? "other"}`}
                disabled={!chipReady || reference === undefined || nodeLabel === undefined}
                onClick={() => {
                  if (reference !== undefined) onReferenceClick?.(reference);
                }}
                title={reference === undefined ? undefined : TEXT.memory.openChip}
                type="button"
              >
                <span className="graph-chip-label">{String(label).replace(/^\[|\]$/g, "")}</span>
              </button>
            );
          }
          return <a href={href} rel="noreferrer" target="_blank">{label}</a>;
        },
        table: ({ children: rows }) => (
          <div className="md-scroll">
            <table>{rows}</table>
          </div>
        ),
      }}
      remarkPlugins={[remarkGfm, [remarkGraphChips, { index: chipIndex }]]}
      urlTransform={preserveGraphChipUrls}
    >
      {children}
    </ReactMarkdown>
  );
});
