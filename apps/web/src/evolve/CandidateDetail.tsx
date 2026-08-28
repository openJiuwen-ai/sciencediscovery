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
 * Diff rather than the whole program, because a winning program grows from a
 * few hundred characters to a few thousand and the interesting part is the few
 * lines that are new. A failed candidate shows its error instead: there is
 * nothing to diff, and the error is the only thing that would help.
 *
 * The three scores are shown apart for the same reason the chart draws three
 * lines — rollout is what the search saw, gate is what decided.
 */

import { useEffect, useState } from "react";

import type { ApiClient } from "../api.js";
import { useLocale } from "../i18n/LocaleProvider.js";

import type { EvolveCandidateView } from "./model.js";
import { collapseContext, diffLines, type DiffRow } from "./text-diff.js";

export interface CandidateDetailProps {
  candidate: EvolveCandidateView;
  client: ApiClient;
  onClose: () => void;
  parent?: EvolveCandidateView;
  runId: string;
}

type Sources = { after: string; before: string } | "missing" | "loading";

export function CandidateDetail({ candidate, client, onClose, parent, runId }: CandidateDetailProps) {
  const { t } = useLocale();
  const [sources, setSources] = useState<Sources>("loading");

  useEffect(() => {
    let cancelled = false;
    const own = candidate.codeHash;
    const from = parent?.codeHash;
    if (!own) {
      setSources("missing");
      return () => { cancelled = true; };
    }
    setSources("loading");
    void (async () => {
      try {
        const [after, before] = await Promise.all([
          client.getEvolveCandidate(runId, own),
          // The baseline has no parent hash; an empty "before" makes the diff
          // read as "all of this is new", which for the first expansion is true.
          from ? client.getEvolveCandidate(runId, from) : Promise.resolve({ hash: "", source: "" }),
        ]);
        if (!cancelled) setSources({ after: after.source, before: before.source });
      } catch {
        // A pruned run, or a hash this run never wrote. Nothing to retry.
        if (!cancelled) setSources("missing");
      }
    })();
    return () => { cancelled = true; };
  }, [candidate.codeHash, client, parent?.codeHash, runId]);

  const rows = typeof sources === "object"
    ? collapseContext(diffLines(sources.before, sources.after))
    : { hidden: 0, rows: [] as DiffRow[] };

  return <aside aria-label={t("evolve.detail.title")} className="evolve-detail">
    <header className="evolve-detail-header">
      <div>
        <p className="evolve-detail-eyebrow">
          {t("evolve.detail.title")} #{candidate.nodeIndex}
          {candidate.parentIndex === null ? "" : ` · ${t("evolve.stream.parent")} #${candidate.parentIndex}`}
          {` · d${candidate.depth}`}
        </p>
        <h3 className="evolve-detail-title">{candidate.changeSummary || "—"}</h3>
      </div>
      <button className="evolve-detail-close" onClick={onClose} type="button">
        {t("evolve.detail.close")}
      </button>
    </header>

    <dl className="evolve-detail-scores">
      <div><dt>{t("evolve.chart.gate")}</dt><dd>{format(candidate.gateScore)}</dd></div>
      <div><dt>{t("evolve.chart.rollout")}</dt><dd>{format(candidate.rolloutScore ?? candidate.score)}</dd></div>
      <div><dt>visits</dt><dd>{candidate.visits}</dd></div>
      {/* Only when a judged prior actually rated this one. Rendering a dash for
          every run without the factor would put an empty column in front of
          everybody to serve the few runs that use it. */}
      {typeof candidate.priorScore === "number"
        ? (
          <div>
            <dt>{t("evolve.detail.prior")}</dt>
            <dd>{candidate.priorScore.toFixed(2)}</dd>
          </div>
        )
        : null}
    </dl>

    {candidate.valid ? null : <section className="evolve-detail-error">
      <h4>{t("evolve.detail.error")}</h4>
      {/* The full text, not a truncation: the tail of a traceback is usually
          the half that says what to change. */}
      <pre>{candidate.error || candidate.reason || "—"}</pre>
    </section>}

    {candidate.parentIndex === null
      ? <p className="evolve-detail-note">{t("evolve.detail.noParent")}</p>
      : <section className="evolve-detail-diff">
        <h4>{t("evolve.detail.diff")}</h4>
        {sources === "loading" ? <p className="evolve-detail-note">{t("evolve.detail.loading")}</p> : null}
        {sources === "missing" ? <p className="evolve-detail-note">{t("evolve.detail.diffUnavailable")}</p> : null}
        {typeof sources === "object" && rows.rows.length === 0
          ? <p className="evolve-detail-note">{t("evolve.detail.unchanged")}</p>
          : null}
        {rows.rows.length === 0 ? null : <table className="evolve-diff">
          <tbody>
            {rows.rows.map((row, at) => <tr className={`evolve-diff-${row.kind}`} key={at}>
              <td className="evolve-diff-line">{row.leftLine ?? ""}</td>
              <td className="evolve-diff-line">{row.rightLine ?? ""}</td>
              <td className="evolve-diff-mark">{row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " "}</td>
              <td className="evolve-diff-text">{row.text || " "}</td>
            </tr>)}
          </tbody>
        </table>}
        {rows.hidden > 0
          // Said out loud: a fold that does not report its size is
          // indistinguishable from a short file.
          ? <p className="evolve-detail-note">… {rows.hidden}</p>
          : null}
      </section>}
  </aside>;
}

function format(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toFixed(4);
}
