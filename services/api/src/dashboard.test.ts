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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";

import type { ScientificArtifactKind } from "@sciencediscovery/schema";

import type {
  ArtifactDashboard,
  ArtifactPreviewPayload,
} from "./artifact-dashboard.js";
import {
  ArtifactDashboardError,
  buildArtifactDashboard,
  buildArtifactVersionPreview,
} from "./artifact-dashboard.js";
import { ProvenanceRecorder } from "@sciencediscovery/provenance";
import { SessionStore } from "./store.js";
import { createApiServer, type ServerConfig } from "./server.js";

interface Fixture {
  dataDir: string;
  recorder: ProvenanceRecorder;
  store: SessionStore;
  session: { id: string; projectId: string };
}

async function createFixture(context: TestContext): Promise<Fixture> {
  const dataDir = await mkdtemp(resolve(tmpdir(), "sciencediscovery-dashboard-"));
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  store.setAvailableSkillIds([]);
  await store.load();
  const model = await store.createModel({
    apiToken: "test",
    baseUrl: "https://models.example.test/v1",
    model: "test",
    name: "Test",
  });
  const project = await store.createProject("Dashboard project");
  const session = await store.createSession(project.id, "Dashboard session", { modelId: model.id });
  const recorder = new ProvenanceRecorder(dataDir, store);
  return { dataDir, recorder, store, session };
}

interface SeedInput {
  kind: ScientificArtifactKind;
  logicalName: string;
  mediaType: string;
  content: string;
  inputArtifactVersionIds?: string[];
}

async function seedArtifact(fixture: Fixture, input: SeedInput): Promise<string> {
  const content = await fixture.recorder.cas.put(input.content);
  const { version } = await fixture.store.createArtifactVersion({
    content,
    kind: input.kind,
    logicalName: input.logicalName,
    mediaType: input.mediaType,
    sessionId: fixture.session.id,
    ...(input.inputArtifactVersionIds ? { inputArtifactVersionIds: input.inputArtifactVersionIds } : {}),
  });
  return version.id;
}

// -- Direct contract tests (no server) ----------------------------------------

test("dashboard context labels stay empty until label fields are implemented", async (context) => {
  const fixture = await createFixture(context);
  const session = fixture.store.getSession(fixture.session.id);
  assert.ok(session);
  const project = fixture.store.getProject(fixture.session.projectId);
  const dashboard = await buildArtifactDashboard(fixture.store, fixture.session.id, project, session);
  const typed: ArtifactDashboard = dashboard;
  assert.deepEqual(typed.context.labels, []);
  assert.equal(typed.context.projectName, "Dashboard project");
  assert.equal(typed.context.sessionTitle, "Dashboard session");
  assert.equal(typed.context.projectId, fixture.session.projectId);
  assert.equal(typed.context.sessionId, fixture.session.id);
  assert.deepEqual(typed.artifacts, []);
});

test("dashboard aggregates artifact list, version list, latestVersionId, and hasParents", async (context) => {
  const fixture = await createFixture(context);
  const csvVid = await seedArtifact(fixture, {
    content: "value\n1\n",
    kind: "dataset",
    logicalName: "input.csv",
    mediaType: "text/csv",
  });
  await seedArtifact(fixture, {
    content: "# Heading\nbody",
    kind: "markdown",
    logicalName: "notes.md",
    mediaType: "text/markdown",
  });
  await seedArtifact(fixture, {
    content: "<svg><text>v1</text></svg>",
    inputArtifactVersionIds: [csvVid],
    kind: "figure",
    logicalName: "plot.svg",
    mediaType: "image/svg+xml",
  });
  await seedArtifact(fixture, {
    content: "<svg><text>v2</text></svg>",
    kind: "figure",
    logicalName: "plot.svg",
    mediaType: "image/svg+xml",
  });

  const session = fixture.store.getSession(fixture.session.id);
  const project = fixture.store.getProject(fixture.session.projectId);
  assert.ok(session && project);
  const dashboard = await buildArtifactDashboard(fixture.store, fixture.session.id, project, session);
  assert.equal(dashboard.artifacts.length, 3);
  const plot = dashboard.artifacts.find((entry) => entry.artifact.logicalName === "plot.svg");
  assert.ok(plot);
  assert.equal(plot.kind, "figure");
  assert.equal(plot.versions.length, 2);
  assert.equal(plot.latestVersionId, plot.versions[1]?.id);
  assert.equal(plot.hasParents, true);
  const notes = dashboard.artifacts.find((entry) => entry.artifact.logicalName === "notes.md");
  assert.ok(notes);
  assert.equal(notes.hasParents, false);
});

