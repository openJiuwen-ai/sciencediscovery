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

import type { ExecutionRun, ScientificArtifactVersion } from "@sciencediscovery/schema";

import { artifactVersionProvenance } from "./index.js";

const version: ScientificArtifactVersion = {
  artifactId: "artifact-1",
  content: { hash: "f".repeat(64), size: 1 },
  createdAt: "2026-08-07T00:00:00.000Z",
  executionRunIds: ["run-current", "run-historical"],
  id: "version-1",
  inputArtifactVersionIds: [],
  mediaType: "text/markdown",
  projectId: "project-1",
  sessionId: "session-1",
  version: 1,
};

function executionRun(id: string, envSnapshot: ExecutionRun["envSnapshot"]): ExecutionRun {
  return {
    cgroupMode: "none",
    code: { hash: `${id}-code`, size: 4 },
    createdFiles: [],
    environmentRevisionId: null,
    envSnapshot,
    exitCode: 0,
    finishedAt: "2026-08-07T00:00:01.000Z",
    id,
    kernelId: `${id}-kernel`,
    kernelMode: "ephemeral",
    language: "python",
    modifiedFiles: [],
    networkPolicy: "none",
    permissionEpochId: "permission-1",
    runnerVersion: "runner-test",
    sandbox: "bubblewrap",
    sessionId: "session-1",
    startedAt: "2026-08-07T00:00:00.000Z",
    status: "succeeded",
    stderr: { hash: `${id}-stderr`, size: 0 },
    stdout: { hash: `${id}-stdout`, size: 4 },
    tool: "run_python",
    toolVersion: "1",
    turnId: "turn-1",
    workingDirectory: id === "run-current" ? "/workspace/results" : "workspace",
  };
}

test("artifact provenance resolves process environment for store and graph paths", async () => {
  const envSnapshot = { hash: "env-current", size: 31 };
  const currentRun = executionRun("run-current", envSnapshot);
  const historicalRun = executionRun("run-historical", undefined);
  const blobs = new Map<string, string>([
    ["env-current", JSON.stringify({ ZETA: "last", ALPHA: "first" })],
    ["run-current-code", "code"],
    ["run-current-stderr", ""],
    ["run-current-stdout", "done"],
    ["run-historical-code", "code"],
    ["run-historical-stderr", ""],
    ["run-historical-stdout", "done"],
  ]);
  // `artifactVersionProvenance` resolves the version's own Session before it
  // reads any execution run: a deleted source Session drops the log entirely
  // and reports `sourceSessionDeleted`. The stub must answer `getSession` for
  // the store and graph paths to reach their execution logs at all.
  const storeWithSession = (getSession: (id: string) => unknown) => ({
    getArtifactVersion: () => version,
    getSession,
    listEnvironmentRevisions: () => [],
    listExecutionRuns: async () => [currentRun, historicalRun],
    listPromptManifests: async () => [],
    listReviews: async () => [],
    readMessages: async () => [],
  } as unknown as Parameters<typeof artifactVersionProvenance>[0]);
  const store = storeWithSession((id) => id === version.sessionId ? { id } : undefined);
  const recorder = {
    cas: {
      read: async (hash: string) => Buffer.from(blobs.get(hash) ?? ""),
    },
  } as unknown as Parameters<typeof artifactVersionProvenance>[1];

  const fromStore = await artifactVersionProvenance(store, recorder, null, "session-1", version.id);
  assert.deepEqual(fromStore.executionLog[0], {
    envSnapshot,
    exitCode: 0,
    finishedAt: currentRun.finishedAt,
    processEnvironment: { ALPHA: "first", ZETA: "last" },
    runId: currentRun.id,
    status: "succeeded",
    stderr: "",
    stdout: "done",
    workingDirectory: "/workspace/results",
  });
  assert.deepEqual(Object.keys(fromStore.executionLog[0]!.processEnvironment!), ["ALPHA", "ZETA"]);
  assert.equal(fromStore.executionLog[1]?.envSnapshot, null);
  assert.equal(fromStore.executionLog[1]?.processEnvironment, null);

  const graph = {
    getArtifactProvenance: async () => ({
      codeHash: currentRun.code.hash,
      codeId: currentRun.id,
      exitCode: currentRun.exitCode,
      finishedAt: currentRun.finishedAt,
      status: currentRun.status,
      stderrHash: currentRun.stderr.hash,
      stdoutHash: currentRun.stdout.hash,
    }),
  } as unknown as NonNullable<Parameters<typeof artifactVersionProvenance>[2]>;
  const fromGraph = await artifactVersionProvenance(store, recorder, graph, "session-1", version.id);
  assert.deepEqual(fromGraph.executionLog[0]?.envSnapshot, envSnapshot);
  assert.deepEqual(fromGraph.executionLog[0]?.processEnvironment, { ALPHA: "first", ZETA: "last" });
  assert.equal(fromGraph.executionLog[0]?.workingDirectory, "/workspace/results");
  assert.equal("sourceSessionDeleted" in fromStore, false);
  assert.equal("sourceSessionDeleted" in fromGraph, false);

  // The source-Session gate itself: once the version's Session is gone the
  // runs are unreachable, so both paths return an empty log and flag it.
  const orphanedStore = storeWithSession(() => undefined);
  const orphanedFromStore = await artifactVersionProvenance(orphanedStore, recorder, null, "session-1", version.id);
  assert.deepEqual(orphanedFromStore.executionLog, []);
  assert.equal(orphanedFromStore.sourceSessionDeleted, true);
  const orphanedFromGraph = await artifactVersionProvenance(orphanedStore, recorder, graph, "session-1", version.id);
  assert.deepEqual(orphanedFromGraph.executionLog, []);
  assert.equal(orphanedFromGraph.sourceSessionDeleted, true);
});
