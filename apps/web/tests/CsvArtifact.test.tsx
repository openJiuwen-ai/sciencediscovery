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
import { spawnSync } from "node:child_process";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ScientificArtifactVersion } from "@sciencediscovery/schema";

import { rowsToCsv } from "../src/csv-artifact/chart-spec/filters.js";
import {
  createCustomSpec,
  createDefaultSpecs,
  requiredMappings,
} from "../src/csv-artifact/chart-spec/presets.js";
import { buildFigure } from "../src/csv-artifact/charts/buildFigure.js";
import {
  resolveSelectedRowIds,
  rowIdsFromCustomData,
  selectedPointIndicesByTrace,
} from "../src/csv-artifact/charts/selection.js";
import { ChartConfigPanel } from "../src/csv-artifact/components/ChartConfigPanel.js";
import { InspectorPanel } from "../src/csv-artifact/components/InspectorPanel.js";
import { VirtualDataTable } from "../src/csv-artifact/components/VirtualDataTable.js";
import { MAX_CSV_DATA_ROWS, parseCsvText } from "../src/csv-artifact/csv/inferCsv.js";
import { setActiveLocale } from "../src/i18n/index.js";
import { csvSourceRecord } from "../src/csv-artifact/source.js";
import {
  DEFAULT_CHART_DRAG_MODE,
  type DataSourceRecord,
} from "../src/csv-artifact/types.js";
import {
  loadWorkspaceState,
  removeChartFromWorkspace,
  saveWorkspaceState,
  workspaceCacheKey,
} from "../src/csv-artifact/workspaceCache.js";
import { detectCsvArtifact, opensInCsvViewer } from "../src/csvArtifact.js";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function source(fileName: string, content: string): DataSourceRecord {
  return {
    fileHash: "a".repeat(64),
    fileName,
    fileSize: new TextEncoder().encode(content).byteLength,
    importedAt: "2026-07-27T00:00:00.000Z",
    sourceArtifactVersionId: "artifact-version:csv-test",
  };
}

function parse(fileName: string, content: string) {
  return parseCsvText(content, source(fileName, content));
}

test("detects CSV artifacts by extension, media type, and consistent content", () => {
  assert.equal(detectCsvArtifact({ name: "RESULT.CSV" })?.method, "extension");
  assert.equal(detectCsvArtifact({ mediaType: "text/csv; charset=utf-8" })?.method, "media-type");
  assert.equal(detectCsvArtifact({
    content: [
      "gene,label,value",
      "CD3D,\"T cell, activated\",4.2",
      "MS4A1,\"B cell, mature\",3.8",
    ].join("\n"),
  })?.method, "content");
});

test("content sniffing rejects non-CSV data and inconsistent rows", () => {
  for (const content of [
    "{\"gene\":\"CD3D\",\"value\":4.2}",
    "gene\tvalue\nCD3D\t4.2",
    "ATOM      1  CA  ALA A   1      10.000  12.000  14.000",
    "gene,value\nCD3D,4.2,unexpected",
    "gene,value\0\nCD3D,4.2",
  ]) {
    assert.equal(detectCsvArtifact({ content }), undefined);
  }
});

test("profiles artifact rows and keeps stable, disambiguated record IDs", () => {
  const table = parse("cells.csv", [
    "cell_id,umap_1,umap_2,cell_type,score",
    "AA-1,1.2,-0.3,T cell,4",
    "AA-1,2.1,0.8,B cell,7",
  ].join("\n"));

  assert.equal(table.kind, "cells");
  assert.deepEqual(table.rows.map((row) => row.__rowId), ["AA-1", "AA-1#3"]);
  assert.equal(table.rows[0]?.umap_1, 1.2);
  assert.equal(table.columns.find((column) => column.id === "cell_type")?.kind, "categorical");
  assert.match(table.warnings[0] ?? "", /duplicate identifiers/);
});

