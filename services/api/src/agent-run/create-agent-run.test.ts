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

import {
  createMainAgentProfile,
  createSubagentProfile,
  type AgentEvent,
  type AgentHistoryMessage,
} from "@science-agent/agent-runtime";

import type { GatewayAgentHandle, GatewayAgentOptions } from "../gateway-agent.js";
import { createAgentRun, type AgentRunHandle } from "./create-agent-run.js";
import { runMainRequestExecution, runSubagentTask } from "./orchestrators.js";

function workspaceBindings() {
  return {
    config: { baseUrl: "http://model.test", dataDir: "/data", model: "test" },
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not called"); },
    executeShell: async () => { throw new Error("not called"); },
    workspaceRoot: "/ignored",
  };
}

test("createAgentRun executes once and returns the canonical final history", async () => {
  const observed: AgentEvent[] = [];
  const histories: AgentHistoryMessage[][] = [];
  const timeoutOptions: Array<{ idle?: number; turn?: number }> = [];
  const createAgent = (options: GatewayAgentOptions): GatewayAgentHandle => ({
    abort() {},
    beginExternalWait: () => () => undefined,
    async execute() {
      histories.push(options.gatewayHistory ?? []);
      timeoutOptions.push({
        ...(options.runIdleTimeoutMs !== undefined ? { idle: options.runIdleTimeoutMs } : {}),
        ...(options.runTimeoutMs !== undefined ? { turn: options.runTimeoutMs } : {}),
      });
      const event = { type: "turn_start" } as const;
      listener?.(event);
      return { finalMessages: [{ role: "assistant", content: "done" }] };
    },
    async prompt() {},
    subscribe(next) {
      listener = next;
      return () => { listener = undefined; };
    },
  });
  let listener: ((event: AgentEvent) => void) | undefined;
  const profile = createMainAgentProfile({
    connectorIds: ["pubmed"],
    gatewayThreadId: "session-1",
    runTimeoutMs: 30_000,
    workspaceRoot: "/workspace",
  });
  const handle = createAgentRun(profile, {
    callbackUrl: "http://api.test/internal/tool-exec",
    createAgent,
    gatewayUrl: "http://gateway.test",
    observer: (event) => observed.push(event),
    runIdleTimeoutMs: 12_000,
    workspace: workspaceBindings(),
  }, {
    agentRunId: "agent-run-1",
    history: [{ role: "user", content: "before" }],
    prompt: "continue",
    purpose: "initial",
    requestExecutionId: "execution-1",
  });

  const result = await handle.execute();
  assert.deepEqual(histories, [[{ role: "user", content: "before" }]]);
  assert.deepEqual(timeoutOptions, [{ idle: 12_000, turn: 30_000 }]);
  assert.deepEqual(observed, [{ type: "turn_start" }]);
  assert.deepEqual(result.finalMessages, [{ role: "assistant", content: "done" }]);
  await assert.rejects(() => handle.execute(), /already been executed/);
});

test("createAgentRun forwards long gateway history without Node-side compaction", async () => {
  const histories: AgentHistoryMessage[][] = [];
  const createAgent = (options: GatewayAgentOptions): GatewayAgentHandle => ({
    abort() {},
    beginExternalWait: () => () => undefined,
    async execute() {
      histories.push(options.gatewayHistory ?? []);
      return { finalMessages: options.gatewayHistory ?? [] };
    },
    async prompt() {},
    subscribe() {
      return () => undefined;
    },
  });
  const profile = createMainAgentProfile({
    connectorIds: [],
    gatewayThreadId: "session-1",
    runTimeoutMs: 30_000,
    workspaceRoot: "/workspace",
  });
  const history = Array.from({ length: 44 }, (_, index): AgentHistoryMessage => ({
    content: `history-${index}`,
    role: "assistant",
  }));
  const handle = createAgentRun(profile, {
    callbackUrl: "http://api.test/internal/tool-exec",
    createAgent,
    gatewayUrl: "http://gateway.test",
    workspace: workspaceBindings(),
  }, {
    agentRunId: "agent-run-compact",
    history,
    prompt: "continue",
    purpose: "reviewer_correction",
    requestExecutionId: "execution-1",
  });

  await handle.execute();

  assert.equal(histories[0]?.length, history.length);
  assert.deepEqual(histories[0], history);
  assert.notEqual(histories[0], history);
});

