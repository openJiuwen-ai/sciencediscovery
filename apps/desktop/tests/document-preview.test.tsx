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
import { strToU8, zipSync } from "fflate";
// Classic JSX runtime under tsx, so React has to be in scope here.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { documentPayload } from "../src/app/document-payload.js";
import type { PreviewSlot } from "../src/app/preview-tabs.js";
import { DocumentPreview } from "../src/views/DocumentPreview.js";

function slot(overrides: Partial<PreviewSlot> & { label: string }): PreviewSlot {
  return { home: false, id: "tab-1", loading: false, path: "", ...overrides };
}

function draw(overrides: Partial<PreviewSlot> & { label: string }): string {
  return renderToStaticMarkup(
    <DocumentPreview expanded={false} onExpand={() => {}} slot={slot(overrides)} />,
  );
}

function workbookDataUrl(): string {
  const parts: Record<string, string> = {
    "xl/_rels/workbook.xml.rels":
      "<Relationships><Relationship Id=\"rId1\" Target=\"worksheets/sheet1.xml\"/>"
      + "<Relationship Id=\"rId2\" Target=\"worksheets/sheet2.xml\"/></Relationships>",
    "xl/workbook.xml":
      "<workbook><sheets><sheet name=\"测量\" r:id=\"rId1\"/><sheet name=\"汇总\" r:id=\"rId2\"/></sheets></workbook>",
    "xl/worksheets/sheet1.xml":
      "<worksheet><sheetData><row r=\"1\"><c r=\"A1\" t=\"inlineStr\"><is><t>样品</t></is></c></row>"
      + "<row r=\"2\"><c r=\"A2\" t=\"inlineStr\"><is><t>A</t></is></c></row></sheetData></worksheet>",
    "xl/worksheets/sheet2.xml":
      "<worksheet><sheetData><row r=\"1\"><c r=\"A1\" t=\"inlineStr\"><is><t>合计</t></is></c></row></sheetData></worksheet>",
  };
  const entries: Record<string, Uint8Array> = {};
  for (const [path, xml] of Object.entries(parts)) entries[path] = strToU8(xml);
  const bytes = zipSync(entries);
  const { dataUrl } = documentPayload(bytes, "results.xlsx");
  assert.ok(dataUrl !== undefined);
  return dataUrl;
}

test("a CSV slot is drawn as a table, not as its text", () => {
  const markup = draw({ content: "样品,强度\nA,12.5\n", label: "samples.csv", path: "samples.csv" });
  assert.match(markup, /class="data-table"/u);
  assert.match(markup, /<th>样品<\/th>/u);
  assert.match(markup, /class="is-number"/u);
  assert.match(markup, /共 1 行/u);
  assert.doesNotMatch(markup, /tab-content-source/u);
});

test("a Python slot is drawn as a numbered, coloured page", () => {
  const markup = draw({ content: "import math\n", label: "plot.py", path: "plot.py" });
  assert.match(markup, /class="code-line-number"/u);
  assert.match(markup, /class="tok tok-keyword"/u);
});

test("a picture slot draws its bytes rather than decoding them", () => {
  const { dataUrl } = documentPayload(Uint8Array.from([137, 80, 78, 71]), "figure.png");
  const markup = draw({ dataUrl, label: "figure.png", path: "figure.png" });
  assert.match(markup, /class="image-view"/u);
  assert.match(markup, /src="data:image\/png;base64,/u);
  assert.doesNotMatch(markup, /�/u);
});

test("a PDF slot is a frame with the download beside it", () => {
  const { dataUrl } = documentPayload(strToU8("%PDF-1.4"), "paper.pdf");
  const markup = draw({ dataUrl, label: "paper.pdf", path: "paper.pdf" });
  assert.match(markup, /<iframe[^>]*src="data:application\/pdf;base64,/u);
  assert.match(markup, /download="paper.pdf"/u);
});

test("a workbook slot draws its sheets and their tabs", () => {
  const markup = draw({ dataUrl: workbookDataUrl(), label: "results.xlsx", path: "results.xlsx" });
  assert.match(markup, /role="tablist"/u);
  assert.match(markup, /测量/u);
  assert.match(markup, /class="data-table"/u);
});

test("a workbook this build cannot read says so", () => {
  const { dataUrl } = documentPayload(strToU8("not a zip"), "broken.xlsx");
  const markup = draw({ dataUrl, label: "broken.xlsx", path: "broken.xlsx" });
  assert.match(markup, /这个工作簿无法读取/u);
});

test("a document this build cannot draw says so instead of showing its bytes", () => {
  const bytes = zipSync({ "word/document.xml": strToU8("<w:document/>") });
  const payload = documentPayload(bytes, "report.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const markup = draw({ ...payload, label: "report.docx", path: "report.docx" });
  assert.match(markup, /无法在面板内预览/u);
  assert.doesNotMatch(markup, /PK|tab-content-source|�/u);
});

test("a log is still drawn as its text", () => {
  const payload = documentPayload(strToU8("2026-11-03 start\n"), "run.log", "text/plain");
  const markup = draw({ ...payload, label: "run.log", path: "run.log" });
  assert.match(markup, /2026-11-03 start/u);
  assert.doesNotMatch(markup, /无法在面板内预览/u);
});

test("a document too large to hold is named and left to the download", () => {
  const markup = draw({ label: "huge.pdf", path: "huge.pdf", tooLarge: true });
  assert.match(markup, /文件太大/u);
});

test("a slot that is still loading is a spinner, and a failed one is its reason", () => {
  assert.match(draw({ label: "a.csv", loading: true }), /class="spinner"/u);
  assert.match(draw({ error: "读不出来了", label: "a.csv" }), /读不出来了/u);
});

test("an empty document of a type with no preview says so", () => {
  const markup = draw({ content: "", label: "archive.bin", path: "archive.bin" });
  assert.match(markup, /这个类型暂时没有预览/u);
});
