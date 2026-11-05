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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { TestContext } from "node:test";


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
import { offlineMcpTransport } from "./mcp/offline-transport.fixture.js";
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

test("notebook preview fills maxCells with valid cells after skipping unsupported cell types", async (context) => {
  const fixture = await createFixture(context);
  const ipynb = JSON.stringify({
    cells: [
      { cell_type: "heading", source: "# not a supported cell" },
      { cell_type: "code", source: "print(1)", execution_count: 1 },
      { cell_type: "code", source: "print(2)", execution_count: 2 },
    ],
  });
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
  assert.equal(payload.totalCells, 3);
  assert.equal(payload.cells.length, 2, "unsupported cells must not consume the maxCells budget");
  assert.deepEqual(payload.cells.map((cell) => cell.cell_type), ["code", "code"]);
  assert.equal(payload.truncated, false, "dropping an unsupported cell is not truncation");
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

test("dataset preview parses quoted csv cells", async (context) => {
  const fixture = await createFixture(context);
  // RFC 4180: a comma inside quotes and a doubled quote are data, not syntax.
  const csv = 'name,note\nAlice,"hello, world"\nBob,"say ""hi"""';
  const vid = await seedArtifact(fixture, {
    content: csv,
    kind: "dataset",
    logicalName: "table.csv",
    mediaType: "text/csv",
  });
  const payload = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, vid, "10",
  );
  if (payload.mode !== "dataset-table") assert.fail(`unexpected mode: ${payload.mode}`);
  assert.deepEqual(payload.columns, ["name", "note"]);
  assert.equal(payload.totalRows, 2);
  assert.deepEqual(payload.rows[0], ["Alice", "hello, world"]);
  assert.deepEqual(payload.rows[1], ["Bob", 'say "hi"']);
});

test("dataset preview keeps an unclosed quote as one field", async (context) => {
  const fixture = await createFixture(context);
  // One opening quote and no closing one makes the entire file a single cell.
  // The content stays small so this test pins the parsed result, not its cost:
  // such a file must still preview as one honest column and no rows.
  const body = `${"x".repeat(64 * 1024)},tail\n`;
  const vid = await seedArtifact(fixture, {
    content: `"${body}`,
    kind: "dataset",
    logicalName: "unclosed.csv",
    mediaType: "text/csv",
  });
  const payload = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, vid, "10",
  );
  if (payload.mode !== "dataset-table") assert.fail(`unexpected mode: ${payload.mode}`);
  assert.equal(payload.columns.length, 1);
  assert.equal(payload.columns[0], body);
  assert.equal(payload.rows.length, 0);
  assert.equal(payload.totalRows, 0);
  assert.equal(payload.truncated, false);
});

test("a csv dataset preview strips the UTF-8 BOM from the first header cell", async (context) => {
  const fixture = await createFixture(context);
  // What Excel writes for "CSV UTF-8": the marker precedes the first header.
  const vid = await seedArtifact(fixture, {
    content: "\uFEFFname,note\nAlice,1\n",
    kind: "dataset",
    logicalName: "bom.csv",
    mediaType: "text/csv",
  });
  const payload = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, vid,
  );
  if (payload.mode !== "dataset-table") assert.fail(`unexpected mode: ${payload.mode}`);
  assert.deepEqual(payload.columns, ["name", "note"]);
  assert.equal(payload.totalRows, 1);
  assert.deepEqual(payload.rows[0], ["Alice", "1"]);
});

test("a csv dataset preview strips the BOM before a quoted header, so the quote still opens the cell", async (context) => {
  const fixture = await createFixture(context);
  // Excel's marker sits in front of the opening quote, not inside the cell: once
  // the marker is gone the quote is back at the start of the record and must
  // still open a field. Otherwise the header arrives as the literal `"name"`,
  // quotes included, and the column disappears for name-based clients.
  const vid = await seedArtifact(fixture, {
    content: "\uFEFF\"name\",note\nAlice,1\n",
    kind: "dataset",
    logicalName: "bom-quoted.csv",
    mediaType: "text/csv",
  });
  const payload = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, vid,
  );
  if (payload.mode !== "dataset-table") assert.fail(`unexpected mode: ${payload.mode}`);
  assert.deepEqual(payload.columns, ["name", "note"]);
  assert.equal(payload.totalRows, 1);
  assert.deepEqual(payload.rows[0], ["Alice", "1"]);
});

test("a tsv dataset preview strips the UTF-8 BOM from the first header cell", async (context) => {
  const fixture = await createFixture(context);
  const vid = await seedArtifact(fixture, {
    content: "\uFEFFname\tnote\nAlice\t1\n",
    kind: "dataset",
    logicalName: "bom.tsv",
    mediaType: "text/tab-separated-values",
  });
  const payload = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, vid,
  );
  if (payload.mode !== "dataset-table") assert.fail(`unexpected mode: ${payload.mode}`);
  assert.deepEqual(payload.columns, ["name", "note"]);
  assert.deepEqual(payload.rows[0], ["Alice", "1"]);
});

test("a dataset preview without a BOM keeps every header cell unchanged", async (context) => {
  const fixture = await createFixture(context);
  for (const [logicalName, mediaType, content, columns] of [
    ["plain.csv", "text/csv", "name,note\nAlice,1\n", ["name", "note"]],
    ["plain.tsv", "text/tab-separated-values", "name\tnote\nAlice\t1\n", ["name", "note"]],
  ] as const) {
    const vid = await seedArtifact(fixture, { content, kind: "dataset", logicalName, mediaType });
    const payload = await buildArtifactVersionPreview(
      fixture.store, fixture.recorder, fixture.session.id, vid,
    );
    if (payload.mode !== "dataset-table") assert.fail(`unexpected mode: ${payload.mode}`);
    assert.deepEqual(payload.columns, [...columns]);
  }
});

