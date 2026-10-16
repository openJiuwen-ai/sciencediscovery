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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { extractPdfText, mergeVisionAnnotations, VISION_ANNOTATION_MARKER } from "./pdf-text.js";
import { selectVisionCandidatePages } from "./pdf-vision.js";

function tempRoot(name: string): string {
  return resolve(process.cwd(), ".tmp", `${name}-${Date.now()}-${process.pid}`);
}

/**
 * Fake "paper worker" (a node script standing in for python + worker): it
 * enforces the REAL worker contract — the output directory must be empty
 * (services/paper/paper_worker.py raises ValueError otherwise) — then writes
 * fulltext.md and prints the manifest JSON. pythonPath=process.execPath runs
 * it with node. The empty-dir check is the regression guard for passing a
 * staging dir that already holds source.pdf.
 */
const FAKE_WORKER = `
const fs = require("node:fs");
const path = require("node:path");
const [pdf, outDir] = process.argv.slice(2);
if (fs.readdirSync(outDir).length > 0) {
  console.error("ValueError: Output directory must be empty");
  process.exit(1);
}
if (!fs.existsSync(pdf) || fs.statSync(pdf).size < 100) {
  console.error("ValueError: not a PDF");
  process.exit(1);
}
fs.writeFileSync(path.join(outDir, "fulltext.md"), "# Extracted PDF text\\n\\nbody text here\\n");
console.log(JSON.stringify({ textPath: "fulltext.md" }));
`;

async function fakeWorkerSetup(root: string): Promise<{ pythonPath: string; workerPath: string }> {
  await mkdir(root, { recursive: true });
  const workerPath = resolve(root, "fake-worker.cjs");
  await writeFile(workerPath, FAKE_WORKER);
  return { pythonPath: process.execPath, workerPath };
}

test("extractPdfText stages the PDF beside an empty output dir and returns fulltext", async (context) => {
  const root = tempRoot("ke-pdftext");
  context.after(() => rm(root, { force: true, recursive: true }));
  const { pythonPath, workerPath } = await fakeWorkerSetup(root);

  const result = await extractPdfText({
    pythonPath,
    workerPath,
    workDirRoot: resolve(root, "staging"),
    pdfBytes: new Uint8Array(200).fill(65),
    docId: "doc-1",
  });
  assert.match(result.fulltext, /body text here/);
  // V1-Z3: the manifest-less fake worker degrades to fulltext-only signals
  // and still classifies (never throws, conservative text-only here).
  assert.equal(result.classification.type, "text-only");
  // Staging is cleaned up afterwards.
  assert.equal(existsSync(resolve(root, "staging", "doc-1")), false);
});

test("extractPdfText warns loudly when a scanned PDF has no vision pass (V1-Z3)", async (context) => {
  const root = tempRoot("ke-pdftext-scanned");
  context.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(root, { recursive: true });
  // Scanned shape: ten pages, ~40 chars of text each, no preview paths.
  const workerPath = resolve(root, "fake-worker.cjs");
  await writeFile(workerPath, `
const fs = require("node:fs");
const path = require("node:path");
const [pdf, outDir] = process.argv.slice(2);
fs.writeFileSync(path.join(outDir, "fulltext.md"), "## Page 1\\n\\nscanned\\n");
console.log(JSON.stringify({
  textPath: "fulltext.md",
  pages: Array.from({ length: 10 }, (_, i) => ({ page: i + 1, textCharacters: 40 })),
}));
`);

  const warnings: Array<{ detail?: unknown; message: string }> = [];
  let classified: string | undefined;
  const result = await extractPdfText({
    pythonPath: process.execPath,
    workerPath,
    workDirRoot: resolve(root, "staging"),
    pdfBytes: new Uint8Array(200).fill(65),
    docId: "doc-1",
    onWarn: (message, detail) => warnings.push({ message, detail }),
    onClassification: (classification) => { classified = classification.type; },
  });
  assert.equal(result.classification.type, "scanned");
  assert.equal(classified, "scanned");
  const loud = warnings.find((warning) => warning.message === "ke_pdf_scanned_no_vision");
  assert.ok(loud, "scanned without vision must warn loudly, not ingest silently");
  assert.match(JSON.stringify(loud!.detail), /hollow shell/);
});

