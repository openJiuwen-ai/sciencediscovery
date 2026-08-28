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
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";

import type { EvolveEvent, EvolveGoal } from "@sciencediscovery/schema";

import { EvolutionStore, makeEventRecords, parseEventLines } from "./store.js";

function temporaryDataDir(name: string): string {
  return resolve(process.cwd(), ".tmp", `${name}-${Date.now()}-${process.pid}`);
}

function goal(overrides: Partial<EvolveGoal> = {}): EvolveGoal {
  return {
    algorithm: "puct",
    baselineProgramCas: "sha256:baseline",
    budget: {
      candidateTimeoutSeconds: 60,
      expansions: 6,
      maxCostCents: 500,
      maxSeconds: 1800,
      maxTokens: 200_000,
      maxTokensPerCall: 16_000,
      workers: 1,
   },
    frozen: ["score.py"],
    modelId: "model-1",
    scorecard: {
      aggregate: "weighted_sum",
      confirmedAt: "2026-08-19T00:00:00.000Z",
      confirmedBy: "tester",
      constraints: [
        { criterionId: "runtime", id: "too-slow", name: "太慢", op: "<", value: 300 },
      ],
      criteria: [
        {
          direction: "maximize",
          id: "f1",
          measure: {
            datasetCas: ["sha256:data"],
            kind: "dataset_metric",
            metric: { direction: "maximize", name: "macro_f1" },
            split: { gateShards: 4, rolloutShards: 4, seed: 0, shardRows: 619, testShards: 4, trainRows: null },
            target: "y",
          },
          name: "宏 F1",
          normalize: { kind: "identity" },
          weight: 1,
        },
      ],
      derivedFrom: { draftRunId: "draft-1", statement: "把准确率做上去" },
      hash: "sha256:card",
      schemaVersion: 1,
      solvedThreshold: 0.999,
    },
    schemaVersion: 2,
    statement: "把准确率做上去",
    target: { entrypoint: "classify.py", kind: "program", programId: "p1" },
    ...overrides,
  };
}

const LOG: EvolveEvent = { level: "info", message: "hello", type: "log" };

