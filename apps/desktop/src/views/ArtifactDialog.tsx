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
 * The artifact behind a citation chip, shown the way the old web UI showed it:
 * a dialog in the middle of the window with the version picker and the download
 * in its header, and 预览 / 溯源 as its two tabs.
 *
 * 预览 draws the document with the same renderer the right panel uses, so a
 * CSV is a table, a report is Markdown with its own chips, and a structure is
 * the viewer. 溯源 is the version's own record — the files it was derived
 * from, the code that ran, the execution log and the managed environment —
 * copied from the old UI's provenance tab. Two things are deliberately absent:
 * 把这个做得更好 (the evolve wizard) and 在科学记忆中查看该产物 (the memory
 * graph), neither of which this window has somewhere to open.
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import type { ApiClient } from "../api/client.js";
import {
  listArtifactOutputs,
  listArtifactVersions,
  listSessions,
  readArtifactProvenance,
  type DocumentBytes,
} from "../api/sessions.js";
import type {
  ArtifactCodeProvenance,
  ArtifactVersionProvenance,
  ComposerReference,
  ScientificArtifactVersion,
  Session,
  SessionArtifactOutput,
} from "../api/types.js";
import { artifactName } from "../app/artifact-labels.js";
import { readCachedDocument } from "../app/document-cache.js";
import { documentPayload } from "../app/document-payload.js";
import type { PreviewSlot } from "../app/preview-tabs.js";
import { TEXT } from "../text.js";
import { useTopmostEscape } from "./use-dialog-escape.js";
import { DocumentPreview } from "./DocumentPreview.js";

interface Props {
  client: ApiClient;
  onClose: () => void;
  /**
   * A 上游文件 row opens its artifact in the right panel instead of switching
   * this dialog: the provenance stays in front of the reader while the file
   * itself opens beside it. Without a panel to open (the demo page), the row
   * falls back to switching the dialog.
   */
  onOpenArtifact?: (output: SessionArtifactOutput) => void;
  /** A chip inside the opened document — a report cites its own evidence —
   *  opens the same surfaces a chip in the transcript does. */
  onReferenceClick?: (reference: ComposerReference) => void;
  /**
   * Width of the right panel, when it is open. The scrim stops at the panel
   * and the dialog centres in what is left, so the two never cover each
   * other.
   */
  panelOffset?: number;
  /** The citation the reader pressed: the artifact id, and the version the
   *  report cited when it named one. */
  reference: ComposerReference;
  /** The report's Session, used when the reference does not name one. */
  sessionId?: string;
}

/** Which Artifact the dialog is showing. A dependency row in 溯源 switches it
 *  in place, the way the old UI's `← derived from` links did. */
interface Target {
  id: string;
  version?: number;
}

type ArtifactState =
  | { status: "loading" }
  | { message: string; status: "error" }
  | { output: SessionArtifactOutput; status: "ready"; versions: ScientificArtifactVersion[] };

type PreviewState =
  | { status: "loading" }
  | { message: string; status: "error" }
  | { document: DocumentBytes; name: string; slot: PreviewSlot; status: "ready" };

type ProvenanceState =
  | { status: "loading" }
  | { message: string; status: "error" }
  | { provenance: ArtifactVersionProvenance; status: "ready" };

const VERSION_SOURCE_MAX_CHARACTERS = 18;

/** A Session title long enough to identify itself and short enough for a
 *  `<select>` option, as the old UI's version picker did. */
function truncateSource(title: string): string {
  const characters = Array.from(title);
  if (characters.length <= VERSION_SOURCE_MAX_CHARACTERS) return title;
  return `${characters.slice(0, VERSION_SOURCE_MAX_CHARACTERS - 1).join("")}…`;
}

/** The version's own bytes, downloaded under the artifact's name — the old
 *  UI's 下载当前版本. */
