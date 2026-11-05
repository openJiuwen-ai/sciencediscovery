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

import {
  XLSX_MEDIA_TYPE,
  delimitedSeparator,
  documentKind,
  isBinaryDocument,
} from "../src/app/preview-kind.js";

test("the extension decides, because the server answers octet-stream for most of them", () => {
  assert.equal(documentKind("plot.py", "application/octet-stream"), "python");
  assert.equal(documentKind("results.xlsx", "application/octet-stream"), "sheet");
  assert.equal(documentKind("figure.png", "application/octet-stream"), "image");
  assert.equal(documentKind("paper.pdf", "application/octet-stream"), "pdf");
  assert.equal(documentKind("samples.csv", "text/plain"), "csv");
});

test("an extension's case does not matter, and a query string is not part of it", () => {
  assert.equal(documentKind("DATA.XLSX"), "sheet");
  assert.equal(documentKind("Figure.PNG"), "image");
  assert.equal(documentKind("report.md?v=2"), "markdown");
});

test("everything the panel draws from bytes is a binary document", () => {
  for (const name of ["a.png", "a.pdf", "a.xlsx"]) {
    assert.equal(isBinaryDocument(documentKind(name)), true, name);
  }
  for (const name of ["a.py", "a.csv", "a.md", "a.txt"]) {
    assert.equal(isBinaryDocument(documentKind(name)), false, name);
  }
});

test("the media type is what an extensionless name has to go on", () => {
  assert.equal(documentKind("attachment", "image/jpeg"), "image");
  assert.equal(documentKind("attachment", `${XLSX_MEDIA_TYPE}; charset=binary`), "sheet");
  assert.equal(documentKind("attachment", "application/pdf"), "pdf");
  assert.equal(documentKind("attachment", "text/csv"), "csv");
  assert.equal(documentKind("attachment", "text/markdown"), "markdown");
});

test("a text page, a listing and anything unknown keep to themselves", () => {
  assert.equal(documentKind("notes.txt"), "prose");
  assert.equal(documentKind("run.log"), "source");
  assert.equal(documentKind("Makefile"), "source");
  assert.equal(documentKind("", "text/plain"), "source");
});

test("a container this build cannot draw is unrenderable, not source", () => {
  for (const name of [
    "report.docx", "deck.pptx", "notes.odt", "sheet.ods", "slides.odp",
    "old.doc", "old.xls", "legacy.xlsb", "bundle.zip", "archive.tar",
    "archive.gz", "archive.7z", "archive.rar", "book.epub",
  ]) {
    assert.equal(documentKind(name), "unrenderable", name);
  }
});

test("a log, a config, a script and a text page keep reading as text", () => {
  const cases: Array<[string, string]> = [
    ["run.log", "source"],
    ["pyproject.toml", "source"],
    ["plot.py", "python"],
    ["notes.txt", "prose"],
    ["samples.csv", "csv"],
  ];
  for (const [name, kind] of cases) assert.equal(documentKind(name), kind, name);
});

test("the media type names an unrenderable container when the name has no extension", () => {
  for (const type of [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.oasis.opendocument.text",
    "application/zip",
  ]) {
    assert.equal(documentKind("attachment", type), "unrenderable", type);
  }
});

test("a workbook is still a sheet, by name and by media type", () => {
  assert.equal(documentKind("results.xlsx"), "sheet");
  assert.equal(documentKind("attachment", XLSX_MEDIA_TYPE), "sheet");
  assert.equal(isBinaryDocument(documentKind("results.xlsx")), true);
});

test("only a .tsv insists on its own separator", () => {
  assert.equal(delimitedSeparator("samples.tsv"), "\t");
  assert.equal(delimitedSeparator("samples.csv"), undefined);
  assert.equal(delimitedSeparator("samples"), undefined);
});
