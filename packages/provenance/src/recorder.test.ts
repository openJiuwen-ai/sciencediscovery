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
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";


import type { NpuJob } from "@sciencediscovery/schema";
import { MemoryGraphClient, MemoryGraphSink, type ObserveExecutionPayload } from "@sciencediscovery/memory";

import { ProvenanceRecorder, recordedWorkspaceModifiedAt } from "./recorder.js";

test("published Workspace mtime is attributed only while its bytes match the execution snapshot", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "recorder-mtime-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const path = join(root, "report.txt");
  const fallback = "2026-09-24T03:00:00.000Z";
  await writeFile(path, "good");
  const hash = createHash("sha256").update("good").digest("hex");
  assert.equal(await recordedWorkspaceModifiedAt(root, "report.txt", hash, 4, fallback),
    (await stat(path)).mtime.toISOString());

  await writeFile(path, "evil");
  assert.equal(await recordedWorkspaceModifiedAt(root, "report.txt", hash, 4, fallback), fallback,
    "a same-size external rewrite must not inherit the tool's origin");
  await symlink(path, join(root, "linked.txt"));
  assert.equal(await recordedWorkspaceModifiedAt(root, "linked.txt", hash, 4, fallback), fallback,
    "a symlink is not a trustworthy published output");
});

/**
 * Subclass MemoryGraphClient so the sink sees a real client (its constructor
 * parameter is typed ``MemoryGraphClient | null``, not a duck type) but every
 * ``observeExecution`` call is captured locally instead of hitting the
 * network. This is the only safe way to assert on what the recorder handed
 * the sink — the sink is fire-and-forget so we can't read it from the
 * client's URL.
 */
class CapturingClient extends MemoryGraphClient {
  public readonly executions: ObserveExecutionPayload[] = [];
  public throwOnNext = false;

  constructor() {
    // Unreachable base URL: posts would fail anyway, but observeExecution
    // overrides post() so it never gets there.
    super({ url: "http://127.0.0.1:1" });
  }

  async observeExecution(payload: ObserveExecutionPayload): Promise<void> {
    if (this.throwOnNext) {
      this.throwOnNext = false;
      throw new Error("sink offline");
    }
    this.executions.push(payload);
  }
}

interface FakeStoreShape {
  listArtifacts: (sessionId: string) => Array<{ id: string; name: string; logicalName?: string; origin?: string }>;
  listArtifactVersions: (sessionId: string, artifactId: string) => Array<{
    content: { hash: string; size: number };
    mediaType: string;
    projectId: string;
    turnId?: string;
    version: number;
  }>;
  listEnvironmentRevisions: () => Array<{ id: string; snapshot: { hash: string; size: number } }>;
}

const castStore = (shape: FakeStoreShape): ConstructorParameters<typeof ProvenanceRecorder>[1] =>
  // The recorder only reads three methods on observeNpuJob's path. Cast away
  // the other ProvenanceStore fields so tests don't have to stub the full
  // 12-method surface; the recorder never touches them on this code path.
  shape as unknown as ConstructorParameters<typeof ProvenanceRecorder>[1];

const buildRecorder = async (client: CapturingClient, storeShape: FakeStoreShape = {
  listArtifacts: () => [],
  listArtifactVersions: () => [],
  listEnvironmentRevisions: () => [],
}) => {
  const dataDir = await mkdtemp(join(tmpdir(), "recorder-npu-"));
  const sink = new MemoryGraphSink(client, () => true);
  const recorder = new ProvenanceRecorder(dataDir, castStore(storeShape), sink);
  return { dataDir, recorder };
};

const baseJob = (overrides: Partial<NpuJob> = {}): NpuJob => ({
  createdAt: "2026-01-01T00:00:00.000Z",
  id: "npu-job-1",
  inputs: { configPath: "antibody_pipeline/config.json" },
  logs: { stderr: "", stdout: "", truncated: false },
  sessionId: "session-1",
  state: "succeeded",
  updatedAt: "2026-01-01T00:01:00.000Z",
  workloadId: "antibody.protenix.v1",
  workspaceRoot: "/workspace",
  ...overrides,
});

test("observeNpuJob mirrors terminal jobs to the memory graph with declared artifacts", async (context) => {
  const client = new CapturingClient();
  const { dataDir, recorder } = await buildRecorder(client);
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  recorder.observeNpuJob(baseJob({
    createdFiles: ["outputs/predictions.csv"],
    environmentRevisionId: "rev-1",
    exitCode: 0,
    finishedAt: "2026-01-01T00:01:30.000Z",
    startedAt: "2026-01-01T00:00:30.000Z",
    state: "succeeded",
    updatedAt: "2026-01-01T00:01:30.000Z",
  }), {
    artifacts: [{ artifact_id: "art-1", path: "outputs/predictions.csv", version: 1 }],
    sessionId: "session-1",
    turnId: "run-1",
  });
  // observeExecution returns a Promise the sink then()s — wait a tick.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.executions.length, 1);
  const sent = client.executions[0]!;
  assert.equal(sent.executionId, "npu-job-1");
  assert.equal(sent.tool, "run_npu_job");
  assert.equal(sent.toolName, "run_npu_job");
  assert.equal(sent.toolType, "execution");
  assert.equal(sent.status, "succeeded");
  assert.equal(sent.exitCode, 0);
  assert.equal(sent.language, null);
  assert.equal(sent.producedArtifacts.length, 0); // empty store → enriched drops missing versions
});

