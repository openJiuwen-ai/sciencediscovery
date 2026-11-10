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
import type { IncomingMessage, ServerResponse } from "node:http";

import type { PermissionEpoch, ShellExecutionRequest } from "@sciencediscovery/schema";

import {
  connectedRunner,
  handleEvolveRunner,
  RunnerGrantRegistry,
  shellForFixedProgram,
  type EvolveRunnerDeps,
} from "./runner-proxy.js";

const EPOCH = {
  createdAt: "2026-01-01T00:00:00.000Z",
  environmentRevisionId: "rev",
  id: "epoch",
  mounts: [],
  networkPolicy: "none",
  reason: "test",
  secretRefs: [],
  sessionId: "session",
} as PermissionEpoch;

function requestOf(method: string, authorization: string | undefined, body?: unknown): IncomingMessage {
  const raw = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    headers: authorization ? { authorization } : {},
    method,
    async *[Symbol.asyncIterator]() {
      yield* raw;
    },
  } as IncomingMessage;
}

function capture(): ServerResponse & { status: number; payload: unknown } {
  const response = {
    payload: undefined as unknown,
    status: 0,
    end(body: string) {
      this.payload = JSON.parse(body);
    },
    writeHead(status: number) {
      this.status = status;
    },
  };
  return response as ServerResponse & { status: number; payload: unknown };
}

function deps(overrides: Partial<EvolveRunnerDeps> = {}): EvolveRunnerDeps & { started: ShellExecutionRequest[] } {
  const started: ShellExecutionRequest[] = [];
  return {
    grants: new RunnerGrantRegistry(),
    runnerClient: () => ({
      cancelShellExecution: async () => ({ state: "cancelled" }),
      getShellExecution: async () => ({ state: "completed", result: { stdout: "{\"device\":\"npu\",\"score\":1}\n" } }),
      startShellExecution: async (request) => {
        started.push(request);
        return { state: "queued" };
      },
    }),
    sessions: {
      effectiveRunnerIds: () => ["local", "lab"],
      getRemoteHost: () => ({ workspaceNamespace: "ns" }),
      getSession: () => ({ projectId: "project" }),
      getSessionPermissionEpoch: () => EPOCH,
      npuDeviceSelection: () => [0, 2],
      workspacePath: () => "/data/workspace",
    },
    started,
    ...overrides,
  };
}

test("a conversation with only the local runner is refused", () => {
  assert.deepEqual(connectedRunner(["local"], () => true), {
    error: "this conversation has no remote runner selected",
  });
});

test("the first connected remote runner is the one that scores", () => {
  assert.deepEqual(connectedRunner(["local", "offline", "lab"], (id) => id === "lab"), { runnerId: "lab" });
});