test("a dataset preview keeps a BOM that starts a data row, because only the file prefix is a marker", async (context) => {
  const fixture = await createFixture(context);
  // Only the leading marker is encoding metadata; the same code point inside the
  // document is a character the cell really contains, so it must survive.
  const vid = await seedArtifact(fixture, {
    content: "\uFEFFname,note\n\uFEFFAlice,1\n",
    kind: "dataset",
    logicalName: "bom-row.csv",
    mediaType: "text/csv",
  });
  const payload = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, vid,
  );
  if (payload.mode !== "dataset-table") assert.fail(`unexpected mode: ${payload.mode}`);
  assert.deepEqual(payload.columns, ["name", "note"]);
  assert.deepEqual(payload.rows[0], ["\uFEFFAlice", "1"]);
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

test("a json artifact of empty objects renders as JSON text, not an empty grid", async (context) => {
  const fixture = await createFixture(context);
  for (const [name, records] of [
    ["empty-two.json", [{}, {}]],
    ["empty-one.json", [{}]],
  ] as const) {
    const vid = await seedArtifact(fixture, {
      content: JSON.stringify(records),
      kind: "json",
      logicalName: name,
      mediaType: "application/json",
    });
    const payload = await buildArtifactVersionPreview(fixture.store, fixture.recorder, fixture.session.id, vid);
    if (payload.mode !== "json-source") assert.fail(`${name}: unexpected mode ${payload.mode}`);
    assert.equal(payload.parsed, true);
    assert.equal(payload.source, JSON.stringify(records, null, 2));
    assert.equal(payload.totalChars, payload.source.length);
    assert.equal(payload.truncated, false);
  }
});

// -- A leading UTF-8 BOM is an encoding marker in JSON too -------------------

test("a JSON document saved with a UTF-8 BOM still previews as a table", async (context) => {
  const fixture = await createFixture(context);
  // Excel and several exporters write a byte-order mark in front of the payload.
  // The delimited path strips exactly one leading U+FEFF as an encoding marker
  // (splitDelimited), so a JSON document must be read under the same rule before
  // JSON.parse: otherwise a valid document is reported as unparseable text.
  const bom = "\uFEFF";
  const shape = (payload: { mode: string; parsed?: boolean }): string =>
    `BOM-JSON ${JSON.stringify({ mode: payload.mode, parsed: payload.parsed })}`;

  const records = [
    { name: "af3", value: 1 },
    { name: "af3b", value: 2 },
  ];
  const tableVersion = await seedArtifact(fixture, {
    content: bom + JSON.stringify(records),
    kind: "json",
    logicalName: "bom-records.json",
    mediaType: "application/json",
  });
  const table = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, tableVersion,
  );
  if (table.mode !== "dataset-table") assert.fail(shape(table));
  assert.deepEqual(table.columns, ["name", "value"]);
  assert.deepEqual(table.rows, [["af3", "1"], ["af3b", "2"]]);

  const scalarVersion = await seedArtifact(fixture, {
    content: `${bom}{"name":"af3"}`,
    kind: "json",
    logicalName: "bom-scalar.json",
    mediaType: "application/json",
  });
  const scalar = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, scalarVersion,
  );
  if (scalar.mode !== "json-source") assert.fail(shape(scalar));
  assert.equal(scalar.parsed, true, "a leading U+FEFF is an encoding marker, not part of the document");
  assert.equal(scalar.source, JSON.stringify({ name: "af3" }, null, 2));
  assert.equal(scalar.totalChars, scalar.source.length);

  // Only the leading marker is syntax: a U+FEFF inside a string is ordinary data.
  const interiorVersion = await seedArtifact(fixture, {
    content: `${bom}${JSON.stringify({ note: "A\uFEFFB" })}`,
    kind: "json",
    logicalName: "bom-interior.json",
    mediaType: "application/json",
  });
  const interior = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, interiorVersion,
  );
  if (interior.mode !== "json-source") assert.fail(shape(interior));
  assert.equal(interior.parsed, true);
  assert.ok(interior.source.includes("A\uFEFFB"), "a U+FEFF inside a string must survive the strip");
});

test("json preview keeps the table when record arrays carry keys", async (context) => {
  const fixture = await createFixture(context);
  const vid = await seedArtifact(fixture, {
    content: JSON.stringify([{ a: 1 }, { a: 2 }]),
    kind: "json",
    logicalName: "rows.json",
    mediaType: "application/json",
  });
  const payload = await buildArtifactVersionPreview(fixture.store, fixture.recorder, fixture.session.id, vid);
  if (payload.mode !== "dataset-table") assert.fail(`unexpected mode: ${payload.mode}`);
  assert.deepEqual(payload.columns, ["a"]);
  assert.deepEqual(payload.rows, [["1"], ["2"]]);
  assert.equal(payload.totalRows, 2);
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

test("structure preview does not claim truncation when the whole source is returned", async (context) => {
  const fixture = await createFixture(context);
  const pdb = Array.from({ length: 9_000 }, (_, index) => `ATOM  ${String(index + 1).padStart(5)}  C   ALA A   1`).join("\n");
  const vid = await seedArtifact(fixture, {
    content: pdb,
    kind: "structure",
    logicalName: "many.pdb",
    mediaType: "chemical/x-pdb",
  });
  const payload = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, vid, undefined, "1000000",
  );
  if (payload.mode !== "structure-source") assert.fail(`unexpected mode: ${payload.mode}`);
  assert.equal(payload.atomCount, 9_000);
  assert.equal(payload.source.length, pdb.length);
  assert.equal(payload.truncated, false);
});

test("structure preview reports truncation when maxChars cuts the source", async (context) => {
  const fixture = await createFixture(context);
  const pdb = Array.from({ length: 200 }, (_, index) => `ATOM  ${String(index + 1).padStart(5)}  C   ALA A   1`).join("\n");
  const vid = await seedArtifact(fixture, {
    content: pdb,
    kind: "structure",
    logicalName: "long.pdb",
    mediaType: "chemical/x-pdb",
  });
  const payload = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, vid, undefined, "400",
  );
  if (payload.mode !== "structure-source") assert.fail(`unexpected mode: ${payload.mode}`);
  assert.equal(payload.truncated, true);
  assert.equal(payload.source.length, 400);
  assert.equal(payload.totalChars, pdb.length);
  assert.equal(payload.source, pdb.slice(0, 400));
});

