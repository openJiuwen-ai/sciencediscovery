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

import {
  MAX_INLINE_BYTES,
  base64Of,
  bytesOfDataUrl,
  documentPayload,
} from "../src/app/document-payload.js";
import { XLSX_MEDIA_TYPE } from "../src/app/preview-kind.js";

const encoder = new TextEncoder();

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

test("base64 pads the last group the way the alphabet requires", () => {
  assert.equal(base64Of(bytes()), "");
  assert.equal(base64Of(bytes(0x4d, 0x61, 0x6e)), "TWFu");
  assert.equal(base64Of(bytes(0x4d, 0x61)), "TWE=");
  assert.equal(base64Of(bytes(0x4d)), "TQ==");
  assert.equal(base64Of(bytes(0, 0)), "AAA=");
  assert.equal(base64Of(bytes(255, 255, 255)), "////");
});

test("a data URL carries back exactly the bytes it was made from", () => {
  const original = bytes(0, 1, 2, 250, 251, 252, 253, 254, 255);
  const { dataUrl } = documentPayload(original, "blob.png");
  assert.deepEqual([...bytesOfDataUrl(dataUrl!)], [...original]);
});

test("a script is decoded as text and typed by its name", () => {
  const payload = documentPayload(encoder.encode("print('hi')\n"), "plot.py", "application/octet-stream");
  assert.equal(payload.content, "print('hi')\n");
  assert.equal(payload.dataUrl, undefined);
  assert.equal(payload.mediaType, "text/x-python");
});

test("a type the server does know is kept as it is", () => {
  const payload = documentPayload(encoder.encode("a,b\n1,2\n"), "samples.csv", "text/csv; charset=utf-8");
  assert.equal(payload.mediaType, "text/csv");
});

test("a picture, a PDF and a workbook are carried as data URLs of their own type", () => {
  const image = documentPayload(bytes(137, 80, 78, 71), "figure.png", "application/octet-stream");
  assert.equal(image.content, undefined);
  assert.match(image.dataUrl ?? "", /^data:image\/png;base64,/u);
  assert.equal(image.mediaType, "image/png");

  const pdf = documentPayload(encoder.encode("%PDF-1.4"), "paper.pdf");
  assert.match(pdf.dataUrl ?? "", /^data:application\/pdf;base64,/u);

  const sheet = documentPayload(bytes(80, 75, 3, 4), "results.xlsx", "application/octet-stream");
  assert.equal(sheet.mediaType, XLSX_MEDIA_TYPE);
  assert.match(sheet.dataUrl ?? "", /^data:application\/vnd\.openxmlformats/u);
});

test("a document past the inline ceiling says so and carries nothing", () => {
  const huge = { byteLength: MAX_INLINE_BYTES + 1 } as Uint8Array;
  const payload = documentPayload(huge, "huge.png", "image/png");
  assert.deepEqual(payload, { mediaType: "image/png", tooLarge: true });
});

const DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function docxBytes(): Uint8Array {
  return zipSync({ "word/document.xml": strToU8("<w:document/>") });
}

test("a container this build cannot draw is not decoded as text", () => {
  const bytes = docxBytes();
  const payload = documentPayload(bytes, "report.docx", DOCX_MEDIA_TYPE);
  assert.equal(payload.content, undefined);
  assert.equal(payload.tooLarge, undefined);
  assert.equal(payload.mediaType, DOCX_MEDIA_TYPE);
  // The bytes are kept for the download, so opening the notice still lets the
  // reader save the document they were told this build could not show.
  assert.deepEqual([...bytesOfDataUrl(payload.dataUrl!)], [...bytes]);
});

test("a .zip and an extensionless archive are containers too, whatever the server said", () => {
  const bytes = zipSync({ "notes.txt": strToU8("hello") });
  for (const [name, type] of [
    ["bundle.zip", "application/octet-stream"],
    ["bundle.zip", ""],
    ["attachment", "application/zip"],
  ] as Array<[string, string]>) {
    const payload = documentPayload(bytes, name, type);
    assert.equal(payload.content, undefined, `${name} ${type}`);
    assert.match(payload.dataUrl ?? "", /^data:.*;base64,/u, `${name} ${type}`);
  }
});

test("a log, a config, a script and a text page are still decoded as text", () => {
  const cases: Array<[string, string]> = [
    ["run.log", "text/plain"],
    ["pyproject.toml", "application/toml"],
    ["plot.py", "application/octet-stream"],
    ["notes.txt", "text/plain"],
  ];
  for (const [name, type] of cases) {
    const payload = documentPayload(encoder.encode("hello\n"), name, type);
    assert.equal(payload.content, "hello\n", name);
    assert.equal(payload.dataUrl, undefined, name);
  }
});

test("a workbook is still carried as a data URL of its own type, not as a container", () => {
  const sheet = documentPayload(zipSync({ "xl/workbook.xml": strToU8("<workbook/>") }), "results.xlsx", "");
  assert.match(sheet.dataUrl ?? "", /^data:application\/vnd\.openxmlformats/u);
});