test("a score uses the session's cards and a fresh shell, not the sidecar's devices", async () => {
  const context = deps();
  const token = context.grants.issue("run-1", "session", 30);
  const response = capture();
  const handled = await handleEvolveRunner(
    requestOf("POST", `Bearer ${token}`, {
      code: "print(_EVOLVE_CANDIDATE)\n",
      executionId: "evolve-one",
      npuDevices: [9],
    }),
    response,
    new URL("http://api/internal/evolve-runner/run-1/shell-executions"),
    context,
  );
  assert.equal(handled, true);
  assert.equal(response.status, 202);
  const submitted = context.started[0]!;
  assert.deepEqual(submitted.npuDevices, [0, 2]);
  assert.equal(submitted.permissionEpoch, EPOCH);
  assert.equal(submitted.runnerWorkspaceKey, "project/session/runners/ns");
  assert.equal(submitted.workspaceRoot, "/data/workspace");
  assert.equal(submitted.kernelMode, "ephemeral");
  assert.match(submitted.code, /^python3 -c /);
  assert.equal(
    Buffer.from(submitted.code.match(/b64decode\("([^"]+)"\)/)![1]!, "base64").toString("utf8"),
    "print(_EVOLVE_CANDIDATE)\n",
  );
  assert.equal(shellForFixedProgram("print(1)\n").includes("print(1)"), false);
});

test("no ticked card refuses the score", async () => {
  const context = deps({
    sessions: {
      ...deps().sessions,
      npuDeviceSelection: () => [],
    },
  });
  const token = context.grants.issue("run-1", "session", 30);
  const response = capture();
  await handleEvolveRunner(
    requestOf("POST", `Bearer ${token}`, { code: "print(1)\n", executionId: "evolve-one" }),
    response,
    new URL("http://api/internal/evolve-runner/run-1/shell-executions"),
    context,
  );
  assert.equal(response.status, 409);
  assert.match(String((response.payload as { error: string }).error), /NPU card/);
});

test("a model token is not a runner token", async () => {
  const context = deps();
  const response = capture();
  await handleEvolveRunner(
    requestOf("POST", "Bearer not-the-runner-token", { code: "print(1)\n", executionId: "evolve-one" }),
    response,
    new URL("http://api/internal/evolve-runner/run-1/shell-executions"),
    context,
  );
  assert.equal(response.status, 401);
});

function endpoint(runId: string, executionId?: string, cancel = false): URL {
  return new URL(`http://api/internal/evolve-runner/${runId}/shell-executions${executionId ? `/${executionId}${cancel ? "/cancel" : ""}` : ""}`);
}

async function submit(context: EvolveRunnerDeps, token: string, id = "evolve-one") {
  const response = capture();
  await handleEvolveRunner(requestOf("POST", `Bearer ${token}`, { code: "print(1)\n", executionId: id }), response, endpoint("run-1"), context);
  return response;
}

test("poll and cancel stay on the accepting runner after runner and card selection changes", async () => {
  const calls: string[] = [];
  let selected = ["lab"];
  let cards = [2];
  const context = deps();
  context.sessions.effectiveRunnerIds = () => selected;
  context.sessions.npuDeviceSelection = () => cards;
  context.runnerClient = (id) => ({
    startShellExecution: async (request) => { calls.push(`start:${id}:${request.npuDevices?.join(",")}`); return { state: "queued" }; },
    getShellExecution: async (executionId, owner) => { calls.push(`get:${id}:${executionId}:${owner.sessionId}`); return { state: "running" }; },
    cancelShellExecution: async (executionId) => { calls.push(`cancel:${id}:${executionId}`); return { state: "cancelled" }; },
  });
  const token = context.grants.issue("run-1", "session", 30);
  assert.equal((await submit(context, token)).status, 202);
  selected = ["second", "lab"];
  cards = [];
  for (const cancel of [false, true]) {
    const response = capture();
    await handleEvolveRunner(requestOf(cancel ? "POST" : "GET", `Bearer ${token}`), response, endpoint("run-1", "evolve-one", cancel), context);
    assert.equal(response.status, cancel ? 202 : 200);
  }
  assert.deepEqual(calls, ["start:lab:2", "get:lab:evolve-one:session", "cancel:lab:evolve-one"]);
  assert.equal((await submit(context, token, "evolve-two")).status, 409);
});

test("an uncertain submit keeps its route and cannot be submitted again on a different runner", async () => {
  const calls: string[] = [];
  const context = deps();
  context.runnerClient = (id) => ({
    startShellExecution: async () => { calls.push(`start:${id}`); throw new Error("response lost"); },
    getShellExecution: async () => { calls.push(`get:${id}`); return { state: "running" }; },
    cancelShellExecution: async () => ({ state: "cancelled" }),
  });
  const token = context.grants.issue("run-1", "session", 30);
  assert.equal((await submit(context, token)).status, 502);
  context.sessions.effectiveRunnerIds = () => ["second"];
  assert.equal((await submit(context, token)).status, 409);
  const response = capture();
  await handleEvolveRunner(requestOf("GET", `Bearer ${token}`), response, endpoint("run-1", "evolve-one"), context);
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["start:lab", "get:lab"]);
});

test("another run cannot inspect an execution and a revoked grant loses access", async () => {
  const context = deps();
  const token = context.grants.issue("run-1", "session", 30);
  assert.equal((await submit(context, token)).status, 202);
  const other = context.grants.issue("run-2", "session", 30);
  const response = capture();
  await handleEvolveRunner(requestOf("GET", `Bearer ${other}`), response, endpoint("run-2", "evolve-one"), context);
  assert.equal(response.status, 404);
  context.grants.revoke("run-1");
  await handleEvolveRunner(requestOf("POST", `Bearer ${token}`), response, endpoint("run-1", "evolve-one", true), context);
  assert.equal(response.status, 401);
});

test("an offline accepting runner never redirects an existing job to a different runner", async () => {
  const context = deps();
  const token = context.grants.issue("run-1", "session", 30);
  assert.equal((await submit(context, token)).status, 202);
  context.sessions.effectiveRunnerIds = () => ["second"];
  const requested: string[] = [];
  context.runnerClient = (id) => { requested.push(id); throw new Error("runner offline"); };
  const response = capture();
  await handleEvolveRunner(requestOf("GET", `Bearer ${token}`), response, endpoint("run-1", "evolve-one"), context);
  assert.equal(response.status, 502);
  assert.deepEqual(requested, ["lab"]);
});
