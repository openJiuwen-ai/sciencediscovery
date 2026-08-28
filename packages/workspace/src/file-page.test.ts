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
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { detectBinaryFile, guessMediaType, isBinaryContent, readTextFilePage } from "./file-page.js";

/** First bytes of a real PNG: signature, IHDR length, and chunk type. */
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);

/** Two ATOM records in the fixed-column PDB format; plain ASCII throughout. */
const PDB_SAMPLE = [
  "HEADER    HYDROLASE                               17-MAY-16   5FHC",
  "ATOM      1  N   MET A   1      38.428  17.323  25.061  1.00 41.28           N",
  "ATOM      2  CA  MET A   1      37.222  16.512  25.212  1.00 40.55           C",
  "END",
].join("\n");

let sequence = 0;

async function fixtureDirectory(context: { after(fn: () => unknown): void }): Promise<string> {
  const root = resolve(process.cwd(), ".tmp", `file-page-${process.pid}-${Date.now()}-${sequence += 1}`);
  await mkdir(root, { recursive: true });
  context.after(() => rm(root, { force: true, recursive: true }));
  return root;
}

test("classification is content-based, so scientific text formats stay readable", () => {
  assert.equal(isBinaryContent(Buffer.from(PDB_SAMPLE, "utf8")), false, "a PDB structure is text");
  assert.equal(isBinaryContent(Buffer.from("id,value\n1,2\n", "utf8")), false);
  assert.equal(isBinaryContent(Buffer.from(">seq1\nMKVLAA\n", "utf8")), false, "a FASTA record is text");
  assert.equal(isBinaryContent(Buffer.from("温度,压力\n300,1\n", "utf8")), false, "valid UTF-8 is text");
  assert.equal(isBinaryContent(Buffer.alloc(0)), false, "an empty file is not binary");

  assert.equal(isBinaryContent(PNG_HEADER), true, "a NUL byte means binary");
  assert.equal(isBinaryContent(Buffer.from([0xff, 0xfe, 0xfd, 0xfc])), true, "invalid UTF-8 means binary");
});

test("a code point split by the sniff window is not mistaken for binary", () => {
  const split = Buffer.from("温度", "utf8").subarray(0, 4);
  assert.equal(isBinaryContent(split, true), false, "a partial sample tolerates a cut code point");
  assert.equal(isBinaryContent(split, false), true, "a whole file ending mid code point is invalid UTF-8");
});

test("media types cover the scientific formats the agent reads", () => {
  assert.equal(guessMediaType("lab/5FHC.pdb"), "chemical/x-pdb");
  assert.equal(guessMediaType("out/plot.PNG"), "image/png");
  assert.equal(guessMediaType("data/table.csv"), "text/csv");
  assert.equal(guessMediaType("model/weights.unknown"), "application/octet-stream");
});

test("a PDB file on disk reads as text and a PNG reads as binary", async (context) => {
  const root = await fixtureDirectory(context);
  await writeFile(resolve(root, "5FHC.pdb"), `${PDB_SAMPLE}\n`);
  await writeFile(resolve(root, "plot.png"), Buffer.concat([PNG_HEADER, Buffer.alloc(512, 7)]));

  assert.equal(await detectBinaryFile(resolve(root, "5FHC.pdb")), false);
  assert.equal(await detectBinaryFile(resolve(root, "plot.png")), true);
});

test("a whole small file is returned byte-identically", async (context) => {
  const root = await fixtureDirectory(context);
  const body = "alpha\nbeta\n";
  await writeFile(resolve(root, "notes.txt"), body);

  const page = await readTextFilePage(resolve(root, "notes.txt"));
  assert.equal(page.text, body);
  assert.equal(page.hasMore, false);
  assert.equal(page.totalLines, 2);
  assert.equal(page.startLine, 1);
  assert.equal(page.endLine, 2);
});

test("a large file is paged by line without being loaded whole", async (context) => {
  const root = await fixtureDirectory(context);
  const path = resolve(root, "big.log");
  await writeFile(path, Array.from({ length: 10_000 }, (_, index) => `line-${index + 1}`).join("\n"));

  const first = await readTextFilePage(path, { limit: 100 });
  assert.equal(first.startLine, 1);
  assert.equal(first.endLine, 100);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextOffset, 101);
  assert.equal(first.totalLines, undefined, "an early stop cannot know the file's total line count");
  assert.equal(first.text.startsWith("line-1\n"), true);
  assert.equal(first.text.endsWith("line-100\n"), true);

  const next = await readTextFilePage(path, { limit: 100, offset: first.nextOffset });
  assert.equal(next.text.startsWith("line-101\n"), true);

  const tail = await readTextFilePage(path, { limit: 100, offset: 9_951 });
  assert.equal(tail.hasMore, false);
  assert.equal(tail.totalLines, 10_000);
  assert.equal(tail.text.endsWith("line-10000"), true);
});

test("the default page is capped by bytes, not only by line count", async (context) => {
  const root = await fixtureDirectory(context);
  const path = resolve(root, "wide.txt");
  await writeFile(path, `${"w".repeat(1_000)}\n`.repeat(500));

  const page = await readTextFilePage(path);
  assert.ok(page.bytes <= 40 * 1_024, `page is ${page.bytes} bytes`);
  assert.equal(page.hasMore, true);
  assert.equal(page.partialLine, false);
});

test("one line wider than a page is cut and flagged so the caller can redirect", async (context) => {
  const root = await fixtureDirectory(context);
  const path = resolve(root, "single-line.json");
  await writeFile(path, "x".repeat(200_000));

  const page = await readTextFilePage(path);
  assert.equal(page.partialLine, true);
  assert.equal(page.hasMore, true);
  assert.ok(page.bytes <= 40 * 1_024);
});

test("an offset past the end returns an empty page instead of failing", async (context) => {
  const root = await fixtureDirectory(context);
  const path = resolve(root, "short.txt");
  await writeFile(path, "only\n");

  const page = await readTextFilePage(path, { offset: 50 });
  assert.equal(page.text, "");
  assert.equal(page.hasMore, false);
  assert.equal(page.endLine, 49);
});