test("extractPdfText rejects a path-escape docId before touching the fs", async (context) => {
  const root = tempRoot("ke-pdftext-guard");
  context.after(() => rm(root, { force: true, recursive: true }));
  const { pythonPath, workerPath } = await fakeWorkerSetup(root);
  await assert.rejects(
    () =>
      extractPdfText({
        pythonPath,
        workerPath,
        workDirRoot: resolve(root, "staging"),
        pdfBytes: new Uint8Array(200),
        docId: "../escape",
      }),
    /invalid docId/,
  );
});

test("extractPdfText propagates worker failure and still cleans staging", async (context) => {
  const root = tempRoot("ke-pdftext-fail");
  context.after(() => rm(root, { force: true, recursive: true }));
  const { pythonPath, workerPath } = await fakeWorkerSetup(root);
  await assert.rejects(
    () =>
      extractPdfText({
        pythonPath,
        workerPath,
        workDirRoot: resolve(root, "staging"),
        pdfBytes: new Uint8Array(10), // too small — the fake worker rejects it
        docId: "doc-2",
      }),
  );
  assert.equal(existsSync(resolve(root, "staging", "doc-2")), false);
});

// ------------------------------------------------------------- vision pass

test("selectVisionCandidatePages picks needsVision and figure-dense pages, capped and preview-bounded", () => {
  const pages = Array.from({ length: 30 }, (_, index) => ({
    page: index + 1,
    needsVision: index % 2 === 0,
    imageAreaRatio: index % 3 === 0 ? 0.5 : 0,
    // Only odd pages have rendered previews (the preview window is bounded).
    ...(index % 2 === 1 ? { previewPath: `pages/page-${String(index + 1).padStart(4, "0")}.png` } : {}),
  }));
  const picked = selectVisionCandidatePages(pages);
  assert.ok(picked.length <= 6, "cap of 6 per document");
  assert.ok(picked.every((page) => page % 2 === 0), "pages without a preview are excluded");
  assert.deepEqual(picked, [4, 10, 16, 22, 28], "only dense/needsVision pages with previews qualify");

  assert.deepEqual(
    selectVisionCandidatePages([
      { page: 1, needsVision: false, imageAreaRatio: 0.1, previewPath: "p1.png" },
      { page: 2, needsVision: false, imageAreaRatio: 0.3, previewPath: "p2.png" },
      { page: 3, needsVision: true, imageAreaRatio: 0, previewPath: "p3.png" },
      { page: 4, needsVision: true, imageAreaRatio: 0.9 }, // no preview → excluded
    ]),
    [2, 3],
  );
});

