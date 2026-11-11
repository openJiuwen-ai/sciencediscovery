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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import type { EvolveGoal } from "@sciencediscovery/schema";

import { exportEvolveRuns, restoreEvolveRuns } from "./package.js";
import { EvolutionStore } from "./store.js";

function temporaryDataDir(name: string): string {
  return resolve(process.cwd(), ".tmp", `${name}-${Date.now()}-${process.pid}`);
}

function goal(statement = "Push the accuracy up"): EvolveGoal {
  return {
    algorithm: "puct",
    baselineProgramCas: "sha256:baseline",
    budget: {
      candidateTimeoutSeconds: 60,
      expansions: 6,
      maxCostCents: 500,
      maxSeconds: 1_800,
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
      constraints: [],
      criteria: [],
      derivedFrom: { draftRunId: "draft-1", statement },
      hash: "sha256:card",
      schemaVersion: 1,
      solvedThreshold: 0.999,
    },
    schemaVersion: 2,
    statement,
    target: { entrypoint: "classify.py", kind: "program", programId: "p1" },
  } as unknown as EvolveGoal;
}

test("a session's evolve runs travel with their event log and come back under the new session", async (context) => {
  const sourceDir = temporaryDataDir("evolution-package-export");
  const targetDir = temporaryDataDir("evolution-package-import");
  context.after(() => rm(sourceDir, { force: true, recursive: true }));
  context.after(() => rm(targetDir, { force: true, recursive: true }));
  const source = new EvolutionStore(sourceDir);
  const target = new EvolutionStore(targetDir);
  const run = await source.createRun({ goal: goal(), id: "run-1", sessionId: "session-source", createdAt: "2026-08-19T00:00:03.000Z" });
  await source.appendEvents("run-1", [
    { createdAt: "2026-08-19T00:00:01.000Z", event: { level: "info", message: "started", type: "log" } as never, sequence: 1 },
  ]);
  await source.patchRun("run-1", { candidates: 7, status: "succeeded", tokens: 1_234 });
  // A run of another session must not be packed.
  await source.createRun({ goal: goal(), id: "run-2", sessionId: "session-other" });

  const packed = await exportEvolveRuns(source, ["session-source"]);
  assert.deepEqual(packed.runs.map((entry) => entry.run.id), ["run-1"]);
  assert.equal(packed.truncated, 0);
  assert.equal(packed.runs[0]!.events.length, 1);
  assert.equal(packed.runs[0]!.run.tokens, 1_234);

  const restored = await restoreEvolveRuns(target, { projectId: "project-1", sessionId: "session-imported" }, { runs: packed.runs });
  assert.equal(restored.restored, 1);
  assert.deepEqual(restored.omissions, []);
  const back = await target.readRun("run-1");
  assert.equal(back?.sessionId, "session-imported", "the copy belongs to the imported session");
  assert.equal(back?.projectId, "project-1");
  assert.equal(back?.status, "succeeded");
  assert.equal(back?.candidates, 7);
  assert.equal(back?.tokens, 1_234);
  assert.equal(back?.createdAt, "2026-08-19T00:00:03.000Z", "the run keeps its own timestamp, not the import time");
  assert.equal((await target.readEvents("run-1")).length, 1, "the search tree survives the trip");
  assert.equal(back?.goal.statement, run.goal.statement);
});

test("a run that was still executing at export time is restored as stopped", async (context) => {
  const dir = temporaryDataDir("evolution-package-active");
  context.after(() => rm(dir, { force: true, recursive: true }));
  const store = new EvolutionStore(dir);
  await store.createRun({ goal: goal(), id: "run-a", sessionId: "s" });
  await store.patchRun("run-a", { status: "running" });
  const packed = await exportEvolveRuns(store, ["s"]);
  const freshDir = temporaryDataDir("evolution-package-active-import");
  context.after(() => rm(freshDir, { force: true, recursive: true }));
  const fresh = new EvolutionStore(freshDir);
  const restored = await restoreEvolveRuns(fresh, { sessionId: "s2" }, { runs: packed.runs });
  assert.equal(restored.restored, 1);
  // Nothing can advance it here, so presenting it as running would lie.
  assert.equal((await fresh.readRun("run-a"))?.status, "stopped");
});

test("an existing run id is never overwritten by a second import", async (context) => {
  const sourceDir = temporaryDataDir("evolution-package-dup-source");
  const targetDir = temporaryDataDir("evolution-package-dup-target");
  context.after(() => rm(sourceDir, { force: true, recursive: true }));
  context.after(() => rm(targetDir, { force: true, recursive: true }));
  const source = new EvolutionStore(sourceDir);
  const target = new EvolutionStore(targetDir);
  await source.createRun({ goal: goal(), id: "run-1", sessionId: "session-source" });
  const packed = await exportEvolveRuns(source, ["session-source"]);

  assert.equal((await restoreEvolveRuns(target, { sessionId: "first" }, { runs: packed.runs })).restored, 1);
  const second = await restoreEvolveRuns(target, { sessionId: "second" }, { runs: packed.runs });
  assert.equal(second.restored, 0);
  assert.equal(second.omissions.length, 1);
  assert.match(second.omissions[0]!, /^evolve:run-1:run id already exists here/);
  assert.equal((await target.readRun("run-1"))?.sessionId, "first", "the first import keeps its run");
});

test("a malformed evolve record degrades to an omission instead of failing the import", async (context) => {
  const dir = temporaryDataDir("evolution-package-bad");
  context.after(() => rm(dir, { force: true, recursive: true }));
  const store = new EvolutionStore(dir);

  const notAList = await restoreEvolveRuns(store, { sessionId: "s" }, { runs: "nope" });
  assert.deepEqual(notAList.omissions, ["evolve:package carries an evolve record that is not a run list"]);

  const badId = await restoreEvolveRuns(store, { sessionId: "s" }, { runs: [{ run: { id: "../etc/passwd", status: "succeeded" } }] });
  assert.equal(badId.restored, 0);
  assert.deepEqual(badId.omissions, ["evolve:package carries a run with an invalid id"]);

  const noGoal = await restoreEvolveRuns(store, { sessionId: "s" }, { runs: [{ run: { id: "run-9", status: "succeeded" } }] });
  assert.equal(noGoal.restored, 0);
  assert.deepEqual(noGoal.omissions, ["evolve:run-9:missing the run goal"]);

  const statementOnly = await restoreEvolveRuns(store, { sessionId: "s" }, { runs: [{ run: { id: "run-10", status: "succeeded", goal: { algorithm: "puct", statement: "a statement with no budget" } } }] });
  assert.equal(statementOnly.restored, 0);
  assert.deepEqual(statementOnly.omissions, ["evolve:run-10:invalid run goal"]);
});
