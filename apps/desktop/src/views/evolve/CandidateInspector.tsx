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
 * One candidate, with the diff against its parent as the main thing.
 *
 * Diff rather than the whole program: a winning program grows from a few
 * hundred characters to a few thousand, and the interesting part is the few
 * lines that are new. A failed candidate shows its error instead — there is
 * nothing to diff, and the error is the only thing that would help.
 *
 * The scores stay apart for the same reason the chart draws them apart:
 * rollout is what the search saw, gate is what decided.
 */

import { useEffect, useState } from "react";

import type { ApiClient } from "../../api/client.js";
import { getEvolveCandidate } from "../../api/evolve.js";
import type { EvolveCandidateView } from "../../evolve/model.js";
import { formatScore, verdictOf } from "../../evolve/model.js";
import { collapseContext, diffLines, type DiffRow } from "../../evolve/text-diff.js";
import { TEXT } from "../../text.js";
import { EvolveGlyph } from "./glyphs.js";

type Sources = { after: string; before: string } | "loading" | "missing";

export interface CandidateInspectorProps {
  candidate?: EvolveCandidateView;
  client: ApiClient;
  onClose: () => void;
  parent?: EvolveCandidateView;
  runId: string;
}

export function CandidateInspector({ candidate, client, onClose, parent, runId }: CandidateInspectorProps) {
  const [sources, setSources] = useState<Sources>("loading");

  useEffect(() => {
    if (candidate === undefined) return;
    // A root has no parent to compare against, so there is nothing to fetch.
    if (candidate.parentIndex === null) {
      setSources("missing");
      return;
    }
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
          // The baseline has no parent hash; an empty "before" makes the diff
          // read as "all of this is new", which for the first expansion is true.
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
  }, [candidate, client, parent?.codeHash, runId]);

  if (candidate === undefined) {
    return <div className="evolve-inspector-empty">
      <span aria-hidden="true" className="evolve-inspector-mark"><EvolveGlyph size={22} /></span>
      <strong>{TEXT.evolve.inspector.emptyTitle}</strong>
      <p>{TEXT.evolve.inspector.emptyBody}</p>
    </div>;
  }

  const root = candidate.parentIndex === null;
  const verdict = verdictOf(candidate);
  const rows = typeof sources === "object"
    ? collapseContext(diffLines(sources.before, sources.after))
    : { hidden: 0, rows: [] as DiffRow[] };

  return <div className="evolve-inspector-body">
    <header className="evolve-inspector-head">
      <div>
        <p className="evolve-inspector-eyebrow">
          {TEXT.evolve.inspector.title} #{candidate.nodeIndex}
          {root
            ? ` · ${TEXT.evolve.inspector.depth} 0`
            : ` · ${TEXT.evolve.inspector.parent} #${candidate.parentIndex} · ${TEXT.evolve.inspector.depth} ${candidate.depth}`}
        </p>
        <h3>{candidate.changeSummary || (root ? TEXT.evolve.table.root : "—")}</h3>
      </div>
      <button aria-label={TEXT.evolve.inspector.close} className="evolve-inspector-close" onClick={onClose} type="button">
        ×
      </button>
    </header>

    <span className={`evolve-verdict is-${root ? "root" : verdict}`}>
      {root
        ? TEXT.evolve.table.root
        : verdict === "accepted" ? TEXT.evolve.table.accepted
          : verdict === "failed" ? TEXT.evolve.table.failed
            : verdict === "violated" ? candidate.rejectedBy ?? TEXT.evolve.table.violated
              : TEXT.evolve.table.rejected}
    </span>

    <dl className="evolve-inspector-scores">
      <div><dt>{TEXT.evolve.inspector.gate}</dt><dd>{formatScore(candidate.gateScore)}</dd></div>
      <div><dt>{TEXT.evolve.inspector.rollout}</dt><dd>{formatScore(candidate.rolloutScore ?? candidate.score)}</dd></div>
      {/* Only when a judged prior actually rated this one. A dash for every
          run without the factor would put an empty column in front of
          everybody to serve the few runs that use it. */}
      {candidate.promise === undefined ? null : <div>
        <dt>{TEXT.evolve.inspector.prior}</dt>
        <dd>{candidate.promise.toFixed(1)}</dd>
      </div>}
      <div><dt>{TEXT.evolve.inspector.visits}</dt><dd>{candidate.visits}</dd></div>
    </dl>

    {candidate.valid ? null : <section className="evolve-inspector-error">
      <h4>{TEXT.evolve.inspector.error}</h4>
      {/* The full text, not a truncation: the tail of a traceback is usually
          the half that says what to change. */}
      <pre>{candidate.error || candidate.reason || "—"}</pre>
    </section>}

    {root ? <p className="evolve-inspector-note">{TEXT.evolve.inspector.noParent}</p> : <section className="evolve-diff-block">
      <h4>{TEXT.evolve.inspector.diff}</h4>
      {sources === "loading" ? <p className="evolve-inspector-note">{TEXT.evolve.inspector.loading}</p> : null}
      {sources === "missing" ? <p className="evolve-inspector-note">{TEXT.evolve.inspector.unavailable}</p> : null}
      {typeof sources === "object" && rows.rows.length === 0
        ? <p className="evolve-inspector-note">{TEXT.evolve.inspector.unchanged}</p>
        : null}
      {rows.rows.length === 0 ? null : <div className="evolve-diff">
        {rows.rows.map((row, at) => <div className={`evolve-diff-row is-${row.kind}`} key={at}>
          <span aria-hidden="true" className="evolve-diff-num">{row.leftLine ?? ""}</span>
          <span aria-hidden="true" className="evolve-diff-num">{row.rightLine ?? ""}</span>
          <span aria-hidden="true" className="evolve-diff-mark">
            {row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " "}
          </span>
          <code className="evolve-diff-text">{row.text || " "}</code>
        </div>)}
      </div>}
      {rows.hidden > 0 ? <p className="evolve-inspector-note">
        {TEXT.evolve.inspector.hidden(rows.hidden)}
      </p> : null}
    </section>}
  </div>;
}
