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
 * The caller decides when to draw it: only once the run is terminal, the same
 * signal the rest of the transcript uses to settle a turn. A list that grows
 * and reshuffles under the reader while the run is still writing is worse than
 * no list.
 */
import { memo } from "react";

import type { ComposerReference } from "../api/types.js";
import { formatBytes } from "../app/format-bytes.js";
import type { TurnArtifact, TurnArtifacts } from "../app/turn-artifacts.js";
import { TEXT } from "../text.js";

export interface TurnArtifactStripProps {
  /** The artifacts this turn produced; absent or empty means no strip. */
  artifacts?: TurnArtifacts;
  /** Open one artifact at exactly the version the row states. */
  onOpenArtifact?: (reference: ComposerReference) => void;
  /** Open the right panel's artifact group — the door to everything else. */
  onOpenArtifactPanel?: () => void;
}

function rowMeta(row: TurnArtifact): string {
  const t = TEXT.turnArtifacts;
  return [t.kinds[row.artifact.kind], t.version(row.version.version), formatBytes(row.version.content.size)].join(" · ");
}

/**
 * One row per artifact. The reference states the version, which is what makes
 * the dialog land on the version the row shows instead of the newest one: the
 * reader clicked `v3` and must get `v3`.
 */
function Row({ onOpenArtifact, row }: { onOpenArtifact?: (reference: ComposerReference) => void; row: TurnArtifact }) {
  const name = row.artifact.title?.trim() || row.artifact.name;
  const meta = rowMeta(row);
  return (
    <li>
      <button
        aria-label={`${name} · ${meta}`}
        className="turn-artifact"
        disabled={!onOpenArtifact}
        onClick={() => onOpenArtifact?.({
          id: row.artifact.id,
          kind: "artifact",
          label: name,
          sessionId: row.version.sessionId,
          version: row.version.version,
        })}
        type="button"
      >
        <span className="turn-artifact-name">{name}</span>
        {row.updated ? <span className="turn-artifact-badge">{TEXT.turnArtifacts.updated}</span> : null}
        <span className="turn-artifact-meta">{meta}</span>
      </button>
    </li>
  );
}

export const TurnArtifactStrip = memo(function TurnArtifactStrip({
  artifacts,
  onOpenArtifact,
  onOpenArtifactPanel,
}: TurnArtifactStripProps) {
  if (!artifacts || artifacts.visible.length === 0) return null;
  const t = TEXT.turnArtifacts;
  return (
    <section aria-label={t.title} className="turn-artifacts">
      <p className="turn-artifacts-title">{t.title}</p>
      <ul className="turn-artifacts-list">
        {artifacts.visible.map((row) => (
          <Row key={row.artifact.id} onOpenArtifact={onOpenArtifact} row={row} />
        ))}
      </ul>
      {artifacts.hidden > 0 ? (
        <button
          className="turn-artifacts-more"
          disabled={!onOpenArtifactPanel}
          onClick={onOpenArtifactPanel}
          title={t.openPanel}
          type="button"
        >
          {t.more(artifacts.hidden)}
        </button>
      ) : null}
    </section>
  );
});
