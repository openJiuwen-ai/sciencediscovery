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
 * One node, as the drawer over the tree.
 *
 * The handoff orders it as a reader actually asks: which node is this and is it
 * the winner, where did it come from, how did it score and how much did it
 * branch, what did it change, and finally the code itself. The last block is a
 * diff against the parent rather than the whole program — a winning program
 * grows from a few hundred characters to a few thousand, and the interesting
 * part is the few lines that are new.
 *
 * Expanding the source opens the same diff in the middle of the window. Both
 * views read one diff, so a line cannot be hidden in one and shown in the
 * other.
 */

import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

import type { ApiClient } from "../../api/client.js";
import { getEvolveCandidate } from "../../api/evolve.js";
import type { EvolveCandidateView } from "../../evolve/model.js";
import { formatScore } from "../../evolve/model.js";
import { collapseContext, diffLines } from "../../evolve/text-diff.js";
import { TEXT } from "../../text.js";
import { claimsEscape } from "../dialog-escape.js";
import { ChildrenGlyph, CrownGlyph, ExpandGlyph, TrophyGlyph } from "./glyphs.js";

type Sources = { after: string; before: string } | "loading" | "missing";

export interface CandidateInspectorProps {
  /** Whether this node is the best in the run. */
  best?: boolean;
  candidate: EvolveCandidateView;
  childCount: number;
  client: ApiClient;
  onClose: () => void;
  parent?: EvolveCandidateView;
  runId: string;
}

