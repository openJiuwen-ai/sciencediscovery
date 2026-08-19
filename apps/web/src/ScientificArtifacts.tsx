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

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";

import type {
  ArtifactAnnotation,
  ArtifactVersionProvenance,
  ComposerReference,
  MemorySubgraph,
  ScientificArtifact,
  ScientificArtifactVersion,
} from "@science-agent/schema";

import type { ApiClient } from "./api.js";
import { artifactDownloadFileName, downloadBlob } from "./artifact-download.js";
import { previewOf, type ArtifactPreviewPayload, type NotebookCell } from "./artifact-dashboard.js";
import { detectCsvArtifact } from "./csvArtifact.js";
import { DownloadIcon } from "./icons.js";
import { useLocale } from "./i18n/index.js";
import { MarkdownRenderer } from "./Markdown.js";
import { detectStructureFormat, isStructureJson, type StructureFormat } from "./molecular.js";

// Mol* is heavy; only fetch its bundle when the floating viewer is opened.
const MolstarWindow = lazy(() => import("./MolstarWindow.js"));

const CsvArtifactWindow = lazy(() => import("./csv-artifact/CsvArtifactWindow.js"));

// Memory graph explorer is heavy; lazy-load to avoid circular import.
const MemoryGraphExplorer = lazy(() => import("./MemoryGraphExplorer.js").then((m) => ({ default: m.MemoryGraphExplorer })));

// Stable identity so the panel never sees a fresh callback on a parent render.
const NOOP = () => undefined;

export function ArtifactDownloadButton({
  busy,
  disabled,
  label,
  onDownload,
}: {
  busy: boolean;
  disabled: boolean;
  label: string;
  onDownload: () => void;
}): ReactNode {
  return <button
    aria-label={label}
    className="icon-button"
    disabled={disabled || busy}
    onClick={onDownload}
    title={label}
    type="button"
  ><DownloadIcon size={16} /></button>;
}

interface StructureAtom {
  element: string;
  layer: "ligand" | "pocket" | "protein";
  x: number;
  y: number;
  z: number;
}

export function parseStructureAtoms(content: string): StructureAtom[] {
  if (content.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(content) as { atoms?: Array<Partial<StructureAtom>> };
      return (parsed.atoms ?? []).flatMap((atom) => Number.isFinite(atom.x) && Number.isFinite(atom.y) && Number.isFinite(atom.z)
        ? [{
            element: atom.element?.slice(0, 2) || "C",
            layer: atom.layer === "ligand" || atom.layer === "pocket" ? atom.layer : "protein",
            x: atom.x!, y: atom.y!, z: atom.z!,
          }]
        : []);
    } catch {
      return [];
    }
  }
  return content.split(/\r?\n/).flatMap((line) => {
    const record = line.slice(0, 6).trim();
    if (record !== "ATOM" && record !== "HETATM") return [];
    const x = Number(line.slice(30, 38));
    const y = Number(line.slice(38, 46));
    const z = Number(line.slice(46, 54));
    if (![x, y, z].every(Number.isFinite)) return [];
    const residue = line.slice(17, 20).trim().toLocaleUpperCase();
    return [{
      element: line.slice(76, 78).trim() || line.slice(12, 14).trim() || "C",
      layer: residue.startsWith("POC") ? "pocket" as const : record === "HETATM" && residue !== "HOH" ? "ligand" as const : "protein" as const,
      x, y, z,
    }];
  }).slice(0, 8_000);
}

function StructureViewer({ content }: { content: string }) {
  const atoms = useMemo(() => parseStructureAtoms(content), [content]);
  const [rotateX, setRotateX] = useState(18);
  const [rotateY, setRotateY] = useState(32);
  const projected = useMemo(() => {
    if (!atoms.length) return [];
    const center = atoms.reduce((sum, atom) => ({ x: sum.x + atom.x, y: sum.y + atom.y, z: sum.z + atom.z }), { x: 0, y: 0, z: 0 });
    center.x /= atoms.length; center.y /= atoms.length; center.z /= atoms.length;
    const rx = rotateX * Math.PI / 180;
    const ry = rotateY * Math.PI / 180;
    const points = atoms.map((atom) => {
      const x0 = atom.x - center.x;
      const y0 = atom.y - center.y;
      const z0 = atom.z - center.z;
      const x1 = x0 * Math.cos(ry) + z0 * Math.sin(ry);
      const z1 = -x0 * Math.sin(ry) + z0 * Math.cos(ry);
      const y1 = y0 * Math.cos(rx) - z1 * Math.sin(rx);
      const z2 = y0 * Math.sin(rx) + z1 * Math.cos(rx);
      return { ...atom, px: x1, py: y1, pz: z2 };
    });
    const span = Math.max(...points.flatMap((point) => [Math.abs(point.px), Math.abs(point.py)]), 1);
    return points.map((point) => ({ ...point, px: 240 + point.px / span * 205, py: 210 - point.py / span * 175 }))
      .toSorted((left, right) => left.pz - right.pz);
  }, [atoms, rotateX, rotateY]);
  if (!atoms.length) return <p className="artifact-empty">No PDB atoms or structure JSON atoms could be parsed from this version.</p>;
  return <div className="structure-viewer"><svg aria-label="Interactive 3D molecular structure" role="img" viewBox="0 0 480 420">{projected.map((atom, index) => <circle className={atom.layer} cx={atom.px} cy={atom.py} key={`${index}:${atom.element}`} r={atom.layer === "ligand" ? 4.4 : atom.layer === "pocket" ? 3.8 : 2.2}><title>{atom.layer} · {atom.element}</title></circle>)}</svg><div><label>Rotate X<input max="180" min="-180" onChange={(event) => setRotateX(Number(event.target.value))} type="range" value={rotateX} /></label><label>Rotate Y<input max="180" min="-180" onChange={(event) => setRotateY(Number(event.target.value))} type="range" value={rotateY} /></label><span><i className="protein" /> protein <i className="pocket" /> pocket <i className="ligand" /> ligand</span></div></div>;
}

