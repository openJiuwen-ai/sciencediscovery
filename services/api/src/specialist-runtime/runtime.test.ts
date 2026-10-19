// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { Codex, type ThreadEvent } from "@openai/codex-sdk";
import { Type } from "typebox";
import { specialistConfigHash, ideaTreeFingerprint } from "@sciencediscovery/idea-tree";
import { createSubagentProfile, type AgentEvent } from "@sciencediscovery/orchestration";
import type { Specialist } from "@sciencediscovery/schema";
import type { AgentTool } from "@sciencediscovery/tools";
import { CasStore } from "@sciencediscovery/cas";
import { createAgentPermissionRuntime } from "@sciencediscovery/governance";
import { routeSpecialistPermissions } from "./permissions.js";
import { normalizeSpecialistRuntime } from "./config.js";
import { CodexSpecialistAdapter, type CodexFactory } from "./codex.js";
import type { SpecialistRuntimeEvent, SpecialistRuntimeRequest } from "./adapter.js";
import { codexAgentFactory } from "./agent.js";
import { runSubagentTask } from "../agent-run/orchestrators.js";
import { SessionStore } from "../store.js";
import { prepareSubagentHandoff } from "../subagents/index.js";
import { normalizePersistedSubagent } from "../store/subagents.js";

const specialist: Specialist = { id: "custom", name: "Coder", description: "Code", instructions: "Solve it", connectorIds: [], enabledSkillIds: [], createdAt: "old", updatedAt: "new" };
const request = (overrides: Partial<SpecialistRuntimeRequest> = {}): SpecialistRuntimeRequest => ({ prompt: "Task", signal: new AbortController().signal, credential: async () => "test-secret", maxTurns: 4, tools: [], ...overrides });
const decision = (tool: string | null = null, args = "{}") => JSON.stringify({ tool, arguments: args, summary: "Finished" });
const events = (text: string): ThreadEvent[] => [
  { type: "thread.started", thread_id: "codex-thread" },
  { type: "item.completed", item: { type: "agent_message", id: "msg", text } },
  { type: "turn.completed", usage: { input_tokens: 2, output_tokens: 3, cached_input_tokens: 1, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } },
];
const factory = (turns: ThreadEvent[][]): CodexFactory => () => ({ async runStreamed() { return { events: (async function* () { yield* turns.shift()!; })() }; } });

test("runtime validation rejects credentials, argv, unsupported adapters and invalid models", () => {
  assert.equal(normalizeSpecialistRuntime(undefined), undefined);
  assert.deepEqual(normalizeSpecialistRuntime({ kind: "native" }), { kind: "native" });
  assert.deepEqual(normalizeSpecialistRuntime({ kind: "codex", model: "gpt-code" }), { kind: "codex", model: "gpt-code" });
  for (const value of [null, [], "codex", { kind: "acp" }, { kind: "codex", apiKey: "secret" }, { kind: "codex", args: ["secret"] }, { kind: "native", model: "x" }, { kind: "codex", model: "--evil" }, { kind: "codex", model: 1 }]) {
    assert.throws(() => normalizeSpecialistRuntime(value));
  }
});

test("native/omitted hashes exactly match legacy; non-native runtime changes hash", () => {
  const legacy = ideaTreeFingerprint({ builtIn: false, connectorIds: [], description: "Code", enabled: true, enabledSkillIds: [], id: "custom", instructions: "Solve it", name: "Coder" });
  assert.equal(specialistConfigHash(specialist), legacy);
  assert.equal(specialistConfigHash({ ...specialist, runtime: { kind: "native" } }), legacy);
  const codex = { ...specialist, runtime: { kind: "codex" as const } };
  assert.notEqual(specialistConfigHash(codex), legacy);
  assert.notEqual(specialistConfigHash(codex), specialistConfigHash({ ...codex, runtime: { kind: "codex", model: "other" } }));
});

