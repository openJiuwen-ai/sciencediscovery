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

// Detail viewer for an Evidence node opened from a report chip. Mirrors the
// ArtifactModal surface so a reader's muscle memory carries over: a three-tab
// bar (Preview / Provenance / View chain) where Preview shows the evidence
// itself, Provenance shows the Paper(s) it was extracted from, and View chain
// opens the memory graph explorer anchored on this evidence node. Uses the
// same artifact-modal-* chrome so the panel is visually indistinguishable from
// the artifact viewer while staying a distinct, non-artifact surface.

import { lazy, Suspense, useEffect, useState } from "react";

import type { MemoryGraphChainResult, MemoryGraphHit, MemoryGraphNode, MemorySubgraph } from "@science-agent/schema";

import type { ApiClient } from "./api.js";
import { firstContentValue, humanizeKey, partitionEvidenceExtra } from "./NodeField.js";
import { useLocale } from "./i18n/index.js";

// Memory graph explorer is heavy; lazy-load to avoid a circular import with
// the artifact panel that re-exports it. Matches ScientificArtifacts.tsx.
const MemoryGraphExplorer = lazy(() => import("./MemoryGraphExplorer.js").then((m) => ({ default: m.MemoryGraphExplorer })));

export interface EvidenceModalProps {
  client: ApiClient;
  evidenceId: string;
  onClose: () => void;
  sessionId: string;
}

type Mode = "preview" | "provenance";

// Paper `extra` fields shown in the provenance tab (full abstract / link /
// counts), keyed off the schema comment on MemoryGraphNode.
function paperExtra(paper: MemoryGraphNode): Record<string, unknown> {
  return (paper.extra as Record<string, unknown> | undefined) ?? {};
}