test("observeNpuJob skips non-terminal jobs (queued / running)", async (context) => {
  const client = new CapturingClient();
  const { dataDir, recorder } = await buildRecorder(client);
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  recorder.observeNpuJob(baseJob({ state: "queued" }), {
    artifacts: [],
    sessionId: "session-1",
    turnId: "run-1",
  });
  recorder.observeNpuJob(baseJob({ state: "running" }), {
    artifacts: [],
    sessionId: "session-1",
    turnId: "run-1",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.executions.length, 0);
});

test("observeNpuJob skips jobs when every declaration failed (producedArtifacts is empty)", async (context) => {
  const client = new CapturingClient();
  const { dataDir, recorder } = await buildRecorder(client);
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  // All declarations failed → workspace hands us an empty artifacts array
  recorder.observeNpuJob(baseJob({ state: "failed" }), {
    artifacts: [],
    sessionId: "session-1",
    turnId: "run-1",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.executions.length, 1);
  assert.equal(client.executions[0]!.producedArtifacts.length, 0);
  assert.equal(client.executions[0]!.status, "failed");
});

test("observeNpuJob enriches producedArtifacts with logicalName / mediaType / projectId from the catalog", async (context) => {
  const client = new CapturingClient();
  const { dataDir, recorder } = await buildRecorder(client, {
    listArtifacts: () => [{
      id: "art-1", logicalName: "predictions.csv", name: "predictions.csv", origin: "llm_declared",
    }],
    listArtifactVersions: () => [{
      content: { hash: "abc123", size: 42 },
      mediaType: "text/csv",
      projectId: "proj-7",
      turnId: "run-1",
      version: 1,
    }],
    listEnvironmentRevisions: () => [],
  });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  recorder.observeNpuJob(baseJob(), {
    artifacts: [{ artifact_id: "art-1", path: "outputs/predictions.csv", version: 1 }],
    sessionId: "session-1",
    turnId: "run-1",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.executions.length, 1);
  const sent = client.executions[0]!.producedArtifacts[0]!;
  assert.equal(sent.artifactId, "art-1");
  assert.equal(sent.logicalName, "predictions.csv");
  assert.equal(sent.mediaType, "text/csv");
  assert.equal(sent.projectId, "proj-7");
  assert.equal(sent.contentHash, "abc123");
  assert.equal(sent.path, "outputs/predictions.csv");
  assert.equal(sent.version, 1);
  assert.equal(sent.turnId, "run-1");
});

test("observeNpuJob does not throw when the sink throws", async (context) => {
  const client = new CapturingClient();
  const { dataDir, recorder } = await buildRecorder(client);
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  client.throwOnNext = true;
  assert.doesNotThrow(() => recorder.observeNpuJob(baseJob(), {
    artifacts: [],
    sessionId: "session-1",
    turnId: "run-1",
  }));
  // Wait for the sink's then() to swallow the thrown error.
  await new Promise((resolve) => setImmediate(resolve));
});

test("observeNpuJob maps job states to graph statuses", async (context) => {
  const client = new CapturingClient();
  const { dataDir, recorder } = await buildRecorder(client);
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  for (const [state, expected] of [
    ["succeeded", "succeeded"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
    ["interrupted", "failed"],
  ] as const) {
    recorder.observeNpuJob(baseJob({ id: `npu-${state}`, state }), {
      artifacts: [],
      sessionId: "session-1",
      turnId: "run-1",
    });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.executions.length, 4);
  assert.deepEqual(client.executions.map((entry) => entry.status), [
    "succeeded", "failed", "cancelled", "failed",
  ]);
  // toolName is the same on every observation — not state-dependent.
  for (const sent of client.executions) {
    assert.equal(sent.toolName, "run_npu_job");
    assert.equal(sent.tool, "run_npu_job");
  }
});

test("observeNpuJob sets a stable, deterministic codeHash from workload + inputs", async (context) => {
  const client = new CapturingClient();
  const { dataDir, recorder } = await buildRecorder(client);
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  // Two jobs with identical workload+inputs must hash identically (so a
  // re-run mirrors onto the same Code node instead of forking it).
  const jobA = baseJob();
  const jobB = baseJob({ id: "npu-job-2", inputs: { configPath: "antibody_pipeline/config.json" } });
  recorder.observeNpuJob(jobA, { artifacts: [], sessionId: "session-1", turnId: "run-1" });
  recorder.observeNpuJob(jobB, { artifacts: [], sessionId: "session-1", turnId: "run-1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.executions.length, 2);
  assert.equal(client.executions[0]!.codeHash, client.executions[1]!.codeHash);
  // And a different workload input changes the hash.
  const jobC = baseJob({ id: "npu-job-3", inputs: { configPath: "different.json" } });
  recorder.observeNpuJob(jobC, { artifacts: [], sessionId: "session-1", turnId: "run-1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(client.executions[2]!.codeHash, client.executions[0]!.codeHash);
});

test("observeNpuJob forwards parentSubagentId from options", async (context) => {
  const client = new CapturingClient();
  const { dataDir, recorder } = await buildRecorder(client);
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  recorder.observeNpuJob(baseJob(), {
    artifacts: [],
    parentSubagentId: "subagent-7",
    sessionId: "session-1",
    turnId: "run-1",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.executions.length, 1);
  assert.equal(client.executions[0]!.parentSubagentId, "subagent-7");
});
