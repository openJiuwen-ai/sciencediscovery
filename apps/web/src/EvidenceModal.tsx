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

import type { MemoryGraphChainResult, MemoryGraphNode, MemorySubgraph } from "@sciencediscovery/schema";

import type { ApiClient } from "./api.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { firstContentValue, humanizeKey, partitionEvidenceExtra } from "./NodeField.js";
import { translateActive, useLocale } from "./i18n/index.js";

// Memory graph explorer is heavy; lazy-load to avoid a circular import with
// the artifact panel that re-exports it. Matches ScientificArtifacts.tsx.
const MemoryGraphExplorer = lazy(() => import("./MemoryGraphExplorer.js").then((m) => ({ default: m.MemoryGraphExplorer })));

/** Inline preview of a SourceFile's content, shown inside the Evidence modal's
 * Provenance tab. Mirrors ArtifactModal's Preview tab for the media types a
 * user-uploaded file can take (PDF/text/image) by loading the matching
 * artifact version and rendering the blob via the same approach
 * ArtifactModal uses (object URL + iframe/pre/img). Other media types fall
 * back to a download hint — the goal is "this is the file content", not
 * "this is a row of metadata about the file". */
function SourceFilePreview({
  client,
  fileNode,
  sessionId,
}: {
  client: ApiClient;
  fileNode: MemoryGraphNode;
  /** Session the SourceFile was uploaded in (parsed from its id). Used so
   * `listArtifacts(sessionId)` finds the user_upload artifact for the file. */
  sessionId: string;
}) {
  const { t } = useLocale();
  const [contentUrl, setContentUrl] = useState<string | undefined>();
  const [mediaType, setMediaType] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  /** SourceFile `path` from the node's extra fields, when the node carries
   * one. Used as the fallback read route: paper uploads are mirrored as
   * SourceFile nodes but never register a catalog artifact, so the preview
   * reads the workspace file directly (`GET /api/sessions/:id/file`). */
  const filePath = typeof sourceFileExtra(fileNode).path === "string"
    ? sourceFileExtra(fileNode).path as string
    : undefined;

  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    setContentUrl(undefined);
    setMediaType(undefined);
    setError(undefined);
    setLoading(true);
    // SourceFile node id: `source_file:session:<sid>:<filename>`. The
    // trailing segment is the logicalName the artifact list keys on
    // (matches the chip → ArtifactModal reverse-lookup at App.tsx:2091).
    const baseName = fileNode.id.includes(":")
      ? fileNode.id.slice(fileNode.id.lastIndexOf(":") + 1)
      : fileNode.id;
    (async () => {
      try {
        // Route 1: the artifact catalog (workspace uploads register a
        // user_upload artifact whose logicalName is the file's path).
        let blob: Blob | undefined;
        let media: string | undefined;
        const artifacts = await client.listArtifacts(sessionId);
        if (!active) return;
        const artifact = artifacts.find((item) => item.logicalName === baseName);
        if (artifact) {
          const versions = await client.listArtifactVersions(sessionId, artifact.id);
          if (!active) return;
          const latest = versions.at(-1);
          if (latest) {
            blob = await client.readArtifactVersion(sessionId, latest.id);
            media = latest.mediaType || artifact.kind;
          }
        }
        // Route 2 (fallback): read the workspace file directly by the
        // SourceFile node's `path` property. Paper uploads (papers/<id>/
        // source.pdf) are mirrored as SourceFile nodes but never register a
        // catalog artifact, so route 1 misses for them; the workspace file
        // read covers every SourceFile regardless of how it was registered.
        if (!blob && filePath) {
          blob = await client.readFile(sessionId, filePath);
          media = blob.type || undefined;
        }
        if (!active) return;
        if (!blob) {
          setError(translateActive("evidence.fileMissing", { name: baseName }));
          setLoading(false);
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setContentUrl(objectUrl);
        setMediaType(media || "application/octet-stream");
        setLoading(false);
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : translateActive("evidence.loadFileFailed"));
          setLoading(false);
        }
      }
    })();
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [client, fileNode.id, sessionId, filePath]);

  if (loading) return <p className="artifact-empty compact">{t("evidence.loadingFilePreview")}</p>;
  if (error) return <p className="artifact-empty compact">{error}</p>;
  if (!contentUrl || !mediaType) return null;

  if (mediaType === "application/pdf") {
    return <iframe className="report-frame evidence-source-frame" src={contentUrl} title={fileNode.id} />;
  }
  if (mediaType.startsWith("image/")) {
    return <img alt={fileNode.id} className="evidence-source-image" src={contentUrl} />;
  }
  // Text-ish content: download via <a download>; rendering inline could be
  // tens of MB for a CSV, so a link + size hint is the right surface. The
  // file's logical name is already in the section heading above.
  return (
    <p className="evidence-source-paper-abstract">
      <a className="evidence-source-paper-link" href={contentUrl} download={fileNode.id.split(":").pop()}>{t("evidence.downloadFile", { name: fileNode.id.split(":").pop() ?? "" })}</a>
      <span> ({mediaType})</span>
    </p>
  );
}