test("reviewer correction is a second AgentRun with explicit canonical history handoff", async () => {
  const receivedHistories: AgentHistoryMessage[][] = [];
  const receivedContracts: Array<string | undefined> = [];
  let runCount = 0;
  const createAgent = (options: GatewayAgentOptions): GatewayAgentHandle => ({
    abort() {},
    beginExternalWait: () => () => undefined,
    async execute() {
      runCount += 1;
      receivedHistories.push(options.gatewayHistory ?? []);
      receivedContracts.push(options.runContract);
      return {
        finalMessages: [
          ...(options.gatewayHistory ?? []),
          { role: "assistant", content: `answer-${runCount}` },
        ],
      };
    },
    async prompt() {},
    subscribe() {
      return () => undefined;
    },
  });
  const profile = createMainAgentProfile({
    connectorIds: [],
    gatewayThreadId: "session-1",
    runTimeoutMs: 30_000,
    workspaceRoot: "/workspace",
  });
  const execution = runMainRequestExecution({
    bindings: {
      callbackUrl: "http://api.test/internal/tool-exec",
      createAgent,
      gatewayUrl: "http://gateway.test",
      workspace: workspaceBindings(),
    },
    profile,
    requestExecutionId: "execution-1",
  });
  const initial = await execution.executeAgentRun({
    history: [{ role: "user", content: "before" }],
    prompt: "initial",
    purpose: "initial",
  });
  const correction = await execution.executeAgentRun({
    history: initial.finalMessages,
    prompt: "correct",
    purpose: "reviewer_correction",
  });

  assert.equal(initial.requestExecutionId, "execution-1");
  assert.equal(correction.requestExecutionId, "execution-1");
  assert.notEqual(initial.agentRunId, correction.agentRunId);
  assert.deepEqual(receivedHistories, [
    [{ role: "user", content: "before" }],
    [{ role: "user", content: "before" }, { role: "assistant", content: "answer-1" }],
  ]);
  assert.deepEqual(receivedContracts, ["initial", "initial"]);
});

test("request execution forwards external waits only to its active AgentRun", async () => {
  let finishExecute: (() => void) | undefined;
  let pauseCount = 0;
  let releaseCount = 0;
  const createAgent = (): GatewayAgentHandle => ({
    abort() {},
    beginExternalWait() {
      pauseCount += 1;
      return () => {
        releaseCount += 1;
      };
    },
    async execute() {
      await new Promise<void>((resolve) => {
        finishExecute = resolve;
      });
      return { finalMessages: [] };
    },
    async prompt() {},
    subscribe() {
      return () => undefined;
    },
  });
  const execution = runMainRequestExecution({
    bindings: {
      callbackUrl: "http://api.test/internal/tool-exec",
      createAgent,
      gatewayUrl: "http://gateway.test",
      workspace: workspaceBindings(),
    },
    profile: createMainAgentProfile({
      connectorIds: [],
      gatewayThreadId: "session-1",
      runTimeoutMs: 30_000,
      workspaceRoot: "/workspace",
    }),
    requestExecutionId: "execution-1",
  });

  assert.throws(() => execution.beginExternalWait(), /No AgentRun is active/);
  const running = execution.executeAgentRun({
    history: [],
    prompt: "run",
    purpose: "initial",
  });
  const release = execution.beginExternalWait();
  assert.equal(pauseCount, 1);
  release();
  assert.equal(releaseCount, 1);
  finishExecute?.();
  await running;
  assert.throws(() => execution.beginExternalWait(), /No AgentRun is active/);
});

test("runSubagentTask returns an unstarted handle visible before synchronous maxTurns events", async () => {
  let listener: ((event: AgentEvent) => void) | undefined;
  let executeCount = 0;
  let abortCount = 0;
  let receivedRunContract: string | undefined;
  const createAgent = (options: GatewayAgentOptions): GatewayAgentHandle => ({
    abort() {
      abortCount += 1;
    },
    beginExternalWait: () => () => undefined,
    async execute() {
      executeCount += 1;
      receivedRunContract = options.runContract;
      listener?.({ type: "turn_start" });
      listener?.({ type: "turn_start" });
      return { finalMessages: [{ role: "assistant", content: "done" }] };
    },
    async prompt() {},
    subscribe(next) {
      listener = next;
      return () => { listener = undefined; };
    },
  });
  const profile = createSubagentProfile({
    connectorIds: [],
    deniedToolNames: ["task"],
    gatewayThreadId: "subagent-1",
    maxModelTurns: 1,
    presetId: "general-purpose",
    runTimeoutMs: 30_000,
    workspaceRoot: "/workspace",
  });
  let turnCount = 0;
  let handle: AgentRunHandle;
  handle = runSubagentTask({
    bindings: {
      callbackUrl: "http://api.test/internal/tool-exec",
      createAgent,
      gatewayUrl: "http://gateway.test",
      observer: (event) => {
        if (event.type !== "turn_start") return;
        turnCount += 1;
        if (turnCount > profile.budget.maxModelTurns) handle.abort();
      },
      workspace: workspaceBindings(),
    },
    profile,
    prompt: "investigate",
    requestExecutionId: "subagent-1",
    runContract: "delegated task contract",
  });

  assert.equal(executeCount, 0);
  await handle.execute();
  assert.equal(executeCount, 1);
  assert.equal(receivedRunContract, "delegated task contract");
  assert.equal(turnCount, 2);
  assert.equal(abortCount, 1);
});
