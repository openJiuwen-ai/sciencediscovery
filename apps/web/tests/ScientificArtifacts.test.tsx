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

import assert from "node:assert/strict";
import test from "node:test";

import type { ArtifactVersionProvenance, MemoryGraphNode, ScientificArtifact, ScientificArtifactVersion } from "@sciencediscovery/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { findArtifactNodeInGraph, findCodeNodeInGraph } from "../src/MemoryGraphExplorer.js";
import {
  ArtifactDownloadButton,
  CsvArtifactPreview,
  DatasetPreview,
  DatasetTable,
  isCsvWorkspaceReady,
  JsonSourcePreview,
  parseStructureAtoms,
  ProvenanceView,
  ScientificArtifactPanelHeader,
} from "../src/ScientificArtifacts.js";

test("artifact preview exposes a current-version download control", () => {
  const enabled = renderToStaticMarkup(createElement(ArtifactDownloadButton, {
    busy: false,
    disabled: false,
    label: "Download current version",
    onDownload: () => undefined,
  }));
  assert.match(enabled, /aria-label="Download current version"/);
  assert.doesNotMatch(enabled, /disabled/);

  const busy = renderToStaticMarkup(createElement(ArtifactDownloadButton, {
    busy: true,
    disabled: false,
    label: "Download current version",
    onDownload: () => undefined,
  }));
  assert.match(busy, /disabled=""/);
});

test("JSON preview shows the formatted document instead of a table", () => {
  const formatted = '{\n  "name": "af3",\n  "sequences": []\n}';
  const html = renderToStaticMarkup(createElement(JsonSourcePreview, {
    parsed: true,
    source: formatted,
    truncated: false,
  }));
  assert.match(html, /&quot;name&quot;: &quot;af3&quot;/);
  assert.doesNotMatch(html, /<table/);
  assert.doesNotMatch(html, /row/);
});

test("JSON preview labels unparseable documents and still shows the raw text", () => {
  const html = renderToStaticMarkup(createElement(JsonSourcePreview, {
    parsed: false,
    source: '{"truncated": tru',
    truncated: true,
  }));
  assert.match(html, /not valid JSON/);
  assert.match(html, /&quot;truncated&quot;: tru/);
  assert.match(html, /Preview truncated/);
});

test("dataset table replaces an empty grid with an explicit no-rows explanation", () => {
  const empty = renderToStaticMarkup(createElement(DatasetTable, {
    columns: [],
    rows: [],
    totalRows: 0,
    truncated: false,
  }));
  assert.doesNotMatch(empty, /<table/);
  assert.doesNotMatch(empty, /0 rows/);
  assert.match(empty, /No table rows could be parsed/);

  const populated = renderToStaticMarkup(createElement(DatasetTable, {
    columns: ["a"],
    rows: [["1"]],
    totalRows: 1,
    truncated: false,
  }));
  assert.match(populated, /<table/);
  assert.match(populated, /1 row</);
});

// -- Tabular JSON: Dataset table <-> raw JSON switch -------------------------

const TABULAR_JSON = {
  columns: ["id", "meta"],
  rawJson: { source: '[\n  {\n    "id": 1,\n    "meta": {\n      "tag": "a"\n    }\n  }\n]', truncated: false },
  rows: [["1", '{"tag":"a"}']],
  totalRows: 1,
  truncated: false,
};

test("a JSON-backed dataset defaults to the table and offers both view switches", () => {
  const html = renderToStaticMarkup(createElement(DatasetPreview, {
    ...TABULAR_JSON,
    onViewChange: () => undefined,
    view: "table" as const,
  }));
  assert.match(html, /<table/);
  assert.match(html, /1 row</);
  // Both switches are always rendered, so the raw view is one click away…
  assert.match(html, /aria-pressed="true"[^>]*>Table</);
  assert.match(html, /aria-pressed="false"[^>]*>Raw JSON</);
  // …and the table view does not leak the raw document into the markup.
  assert.doesNotMatch(html, /json-source-preview/);
});

test("the raw JSON view shows the formatted source document and can switch back", () => {
  const html = renderToStaticMarkup(createElement(DatasetPreview, {
    ...TABULAR_JSON,
    onViewChange: () => undefined,
    view: "raw" as const,
  }));
  assert.match(html, /json-source-preview/);
  assert.match(html, /&quot;tag&quot;: &quot;a&quot;/);
  assert.doesNotMatch(html, /<table/);
  // The Table switch stays available, so the transition is reversible.
  assert.match(html, /aria-pressed="false"[^>]*>Table</);
  assert.match(html, /aria-pressed="true"[^>]*>Raw JSON</);
});