export interface EvidenceModalProps {
  client: ApiClient;
  evidenceId: string;
  onClose: () => void;
  /** Open the evolve panel for a run a graph node points at. */
  onOpenEvolveRun?: (runId: string) => void;
  /** Open the ArtifactModal on a SourceFile-derived artifact (uploaded PDF
   * or data file). The chain walk surfaces the SourceFile upstream of the
   * Evidence as a memory-graph node; clicking its name should mirror the
   * right-rail artifact card click — open the same ArtifactModal so the
   * reader sees the file content / PDF preview, not the empty-Paper state. */
  onOpenSourceFile?: (logicalName: string, sessionId?: string) => void;
  sessionId: string;
}

type Mode = "preview" | "provenance";

// Paper `extra` fields shown in the provenance tab (full abstract / link /
// counts), keyed off the schema comment on MemoryGraphNode.
function paperExtra(paper: MemoryGraphNode): Record<string, unknown> {
  return (paper.extra as Record<string, unknown> | undefined) ?? {};
}

// SourceFile `extra` fields shown in the provenance tab when the Evidence
// was extracted from an uploaded PDF (SourceFile -[:extracts]-> Evidence).
// The chain walk surfaces the SourceFile node directly; we render it like a
// Paper card but with file-shaped fields (path, media_type, size) instead
// of literature-shaped ones (title, abstract, link).
function sourceFileExtra(node: MemoryGraphNode): Record<string, unknown> {
  return (node.extra as Record<string, unknown> | undefined) ?? {};
}

