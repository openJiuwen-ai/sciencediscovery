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
 * The strip under an assistant turn that says which files that turn wrote
 * (#1252).
 *
 * The artifacts themselves live in the right panel, grouped by Session. That
 * answers "what does this research hold"; it does not answer "what did this
 * answer hand me", which is the question a reader has while following the
 * conversation. The versions carry the run that wrote them, so the turn can
 * answer it without leaving the transcript.
 *
 * Cards, not rows: two to a line (see `conversation.css`), because a full-width
 * bar per file reads as a table of contents and pushes the next answer down the
 * page. A card says "a file", carries the kind in its icon, and two of them fit
 * beside each other in the transcript's column.
 *
 * Opening one is the panel's own gesture, not the dialog's: the reader who
 * presses a file wants to read it in the place they already read files, with its
 * versions and its neighbours beside it.
 *
 * The caller decides when to draw the strip: only once the run is terminal, the
 * same signal the rest of the transcript uses to settle a turn. A list that
 * grows and reshuffles under the reader while the run is still writing is worse
 * than no list.
 */
import { memo } from "react";

import type { ScientificArtifactKind } from "@sciencediscovery/schema";

import { formatBytes } from "../app/format-bytes.js";
import type { TurnArtifact, TurnArtifacts } from "../app/turn-artifacts.js";
import { TEXT } from "../text.js";

export interface TurnArtifactStripProps {
  /** The artifacts this turn produced; absent or empty means no strip. */
  artifacts?: TurnArtifacts;
  /** Show one artifact in the right panel, at the version the card names. */
  onPreviewArtifact?: (row: TurnArtifact) => void;
  /** Open the right panel's artifact group — the strip's route to the rest. */
  onOpenArtifactPanel?: () => void;
}

/**
 * One glyph per kind, in the same 24-unit stroke language as the panel's own
 * icons. They answer "what sort of thing is this" before the label is read,
 * which is the reason a card is not just a filename in a box.
 */
function KindIcon({ kind }: { kind: ScientificArtifactKind }) {
  const paths = (() => {
    switch (kind) {
      case "figure":
        return <><rect height="15" rx="2.5" width="18" x="3" y="4.5" /><path d="m4 16 4.5-5 3.5 3.5 3-3L20 17" /><circle cx="9" cy="9" r="1.2" /></>;
      case "dataset":
        return <><rect height="16" rx="2.5" width="18" x="3" y="4" /><path d="M3 9.5h18M3 15h18M9 4v16" /></>;
      case "structure":
        return <><circle cx="12" cy="5" r="2" /><circle cx="5.5" cy="17" r="2" /><circle cx="18.5" cy="17" r="2" /><path d="M10.7 6.7 6.8 15.3M13.3 6.7l3.9 8.6M7.5 17h9" /></>;
      case "notebook":
        return <><rect height="16" rx="2" width="14" x="5" y="4" /><path d="M9 4v16M12 8.5h4M12 12h4" /></>;
      case "html":
        return <><path d="m9 8-4 4 4 4M15 8l4 4-4 4" /><path d="m13.5 5-3 14" /></>;
      case "latex":
        return <><path d="M17 5.5h-6.5l4 6-4 6H17" /><path d="M6 5.5h2.5M6 17.5h2.5" /></>;
      case "json":
        return <><path d="M9 4.5c-2 0-2.5 1-2.5 3v2c0 2-1 2.5-2 2.5 1 0 2 .5 2 2.5v2c0 2 .5 3 2.5 3" /><path d="M15 4.5c2 0 2.5 1 2.5 3v2c0 2 1 2.5 2 2.5-1 0-2 .5-2 2.5v2c0 2-.5 3-2.5 3" /></>;
      case "report":
      case "markdown":
        return <><path d="M14 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V7.5z" /><path d="M14 3.5V8h4" /><path d="M9 12h6M9 15.5h4" /></>;
      default:
        return <><path d="M14 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V7.5z" /><path d="M14 3.5V8h4" /></>;
    }
  })();
  return (
    <svg
      aria-hidden="true"
      className="turn-artifact-glyph"
      fill="none"
      height="17"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 24 24"
      width="17"
    >
      {paths}
    </svg>
  );
}

/**
 * One file. The whole card is the way in — there is no small control beside it
 * to aim at — and it opens the panel at exactly the version printed here, so the
 * card and the document never disagree about which version is on screen.
 */
function Card({ onPreviewArtifact, row }: { onPreviewArtifact?: (row: TurnArtifact) => void; row: TurnArtifact }) {
  const t = TEXT.turnArtifacts;
  const name = row.artifact.title?.trim() || row.artifact.name;
  const meta = [t.kinds[row.artifact.kind], t.version(row.version.version), formatBytes(row.version.content.size)].join(" · ");
  return (
    <button
      aria-label={`${name} · ${meta}`}
      className="turn-artifact"
      disabled={!onPreviewArtifact}
      onClick={() => onPreviewArtifact?.(row)}
      title={`${name} · ${meta}`}
      type="button"
    >
      <span aria-hidden="true" className={`turn-artifact-icon is-${row.artifact.kind}`}>
        <KindIcon kind={row.artifact.kind} />
      </span>
      <span className="turn-artifact-text">
        <span className="turn-artifact-name">{name}</span>
        <span className="turn-artifact-meta">
          {row.updated ? <span className="turn-artifact-badge">{t.updated}</span> : null}
          <span className="turn-artifact-facts">{meta}</span>
        </span>
      </span>
    </button>
  );
}

export const TurnArtifactStrip = memo(function TurnArtifactStrip({
  artifacts,
  onPreviewArtifact,
  onOpenArtifactPanel,
}: TurnArtifactStripProps) {
  if (!artifacts || artifacts.visible.length === 0) return null;
  const t = TEXT.turnArtifacts;
  return (
    <section aria-label={t.title} className="turn-artifacts">
      <p className="turn-artifacts-title">{t.title}</p>
      <ul className="turn-artifacts-list">
        {artifacts.visible.map((row) => (
          <li key={row.artifact.id}>
            <Card onPreviewArtifact={onPreviewArtifact} row={row} />
          </li>
        ))}
        {artifacts.hidden > 0 ? (
          <li>
            <button
              className="turn-artifact turn-artifact-rest"
              disabled={!onOpenArtifactPanel}
              onClick={onOpenArtifactPanel}
              title={t.openPanel}
              type="button"
            >
              <span aria-hidden="true" className="turn-artifact-icon is-rest">
                <svg fill="none" height="17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24" width="17">
                  <circle cx="6" cy="12" r="1.4" />
                  <circle cx="12" cy="12" r="1.4" />
                  <circle cx="18" cy="12" r="1.4" />
                </svg>
              </span>
              <span className="turn-artifact-text">
                <span className="turn-artifact-name">{t.more(artifacts.hidden)}</span>
                <span className="turn-artifact-meta">{t.openPanel}</span>
              </span>
            </button>
          </li>
        ) : null}
      </ul>
    </section>
  );
});