// `renderToStaticMarkup` cannot click, so walk the returned element tree and
// invoke each switch handler directly. That proves both directions are wired,
// not just that both buttons are painted.
function switchLabelsAndHandlers(node: unknown): Array<{ click: () => void; label: string }> {
  if (!node || typeof node !== "object") return [];
  const element = node as { props?: { children?: unknown; onClick?: () => void }; type?: unknown };
  const children = element.props?.children;
  const nested = (Array.isArray(children) ? children : [children]).flatMap(switchLabelsAndHandlers);
  if (element.type === "button" && typeof element.props?.onClick === "function" && typeof children === "string") {
    return [{ click: element.props.onClick, label: children }, ...nested];
  }
  return nested;
}

test("both view switches report the view they select, in either starting view", () => {
  for (const view of ["table", "raw"] as const) {
    const seen: string[] = [];
    const switches = switchLabelsAndHandlers(
      DatasetPreview({ ...TABULAR_JSON, onViewChange: (next) => seen.push(next), view }),
    );
    assert.deepEqual(switches.map((item) => item.label), ["Table", "Raw JSON"], `starting from ${view}`);
    for (const item of switches) item.click();
    assert.deepEqual(seen, ["table", "raw"], `starting from ${view}`);
  }
});

test("a non-JSON dataset renders the table alone, with no raw JSON switch", () => {
  const html = renderToStaticMarkup(createElement(DatasetPreview, {
    columns: ["name", "value"],
    onViewChange: () => undefined,
    rows: [["a", "1"]],
    totalRows: 1,
    truncated: false,
    view: "table" as const,
  }));
  assert.match(html, /<table/);
  assert.doesNotMatch(html, /Raw JSON/);
  assert.doesNotMatch(html, /dataset-view-tabs/);
});

test("parses protein, pocket, and ligand layers for the interactive structure viewer", () => {
  const pdb = [
    "ATOM      1  CA  ALA A   1      10.000  12.000  14.000  1.00 20.00           C ",
    "HETATM    2  C1  POC A   2      11.000  13.000  15.000  1.00 20.00           C ",
    "HETATM    3  N1  LIG A   3      12.000  14.000  16.000  1.00 20.00           N ",
  ].join("\n");
  assert.deepEqual(parseStructureAtoms(pdb).map((atom) => atom.layer), ["protein", "pocket", "ligand"]);
});

test("artifact provenance shows parent files and generation info without sub-tabs", () => {
  const provenance: ArtifactVersionProvenance = {
    code: [],
    dependencies: [],
    environments: [],
    executionLog: [],
    messages: [],
    review: [],
    version: {
      artifactId: "artifact-1",
      content: { hash: "a".repeat(64), size: 10 },
      createdAt: "2026-07-16T00:00:00.000Z",
      executionRunIds: [],
      id: "version-1",
      inputArtifactVersionIds: [],
      mediaType: "text/markdown",
      projectId: "project-1",
      sessionId: "session-1",
      version: 1,
    },
  };
  const html = renderToStaticMarkup(createElement(ProvenanceView, { provenance }));
  assert.match(html, /No parent files recorded/);
  assert.doesNotMatch(html, /No generation script/);
  assert.doesNotMatch(html, /Messages/);
  assert.doesNotMatch(html, /Review/);
  assert.doesNotMatch(html, /Execution Log/);
  assert.doesNotMatch(html, /Environment/);
});

test("artifact provenance explains retained content when its source Session was deleted", () => {
  const provenance: ArtifactVersionProvenance = {
    code: [], dependencies: [], environments: [], executionLog: [], messages: [], review: [],
    sourceSessionDeleted: true,
    version: {
      artifactId: "artifact-1", content: { hash: "a".repeat(64), size: 10 },
      createdAt: "2026-07-16T00:00:00.000Z", executionRunIds: [], id: "version-1",
      inputArtifactVersionIds: [], mediaType: "text/markdown", projectId: "project-1",
      sessionId: "deleted-session", version: 1,
    },
  };
  const html = renderToStaticMarkup(createElement(ProvenanceView, { provenance }));
  assert.match(html, /source Session was deleted/);
  assert.match(html, /content and version history are retained/);
});

