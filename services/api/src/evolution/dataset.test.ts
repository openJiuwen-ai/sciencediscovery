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
 * Staging, from the angle that can silently ruin every score downstream.
 *
 * A split that quietly overlaps, a shuffle that is not reproducible, a test file
 * that still carries the answer — none of these fail loudly. They produce a
 * number, and the number is believed.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, test } from "node:test";

import type { EvolveScorecard, EvolveSplit, ScorecardCriterion } from "@sciencediscovery/schema";

import {
  DatasetStagingError, casHash, parseCsv, planSplit, shuffled, stageDataset, toCsv, validateSplit,
} from "./dataset.js";

const SPLIT: EvolveSplit = {
  gateShards: 2, rolloutShards: 2, seed: 7, shardRows: 3, testShards: 1, trainRows: null,
};

function criterion(overrides: Partial<EvolveSplit> = {}, target = "y"): ScorecardCriterion {
  return {
    direction: "maximize", id: "acc", name: "accuracy",
    measure: {
      datasetCas: ["sha256:" + "a".repeat(64)], kind: "dataset_metric",
      metric: { direction: "maximize", name: "accuracy" },
      split: { ...SPLIT, ...overrides }, target,
    },
    normalize: { kind: "identity" }, weight: 1,
  };
}

function scorecard(criteria: ScorecardCriterion[]): EvolveScorecard {
  return {
    aggregate: "weighted_sum", confirmedAt: "", confirmedBy: "", constraints: [],
    criteria, derivedFrom: { draftRunId: "", statement: "" },
    hash: "sha256:card", schemaVersion: 1, solvedThreshold: 0.999,
  };
}

/** A CSV of `rows` rows, with a target column whose value is the row number. */
function csv(rows: number): string {
  const lines = ["x1,x2,y"];
  for (let index = 0; index < rows; index += 1) lines.push(`${index},${index * 2},${index}`);
  return lines.join("\n") + "\n";
}

function fakeCas(content: Record<string, string>) {
  return {
    has: async (hash: string) => hash in content,
    hash: () => "",
    put: async () => ({ hash: "", size: 0 }),
    read: async (hash: string) => {
      const found = content[hash];
      if (found === undefined) throw new Error("ENOENT");
      return Buffer.from(found, "utf-8");
    },
    verify: async () => true,
  };
}

