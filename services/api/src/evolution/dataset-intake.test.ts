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

/**
 * Taking a dataset in, and describing it well enough for the wizard's next
 * question.
 *
 * The description is the part that can be quietly wrong: a column reported as
 * numeric that is not becomes a run refused at staging, one screen and one
 * round trip later than it needed to be.
 */

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";

import { DatasetIntakeError, ingestDataset } from "./dataset-intake.js";

function fakeCas() {
  const stored: Buffer[] = [];
  return {
    cas: { put: async (content: string | Buffer) => {
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
      stored.push(bytes);
      return { hash: "c".repeat(64), size: bytes.length };
    } },
    stored,
  };
}

async function withFile(name: string, content: string) {
  const root = await mkdtemp(resolve(tmpdir(), "evolve-intake-"));
  await writeFile(resolve(root, name), content, "utf-8");
  return (path: string) => resolve(root, path);
}

test("the columns come back with the hash, so the next question is a dropdown", async () => {
  const { cas } = fakeCas();
  const summary = await ingestDataset({
    cas,
    path: "data.csv",
    resolve: await withFile("data.csv", "x1,name,y\n1,alice,2\n3,bob,4\n"),
  });

  assert.match(summary.cas, /^sha256:c{64}$/);
  assert.deepEqual(summary.columns, ["x1", "name", "y"]);
  assert.equal(summary.rows, 2);
});

test("a text column is not offered as something a metric can score", async () => {
  const { cas } = fakeCas();
  const summary = await ingestDataset({
    cas,
    path: "data.csv",
    resolve: await withFile("data.csv", "x,label,y\n1,alice,2\n3,bob,4\n"),
  });

  // Every metric this engine has is arithmetic on the target. Naming a text
  // column produces a NaN that would be refused at staging instead.
  assert.deepEqual(summary.numericColumns, ["x", "y"]);
});

test("a column that is numeric in the first rows and not later is still caught by staging", async () => {
  const { cas } = fakeCas();
  // The sample is 200 rows, so a file shorter than that is fully checked.
  const rows = Array.from({ length: 5 }, (_, at) => `${at},${at === 4 ? "n/a" : at}`).join("\n");
  const summary = await ingestDataset({
    cas, path: "data.csv", resolve: await withFile("data.csv", `x,y\n${rows}\n`),
  });

  assert.deepEqual(summary.numericColumns, ["x"]);
});

test("a program is taken in whole rather than read as a table", async () => {
  const { cas, stored } = fakeCas();
  const source = "def train_and_predict(a, b):\n    return [1.0]\n";
  const summary = await ingestDataset({
    cas, path: "baseline.py", raw: true, resolve: await withFile("baseline.py", source),
  });

  // Parsing it as CSV would refuse a file that is perfectly fine.
  assert.deepEqual(summary.columns, []);
  assert.equal(summary.rows, 0);
  assert.equal(stored[0]?.toString("utf-8"), source);
});

test("a file with no rows is refused with a reason, not accepted as empty", async () => {
  const { cas } = fakeCas();
  await assert.rejects(
    ingestDataset({ cas, path: "data.csv", resolve: await withFile("data.csv", "x,y\n") }),
    (error: Error) => {
      assert.ok(error instanceof DatasetIntakeError);
      // An empty dataset staged silently would make every candidate score the
      // same and the search look broken for a reason that is not in it.
      assert.match(error.message, /没有数据/);
      return true;
    },
  );
});

test("a path the workspace does not have is refused by name", async () => {
  const { cas } = fakeCas();
  await assert.rejects(
    ingestDataset({ cas, path: "nope.csv", resolve: await withFile("data.csv", "x\n1\n") }),
    DatasetIntakeError,
  );
});