test("structure preview at exactly maxChars returns the whole source without truncation", async (context) => {
  const fixture = await createFixture(context);
  const source = `HEADER ${"X".repeat(93)}`;
  assert.equal(source.length, 100);
  const vid = await seedArtifact(fixture, {
    content: source,
    kind: "structure",
    logicalName: "boundary.pdb",
    mediaType: "chemical/x-pdb",
  });
  const payload = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, vid, undefined, "100",
  );
  if (payload.mode !== "structure-source") assert.fail(`unexpected mode: ${payload.mode}`);
  assert.equal(payload.truncated, false);
  assert.equal(payload.source, source);
});

// A cut inside a surrogate pair leaves invalid UTF-16 in the payload; every
// truncating preview path must cut at a code point boundary instead.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const SPLIT_AT_LIMIT = `${"a".repeat(9)}\u{1F600}tail`;

function assertCodePointCut(source: string): void {
  assert.equal(LONE_SURROGATE.test(source), false, `source carries a lone surrogate: ${JSON.stringify(source)}`);
  // Either the whole character is kept or it is dropped; never half of it.
  assert.ok([`${"a".repeat(9)}`, `${"a".repeat(9)}\u{1F600}`].includes(source), `unexpected cut: ${JSON.stringify(source)}`);
}

test("markdown preview truncation never splits a surrogate pair", async (context) => {
  const fixture = await createFixture(context);
  const vid = await seedArtifact(fixture, {
    content: SPLIT_AT_LIMIT,
    kind: "markdown",
    logicalName: "notes.md",
    mediaType: "text/markdown",
  });
  const payload = await buildArtifactVersionPreview(fixture.store, fixture.recorder, fixture.session.id, vid, undefined, "10");
  if (payload.mode !== "markdown-source") assert.fail(`unexpected mode: ${payload.mode}`);
  assertCodePointCut(payload.source);
  assert.equal(payload.totalChars, SPLIT_AT_LIMIT.length);
  assert.equal(payload.truncated, true);
});

test("latex preview truncation never splits a surrogate pair", async (context) => {
  const fixture = await createFixture(context);
  const vid = await seedArtifact(fixture, {
    content: SPLIT_AT_LIMIT,
    kind: "latex",
    logicalName: "paper.tex",
    mediaType: "application/x-tex",
  });
  const payload = await buildArtifactVersionPreview(fixture.store, fixture.recorder, fixture.session.id, vid, undefined, "10");
  if (payload.mode !== "latex-source") assert.fail(`unexpected mode: ${payload.mode}`);
  assertCodePointCut(payload.source);
  assert.equal(payload.totalChars, SPLIT_AT_LIMIT.length);
  assert.equal(payload.truncated, true);
});

test("structure preview truncation never splits a surrogate pair", async (context) => {
  const fixture = await createFixture(context);
  const vid = await seedArtifact(fixture, {
    content: SPLIT_AT_LIMIT,
    kind: "structure",
    logicalName: "protein.pdb",
    mediaType: "chemical/x-pdb",
  });
  const payload = await buildArtifactVersionPreview(fixture.store, fixture.recorder, fixture.session.id, vid, undefined, "10");
  if (payload.mode !== "structure-source") assert.fail(`unexpected mode: ${payload.mode}`);
  assertCodePointCut(payload.source);
  assert.equal(payload.totalChars, SPLIT_AT_LIMIT.length);
  assert.equal(payload.truncated, true);
});

test("json-source preview truncation never splits a surrogate pair", async (context) => {
  const fixture = await createFixture(context);
  const vid = await seedArtifact(fixture, {
    content: SPLIT_AT_LIMIT,
    kind: "json",
    logicalName: "notes.json",
    mediaType: "application/json",
  });
  const payload = await buildArtifactVersionPreview(fixture.store, fixture.recorder, fixture.session.id, vid, undefined, "10");
  if (payload.mode !== "json-source") assert.fail(`unexpected mode: ${payload.mode}`);
  assertCodePointCut(payload.source);
  assert.equal(payload.totalChars, SPLIT_AT_LIMIT.length);
  assert.equal(payload.truncated, true);
});

test("an ascii markdown preview still cuts at exactly maxChars", async (context) => {
  const fixture = await createFixture(context);
  const ascii = "x".repeat(20);
  const vid = await seedArtifact(fixture, {
    content: ascii,
    kind: "markdown",
    logicalName: "plain.md",
    mediaType: "text/markdown",
  });
  const payload = await buildArtifactVersionPreview(fixture.store, fixture.recorder, fixture.session.id, vid, undefined, "10");
  if (payload.mode !== "markdown-source") assert.fail(`unexpected mode: ${payload.mode}`);
  assert.equal(payload.source, "x".repeat(10));
  assert.equal(payload.totalChars, 20);
  assert.equal(payload.truncated, true);
});

// The budget is counted in UTF-16 units, so maxChars 1 or 2 cannot hold a first
// character that is a surrogate pair. These are the only budgets where the cut
// removes a whole unit instead of measuring a boundary, and they are the first
// thing a simplification of `splitsPair` would break: `charCodeAt(maxChars) >=
// 0xdc00` would leave half a pair or read out of bounds here while every
// existing case (all maxChars = 10) stayed green. maxChars = 0 never reaches
// the cut (parsePositiveInt requires > 0), so 1 is the degenerate boundary.
for (const [maxChars, expected] of [["1", ""], ["2", "😀"]] as const) {
  test(`a markdown preview with maxChars=${maxChars} drops a straddling emoji whole`, async (context) => {
    const fixture = await createFixture(context);
    const vid = await seedArtifact(fixture, {
      content: "😀abcdef",
      kind: "markdown",
      logicalName: "emoji.md",
      mediaType: "text/markdown",
    });
    const payload = await buildArtifactVersionPreview(fixture.store, fixture.recorder, fixture.session.id, vid, undefined, maxChars);
    if (payload.mode !== "markdown-source") assert.fail(`unexpected mode: ${payload.mode}`);
    assert.equal(payload.source, expected);
    assert.equal(payload.source.length, expected.length, "a surviving emoji keeps both of its units");
    assert.equal(payload.totalChars, 8);
    assert.equal(payload.truncated, true);
  });
}

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
    // No packaging snapshot in tests: the catalog stays empty unless a test installs one.
    modelCatalogPath: resolve(fixture.dataDir, "model-catalog/absent.json"),
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
    evolve: { url: "http://127.0.0.1:4313", internalToken: "test" },
  };
  const server = createApiServer(config, { mcpTransport: offlineMcpTransport });
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

