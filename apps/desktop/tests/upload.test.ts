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

import { carriesFiles, formatByteLimit, splitBySize } from "../src/app/upload.js";

/** Only the two fields the size check reads; a real `File` has neither a name
 *  the test controls nor a size it can set. */
function sized(name: string, size: number): { name: string; size: number } {
  return { name, size };
}

test("a limit is written the way it is configured, not to one decimal", () => {
  assert.equal(formatByteLimit(1_073_741_824), "1 GiB");
  assert.equal(formatByteLimit(512 * 1024 * 1024), "512 MiB");
  assert.equal(formatByteLimit(1024), "1 KiB");
  assert.equal(formatByteLimit(999), "999 B");
});

test("a non-positive limit is no limit, and says so by saying nothing", () => {
  // The server reads its own quota this way, so the app has to hand the
  // wording back to its caller rather than invent "0 B" — a limit of zero
  // bytes is the opposite of what it means.
  assert.equal(formatByteLimit(0), undefined);
  assert.equal(formatByteLimit(-1), undefined);
});

test("files are split at the limit, keeping the order they were chosen in", () => {
  const files = [sized("a.csv", 10), sized("b.csv", 100), sized("c.csv", 11)];
  const { accepted, oversized } = splitBySize(files, 11);
  assert.deepEqual(accepted.map((file) => file.name), ["a.csv", "c.csv"]);
  assert.deepEqual(oversized.map((file) => file.name), ["b.csv"]);
});

test("a file exactly at the limit is accepted", () => {
  const { accepted, oversized } = splitBySize([sized("exact.csv", 11)], 11);
  assert.equal(accepted.length, 1);
  assert.equal(oversized.length, 0);
});

test("a limit of zero accepts everything rather than refusing everything", () => {
  const files = [sized("huge.tar", 5_000_000_000)];
  const { accepted, oversized } = splitBySize(files, 0);
  assert.equal(accepted.length, 1);
  assert.equal(oversized.length, 0);
});

test("only a drag carrying files can become an upload", () => {
  assert.equal(carriesFiles(["Files"]), true);
  // A drag of selected text fires the same window events; treating it as an
  // upload would promise a drop that can never arrive.
  assert.equal(carriesFiles(["text/plain"]), false);
  assert.equal(carriesFiles([]), false);
  assert.equal(carriesFiles(["text/plain", "Files"]), true);
});