test("selecting a duplicate CSV identifier highlights and inspects only the chosen record", () => {
  const content = "id,value\nsample#4,111\nsample,222\nsample,333\n";
  const table = parse("duplicate-ids.csv", content);
  const selectedRowIds = [table.rows[2]!.__rowId];
  const inspector = renderToStaticMarkup(createElement(InspectorPanel, {
    selectedRowIds,
    spec: createDefaultSpecs(table)[0]!,
    table,
  }));
  assert.match(inspector, /<dt>value<\/dt><dd title="333">333<\/dd>/);
  const grid = renderToStaticMarkup(createElement(VirtualDataTable, {
    onExport: () => undefined,
    onSelectRows: () => undefined,
    rows: table.rows,
    selectedRowIds,
    table,
  }));
  assert.equal((grid.match(/aria-selected="true"/g) ?? []).length, 1);
  assert.deepEqual(table.rows.map((row) => row.id), ["sample#4", "sample", "sample"]);
  assert.deepEqual(table.rows.map((row) => row.value), [111, 222, 333]);
  assert.deepEqual(parse("duplicate-ids.csv", content).rows, table.rows);
});

test("duplicate CSV identifiers remain unique through multiple occupied suffixes", () => {
  const table = parse("occupied-suffixes.csv", [
    "id,value",
    "sample#6,111",
    "sample#7,222",
    "sample#8,333",
    "sample,444",
    "sample,555",
  ].join("\n"));
  assert.equal(new Set(table.rows.map((row) => row.__rowId)).size, 5);
  assert.equal(table.rows.find((row) => row.__rowId === table.rows[4]!.__rowId)?.value, 555);
  assert.match(table.warnings[0] ?? "", /1 duplicate identifiers/);
});

test("missing CSV identifiers remain unique when generated row IDs and suffixes are occupied", () => {
  const table = parse("missing-id-collisions.csv", [
    "id,value",
    "row-4,111",
    "row-4#4,222",
    ",333",
  ].join("\n"));
  assert.equal(new Set(table.rows.map((row) => row.__rowId)).size, 3);
  assert.equal(table.rows.find((row) => row.__rowId === table.rows[2]!.__rowId)?.value, 333);
  assert.equal(table.rows[2]?.id, null);
});