// -- Integers beyond 2^53 keep the digits that are stored -------------------

test("json preview shows integers beyond 2^53 without rounding them", async (context) => {
  const fixture = await createFixture(context);
  // JSON.parse turns 9007199254740993 into 9007199254740992: the preview must
  // display what the document says, not what a double can hold.
  const tableVersion = await seedArtifact(fixture, {
    content: '[{"sample_id":9007199254740993,"label":"x"}]',
    kind: "json",
    logicalName: "samples.json",
    mediaType: "application/json",
  });
  const table = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, tableVersion,
  );
  if (table.mode !== "dataset-table") assert.fail(`unexpected mode: ${table.mode}`);
  assert.deepEqual(table.columns, ["sample_id", "label"]);
  assert.deepEqual(table.rows, [["9007199254740993", "x"]], "the cell must keep the stored digits");
  if (!table.rawJson) assert.fail("a json-backed table must carry rawJson");
  assert.ok(
    table.rawJson.source.includes("9007199254740993"),
    `rawJson must keep the stored digits: ${table.rawJson.source}`,
  );

  // A document that is not a record array goes to the source view, same rule.
  const scalarVersion = await seedArtifact(fixture, {
    content: '{"run_id":12345678901234567890}',
    kind: "json",
    logicalName: "run.json",
    mediaType: "application/json",
  });
  const scalar = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, scalarVersion,
  );
  if (scalar.mode !== "json-source") assert.fail(`unexpected mode: ${scalar.mode}`);
  assert.equal(scalar.parsed, true);
  assert.ok(
    scalar.source.includes("12345678901234567890"),
    `the source view must keep the stored digits: ${scalar.source}`,
  );
});

test("json preview leaves safe numbers, strings and nested values unchanged", async (context) => {
  const fixture = await createFixture(context);
  const safeVersion = await seedArtifact(fixture, {
    content: JSON.stringify([{ n: 42, text: "9007199254740993" }]),
    kind: "json",
    logicalName: "safe.json",
    mediaType: "application/json",
  });
  const safe = await buildArtifactVersionPreview(fixture.store, fixture.recorder, fixture.session.id, safeVersion);
  if (safe.mode !== "dataset-table") assert.fail(`unexpected mode: ${safe.mode}`);
  assert.deepEqual(safe.rows, [["42", "9007199254740993"]], "a safe number and a string that looks like one stay put");

  const nested = { config: { seed: 7, tags: ["a", "b"] }, ratio: 0.5 };
  const nestedVersion = await seedArtifact(fixture, {
    content: JSON.stringify(nested),
    kind: "json",
    logicalName: "nested.json",
    mediaType: "application/json",
  });
  const nestedPreview = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, nestedVersion,
  );
  if (nestedPreview.mode !== "json-source") assert.fail(`unexpected mode: ${nestedPreview.mode}`);
  assert.equal(nestedPreview.parsed, true);
  assert.equal(nestedPreview.source, JSON.stringify(nested, null, 2));
});

test("json preview keeps big integers as numbers in the raw and source views", async (context) => {
  const fixture = await createFixture(context);
  // JSON.stringify writes a placeholder back as a quoted string, so restoring
  // only the bare shape would hand the client "9007199254740993" (a string)
  // where the document holds 9007199254740993 (a number).
  const tableVersion = await seedArtifact(fixture, {
    content: '[{"sample_id":9007199254740993,"label":"x"}]',
    kind: "json",
    logicalName: "samples.json",
    mediaType: "application/json",
  });
  const table = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, tableVersion,
  );
  if (table.mode !== "dataset-table") assert.fail(`unexpected mode: ${table.mode}`);
  assert.deepEqual(table.rows, [["9007199254740993", "x"]], "the cell keeps the stored digits");
  if (!table.rawJson) assert.fail("a json-backed table must carry rawJson");
  assert.match(
    table.rawJson.source,
    /"sample_id": 9007199254740993/,
    `rawJson must hold the number, not a string: ${table.rawJson.source}`,
  );
  assert.ok(
    !table.rawJson.source.includes('"9007199254740993"'),
    `rawJson must not quote the stored digits: ${table.rawJson.source}`,
  );
  // Compare the digit string itself: JSON.parse rounds both sides the same way,
  // so only the text proves that the precise digits are the stored ones.
  assert.equal(
    /"sample_id":\s*(\d+)/.exec(table.rawJson.source)?.[1],
    "9007199254740993",
    `rawJson must carry the stored digit string: ${table.rawJson.source}`,
  );

  const objectVersion = await seedArtifact(fixture, {
    content: '{"run_id":12345678901234567890}',
    kind: "json",
    logicalName: "run.json",
    mediaType: "application/json",
  });
  const objectPreview = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, objectVersion,
  );
  if (objectPreview.mode !== "json-source") assert.fail(`unexpected mode: ${objectPreview.mode}`);
  assert.equal(objectPreview.parsed, true);
  assert.match(
    objectPreview.source,
    /"run_id": 12345678901234567890/,
    `the source view must hold the number, not a string: ${objectPreview.source}`,
  );
  assert.ok(
    !objectPreview.source.includes('"12345678901234567890"'),
    `the source view must not quote the stored digits: ${objectPreview.source}`,
  );
  assert.equal(
    /"run_id":\s*(\d+)/.exec(objectPreview.source)?.[1],
    "12345678901234567890",
    `the source view must carry the stored digit string: ${objectPreview.source}`,
  );

  // A scalar document has no surrounding syntax: the view is just the digits.
  const bareVersion = await seedArtifact(fixture, {
    content: "9007199254740993",
    kind: "json",
    logicalName: "scalar.json",
    mediaType: "application/json",
  });
  const bare = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, bareVersion,
  );
  if (bare.mode !== "json-source") assert.fail(`unexpected mode: ${bare.mode}`);
  assert.equal(bare.source, "9007199254740993", "a bare scalar must stay a bare number");
  assert.equal(
    /^(\d+)$/.exec(bare.source)?.[1],
    "9007199254740993",
    `a bare scalar is exactly the stored digits: ${bare.source}`,
  );

  const scalarArrayVersion = await seedArtifact(fixture, {
    content: "[9007199254740993]",
    kind: "json",
    logicalName: "scalar-array.json",
    mediaType: "application/json",
  });
  const scalarArray = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, scalarArrayVersion,
  );
  if (scalarArray.mode !== "json-source") assert.fail(`unexpected mode: ${scalarArray.mode}`);
  assert.equal(scalarArray.source, "[\n  9007199254740993\n]", "an array of one big integer stays numeric");
  assert.equal(
    /\[\s*(\d+)\s*\]/.exec(scalarArray.source)?.[1],
    "9007199254740993",
    `an array element is exactly the stored digits: ${scalarArray.source}`,
  );
});

