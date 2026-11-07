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
 * The card behind a report's citation chip.
 *
 * A report cites its evidence as `[evidence1]`; pressing one opens this dialog
 * instead of leaving the document. It is the old web UI's `EvidenceModal`,
 * minus the memory-graph explorer: 预览 shows what the node says, and 溯源
 * answers "where did this come from" with one card per upstream source — the
 * paper, uploaded file, or web page the evidence was extracted from. There is
 * deliberately no graph canvas.
 *
 * An Artifact citation never reaches this dialog: pressing `[artifact1]` opens
 * the artifact itself in `ArtifactDialog` (see `App.tsx`'s `openReference`), so
 * the card has no properties page for something the reader can simply read.
 *
 * Reads only. The dialog never writes to the graph.
 */

import { useEffect, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";

import type { ApiClient } from "../api/client.js";
import { listMemoryNodes, memoryChain } from "../api/memory.js";
import {
  listArtifacts,
  listArtifactVersions,
  readArtifactVersion,
  readWorkspaceFile,
  type DocumentBytes,
} from "../api/sessions.js";
import type {
  ComposerReference,
  MemoryGraphHit,
  MemoryGraphNode,
} from "../api/types.js";
import {
  evidenceSources,
  matchReferenceHit,
  memoryNodeDetail,
  memoryNodeLink,
  memoryNodeTitle,
} from "../app/memory.js";
import { referenceNodeLabel } from "../app/memory-chips.js";
import { paperAbstractSections, type AbstractSection } from "../app/paper-abstract.js";
import { TEXT } from "../text.js";
import { useTopmostEscape } from "./use-dialog-escape.js";

interface Props {
  client: ApiClient;
  onClose: () => void;
  /** The way out when memory is off or unreachable: the switch is in 设置. */
  onOpenSettings: () => void;
  /** The citation the reader pressed. */
  reference: ComposerReference;
  /** The report's Session, used when the reference does not name one. */
  sessionId?: string;
}

type DetailTab = "preview" | "provenance";

type LoadState =
  | { status: "loading" }
  /** `title` separates "switched off" and "service gone" from a generic read
   *  failure: the reason travels in the same 200 body, so only the copy can
   *  tell the reader which one they are looking at. */
  | { message: string; offerSettings: boolean; status: "error"; title: string }
  | { status: "missing" }
  | { hit: MemoryGraphHit; status: "ready" };

/** The old web UI's classification of an Evidence node's `extra`: content
 *  fields are the claim itself, everything else is a compact meta strip. */
const CONTENT_KEYS = ["content", "source_excerpt"] as const;

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function formatWhen(iso: string | undefined): string {
  if (iso === undefined) return "";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const date = new Date(time);
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString(TEXT.languageTag, { hour: "2-digit", minute: "2-digit" });
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(TEXT.languageTag, sameYear
    ? { month: "short", day: "numeric" }
    : { year: "numeric", month: "short", day: "numeric" });
}

function rawValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function hitTitle(hit: MemoryGraphHit): string {
  if (hit.label === "Artifact" || hit.label === "SourceFile" || hit.label === "DbRecord") {
    const name = memoryNodeTitle({ extra: hit.extra, id: hit.id, label: hit.label });
    return name === hit.id ? hit.excerpt || name : name;
  }
  const content = hit.extra?.content;
  return typeof content === "string" && content.trim() !== "" ? content : hit.excerpt || hit.id;
}

/** A SourceFile node id is `source_file:session:<sid>:<filename>`; the trailing
 *  segment is the logical name the artifact list keys on. */
function fileNameOf(node: MemoryGraphNode): string {
  const extra = node.extra ?? {};
  const named = typeof extra.name === "string" && extra.name !== ""
    ? extra.name
    : typeof extra.path === "string" && extra.path !== ""
      ? extra.path
      : undefined;
  if (named !== undefined) return named.slice(named.lastIndexOf("/") + 1);
  return node.id.includes(":") ? node.id.slice(node.id.lastIndexOf(":") + 1) : node.id;
}

export function MemoryCardDialog({
  client,
  onClose,
  onOpenSettings,
  reference,
  sessionId,
}: Props) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [tab, setTab] = useState<DetailTab>("preview");
  const nodeLabel = referenceNodeLabel(reference.kind);
  const targetSession = reference.sessionId ?? sessionId;

  // Escape closes the card, but only when nothing above it has claimed the
  // key first (a nested confirmation, for instance) — and, in the other
  // direction, the dialog the card was opened in stays open, because the card
  // is the one that was opened last.
  useTopmostEscape(onClose);

  useEffect(() => {
    let alive = true;
    if (nodeLabel === undefined) {
      setState({ status: "missing" });
      return;
    }
    setState({ status: "loading" });
    listMemoryNodes(client, [nodeLabel], targetSession).then(
      (result) => {
        if (!alive) return;
        if (result.reason === "memory_graph_disabled") {
          setState({
            message: TEXT.memory.disabledBody,
            offerSettings: true,
            status: "error",
            title: TEXT.memory.disabledTitle,
          });
          return;
        }
        if (result.reason === "memory_graph_unreachable") {
          setState({
            message: TEXT.memory.unreachableBody,
            offerSettings: true,
            status: "error",
            title: TEXT.memory.unreachableTitle,
          });
          return;
        }
        const hit = matchReferenceHit(result.hits ?? [], reference);
        setState(hit === undefined ? { status: "missing" } : { hit, status: "ready" });
      },
      (failure: unknown) => {
        if (!alive) return;
        setState({
          message: failure instanceof Error ? failure.message : TEXT.memory.errorTitle,
          offerSettings: true,
          status: "error",
          title: TEXT.memory.errorTitle,
        });
      },
    );
    return () => {
      alive = false;
    };
  }, [attempt, client, nodeLabel, reference, targetSession]);

  const kind = reference.kind;
  const provenanceReady = state.status === "ready" && state.hit.label === "Evidence";
  const currentTab = provenanceReady ? tab : "preview";
  const title = state.status === "ready" ? hitTitle(state.hit) : TEXT.memory.title;

  const dialog = (
    <div className="modal-backdrop memory-backdrop" onPointerDown={onClose}>
      <section
        aria-label={TEXT.memory.title}
        aria-modal="true"
        className={`memory-dialog is-${kind}`}
        onPointerDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="memory-dialog-head">
          {/* The kind alone names the card. The alias the report used and the
              record's timestamp were the citation's bookkeeping, not the
              evidence: the reader already sees the content. */}
          <div className="memory-dialog-eyebrow">
            <span className={`memory-kind-chip is-${kind}`}>{TEXT.memory.chipLabels[kind]}</span>
          </div>
          <h2 className="evidence-title" title={title}>{title}</h2>
          <button aria-label={TEXT.memory.closeDialog} className="modal-close" onClick={onClose} type="button">
            ×
          </button>
        </header>

        {provenanceReady ? (
          <div className="memory-dialog-tabs">
            <nav aria-label={TEXT.memory.title} className="memory-tabs">
              <button
                aria-pressed={currentTab === "preview"}
                className={currentTab === "preview" ? "is-active" : ""}
                onClick={() => setTab("preview")}
                type="button"
              >
                {TEXT.memory.previewTab}
              </button>
              <button
                aria-pressed={currentTab === "provenance"}
                className={currentTab === "provenance" ? "is-active" : ""}
                onClick={() => setTab("provenance")}
                type="button"
              >
                {TEXT.memory.provenanceTab}
              </button>
            </nav>
          </div>
        ) : null}

        <div className="memory-dialog-body" role="tabpanel">
          {state.status === "loading" ? (
            <div aria-label={TEXT.memory.loading} className="memory-trace-loading" role="status">
              <span className="spinner" aria-hidden="true" />
              <span>{TEXT.memory.loading}</span>
            </div>
          ) : state.status === "error" ? (
            <MemoryState
              action={state.offerSettings ? TEXT.memory.openSettings : TEXT.memory.retry}
              body={state.message}
              onAction={state.offerSettings ? onOpenSettings : () => setAttempt((value) => value + 1)}
              title={state.title}
            />
          ) : state.status === "missing" ? (
            <MemoryState body={TEXT.memory.notFoundBody} title={TEXT.memory.notFoundTitle} />
          ) : state.hit.label === "Evidence" && currentTab === "provenance" ? (
            <MemoryProvenance
              client={client}
              hit={state.hit}
              sessionId={targetSession}
            />
          ) : state.hit.label === "Evidence" ? (
            <EvidencePreview hit={state.hit} />
          ) : (
            <MemoryFacts hit={state.hit} />
          )}
        </div>
      </section>
    </div>
  );

  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}

function MemoryState({ action, body, onAction, title }: {
  action?: string;
  body: string;
  onAction?: () => void;
  title: string;
}) {
  return (
    <div className="memory-state">
      <strong>{title}</strong>
      <p>{body}</p>
      {action !== undefined && onAction !== undefined ? (
        <button className="secondary-button" onClick={onAction} type="button">{action}</button>
      ) : null}
    </div>
  );
}

/* ── preview ────────────────────────────────────────────────────────────── */

/** The evidence itself, as the old UI's 预览 tab: its content as the claim, and
 *  the fields that qualify it as a compact strip underneath. */
function EvidencePreview({ hit }: { hit: MemoryGraphHit }) {
  const extra = hit.extra ?? {};
  const contentPairs = CONTENT_KEYS
    .filter((key) => isPresent(extra[key]))
    .map((key) => ({ key, value: extra[key] }));
  const metaPairs = [
    { label: TEXT.memory.field.evidenceType, value: extra.evidence_type },
    { label: TEXT.memory.field.locator, value: extra.locator },
    { label: TEXT.memory.field.confidence, value: extra.confidence },
    { label: TEXT.memory.field.recordedAt, value: hit.createdAt === undefined ? "" : formatWhen(hit.createdAt) },
  ].filter((pair) => isPresent(pair.value));

  return (
    <div className="evidence-detail">
      {contentPairs.length === 0 ? null : (
        <section className="evidence-content">
          {contentPairs.map(({ key, value }) => (
            <div key={key}>
              <h3 className="evidence-content-label">
                {key === "source_excerpt" ? TEXT.memory.sourceExcerpt : TEXT.memory.contentLabel}
              </h3>
              <p className="evidence-content-text">{rawValue(value)}</p>
            </div>
          ))}
        </section>
      )}
      {metaPairs.length === 0 ? null : (
        <dl className="evidence-meta">
          {metaPairs.map(({ label, value }) => (
            <div className="evidence-meta-prop" key={label}>
              <dt>{label}</dt>
              <dd>{rawValue(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** SourceFile / DbRecord / Session citations keep showing the label's own
 *  fields: this is a citation the report made, so showing the payload honestly
 *  beats a second UI vocabulary for each graph label. */
function MemoryFacts({ hit }: { hit: MemoryGraphHit }) {
  const extra = hit.extra ?? {};
  const fact = (rawKey: string, label: string, value: unknown): ReactElement | null => {
    if (!isPresent(value)) return null;
    return (
      <div className="memory-fact" key={rawKey}>
        <dt>{label}</dt>
        <dd>{rawValue(value)}</dd>
      </div>
    );
  };
  const link = memoryNodeLink({ extra, id: hit.id, label: hit.label });

  return (
    <div className="memory-facts">
      <dl className="memory-fact-grid">
        {fact("name", TEXT.memory.field.name, extra.name)}
        {fact("title", TEXT.memory.field.name, extra.title)}
        {fact("identifier", TEXT.memory.field.locator, extra.identifier)}
        {fact("path", TEXT.memory.field.path, extra.path)}
        {fact("media_type", TEXT.memory.field.mediaType, extra.media_type)}
        {fact("createdAt", TEXT.memory.field.recordedAt, formatWhen(hit.createdAt))}
        {link === undefined ? null : (
          <div className="memory-fact" key="source">
            <dt>{TEXT.memory.field.source}</dt>
            <dd><a href={link} rel="noreferrer" target="_blank">{link}</a></dd>
          </div>
        )}
      </dl>
    </div>
  );
}

/* ── provenance ─────────────────────────────────────────────────────────── */

type ProvenanceState =
  | { status: "loading" }
  | { message: string; status: "error" }
  /** Evidence follows the old web UI's 溯源 tab: what the evidence was
   *  extracted from, and nothing else. The claims that cite it belong to the
   *  report, not to the evidence. */
  | { sources: MemoryGraphNode[]; status: "ready" };

/** A chain answers 200 with a reason when the graph is off or gone. Treating
 *  that as "nothing recorded" would print a trace full of empty steps for a
 *  service that never answered. */
function chainProblem(reason: string | undefined): string | undefined {
  if (reason === "memory_graph_unreachable") return TEXT.memory.unreachableBody;
  if (reason === "memory_graph_disabled") return TEXT.memory.disabledBody;
  return undefined;
}

function MemoryProvenance({ client, hit, sessionId }: {
  client: ApiClient;
  hit: MemoryGraphHit;
  sessionId?: string;
}) {
  const [state, setState] = useState<ProvenanceState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const readSession = hit.sessionId ?? sessionId;

  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    const read = async (): Promise<void> => {
      const sources = await memoryChain(client, hit.id, readSession, "viewSourcePaper");
      if (!alive) return;
      const problem = chainProblem(sources.reason);
      if (problem !== undefined) {
        setState({ message: problem, status: "error" });
        return;
      }
      setState({
        sources: evidenceSources(hit.id, sources.nodes),
        status: "ready",
      });
    };
    void read().catch((failure: unknown) => {
      if (alive) {
        setState({
          message: failure instanceof Error ? failure.message : TEXT.memory.provenance.error,
          status: "error",
        });
      }
    });
    return () => {
      alive = false;
    };
  }, [attempt, client, hit.id, readSession]);

  if (state.status === "loading") {
    return (
      <div aria-label={TEXT.memory.provenance.loading} className="memory-trace-loading" role="status">
        <span className="spinner" aria-hidden="true" />
        <span>{TEXT.memory.provenance.loading}</span>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <MemoryState
        action={TEXT.memory.provenance.retry}
        body={state.message}
        onAction={() => setAttempt((value) => value + 1)}
        title={TEXT.memory.provenance.error}
      />
    );
  }
  return <EvidenceSources client={client} nodes={state.sources} sessionId={readSession} />;
}

/**
 * A paper's abstract, keeping the section labels the source gave it. A
 * structured abstract reads as 背景 / 方法 / 结果 rather than as one run-on
 * paragraph, and the labels are the publisher's own words — not translated,
 * because they are part of the citation.
 */
function PaperAbstract({ sections }: { sections: AbstractSection[] }) {
  return (
    <div className="evidence-source-paper-abstract-sections">
      {sections.map((section, index) => (
        <div className="evidence-source-paper-abstract-section" key={`${String(index)}:${section.heading ?? ""}`}>
          {section.heading === undefined ? null : (
            <h6 className="evidence-source-paper-abstract-heading">{section.heading}</h6>
          )}
          <p className="evidence-source-paper-abstract">{section.text}</p>
        </div>
      ))}
    </div>
  );
}

/**
 * An Evidence's provenance, as the old web UI draws it: one card per upstream
 * source, with the card's own kind label. A Paper is its title, abstract and
 * link; an uploaded file is its name and content; a web page is its title,
 * snippet and link.
 */
function EvidenceSources({ client, nodes, sessionId }: {
  client: ApiClient;
  nodes: MemoryGraphNode[];
  sessionId?: string;
}) {
  if (nodes.length === 0) {
    return <p className="memory-trace-empty">{TEXT.memory.provenance.sourcesEmpty}</p>;
  }
  const papers = nodes.filter((node) => node.label === "Paper");
  const sourceFiles = nodes.filter((node) => node.label === "SourceFile");
  const webPages = nodes.filter((node) => node.label === "WebPage");
  const others = nodes.filter((node) => !["Paper", "SourceFile", "WebPage"].includes(node.label));

  return (
    <div className="evidence-source-papers">
      {papers.map((paper) => {
        const extra = paper.extra ?? {};
        // The source's abstract arrives as markup (`<h4>Methods</h4>…`), so it
        // is read into sections here and drawn as text: the card never inserts
        // third-party HTML.
        const abstract = typeof extra.abstract === "string" ? paperAbstractSections(extra.abstract) : [];
        const link = memoryNodeLink(paper);
        return (
          <article className="evidence-source-paper" key={paper.id}>
            <h4 className="evidence-source-paper-label">{TEXT.memory.nodeLabels.Paper}</h4>
            <h5 className="evidence-source-paper-title">{memoryNodeTitle(paper)}</h5>
            <div className="evidence-source-paper-detail">
              {abstract.length === 0
                ? <p className="memory-trace-empty">{TEXT.memory.provenance.noAbstract}</p>
                : <PaperAbstract sections={abstract} />}
              {link === undefined ? null : (
                <a className="evidence-source-paper-link" href={link} rel="noreferrer" target="_blank">{link}</a>
              )}
            </div>
          </article>
        );
      })}
      {sourceFiles.map((sourceFile) => {
        // SourceFile node ids are `source_file:session:<sid>:<filename>` — the
        // second segment is the Session the file belongs to, which is where
        // the matching artifact version lives.
        const fileSession = sourceFile.id.split(":")[2] ?? sessionId;
        return (
          <article className="evidence-source-paper" key={sourceFile.id}>
            <h4 className="evidence-source-paper-label">{TEXT.memory.nodeLabels.SourceFile}</h4>
            <h5 className="evidence-source-paper-title">{fileNameOf(sourceFile)}</h5>
            <div className="evidence-source-paper-detail">
              <SourceFilePreview
                client={client}
                fileNode={sourceFile}
                sessionId={fileSession}
              />
            </div>
          </article>
        );
      })}
      {webPages.map((webPage) => {
        const detail = memoryNodeDetail(webPage);
        const link = memoryNodeLink(webPage);
        return (
          <article className="evidence-source-paper" key={webPage.id}>
            <h4 className="evidence-source-paper-label">{TEXT.memory.nodeLabels.WebPage}</h4>
            <h5 className="evidence-source-paper-title">{memoryNodeTitle(webPage)}</h5>
            <div className="evidence-source-paper-detail">
              {detail === undefined ? null : <p className="evidence-source-paper-abstract">{detail}</p>}
              {link === undefined ? null : (
                <a className="evidence-source-paper-link" href={link} rel="noreferrer" target="_blank">{link}</a>
              )}
            </div>
          </article>
        );
      })}
      {others.map((node) => {
        const detail = memoryNodeDetail(node);
        const link = memoryNodeLink(node);
        return (
          <article className="evidence-source-paper" key={node.id}>
            <h4 className="evidence-source-paper-label">
              {node.label in TEXT.memory.nodeLabels
                ? TEXT.memory.nodeLabels[node.label as keyof typeof TEXT.memory.nodeLabels]
                : node.label}
            </h4>
            <h5 className="evidence-source-paper-title">{memoryNodeTitle(node)}</h5>
            <div className="evidence-source-paper-detail">
              {detail === undefined ? null : <p className="evidence-source-paper-abstract">{detail}</p>}
              {link === undefined ? null : (
                <a className="evidence-source-paper-link" href={link} rel="noreferrer" target="_blank">{link}</a>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

/* ── source file preview ────────────────────────────────────────────────── */

type FileState =
  | { status: "loading" }
  | { message: string; status: "error" }
  | { name: string; status: "missing" }
  | { mediaType: string; name: string; status: "ready"; url: string };

/**
 * The file a piece of evidence was extracted from, shown the way the old UI
 * showed it: the uploaded artifact's latest version when the catalog has one,
 * otherwise the workspace file the SourceFile node points at. PDFs render in a
 * frame, images inline, and text as a download link — a CSV can be tens of
 * megabytes, so the right surface is a link, not a rendered blob.
 */
function SourceFilePreview({ client, fileNode, sessionId }: {
  client: ApiClient;
  fileNode: MemoryGraphNode;
  sessionId?: string;
}) {
  const [state, setState] = useState<FileState>({ status: "loading" });
  const name = fileNameOf(fileNode);
  const path = typeof fileNode.extra?.path === "string" ? fileNode.extra.path : undefined;

  useEffect(() => {
    let alive = true;
    let objectUrl: string | undefined;
    setState({ status: "loading" });
    const read = async (): Promise<void> => {
      let document: DocumentBytes | undefined;
      let mediaType = "";
      if (sessionId !== undefined) {
        // Route 1: the artifact catalog. Uploads register a user_upload
        // artifact whose logical name is the file's path.
        const artifacts = await listArtifacts(client, sessionId);
        if (!alive) return;
        const artifact = artifacts.find((item) => item.logicalName === name || item.name === name);
        if (artifact !== undefined) {
          const versions = await listArtifactVersions(client, sessionId, artifact.id);
          if (!alive) return;
          const latest = versions.at(-1);
          if (latest !== undefined) {
            document = await readArtifactVersion(client, sessionId, latest.id);
            mediaType = latest.mediaType || artifact.kind;
          }
        }
        // Route 2: the workspace file itself. Paper uploads are mirrored as
        // SourceFile nodes but never register a catalog artifact.
        if (document === undefined && path !== undefined) {
          document = await readWorkspaceFile(client, sessionId, path);
          mediaType = document.mediaType;
        }
      }
      if (!alive) return;
      if (document === undefined) {
        setState({ name, status: "missing" });
        return;
      }
      objectUrl = URL.createObjectURL(
        new Blob([document.bytes as BlobPart], { type: mediaType || "application/octet-stream" }),
      );
      setState({
        mediaType: mediaType === "" ? TEXT.memory.evidenceSource.unknownType : mediaType,
        name,
        status: "ready",
        url: objectUrl,
      });
    };
    void read().catch((failure: unknown) => {
      if (alive) {
        setState({
          message: failure instanceof Error ? failure.message : TEXT.memory.evidenceSource.fileFailed,
          status: "error",
        });
      }
    });
    return () => {
      alive = false;
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    };
  }, [client, name, path, sessionId]);

  if (state.status === "loading") {
    return <p className="memory-trace-empty">{TEXT.memory.evidenceSource.loadingFile}</p>;
  }
  if (state.status === "error") {
    return <p className="memory-trace-empty">{state.message}</p>;
  }
  if (state.status === "missing") {
    return <p className="memory-trace-empty">{TEXT.memory.evidenceSource.fileMissing(state.name)}</p>;
  }
  if (state.mediaType === "application/pdf") {
    return (
      <iframe
        className="evidence-source-frame"
        src={state.url}
        title={state.name}
      />
    );
  }
  if (state.mediaType.startsWith("image/")) {
    return <img alt={state.name} className="evidence-source-image" src={state.url} />;
  }
  return (
    <p className="evidence-source-paper-abstract">
      <a className="evidence-source-paper-link" download={state.name} href={state.url}>
        {TEXT.memory.evidenceSource.downloadFile(state.name)}
      </a>
      <span> ({state.mediaType})</span>
    </p>
  );
}