test("mergeVisionAnnotations inserts blocks at page-section ends and appends orphans", () => {
  const fulltext = "# Extracted PDF text\n\n## Page 1\n\nalpha text\n\n## Page 2\n\nbeta text\n\n## Page 3\n\ngamma text\n";
  const merged = mergeVisionAnnotations(fulltext, new Map([[1, "figure one described"], [3, "figure three described"], [9, "orphan"]]));
  // Page 1's block lands after its body, before the Page 2 heading.
  const p1Block = merged.indexOf(`### Page 1 ${VISION_ANNOTATION_MARKER}`);
  assert.ok(p1Block > merged.indexOf("alpha text"));
  assert.ok(p1Block < merged.indexOf("## Page 2"));
  // Last page's block lands at the very end of the document.
  assert.ok(merged.indexOf(`### Page 3 ${VISION_ANNOTATION_MARKER}`) > merged.indexOf("gamma text"));
  assert.match(merged, /## Vision annotations \(pages without matching text sections\)[\s\S]*orphan/);
});

test("extractPdfText merges vision descriptions for candidate pages via describeImage", async (context) => {
  const root = tempRoot("ke-pdftext-vision");
  context.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(root, { recursive: true });
  const workerPath = resolve(root, "fake-worker-vision.cjs");
  // A fake worker honoring the real contract, emitting a manifest whose
  // page 2 is needsVision and ships a preview PNG.
  await writeFile(workerPath, `
const fs = require("node:fs");
const path = require("node:path");
const [pdf, outDir] = process.argv.slice(2);
if (fs.readdirSync(outDir).length > 0) process.exit(1);
fs.mkdirSync(path.join(outDir, "pages"), { recursive: true });
fs.writeFileSync(path.join(outDir, "pages", "page-0002.png"), Buffer.from([137, 80, 78, 71]));
fs.writeFileSync(path.join(outDir, "fulltext.md"), "# Extracted PDF text\\n\\n## Page 1\\n\\nreal body text\\n\\n## Page 2\\n\\n_[No embedded text.]_\\n");
console.log(JSON.stringify({
  textPath: "fulltext.md",
  pages: [
    { page: 1, textCharacters: 500, needsVision: false, imageAreaRatio: 0 },
    { page: 2, textCharacters: 0, needsVision: true, imageAreaRatio: 0.9, previewPath: "pages/page-0002.png" },
  ],
}));
`);
  const described: number[] = [];
  const { fulltext: text } = await extractPdfText({
    pythonPath: process.execPath,
    workerPath,
    workDirRoot: resolve(root, "staging"),
    pdfBytes: new Uint8Array(200).fill(65),
    docId: "doc-vision",
    describeImage: async (png, page) => {
      described.push(page);
      assert.ok(png.length > 0);
      return "Figure 2: cryo-EM density of the nucleocapsid (panel a: side view).";
    },
  });
  assert.deepEqual(described, [2]);
  assert.match(text, /### Page 2 vision-model annotation/);
  assert.match(text, /cryo-EM density of the nucleocapsid/);
  // The annotation sits inside page 2's section (after its marker text).
  assert.ok(text.indexOf("### Page 2") > text.indexOf("_[No embedded text.]_"));
});

test("extractPdfText without describeImage returns the worker fulltext unchanged, even with vision candidates", async (context) => {
  const root = tempRoot("ke-pdftext-no-vision");
  context.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(root, { recursive: true });
  const workerPath = resolve(root, "fake-worker-plain.cjs");
  await writeFile(workerPath, `
const fs = require("node:fs");
const path = require("node:path");
const [pdf, outDir] = process.argv.slice(2);
if (fs.readdirSync(outDir).length > 0) process.exit(1);
fs.writeFileSync(path.join(outDir, "fulltext.md"), "# Extracted PDF text\\n\\n## Page 1\\n\\n_[No embedded text.]_\\n");
console.log(JSON.stringify({
  textPath: "fulltext.md",
  pages: [{ page: 1, textCharacters: 0, needsVision: true, imageAreaRatio: 0.9, previewPath: "pages/page-0001.png" }],
}));
`);
  const { fulltext: text } = await extractPdfText({
    pythonPath: process.execPath,
    workerPath,
    workDirRoot: resolve(root, "staging"),
    pdfBytes: new Uint8Array(200).fill(65),
    docId: "doc-plain",
  });
  assert.equal(text, "# Extracted PDF text\n\n## Page 1\n\n_[No embedded text.]_\n");
});

test("extractPdfText degrades to warnings when the vision call fails", async (context) => {
  const root = tempRoot("ke-pdftext-vision-fail");
  context.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(root, { recursive: true });
  const workerPath = resolve(root, "fake-worker-vision2.cjs");
  await writeFile(workerPath, `
const fs = require("node:fs");
const path = require("node:path");
const [pdf, outDir] = process.argv.slice(2);
if (fs.readdirSync(outDir).length > 0) process.exit(1);
fs.mkdirSync(path.join(outDir, "pages"), { recursive: true });
fs.writeFileSync(path.join(outDir, "pages", "page-0001.png"), Buffer.from([137, 80, 78, 71]));
fs.writeFileSync(path.join(outDir, "fulltext.md"), "# Extracted PDF text\\n\\n## Page 1\\n\\n_[No embedded text.]_\\n");
console.log(JSON.stringify({
  textPath: "fulltext.md",
  pages: [{ page: 1, textCharacters: 0, needsVision: true, imageAreaRatio: 0.9, previewPath: "pages/page-0001.png" }],
}));
`);
  const warnings: string[] = [];
  const { fulltext: text } = await extractPdfText({
    pythonPath: process.execPath,
    workerPath,
    workDirRoot: resolve(root, "staging"),
    pdfBytes: new Uint8Array(200).fill(65),
    docId: "doc-vision-fail",
    describeImage: async () => {
      throw new Error("vision endpoint down");
    },
    onWarn: (message) => warnings.push(message),
  });
  assert.deepEqual(warnings, ["ke_pdf_vision_page_failed"]);
  assert.doesNotMatch(text, /vision-model annotation/);
});
