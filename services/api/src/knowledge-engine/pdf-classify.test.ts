// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
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

import { classifyPdfDocument } from "./pdf-classify.js";
import type { WorkerPageEntry } from "./pdf-vision.js";

const pages = (count: number, textChars: number, imageAreaRatio = 0): WorkerPageEntry[] =>
  Array.from({ length: count }, (_, index) => ({
    page: index + 1,
    ...(textChars ? { textCharacters: textChars } : {}),
    ...(imageAreaRatio ? { imageAreaRatio } : {}),
  }));

test("classifyPdfDocument: a scarce text layer with pages reads scanned, with reasons", () => {
  const result = classifyPdfDocument("", pages(10, 40));
  assert.equal(result.type, "scanned");
  assert.equal(result.confidence, 0.85);
  assert.equal(result.signals.pageCount, 10);
  assert.ok(result.signals.textCharsPerPage < 100);
  assert.ok(result.reasons.some((reason) => /hollow shell|vision/.test(reason)));
});

test("classifyPdfDocument: digital-born text stays text-only (conservative bar)", () => {
  const result = classifyPdfDocument(
    "Body text with plenty of characters per page. ".repeat(80),
    pages(10, 2_000),
  );
  assert.equal(result.type, "text-only");
  assert.deepEqual(result.reasons, []);
});

test("classifyPdfDocument: markers route table-heavy, formula-heavy, and mixed", () => {
  const tableText = "Intro paragraph.\n\n| col a | col b |\n| 1 | 2 |\n\nTable 1: caption\n";
  const formulaText = "The binding energy \\frac{a}{b} converges (∑ over sites) to ∞.\n";
  assert.equal(classifyPdfDocument(tableText, pages(5, 1_500)).type, "table-heavy");
  assert.equal(classifyPdfDocument(formulaText, pages(5, 1_500)).type, "formula-heavy");
  const mixed = classifyPdfDocument(`${tableText}${formulaText}`, pages(5, 1_500));
  assert.equal(mixed.type, "mixed");
  assert.ok(mixed.reasons.some((reason) => /LaTeX source/.test(reason)));
  assert.ok(mixed.reasons.some((reason) => /rendered pages/.test(reason)));
});

test("classifyPdfDocument: figure-dense pages with thin text read image-heavy", () => {
  const result = classifyPdfDocument("short", pages(10, 300, 0.5));
  assert.equal(result.type, "image-heavy");
  assert.equal(result.signals.imageDensePages, 10);
  assert.ok(result.reasons.some((reason) => /figure-dense/.test(reason)));
});

test("classifyPdfDocument: no manifest degrades to fulltext-only signals, never throws", () => {
  const result = classifyPdfDocument(
    "## Page 1\n\n" + "dense body text ".repeat(200) + "\n\n## Page 2\n\n" + "more body text ".repeat(200),
    [],
  );
  assert.equal(result.signals.pageCount, 2);
  assert.ok(result.signals.textCharsPerPage > 1_500);
  assert.equal(result.type, "text-only");
});