async function scratch(name: string): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), `evolve-${name}-`));
  after(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

// --- The split --------------------------------------------------------------

test("nothing measured was trained on", () => {
  const plan = planSplit(40, SPLIT);

  const train = new Set(plan.trainRows);
  const measured = plan.shards.flatMap((shard) => shard.rows);
  // A candidate measured on rows it trained on is scoring its own memory.
  for (const row of measured) assert.equal(train.has(row), false, `row ${row} is in both`);
  assert.equal(new Set(measured).size, measured.length, "no row is in two shards");
  assert.equal(train.size + measured.length, 40, "every row is used exactly once");
});

test("the same seed stages the same split", () => {
  // Two runs of the same goal must measure on the same rows, or a search cannot
  // be compared with its own baseline, let alone with another run.
  assert.deepEqual(planSplit(40, SPLIT), planSplit(40, SPLIT));
  assert.notDeepEqual(planSplit(40, SPLIT), planSplit(40, { ...SPLIT, seed: 8 }));
});

test("the shuffle is a permutation, not a sample", () => {
  const order = shuffled(200, 3);
  assert.equal(new Set(order).size, 200);
  assert.deepEqual([...order].sort((a, b) => a - b), Array.from({ length: 200 }, (_, i) => i));
  // A dataset sorted by its target would otherwise hand the gate a slice with
  // no variance in it.
  assert.notDeepEqual(order, Array.from({ length: 200 }, (_, i) => i));
});

test("roles are assigned in the order the scorecard asked for", () => {
  const plan = planSplit(40, SPLIT);
  assert.deepEqual(plan.shards.map((shard) => shard.role),
    ["rollout", "rollout", "gate", "gate", "test"]);
  for (const shard of plan.shards) assert.equal(shard.rows.length, SPLIT.shardRows);
});

test("a dataset too small for the requested shards is refused with the numbers", () => {
  assert.throws(() => planSplit(10, SPLIT), (error: Error) => {
    assert.ok(error instanceof DatasetStagingError);
    // The numbers, so the user can see which knob to turn.
    assert.match(error.message, /10 rows/);
    assert.match(error.message, /15 in total/);
    return true;
  });
});

test("a split that could not fit any dataset is caught without one", () => {
  assert.ok(validateSplit({ ...SPLIT, shardRows: 0 }));
  assert.ok(validateSplit({ ...SPLIT, gateShards: 0, rolloutShards: 0, testShards: 0 }));
  assert.ok(validateSplit({ ...SPLIT, trainRows: 0 }));
  assert.equal(validateSplit(SPLIT), undefined);
});

test("an explicit train size is honoured and still leaves the shards room", () => {
  const plan = planSplit(40, { ...SPLIT, trainRows: 20 });
  assert.equal(plan.trainRows.length, 20);
  assert.throws(() => planSplit(20, { ...SPLIT, trainRows: 19 }), DatasetStagingError);
});

// --- CSV --------------------------------------------------------------------

test("a quoted field survives the round trip", () => {
  // A target column containing a comma is ordinary, and a parser that splits on
  // commas would shift every column after it.
  const text = 'a,b\n"x,1","he said ""hi"""\nplain,2\n';
  const table = parseCsv(text);
  assert.deepEqual(table.header, ["a", "b"]);
  assert.deepEqual(table.rows, [["x,1", 'he said "hi"'], ["plain", "2"]]);
  assert.deepEqual(parseCsv(toCsv(table.header, table.rows)).rows, table.rows);
});

test("a trailing newline is not a row", () => {
  assert.equal(parseCsv("a,b\n1,2\n").rows.length, 1);
  assert.equal(parseCsv("a,b\n1,2").rows.length, 1);
  assert.equal(parseCsv("a,b\r\n1,2\r\n").rows.length, 1);
});

test("a cas ref is accepted with or without its algorithm prefix", () => {
  assert.equal(casHash("sha256:abc"), "abc");
  assert.equal(casHash("abc"), "abc");
});

// --- Staging ----------------------------------------------------------------

test("the candidate is given the features and never the answer", async () => {
  const hash = "a".repeat(64);
  const directory = await scratch("stage");
  await stageDataset({
    cas: fakeCas({ [hash]: csv(40) }),
    directory,
    scorecard: scorecard([criterion()]),
  });

  const test0 = parseCsv(await readFile(resolve(directory, "acc/0/test.csv"), "utf-8"));
  // The target column is gone from what the candidate reads. A candidate that
  // can read the answer key optimises for reading it, and scores perfectly.
  assert.deepEqual(test0.header, ["x1", "x2"]);
  const truth = JSON.parse(await readFile(resolve(directory, "acc/0/truth.json"), "utf-8")) as number[];
  assert.equal(truth.length, SPLIT.shardRows);
  // Truth is the target column of exactly those rows: the fixture's y equals
  // the row number, and x1 does too.
  assert.deepEqual(truth, test0.rows.map((row) => Number(row[0])));

  // The train file keeps the target — that is what training means.
  const train = parseCsv(await readFile(resolve(directory, "acc/train.csv"), "utf-8"));
  assert.deepEqual(train.header, ["x1", "x2", "y"]);
  assert.equal(train.rows.length, 40 - 5 * SPLIT.shardRows);
});

test("the manifest names every shard and its role", async () => {
  const hash = "a".repeat(64);
  const directory = await scratch("manifest");
  await stageDataset({
    cas: fakeCas({ [hash]: csv(40) }),
    directory,
    scorecard: scorecard([criterion()]),
  });

  const manifest = JSON.parse(
    await readFile(resolve(directory, "manifest.json"), "utf-8"),
  ) as { criteria: Record<string, { shards: Array<{ role: string; test: string; train: string }> }> };

  const shards = manifest.criteria.acc!.shards;
  assert.equal(shards.length, 5);
  assert.deepEqual(shards.map((shard) => shard.role),
    ["rollout", "rollout", "gate", "gate", "test"]);
  // Every shard trains on the same file and tests on its own: the sidecar reads
  // this rather than re-deriving which rows are a gate shard.
  assert.equal(new Set(shards.map((shard) => shard.train)).size, 1);
  assert.equal(new Set(shards.map((shard) => shard.test)).size, 5);
});

test("a criterion measured on time needs no dataset staged", async () => {
  const directory = await scratch("seconds");
  const seconds: ScorecardCriterion = {
    direction: "minimize", id: "secs", name: "training time",
    measure: {
      datasetCas: [], kind: "dataset_metric",
      metric: { direction: "minimize", name: "seconds" },
      split: SPLIT, target: "",
    },
    normalize: { kind: "identity" }, weight: 0,
  };

  const staged = await stageDataset({
    cas: fakeCas({}), directory, scorecard: scorecard([seconds]),
  });

  // This is what makes a "training time under 300s" veto expressible without a
  // dataset behind it.
  assert.deepEqual(staged.staged, []);
  const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf-8")) as {
    criteria: Record<string, unknown>;
  };
  assert.deepEqual(manifest.criteria, {});
});

test("a target column that is not in the file is refused by name", async () => {
  const hash = "a".repeat(64);
  const directory = await scratch("target");
  await assert.rejects(
    stageDataset({
      cas: fakeCas({ [hash]: csv(40) }),
      directory,
      scorecard: scorecard([criterion({}, "price")]),
    }),
    (error: Error) => {
      assert.ok(error instanceof DatasetStagingError);
      assert.match(error.message, /price/);
      // The columns that *are* there, so the user can see the typo.
      assert.match(error.message, /x1, x2, y/);
      return true;
    },
  );
});

test("a non-numeric target value is refused rather than staged as NaN", async () => {
  const hash = "a".repeat(64);
  const directory = await scratch("nan");
  await assert.rejects(
    stageDataset({
      cas: fakeCas({ [hash]: "x1,y\n1,ok\n2,3\n" + "3,4\n".repeat(30) }),
      directory,
      scorecard: scorecard([criterion({ shardRows: 2 })]),
    }),
    // A NaN in the truth poisons every metric computed against it and still
    // comes back looking like a number.
    DatasetStagingError,
  );
});

test("a dataset that is not in the store is named, not swallowed", async () => {
  const directory = await scratch("missing");
  await assert.rejects(
    stageDataset({ cas: fakeCas({}), directory, scorecard: scorecard([criterion()]) }),
    (error: Error) => {
      assert.ok(error instanceof DatasetStagingError);
      assert.match(error.message, /not in the content store/);
      return true;
    },
  );
});


