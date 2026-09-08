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
import test from "node:test";

import { MAX_ARTIFACT_TEXT_BYTES, projectArtifactContent } from "./artifact-read.js";

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
  Buffer.alloc(4_096, 9),
]);

const PDB_TEXT = [
  "HEADER    HYDROLASE                               17-MAY-16   5FHC",
  "ATOM      1  N   MET A   1      38.428  17.323  25.061  1.00 41.28           N",
  "END",
].join("\n");

test("a binary version returns type and size, never a body or base64", () => {
  const projection = projectArtifactContent(PNG_BYTES, "image/png");
  assert.equal(projection.binary, true);
  assert.equal(projection.encoding, "binary");
  assert.equal(projection.content, undefined);
  assert.equal(projection.size, PNG_BYTES.length);
  assert.equal(JSON.stringify(projection).includes(PNG_BYTES.toString("base64").slice(0, 24)), false);
});

test("an unlabeled binary upload is caught by its bytes", () => {
  const projection = projectArtifactContent(PNG_BYTES, "application/octet-stream");
  assert.equal(projection.binary, true);
  assert.equal(projection.content, undefined);
});

test("a PDB version is text even though its media type is not text/*", () => {
  const projection = projectArtifactContent(Buffer.from(`${PDB_TEXT}\n`, "utf8"), "chemical/x-pdb");
  assert.equal(projection.binary, false);
  assert.equal(projection.encoding, "utf8");
  assert.equal(projection.content, `${PDB_TEXT}\n`);
  assert.equal(projection.page?.totalLines, 3);
  assert.equal(projection.page?.hasMore, false);
});

test("a text version is paged and reports where to continue", () => {
  const bytes = Buffer.from(Array.from({ length: 5_000 }, (_, index) => `row-${index + 1}`).join("\n"), "utf8");

  const first = projectArtifactContent(bytes, "text/csv", { limit: 100 });
  assert.equal(first.page?.startLine, 1);
  assert.equal(first.page?.endLine, 100);
  assert.equal(first.page?.hasMore, true);
  assert.equal(first.page?.nextOffset, 101);
  assert.equal(first.page?.totalLines, 5_000);
  assert.equal(first.content?.startsWith("row-1\n"), true);
  assert.equal(first.content?.includes("row-101"), false);

  const next = projectArtifactContent(bytes, "text/csv", { limit: 100, offset: 101 });
  assert.equal(next.content?.startsWith("row-101\n"), true);
});

test("a page stays under the model-facing byte budget whatever limit is asked for", () => {
  const bytes = Buffer.from(`${"c".repeat(2_000)}\n`.repeat(1_000), "utf8");
  const projection = projectArtifactContent(bytes, "text/plain", { limit: 10_000 });
  assert.ok((projection.page?.bytes ?? 0) <= 40 * 1_024 + 2_001, `page is ${projection.page?.bytes} bytes`);
  assert.equal(projection.page?.hasMore, true);
});

test("paging stops at the decodable text window instead of promising a page no offset can reach", () => {
  // 9500 lines of exactly 1000 bytes: larger than the 8 MiB text window, so the
  // window ends part-way through a line and 1111 lines fall outside it.
  const bytes = Buffer.from(`${"x".repeat(999)}\n`.repeat(9_500), "utf8");
  assert.ok(bytes.length > MAX_ARTIFACT_TEXT_BYTES);
  const windowLines = 8_389;

  const first = projectArtifactContent(bytes, "text/csv", { limit: 40 });
  assert.equal(first.truncated, true, "the version is larger than the text window");
  assert.equal(first.page?.totalLines, windowLines, "totalLines counts the window, not the whole version");
  assert.match(String(first.note), /Only the first 8388608 bytes/);
  assert.match(String(first.note), /offset cannot reach past line 8389/);
  assert.match(String(first.note), /Process the rest with run_shell/);
  assert.doesNotMatch(String(first.note), /run_python|run_r\b/);

  // Walking the protocol has to terminate: every nextOffset must advance.
  let offset = 1;
  let steps = 0;
  let lastEndLine = 0;
  while (steps < 1_000) {
    steps += 1;
    const page = projectArtifactContent(bytes, "text/csv", { limit: 40, offset }).page!;
    assert.equal(page.startLine, offset);
    if (!page.hasMore) {
      lastEndLine = page.endLine;
      assert.equal(page.nextOffset, undefined, "a final page carries no next offset");
      break;
    }
    assert.ok(page.nextOffset! > offset, `nextOffset ${page.nextOffset} must advance past ${offset}`);
    offset = page.nextOffset!;
  }
  assert.ok(steps < 1_000, "paging terminated");
  assert.equal(lastEndLine, windowLines, "paging reached the last line inside the window");

  // The reviewer's repro: offsets past the window used to return
  // hasMore=true with nextOffset equal to the offset just used.
  for (const beyond of [windowLines + 1, windowLines + 5, 11_500]) {
    const projection = projectArtifactContent(bytes, "text/csv", { limit: 40, offset: beyond });
    assert.equal(projection.content, "");
    assert.equal(projection.page?.hasMore, false, `offset ${beyond} is past the window and cannot advance`);
    assert.equal(projection.page?.nextOffset, undefined);
  }
});

test("an over-wide line reports that offsets cannot reach its remainder", () => {
  const bytes = Buffer.from(`${"j".repeat(200_000)}\nsecond\n`, "utf8");

  const page = projectArtifactContent(bytes, "application/json", { limit: 2_000 });
  assert.equal(page.page?.partialLine, true);
  assert.ok((page.page?.bytes ?? 0) <= 40 * 1_024);
  assert.equal(page.page?.hasMore, true, "line 2 is still reachable by offset");
  assert.equal(page.page?.nextOffset, 2);
  assert.match(String(page.note), /Line 1 is wider than one page and was cut/);
  assert.match(String(page.note), /read it with run_shell instead/);
  assert.doesNotMatch(String(page.note), /run_python|run_r\b/);
  assert.equal(page.truncated, false, "the version fits the text window; only the page was cut");
});
