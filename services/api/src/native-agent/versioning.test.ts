// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { committedWorkspaceSnapshot, withWorkspaceMutation, RefStore, VersionStore, type TrajectoryStep, type WorkspaceTree } from "@sciencediscovery/cas";
import { createMainAgentProfile, createSubagentProfile } from "@sciencediscovery/orchestration";
import type { ModelInput } from "@sciencediscovery/model";
import type { WorkspaceAgentOptions } from "@sciencediscovery/workspace";
import { AgentLoop, type RuntimeMessage } from "@sciencediscovery/runtime-core";
import { createAgentRun } from "../agent-run/create-agent-run.js";
import { createNativeAgent, setModelTurnStreamerForTest, type ModelTurnStreamer } from "./index.js";
import { AgentStateAssembler, AgentVersionRecorder, agentHeadName, type AgentStateSnapshot, type ContextAssemblyRecord, type ModelContextSnapshot } from "./versioning.js";
import { openSessionTrajectory, type RecordedEvent } from "@sciencediscovery/trajectory/server";
import type { AgentEvent } from "@sciencediscovery/orchestration";
import type { RunStreamEvent } from "@sciencediscovery/schema";

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
      return id === "first" ? { data: largeResult, nested: [{ apiToken: "audit-secret", body: "private-body" }] } : largeResult;
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
  const events: RecordedEvent[] = [];
  const recordEvent = async (event: RunStreamEvent) => {
    events.push({ id: `run:${events.length + 1}`, agentId: "main:session-version", runId: event.evidence!.requestExecutionId,
      streamId: "main", sequence: events.length + 1, createdAt: new Date().toISOString(), event });
  };
  const bindings = {
    // Pinned to the native loop regardless of SCIENCE_AGENT_EXECUTOR: this test drives model turns
    // through setModelTurnStreamerForTest, a native-agent-only hook the JiuwenSwarm executor never calls.
    createAgent: createNativeAgent,
    recordEvent,
    observer: (event: AgentEvent) => {
      if (event.type === "tool_execution_start" || event.type === "tool_execution_end") void recordEvent({
        type: event.type === "tool_execution_start" ? "tool.started" : "tool.completed", evidence: event.evidence,
        trace: { id: event.toolCallId, name: event.toolName, status: event.type === "tool_execution_start" ? "running" : "completed" },
      });
    },
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
    assert.deepEqual(first.eventSegments, []); // Only the existing Run stream owns events.
    const modelRecords = events.map(item => item.event as RunStreamEvent).filter(event => event.type === "agent.record" && event.name === "model.completed");
    assert.equal(modelRecords.length, 2);
    for (const [i, step] of [first, final].entries()) {
      const recorded = modelRecords[i]!;
      assert.equal(recorded.type, "agent.record");
      if (recorded.type !== "agent.record") throw new Error("Expected model record");
      assert.deepEqual(recorded.payloadRef, step.actions[0], "Run and Step reuse the same authoritative ModelAction");
      assert.equal((await store.readRecord(recorded.payloadRef!)).kind, "ModelAction");
    }
    await assert.rejects(access(resolve(dataDir, "trajectories")), { code: "ENOENT" });
    assert.equal(first.childTrajectories.length, 0);
    const state = (await store.readRecord<AgentStateSnapshot>(final.after, "AgentStateSnapshot")).value;
    assert.equal(state.transcript.length, 5);
    assert.equal(state.transcript.at(-1)?.provider_extension, "preserved");
    assert.equal(state.observations.length, 2);
    const observation = (await store.readRecord<{ content: import("@sciencediscovery/cas").AgentStateRef; details: unknown }>(state.observations[0]!)).value;
    assert.deepEqual(observation.details, {
      data: largeResult, nested: [{ apiToken: "[redacted]", body: "[omitted]" }],
    }, "persisted observations retain safe metadata without credentials or raw payloads");
    assert.doesNotMatch(JSON.stringify(observation.details), /audit-secret|private-body/);
    const modelObservation = JSON.parse((await store.readState(observation.content)).toString()) as { data: { text: string; truncated: boolean } };
    assert.equal(modelObservation.data.truncated, true);
    assert.equal(largeResult.startsWith(modelObservation.data.text.replace(/\.\.\.$/, "")), true);
    assert.ok(Buffer.byteLength(JSON.stringify(modelObservation), "utf8") <= 48 * 1024);
    const tree = (await store.readRecord<WorkspaceTree>(state.workspace)).value;
    const entry = tree.entries.find((item) => Buffer.from(item.name, "base64url").toString() === "result.txt")!;
    assert.equal(entry.type, "file");
    if (entry.type === "file") assert.deepEqual(await store.readData(entry.content), await readFile(resolve(workspace, "result.txt")));
    const modelContext = (await store.readRecord<{ input: ModelInput }>(first.modelContext, "ModelContextSnapshot")).value;
    assert.deepEqual(modelContext.input, received[0]);
    const trajectory = await openSessionTrajectory(dataDir, { sessionId: "session-version", agents: [{ id: "main:session-version", label: "Main" }], events: [
      ...events,
      { id: "mcp-first", agentId: "main:session-version", createdAt: new Date().toISOString(), runId: "request-1", event: { type: "mcp.invocation", toolCallId: "first", toolId: "write" } },
    ] }, new AbortController().signal);
    const mcp = trajectory.index.entries.find(item => item.kind === "mcp")!;
    assert.ok(mcp.contextId, JSON.stringify(trajectory.index.entries.map(e => ({ type: e.eventType, run: e.runId, context: e.contextId }))));
    assert.deepEqual((await trajectory.detail(mcp.id))!.context!.input, received[0]);
    assert.equal((await trajectory.detail(mcp.id))!.context!.blocks[0]!.attribution, "recorded");
    const event = trajectory.index.entries.find(item => item.eventType === "tool.started")!;
    assert.ok(event.timestamp);
    assert.ok(event.endTime);
    const journalEntries = trajectory.index.entries.filter(item => item.streamId === "main");
    assert.ok(journalEntries.length > 0);
    assert.ok(journalEntries.every(item => item.runId === "trajectory-1" && item.timestamp && item.sequence));
    assert.deepEqual(trajectory.index.historicalEntries, []);
    assert.ok(journalEntries.findIndex(item => item.label === "model.completed") < journalEntries.findIndex(item => item.eventType === "tool.started"));
    assert.deepEqual((await trajectory.detail(event.id))!.context!.input, received[0]);
    const inputState = (await store.readRecord<AgentStateSnapshot>(first.before)).value;
    const assembly = (await store.readRecord<ContextAssemblyRecord>(first.context)).value;
    assert.deepEqual(assembly.checkpoint, inputState.checkpoint);
    assert.deepEqual(inputState.checkpoint!.components.find((item) => item.id === "workspace")!.value, inputState.workspace);
    assert.deepEqual((inputState.checkpoint!.components.find((item) => item.id === "tools")!.value as { specs: unknown }).specs, received[0]!.tools);
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
      // Pinned to the native loop regardless of SCIENCE_AGENT_EXECUTOR: setModelTurnStreamerForTest above is a
      // native-agent-only hook the JiuwenSwarm executor never calls.
      createAgent: createNativeAgent,
      workspace: { ...base, workspaceRoot: parentRoot, runSubagent: async (input) => {
        await createAgentRun(childProfile, { createAgent: createNativeAgent, workspace: { ...base, workspaceRoot: childRoot } }, {
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

test("a completion record keeps the response id of the call it answers (#1133)", async (t) => {
  // The recorder holds `responseId` in one field, written synchronously by the
  // event path and cleared inside the recording queue by `beforeTurn` /
  // `afterAssembly`. Reading it when the queue drains is therefore a race: a
  // completion that was still being written could lose an id that had already
  // been issued for its own call.
  await mkdir(resolve(".tmp"), { recursive: true });
  const root = await mkdtemp(resolve(".tmp/versioning-response-id-"));
  const workspace = resolve(root, "workspace"); await mkdir(workspace);
  const records: Array<{ name: string; evidence: { turn?: number; responseId?: string } }> = [];
  const recorder = new AgentVersionRecorder<RuntimeMessage, { history: RuntimeMessage[] }, never>(resolve(root, "data"), workspace, {
    agentId: "response-id-agent", trajectoryId: "response-id-trajectory", requestExecutionId: "response-id-request",
    recordEvent: async (event: unknown) => { records.push(event as never); },
  }, () => ({}));
  t.after(() => rm(root, { recursive: true, force: true }));
  try {
    await recorder.initialize({}, []);
    await recorder.beforeTurn({ turn: 1, history: [] });
    await recorder.afterAssembly({ turn: 1, assembly: { history: [], modelInput: { history: [] } } });
    recorder.event({ type: "response_start", responseId: "r1", turn: 1 } as never);
    // The write below is queued; opening the next turn clears the field while it
    // drains, which is the interleaving that dropped the id in production.
    const completion = recorder.modelCompleted({ ok: true });
    await recorder.beforeTurn({ turn: 2, history: [] });
    await completion;
    const record = records.find((item) => item.name === "model.completed");
    assert.equal(record?.evidence.responseId, "r1", "the completion names the response it answers");
    assert.equal(record?.evidence.turn, 1, "and the turn that response belongs to");
  } finally { recorder.close(); }
});

test("an identity passed by the caller wins over a recorder field that has moved on (#1133)", async (t) => {
  // The JiuwenSwarm executor knows the response id per call and passes it, so a
  // record cannot be attributed to a neighbouring response even when the field
  // has already been cleared or replaced.
  await mkdir(resolve(".tmp"), { recursive: true });
  const root = await mkdtemp(resolve(".tmp/versioning-identity-"));
  const workspace = resolve(root, "workspace"); await mkdir(workspace);
  const records: Array<{ name: string; evidence: { turn?: number; responseId?: string } }> = [];
  const recorder = new AgentVersionRecorder<RuntimeMessage, { history: RuntimeMessage[] }, never>(resolve(root, "data"), workspace, {
    agentId: "identity-agent", trajectoryId: "identity-trajectory", requestExecutionId: "identity-request",
    recordEvent: async (event: unknown) => { records.push(event as never); },
  }, () => ({}));
  t.after(() => rm(root, { recursive: true, force: true }));
  try {
    await recorder.initialize({}, []);
    await recorder.beforeTurn({ turn: 1, history: [] });
    await recorder.afterAssembly({ turn: 1, assembly: { history: [], modelInput: { history: [] } } });
    recorder.event({ type: "response_start", responseId: "r9", turn: 1 } as never);
    await recorder.beforeTurn({ turn: 2, history: [] });
    await recorder.modelCompleted({ ok: true }, { turn: 1, responseId: "r9" });
    const record = records.find((item) => item.name === "model.completed");
    assert.equal(record?.evidence.responseId, "r9");
    assert.equal(record?.evidence.turn, 1);
  } finally { recorder.close(); }
});
test("a response id minted after the completion was requested still reaches it (#1133)", async (t) => {
  // A call with no text and no reasoning opens its response in the adapter,
  // after this record has been requested; that id belongs to this row and the
  // write must pick it up rather than persist "no id".
  await mkdir(resolve(".tmp"), { recursive: true });
  const root = await mkdtemp(resolve(".tmp/versioning-late-id-"));
  const workspace = resolve(root, "workspace"); await mkdir(workspace);
  const records: Array<{ name: string; evidence: { turn?: number; responseId?: string } }> = [];
  const recorder = new AgentVersionRecorder<RuntimeMessage, { history: RuntimeMessage[] }, never>(resolve(root, "data"), workspace, {
    agentId: "late-id-agent", trajectoryId: "late-id-trajectory", requestExecutionId: "late-id-request",
    recordEvent: async (event: unknown) => { records.push(event as never); },
  }, () => ({}));
  t.after(() => rm(root, { recursive: true, force: true }));
  try {
    await recorder.initialize({}, []);
    await recorder.beforeTurn({ turn: 1, history: [] });
    await recorder.afterAssembly({ turn: 1, assembly: { history: [], modelInput: { history: [] } } });
    const completion = recorder.modelCompleted({ toolCalls: ["x"] }, { turn: 1 });
    recorder.event({ type: "response_start", responseId: "late-1", turn: 1 } as never);
    await completion;
    const record = records.find((item) => item.name === "model.completed");
    assert.equal(record?.evidence.responseId, "late-1");
    assert.equal(record?.evidence.turn, 1);
  } finally { recorder.close(); }
});

test("a leftover id from another turn is never attributed to this record (#1133)", async (t) => {
  await mkdir(resolve(".tmp"), { recursive: true });
  const root = await mkdtemp(resolve(".tmp/versioning-foreign-id-"));
  const workspace = resolve(root, "workspace"); await mkdir(workspace);
  const records: Array<{ name: string; evidence: { turn?: number; responseId?: string } }> = [];
  const recorder = new AgentVersionRecorder<RuntimeMessage, { history: RuntimeMessage[] }, never>(resolve(root, "data"), workspace, {
    agentId: "foreign-id-agent", trajectoryId: "foreign-id-trajectory", requestExecutionId: "foreign-id-request",
    recordEvent: async (event: unknown) => { records.push(event as never); },
  }, () => ({}));
  t.after(() => rm(root, { recursive: true, force: true }));
  try {
    await recorder.initialize({}, []);
    await recorder.beforeTurn({ turn: 1, history: [] });
    await recorder.afterAssembly({ turn: 1, assembly: { history: [], modelInput: { history: [] } } });
    recorder.event({ type: "response_start", responseId: "r-one", turn: 1 } as never);
    await recorder.beforeTurn({ turn: 2, history: [] });
    await recorder.afterAssembly({ turn: 2, assembly: { history: [], modelInput: { history: [] } } });
    recorder.event({ type: "response_start", responseId: "r-two", turn: 2 } as never);
    await recorder.modelCompleted({ ok: true }, { turn: 1 });
    const record = records.find((item) => item.name === "model.completed");
    assert.notEqual(record?.evidence.responseId, "r-two", "the other turn's id must not be reused");
    assert.equal(record?.evidence.responseId, undefined);
  } finally { recorder.close(); }
});