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
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { extractPdfText } from "./pdf-text.js";

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

  const text = await extractPdfText({
    pythonPath,
    workerPath,
    workDirRoot: resolve(root, "staging"),
    pdfBytes: new Uint8Array(200).fill(65),
    docId: "doc-1",
  });
  assert.match(text, /body text here/);
  // Staging is cleaned up afterwards.
  assert.equal(existsSync(resolve(root, "staging", "doc-1")), false);
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