test("json preview leaves user text that spells an old placeholder untouched", async (context) => {
  const fixture = await createFixture(context);
  // `sd-bigint:` was an internal detail of an earlier revision; as far as a
  // document is concerned it is ordinary text and must survive verbatim.
  const textOnly = await seedArtifact(fixture, {
    content: '{"note":"sd-bigint:9007199254740993"}',
    kind: "json",
    logicalName: "note.json",
    mediaType: "application/json",
  });
  const noteOnly = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, textOnly,
  );
  if (noteOnly.mode !== "json-source") assert.fail(`unexpected mode: ${noteOnly.mode}`);
  assert.match(
    noteOnly.source,
    /"note": "sd-bigint:9007199254740993"/,
    `a note that spells the old prefix must not be rewritten: ${noteOnly.source}`,
  );

  // The same document beside a real big integer: restoring the number must not
  // reach into the neighbouring string.
  const mixed = await seedArtifact(fixture, {
    content: '{"note":"sd-bigint:9007199254740993","id":9007199254740993}',
    kind: "json",
    logicalName: "mixed.json",
    mediaType: "application/json",
  });
  const mixedPreview = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, mixed,
  );
  if (mixedPreview.mode !== "json-source") assert.fail(`unexpected mode: ${mixedPreview.mode}`);
  assert.match(
    mixedPreview.source,
    /"note": "sd-bigint:9007199254740993"/,
    `the note must keep every character: ${mixedPreview.source}`,
  );
  assert.match(
    mixedPreview.source,
    /"id": 9007199254740993/,
    `the id must still be restored: ${mixedPreview.source}`,
  );

  // A document that writes the marker shape itself, with a token this call did
  // not mint, is still ordinary text.
  const fabricatedContent = '{"note":"\\u0001sd-bigint-00000000-0000-0000-0000-000000000000:0","id":9007199254740993}';
  const fabricatedVersion = await seedArtifact(fixture, {
    content: fabricatedContent,
    kind: "json",
    logicalName: "fabricated.json",
    mediaType: "application/json",
  });
  const fabricated = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, fabricatedVersion,
  );
  if (fabricated.mode !== "json-source") assert.fail(`unexpected mode: ${fabricated.mode}`);
  const fabricatedShown = JSON.parse(fabricated.source) as { id: number; note: string };
  const fabricatedStored = JSON.parse(fabricatedContent) as { id: number; note: string };
  assert.equal(fabricatedShown.note, fabricatedStored.note, "a token the call never minted must survive verbatim");
  assert.match(fabricated.source, /"id": 9007199254740993/, `the real big integer is still restored: ${fabricated.source}`);
});

test("json preview round-trips a big integer document through JSON.parse", async (context) => {
  const fixture = await createFixture(context);
  // Parsing both sides pins the type of every value: digits rendered as a JSON
  // string would compare as a string here, while the digits themselves survive
  // the same double rounding on both sides.
  const recordSource = '[{"sample_id":9007199254740993,"label":"x"}]';
  const recordVersion = await seedArtifact(fixture, {
    content: recordSource,
    kind: "json",
    logicalName: "round-trip.json",
    mediaType: "application/json",
  });
  const record = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, recordVersion,
  );
  if (record.mode !== "dataset-table") assert.fail(`unexpected mode: ${record.mode}`);
  if (!record.rawJson) assert.fail("a json-backed table must carry rawJson");
  assert.deepEqual(
    JSON.parse(record.rawJson.source),
    JSON.parse(recordSource),
    `rawJson must parse back to the stored document: ${record.rawJson.source}`,
  );

  const objectSource = '{"run_id":12345678901234567890,"nested":{"id":9007199254740993}}';
  const objectVersion = await seedArtifact(fixture, {
    content: objectSource,
    kind: "json",
    logicalName: "round-trip-object.json",
    mediaType: "application/json",
  });
  const object = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, objectVersion,
  );
  if (object.mode !== "json-source") assert.fail(`unexpected mode: ${object.mode}`);
  assert.deepEqual(
    JSON.parse(object.source),
    JSON.parse(objectSource),
    `the source view must parse back to the stored document: ${object.source}`,
  );

  const scalarSource = "9007199254740993";
  const scalarVersion = await seedArtifact(fixture, {
    content: scalarSource,
    kind: "json",
    logicalName: "round-trip-scalar.json",
    mediaType: "application/json",
  });
  const scalar = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, scalarVersion,
  );
  if (scalar.mode !== "json-source") assert.fail(`unexpected mode: ${scalar.mode}`);
  assert.deepEqual(JSON.parse(scalar.source), JSON.parse(scalarSource), "a bare scalar parses back as a number");
});