test("dashboard latestVersionId is undefined for legacy artifact with no versions recorded", async (context) => {
  // Simulates an older artifact row that has no version records attached at all.
  const fixture = await createFixture(context);
  const store = fixture.store;
  const now = new Date().toISOString();
  (store as unknown as { catalog: { artifacts: unknown[]; artifactVersions: unknown[] } }).catalog.artifacts.push({
    createdAt: now,
    createdInSessionId: fixture.session.id,
    createdInSessionTitle: "Dashboard session",
    currentVersion: 0,
    id: "legacy-artifact",
    kind: "markdown",
    logicalName: "legacy.md",
    name: "legacy.md",
    origin: "legacy_auto",
    projectId: fixture.session.projectId,
    sessionId: fixture.session.id,
    updatedAt: now,
  });
  const session = fixture.store.getSession(fixture.session.id);
  const project = fixture.store.getProject(fixture.session.projectId);
  assert.ok(session && project);
  const dashboard = await buildArtifactDashboard(fixture.store, fixture.session.id, project, session);
  const legacy = dashboard.artifacts.find((entry) => entry.artifact.id === "legacy-artifact");
  assert.ok(legacy);
  assert.equal(legacy.versions.length, 0);
  assert.equal(legacy.latestVersionId, undefined);
  assert.equal(legacy.hasParents, false);
});

test("notebook preview stays read-only", async (context) => {
  const fixture = await createFixture(context);
  const ipynb = JSON.stringify({
    cells: [
      { cell_type: "markdown", source: "## Intro" },
      { cell_type: "code", source: "print(1)", execution_count: 1 },
      { cell_type: "raw", source: "raw text" },
    ],
  });
  const vid = await seedArtifact(fixture, {
    content: ipynb,
    kind: "notebook",
    logicalName: "analysis.ipynb",
    mediaType: "application/x-ipynb+json",
  });
  const payload = await buildArtifactVersionPreview(fixture.store, fixture.recorder, fixture.session.id, vid);
  const typed: ArtifactPreviewPayload = payload;
  if (typed.kind !== "notebook" || typed.mode !== "notebook-cells") {
    assert.fail(`unexpected payload shape: ${payload.mode}`);
  }
  assert.equal(typed.editable, false);
  assert.equal(typed.totalCells, 3);
  assert.equal(typed.cells.length, 3);
  assert.equal(typed.cells[0]?.cell_type, "markdown");
  assert.equal(typed.cells[1]?.cell_type, "code");
  assert.equal(typed.cells[1]?.execution_count, 1);
  assert.equal(typed.cells[2]?.cell_type, "raw");
  assert.equal(typed.truncated, false);
});

test("notebook preview truncates to maxCells", async (context) => {
  const fixture = await createFixture(context);
  const cells = Array.from({ length: 5 }, (_, index) => ({ cell_type: "code" as const, source: `print(${index})`, execution_count: index }));
  const ipynb = JSON.stringify({ cells });
  const vid = await seedArtifact(fixture, {
    content: ipynb,
    kind: "notebook",
    logicalName: "analysis.ipynb",
    mediaType: "application/x-ipynb+json",
  });
  const payload = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, vid, undefined, undefined, "2",
  );
  if (payload.mode !== "notebook-cells") assert.fail(`unexpected mode: ${payload.mode}`);
  assert.equal(payload.totalCells, 5);
  assert.equal(payload.cells.length, 2);
  assert.equal(payload.truncated, true);
});