test("Store create/update/reload preserves metadata and frozen hash; credentials stay encrypted outside catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "sd-runtime-store-"));
  try {
    const store = new SessionStore(root); await store.load();
    const profile = await store.createSpecialist({ ...specialist, runtime: { kind: "codex" } });
    assert.deepEqual((await store.updateSpecialist(profile.id, { description: "New" })).runtime, { kind: "codex" });
    const project = await store.createProject("Runtime");
    const session = await store.createSession(project.id, "Runtime", {}, {}, { allowUnconfiguredModel: true });
    let child = await store.createSubagent(session.id, "run", { description: "Work", prompt: "Work", specialistId: profile.id }, { specialistConfigHash: "frozen", timeoutSeconds: 60, maxTurns: 4 });
    assert.throws(() => store.configureCodex(child.id, "stale", "secret"), /no longer pending/);
    child = await store.updateSubagent({ ...child, runtimeInput: { id: "card", runtime: "codex", state: "pending" }, runtimeSessionId: "thread" });
    assert.throws(() => store.configureCodex(child.id, "card", ""), /API key/);
    store.configureCodex(child.id, "card", "test-secret-unique");
    assert.equal(store.codexApiKey(session.id), "test-secret-unique");
    assert.equal(store.codexApiKey("other-session"), undefined);
    const persisted = normalizePersistedSubagent(child)!;
    assert.equal(persisted.specialistConfigHash, "frozen");
    assert.equal(persisted.runtimeSessionId, "thread");
    assert.equal(persisted.runtimeInput?.id, "card");
    assert.equal("runtimeInput" in persisted.input, false);
    const reopened = new SessionStore(root); await reopened.load();
    assert.deepEqual(reopened.getSpecialist(profile.id)?.runtime, { kind: "codex" });
    assert.equal(reopened.codexApiKey(session.id), "test-secret-unique");
    // Catalog and raw SQLite never hold the plaintext credential.
    for (const name of ["catalog.sqlite", "catalog.sqlite-wal"]) {
      const data = await readFile(join(root, name)).catch(() => Buffer.alloc(0));
      assert.equal(data.includes(Buffer.from("test-secret-unique")), false);
    }
    await store.updateSubagent({ ...child, status: "completed" });
    assert.throws(() => store.configureCodex(child.id, "card", "late"), /no longer pending/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("adapter maps SDK events, validates tool requests, accumulates usage and accepts only platform artifacts", async () => {
  const observed: SpecialistRuntimeEvent[] = [];
  let calls = 0;
  const tool: AgentTool = { name: "declare_artifact", label: "Declare", description: "Declare", parameters: Type.Object({ path: Type.String() }), execute: async (_id, args) => {
    assert.deepEqual(args, { path: "result.txt" }); calls++;
    return { content: [{ type: "text", text: "registered" }], details: { artifact: { id: "platform-artifact" }, version: 1 } };
  } };
  const result = await new CodexSpecialistAdapter(factory([events(decision("declare_artifact", '{"path":"result.txt"}')), events(decision())])).invoke(request({ tools: [tool] }), async event => { observed.push(event); });
  assert.equal(calls, 1); assert.equal(result.summary, "Finished"); assert.equal(result.runtimeSessionId, "codex-thread");
  assert.equal(result.artifacts.length, 1); assert.equal(result.usage?.totalTokens, 10);
  assert.deepEqual(observed.map(e => e.type), ["progress", "started", "tool_call", "tool_call", "progress", "started", "done"]);
});

for (const [name, stream, pattern] of [
  ["invalid JSON", events("{"), /invalid platform decision/],
  ["invalid shape", events('{}'), /invalid platform decision/],
  ["unknown tool", events(decision("host_shell")), /unavailable platform tool/],
  ["incomplete stream", [], /incomplete/],
  ["oversized decision", events("x".repeat(100001)), /oversized/],
  ["provider error", [{ type: "error", message: "test-secret" }], /provider request failed/],
  ["failed turn", [{ type: "turn.failed", error: { message: "test-secret" } }], /provider request failed/],
  ["native tool", [{ type: "item.started", item: { type: "command_execution", id: "bad", command: "touch host", aggregated_output: "", status: "in_progress" } }], /disabled native tool/],
] as const) {
  test(`adapter rejects ${name} without credential leakage`, async () => {
    await assert.rejects(new CodexSpecialistAdapter(factory([[...stream] as ThreadEvent[]])).invoke(request(), async () => {}), pattern);
  });
}

test("invalid JSON and schema arguments cannot reach tool execution", async () => {
  const tool: AgentTool = { name: "test", label: "Test", description: "Test", parameters: Type.Object({ path: Type.String() }), execute: async () => { assert.fail("must not execute"); } };
  for (const args of ["{", '{"path":1}']) {
    await assert.rejects(new CodexSpecialistAdapter(factory([events(decision("test", args))])).invoke(request({ tools: [tool] }), async () => {}), /Invalid platform tool arguments/);
  }
});

test("turn budget and sink failure stop execution; SDK errors are redacted", async () => {
  await assert.rejects(new CodexSpecialistAdapter(factory([])).invoke(request({ maxTurns: 0 }), async () => {}), /maximum turns/);
  const adapter = new CodexSpecialistAdapter(() => { throw Error("provider echoed test-secret"); });
  await assert.rejects(adapter.invoke(request(), async () => {}), error => error instanceof Error && !error.message.includes("test-secret"));
  await assert.rejects(new CodexSpecialistAdapter(factory([])).invoke(request(), async () => { throw Error("sink failed"); }), /runtime failed/);
});

test("cancel before launch and during credential wait; timeout stops a streaming adapter", async () => {
  const cancelled = new AbortController(); cancelled.abort();
  let launched = false;
  const adapter = new CodexSpecialistAdapter(() => { launched = true; throw Error("unexpected"); });
  await assert.rejects(adapter.invoke(request({ signal: cancelled.signal }), async () => {}), { name: "AbortError" });
  assert.equal(launched, false);
  const signal = AbortSignal.timeout(20);
  await assert.rejects(adapter.invoke(request({ signal, credential: async () => { await delay(1000, undefined, { signal }); return "x"; } }), async () => {}), { name: "AbortError" });
  assert.equal(launched, false);
  const streaming: CodexFactory = () => ({ async runStreamed(_input, opts) { return { events: (async function* () { await delay(1000, undefined, { signal: opts!.signal }); yield* events(decision()); })() }; } });
  await assert.rejects(new CodexSpecialistAdapter(streaming).invoke(request({ signal: AbortSignal.timeout(20) }), async () => {}), { name: "TimeoutError" });
});

test("official SDK executable transport receives isolated config and secret env, never secret argv", async () => {
  const root = await mkdtemp(join(tmpdir(), "sd-sdk-test-"));
  let sdkHome = "";
  try {
    const cli = join(root, "fixture.mjs");
    await writeFile(cli, `#!/usr/bin/env node\nlet input=''; for await (const chunk of process.stdin) input+=chunk;\nif(process.argv.join(' ').includes('test-secret')) process.exit(10);\nif(process.env.CODEX_API_KEY!=='test-secret') process.exit(11);\nfor(const event of ${JSON.stringify(events(decision()))}) console.log(JSON.stringify(event));\n`, { mode: 0o700 });
    const adapter = new CodexSpecialistAdapter((options, thread) => {
      assert.equal(options.config?.features && (options.config.features as Record<string, unknown>).shell_tool, false);
      assert.equal(thread.sandboxMode, "read-only");
      assert.equal(thread.networkAccessEnabled, false);
      assert.equal(options.env?.OPENAI_API_KEY, undefined);
      sdkHome = options.env!.CODEX_HOME!;
      return new Codex({ ...options, codexPathOverride: cli }).startThread(thread);
    });
    assert.equal((await adapter.invoke(request({ model: "test-model" }), async () => {})).summary, "Finished");
    await assert.rejects(access(sdkHome));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("existing Subagent AgentRun receives normalized events and executes through platform bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "sd-child-runtime-"));
  const observed: AgentEvent[] = [];
  const runtimeEvents: SpecialistRuntimeEvent[] = [];
  try {
    const store = new SessionStore(root); await store.load();
    const project = await store.createProject("Task");
    const session = await store.createSession(project.id, "Child", {}, {}, { allowUnconfiguredModel: true });
    const child = await store.createSubagent(session.id, "lead", { description: "Codex task", prompt: "Produce output" });
    const handoff = await prepareSubagentHandoff(store, session.id, child.id, child.input);
    assert.ok(handoff.workspaceId);
    let executed = false;
    const createAgent = codexAgentFactory({ maxTurns: 3, credential: async (_signal, need) => { await need(); return "test-secret"; },
      onRuntimeEvent: async e => { runtimeEvents.push(e); },
      adapter: new CodexSpecialistAdapter(factory([events(decision("run_shell", '{"command":"echo output"}')), events(decision("declare_artifact", '{"path":"result.txt"}')), events(decision())])) });
    const handle = runSubagentTask({ bindings: { createAgent, observer: e => { observed.push(e); }, workspace: {
      config: { baseUrl: "http://unused.test", dataDir: root, model: "unused" }, enabledConnectorIds: [],
      workspaceRoot: store.agentWorkspacePath(session.id, child.id),
      declareArtifact: async input => {
        const bytes = await readFile(join(store.agentWorkspacePath(session.id, child.id), input.path));
        return store.createArtifactVersion({ content: await new CasStore(root).put(bytes), kind: "other", logicalName: "result.txt", mediaType: "text/plain", origin: "llm_declared", sessionId: session.id, turnId: child.id });
      },
      executePython: async () => { assert.fail("unused"); },
      executeShell: async (code, mode) => { assert.equal(code, "echo output"); assert.equal(mode, "ephemeral"); executed = true; await writeFile(join(store.agentWorkspacePath(session.id, child.id), "result.txt"), "platform-output"); return { exitCode: 0, stdout: "output", stderr: "", createdFiles: ["result.txt"], modifiedFiles: [], kernelMode: "ephemeral", language: "shell", environmentRevisionId: "fixture", cgroupMode: "none", environmentVariables: {}, executionId: "fixture", finishedAt: "now", startedAt: "then", kernelId: "fixture", networkPolicy: "none", runnerVersion: "fixture", sandbox: "bubblewrap", workingDirectory: "/workspace" }; },
    } }, profile: createSubagentProfile({ connectorIds: [], deniedToolNames: ["task"], gatewayThreadId: child.id, maxModelTurns: 3, presetId: "general-purpose", runTimeoutMs: 30000, workspaceRoot: store.agentWorkspacePath(session.id, child.id) }),
      prompt: "delegated brief", requestExecutionId: child.id });
    const result = await handle.execute();
    assert.equal(executed, true);
    const completed = runtimeEvents.findLast(e => e.type === "done");
    assert.equal(completed?.type === "done" ? completed.result.artifacts.length : 0, 1);
    assert.equal(await readFile(join(store.agentWorkspacePath(session.id, child.id), "result.txt"), "utf8"), "platform-output");
    assert.equal(store.listProjectArtifacts(project.id).length, 1);
    assert.equal(result.finalMessages.at(-1)?.content, "Finished");
    assert.ok(observed.some(e => e.type === "tool_execution_end"));
    assert.ok(observed.some(e => e.type === "message_update" && e.assistantMessageEvent.type === "text_delta"));
    assert.ok(runtimeEvents.some(e => e.type === "need_input"));
    assert.ok(runtimeEvents.some(e => e.type === "file_change"));
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("Codex child uses platform approval while the Swarm lead retains native decisions in one permission cell", async () => {
  const root = await mkdtemp(join(tmpdir(), "sd-runtime-permission-"));
  try {
    const store = new SessionStore(root); await store.load();
    const project = await store.createProject("Permission routing");
    const session = await store.createSession(project.id, "Ask before code", {}, {}, { allowUnconfiguredModel: true });
    const external = new Set(["codex-child"]);
    const required: string[] = [];
    const runtime = createAgentPermissionRuntime(store.getSessionPermissionEpoch(session.id)!, {
      requestPermission: routeSpecialistPermissions(
        (action, resource, _summary, context) => store.authorizeByJiuwenSwarm(session.id, action, resource, context),
        (action, resource, summary, context) => store.requestPermission(session.id, action, resource, summary, context), external),
      readEpoch: () => store.getSessionPermissionEpoch(session.id),
      readAuthorization: id => store.getPermissionAuthorization(id),
      emitRequired: request => { required.push(request.executionId!); },
      waitForDecision: async request => ({ ...request, state: "denied" }),
    });
    await runtime.requirePrivilege({ action: "code", resource: "lead-command", summary: "Native lead", executionId: "lead" });
    await assert.rejects(runtime.requirePrivilege({ action: "code", resource: "external-command", summary: "Codex command", executionId: "codex-child" }), /Permission denied/);
    assert.deepEqual(required, ["codex-child"], "Swarm approval must not authorize a Codex execution");
    await runtime.requirePrivilege({ action: "code", resource: "native-child-command", summary: "Native child", executionId: "native-child" });
    assert.deepEqual(required, ["codex-child"]);
    external.delete("codex-child");
    await runtime.requirePrivilege({ action: "code", resource: "native-again", summary: "Native", executionId: "codex-child" });
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("file-change events include modified files and omit unchanged executions", async () => {
  for (const changed of [false, true]) {
    const observed: SpecialistRuntimeEvent[] = [];
    const tool: AgentTool = { name: "run_shell", label: "Run", description: "Run", parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "Executed by platform" }], details: { modifiedFiles: changed ? ["input.txt"] : [] } }) };
    await new CodexSpecialistAdapter(factory([events(decision("run_shell")), events(decision())])).invoke(request({ tools: [tool] }), async e => { observed.push(e); });
    assert.deepEqual(observed.filter(e => e.type === "file_change").map(e => e.details), changed ? [{ paths: ["input.txt"] }] : []);
  }
});
