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


import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { appendEvolveDirection, type EvolveGoal, type EvolveRunProposal } from "@sciencediscovery/schema";
import { offlineMcpTransport } from "../mcp/offline-transport.fixture.js";
import { loadServerConfig, repositoryRoot } from "./config.js";

import { createPlatformServices, evolveArtifactName } from "./platform.js";

function goalWith(target: EvolveGoal["target"]): EvolveGoal {
  return { target } as EvolveGoal;
}

test("each run's result artifact gets its own name and does not merge across runs", () => {
  // Measured before the fix: every scripted search's entrypoint is the literal
  // `candidate.py`, so compression, peak-detection and enzyme-kinetics runs in
  // one project piled into a single artifact ten versions deep — interleaved
  // with versions the sessions' own agents had declared under that name.
  const enzyme = evolveArtifactName({
    goal: goalWith({ entrypoint: "candidate.py", kind: "program", programId: "x" }),
    id: "23601271-aaaa-bbbb-cccc-000000000000",
  });
  const peaks = evolveArtifactName({
    goal: goalWith({ entrypoint: "candidate.py", kind: "program", programId: "y" }),
    id: "1181371b-aaaa-bbbb-cccc-000000000000",
  });
  assert.equal(enzyme, "evolve/23601271/candidate.py");
  assert.notEqual(enzyme, peaks);
});

test("a text goal and an invalid entrypoint path each land somewhere of their own", () => {
  const text = evolveArtifactName({
    goal: goalWith({ contentCas: "sha256:x", kind: "text", label: "abstract" }),
    id: "abcd1234-0000-0000-0000-000000000000",
  });
  assert.equal(text, "evolve/abcd1234/evolved.md");
  const dodgy = evolveArtifactName({
    goal: goalWith({ entrypoint: "../../etc/passwd", kind: "program", programId: "z" }),
    id: "deadbeef-0000-0000-0000-000000000000",
  });
  assert.equal(dodgy, "evolve/deadbeef/result.txt");
});

test("Evolve binds the latest user scope to the scored baseline and refuses incompatible proposals", async context => {
  const dataDir = await mkdtemp(resolve(tmpdir(), "evolve-platform-scope-"));
  const config = loadServerConfig({ SCIENCE_AGENT_DATA_DIR: dataDir });
  const platform = createPlatformServices(config, repositoryRoot, { mcpTransport: offlineMcpTransport });
  const { store, evolveAvailability, evolveOrchestrator, evolutionStore } = platform;
  context.after(async () => {
    store.close();
    await rm(dataDir, { force: true, recursive: true });
  });
  await store.load();
  await evolutionStore.initialize();
  const model = await store.createModel({
    apiToken: "test-token", baseUrl: "http://127.0.0.1:1/v1", model: "fixture", name: "Fixture",
  });
  const project = await store.createProject("Scope test");
  const session = await store.createSession(project.id, "Tune policy", { modelId: model.id });
  context.mock.getter(evolveAvailability, "ready", () => true);
  context.mock.method(evolveAvailability, "connection", async () => config.evolve);
  const sandbox = context.mock.method(evolveOrchestrator, "sandboxCapability", async () => ({
    available: true, backend: "bwrap" as const,
  }));
  const baseline = '{"weight":1,"fixed":32}';
  let scoredGoal: EvolveGoal | undefined;
  const probe = context.mock.method(evolveOrchestrator, "probe", async (goal: EvolveGoal) => {
    scoredGoal = goal;
    return { baseline: 0.5, worsened: 0.5, flat: true, label: "Fixture" };
  });
  const runtime = platform.evolveRuntimeFactory({ sessionId: session.id, modelId: model.id, emit: async () => {} });
  assert.ok(runtime);
  const proposal: EvolveRunProposal = {
    statement: "Tune policy", howScored: "Fixture score", mode: "custom_script",
    startingPointPath: "ignored-missing-file.json", editableFields: ["fixed"],
    evaluatorSource: "# SCIENCE_AGENT_SHARDS and SCIENCE_AGENT_RESULT",
    split: { gateShards: 8, rolloutShards: 4, seed: 0, shardRows: 20, testShards: 2, trainRows: null },
    expansions: 8, workers: 1,
  };
  await store.appendMessage(session.id, "user", appendEvolveDirection("/evolve-design Tune policy", {
    baseline, editable: ["weight"],
  }));
  await store.appendMessage(session.id, "user", "Continue with the selected scope");
  const incompatible = await runtime.createEvolveRun({ ...proposal, mode: "test_gate" });
  assert.match(incompatible.refusedBecause ?? "", /selected a JSON baseline/);
  assert.equal(sandbox.mock.callCount(), 0);

  const result = await runtime.createEvolveRun(proposal);
  assert.equal(probe.mock.callCount(), 1, result.refusedBecause ?? "The proposal must reach the scoring probe");
  assert.equal(result.probe?.flat, true, result.refusedBecause ?? "The fixture probe should be flat");
  assert.ok(scoredGoal);
  assert.equal(scoredGoal.baselineProgramCas, "sha256:" + createHash("sha256").update(baseline).digest("hex"));
  assert.deepEqual(scoredGoal.scorecard.direction, { editable: ["weight"] });
  assert.equal(result.run, undefined);

  await store.appendMessage(session.id, "user", appendEvolveDirection("/evolve-design Try again", {
    baseline, editable: ["missing"],
  }));
  const invalid = await runtime.createEvolveRun(proposal);
  assert.match(invalid.refusedBecause ?? "", /field list is invalid/);
  assert.equal(sandbox.mock.callCount(), 1);
});