export function EvidenceModal({ client, evidenceId, onClose, onOpenEvolveRun, onOpenSourceFile, sessionId }: EvidenceModalProps) {
  const [evidence, setEvidence] = useState<MemoryGraphNode | null>(null);
  const [papers, setPapers] = useState<MemoryGraphNode[]>([]);
  // SourceFile nodes upstream of this Evidence (`SourceFile -[:extracts]->
  // Evidence`). Block 3 added PDF SourceFile as a valid Evidence source, so
  // the chain may surface a SourceFile in addition to (or instead of) a
  // Paper; the UI renders each kind in its own card so the user sees what
  // the evidence was actually drawn from.
  const [sourceFiles, setSourceFiles] = useState<MemoryGraphNode[]>([]);
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
    // The Evidence node itself is the chain's source, so it appears in the
    // chain result's nodes with its full `extra` (the chain serializer uses
    // the same _to_hit as the node-detail path used to). No separate node
    // fetch needed — one chain request carries both the evidence and its
    // upstream Paper(s). ``viewSourcePaper`` walks one ``extracts`` hop
    // upstream (Evidence←extracts←Paper), so the returned nodes are the
    // evidence + its source Paper(s) — exactly what this modal fills in.
    void client.getMemoryChain(evidenceId, sessionId, undefined, "viewSourcePaper").then((chain) => {
      if (!active) return;
      const chainResult = chain as MemoryGraphChainResult;
      const nodes = chainResult?.nodes ?? [];
      setEvidence(nodes.find((node) => node.id === evidenceId) ?? null);
      // The Paper upstream of this Evidence (extracts, walked in) surfaces in
      // the chain nodes; collect any Paper nodes that appear. Block 3 also
      // lets a SourceFile-PDF be the upstream (block 4 prompt teaching):
      // `SourceFile -[:extracts]-> Evidence` is the same edge, walked the
      // same direction, so the chain node list carries the SourceFile in
      // addition to (or instead of) the Paper. Treat them as two surfaces
      // of the same concept — the provenance tab renders both.
      setPapers(nodes.filter((node) => node.label === "Paper"));
      setSourceFiles(nodes.filter((node) => node.label === "SourceFile"));
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
        setError(t("evidence.notInMemory"));
        return;
      }
      setError(undefined);
      setChainExplorer({ nodeId: evidenceId, subgraph });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("evidence.loadMemoryFailed"));
    }
  }

  // Header title: prefer the full evidence content (truncated to one line by
  // CSS with an ellipsis) so the reader sees the start of the claim; the
  // complete content is surfaced via a native title tooltip on hover (the
  // standard pattern for titles that don't fit). Fall back to the id prefix
  // when there is no content field.
  const titleText = firstContentValue(evidence?.extra) ?? evidenceId.slice(0, 8);
  const titleHover = titleText === evidenceId.slice(0, 8) ? undefined : titleText;
  const { contentNodes, metaPairs, rawPairs } = partitionEvidenceExtra(evidence?.extra);

  return (
    <div className="artifact-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section aria-label={t("evidence.dialogLabel", { title: titleText })} aria-modal="true" className="artifact-modal-panel" role="dialog">
        <header className="artifact-modal-header">
          <div><span className="eyebrow">{t("evidence.eyebrow")}</span><h2 className="evidence-title" title={loading || !titleHover ? undefined : titleHover}>{loading ? t("evidence.loading") : titleText}</h2></div>
          <div className="artifact-modal-controls">
            <button aria-label={t("evidence.close")} className="icon-button" onClick={onClose} title={t("evidence.close")} type="button">✕</button>
          </div>
        </header>
        <nav className="artifact-mode-tabs">
          <button className={mode === "preview" ? "active" : ""} onClick={() => setMode("preview")} type="button">{t("artifact.tabPreview")}</button>
          <button className={mode === "provenance" ? "active" : ""} onClick={() => setMode("provenance")} type="button">{t("artifact.tabProvenance")}</button>
          {memoryGraphEnabled ? <button className="view-chain-btn" onClick={() => void viewChain()} type="button">{t("chain.viewInMemoryX", { x: t("chain.evidence") })}</button> : null}
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
                  <summary>{t("evidence.rawAttributes")}</summary>
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
              {!loading && !evidence && !error ? <p className="artifact-empty">{t("evidence.notFound")}</p> : null}
            </div>
          ) : (
            <div className="evidence-source-papers">
              {papers.length ? papers.map((paper) => {
                const extra = paperExtra(paper);
                const paperTitle = String(extra.title ?? paper.id);
                return (
                  <article className="evidence-source-paper expanded" key={paper.id}>
                    <h4 className="evidence-source-paper-label">{t("evidence.paper")}</h4>
                    <h5 className="evidence-source-paper-title">{paperTitle}</h5>
                    <div className="evidence-source-paper-detail">
                      {typeof extra.abstract === "string" && extra.abstract ? (
                        <p className="evidence-source-paper-abstract">{extra.abstract}</p>
                      ) : <p className="artifact-empty compact">{t("evidence.noAbstract")}</p>}
                      {typeof extra.link === "string" && extra.link ? (
                        <a className="evidence-source-paper-link" href={extra.link} rel="noreferrer" target="_blank">{extra.link}</a>
                      ) : null}
                    </div>
                  </article>
                );
              }) : null}
              {sourceFiles.length ? sourceFiles.map((sourceFile) => {
                const extra = sourceFileExtra(sourceFile);
                const fileName = String(extra.name ?? extra.path ?? sourceFile.id);
                // SourceFile node ids are `source_file:session:<sid>:<filename>`
                // — the second segment is the Session the file was uploaded
                // in; that's where the matching artifact version lives (the
                // artifact list is session-scoped even though the SourceFile
                // node itself is graph-scoped).
                const sourceSessionId = sourceFile.id.split(":")[2] ?? sessionId;
                return (
                  <article className="evidence-source-paper expanded" key={sourceFile.id}>
                    <h4 className="evidence-source-paper-label">{t("evidence.sourceFile")}</h4>
                    <h5 className="evidence-source-paper-title">{fileName}</h5>
                    <div className="evidence-source-paper-detail">
                      <SourceFilePreview client={client} fileNode={sourceFile} sessionId={sourceSessionId} />
                    </div>
                  </article>
                );
              }) : null}
              {!papers.length && !sourceFiles.length ? (
                <p className="artifact-empty">{t("evidence.noSource")}</p>
              ) : null}
            </div>
          )}
        </div>
      </section>
      {chainExplorer ? (
        <ErrorBoundary label="ScienceMemory" onError={(message) => { setError(message); setChainExplorer(null); }}>
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
        </ErrorBoundary>
      ) : null}
    </div>
  );
}