export function CandidateInspector({
  best = false,
  candidate,
  childCount,
  client,
  onClose,
  parent,
  runId,
}: CandidateInspectorProps) {
  const [sources, setSources] = useState<Sources>("loading");
  const [expanded, setExpanded] = useState(false);
  const titleId = useId();

  useEffect(() => {
    const own = candidate.codeHash;
    if (own === undefined) {
      setSources("missing");
      return;
    }
    let cancelled = false;
    setSources("loading");
    void (async () => {
      try {
        const [after, before] = await Promise.all([
          getEvolveCandidate(client, runId, own),
          // The root has no parent to compare against; an empty "before" makes
          // the diff read as "all of this is the starting point", which is true.
          parent?.codeHash === undefined
            ? Promise.resolve({ hash: "", source: "" })
            : getEvolveCandidate(client, runId, parent.codeHash),
        ]);
        if (!cancelled) setSources({ after: after.source, before: before.source });
      } catch {
        // A pruned run, or a hash this run never wrote. Nothing to retry.
        if (!cancelled) setSources("missing");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [candidate.codeHash, client, parent?.codeHash, runId]);

  // A new selection is a new node: the full-window source view of the old one
  // has nothing to do with it.
  useEffect(() => {
    setExpanded(false);
  }, [candidate.nodeIndex]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (!claimsEscape(event)) return;
      event.preventDefault();
      setExpanded(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [expanded]);

  const rows = typeof sources === "object"
    ? collapseContext(diffLines(sources.before, sources.after))
    : { hidden: 0, rows: [] };
  const score = candidate.gateScore ?? candidate.score;
  const root = candidate.parentIndex === null;

  return <div className="evolve-drawer">
    <header className="evolve-drawer-head">
      <h2>
        {TEXT.evolve.detail.nodeTitle(candidate.nodeIndex)}
        {best ? <span className="evolve-node-best">
          <CrownGlyph size={12} />
          {TEXT.evolve.detail.bestTag}
        </span> : null}
      </h2>
      <button
        aria-label={TEXT.evolve.detail.closeInspector}
        className="evolve-drawer-close"
        onClick={onClose}
        title={TEXT.evolve.detail.closeInspector}
        type="button"
      >
        ×
      </button>
    </header>

    <p className="evolve-drawer-meta">
      {root
        ? TEXT.evolve.detail.root
        : `${TEXT.evolve.inspector.parent} #${candidate.parentIndex} · ${TEXT.evolve.detail.generation(candidate.depth)}`}
    </p>

    <div className="evolve-drawer-tiles">
      <div className="evolve-drawer-tile is-score">
        <span aria-hidden="true" className="evolve-drawer-tile-icon"><TrophyGlyph size={20} /></span>
        <span className="evolve-drawer-tile-value">{candidate.valid ? formatScore(score) : "-"}</span>
        <span className="evolve-drawer-tile-label">{TEXT.evolve.detail.score}</span>
      </div>
      <div className="evolve-drawer-tile is-children">
        <span aria-hidden="true" className="evolve-drawer-tile-icon"><ChildrenGlyph size={20} /></span>
        <span className="evolve-drawer-tile-value">{childCount}</span>
        <span className="evolve-drawer-tile-label">{TEXT.evolve.detail.children}</span>
      </div>
    </div>

    <p className="evolve-drawer-note">
      {candidate.changeSummary
        || candidate.reason
        || candidate.error
        || (root ? TEXT.evolve.inspector.noParent : "—")}
    </p>

    {candidate.valid ? null : <section className="evolve-drawer-error">
      <h3>{TEXT.evolve.inspector.error}</h3>
      {/* The full text, not a truncation: the tail of a traceback is usually
          the half that says what to change. */}
      <pre>{candidate.error || candidate.reason || "—"}</pre>
    </section>}

    <section className="evolve-drawer-source">
      <header>
        <h3>{TEXT.evolve.detail.source}</h3>
        <button
          aria-label={TEXT.evolve.detail.expandSource}
          className="evolve-drawer-expand"
          disabled={typeof sources !== "object"}
          onClick={() => setExpanded(true)}
          title={TEXT.evolve.detail.expandSource}
          type="button"
        >
          <ExpandGlyph />
        </button>
      </header>
      <SourceBody rows={rows.rows} sources={sources} />
      {rows.hidden > 0 ? <p className="evolve-source-hidden">
        {TEXT.evolve.inspector.hidden(rows.hidden)}
      </p> : null}
    </section>

    {!expanded ? null : createPortal(
      <div
        className="evolve-source-backdrop"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) setExpanded(false);
        }}
      >
        <section
          aria-labelledby={titleId}
          aria-modal="true"
          className="evolve-source-modal"
          role="dialog"
        >
          <header className="evolve-source-head">
            <h2 id={titleId}>{TEXT.evolve.detail.source}</h2>
            <button
              aria-label={TEXT.evolve.detail.closeSource}
              className="evolve-drawer-close"
              onClick={() => setExpanded(false)}
              title={TEXT.evolve.detail.closeSource}
              type="button"
            >
              ×
            </button>
          </header>
          <div className="evolve-source-scroll">
            <SourceBody rows={rows.rows} sources={sources} />
            {rows.hidden > 0 ? <p className="evolve-source-hidden">
              {TEXT.evolve.inspector.hidden(rows.hidden)}
            </p> : null}
          </div>
        </section>
      </div>,
      document.body,
    )}
  </div>;
}

function SourceBody({ rows, sources }: {
  rows: ReturnType<typeof collapseContext>["rows"];
  sources: Sources;
}) {
  if (sources === "loading") {
    return <p className="evolve-inspector-note">{TEXT.evolve.inspector.loading}</p>;
  }
  if (sources === "missing") {
    return <p className="evolve-inspector-note">{TEXT.evolve.inspector.unavailable}</p>;
  }
  if (rows.length === 0) {
    return <p className="evolve-inspector-note">{TEXT.evolve.inspector.unchanged}</p>;
  }
  return <div className="evolve-diff">
    {rows.map((row, at) => <div className={`evolve-diff-row is-${row.kind}`} key={at}>
      <span aria-hidden="true" className="evolve-diff-num">{row.leftLine ?? ""}</span>
      <span aria-hidden="true" className="evolve-diff-num">{row.rightLine ?? ""}</span>
      <span aria-hidden="true" className="evolve-diff-mark">
        {row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " "}
      </span>
      <code className="evolve-diff-text">{row.text || " "}</code>
    </div>)}
  </div>;
}