export function EvidenceModal({ client, evidenceId, onClose, sessionId }: EvidenceModalProps) {
  const [evidence, setEvidence] = useState<MemoryGraphHit | null>(null);
  const [papers, setPapers] = useState<MemoryGraphNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  // Chain overlay: when set, MemoryGraphExplorer renders full-screen on top
  // of this modal (anchored on this evidence node). Closing the explorer
  // returns here, not to App.
  const [chainExplorer, setChainExplorer] = useState<{ nodeId: string; subgraph: MemorySubgraph } | null>(null);
  const [memoryGraphEnabled, setMemoryGraphEnabled] = useState(false);
  const [mode, setMode] = useState<Mode>("preview");
  const { t } = useLocale();

  // Gate the View chain button on memory-graph health, the same way the
  // artifact panel does (ScientificArtifacts.tsx). App does not carry this
  // state, so this modal self-serves it.
  useEffect(() => {
    void client.getMemoryHealth().then((result) => setMemoryGraphEnabled(result?.memoryGraph === "healthy")).catch(() => setMemoryGraphEnabled(false));
  }, [client]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    void Promise.all([
      client.getMemoryNode("Evidence", evidenceId),
      client.getMemoryChain(evidenceId, sessionId),
    ]).then(([hit, chain]) => {
      if (!active) return;
      setEvidence(hit);
      const chainResult = chain as MemoryGraphChainResult;
      // The Paper upstream of this Evidence (extracted_from) surfaces in the
      // chain nodes; collect any Paper nodes that appear.
      setPapers((chainResult?.nodes ?? []).filter((node) => node.label === "Paper"));
    }).catch((err: Error) => {
      if (active) setError(err.message);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [client, evidenceId, sessionId]);

  async function viewChain(): Promise<void> {
    try {
      const subgraph = await client.getMemorySubgraph(sessionId);
      // Evidence node ids in the subgraph equal the id this modal already holds
      // (evidence_id — no composite-key encoding like Artifact's "<id>#v<v>").
      // Confirm the node is present before anchoring the explorer so a
      // not-yet-mirrored node gets a friendly error instead of a blank graph.
      const present = subgraph.nodes.some((n) => n.id === evidenceId);
      if (!present) {
        setError("This evidence is not yet in the Science Memory.");
        return;
      }
      setError(undefined);
      setChainExplorer({ nodeId: evidenceId, subgraph });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load Science Memory.");
    }
  }

  // Header title: prefer the full evidence content (truncated to one line by
  // CSS with an ellipsis) so the reader sees the start of the claim; the
  // complete content is surfaced via a native title tooltip on hover (the
  // standard pattern for titles that don't fit). Fall back to excerpt/id when
  // there is no content field.
  const titleText = firstContentValue(evidence?.extra) ?? evidence?.excerpt ?? evidenceId.slice(0, 8);
  const titleHover = titleText === evidence?.excerpt ? undefined : titleText;
  const { contentNodes, metaPairs, rawPairs } = partitionEvidenceExtra(evidence?.extra);

  return (
    <div className="artifact-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section aria-label={`Evidence: ${titleText}`} aria-modal="true" className="artifact-modal-panel" role="dialog">
        <header className="artifact-modal-header">
          <div><span className="eyebrow">Evidence</span><h2 className="evidence-title" title={loading || !titleHover ? undefined : titleHover}>{loading ? "Loading evidence…" : titleText}</h2></div>
          <div className="artifact-modal-controls">
            <button aria-label="Close evidence viewer" className="icon-button" onClick={onClose} title="Close evidence viewer" type="button">✕</button>
          </div>
        </header>
        <nav className="artifact-mode-tabs">
          <button className={mode === "preview" ? "active" : ""} onClick={() => setMode("preview")} type="button">Preview</button>
          <button className={mode === "provenance" ? "active" : ""} onClick={() => setMode("provenance")} type="button">Provenance</button>
          {memoryGraphEnabled ? <button className="view-chain-btn" onClick={() => void viewChain()} type="button">{t("chain.view")}</button> : null}
        </nav>
        <div className="artifact-modal-body">
          {error ? <p className="artifact-empty">{error}</p> : null}
          {mode === "preview" ? (
            <div className="evidence-detail">
              {contentNodes.length ? (
                <section className="evidence-content">
                  {contentNodes.map(({ key, value }) => (
                    <div key={key}>
                      <h3 className="evidence-content-label">{humanizeKey(key)}</h3>
                      <p className="evidence-content-text">{String(value)}</p>
                    </div>
                  ))}
                </section>
              ) : null}
              {metaPairs.length ? (
                <dl className="evidence-meta">
                  {metaPairs.map(({ key, value }) => (
                    <div className="evidence-meta-prop" key={key}>
                      <dt>{humanizeKey(key)}</dt>
                      <dd>{typeof value === "string" || typeof value === "number" ? String(value) : JSON.stringify(value)}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {rawPairs.length ? (
                <details className="evidence-raw-attrs">
                  <summary>Raw attributes</summary>
                  <dl className="memory-graph-detail-props">
                    {rawPairs.map(({ key, value }) => (
                      <div className="memory-graph-detail-prop" key={key}>
                        <dt>{key}</dt>
                        <dd>{typeof value === "string" || typeof value === "number" ? String(value) : JSON.stringify(value)}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              ) : null}
              {!loading && !evidence && !error ? <p className="artifact-empty">Evidence not found.</p> : null}
            </div>
          ) : (
            <div className="evidence-source-papers">
              {papers.length ? papers.map((paper) => {
                const extra = paperExtra(paper);
                const paperTitle = String(extra.title ?? paper.id);
                return (
                  <article className="evidence-source-paper expanded" key={paper.id}>
                    <h4 className="evidence-source-paper-label">Paper</h4>
                    <h5 className="evidence-source-paper-title">{paperTitle}</h5>
                    <div className="evidence-source-paper-detail">
                      {typeof extra.abstract === "string" && extra.abstract ? (
                        <p className="evidence-source-paper-abstract">{extra.abstract}</p>
                      ) : <p className="artifact-empty compact">No abstract recorded.</p>}
                      {typeof extra.link === "string" && extra.link ? (
                        <a className="evidence-source-paper-link" href={extra.link} rel="noreferrer" target="_blank">{extra.link}</a>
                      ) : null}
                    </div>
                  </article>
                );
              }) : <p className="artifact-empty">No source paper recorded for this evidence.</p>}
            </div>
          )}
        </div>
      </section>
      {chainExplorer ? (
        <Suspense fallback={null}>
          <MemoryGraphExplorer
            client={client}
            initialNodeId={chainExplorer.nodeId}
            autoChain
            onClose={() => setChainExplorer(null)}
            onError={(message: string) => { setError(message); setChainExplorer(null); }}
            sessionId={sessionId}
            subgraph={chainExplorer.subgraph}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