function latexPreview(source: string): string {
  return source
    .replace(/\\(?:documentclass|usepackage)(?:\[[^\]]*])?\{[^}]*}/g, "")
    .replace(/\\begin\{document}|\\end\{document}/g, "")
    .replace(/\\section\*?\{([^}]*)}/g, "# $1")
    .replace(/\\subsection\*?\{([^}]*)}/g, "## $1")
    .replace(/\\textbf\{([^}]*)}/g, "**$1**")
    .replace(/\\emph\{([^}]*)}/g, "*$1*");
}

const PROCESS_ENVIRONMENT_VALUE_PREVIEW_LENGTH = 160;

function ProcessEnvironmentValue({ value }: { value: string }) {
  if (value.length <= PROCESS_ENVIRONMENT_VALUE_PREVIEW_LENGTH) return <code>{value}</code>;
  return <details className="process-environment-value">
    <summary><code>{value.slice(0, PROCESS_ENVIRONMENT_VALUE_PREVIEW_LENGTH)}…</code></summary>
    <pre>{value}</pre>
  </details>;
}

function ProcessEnvironment({ environment }: { environment: Record<string, string> | null }) {
  if (!environment) return <p className="process-environment-unavailable">Process environment unavailable (not recorded for this run).</p>;
  const entries = Object.entries(environment)
    .toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return <details className="process-environment">
    <summary>Process environment ({entries.length} {entries.length === 1 ? "variable" : "variables"})</summary>
    {entries.length
      ? <dl>{entries.map(([key, value]) => <div className="process-environment-row" key={key}><dt><code>{key}</code></dt><dd><ProcessEnvironmentValue value={value} /></dd></div>)}</dl>
      : <p>No environment variables recorded.</p>}
  </details>;
}