function downloadDocument(name: string, bytes: DocumentBytes): void {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(
    new Blob([bytes.bytes as BlobPart], { type: bytes.mediaType || "application/octet-stream" }),
  );
  const anchor = document.createElement("a");
  anchor.download = name;
  anchor.href = url;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ArtifactDialog({
  client,
  onClose,
  onOpenArtifact,
  onReferenceClick,
  panelOffset = 0,
  reference,
  sessionId,
}: Props) {
  const target = reference.sessionId ?? sessionId;
  const [current, setCurrent] = useState<Target>({ id: reference.id, version: reference.version });
  const [state, setState] = useState<ArtifactState>({ status: "loading" });
  const [versionId, setVersionId] = useState<string>();
  const [sessions, setSessions] = useState<Session[]>();
  const [mode, setMode] = useState<"preview" | "provenance">("preview");
  const [preview, setPreview] = useState<PreviewState>({ status: "loading" });
  const [provenance, setProvenance] = useState<ProvenanceState>({ status: "loading" });
  const [expanded, setExpanded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  /** The scrolling body. Each tab is a page of its own, so 溯源 opens at its
   *  first line even when the reader had read the preview a few screens down;
   *  picking another version likewise starts that version at the top. The body
   *  keeps its scroll offset across a content swap, which is what put the
   *  provenance record halfway down its own page. */
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (bodyRef.current !== null) bodyRef.current.scrollTop = 0;
  }, [mode, versionId]);
  /** Re-reads the version's record without touching the selection. */
  const [provenanceAttempt, setProvenanceAttempt] = useState(0);

  // A structure's full-screen view sits above the dialog and is the first
  // thing Escape should leave; the viewer handles it, so the dialog stands
  // back until the document is back to its box. The card a citation opens over
  // this dialog is above it too, and takes the key first for the same reason:
  // the reader goes back one surface at a time.
  useTopmostEscape(onClose, !expanded);

  // The artifact and every version it has. A citation may pin a version
  // number (the one the report cited); that pin wins over the newest version,
  // so an `[artifact1]`@v1 chip opens v1 rather than the drifted latest.
  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    const read = async (): Promise<ArtifactState> => {
      if (target === undefined) return { message: TEXT.memory.artifactMissing, status: "error" };
      const [outputs, versions] = await Promise.all([
        listArtifactOutputs(client, target),
        listArtifactVersions(client, target, current.id),
      ]);
      const output = outputs.find((candidate) => candidate.artifact.id === current.id);
      if (output === undefined) return { message: TEXT.memory.artifactMissing, status: "error" };
      return {
        output,
        status: "ready",
        // A Session that predates the version list still has the version its
        // output names; showing that one beats showing nothing.
        versions: versions.length > 0 ? versions : [output.version],
      };
    };
    void read().then(
      (next) => {
        if (!alive) return;
        setState(next);
        if (next.status !== "ready") return;
        const pinned = current.version === undefined
          ? undefined
          : next.versions.find((version) => version.version === current.version);
        const chosen = pinned ?? next.versions.at(-1);
        setVersionId(chosen?.id);
        // The version's bytes are their own request, and the effect that reads
        // them only runs after this commit. Starting that read here — the same
        // read it will ask for, which the cache hands back rather than
        // repeating — overlaps the bytes with the render instead of queueing
        // them behind it. A failure is not swallowed: the effect retries and
        // shows it, because nothing is cached on a failed read.
        if (chosen !== undefined && target !== undefined) {
          void readCachedDocument(client, chosen.sessionId || target, chosen.id).catch(() => {});
        }
      },
      (failure: unknown) => {
        if (alive) {
          setState({
            message: failure instanceof Error ? failure.message : TEXT.memory.openArtifactFailed,
            status: "error",
          });
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [attempt, client, current.id, current.version, target]);

  // The Session titles a version can come from, for the header's source line
  // and the picker's option text.
  const projectId = state.status === "ready" ? state.output.artifact.projectId : undefined;
  useEffect(() => {
    if (projectId === undefined) return;
    let alive = true;
    setSessions(undefined);
    void listSessions(client, projectId, "all")
      .then((items) => {
        if (alive) setSessions(items);
      })
      .catch(() => {
        if (alive) setSessions([]);
      });
    return () => {
      alive = false;
    };
  }, [client, projectId]);

  // The chosen version's bytes and provenance, in parallel: the provenance tab
  // is one press away, and the old UI read both as soon as the version opened.
  useEffect(() => {
    if (state.status !== "ready" || versionId === undefined) return;
    const version = state.versions.find((candidate) => candidate.id === versionId);
    if (version === undefined) return;
    let alive = true;
    setPreview({ status: "loading" });
    setProvenance({ status: "loading" });
    const readSession = version.sessionId || target || "";
    const name = artifactName(state.output);
    const path = version.sourcePath ?? "";
    void readCachedDocument(client, readSession, version.id).then(
      (document) => {
        if (!alive) return;
        setPreview({
          document,
          name,
          slot: {
            artifactId: state.output.artifact.id,
            home: false,
            id: `artifact:${version.id}`,
            label: name,
            loading: false,
            path,
            references: version.references,
            sessionId: version.sessionId || target,
            source: "artifact",
            versionId: version.id,
            ...documentPayload(document.bytes, path === "" ? name : path, document.mediaType),
          },
          status: "ready",
        });
      },
      (failure: unknown) => {
        if (alive) {
          setPreview({
            message: failure instanceof Error ? failure.message : TEXT.memory.openArtifactFailed,
            status: "error",
          });
        }
      },
    );
    void readArtifactProvenance(client, readSession, version.id).then(
      (record) => {
        if (alive) setProvenance({ provenance: record, status: "ready" });
      },
      (failure: unknown) => {
        if (alive) {
          setProvenance({
            message: failure instanceof Error ? failure.message : TEXT.memory.provenance.error,
            status: "error",
          });
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [client, provenanceAttempt, state, target, versionId]);

  const output = state.status === "ready" ? state.output : undefined;
  const artifact = output?.artifact;
  const versions = state.status === "ready" ? state.versions : [];
  const version = versions.find((candidate) => candidate.id === versionId);
  const title = output === undefined ? reference.label || reference.id : artifactName(output);
  const showVersionSources = new Set(versions.map((candidate) => candidate.sessionId)).size > 1;

  const versionOption = (candidate: ScientificArtifactVersion): string => {
    const when = new Date(candidate.createdAt).toLocaleString();
    if (!showVersionSources || sessions === undefined) return `v${candidate.version} · ${when}`;
    const title = sessions.find((session) => session.id === candidate.sessionId)?.title
      ?? TEXT.memory.artifactDialog.deletedSession;
    return `v${candidate.version} · ${TEXT.memory.artifactDialog.versionSource(truncateSource(title))} · ${when}`;
  };

  const sourceLine = version === undefined || sessions === undefined
    ? undefined
    : TEXT.memory.artifactDialog.updatedInSession(
      sessions.find((session) => session.id === version.sessionId)?.title
        ?? TEXT.memory.artifactDialog.deletedSession,
    );

  const download = () => {
    if (version === undefined || preview.status !== "ready") return;
    downloadDocument(preview.name, preview.document);
  };

  // The frame is drawn from the press, not from the bytes: the title and the
  // tabs are already known, and a dialog that stays invisible for two round
  // trips reads as a press that did nothing. The body holds a placeholder
  // line and reserves a document's worth of height while it waits, so the
  // dialog does not open as a strip and grow into a page (which is why the
  // old UI waited for the content instead).
  const bodyLoading = state.status === "loading"
    || (state.status === "ready" && mode === "preview" && preview.status === "loading");

  const split = panelOffset > 0;
  const dialog = (
    <div
      className={`modal-backdrop artifact-backdrop${split ? " is-split" : ""}`}
      onPointerDown={onClose}
      style={split
        ? ({ "--artifact-panel-offset": `${panelOffset}px` } as CSSProperties)
        : undefined}
    >
      <section
        aria-label={title}
        aria-modal="true"
        className={`artifact-dialog${split ? " is-split" : ""}${bodyLoading ? " is-loading" : ""}`}
        onPointerDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="artifact-dialog-head">
          <div className="artifact-dialog-title">
            <div className="artifact-dialog-eyebrow">
              <span className="memory-kind-chip is-artifact">{artifact?.kind ?? "artifact"}</span>
              {version !== undefined && version.version > 1 ? (
                <span className="artifact-dialog-version">
                  {TEXT.memory.artifactDialog.versionOf(version.version, versions.length)}
                </span>
              ) : null}
            </div>
            <h2>{title}</h2>
            {sourceLine === undefined ? null : (
              <p className="artifact-dialog-source" title={version?.sessionId}>{sourceLine}</p>
            )}
          </div>
          <div className="artifact-dialog-controls">
            {versions.length === 0 ? null : (
              <label className="artifact-dialog-picker">
                <span>{TEXT.memory.artifactDialog.versionLabel}</span>
                <select
                  aria-label={TEXT.memory.artifactDialog.versionAria}
                  onChange={(event) => setVersionId(event.target.value)}
                  value={versionId ?? ""}
                >
                  {versions.toReversed().map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>{versionOption(candidate)}</option>
                  ))}
                </select>
              </label>
            )}
            <button
              className="artifact-dialog-download"
              disabled={version === undefined || preview.status !== "ready"}
              onClick={download}
              type="button"
            >
              {TEXT.memory.artifactDialog.download}
            </button>
            <button aria-label={TEXT.memory.closeDialog} className="modal-close" onClick={onClose} type="button">
              ×
            </button>
          </div>
        </header>

        <nav className="memory-tabs artifact-dialog-tabs">
          <button
            aria-pressed={mode === "preview"}
            className={mode === "preview" ? "is-active" : ""}
            onClick={() => setMode("preview")}
            type="button"
          >
            {TEXT.memory.artifactDialog.previewTab}
          </button>
          <button
            aria-pressed={mode === "provenance"}
            className={mode === "provenance" ? "is-active" : ""}
            onClick={() => setMode("provenance")}
            type="button"
          >
            {TEXT.memory.provenanceTab}
          </button>
        </nav>

        <div aria-busy={bodyLoading} className="doc-body artifact-dialog-body" ref={bodyRef}>
          {bodyLoading ? <p className="doc-note">{TEXT.memory.artifactDialog.loading}</p> : null}
          {state.status === "error" ? (
            <Failure message={state.message} onRetry={() => setAttempt((value) => value + 1)} />
          ) : null}
          {state.status === "ready" && mode === "preview" ? (
            preview.status === "error" ? <Failure message={preview.message} />
              : preview.status === "ready" ? (
                <div className="artifact-canvas">
                  <DocumentPreview
                    expanded={expanded}
                    onExpand={setExpanded}
                    onReferenceClick={onReferenceClick}
                    slot={preview.slot}
                  />
                </div>
              ) : null
          ) : null}
          {state.status === "ready" && mode === "provenance" ? (
            // The old UI's loader for this tab was a plain sentence, not a
            // spinner, and provenance is the slower of the two reads.
            provenance.status === "loading"
              ? <p className="doc-note">{TEXT.memory.provenance.loading}</p>
              : provenance.status === "error" ? (
                <Failure
                  message={provenance.message}
                  onRetry={() => setProvenanceAttempt((value) => value + 1)}
                  title={TEXT.memory.provenance.error}
                />
              ) : (
                <ArtifactProvenanceView
                  onOpenDependency={(dependency) => {
                    if (onOpenArtifact === undefined) {
                      // No panel to open (the demo page): keep the old
                      // behaviour of switching this dialog in place.
                      setCurrent({ id: dependency.artifact.id, version: dependency.version.version });
                      return;
                    }
                    onOpenArtifact({ artifact: dependency.artifact, version: dependency.version });
                  }}
                  provenance={provenance.provenance}
                />
              )
          ) : null}
        </div>
      </section>
    </div>
  );

  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}

function Failure({ message, onRetry, title = TEXT.memory.openArtifactFailed }: {
  message: string;
  onRetry?: () => void;
  title?: string;
}) {
  return (
    <div className="memory-state">
      <strong>{title}</strong>
      <p>{message}</p>
      {onRetry === undefined ? null : (
        <button className="secondary-button" onClick={onRetry} type="button">
          {TEXT.memory.provenance.retry}
        </button>
      )}
    </div>
  );
}

/* ── 溯源, as the old UI's provenance tab shows it ──────────────────────── */

function downloadScript(item: ArtifactCodeProvenance, version: number): void {
  if (typeof document === "undefined") return;
  const extension = item.language === "r" ? "R" : item.language === "shell" ? "sh" : "py";
  const url = URL.createObjectURL(new Blob([item.code], { type: "text/plain" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `artifact-v${version}-${item.runId}.${extension}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

const ENVIRONMENT_VALUE_PREVIEW = 160;

function ProcessEnvironment({ environment }: { environment: Record<string, string> | null }) {
  const text = TEXT.memory.artifactProvenance;
  if (environment === null) {
    return <p className="memory-trace-empty">{text.processEnvironmentUnavailable}</p>;
  }
  const entries = Object.entries(environment).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return (
    <details className="memory-process-environment">
      <summary>{text.processEnvironment(entries.length)}</summary>
      {entries.length === 0 ? <p className="memory-trace-empty">{text.processEnvironmentEmpty}</p> : (
        <dl>
          {entries.map(([key, value]) => (
            <div className="memory-process-environment-row" key={key}>
              <dt><code>{key}</code></dt>
              <dd>
                {value.length <= ENVIRONMENT_VALUE_PREVIEW ? <code>{value}</code> : (
                  <details>
                    <summary><code>{value.slice(0, ENVIRONMENT_VALUE_PREVIEW)}…</code></summary>
                    <pre>{value}</pre>
                  </details>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </details>
  );
}

type ProvenanceDependency = ArtifactVersionProvenance["dependencies"][number];

function ArtifactProvenanceView({
  onOpenDependency,
  provenance,
}: {
  onOpenDependency: (dependency: ProvenanceDependency) => void;
  provenance: ArtifactVersionProvenance;
}) {
  const text = TEXT.memory.artifactProvenance;
  return (
    <div className="memory-artifact-provenance">
      {provenance.sourceSessionDeleted === true ? (
        <p className="memory-trace-empty">{text.sourceSessionDeleted}</p>
      ) : null}
      {/* An artifact that nothing was derived from says nothing here: a
          heading and a "none recorded" line were only ever a placeholder, and
          the old UI left the block out entirely. The code that wrote it and
          the run that executed it follow either way. */}
      {provenance.dependencies.length === 0 ? null : (
        <section className="memory-provenance-block is-dependencies">
          <h4>{text.dependencies}</h4>
          <div className="memory-dependency-list">
            {provenance.dependencies.map((dependency) => {
              const { artifact, kind, version } = dependency;
              const name = artifact.name || artifact.logicalName;
              // An uploaded source file has no artifact version to open; the
              // name is the whole answer.
              return kind === "source_file" ? (
                <span className="memory-dependency is-file" key={version.id}>{name}</span>
              ) : (
                <button
                  className="memory-dependency"
                  key={version.id}
                  onClick={() => onOpenDependency(dependency)}
                  type="button"
                >
                  {name} <span className="memory-dependency-version">{TEXT.memory.version(version.version)}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {provenance.code.length === 0 ? null : (
        <section className="memory-provenance-block">
          <h4>{text.code}</h4>
          {provenance.code.map((item) => (
            <article className="memory-code" key={item.runId}>
              <header className="memory-code-head">
                <strong>{item.tool} · {item.runId.slice(0, 8)}</strong>
                <button
                  className="memory-node-action"
                  onClick={() => downloadScript(item, provenance.version.version)}
                  type="button"
                >
                  {text.downloadScript}
                </button>
              </header>
              <pre className="memory-code-body">{item.code}</pre>
            </article>
          ))}
        </section>
      )}

      {provenance.executionLog.length === 0 ? null : (
        <section className="memory-provenance-block">
          <h4>{text.execution}</h4>
          {provenance.executionLog.map((log) => (
            <article className="memory-execution" key={log.runId}>
              <header className="memory-execution-head">
                <strong>{log.status} · {text.exitCode(log.exitCode)}</strong>
                <code className="memory-run-id">{log.runId.slice(0, 8)}</code>
              </header>
              <p className="memory-working-dir">
                <span>{text.workingDirectory}</span>
                <code>{log.workingDirectory || text.unavailable}</code>
              </p>
              <pre className="memory-log-body">
                {log.stdout || text.stdoutEmpty}
                {log.stderr ? `\n\nstderr:\n${log.stderr}` : ""}
              </pre>
              <ProcessEnvironment environment={log.processEnvironment} />
            </article>
          ))}
        </section>
      )}

      {provenance.environments.length === 0 ? null : (
        <section className="memory-provenance-block">
          <h4>{text.environment}</h4>
          {provenance.environments.map((environment) => (
            <article className="memory-environment" key={environment.id}>
              <header>
                <strong>{environment.language} {environment.languageVersion}</strong>
              </header>
              <p>{environment.provisioner} · {environment.platform}</p>
              <small>{environment.packages.join(", ") || text.noPackages}</small>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