test("initialize creates every subdirectory and is idempotent", async () => {
  const dataDir = temporaryDataDir("evolution-init");
  const store = new EvolutionStore(dataDir);
  try {
    await store.initialize();
    await store.initialize();
    for (const directory of ["programs", "runs", "ledger", "results"]) {
      const info = await stat(resolve(dataDir, "evolution", directory));
      assert.ok(info.isDirectory(), `${directory} should exist`);
    }
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("a run stored under the old algorithm name still reads back", async () => {
  // 39 runs on the deployed host were written while the algorithm was called
  // `"era"`, 66 occurrences across their records. Nothing rewrites them, so the
  // read path is the only thing standing between an old run and a panel that
  // opens empty — and it fails silently, because an unknown algorithm string is
  // not an error anywhere downstream, it just matches no branch.
  const dataDir = temporaryDataDir("evolution-legacy-algorithm");
  const store = new EvolutionStore(dataDir);
  try {
    await store.initialize();
    const run = await store.createRun({ goal: goal(), sessionId: "s1" });
    const file = join(dataDir, "evolution", "runs", run.id, "run.json");
    await writeFile(file, (await readFile(file, "utf8")).replaceAll('"puct"', '"era"'));

    const reloaded = await store.readRun(run.id);
    assert.equal(reloaded?.algorithm, "puct");
    assert.equal(reloaded?.goal.algorithm, "puct");
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("a created run round-trips and starts at the zero watermark", async () => {
  const dataDir = temporaryDataDir("evolution-create");
  const store = new EvolutionStore(dataDir);
  try {
    await store.initialize();
    const run = await store.createRun({ goal: goal(), sessionId: "s1" });
    assert.equal(run.status, "pending");
    assert.equal(run.lastSeq, 0);
    assert.equal(run.algorithm, "puct");

    const reloaded = await store.readRun(run.id);
    assert.deepEqual(reloaded, run);
    assert.equal(await store.readRun("missing-run"), undefined);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("listRuns filters by session and returns newest first", async () => {
  const dataDir = temporaryDataDir("evolution-list");
  const store = new EvolutionStore(dataDir);
  try {
    await store.initialize();
    const first = await store.createRun({ goal: goal(), id: "run-a", sessionId: "s1" });
    await new Promise((done) => setTimeout(done, 2));
    const second = await store.createRun({ goal: goal(), id: "run-b", sessionId: "s1" });
    await store.createRun({ goal: goal(), id: "run-c", sessionId: "s2" });

    const mine = await store.listRuns("s1");
    assert.deepEqual(mine.map((run) => run.id), [second.id, first.id]);
    assert.equal((await store.listRuns()).length, 3);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("replaying the same batch is a no-op: the log and the watermark do not move", async () => {
  const dataDir = temporaryDataDir("evolution-replay");
  const store = new EvolutionStore(dataDir);
  try {
    await store.initialize();
    const run = await store.createRun({ goal: goal(), sessionId: "s1" });
    const batch = makeEventRecords(
      [
        { algorithm: "puct", scorecardHash: "sha256:card", type: "search_started" },
        { baselineScore: 0.57, nodeIndex: 0, type: "seeded" },
      ],
      1,
    );

    const first = await store.appendEvents(run.id, batch);
    assert.equal(first.applied.length, 2);
    assert.equal(first.lastSeq, 2);
    assert.equal(first.skipped, 0);

    const replay = await store.appendEvents(run.id, batch);
    assert.equal(replay.applied.length, 0);
    assert.equal(replay.skipped, 2);
    assert.equal(replay.lastSeq, 2);

    const events = await store.readEvents(run.id);
    assert.equal(events.length, 2, "a replayed batch must not duplicate lines");
    assert.equal((await store.readRun(run.id))?.lastSeq, 2);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("a partially replayed batch keeps only the records past the watermark", async () => {
  const dataDir = temporaryDataDir("evolution-overlap");
  const store = new EvolutionStore(dataDir);
  try {
    await store.initialize();
    const run = await store.createRun({ goal: goal(), sessionId: "s1" });
    await store.appendEvents(run.id, makeEventRecords([LOG, LOG], 1));

    const overlapping = await store.appendEvents(run.id, makeEventRecords([LOG, LOG, LOG], 2));
    assert.equal(overlapping.skipped, 1, "sequence 2 was already applied");
    assert.deepEqual(overlapping.applied.map((record) => record.sequence), [3, 4]);

    assert.deepEqual(
      (await store.readEvents(run.id)).map((record) => record.sequence),
      [1, 2, 3, 4],
    );
    assert.deepEqual((await store.readEvents(run.id, 2)).map((record) => record.sequence), [3, 4]);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("a torn tail is skipped without losing the events before it", async () => {
  const dataDir = temporaryDataDir("evolution-torn");
  const store = new EvolutionStore(dataDir);
  try {
    await store.initialize();
    const run = await store.createRun({ goal: goal(), sessionId: "s1" });
    await store.appendEvents(run.id, makeEventRecords([LOG, LOG], 1));
    await appendFile(store.eventLogPath(run.id), '{"sequence":3,"createdAt":"2026-0', "utf8");

    const events = await store.readEvents(run.id);
    assert.deepEqual(events.map((record) => record.sequence), [1, 2]);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("parseEventLines drops records that are not events", () => {
  const records = parseEventLines([
    JSON.stringify({ createdAt: "2026-08-19T00:00:00.000Z", event: LOG, sequence: 1 }),
    JSON.stringify({ createdAt: "2026-08-19T00:00:00.000Z", event: {}, sequence: 2 }),
    JSON.stringify({ createdAt: 7, event: LOG, sequence: 3 }),
    "not json",
    "",
  ].join("\n"));
  assert.deepEqual(records.map((record) => record.sequence), [1]);
});

test("concurrent appends and patches do not lose each other's fields", async () => {
  const dataDir = temporaryDataDir("evolution-concurrent");
  const store = new EvolutionStore(dataDir);
  try {
    await store.initialize();
    const run = await store.createRun({ goal: goal(), sessionId: "s1" });

    await Promise.all([
      store.appendEvents(run.id, makeEventRecords([LOG], 1)),
      store.patchRun(run.id, { status: "running", startedAt: "2026-08-19T00:00:00.000Z" }),
      store.appendEvents(run.id, makeEventRecords([LOG], 2)),
      store.patchRun(run.id, { candidates: 7 }),
    ]);

    const reloaded = await store.readRun(run.id);
    assert.equal(reloaded?.status, "running");
    assert.equal(reloaded?.candidates, 7);
    assert.equal(reloaded?.lastSeq, 2, "the watermark must survive an interleaved patch");
    assert.equal((await store.readEvents(run.id)).length, 2);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("finishRun stamps a terminal status and refuses an active one", async () => {
  const dataDir = temporaryDataDir("evolution-finish");
  const store = new EvolutionStore(dataDir);
  try {
    await store.initialize();
    const run = await store.createRun({ goal: goal(), sessionId: "s1" });
    const finished = await store.finishRun(run.id, "succeeded");
    assert.equal(finished.status, "succeeded");
    assert.ok(finished.finishedAt);

    await assert.rejects(() => store.finishRun(run.id, "running"), /Not a terminal status/);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("run ids that could escape the data directory are refused", async () => {
  const dataDir = temporaryDataDir("evolution-ids");
  const store = new EvolutionStore(dataDir);
  try {
    await store.initialize();
    for (const id of ["../escape", "a/b", "", ".hidden"]) {
      await assert.rejects(
        () => store.createRun({ goal: goal(), id, sessionId: "s1" }),
        /Invalid evolve run id/,
        `should refuse ${JSON.stringify(id)}`,
      );
    }
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("deleteRun removes the run, its log, its ledger and its results", async () => {
  const dataDir = temporaryDataDir("evolution-delete");
  const store = new EvolutionStore(dataDir);
  try {
    await store.initialize();
    const run = await store.createRun({ goal: goal(), sessionId: "s1" });
    await store.appendEvents(run.id, makeEventRecords([LOG], 1));
    await mkdir(store.ledgerDirectory(run.id), { recursive: true });
    await writeLedgerMarker(store.ledgerDirectory(run.id));

    await store.deleteRun(run.id);

    assert.equal(await store.readRun(run.id), undefined);
    assert.deepEqual(await store.readEvents(run.id), []);
    await assert.rejects(() => stat(store.ledgerDirectory(run.id)));
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

async function writeLedgerMarker(directory: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(resolve(directory, "HEAD"), "dev\n", "utf8");
  await readFile(resolve(directory, "HEAD"), "utf8");
}