test("markdown preview truncates to maxChars", async (context) => {
  const fixture = await createFixture(context);
  const big = "a".repeat(10_000);
  const vid = await seedArtifact(fixture, {
    content: big,
    kind: "markdown",
    logicalName: "big.md",
    mediaType: "text/markdown",
  });
  const payload = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, vid, undefined, "1000",
  );
  if (payload.mode !== "markdown-source") assert.fail(`unexpected mode: ${payload.mode}`);
  assert.equal(payload.totalChars, 10_000);
  assert.equal(payload.source.length, 1000);
  assert.equal(payload.truncated, true);
});

test("dataset preview parses csv tables and truncates rows", async (context) => {
  const fixture = await createFixture(context);
  const rows = Array.from({ length: 5 }, (_, index) => `row${index},${index}`).join("\n");
  const csv = `name,value\n${rows}`;
  const vid = await seedArtifact(fixture, {
    content: csv,
    kind: "dataset",
    logicalName: "table.csv",
    mediaType: "text/csv",
  });
  const payload = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, vid, "2",
  );
  if (payload.mode !== "dataset-table") assert.fail(`unexpected mode: ${payload.mode}`);
  assert.equal(payload.mediaSubtype, "csv");
  assert.deepEqual(payload.columns, ["name", "value"]);
  assert.equal(payload.totalRows, 5);
  assert.equal(payload.rows.length, 2);
  assert.equal(payload.truncated, true);
});

test("json preview keeps the dataset table for record arrays", async (context) => {
  const fixture = await createFixture(context);
  const vid = await seedArtifact(fixture, {
    content: JSON.stringify([{ a: 1, b: "x" }, { a: 2, b: "y", c: "z" }]),
    kind: "json",
    logicalName: "data.json",
    mediaType: "application/json",
  });
  const payload = await buildArtifactVersionPreview(fixture.store, fixture.recorder, fixture.session.id, vid);
  if (payload.mode !== "dataset-table") assert.fail(`unexpected mode: ${payload.mode}`);
  assert.equal(payload.mediaSubtype, "json");
  assert.deepEqual(payload.columns, ["a", "b", "c"]);
  assert.equal(payload.totalRows, 2);
  assert.equal(payload.rows.length, 2);
  assert.deepEqual(payload.rows[0], ["1", "x", ""]);
});