test("large blocks of colliding CSV identifiers can be profiled without repeated suffix scans", () => {
  // Run separately so a synchronous browser-style stall is actually bounded.
  const moduleUrl = new URL("../src/csv-artifact/csv/inferCsv.ts", import.meta.url).href;
  const program = `
    import { parseCsvText } from ${JSON.stringify(moduleUrl)};
    const content = ["id,value",
      ...Array.from({ length: 20000 }, (_, i) => "sample#" + (20002 + i) + "," + i),
      ...Array.from({ length: 20000 }, (_, i) => "sample," + (20000 + i)),
    ].join("\\n");
    const table = parseCsvText(content, {
      fileHash: "a".repeat(64), fileName: "occupied-block.csv",
      fileSize: new TextEncoder().encode(content).byteLength,
      importedAt: "2026-07-27T00:00:00.000Z", sourceArtifactVersionId: "large-collision-test",
    });
    console.log(JSON.stringify({ rows: table.rows.length,
      unique: new Set(table.rows.map(row => row.__rowId)).size,
      lastValue: table.rows.at(-1).value }));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.error, undefined, "CSV profiling exceeded the 10-second responsiveness budget");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { rows: 40000, unique: 40000, lastValue: 39999 });
});

test("profiles common scientific missing-value tokens as null", () => {
  const table = parse("missing.csv", [
    "id,value",
    "row-1,1.5",
    "row-2,NA",
    "row-3,NaN",
    "row-4,null",
    "row-5,3.5",
  ].join("\n"));

  assert.equal(table.columns.find((column) => column.id === "value")?.kind, "quantitative");
  assert.equal(table.columns.find((column) => column.id === "value")?.missingCount, 3);
  assert.deepEqual(table.rows.map((row) => row.value), [1.5, null, null, null, 3.5]);
});

test("imports one million numeric records, excluding the header and blank lines", () => {
  assert.equal(MAX_CSV_DATA_ROWS, 1_000_000);
  const table = parse("million.csv", `value\r\n \r\n${"-2\r\n".repeat(MAX_CSV_DATA_ROWS - 1)}7\r\n\r\n`);
  assert.equal(table.rows.length, MAX_CSV_DATA_ROWS);
  assert.equal(table.rows.at(-1)?.value, 7);
  assert.equal(table.columns[0]?.min, -2);
  assert.equal(table.columns[0]?.max, 7);
});

test("rejects oversized CSVs with localized recovery guidance instead of truncating them", () => {
  const csv = `value\n${"1\n".repeat(MAX_CSV_DATA_ROWS + 1)}`;
  try {
    setActiveLocale("en");
    assert.throws(() => parse("oversized.csv", csv), /more than 1,000,000 data rows.*locally.*split\/sample/);
    setActiveLocale("zh-CN");
    assert.throws(() => parse("oversized.csv", csv), /超过 1,000,000 行数据.*本地处理.*拆分\/抽样/);
  } finally {
    setActiveLocale("en");
  }
  assert.equal(parse("small.csv", "value\n42\n").rows[0]?.value, 42);
});

test("counts quoted newlines as part of one data record when enforcing the CSV cap", () => {
  const record = '"two\nlines"\n';
  const csv = `label\n${record.repeat(MAX_CSV_DATA_ROWS)}`;
  const table = parse("multiline.csv", csv);
  assert.equal(table.rows.length, MAX_CSV_DATA_ROWS);
  assert.equal(table.rows.at(-1)?.label, "two\nlines");
  assert.throws(() => parse("multiline-overflow.csv", `${csv}${record}`), /more than 1,000,000 data rows/);
});

test("large scatter size mappings preserve their range without expanding function arguments", () => {
  const table = parse("large-scatter.csv", `x,y\n${"-2,0\n".repeat(149_999)}7,1\n`);
  const scatter = createCustomSpec(table, 1);
  scatter.mappings.sizeBy = "x";
  const figure = buildFigure(table, scatter);
  const sizes = (figure.data[0]?.marker as { size: number[] }).size;
  assert.equal(sizes.length, 150_000);
  assert.equal(sizes[0], scatter.appearance.pointMin);
  assert.equal(sizes.at(-1), scatter.appearance.pointMax);
});

test("derives UMAP, t-SNE, PCA, distribution, and table views from cell data", () => {
  const table = parse("embedding.csv", [
    "cell_id,cell_type,umap_1,umap_2,tsne_1,tsne_2,pca_1,pca_2,CD3D",
    "c1,T cell,1,2,3,4,5,6,8.1",
    "c2,B cell,2,3,4,5,6,7,0.4",
  ].join("\n"));
  const specs = createDefaultSpecs(table);
  const presets = new Set(specs.map((spec) => spec.preset));

  for (const preset of ["UMAP", "t-SNE", "PCA", "Histogram", "Box plot", "Violin plot", "Data table"]) {
    assert.ok(presets.has(preset), `missing ${preset}`);
  }
  assert.ok(specs.every((spec) => spec.displayName === spec.preset));
});

test("creates configurable charts with an independent display name", () => {
  const table = parse("custom.csv", [
    "id,x,y,group",
    "row-1,1,2,A",
    "row-2,2,3,B",
  ].join("\n"));
  const custom = createCustomSpec(table, 1);

  assert.equal(custom.id, "custom-chart-1");
  assert.equal(custom.type, "scatter");
  assert.equal(custom.displayName, "New chart 1");
  assert.equal(custom.appearance.title, "New chart 1");
  assert.equal(custom.mappings.x, "x");
  assert.equal(custom.mappings.y, "y");

  custom.displayName = "My comparison";
  const html = renderToStaticMarkup(createElement(ChartConfigPanel, {
    activeTable: table,
    canDelete: true,
    onChange: () => undefined,
    onDeleteSpec: () => undefined,
    onResetSpec: () => undefined,
    spec: custom,
  }));
  assert.match(html, /Display name/);
  assert.match(html, /value="My comparison"/);
  assert.match(html, /aria-label="Delete current chart"/);
  assert.equal(custom.appearance.title, "New chart 1");
});

test("category filters expose every value in supported low-cardinality fields", () => {
  const categories = Array.from({ length: 25 }, (_, index) => `group-${index + 1}`);
  const table = parse("categories.csv", [
    "id,x,y,group",
    ...categories.map((category, index) => `row-${index + 1},${index},${index + 1},${category}`),
  ].join("\n"));
  const chart = createCustomSpec(table, 1);
  const html = renderToStaticMarkup(createElement(ChartConfigPanel, {
    activeTable: table,
    canDelete: false,
    onChange: () => undefined,
    onDeleteSpec: () => undefined,
    onResetSpec: () => undefined,
    spec: chart,
  }));

  assert.match(html, /group-25/);
});

test("new charts fall back to histogram or data table when axes are limited", () => {
  const histogram = createCustomSpec(parse("one-number.csv", [
    "id,value,label",
    "row-1,1,A",
    "row-2,2,B",
  ].join("\n")), 1);
  assert.equal(histogram.type, "histogram");
  assert.equal(histogram.mappings.x, "value");
  assert.equal(histogram.mappings.y, undefined);

  const table = createCustomSpec(parse("text.csv", [
    "id,label",
    "row-1,alpha",
    "row-2,beta",
  ].join("\n")), 2);
  assert.equal(table.type, "table");
  assert.equal(table.mappings.x, undefined);
  assert.equal(table.mappings.y, undefined);
});

test("persists chart configuration per Artifact Version", () => {
  const table = parse("cached.csv", [
    "id,x,y,group",
    "row-1,1,2,A",
    "row-2,2,3,B",
  ].join("\n"));
  const defaults = createDefaultSpecs(table);
  const custom = createCustomSpec(table, 1);
  custom.displayName = "Saved comparison";
  custom.appearance.title = "Independent title";
  const storage = new MemoryStorage();

  assert.equal(saveWorkspaceState(storage, table.source.sourceArtifactVersionId, {
    activeSpecId: custom.id,
    specs: [defaults[0]!, custom],
  }), true);
  assert.match(storage.getItem(workspaceCacheKey(table.source.sourceArtifactVersionId)) ?? "", /Saved comparison/);

  const restored = loadWorkspaceState(storage, table, defaults);
  assert.equal(restored.activeSpecId, custom.id);
  assert.equal(restored.specs[1]?.displayName, "Saved comparison");
  assert.equal(restored.specs[1]?.appearance.title, "Independent title");

  const otherVersion = parseCsvText([
    "id,x,y,group",
    "row-1,1,2,A",
  ].join("\n"), {
    ...source("cached.csv", "id,x,y,group\nrow-1,1,2,A"),
    sourceArtifactVersionId: "artifact-version:other",
  });
  const otherDefaults = createDefaultSpecs(otherVersion);
  assert.deepEqual(loadWorkspaceState(storage, otherVersion, otherDefaults).specs, otherDefaults);

  storage.setItem(workspaceCacheKey(table.source.sourceArtifactVersionId), "{not-json");
  assert.deepEqual(loadWorkspaceState(storage, table, defaults).specs, defaults);
});

test("workspace files open in the CSV viewer by name or served media type only", () => {
  assert.equal(opensInCsvViewer("uploads/measurements.csv"), true);
  assert.equal(opensInCsvViewer("RESULTS.CSV", "application/octet-stream"), true);
  assert.equal(opensInCsvViewer("exports/table", "text/csv; charset=utf-8"), true);
  // No format the viewer does not already take is routed to it, and nothing
  // is promoted by sniffing comma-separated content.
  for (const [path, mediaType] of [
    ["notes.txt", "text/plain; charset=utf-8"],
    ["tables/expression.tsv", "application/octet-stream"],
    ["records.json", "application/json; charset=utf-8"],
    ["results/summary.md", "application/octet-stream"],
    ["README", "application/octet-stream"],
  ] as const) {
    assert.equal(opensInCsvViewer(path, mediaType), false, path);
  }
});

test("workspace CSV sources carry no artifact identity and key layouts by revision", () => {
  const workspace = {
    kind: "workspace" as const,
    modifiedAt: "2026-10-20T01:00:00.000Z",
    openedAt: "2026-10-20T02:00:00.000Z",
    path: "uploads/measurements.csv",
    revisionId: "revision-1",
    sessionId: "session-1",
    size: 42,
  };
  assert.deepEqual(csvSourceRecord(workspace, "measurements.csv"), {
    fileHash: "",
    fileName: "measurements.csv",
    fileSize: 42,
    importedAt: "2026-10-20T02:00:00.000Z",
    sourceArtifactVersionId: "workspace:session-1:revision-1",
  });
  assert.equal(
    csvSourceRecord({ ...workspace, revisionId: undefined }, "measurements.csv").sourceArtifactVersionId,
    "workspace:session-1:uploads/measurements.csv@2026-10-20T01:00:00.000Z",
  );
  assert.equal(
    csvSourceRecord({ ...workspace, modifiedAt: undefined, revisionId: undefined }, "measurements.csv").sourceArtifactVersionId,
    "workspace:session-1:uploads/measurements.csv",
  );

  const version: ScientificArtifactVersion = {
    artifactId: "artifact-1",
    content: { hash: "b".repeat(64), size: 128 },
    createdAt: "2026-10-19T00:00:00.000Z",
    executionRunIds: [],
    id: "version-1",
    inputArtifactVersionIds: [],
    mediaType: "text/csv",
    projectId: "project-1",
    sessionId: "session-1",
    version: 3,
  };
  assert.deepEqual(csvSourceRecord({ kind: "artifact", version }, "marker.csv"), {
    fileHash: "b".repeat(64),
    fileName: "marker.csv",
    fileSize: 128,
    importedAt: "2026-10-19T00:00:00.000Z",
    sourceArtifactVersionId: "version-1",
  });
});

test("charts saved for one workspace revision do not carry over to an edited file", () => {
  const content = ["id,x,y,group", "row-1,1,2,A", "row-2,2,3,B"].join("\n");
  const workspaceTable = (revisionId: string) => parseCsvText(content, csvSourceRecord({
    kind: "workspace",
    openedAt: "2026-10-20T02:00:00.000Z",
    path: "uploads/cached.csv",
    revisionId,
    sessionId: "session-1",
    size: content.length,
  }, "cached.csv"));
  const table = workspaceTable("revision-1");
  const defaults = createDefaultSpecs(table);
  const custom = createCustomSpec(table, 1);
  custom.displayName = "Saved comparison";
  const storage = new MemoryStorage();
  saveWorkspaceState(storage, table.source.sourceArtifactVersionId, { activeSpecId: custom.id, specs: [defaults[0]!, custom] });

  const reopened = workspaceTable("revision-1");
  assert.equal(loadWorkspaceState(storage, reopened, createDefaultSpecs(reopened)).specs[1]?.displayName, "Saved comparison");
  const edited = workspaceTable("revision-2");
  const editedDefaults = createDefaultSpecs(edited);
  assert.deepEqual(loadWorkspaceState(storage, edited, editedDefaults).specs, editedDefaults);
});

test("deletes charts while retaining a valid active view and one required chart", () => {
  const table = parse("delete.csv", [
    "id,x,y",
    "row-1,1,2",
    "row-2,2,3",
  ].join("\n"));
  const first = createDefaultSpecs(table)[0]!;
  const second = createCustomSpec(table, 1);
  const third = createCustomSpec(table, 2);

  const removed = removeChartFromWorkspace({
    activeSpecId: second.id,
    specs: [first, second, third],
  }, second.id);
  assert.deepEqual(removed.specs.map((spec) => spec.id), [first.id, third.id]);
  assert.equal(removed.activeSpecId, third.id);

  const retained = removeChartFromWorkspace({
    activeSpecId: first.id,
    specs: [first],
  }, first.id);
  assert.deepEqual(retained.specs.map((spec) => spec.id), [first.id]);
  assert.equal(retained.activeSpecId, first.id);
});

test("derives differential, marker, and enrichment views from field sets", () => {
  const differential = createDefaultSpecs(parse("differential.csv", [
    "gene,log2_fc,adjusted_p_value,group",
    "CD3D,2.4,0.0001,up",
    "MS4A1,-1.8,0.002,down",
  ].join("\n")));
  assert.ok(differential.some((spec) => spec.type === "volcano"));

  const marker = createDefaultSpecs(parse("marker.csv", [
    "gene,cell_type,mean_expression,pct_expressing",
    "CD3D,T cell,4.2,0.91",
    "MS4A1,B cell,3.8,0.82",
  ].join("\n")));
  assert.ok(marker.some((spec) => spec.type === "dot-matrix"));
  assert.ok(marker.some((spec) => spec.type === "heatmap"));

  const enrichmentTable = parse("enrichment.csv", [
    "term,gene_ratio,neg_log10_padj,hit_count,category",
    "T cell signaling,0.31,4.2,14,immune",
    "DNA repair,0.18,2.8,9,repair",
  ].join("\n"));
  const enrichment = createDefaultSpecs(enrichmentTable);
  assert.ok(enrichment.some((spec) => spec.type === "ranked-bar"));
  assert.ok(enrichment.some((spec) => spec.type === "ranked-bubble"));
  const bar = enrichment.find((spec) => spec.type === "ranked-bar");
  assert.ok(bar);
  assert.equal(bar.scales.yScale, "category");
  assert.equal((buildFigure(enrichmentTable, bar).layout.yaxis as { type: string }).type, "category");
});

test("scientific field aliases follow semantic priority instead of CSV column order", () => {
  const withPrecomputedSignificance = createDefaultSpecs(parse("differential.csv", [
    "gene,log2_fc,p_value,adjusted_p_value,neg_log10_padj,group",
    "CD3D,2.4,0.00001,0.0001,4,up",
    "MS4A1,-1.8,0.001,0.01,2,down",
  ].join("\n"))).find((spec) => spec.type === "volcano");
  assert.ok(withPrecomputedSignificance);
  assert.equal(withPrecomputedSignificance.mappings.y, "neg_log10_padj");

  const withAdjustedSignificance = createDefaultSpecs(parse("differential.csv", [
    "gene,log2_fc,p_value,adjusted_p_value,group",
    "CD3D,2.4,0.00001,0.0001,up",
    "MS4A1,-1.8,0.001,0.01,down",
  ].join("\n"))).find((spec) => spec.type === "volcano");
  assert.ok(withAdjustedSignificance);
  assert.equal(withAdjustedSignificance.mappings.y, "adjusted_p_value");
});

test("defaults graphical interaction to pan mode", () => {
  const table = parse("scatter.csv", [
    "id,x,y",
    "row-1,1,2",
    "row-2,2,3",
  ].join("\n"));
  const scatter = createDefaultSpecs(table).find((spec) => spec.type === "scatter");
  assert.ok(scatter);

  assert.equal(DEFAULT_CHART_DRAG_MODE, "pan");
  assert.equal(buildFigure(table, scatter).layout.dragmode, "pan");
});

test("every inferred graphical preset has complete mappings and renderable data", () => {
  const table = parse("embedding.csv", [
    "cell_id,cell_type,umap_1,umap_2,pca_1,pca_2,score",
    "c1,T cell,1,2,5,6,8.1",
    "c2,B cell,2,3,6,7,0.4",
  ].join("\n"));

  for (const spec of createDefaultSpecs(table)) {
    for (const mapping of requiredMappings(spec.type)) {
      assert.ok(spec.mappings[mapping], `${spec.preset} is missing ${mapping}`);
    }
    if (spec.type === "table") continue;
    const figure = buildFigure(table, spec);
    assert.ok(figure.data.length > 0, `${spec.preset} has no traces`);
    assert.equal(figure.visibleRows.length, 2);
  }
});

test("categorical matrix charts reserve room for axis labels", () => {
  const table = parse("marker.csv", [
    "gene,cell_type,mean_expression,pct_expressing",
    "CD3D,T cell,4.2,0.91",
    "LYZ,Classical monocyte population,3.8,0.82",
  ].join("\n"));
  const heatmap = createDefaultSpecs(table).find((spec) => spec.type === "heatmap");
  assert.ok(heatmap);

  const layout = buildFigure(table, heatmap).layout;
  const margin = layout.margin as { b: number; l: number };
  const xaxis = layout.xaxis as { title: { standoff: number } };
  const yaxis = layout.yaxis as { title: { standoff: number } };

  assert.ok(margin.l >= 120);
  assert.ok(margin.b >= 90);
  assert.equal(xaxis.title.standoff, 14);
  assert.equal(yaxis.title.standoff, 18);
});

test("heatmap cells retain the source record IDs they aggregate", () => {
  const table = parse("marker.csv", [
    "gene,cell_type,mean_expression,pct_expressing",
    "CD3D,T cell,4.2,0.91",
    "CD3D,T cell,3.8,0.82",
    "MS4A1,B cell,4.1,0.76",
  ].join("\n"));
  const heatmap = createDefaultSpecs(table).find((spec) => spec.type === "heatmap");
  assert.ok(heatmap);

  const trace = buildFigure(table, heatmap).data[0];
  const customdata = trace?.customdata as Array<Array<{ rowIds: string[] }>>;
  assert.deepEqual(customdata[1]?.[0]?.rowIds, ["CD3D", "CD3D#3"]);
  assert.deepEqual(rowIdsFromCustomData(customdata[1]?.[0]), ["CD3D", "CD3D#3"]);
});

test("volcano plots transform adjusted p-values to -log10", () => {
  const table = parse("differential.csv", [
    "gene,log2_fc,adjusted_p_value,group",
    "CD3D,2.4,0.0001,up",
    "MS4A1,-1.8,0.01,down",
  ].join("\n"));
  const volcano = createDefaultSpecs(table).find((spec) => spec.type === "volcano");
  assert.ok(volcano);

  const yValues = buildFigure(table, volcano).data.flatMap((trace) =>
    Array.isArray(trace.y) ? trace.y : []);
  assert.deepEqual(yValues.toSorted((left, right) => Number(left) - Number(right)), [2, 4]);
  const yaxis = buildFigure(table, volcano).layout.yaxis as { title: { text: string } };
  assert.equal(yaxis.title.text, "-log10(adjusted_p_value)");
});

test("axis types follow mapped field semantics and continuous colors avoid a discrete legend", () => {
  const table = parse("scatter.csv", [
    "id,x,y,score,group,date",
    "row-1,1,2,0.2,A,2026-07-26",
    "row-2,2,3,0.8,B,2026-07-27",
  ].join("\n"));
  const scatter = createDefaultSpecs(table).find((spec) => spec.type === "scatter");
  assert.ok(scatter);
  scatter.mappings.x = "group";
  scatter.mappings.colorBy = "score";
  scatter.scales.xScale = "linear";

  const figure = buildFigure(table, scatter);
  assert.equal((figure.layout.xaxis as { type: string }).type, "category");
  assert.ok(figure.data.every((trace) => trace.showlegend === false));
  assert.ok(figure.data.every((trace) => trace.name === "score"));

  scatter.mappings.x = "date";
  assert.equal((buildFigure(table, scatter).layout.xaxis as { type: string }).type, "date");
});

test("faceted charts keep a valid layout when filters hide every record", () => {
  const table = parse("scatter.csv", [
    "id,x,y,group",
    "row-1,1,2,A",
    "row-2,2,3,B",
  ].join("\n"));
  const scatter = createDefaultSpecs(table).find((spec) => spec.type === "scatter");
  assert.ok(scatter);
  scatter.mappings.facetBy = "group";
  scatter.displayFilters = [{ kind: "search", query: "not-present" }];

  const figure = buildFigure(table, scatter);
  assert.equal(figure.visibleRows.length, 0);
  assert.deepEqual(figure.layout.grid, {
    columns: 1,
    pattern: "independent",
    rows: 1,
    xgap: 0.08,
    ygap: 0.13,
  });
  assert.ok(figure.layout.xaxis);
  assert.ok(figure.layout.yaxis);
});

test("faceted charts do not silently omit supported category values", () => {
  const categories = Array.from({ length: 13 }, (_, index) => `group-${index + 1}`);
  const table = parse("facets.csv", [
    "id,x,y,group",
    ...categories.map((category, index) => `row-${index + 1},${index},${index + 1},${category}`),
  ].join("\n"));
  const scatter = createCustomSpec(table, 1);
  scatter.mappings.facetBy = "group";

  const figure = buildFigure(table, scatter);
  assert.equal(figure.data.length, categories.length);
  assert.deepEqual(figure.layout.grid, {
    columns: 2,
    pattern: "independent",
    rows: 7,
    xgap: 0.08,
    ygap: 0.13,
  });
});

test("chart selections replace by default and use Ctrl to add or remove", () => {
  assert.deepEqual(resolveSelectedRowIds(["row-1"], ["row-2", "row-2"], false), ["row-2"]);
  assert.deepEqual(
    resolveSelectedRowIds(["row-1", "row-2"], ["row-2", "row-3"], true),
    ["row-1", "row-2", "row-3"],
  );
  assert.deepEqual(
    resolveSelectedRowIds(["row-1", "row-2", "row-3"], ["row-1", "row-3"], true),
    ["row-2"],
  );
  assert.deepEqual(
    resolveSelectedRowIds(["row-1"], [], true),
    ["row-1"],
  );
});

test("chart selection updates map record IDs without rebuilding trace data", () => {
  const traces = [
    { customdata: [["row-1"], ["row-2"], ["row-3"]] },
    { customdata: [["row-4"], ["row-5"]] },
    { customdata: [[{ rowIds: ["row-1", "row-2"] }]], type: "heatmap" },
  ];

  assert.deepEqual(
    selectedPointIndicesByTrace(traces, ["row-2", "row-4"]),
    [[1], [0], null],
  );
  assert.deepEqual(
    selectedPointIndicesByTrace(traces, []),
    [null, null, null],
  );
});

test("the data table exposes every source field", () => {
  const fields = Array.from({ length: 18 }, (_, index) => `field_${index + 1}`);
  const table = parse("wide.csv", [
    ["id", ...fields].join(","),
    ["row-1", ...fields.map((_, index) => String(index + 1))].join(","),
  ].join("\n"));
  const html = renderToStaticMarkup(createElement(VirtualDataTable, {
    onExport: () => undefined,
    onSelectRows: () => undefined,
    rows: table.rows,
    selectedRowIds: [],
    table,
  }));

  assert.match(html, /field_18/);
});

test("selected scatter points keep their configured base size", () => {
  const table = parse("scatter.csv", [
    "id,x,y,group",
    "row-1,1,2,A",
    "row-2,2,3,B",
  ].join("\n"));
  const scatter = createDefaultSpecs(table).find((spec) => spec.type === "scatter");
  assert.ok(scatter);

  const trace = buildFigure(table, scatter).data[0];
  const selectedMarker = (trace?.selected as { marker?: Record<string, unknown> } | undefined)?.marker;
  assert.equal(selectedMarker?.size, undefined);
});

test("CSV export neutralizes spreadsheet formulas", () => {
  const csv = rowsToCsv([
    { __rowId: "unsafe", label: "=HYPERLINK(\"https://example.invalid\")" },
    { __rowId: "whitespace", label: " \t@SUM(1,2)" },
  ], ["label"]);
  assert.match(csv, /'=HYPERLINK/);
  assert.match(csv, /' \t@SUM/);
});