test("artifact provenance separates process environment from managed packages", () => {
  const longValue = "x".repeat(200);
  const provenance: ArtifactVersionProvenance = {
    code: [],
    dependencies: [],
    environments: [{
      channels: ["conda-forge"],
      createdAt: "2026-08-07T00:00:00.000Z",
      environmentId: "environment-1",
      id: "revision-1",
      language: "python",
      languageVersion: "3.12",
      packages: ["numpy==2.3.2"],
      packageSpecHash: "b".repeat(64),
      platform: "linux-64",
      provisioner: "micromamba",
      runnerVersion: "runner-test",
      snapshot: { hash: "c".repeat(64), size: 128 },
    }],
    executionLog: [{
      envSnapshot: { hash: "d".repeat(64), size: 256 },
      exitCode: 0,
      finishedAt: "2026-08-07T00:00:01.000Z",
      processEnvironment: { ZETA: "last", LONG: longValue, ALPHA: "first" },
      runId: "run-present",
      status: "succeeded",
      stderr: "",
      stdout: "done",
      workingDirectory: "/workspace/results",
    }, {
      envSnapshot: null,
      exitCode: 1,
      finishedAt: "2026-08-07T00:00:02.000Z",
      processEnvironment: null,
      runId: "run-historical",
      status: "failed",
      stderr: "failed",
      stdout: "",
      workingDirectory: "unavailable",
    }],
    messages: [],
    review: [],
    version: {
      artifactId: "artifact-1",
      content: { hash: "a".repeat(64), size: 10 },
      createdAt: "2026-08-07T00:00:00.000Z",
      executionRunIds: ["run-present", "run-historical"],
      id: "version-1",
      inputArtifactVersionIds: [],
      mediaType: "text/markdown",
      projectId: "project-1",
      sessionId: "session-1",
      version: 1,
    },
  };
  const html = renderToStaticMarkup(createElement(ProvenanceView, { provenance }));
  assert.match(html, /Working directory/);
  assert.match(html, /\/workspace\/results/);
  assert.match(html, /Process environment \(3 variables\)/);
  assert.ok(html.indexOf("ALPHA") < html.indexOf("LONG"));
  assert.ok(html.indexOf("LONG") < html.indexOf("ZETA"));
  assert.match(html, new RegExp(`${"x".repeat(160)}…`));
  assert.match(html, new RegExp(longValue));
  assert.match(html, /Process environment unavailable \(not recorded for this run\)\./);
  assert.match(html, /Managed package environment/);
  assert.doesNotMatch(html, /<details class="process-environment" open/);
});

test("renders the interactive CSV entry only after its immutable version is ready", () => {
  const ready = renderToStaticMarkup(createElement(CsvArtifactPreview, {
    onOpen: () => undefined,
    ready: true,
    source: "gene,value\nCD3D,4.2",
  }));
  assert.match(ready, /Open CSV Visualization Workspace/);
  assert.match(ready, /View raw CSV/);
  assert.doesNotMatch(ready, /disabled/);

  const loading = renderToStaticMarkup(createElement(CsvArtifactPreview, {
    onOpen: () => undefined,
    ready: false,
    source: "",
  }));
  assert.match(loading, /disabled/);
  assert.match(loading, /Loading CSV Artifact/);
});

test("opens a requested CSV workspace only for the loaded immutable version", () => {
  assert.equal(isCsvWorkspaceReady({
    detected: true,
    loadedVersionId: "version-1",
    source: "gene,value\nCD3D,4.2",
    versionId: "version-1",
  }), true);
  assert.equal(isCsvWorkspaceReady({
    detected: true,
    loadedVersionId: "version-previous",
    source: "gene,value\nCD3D,4.2",
    versionId: "version-1",
  }), false);
  assert.equal(isCsvWorkspaceReady({
    detected: false,
    loadedVersionId: "version-1",
    source: "gene,value\nCD3D,4.2",
    versionId: "version-1",
  }), false);
});

test("renders the embedded scientific artifact selectors", () => {
  const artifact: ScientificArtifact = {
    createdAt: "2026-07-27T02:47:21.000Z",
    createdInSessionId: "session-1",
    createdInSessionTitle: "Analysis",
    currentVersion: 1,
    id: "artifact-1",
    kind: "dataset",
    logicalName: "reports/marker-matrix.csv",
    name: "reports/marker-matrix.csv",
    origin: "llm_declared",
    projectId: "project-1",
    sessionId: "session-1",
    updatedAt: "2026-07-27T02:47:21.000Z",
  };
  const version: ScientificArtifactVersion = {
    artifactId: artifact.id,
    content: { hash: "a".repeat(64), size: 128 },
    createdAt: artifact.createdAt,
    executionRunIds: [],
    id: "version-1",
    inputArtifactVersionIds: [],
    mediaType: "text/csv",
    projectId: artifact.projectId,
    sessionId: artifact.sessionId,
    version: 1,
  };
  const html = renderToStaticMarkup(createElement(ScientificArtifactPanelHeader, {
    artifactId: artifact.id,
    artifacts: [artifact],
    onArtifactChange: () => undefined,
    onVersionChange: () => undefined,
    versionId: version.id,
    versions: [version],
  }));

  assert.doesNotMatch(html, /Immutable outputs/);
  assert.match(html, /Scientific artifacts/);
  assert.match(html, /reports\/marker-matrix\.csv · dataset/);
  assert.match(html, /aria-label="Artifact version"/);
});

