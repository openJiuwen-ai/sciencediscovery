// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { committedWorkspaceSnapshot, withWorkspaceMutation, RefStore, VersionStore, type TrajectoryStep, type WorkspaceTree } from "@sciencediscovery/cas";
import { createMainAgentProfile, createSubagentProfile } from "@sciencediscovery/orchestration";
import type { ModelInput } from "@sciencediscovery/model";
import type { WorkspaceAgentOptions } from "@sciencediscovery/workspace";
import { AgentLoop, type RuntimeMessage } from "@sciencediscovery/runtime-core";
import { createAgentRun } from "../agent-run/create-agent-run.js";
import { setModelTurnStreamerForTest, type ModelTurnStreamer } from "./index.js";
import { AgentStateAssembler, AgentVersionRecorder, agentHeadName, type AgentStateSnapshot, type ContextAssemblyRecord, type ModelContextSnapshot } from "./versioning.js";

test("turn state uses a committed Workspace tree while the next execution is still writing", async (t) => {
  await mkdir(resolve(".tmp"), { recursive: true });
  const root = await mkdtemp(resolve(".tmp/agent-versioning-busy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = resolve(root, "workspace"); await mkdir(workspace);
  const store = new VersionStore(resolve(root, "data"));
  await writeFile(resolve(workspace, "result"), "previous");
  const baseline = await committedWorkspaceSnapshot(store, workspace);
  let ready!: () => void; const started = new Promise<void>((done) => { ready = done; });
  let release!: () => void; const finish = new Promise<void>((done) => { release = done; });
  const writing = withWorkspaceMutation(store, workspace, async () => {
    await writeFile(resolve(workspace, "result"), "unfinished"); ready(); await finish;
  }, { kind: "next-execution" });
  await started;
  try {
    const manifest = await store.putRecord("AgentManifest", {});
    const assembler = new AgentStateAssembler(store, workspace, () => ({}), async () => ({}));
    const ref = await assembler.assemble({ agentId: "main", trajectoryId: "turn", turn: 1, phase: "after",
      manifest, agentRevision: manifest, predecessor: null, transcript: [], history: [], observations: [] });
    assert.deepEqual((await store.readRecord<AgentStateSnapshot>(ref)).value.workspace, baseline);
  } finally { release(); await writing; }
});

test("production AgentRun records exact contexts, complete observations, sequential MCP overwrite and manifest lineage", async () => {
  await mkdir(resolve(".tmp"), { recursive: true });
  const root = await mkdtemp(resolve(".tmp/agent-versioning-"));
  const workspace = resolve(root, "workspace"); await mkdir(workspace);
  const dataDir = resolve(root, "data");
  const store = new VersionStore(dataDir);
  const received: ModelInput[] = [];
  const largeResult = "full-observation-".repeat(20_000);
  const tool: NonNullable<WorkspaceAgentOptions["mcpTools"]>[number] = {
    name: "write_result", description: "Write a result", displayName: "Write", inputSchema: { type: "object" },
    sourceId: "test", toolId: "write", routing: { keywords: ["write"], mode: "prefer", priority: 1 },
    async execute(id) {
      if (id === "last") await new Promise((done) => setTimeout(done, 15));
      await writeFile(resolve(workspace, "result.txt"), id);
      return largeResult;
    },
  };
  let turn = 0;
  const streamer: ModelTurnStreamer = async (_endpoint, systemPrompt, history, tools) => {
    received.push(structuredClone({ systemPrompt, history, tools }));
    turn += 1;
    if (turn !== 1) return { assistantMessage: { role: "assistant", content: "done", provider_extension: "preserved" }, toolCalls: [] };
    const toolCalls = ["first", "last"].map((id) => ({ id, name: "write_result", args: {} }));
    return { assistantMessage: { role: "assistant", content: "", tool_calls: toolCalls.map((call) => ({
      id: call.id, type: "function", function: { name: call.name, arguments: "{}" },
    })) }, toolCalls };
  };
  const reset = setModelTurnStreamerForTest(streamer);
  const profile = createMainAgentProfile({ connectorIds: [], gatewayThreadId: "session-version", runTimeoutMs: 0, workspaceRoot: workspace });
  const bindings = {
    readVersioningAuthorities: async () => ({ permissionEpoch: "epoch-2", plan: { goal: "preserve" } }),
    workspace: {
      config: { baseUrl: "http://model.test", dataDir, model: "stub", apiToken: "not-in-manifest" },
      enabledConnectorIds: [], mcpTools: [tool], workspaceRoot: workspace,
      executePython: async () => { throw new Error("not called"); },
      executeShell: async () => { throw new Error("not called"); },
    },
  };
  let refs: RefStore | undefined;
  try {
    await createAgentRun(profile, bindings, {
      agentRunId: "trajectory-1", requestExecutionId: "request-1", history: [], prompt: "write", purpose: "initial", runContract: "Keep every result",
    }).execute();
    refs = await RefStore.open(store);
    const head = refs.head(agentHeadName("main:session-version"))!;
    await store.validateClosure(head);
    assert.equal(refs.history(agentHeadName("main:session-version")).length, 2);
    const final = (await store.readRecord<TrajectoryStep>(head, "TrajectoryStep")).value;
    const first = (await store.readRecord<TrajectoryStep>(final.parent!, "TrajectoryStep")).value;
    assert.equal(first.actions.length, 3);
    assert.deepEqual(first.eventSegments.map((s) => s.stream).sort(), ["main:session-version", "tool:first", "tool:last"]);
    assert.equal(first.childTrajectories.length, 0);
    const state = (await store.readRecord<AgentStateSnapshot>(final.after, "AgentStateSnapshot")).value;
    assert.equal(state.transcript.length, 5);
    assert.equal(state.transcript.at(-1)?.provider_extension, "preserved");
    assert.equal(state.observations.length, 2);
    const observation = (await store.readRecord<{ content: import("@sciencediscovery/cas").AgentStateRef }>(state.observations[0]!)).value;
    assert.equal(JSON.parse((await store.readState(observation.content)).toString()), largeResult);
    const tree = (await store.readRecord<WorkspaceTree>(state.workspace)).value;
    const entry = tree.entries.find((item) => Buffer.from(item.name, "base64url").toString() === "result.txt")!;
    assert.equal(entry.type, "file");
    if (entry.type === "file") assert.deepEqual(await store.readData(entry.content), await readFile(resolve(workspace, "result.txt")));
    const modelContext = (await store.readRecord<{ input: ModelInput }>(first.modelContext, "ModelContextSnapshot")).value;
    assert.deepEqual(modelContext.input, received[0]);
    const revision = (await store.readRecord<{ manifest: import("@sciencediscovery/cas").AgentStateRef }>(first.revision)).value;
    const manifest = await store.readRecord(revision.manifest, "AgentManifest");
    assert.ok(!JSON.stringify(manifest).includes("not-in-manifest"));
    await createAgentRun(profile, bindings, {
      agentRunId: "trajectory-2", requestExecutionId: "request-2", history: [], prompt: "again", purpose: "initial",
    }).execute();
    const secondHead = (await store.readRecord<TrajectoryStep>(refs.head(agentHeadName("main:session-version"))!)).value;
    const revision2 = (await store.readRecord<{ manifest: unknown; parentRevision: unknown }>(secondHead.revision)).value;
    const secondState = (await store.readRecord<AgentStateSnapshot>(secondHead.after)).value;
    assert.notDeepEqual((secondState.runtime as { toolState: unknown }).toolState, (state.runtime as { toolState: unknown }).toolState);
    assert.deepEqual(revision2.manifest, revision.manifest);
    assert.deepEqual(revision2.parentRevision, final.revision);
    assert.deepEqual(secondHead.parent, head);
    bindings.workspace.mcpTools = [{ ...tool, description: "Changed tool schema contract" }];
    await createAgentRun(profile, bindings, {
      agentRunId: "trajectory-3", requestExecutionId: "request-3", history: [], prompt: "again", purpose: "initial",
    }).execute();
    const third = (await store.readRecord<TrajectoryStep>(refs.head(agentHeadName("main:session-version"))!)).value;
    const revision3 = (await store.readRecord<{ manifest: unknown }>(third.revision)).value;
    assert.notDeepEqual(revision3.manifest, revision.manifest);
    const previousHead = refs.head(agentHeadName("main:session-version"));
    const putRecord = VersionStore.prototype.putRecord;
    VersionStore.prototype.putRecord = async function(kind, value, dependencies) {
      if (kind === "TrajectoryStep") throw new Error("injected storage failure");
      return putRecord.call(this, kind, value, dependencies);
    };
    try {
      await assert.rejects(createAgentRun(profile, bindings, {
        agentRunId: "trajectory-fail", requestExecutionId: "request-fail", history: [], prompt: "again", purpose: "initial",
      }).execute(), /injected storage failure/);
      assert.deepEqual(refs.head(agentHeadName("main:session-version")), previousHead);
      assert.ok(refs.head("attempts/trajectory-fail/0"));
      await store.validateClosure(previousHead!);
    } finally { VersionStore.prototype.putRecord = putRecord; }
  } finally { reset(); refs?.close(); await rm(root, { recursive: true, force: true }); }
});

test("overflow retry retains both exact inputs and commits only the successful input", async () => {
  await mkdir(resolve(".tmp"), { recursive: true });
  const root = await mkdtemp(resolve(".tmp/versioning-recovery-"));
  const workspace = resolve(root, "workspace"); await mkdir(workspace);
  type Input = { history: RuntimeMessage[] };
  const recorder = new AgentVersionRecorder<RuntimeMessage, Input, never>(resolve(root, "data"), workspace, {
    agentId: "recovery-agent", trajectoryId: "recovery-trajectory", requestExecutionId: "recovery-request",
  }, () => ({}));
  const received: Input[] = [];
  let refs: RefStore | undefined;
  try {
    await recorder.initialize({}, []);
    const loop = new AgentLoop<RuntimeMessage, Input, never>({
      maxModelTurns: 1,
      contextAssembler: { async assemble({ history, recovery }) {
        const next = recovery ? [{ role: "user", content: "compacted input" }] : [...history];
        return { history: next, modelInput: { history: next } };
      } },
      modelClient: {
        isInputTooLargeError: () => true,
        async invoke(input) {
          received.push(structuredClone(input));
          if (received.length === 1) throw new Error("context too large");
          return { assistantMessage: { role: "assistant", content: "done" }, toolCalls: [] };
        },
      },
      toolDispatcher: { async execute() { throw new Error("unused"); } },
      turnLifecycle: recorder,
    });
    await loop.run([{ role: "user", content: "original input" }], new AbortController().signal, () => {});
    refs = await RefStore.open(recorder.store);
    const attempts = refs.history("attempts/recovery-trajectory/0");
    assert.equal(attempts.length, 2);
    assert.equal(refs.history(agentHeadName("recovery-agent")).length, 1);
    const step = (await recorder.store.readRecord<TrajectoryStep>(refs.head(agentHeadName("recovery-agent"))!)).value;
    const input = (await recorder.store.readRecord<ModelContextSnapshot<Input>>(step.modelContext)).value.input;
    assert.notDeepEqual(received[0], received[1]);
    assert.deepEqual(input, received[1]);
    for (const [index, attempt] of attempts.entries()) {
      const context = (await recorder.store.readRecord<ContextAssemblyRecord>(attempt)).value;
      assert.deepEqual((await recorder.store.readRecord<ModelContextSnapshot<Input>>(context.modelContext)).value.input, received[index]);
      await recorder.store.validateClosure(attempt);
    }
    await recorder.store.validateClosure(refs.head(agentHeadName("recovery-agent"))!);
  } finally { recorder.close(); refs?.close(); await rm(root, { recursive: true, force: true }); }
});

test("parent Step links the child trajectory using the same state and revision model", async () => {
  await mkdir(resolve(".tmp"), { recursive: true });
  const root = await mkdtemp(resolve(".tmp/child-versioning-"));
  const parentRoot = resolve(root, "parent"); const childRoot = resolve(root, "child");
  await mkdir(parentRoot); await mkdir(childRoot);
  const dataDir = resolve(root, "data");
  const base = {
    config: { baseUrl: "http://model.test", dataDir, model: "stub" }, enabledConnectorIds: [],
    executePython: async () => { throw new Error("unused"); }, executeShell: async () => { throw new Error("unused"); },
  };
  let calls = 0;
  const reset = setModelTurnStreamerForTest(async () => {
    calls += 1;
    if (calls !== 1) return { assistantMessage: { role: "assistant", content: "done" }, toolCalls: [] };
    const args = { description: "child", prompt: "inspect" };
    return { assistantMessage: { role: "assistant", tool_calls: [{ id: "delegate", type: "function", function: { name: "task", arguments: JSON.stringify(args) } }] },
      toolCalls: [{ id: "delegate", name: "task", args }] };
  });
  let refs: RefStore | undefined;
  try {
    const childProfile = createSubagentProfile({ connectorIds: [], deniedToolNames: [], presetId: "test", gatewayThreadId: "child-1", maxModelTurns: 2, runTimeoutMs: 0, workspaceRoot: childRoot });
    await createAgentRun(createMainAgentProfile({ connectorIds: [], gatewayThreadId: "parent-1", runTimeoutMs: 0, workspaceRoot: parentRoot }), {
      workspace: { ...base, workspaceRoot: parentRoot, runSubagent: async (input) => {
        await createAgentRun(childProfile, { workspace: { ...base, workspaceRoot: childRoot } }, {
          agentRunId: "child-run", requestExecutionId: "child-request", history: [], prompt: input.prompt, purpose: "initial",
        }).execute();
        return { id: "child-1", input, description: input.description, maxTurns: 2, parentTurnId: "parent-run", sessionId: "parent-1",
          status: "completed", steps: [], timeoutSeconds: 0, turnCount: 1, createdAt: new Date().toISOString() };
      } },
    }, { agentRunId: "parent-run", requestExecutionId: "parent-request", history: [], prompt: "delegate", purpose: "initial" }).execute();
    const store = new VersionStore(dataDir); refs = await RefStore.open(store);
    const parentHead = (await store.readRecord<TrajectoryStep>(refs.head(agentHeadName("main:parent-1"))!)).value;
    const delegated = (await store.readRecord<TrajectoryStep>(parentHead.parent!)).value;
    assert.deepEqual(delegated.childTrajectories, [refs.head(agentHeadName("subagent:child-1"))]);
    await store.validateClosure(parentHead.parent!);
    const child = (await store.readRecord<TrajectoryStep>(delegated.childTrajectories[0]!)).value;
    assert.equal((await store.readRecord<AgentStateSnapshot>(child.after)).value.agentId, "subagent:child-1");
    assert.ok(refs.head("attempts/child-run/0"));
  } finally { reset(); refs?.close(); await rm(root, { recursive: true, force: true }); }
});