test("big integer placeholders are generated per document and are not the old prefix", async () => {
  // The placeholder must be unpredictable: text a user wrote cannot be mistaken
  // for a protected number, and two documents can never share one.
  const dashboard = await import("./artifact-dashboard.js") as unknown as {
    createBigIntegerMarker?: () => string;
  };
  assert.equal(
    typeof dashboard.createBigIntegerMarker,
    "function",
    "artifact-dashboard must export createBigIntegerMarker so the contract is testable",
  );
  const first = dashboard.createBigIntegerMarker?.() ?? "";
  const second = dashboard.createBigIntegerMarker?.() ?? "";
  assert.notEqual(first, second, "each document must get its own placeholder");
  assert.ok(!first.startsWith("sd-bigint:"), `the marker must not be the retired constant: ${first}`);
  assert.ok(first.includes("\u0001"), `the marker must carry the U+0001 prefix: ${JSON.stringify(first)}`);
});

test("json preview keeps placeholders for many big integers apart", async (context) => {
  const fixture = await createFixture(context);
  // Twelve distinct literals make the placeholder counters share prefixes
  // (1, 10, 11, 12): restoring one placeholder must never eat another.
  const literals = Array.from({ length: 12 }, (_, index) => `900719925474${993 + index}`);
  const source = `[${literals.map((value) => `{"id":${value}}`).join(",")}]`;
  const version = await seedArtifact(fixture, {
    content: source,
    kind: "json",
    logicalName: "many.json",
    mediaType: "application/json",
  });
  const preview = await buildArtifactVersionPreview(fixture.store, fixture.recorder, fixture.session.id, version);
  if (preview.mode !== "dataset-table") assert.fail(`unexpected mode: ${preview.mode}`);
  assert.deepEqual(preview.rows, literals.map((value) => [value]), "every cell keeps its own digits");
  if (!preview.rawJson) assert.fail("a json-backed table must carry rawJson");
  for (const value of literals) {
    assert.match(
      preview.rawJson.source,
      new RegExp(`"id": ${value}`),
      `rawJson must keep ${value} as a number: ${preview.rawJson.source}`,
    );
  }
  assert.deepEqual(
    JSON.parse(preview.rawJson.source),
    JSON.parse(source),
    `rawJson must parse back to the stored document: ${preview.rawJson.source}`,
  );
});

test("a delimited preview keeps every row as wide as the columns it advertises", async (context) => {
  const fixture = await createFixture(context);
  // An uneven file used to ship rows of their own width: the renderer prints one
  // <th> per column and one <td> per cell, so a short row left cells under the
  // wrong header and an extra cell had no header at all.
  for (const [name, mediaType, content, columns, rows] of [
    ["short.csv", "text/csv", "a,b,c\n1,2\n", ["a", "b", "c"], [["1", "2", ""]]],
    ["long.csv", "text/csv", "a,b\n1,2,3\n", ["a", "b", ""], [["1", "2", "3"]]],
    ["short.tsv", "text/tab-separated-values", "a\tb\tc\n1\t2\n", ["a", "b", "c"], [["1", "2", ""]]],
    ["long.tsv", "text/tab-separated-values", "a\tb\n1\t2\t3\n", ["a", "b", ""], [["1", "2", "3"]]],
  ] as const) {
    const vid = await seedArtifact(fixture, { content, kind: "dataset", logicalName: name, mediaType });
    const payload = await buildArtifactVersionPreview(
      fixture.store, fixture.recorder, fixture.session.id, vid,
    );
    if (payload.mode !== "dataset-table") assert.fail(`${name}: unexpected mode ${payload.mode}`);
    assert.deepEqual(payload.columns, [...columns], `${name}: header text keeps its order, an extra column is blank`);
    assert.deepEqual(
      payload.rows,
      rows.map((row) => [...row]),
      `${name}: rows are padded or carried over, never dropped`,
    );
    assert.ok(
      payload.rows.every((row) => row.length === payload.columns.length),
      `${name}: every row must match the advertised width`,
    );
    assert.equal(payload.totalRows, 1, `${name}: totalRows must not change`);
    assert.equal(payload.truncated, false, `${name}: truncated must not change`);
  }

  // A quoted cell that contains the delimiter is parsed by the field splitter,
  // not by the width rule, and stays exactly as wide as the header.
  const quoted = await seedArtifact(fixture, {
    content: 'a,b\n"x,y",2\n',
    kind: "dataset",
    logicalName: "quoted.csv",
    mediaType: "text/csv",
  });
  const quotedPayload = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, quoted,
  );
  if (quotedPayload.mode !== "dataset-table") assert.fail(`unexpected mode: ${quotedPayload.mode}`);
  assert.deepEqual(quotedPayload.columns, ["a", "b"]);
  assert.deepEqual(quotedPayload.rows, [["x,y", "2"]]);

  // The column set comes from the whole file, not from the rows a caller asked
  // for: the same file must show the same columns at maxRows=1 and maxRows=1000,
  // so a wide row past the window still sets the width and the returned rows are
  // padded to it.
  const truncated = await seedArtifact(fixture, {
    content: "a,b\n1,2\n3,4,5\n",
    kind: "dataset",
    logicalName: "truncated.csv",
    mediaType: "text/csv",
  });
  const truncatedPayload = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, truncated, "1",
  );
  if (truncatedPayload.mode !== "dataset-table") assert.fail(`unexpected mode: ${truncatedPayload.mode}`);
  assert.deepEqual(
    truncatedPayload.columns,
    ["a", "b", ""],
    "the width is the file's widest line, whatever maxRows returns",
  );
  assert.deepEqual(truncatedPayload.rows, [["1", "2", ""]], "the returned row is padded to that width");
  assert.equal(truncatedPayload.totalRows, 2);
  assert.equal(truncatedPayload.truncated, true);
});