test("a tabular json preview also carries the formatted source document for the raw view", async (context) => {
  const fixture = await createFixture(context);
  // Nested values survive in rawJson but are flattened to a string in the table
  // cell, so the raw view must not be rebuilt from the rows.
  const vid = await seedArtifact(fixture, {
    content: '[{"id":1,"meta":{"tag":"a"}},{"id":2,"meta":{"tag":"b"}}]',
    kind: "json",
    logicalName: "records.json",
    mediaType: "application/json",
  });
  const payload = await buildArtifactVersionPreview(fixture.store, fixture.recorder, fixture.session.id, vid);
  if (payload.mode !== "dataset-table") assert.fail(`unexpected mode: ${payload.mode}`);
  const raw = payload.rawJson;
  if (!raw) assert.fail("a json-backed table must carry rawJson");
  assert.equal(raw.truncated, false);
  assert.equal(raw.totalChars, raw.source.length);
  // Indented and complete: the nested object is still an object, not a cell string.
  assert.match(raw.source, /^\[\n {2}\{\n {4}"id": 1,\n {4}"meta": \{\n {6}"tag": "a"/);
  assert.deepEqual(JSON.parse(raw.source), [{ id: 1, meta: { tag: "a" } }, { id: 2, meta: { tag: "b" } }]);
});

test("a csv dataset preview carries no rawJson, so no raw-JSON view is offered", async (context) => {
  const fixture = await createFixture(context);
  for (const [name, mediaType, content] of [
    ["table.csv", "text/csv", "name,value\na,1\n"],
    ["table.tsv", "text/tab-separated-values", "name\tvalue\na\t1\n"],
  ] as const) {
    const vid = await seedArtifact(fixture, { content, kind: "dataset", logicalName: name, mediaType });
    const payload = await buildArtifactVersionPreview(fixture.store, fixture.recorder, fixture.session.id, vid);
    if (payload.mode !== "dataset-table") assert.fail(`${name}: unexpected mode ${payload.mode}`);
    assert.equal(payload.rawJson, undefined, `${name} must not offer a raw JSON view`);
  }
});

test("rawJson honours the maxChars budget independently of the row budget", async (context) => {
  const fixture = await createFixture(context);
  const vid = await seedArtifact(fixture, {
    content: JSON.stringify(Array.from({ length: 5 }, (_, index) => ({ index, blob: "x".repeat(200) }))),
    kind: "json",
    logicalName: "wide.json",
    mediaType: "application/json",
  });
  const payload = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, vid, undefined, "120",
  );
  if (payload.mode !== "dataset-table") assert.fail(`unexpected mode: ${payload.mode}`);
  assert.equal(payload.totalRows, 5);
  assert.equal(payload.truncated, false);
  assert.equal(payload.rawJson?.source.length, 120);
  assert.equal(payload.rawJson?.truncated, true);
});

// -- Plain JSON documents must show content, never an empty table --

test("json preview returns formatted JSON for a plain object instead of an empty table", async (context) => {
  const fixture = await createFixture(context);
  const vid = await seedArtifact(fixture, {
    content: '{"name":"af3","sequences":[{"protein":{"id":"A"}}]}',
    kind: "json",
    logicalName: "antibody_pipeline/runs/my_test_1/03_af3_input_json/output_000000_dldesign_0.json",
    mediaType: "application/json",
  });
  const payload = await buildArtifactVersionPreview(fixture.store, fixture.recorder, fixture.session.id, vid);
  if (payload.mode !== "json-source") assert.fail(`unexpected mode: ${payload.mode}`);
  assert.equal(payload.kind, "json");
  assert.equal(payload.parsed, true);
  assert.equal(payload.truncated, false);
  // Re-indented, so the payload is readable rather than a single line.
  assert.match(payload.source, /^\{\n {2}"name": "af3",/);
  assert.equal(payload.totalChars, payload.source.length);
});

test("json preview returns json-source for arrays that are not record arrays", async (context) => {
  const fixture = await createFixture(context);
  for (const [name, content] of [
    ["scalars.json", JSON.stringify([1, 2, 3])],
    ["mixed.json", JSON.stringify([{ a: 1 }, "not-a-record"])],
    ["empty.json", "[]"],
    ["nested.json", JSON.stringify([[1, 2], [3, 4]])],
  ] as const) {
    const vid = await seedArtifact(fixture, { content, kind: "json", logicalName: name, mediaType: "application/json" });
    const payload = await buildArtifactVersionPreview(fixture.store, fixture.recorder, fixture.session.id, vid);
    if (payload.mode !== "json-source") assert.fail(`${name}: unexpected mode ${payload.mode}`);
    assert.equal(payload.parsed, true);
    assert.ok(payload.source.length > 0, `${name} preview must carry content`);
  }
});

test("json preview falls back to the raw text when the document does not parse", async (context) => {
  const fixture = await createFixture(context);
  const vid = await seedArtifact(fixture, {
    content: '{"truncated": tru',
    kind: "json",
    logicalName: "broken.json",
    mediaType: "application/json",
  });
  const payload = await buildArtifactVersionPreview(fixture.store, fixture.recorder, fixture.session.id, vid);
  if (payload.mode !== "json-source") assert.fail(`unexpected mode: ${payload.mode}`);
  assert.equal(payload.parsed, false);
  assert.equal(payload.source, '{"truncated": tru');
});

test("json preview truncates long documents by maxChars", async (context) => {
  const fixture = await createFixture(context);
  const vid = await seedArtifact(fixture, {
    content: JSON.stringify({ blob: "x".repeat(500) }),
    kind: "json",
    logicalName: "big.json",
    mediaType: "application/json",
  });
  const payload = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, vid, undefined, "80",
  );
  if (payload.mode !== "json-source") assert.fail(`unexpected mode: ${payload.mode}`);
  assert.equal(payload.source.length, 80);
  assert.equal(payload.truncated, true);
  assert.ok(payload.totalChars > 80);
});

test("a .json artifact declared as a dataset still shows content when it has no rows", async (context) => {
  const fixture = await createFixture(context);
  const vid = await seedArtifact(fixture, {
    content: '{"config":{"seed":7}}',
    kind: "dataset",
    logicalName: "declared-dataset.json",
    mediaType: "application/json",
  });
  const payload = await buildArtifactVersionPreview(fixture.store, fixture.recorder, fixture.session.id, vid);
  if (payload.mode !== "json-source") assert.fail(`unexpected mode: ${payload.mode}`);
  assert.equal(payload.parsed, true);
  assert.match(payload.source, /"seed": 7/);
});

test("legacy .json catalog entries stored as dataset load as json and accept new versions", async (context) => {
  const fixture = await createFixture(context);
  await seedArtifact(fixture, {
    content: JSON.stringify({ seed: 1 }),
    kind: "dataset",
    logicalName: "legacy.json",
    mediaType: "application/json",
  });
  const reloaded = new SessionStore(fixture.dataDir);
  reloaded.setAvailableSkillIds([]);
  await reloaded.load();
  const migrated = reloaded.listArtifacts(fixture.session.id).find((item) => item.logicalName === "legacy.json");
  assert.equal(migrated?.kind, "json");
  // The "kind cannot change across versions" guard must accept the upgraded kind.
  const next = await reloaded.createArtifactVersion({
    content: await fixture.recorder.cas.put(JSON.stringify({ seed: 2 })),
    kind: "json",
    logicalName: "legacy.json",
    mediaType: "application/json",
    sessionId: fixture.session.id,
  });
  assert.equal(next.version.version, 2);
});

test("dataset preview falls back to binary for parquet without parsing library", async (context) => {
  const fixture = await createFixture(context);
  const vid = await seedArtifact(fixture, {
    content: "PAR1notreallyparquet",
    kind: "dataset",
    logicalName: "binary.parquet",
    mediaType: "application/vnd.apache.parquet",
  });
  const payload = await buildArtifactVersionPreview(fixture.store, fixture.recorder, fixture.session.id, vid);
  if (payload.mode !== "binary-fallback") assert.fail(`unexpected mode: ${payload.mode}`);
  assert.ok(payload.note);
  assert.equal(payload.size, "PAR1notreallyparquet".length);
});

test("structure preview counts PDB ATOM/HETATM records", async (context) => {
  const fixture = await createFixture(context);
  const pdb = [
    "HEADER PROTEIN",
    "ATOM      1  N   ALA A   1      11.000  12.000  13.000  1.00  0.00           N",
    "HETATM    2  O   HOH A   2      21.000  22.000  23.000  1.00  0.00           O",
    "ATOM      3  CA  ALA A   1      31.000  32.000  33.000  1.00  0.00           C",
  ].join("\n");
  const vid = await seedArtifact(fixture, {
    content: pdb,
    kind: "structure",
    logicalName: "protein.pdb",
    mediaType: "chemical/x-pdb",
  });
  const payload = await buildArtifactVersionPreview(fixture.store, fixture.recorder, fixture.session.id, vid);
  if (payload.mode !== "structure-source") assert.fail(`unexpected mode: ${payload.mode}`);
  assert.equal(payload.atomCount, 3);
  assert.equal(payload.source, pdb);
  assert.equal(payload.truncated, false);
});

test("structure preview counts atoms in the .structure.json atom bag", async (context) => {
  const fixture = await createFixture(context);
  const atomBag = JSON.stringify({
    atoms: [
      { element: "C", x: 1, y: 2, z: 3 },
      { element: "O", x: 4, y: 5, z: 6 },
    ],
  });
  const vid = await seedArtifact(fixture, {
    content: atomBag,
    kind: "structure",
    logicalName: "pocket.structure.json",
    mediaType: "application/json",
  });
  const payload = await buildArtifactVersionPreview(fixture.store, fixture.recorder, fixture.session.id, vid);
  if (payload.mode !== "structure-source") assert.fail(`unexpected mode: ${payload.mode}`);
  assert.equal(payload.atomCount, 2);
});

test("figure preview surfaces the content URL without reading CAS bytes", async (context) => {
  const fixture = await createFixture(context);
  const vid = await seedArtifact(fixture, {
    content: "<svg/>",
    kind: "figure",
    logicalName: "image.svg",
    mediaType: "image/svg+xml",
  });
  const payload = await buildArtifactVersionPreview(fixture.store, fixture.recorder, fixture.session.id, vid);
  if (payload.mode !== "figure-url") assert.fail(`unexpected mode: ${payload.mode}`);
  assert.equal(payload.truncated, false);
  assert.ok(payload.contentUrl.endsWith(`/artifact-versions/${vid}/content`));
});

test("report and html previews return sandbox iframe content URLs", async (context) => {
  const fixture = await createFixture(context);
  const pdfVid = await seedArtifact(fixture, {
    content: "%PDF-1.4 stub",
    kind: "report",
    logicalName: "paper.pdf",
    mediaType: "application/pdf",
  });
  const htmlVid = await seedArtifact(fixture, {
    content: "<html><body>hi</body></html>",
    kind: "html",
    logicalName: "dashboard.html",
    mediaType: "text/html",
  });
  const pdfPayload = await buildArtifactVersionPreview(fixture.store, fixture.recorder, fixture.session.id, pdfVid);
  if (pdfPayload.mode !== "report-iframe") assert.fail(`unexpected mode: ${pdfPayload.mode}`);
  assert.ok(pdfPayload.contentUrl.endsWith(`/artifact-versions/${pdfVid}/content`));
  const htmlPayload = await buildArtifactVersionPreview(fixture.store, fixture.recorder, fixture.session.id, htmlVid);
  if (htmlPayload.mode !== "html-iframe") assert.fail(`unexpected mode: ${htmlPayload.mode}`);
  assert.ok(htmlPayload.contentUrl.endsWith(`/artifact-versions/${htmlVid}/content`));
});

test("latex preview returns the raw source so the frontend reuses latexPreview", async (context) => {
  const fixture = await createFixture(context);
  const tex = "\\documentclass{article}\n\\begin{document}\n\\section{Intro}\nbody\n\\end{document}";
  const vid = await seedArtifact(fixture, {
    content: tex,
    kind: "latex",
    logicalName: "manuscript.tex",
    mediaType: "application/x-tex",
  });
  const payload = await buildArtifactVersionPreview(fixture.store, fixture.recorder, fixture.session.id, vid);
  if (payload.mode !== "latex-source") assert.fail(`unexpected mode: ${payload.mode}`);
  assert.equal(payload.source, tex);
  assert.equal(payload.totalChars, tex.length);
  assert.equal(payload.truncated, false);
});

test("preview throws ARTIFACT_NOT_FOUND for unknown version ids", async (context) => {
  const fixture = await createFixture(context);
  await assert.rejects(
    buildArtifactVersionPreview(fixture.store, fixture.recorder, fixture.session.id, "missing-version-id"),
    (error: unknown) => {
      assert.ok(error instanceof ArtifactDashboardError);
      assert.equal((error as ArtifactDashboardError).code, "ARTIFACT_NOT_FOUND");
      return true;
    },
  );
});

test("preview throws ARTIFACT_CONTENT_UNAVAILABLE when the CAS blob is missing", async (context) => {
  const fixture = await createFixture(context);
  // Register an artifact version whose content hash is never persisted to CAS.
  const content = { hash: "a".repeat(64), size: 0 };
  const { version } = await fixture.store.createArtifactVersion({
    content,
    kind: "markdown",
    logicalName: "ghost.md",
    mediaType: "text/markdown",
    sessionId: fixture.session.id,
  });
  await assert.rejects(
    buildArtifactVersionPreview(fixture.store, fixture.recorder, fixture.session.id, version.id),
    (error: unknown) => {
      assert.ok(error instanceof ArtifactDashboardError);
      assert.equal((error as ArtifactDashboardError).code, "ARTIFACT_CONTENT_UNAVAILABLE");
      return true;
    },
  );
});

// -- HTTP-level tests ---------------------------------------------------------

const MEDIA_BY_KIND: Record<ScientificArtifactKind, { content: string; kind: ScientificArtifactKind; logicalName: string; mediaType: string }> = {
  dataset: { content: "value\n1\n", kind: "dataset", logicalName: "input.csv", mediaType: "text/csv" },
  figure: { content: "<svg/>", kind: "figure", logicalName: "image.svg", mediaType: "image/svg+xml" },
  html: { content: "<html><body>hi</body></html>", kind: "html", logicalName: "dash.html", mediaType: "text/html" },
  json: { content: JSON.stringify({ name: "af3" }), kind: "json", logicalName: "af3_input.json", mediaType: "application/json" },
  latex: { content: "\\documentclass{article}\\begin{document}body\\end{document}", kind: "latex", logicalName: "m.tex", mediaType: "application/x-tex" },
  markdown: { content: "# Heading\nbody", kind: "markdown", logicalName: "notes.md", mediaType: "text/markdown" },
  notebook: { content: JSON.stringify({ cells: [{ cell_type: "code", source: "print(1)", execution_count: 1 }] }), kind: "notebook", logicalName: "analysis.ipynb", mediaType: "application/x-ipynb+json" },
  other: { content: "opaque", kind: "other", logicalName: "result.bin", mediaType: "application/octet-stream" },
  report: { content: "%PDF-1.4 stub", kind: "report", logicalName: "paper.pdf", mediaType: "application/pdf" },
  structure: { content: "HEADER PROTEIN\nATOM      1  N   ALA A   1      1.000  2.000  3.000  1.00  0.00           N", kind: "structure", logicalName: "protein.pdb", mediaType: "chemical/x-pdb" },
};

async function startHttpFixture<T>(
  context: TestContext,
  seed?: (fixture: Fixture) => Promise<T>,
): Promise<{
  authorization: string;
  fixture: Fixture;
  origin: string;
  seedResult: T;
}> {
  const fixture = await createFixture(context);
  // Seed before starting the server so its own SessionStore, which loads the
  // catalog from disk during the ready phase, observes the new artifacts.
  const seedResult = seed ? await seed(fixture) : (undefined as unknown as T);
  const config: ServerConfig = {
    authToken: "test-token",
    dataDir: fixture.dataDir,
    gatewayIdleTimeoutMs: 240_000,
    gatewayTurnTimeoutMs: 0,
    host: "127.0.0.1",
    kernelIdleTimeoutMs: 0,
    paperPythonPath: resolve(fixture.dataDir, "paper-python"),
    paperWorkerPath: resolve(fixture.dataDir, "paper-worker.py"),
    permissionWaitTimeoutMs: 0,
    port: 0,
    runnerExecTimeoutMs: 0,
    runnerMaxOutputBytes: 1_000_000,
    runnerMaxWorkspaceBytes: 10_737_418_240,
    runnerToken: "runner-token",
    runnerUrl: "http://127.0.0.1:1",
    sshConfigPath: resolve(fixture.dataDir, "ssh-config"),
    staticDir: resolve(fixture.dataDir, "web"),
    workspaceUpload: {
      maxFileBytes: 1_000_000,
      maxRequestBytes: 10_000_000,
      maxWorkspaceBytes: 10_737_418_240,
    },
    memoryGraph: { url: "http://127.0.0.1:17674", internalToken: "test" },
  };
  const server = createApiServer(config);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
  return {
    authorization: "Bearer test-token",
    fixture,
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seedResult,
  };
}

test("dashboard and preview endpoints reject unauthenticated callers", async (context) => {
  const { fixture, origin } = await startHttpFixture(context);
  const dash = await fetch(`${origin}/api/sessions/${fixture.session.id}/artifact-dashboard`);
  assert.equal(dash.status, 401);
  const preview = await fetch(`${origin}/api/sessions/${fixture.session.id}/artifact-versions/any/preview`);
  assert.equal(preview.status, 401);
  const wrongToken = await fetch(`${origin}/api/sessions/${fixture.session.id}/artifact-dashboard`, {
    headers: { authorization: "Bearer wrong-token" },
  });
  assert.equal(wrongToken.status, 401);
});

test("dashboard endpoint returns 404 for unknown session and 200 with payload for known one", async (context) => {
  const { authorization, fixture, origin } = await startHttpFixture(context, async (fx) => seedArtifact(fx, MEDIA_BY_KIND.markdown));
  const missing = await fetch(`${origin}/api/sessions/unknown-session/artifact-dashboard`, {
    headers: { authorization },
  });
  assert.equal(missing.status, 404);

  const ok = await fetch(`${origin}/api/sessions/${fixture.session.id}/artifact-dashboard`, {
    headers: { authorization },
  });
  assert.equal(ok.status, 200);
  const dashboard = (await ok.json()) as ArtifactDashboard;
  assert.deepEqual(dashboard.context.labels, []);
  assert.equal(dashboard.artifacts.length, 1);
});

test("preview endpoint returns 404 for unknown version and 200 with routed payload", async (context) => {
  const { authorization, fixture, origin, seedResult: markdownVid } = await startHttpFixture(
    context,
    async (fx) => seedArtifact(fx, MEDIA_BY_KIND.markdown),
  );
  const missing = await fetch(`${origin}/api/sessions/${fixture.session.id}/artifact-versions/unknown/preview`, {
    headers: { authorization },
  });
  assert.equal(missing.status, 404);

  const ok = await fetch(`${origin}/api/sessions/${fixture.session.id}/artifact-versions/${markdownVid}/preview`, {
    headers: { authorization },
  });
  assert.equal(ok.status, 200);
  const payload = (await ok.json()) as ArtifactPreviewPayload;
  assert.equal(payload.mode, "markdown-source");
});

test("preview endpoint serves a plain .json artifact as json content, not a dataset table", async (context) => {
  const { authorization, fixture, origin, seedResult: jsonVid } = await startHttpFixture(
    context,
    async (fx) => seedArtifact(fx, MEDIA_BY_KIND.json),
  );
  const dashboard = (await (await fetch(`${origin}/api/sessions/${fixture.session.id}/artifact-dashboard`, {
    headers: { authorization },
  })).json()) as ArtifactDashboard;
  assert.equal(dashboard.artifacts[0]?.kind, "json");

  const ok = await fetch(`${origin}/api/sessions/${fixture.session.id}/artifact-versions/${jsonVid}/preview`, {
    headers: { authorization },
  });
  assert.equal(ok.status, 200);
  const payload = (await ok.json()) as ArtifactPreviewPayload;
  if (payload.mode !== "json-source") assert.fail(`unexpected mode: ${payload.mode}`);
  assert.equal(payload.kind, "json");
  assert.match(payload.source, /"name": "af3"/);
});

test("preview endpoint cross-session access returns 404", async (context) => {
  const { authorization, fixture, origin, seedResult: markdownVid } = await startHttpFixture(
    context,
    async (fx) => seedArtifact(fx, MEDIA_BY_KIND.markdown),
  );
  const otherProject = await fixture.store.createProject("Other");
  const otherModel = await fixture.store.createModel({
    apiToken: "test",
    baseUrl: "https://models.example.test/v1",
    model: "test",
    name: "Test",
  });
  const otherSession = await fixture.store.createSession(otherProject.id, "Other", { modelId: otherModel.id });
  const cross = await fetch(`${origin}/api/sessions/${otherSession.id}/artifact-versions/${markdownVid}/preview`, {
    headers: { authorization },
  });
  assert.equal(cross.status, 404);
});

test("preview endpoint returns 422 when the CAS blob is missing", async (context) => {
  const { authorization, fixture, origin, seedResult: ghostVid } = await startHttpFixture(
    context,
    async (fx) => {
      const { version } = await fx.store.createArtifactVersion({
        content: { hash: "b".repeat(64), size: 0 },
        kind: "markdown",
        logicalName: "ghost.md",
        mediaType: "text/markdown",
        sessionId: fx.session.id,
      });
      return version.id;
    },
  );
  const response = await fetch(`${origin}/api/sessions/${fixture.session.id}/artifact-versions/${ghostVid}/preview`, {
    headers: { authorization },
  });
  assert.equal(response.status, 422);
});