const ARTIFACT_NODES: MemoryGraphNode[] = [
  { id: "a1", label: "Artifact", extra: { path: "results/fig1.png", version: 1 } },
  { id: "a2", label: "Artifact", extra: { path: "results/fig1.png", version: 2 } },
  { id: "b1", label: "Artifact", extra: { path: "data/raw.csv", version: 1 } },
  { id: "c-code", label: "Code", extra: { tool: "matplotlib" } },
];

test("findArtifactNodeInGraph matches the exact (path, version) composite key", () => {
  const node = findArtifactNodeInGraph(ARTIFACT_NODES, "results/fig1.png", 1);
  assert.equal(node?.id, "a1");
  const nodeV2 = findArtifactNodeInGraph(ARTIFACT_NODES, "results/fig1.png", 2);
  assert.equal(nodeV2?.id, "a2");
});

test("findArtifactNodeInGraph falls back to the highest version when version is unspecified", () => {
  const node = findArtifactNodeInGraph(ARTIFACT_NODES, "results/fig1.png");
  assert.equal(node?.id, "a2");
});

test("findArtifactNodeInGraph also matches a logical name that ends with the stored path", () => {
  // A session may prefix paths with a workspace root the graph doesn't carry.
  const node = findArtifactNodeInGraph(ARTIFACT_NODES, "ws/results/fig1.png", 1);
  assert.equal(node?.id, "a1");
});

test("findArtifactNodeInGraph returns undefined when no Artifact node carries that path", () => {
  const missing = findArtifactNodeInGraph(ARTIFACT_NODES, "results/missing.png", 1);
  assert.equal(missing, undefined);
  // A requested version that isn't in the graph falls back to the latest
  // version of that path, not undefined — losing the node entirely is worse
  // than showing the closest known version.
  const wrongVersion = findArtifactNodeInGraph(ARTIFACT_NODES, "results/fig1.png", 99);
  assert.equal(wrongVersion?.id, "a2");
});

test("findArtifactNodeInGraph ignores non-Artifact nodes even if their extra happens to carry a path", () => {
  const nodes: MemoryGraphNode[] = [
    { id: "code-with-path", label: "Code", extra: { path: "results/fig1.png", version: 1 } },
  ];
  assert.equal(findArtifactNodeInGraph(nodes, "results/fig1.png", 1), undefined);
});

const CODE_NODES: MemoryGraphNode[] = [
  { id: "2ffd91a4-6f9a-4498-8e2b-ff564c963f80", label: "Code", extra: { tool: "run_python" } },
  { id: "dbf88e90-205a-4707-bcd7-4f63d5cb5c08", label: "Code", extra: { code_id: "dbf88e90-205a-4707-bcd7-4f63d5cb5c08", tool: "run_python" } },
  { id: "artifact-with-code-id", label: "Artifact", extra: { code_id: "2ffd91a4-6f9a-4498-8e2b-ff564c963f80", path: "results/fig1.png", version: 1 } },
];

test("findCodeNodeInGraph matches by node id when extra.code_id is absent (legacy/typical writes)", () => {
  const node = findCodeNodeInGraph(CODE_NODES, "2ffd91a4-6f9a-4498-8e2b-ff564c963f80");
  assert.equal(node?.id, "2ffd91a4-6f9a-4498-8e2b-ff564c963f80");
});

test("findCodeNodeInGraph matches by extra.code_id when present (canonical place the runId lives)", () => {
  const node = findCodeNodeInGraph(CODE_NODES, "dbf88e90-205a-4707-bcd7-4f63d5cb5c08");
  assert.equal(node?.id, "dbf88e90-205a-4707-bcd7-4f63d5cb5c08");
});

test("findCodeNodeInGraph ignores non-Code nodes even if their extra happens to carry a code_id", () => {
  // An Artifact node carrying a stray code_id must not be returned as a Code.
  const node = findCodeNodeInGraph(CODE_NODES, "2ffd91a4-6f9a-4498-8e2b-ff564c963f80");
  assert.equal(node?.label, "Code");
  assert.equal(node?.id, "2ffd91a4-6f9a-4498-8e2b-ff564c963f80");
});

test("findCodeNodeInGraph returns undefined when no Code node carries that runId", () => {
  assert.equal(findCodeNodeInGraph(CODE_NODES, "never-existed"), undefined);
});