test("a long file does not cost a legitimate table its columns", async (context) => {
  const fixture = await createFixture(context);
  // The width is the widest line capped by a constant, never the file's row
  // count over the budget: 20,000 rows of six cells still pad to 100 x 6 cells,
  // so the sixth column must not disappear from a long file.
  for (const rowCount of [20_000, 50_000]) {
    // Six named columns, so the header and the rows agree: the file really has
    // six columns and the length of the file must not take one away.
    const lines = ["title,a,b,c,d,e"];
    for (let index = 0; index < rowCount; index += 1) lines.push(`${index},a,b,c,d,e`);
    const vid = await seedArtifact(fixture, {
      content: lines.join("\n"),
      kind: "dataset",
      logicalName: `long-${rowCount}.csv`,
      mediaType: "text/csv",
    });
    const payload = await buildArtifactVersionPreview(
      fixture.store, fixture.recorder, fixture.session.id, vid,
    );
    if (payload.mode !== "dataset-table") assert.fail(`unexpected mode ${payload.mode}`);
    assert.equal(payload.columns.length, 6, `${rowCount} rows must not cost the sixth column`);
    assert.equal(payload.rows.length, 100);
    for (const row of payload.rows) assert.equal(row.length, 6, `${rowCount}: rows are six cells wide`);
    assert.deepEqual(payload.clippedColumns, { shown: 6, total: 6 });
    assert.equal(payload.clippedCells, 0, `${rowCount}: nothing is past the width`);
    assert.deepEqual(payload.warnings, [], `${rowCount}: a whole table warns about nothing`);
  }
});

test("a delimited preview caps a pathological line and counts what it leaves out", async (context) => {
  const fixture = await createFixture(context);
  // One 200k-field line may widen the grid only up to the column constant; the
  // payload says how many columns and cells did not make it, instead of hiding
  // the loss behind a shorter row.
  const wide = Array.from({ length: 200_001 }, () => "w").join(",");
  const lines = ["a,b"];
  for (let index = 0; index < 99; index += 1) lines.push("1,2");
  lines.push(wide);
  const vid = await seedArtifact(fixture, {
    content: lines.join("\n"),
    kind: "dataset",
    logicalName: "pathological.csv",
    mediaType: "text/csv",
  });
  const payload = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, vid,
  );
  if (payload.mode !== "dataset-table") assert.fail(`unexpected mode ${payload.mode}`);
  assert.equal(payload.columns.length, 1_001, "the width stops at the column constant");
  assert.equal(payload.rows.length, 100);
  // Compare lengths and short slices: diffing a 200k-element array against a
  // 1001-element one is what the assertion itself must never do.
  for (const row of payload.rows) {
    assert.equal(row.length, payload.columns.length, "every row is as wide as the grid");
  }
  const cells = payload.rows.reduce((total, row) => total + row.length, 0);
  assert.ok(cells <= 100_100, `the grid must fit the preview bound, got ${cells}`);
  assert.deepEqual(payload.rows[99]?.slice(0, 2), ["w", "w"], "the leading cells of the wide line are kept");
  assert.equal(payload.clippedCells, 199_000, "the cells past the width are counted, not hidden");
  assert.deepEqual(
    payload.clippedColumns,
    { shown: 1_001, total: 2 },
    "the column count comes from the header; the wide row is cells, not columns",
  );
  assert.deepEqual(
    payload.warnings,
    ["199000 cells past the preview width are not shown."],
    "one sentence for one loss: the row's cells, not a schema the file does not have",
  );
  assert.ok(
    JSON.stringify(payload).length < 1_000_000,
    `the response must stay small, got ${JSON.stringify(payload).length} chars`,
  );
  // `maxRows` may lower the row count, never raise it past the constant.
  const asked = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, vid, "10000",
  );
  if (asked.mode !== "dataset-table") assert.fail(`unexpected mode ${asked.mode}`);
  assert.equal(asked.rows.length, 100, "maxRows cannot lift the row constant");
  assert.deepEqual(asked.columns, payload.columns);
  assert.equal(payload.totalRows, 100);
  assert.equal(payload.truncated, false);
});

test("a wide line past the row window does not become the file's column count", async (context) => {
  const fixture = await createFixture(context);
  // The header is the schema: this file has two columns. One outlier line that
  // falls outside the default row window is a row with many fields, not
  // evidence that the file has 5,000 columns, and no returned row is padded or
  // cut because of it. The grid width itself is the separate question the issue
  // leaves open, so columns.length is deliberately not pinned to 2 here.
  const outlier = Array.from({ length: 5_000 }, (_, index) => `c${index}`).join(",");
  const lines = ["a,b"];
  for (let index = 0; index < 100; index += 1) lines.push("1,2");
  lines.push(outlier);
  const vid = await seedArtifact(fixture, {
    content: lines.join("\n"),
    kind: "dataset",
    logicalName: "outlier-past-window.csv",
    mediaType: "text/csv",
  });
  const payload = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, vid,
  );
  if (payload.mode !== "dataset-table") assert.fail(`unexpected mode ${payload.mode}`);
  assert.equal(payload.rows.length, 100);
  for (const row of payload.rows) {
    assert.equal(row.length, payload.columns.length, "every returned row is as wide as the grid");
  }
  assert.equal(payload.clippedCells, 0, "a line outside the window clips no returned cell");
  assert.equal(payload.clippedColumns.total, 2, "the file has as many columns as its header");
  for (const warning of payload.warnings) {
    assert.doesNotMatch(
      warning,
      /has \d+ columns/,
      `a row's field count must not be announced as the file's column count: ${warning}`,
    );
  }
});