export function ProvenanceView({ provenance, onNavigateArtifact, onNavigateCode }: { provenance?: ArtifactVersionProvenance; onNavigateArtifact?: (logicalName: string, version?: number) => void; onNavigateCode?: (runId: string) => void }) {
  if (!provenance) return <p className="artifact-empty">Loading provenance…</p>;
  function downloadCode(index: number): void {
    const item = provenance!.code[index];
    if (!item) return;
    const url = URL.createObjectURL(new Blob([item.code], { type: "text/plain" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `artifact-${provenance!.version.version}-${item.runId}.${item.language === "r" ? "R" : item.language === "shell" ? "sh" : "py"}`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  return <div className="artifact-provenance">
    {provenance.sourceSessionDeleted ? <p className="artifact-empty compact">The source Session was deleted. Artifact content and version history are retained; Session execution details are unavailable.</p> : null}
    {provenance.dependencies.length ? <div className="provenance-parents"><span className="provenance-parents-label">← derived from</span> {provenance.dependencies.map(({ artifact, version }, i) => <span key={version.id}>{i > 0 ? " · " : ""}{onNavigateArtifact ? <button className="parent-link" onClick={() => onNavigateArtifact(artifact.logicalName, version.version)} type="button">{artifact.logicalName} v{version.version}</button> : <span>{artifact.logicalName} v{version.version}</span>}</span>)}</div> : <p className="artifact-empty compact">No parent files recorded.</p>}
    {provenance.code.length ? <div className="provenance-section">{provenance.code.map((item, index) => <article key={item.runId}><header>{onNavigateCode ? <button className="parent-link code-link" onClick={() => onNavigateCode(item.runId)} title="Highlight this run's Code node in the graph" type="button"><strong>{item.tool} · {item.runId.slice(0, 8)}</strong></button> : <strong>{item.tool} · {item.runId.slice(0, 8)}</strong>}<button onClick={() => downloadCode(index)} type="button">Download script</button></header><pre>{item.code}</pre></article>)}</div> : null}
    {provenance.executionLog.length ? <div className="provenance-section"><h3 className="provenance-section-title">Execution log</h3>{provenance.executionLog.map((log) => <article key={log.runId}><header><strong>{log.status} · exit {log.exitCode ?? "unavailable"}</strong></header><p className="provenance-working-directory"><strong>Working directory</strong> <code>{log.workingDirectory || "unavailable"}</code></p><pre>{log.stdout || "stdout: empty"}{log.stderr ? `\n\nstderr:\n${log.stderr}` : ""}</pre><ProcessEnvironment environment={log.processEnvironment} /></article>)}</div> : null}
    {provenance.environments.length ? <div className="provenance-section"><h3 className="provenance-section-title">Managed package environment</h3>{provenance.environments.map((environment) => <article key={environment.id}><header><strong>{environment.language} {environment.languageVersion}</strong></header><p>{environment.provisioner} · {environment.platform}</p><small>{environment.packages.join(", ") || "No packages recorded"}</small></article>)}</div> : null}
  </div>;
}

export function CsvArtifactPreview({
  onOpen,
  ready,
  source,
}: {
  onOpen: () => void;
  ready: boolean;
  source: string;
}) {
  return <div className="csv-artifact-preview">
    <button className="csv-artifact-launch" disabled={!ready} onClick={onOpen} type="button">
      <span>Interactive CSV</span>
      <strong>Open CSV Visualization Workspace</strong>
      <small>Automatically creates embedding, distribution, differential, marker, enrichment, and table views with configurable mappings, filters, linked selections, and exports.</small>
    </button>
    <details><summary>View raw CSV</summary><pre className="artifact-source-preview">{source.slice(0, 100_000) || "Loading CSV Artifact..."}</pre></details>
  </div>;
}

export function isCsvWorkspaceReady({
  detected,
  loadedVersionId,
  source,
  versionId,
}: {
  detected: boolean;
  loadedVersionId?: string;
  source: string;
  versionId?: string;
}): boolean {
  return detected && Boolean(source) && Boolean(versionId) && loadedVersionId === versionId;
}

export function DatasetTable({ columns, rows, totalRows, truncated }: { columns: string[]; rows: string[][]; totalRows: number; truncated: boolean }) {
  // An empty grid plus "0 rows" is not usable feedback: say why
  // there is nothing to show instead of rendering a headerless table.
  if (!columns.length && !rows.length) {
    return <p className="artifact-empty">No table rows could be parsed from this file. Download it to inspect the raw content.</p>;
  }
  return <div className="dataset-table-wrapper">
    <table className="dataset-table">
      <thead><tr>{columns.map((col, i) => <th key={i}>{col}</th>)}</tr></thead>
      <tbody>{rows.map((row, ri) => <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{cell}</td>)}</tr>)}</tbody>
    </table>
    <p className="dataset-table-meta">{totalRows} row{totalRows !== 1 ? "s" : ""}{truncated ? " (truncated)" : ""}</p>
  </div>;
}

/**
 * Plain JSON document preview: formatted JSON when the file parses, raw text
 * with an explicit reason when it does not. Never a table.
 */
export function JsonSourcePreview({ parsed, source, truncated }: { parsed: boolean; source: string; truncated: boolean }) {
  return <div className="json-source-preview">
    {parsed
      ? null
      : <p className="artifact-empty compact">This file is not valid JSON; the raw text is shown below.</p>}
    <pre className="artifact-source-preview">{source}</pre>
    {truncated ? <p className="dataset-table-meta">Preview truncated; download the artifact for the full content.</p> : null}
  </div>;
}

/** Which view a JSON-backed dataset table is showing. */
export type DatasetPreviewView = "raw" | "table";

/**
 * Dataset table preview. When the table came from a JSON document the payload
 * also carries the original document (`rawJson`), so the user can switch
 * between the table and the complete formatted JSON. csv/tsv carry no
 * `rawJson` and therefore render the table alone, without a switch.
 */
export function DatasetPreview({
  columns,
  onViewChange,
  rawJson,
  rows,
  totalRows,
  truncated,
  view,
}: {
  columns: string[];
  onViewChange: (view: DatasetPreviewView) => void;
  rawJson?: { source: string; truncated: boolean };
  rows: string[][];
  totalRows: number;
  truncated: boolean;
  view: DatasetPreviewView;
}) {
  const table = <DatasetTable columns={columns} rows={rows} totalRows={totalRows} truncated={truncated} />;
  if (!rawJson) return table;
  return <div className="dataset-preview">
    <nav aria-label="Dataset preview view" className="dataset-view-tabs">
      <button aria-pressed={view === "table"} className={view === "table" ? "active" : ""} onClick={() => onViewChange("table")} type="button">Table</button>
      <button aria-pressed={view === "raw"} className={view === "raw" ? "active" : ""} onClick={() => onViewChange("raw")} type="button">Raw JSON</button>
    </nav>
    {view === "raw"
      ? <JsonSourcePreview parsed source={rawJson.source} truncated={rawJson.truncated} />
      : table}
  </div>;
}

function NotebookCells({ cells }: { cells: NotebookCell[] }) {
  return <div className="notebook-cells">{cells.map((cell, i) => {
    if (cell.cell_type === "markdown") return <div className="notebook-cell markdown" key={i}><MarkdownRenderer content={cell.source} /></div>;
    if (cell.cell_type === "code") return <div className="notebook-cell code" key={i}><div className="notebook-cell-header">code</div><pre>{cell.source}</pre>{cell.execution_count != null ? <small>execution count: {cell.execution_count}</small> : null}</div>;
    return <div className="notebook-cell raw" key={i}><pre>{cell.source}</pre></div>;
  })}</div>;
}

export function ScientificArtifactPanelHeader({
  artifactId,
  artifacts,
  onArtifactChange,
  onVersionChange,
  versionId,
  versions,
}: {
  artifactId?: string;
  artifacts: ScientificArtifact[];
  onArtifactChange: (artifactId: string) => void;
  onVersionChange: (versionId: string) => void;
  versionId?: string;
  versions: ScientificArtifactVersion[];
}) {
  const selectedArtifact = artifacts.find((item) => item.id === artifactId);
  const selectedVersion = versions.find((item) => item.id === versionId);
  return <header>
    <h3>Scientific artifacts</h3>
    <div>
      <select aria-label="Artifact" onChange={(event) => onArtifactChange(event.target.value)} title={selectedArtifact?.logicalName ?? "Select an artifact"} value={artifactId ?? ""}>
        {artifacts.map((item) => <option key={item.id} value={item.id}>{item.logicalName} · {item.kind}</option>)}
      </select>
      <select aria-label="Artifact version" onChange={(event) => onVersionChange(event.target.value)} title={selectedVersion ? `Version ${selectedVersion.version}` : "Select an artifact version"} value={versionId ?? ""}>
        {versions.toReversed().map((item) => <option key={item.id} value={item.id}>v{item.version} · {new Date(item.createdAt).toLocaleString()}</option>)}
      </select>
    </div>
  </header>;
}

/**
 * Resolve the Session a memory-graph read (subgraph / artifact-provenance) must
 * target for the currently-viewed artifact. The workspace artifact list is
 * project-scoped (``listProjectArtifacts``), so the open artifact may belong to
 * a different Session than the active Session (``sessionId``). Non-graph
 * requests tolerate the mismatch — they route by versionId/projectId, not
 * ``n.session_id`` — but graph queries filter by ``n.session_id``, so they
 * must target the artifact's own Session or view-chain reports
 * "not yet in the Science Memory".
 *
 * Precedence (most specific first):
 * 1. ``version?.sessionId`` — the Session that actually produced THIS version.
 *    Finer than ``artifact.createdInSessionId`` (which is the Session that first
 *    created the name; a later Session reusing the same name only adds a new
 *    version). Available once the version list loads; view-chain only fires
 *    after that, so it's safe to prefer.
 * 2. ``artifactSessionId`` — caller-pinned Session (openArtifact / chip click
 *    forward ``artifact.createdInSessionId``). Used before the version loads.
 * 3. ``sessionId`` — the active Session (embedded/explorer and URL/shared-link
 *    paths, where the artifact IS the active Session's).
 */
export function resolveGraphSessionId(
  version: { sessionId?: string } | undefined,
  artifactSessionId: string | undefined,
  sessionId: string,
): string {
  // ``||`` (not ``??``): an empty string is treated as "unspecified" so legacy
  // rows missing sessionId / a caller pin of "" fall through to the active
  // Session rather than stranding graph reads on "".
  return version?.sessionId || artifactSessionId || sessionId;
}

export function ArtifactModal({
  client,
  embedded = false,
  logicalName,
  initialVersion,
  onClose,
  onMissing,
  onNavigateArtifact,
  onNavigateCode,
  onChipClick,
  onError,
  onPendingAnnotation,
  refreshKey,
  sessionId,
  artifactSessionId,
}: {
  client: ApiClient;
  /** Render inline (memory-graph explorer) instead of as a modal over a backdrop. */
  embedded?: boolean;
  logicalName: string;
  /** When opened from a chip, select this version (the one the claim cited)
    * instead of the latest — so an [artifact1] chip pointing at v1 opens v1, not the
    * drifted-latest. Absent → latest (current behavior). */
  initialVersion?: number;
  onClose: () => void;
  /**
    * Standalone mode only: called when no artifact in the Session matches
    * `logicalName` (e.g. a stale shared link), instead of silently opening
    * the first artifact.
    */
  onMissing?: (logicalName: string) => void;
  onNavigateArtifact: (logicalName: string, version?: number) => void;
  /** Embedded mode only (MemoryGraphExplorer): called when the user clicks a
    * provenance code-header to drive the canvas to the producing Code node.
    * Absent in standalone mode → code header renders as plain text. */
  onNavigateCode?: (runId: string) => void;
  onChipClick?: (reference: ComposerReference) => void;
  onError: (message: string) => void;
  onPendingAnnotation: (annotation: ArtifactAnnotation) => void;
  refreshKey?: string;
  sessionId: string;
  /** The Session the opened artifact actually belongs to, used ONLY for
    * memory-graph reads (subgraph for view-chain, artifact-provenance for the
    * derived-from row). The workspace artifact list is project-scoped
    * (listProjectArtifacts), so an artifact opened from it may live in a
    * different Session than ``sessionId`` (= activeSessionId); the graph
    * filters by Session (n.session_id), so without this the reads query the
    * wrong graph and view-chain reports "not yet in the memory graph".
    * Prefers the version's own Session (a version node's session_id is the
    * Session that actually produced that version — finer than
    * artifact.createdInSessionId, which is the Session that first created the
    * name). Absent → ``sessionId`` (current behavior for embedded/explorer
    * and URL/shared-link paths). */
  artifactSessionId?: string;
}) {
  const { t } = useLocale();
  const [artifacts, setArtifacts] = useState<ScientificArtifact[]>([]);
  const [artifactId, setArtifactId] = useState<string>();
  const [versions, setVersions] = useState<ScientificArtifactVersion[]>([]);
  const [versionId, setVersionId] = useState<string>();
  const [contentUrl, setContentUrl] = useState<string>();
  const [source, setSource] = useState("");
  const [loadedVersionId, setLoadedVersionId] = useState<string>();
  const [provenance, setProvenance] = useState<ArtifactVersionProvenance>();
  const [mode, setMode] = useState<"preview" | "provenance">("preview");
  const [point, setPoint] = useState<{ x: number; y: number }>();
  const [note, setNote] = useState("");
  const [zoom, setZoom] = useState(1);
  const [compareId, setCompareId] = useState<string>();
  const [compare, setCompare] = useState<{ content: string; format: StructureFormat; name?: string }>();
  const [molstarOpen, setMolstarOpen] = useState(false);
  const [csvWindowOpen, setCsvWindowOpen] = useState(false);
  const [preview, setPreview] = useState<ArtifactPreviewPayload>();
  const [datasetView, setDatasetView] = useState<DatasetPreviewView>("table");
  const [chainExplorer, setChainExplorer] = useState<{ nodeId: string; version?: number; chainKind: "task" | "artifact"; subgraph: MemorySubgraph } | null>(null);
  const [memoryGraphEnabled, setMemoryGraphEnabled] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState(false);
  useEffect(() => {
    void client.getMemoryHealth().then((result) => setMemoryGraphEnabled(result.memoryGraph === "healthy")).catch(() => setMemoryGraphEnabled(false));
  }, [client]);
  // Callers pass an inline arrow, so `onError` is a new function on every parent
  // render. It only reports failures and never decides what to fetch, so hold it
  // in a ref and keep it out of the fetch effects' dependencies.
  const onErrorRef = useRef(onError);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  const reportError = useCallback((message: string) => onErrorRef.current(message), []);
  const artifact = artifacts.find((item) => item.id === artifactId);
  const version = versions.find((item) => item.id === versionId);
  // Session used ONLY for memory-graph reads (getMemorySubgraph for view-chain,
  // getMemoryArtifactProvenance for the derived-from row). Non-graph requests
  // keep using ``sessionId`` — they route by versionId/projectId, not session_id,
  // so they tolerate a session mismatch; graph queries filter by n.session_id,
  // so they must target the artifact's own Session. See resolveGraphSessionId.
  const graphSessionId = resolveGraphSessionId(version, artifactSessionId, sessionId);
  const structureFormat = useMemo(
    () => (source ? detectStructureFormat({ content: source, mediaType: version?.mediaType, name: artifact?.logicalName }) : undefined),
    [artifact?.logicalName, source, version?.mediaType],
  );
  const molecularByName = useMemo(
    () => detectStructureFormat({ mediaType: version?.mediaType, name: artifact?.logicalName }),
    [artifact?.logicalName, version?.mediaType],
  );
  const comparableStructures = useMemo(
    () => artifacts.filter((item) => item.id !== artifactId && (item.kind === "structure" || detectStructureFormat({ name: item.logicalName }))),
    [artifactId, artifacts],
  );
  const csvDetection = useMemo(
    () => artifact?.kind === "dataset"
      ? detectCsvArtifact({
          content: loadedVersionId === version?.id ? source : "",
          mediaType: version?.mediaType,
          name: artifact.logicalName,
        })
      : undefined,
    [artifact?.kind, artifact?.logicalName, loadedVersionId, source, version?.id, version?.mediaType],
  );
  const csvWorkspaceReady = isCsvWorkspaceReady({
    detected: Boolean(csvDetection),
    loadedVersionId,
    source,
    versionId: version?.id,
  });
  // Preview routing is driven by the payload `mode`, not by the artifact kind:
  // a JSON artifact reports `dataset-table` only when it is a record array.
  const datasetTable = preview ? previewOf(preview, "dataset-table") : undefined;
  const jsonSource = preview ? previewOf(preview, "json-source") : undefined;

  useEffect(() => {
    setArtifacts([]);
    setArtifactId(undefined);
    setVersions([]);
    setVersionId(undefined);
    setContentUrl(undefined);
    setSource("");
    setLoadedVersionId(undefined);
    setProvenance(undefined);
    setPreview(undefined);
    setCompareId(undefined);
    setCompare(undefined);
    setMolstarOpen(false);
    setCsvWindowOpen(false);
    setPoint(undefined);
    setNote("");
    setMode("preview");
  }, [logicalName, sessionId]);

  useEffect(() => {
    let active = true;
    void client.listArtifacts(sessionId).then((items) => {
      if (!active) return;
      setArtifacts(items);
      const match = items.find((item) => item.logicalName === logicalName);
      // A standalone modal addressed by name (URL, shared link) must report a
      // stale name instead of silently opening the first artifact.
      if (!embedded && !match) {
        onMissing?.(logicalName);
        return;
      }
      setArtifactId((current) => {
        if (!embedded) return match?.id;
        if (current && items.some((item) => item.id === current)) return current;
        return match?.id ?? items[0]?.id;
      });
    }).catch((error: Error) => { if (active) reportError(error.message); });
    return () => { active = false; };
  }, [client, embedded, logicalName, onMissing, refreshKey, sessionId]);

  useEffect(() => {
    if (!artifactId) { setVersions([]); setVersionId(undefined); return; }
    let active = true;
    setVersions([]);
    setVersionId(undefined);
    void client.listArtifactVersions(sessionId, artifactId).then((items) => {
      if (!active) return;
      setVersions(items);
      // A chip may pin a specific version (the one the claim cited); honor it
      // over the latest so opening an [artifact1]@v1 chip shows v1, not the drifted
      // latest. Falls back to latest when no version is pinned or it's gone.
      const pinned = initialVersion != null
        ? items.find((item) => item.version === initialVersion)
        : undefined;
      setVersionId((current) =>
        items.some((item) => item.id === current) ? current : (pinned?.id ?? items.at(-1)?.id));
    }).catch((error: Error) => { if (active) reportError(error.message); });
    return () => { active = false; };
  }, [artifactId, client, refreshKey, sessionId, initialVersion]);

  useEffect(() => { setCompareId(undefined); setCompare(undefined); setMolstarOpen(false); }, [artifactId]);

  useEffect(() => {
    if (!compareId) { setCompare(undefined); return; }
    let active = true;
    void client.listArtifactVersions(sessionId, compareId).then(async (items) => {
      const latest = items.at(-1);
      const other = artifacts.find((item) => item.id === compareId);
      if (!active || !latest) return;
      const text = await (await client.readArtifactVersion(sessionId, latest.id)).text();
      const format = detectStructureFormat({ content: text, mediaType: latest.mediaType, name: other?.logicalName });
      if (active && format) setCompare({ content: text, format, name: other?.logicalName });
    }).catch((error: Error) => { if (active) reportError(error.message); });
    return () => { active = false; };
  }, [artifacts, client, compareId, sessionId]);

  useEffect(() => {
    setCsvWindowOpen(false);
    // Each artifact/version opens on its default table view; the raw-JSON
    // choice is per-preview, not sticky across artifacts.
    setDatasetView("table");
  }, [artifactId, versionId]);

  useEffect(() => {
    if (!versionId) { setContentUrl(undefined); setSource(""); setLoadedVersionId(undefined); setProvenance(undefined); return; }
    let active = true;
    let url: string | undefined;
    setContentUrl(undefined);
    setSource("");
    setLoadedVersionId(undefined);
    setProvenance(undefined);
    void Promise.all([client.readArtifactVersion(sessionId, versionId), client.getArtifactProvenance(sessionId, versionId)]).then(async ([blob, nextProvenance]) => {
      if (!active) return;
      const textualKind = artifact && ["dataset", "html", "json", "latex", "markdown", "notebook", "structure"].includes(artifact.kind);
      const molecularByName = detectStructureFormat({ name: artifact?.logicalName });
      const nextSource = textualKind || molecularByName ? await blob.text() : "";
      if (!active) return;
      url = URL.createObjectURL(blob);
      setContentUrl(url);
      setSource(nextSource);
      setLoadedVersionId(versionId);
      setProvenance(nextProvenance);
      setPoint(undefined);
      setNote("");
      // derived-from: overlay the memory-graph's ``input``/``produces`` 2-hop
      // dependencies on top of the legacy SessionStore provenance. The graph
      // is the authority for derived-from topology; the legacy endpoint stays
      // the source for the other five provenance fields (code/env/log/msg/review)
      // until the graph endpoint also provides them. Override ONLY when the
      // graph returns dependencies — an empty result means graph off/unreachable,
      // the ``input`` edge was never written (producing run ran while the graph
      // was off; writes are fire-and-forget and not replayed), or the run
      // genuinely read no inputs; in all those cases keep the legacy
      // dependencies so the ``← derived from`` row never silently blanks
      // (docs/memory-graph-derived-from-impl.md §7). The composite key
      // ``artifact.id`` + ``version.version`` is what the new endpoint takes,
      // and both are in hand here.
      if (artifact?.id && version?.version) {
        client.getMemoryArtifactProvenance(artifact.id, version.version, graphSessionId).then((graphResult) => {
          if (!active) return;
          if (!graphResult.dependencies.length) return; // empty → keep legacy
          setProvenance((current) =>
            current ? { ...current, dependencies: graphResult.dependencies } : current,
          );
        }).catch((error: Error) => { if (active) reportError(error.message); });
      }
    }).catch((error: Error) => { if (active) reportError(error.message); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [artifact?.kind, artifact?.logicalName, client, graphSessionId, sessionId, versionId]);

  useEffect(() => {
    if (!versionId || !artifact) { setPreview(undefined); return; }
    if (artifact.kind !== "dataset" && artifact.kind !== "json" && artifact.kind !== "notebook") { setPreview(undefined); return; }
    let active = true;
    void client.getArtifactVersionPreview(sessionId, versionId).then((payload) => { if (active) setPreview(payload); })
      .catch((error: Error) => { if (active) { setPreview(undefined); reportError(error.message); } });
    return () => { active = false; };
  }, [artifact, client, sessionId, versionId]);

  useEffect(() => {
    if (embedded) return;
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape" && !csvWindowOpen && !molstarOpen) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [csvWindowOpen, embedded, molstarOpen, onClose]);

  function choosePoint(event: MouseEvent<HTMLImageElement>): void {
    const bounds = event.currentTarget.getBoundingClientRect();
    setPoint({ x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height });
  }

  async function saveAnnotation(): Promise<void> {
    if (!version || !point || !note.trim()) return;
    try {
      const annotation = await client.createArtifactAnnotation(sessionId, version.id, { note: note.trim(), ...point });
      onPendingAnnotation(annotation);
      setPoint(undefined);
      setNote("");
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not save annotation");
    }
  }

  async function downloadCurrentVersion(): Promise<void> {
    if (!artifact || !version || downloadBusy) return;
    setDownloadBusy(true);
    try {
      const blob = await client.readArtifactVersion(sessionId, version.id);
      downloadBlob(blob, artifactDownloadFileName(artifact.name));
    } catch (error) {
      reportError(error instanceof Error ? error.message : t("artifact.downloadFailed"));
    } finally {
      setDownloadBusy(false);
    }
  }

  // Embedded mode switches `artifactId` in place so the left panel updates
  // without a remount; standalone mode hands the name up to the page. In both
  // modes, also forward the version pin so graph-aware callers (the memory
  // explorer) can match the exact composite-key node instead of the latest.
  function navigateArtifact(name: string, version?: number): void {
    if (!embedded) {
      onNavigateArtifact(name, version);
      return;
    }
    const target = artifacts.find((item) => item.logicalName === name);
    if (target) setArtifactId(target.id);
    onNavigateArtifact(name, version);
  }

  async function viewChain(chainKind: "task" | "artifact"): Promise<void> {
    try {
      // Query the artifact's own Session's graph (graphSessionId), not the
      // active Session — the workspace list is project-scoped so the open
      // artifact may live elsewhere; querying activeSession's graph would miss
      // the node and report "not yet in the Science Memory".
      const subgraph = await client.getMemorySubgraph(graphSessionId);
      // Artifact is one node per version (composite key); the subgraph holds
      // v1 and v2 as separate nodes. Match the EXACT version the user is
      // viewing so "View chain from v1" vs "from v2" walk separate chains.
      const currentVersion = version?.version;
      const node = subgraph.nodes.find((n) =>
        n.label === "Artifact" &&
        (n.extra?.path === logicalName || n.extra?.artifact_id === artifact?.id) &&
        (currentVersion == null || n.extra?.version === currentVersion));
      if (!node) {
        onError("This artifact is not yet in the Science Memory.");
        return;
      }
      setChainExplorer({ nodeId: node.id, version: currentVersion, chainKind, subgraph });
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not load Science Memory.");
    }
  }

  if (!artifacts.length) return null;
  // Shared by the dataset and json branches: same table, and the same
  // table/raw-JSON switch whenever the payload carries the source document.
  const datasetPreview: ReactNode = datasetTable
    ? <DatasetPreview
        columns={datasetTable.columns}
        onViewChange={setDatasetView}
        {...(datasetTable.rawJson ? { rawJson: datasetTable.rawJson } : {})}
        rows={datasetTable.rows}
        totalRows={datasetTable.totalRows}
        truncated={datasetTable.truncated}
        view={datasetView}
      />
    : null;
  const artifactContent: ReactNode = mode === "provenance"
    ? <ProvenanceView onNavigateArtifact={navigateArtifact} onNavigateCode={onNavigateCode} provenance={provenance} />
    : <div className="artifact-version-preview">
        {artifact?.kind === "figure" && contentUrl ? <><div className="annotatable-figure"> <img alt={artifact.logicalName} onClick={choosePoint} src={contentUrl} />{point ? <i style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }} /> : null}</div><div className="annotation-editor"><input onChange={(event) => setNote(event.target.value)} placeholder="Describe the requested edit at the pinned point" value={note} /><button disabled={!point || !note.trim()} onClick={() => void saveAnnotation()} type="button">Attach to next message</button></div></> : null}
        {artifact?.kind === "html" && contentUrl ? <><div className="dashboard-controls"><button aria-label="Zoom dashboard out" onClick={() => setZoom((value) => Math.max(.5, value - .1))} title="Zoom dashboard out" type="button">−</button><span>{Math.round(zoom * 100)}%</span><button aria-label="Zoom dashboard in" onClick={() => setZoom((value) => Math.min(2, value + .1))} title="Zoom dashboard in" type="button">＋</button></div><div className="dashboard-frame"><iframe sandbox="allow-scripts" src={contentUrl} style={{ height: `${420 / zoom}px`, transform: `scale(${zoom})`, transformOrigin: "top left", width: `${100 / zoom}%` }} title={artifact.logicalName} /></div></> : null}
        {artifact?.kind === "markdown" ? <div className="manuscript-preview"><MarkdownRenderer content={source} onChipClick={onChipClick} references={version?.references} /><details><summary>Source</summary><pre>{source}</pre></details></div> : null}
        {artifact?.kind === "latex" ? <div className="manuscript-preview"><MarkdownRenderer content={latexPreview(source)} onChipClick={onChipClick} references={version?.references} /><details><summary>LaTeX source</summary><pre>{source}</pre></details></div> : null}
        {structureFormat && source ? <div className="molecular-with-compare">
          {comparableStructures.length ? <div className="cmp-picker"><label>Compare with
            <select onChange={(event) => setCompareId(event.target.value || undefined)} value={compareId ?? ""}>
              <option value="">- none -</option>
              {comparableStructures.map((item) => <option key={item.id} value={item.id}>{item.logicalName}</option>)}
            </select></label></div> : null}
          <button className="molstar-launch-card" onClick={() => setMolstarOpen(true)} type="button">
            <span className="molstar-launch-badge">{structureFormat.toUpperCase()}</span>
            <span className="molstar-launch-title">{artifact?.logicalName}</span>
            <small>{compareId && compare ? `Open in Mol* and superpose ${compare.name} ↗` : "Open the interactive Mol* viewer ↗"}</small>
          </button>
          {molstarOpen ? <Suspense fallback={null}><MolstarWindow
            onClose={() => setMolstarOpen(false)}
            structures={compareId && compare
              ? [{ content: source, format: structureFormat, name: artifact?.logicalName }, { content: compare.content, format: compare.format, name: compare.name }]
              : [{ content: source, format: structureFormat, name: artifact?.logicalName }]}
          /></Suspense> : null}
        </div>
          : molecularByName ? <p className="artifact-empty">Loading interactive structure…</p>
          : artifact?.kind === "structure" || isStructureJson(source) ? <StructureViewer content={source} /> : null}
        {artifact?.kind === "report" && contentUrl ? <iframe className="report-frame" src={contentUrl} title={artifact.logicalName} /> : null}
        {artifact?.kind === "dataset" && csvDetection && !(structureFormat && source) ? <CsvArtifactPreview
          onOpen={() => setCsvWindowOpen(true)}
          ready={csvWorkspaceReady}
          source={source}
        />
          : artifact?.kind === "dataset" && datasetTable
            ? datasetPreview
          : artifact?.kind === "dataset" && jsonSource
            ? <JsonSourcePreview parsed={jsonSource.parsed} source={jsonSource.source} truncated={jsonSource.truncated} />
          : artifact?.kind === "dataset" && !(structureFormat && source) ? <pre className="artifact-source-preview">{source.slice(0, 100_000) || "Binary artifact: use the version content endpoint to inspect it."}</pre> : null}
        {/* JSON: a record array still gets the table (with a raw-JSON switch);
            every other document is shown as formatted JSON or raw text, never
            an empty grid. */}
        {artifact?.kind === "json" && !(structureFormat && source)
          ? datasetTable
            ? datasetPreview
            : jsonSource
              ? <JsonSourcePreview parsed={jsonSource.parsed} source={jsonSource.source} truncated={jsonSource.truncated} />
              : <pre className="artifact-source-preview">{source.slice(0, 100_000) || "Loading JSON content…"}</pre>
          : null}
        {artifact?.kind === "notebook" && preview?.kind === "notebook" && preview.mode === "notebook-cells"
          ? <NotebookCells cells={preview.cells} />
          : artifact?.kind === "notebook" && !(structureFormat && source) ? <pre className="artifact-source-preview">{source.slice(0, 100_000) || "Binary artifact: use the version content endpoint to inspect it."}</pre> : null}
      </div>;
  const csvWorkspace: ReactNode = csvWindowOpen && artifact && version && csvWorkspaceReady ? <Suspense fallback={<div className="csv-artifact-loading" role="status"><span>Loading CSV visualization...</span></div>}>
    <CsvArtifactWindow
      content={source}
      fileName={artifact.logicalName}
      onClose={() => setCsvWindowOpen(false)}
      provenance={provenance}
      version={version}
    />
  </Suspense> : null;

  if (embedded) {
    return <section aria-label="Versioned scientific artifacts" className="scientific-artifacts artifact-embedded-panel">
      <header className="artifact-modal-header">
        <div><span className="eyebrow">{artifact?.kind ?? "artifact"}</span><h2>{artifact?.logicalName ?? logicalName}</h2></div>
        <div className="artifact-modal-controls">
          {version && version.version > 1 ? <span className="version-hint">v{version.version} of {versions.length}</span> : null}
          <ArtifactDownloadButton busy={downloadBusy} disabled={!version} label={t("artifact.downloadCurrent")} onDownload={() => void downloadCurrentVersion()} />
        </div>
      </header>
      <nav className="artifact-mode-tabs">
        <button className={mode === "preview" ? "active" : ""} onClick={() => setMode("preview")} type="button">Preview</button>
        <button className={mode === "provenance" ? "active" : ""} onClick={() => setMode("provenance")} type="button">Provenance</button>
      </nav>
      <div className="artifact-modal-body">
        {artifactContent}
      </div>
      {csvWorkspace}
    </section>;
  }

  return <div className="artifact-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section aria-label={`Artifact: ${logicalName}`} aria-modal="true" className="artifact-modal-panel" role="dialog">
      <header className="artifact-modal-header">
        <div><span className="eyebrow">{artifact?.kind ?? "artifact"}</span><h2>{artifact?.logicalName ?? logicalName}</h2></div>
        <div className="artifact-modal-controls">
          <label className="version-picker"><span>version</span>
            <select aria-label="Artifact version" onChange={(event) => setVersionId(event.target.value)} value={versionId}>{versions.toReversed().map((item) => <option key={item.id} value={item.id}>v{item.version} · {new Date(item.createdAt).toLocaleString()}</option>)}</select>
          </label>
          <ArtifactDownloadButton busy={downloadBusy} disabled={!version} label={t("artifact.downloadCurrent")} onDownload={() => void downloadCurrentVersion()} />
          <button aria-label="Close artifact viewer" className="icon-button" onClick={onClose} title="Close artifact viewer" type="button">✕</button>
        </div>
      </header>
      <nav className="artifact-mode-tabs"><button className={mode === "preview" ? "active" : ""} onClick={() => setMode("preview")} type="button">Preview</button><button className={mode === "provenance" ? "active" : ""} onClick={() => setMode("provenance")} type="button">Provenance</button>{!embedded && memoryGraphEnabled ? <><button className="view-chain-btn" onClick={() => void viewChain("task")} type="button">{t("chain.viewTask")}</button><button className="view-chain-btn" onClick={() => void viewChain("artifact")} type="button">{t("chain.viewArtifact")}</button></> : null}{version && version.version > 1 && mode === "preview" ? <span className="version-hint">v{version.version} of {versions.length}</span> : null}</nav>
      <div className="artifact-modal-body">{artifactContent}</div>
      {csvWorkspace}
    </section>
    {chainExplorer ? <Suspense fallback={null}><MemoryGraphExplorer
      client={client}
      initialNodeId={chainExplorer.nodeId}
      initialVersion={chainExplorer.version}
      initialChainKind={chainExplorer.chainKind}
      autoChain
      onClose={() => setChainExplorer(null)}
      onError={onError}
      onPendingAnnotation={onPendingAnnotation}
      sessionId={graphSessionId}
      subgraph={chainExplorer.subgraph}
    /></Suspense> : null}
  </div>;
}

export function ScientificArtifacts({
  client,
  onError,
  onPendingAnnotation,
  refreshKey,
  sessionId,
}: {
  client: ApiClient;
  onError: (message: string) => void;
  onPendingAnnotation: (annotation: ArtifactAnnotation) => void;
  refreshKey: string;
  sessionId: string;
}) {
  return <ArtifactModal
    client={client}
    embedded
    logicalName=""
    onClose={NOOP}
    onError={onError}
    onNavigateArtifact={NOOP}
    onPendingAnnotation={onPendingAnnotation}
    refreshKey={refreshKey}
    sessionId={sessionId}
  />;
}