test("a header wider than the preview is clipped with an explicit signal", async (context) => {
  const fixture = await createFixture(context);
  // A 200k-column header is not a table; keeping every named column made the
  // payload unbounded (20M cells, 60 MB). The cap keeps the first constant
  // number of columns and says how many columns the file actually had.
  const header = Array.from({ length: 200_001 }, (_, index) => `h${index}`);
  const lines = [header.join(",")];
  for (let index = 0; index < 600; index += 1) lines.push("1,2");
  const vid = await seedArtifact(fixture, {
    content: lines.join("\n"),
    kind: "dataset",
    logicalName: "wide-header.csv",
    mediaType: "text/csv",
  });
  for (const [label, maxRows] of [["default", undefined], ["maxRows=500", "500"]] as const) {
    const payload = maxRows === undefined
      ? await buildArtifactVersionPreview(fixture.store, fixture.recorder, fixture.session.id, vid)
      : await buildArtifactVersionPreview(fixture.store, fixture.recorder, fixture.session.id, vid, maxRows);
    if (payload.mode !== "dataset-table") assert.fail(`unexpected mode ${payload.mode}`);
    assert.equal(payload.columns.length, 1_001, `${label}: the width stops at the column constant`);
    assert.deepEqual(payload.columns.slice(0, 2), ["h0", "h1"], `${label}: the leading names are kept`);
    assert.equal(payload.rows.length, 100, `${label}: the row constant holds`);
    for (const row of payload.rows) assert.equal(row.length, 1_001, `${label}: every row is square`);
    assert.deepEqual(payload.clippedColumns, { shown: 1_001, total: 200_001 }, `${label}: both widths are reported`);
    assert.equal(payload.clippedCells, 0, `${label}: the lost columns are reported as columns, not cells`);
    assert.ok(
      JSON.stringify(payload).length < 1_000_000,
      `${label}: the response must stay small, got ${JSON.stringify(payload).length} chars`,
    );
  }
});

test("a delimited preview shows the same columns whatever maxRows it is asked for", async (context) => {
  const fixture = await createFixture(context);
  // The width comes from every line of the file plus a constant, so a wide line
  // past the window cannot make maxRows=1 and maxRows=1000 disagree about the
  // columns; maxRows only decides how many of those rows come back.
  const wide = Array.from({ length: 200_001 }, () => "w").join(",");
  const lines = ["a,b", "1,2", "3,4", wide];
  for (let index = 0; index < 100; index += 1) lines.push("5,6");
  const vid = await seedArtifact(fixture, {
    content: lines.join("\n"),
    kind: "dataset",
    logicalName: "outlier-beyond-window.csv",
    mediaType: "text/csv",
  });
  const first = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, vid, "1",
  );
  const many = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, vid, "1000",
  );
  const some = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, vid, "50",
  );
  if (first.mode !== "dataset-table" || many.mode !== "dataset-table" || some.mode !== "dataset-table") {
    assert.fail("every call must answer a dataset-table");
  }
  assert.deepEqual(first.columns, many.columns, "maxRows cannot change the column set");
  assert.deepEqual(first.columns, some.columns, "maxRows cannot change the column set");
  assert.equal(first.columns.length, 1_001);
  assert.equal(first.rows.length, 1);
  assert.equal(first.rows[0]?.length, 1_001, "a returned row is padded to the file-wide width");
  assert.equal(many.rows.length, 100, "maxRows above the row constant is clamped");
  assert.equal(some.rows.length, 50, "maxRows below the row constant still lowers the count");
  assert.equal(many.totalRows, 103);
});

test("a delimited preview keeps a header wider than the budget whole", async (context) => {
  const fixture = await createFixture(context);
  // 1001 named columns is the widest header the preview contract covers, and
  // MAX_PREVIEW_COLUMNS is chosen so it is previewed whole: a legitimate table
  // keeps every named column, and only a line wider than that constant is cut.
  const columns = Array.from({ length: 1_001 }, (_, index) => `c${index}`);
  const lines = [columns.join(",")];
  for (let index = 0; index < 100; index += 1) lines.push("1,2,3");
  const vid = await seedArtifact(fixture, {
    content: lines.join("\n"),
    kind: "dataset",
    logicalName: "wide-header.csv",
    mediaType: "text/csv",
  });
  const payload = await buildArtifactVersionPreview(
    fixture.store, fixture.recorder, fixture.session.id, vid,
  );
  if (payload.mode !== "dataset-table") assert.fail(`unexpected mode ${payload.mode}`);
  assert.equal(payload.columns.length, 1_001, "not one named column is dropped");
  assert.deepEqual(payload.columns.slice(0, 3), ["c0", "c1", "c2"]);
  assert.equal(payload.rows.length, 100);
  for (const row of payload.rows) assert.equal(row.length, 1_001, "every row is padded to the header");
  assert.deepEqual(payload.rows[0]?.slice(0, 3), ["1", "2", "3"]);
  assert.equal(payload.rows[0]?.[1_000], "", "the padding columns stay empty");
  assert.equal(payload.clippedCells, 0, "nothing left the preview, so nothing is reported as clipped");
});

test("a delimited preview returns a legitimately wide table whole", async (context) => {
  const fixture = await createFixture(context);
  // The cell budget must never be spent by cutting columns: a well-formed table
  // of 100 or 200 named columns is previewed exactly, as it was before.
  for (const columnCount of [100, 200]) {
    const columns = Array.from({ length: columnCount }, (_, index) => `c${index}`);
    const values = Array.from({ length: columnCount }, (_, index) => `v${index}`);
    const vid = await seedArtifact(fixture, {
      content: [columns.join(","), values.join(","), values.join(",")].join("\n"),
      kind: "dataset",
      logicalName: `wide-${columnCount}.csv`,
      mediaType: "text/csv",
    });
    const payload = await buildArtifactVersionPreview(
      fixture.store, fixture.recorder, fixture.session.id, vid,
    );
    if (payload.mode !== "dataset-table") assert.fail(`unexpected mode ${payload.mode}`);
    assert.deepEqual(payload.columns, columns, `${columnCount}: every named column is kept in order`);
    assert.deepEqual(payload.rows, [values, values], `${columnCount}: every row keeps all its cells`);
    assert.equal(payload.totalRows, 2, `${columnCount}: totalRows must not change`);
    assert.equal(payload.truncated, false, `${columnCount}: truncated must not change`);
    assert.equal(payload.clippedCells, 0, `${columnCount}: a whole wide table clips nothing`);
  }
});
