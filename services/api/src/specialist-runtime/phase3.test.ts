// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { SessionStore } from "../store.js";
import { normalizeSpecialistRuntime } from "./config.js";
import { mainRuntimeConfigTool } from "./main-config.js";
import { runPlatformDecisions } from "./decisions.js";
import { SpecialistUnavailableError } from "./codex.js";
import type { SpecialistRuntimeRequest } from "./adapter.js";
const request = (overrides: Partial<SpecialistRuntimeRequest> = {}): SpecialistRuntimeRequest => ({ prompt: "Task", maxTurns: 4, tools: [], credential: async () => "secret", signal: new AbortController().signal, ...overrides });
const decision = (tool: string | null = null, args = "{}") => JSON.stringify({ tools: tool === null ? [] : [{ tool, arguments: args }], summary: "done" });

test("all runtimes accept only credential-free metadata", () => {
  for (const kind of ["codex", "claude-code", "acp"]) {
    assert.deepEqual(normalizeSpecialistRuntime({ kind, model: "model", fallback: false }), { kind, model: "model", fallback: false });
    for (const field of ["apiKey", "env", "args", "command", "token", "binary"]) assert.throws(() => normalizeSpecialistRuntime({ kind, [field]: "secret" }));
  }
});

test("shared dispatch validates tools and arguments, rejects native work and prevents fallback replay", async () => {
  let calls = 0;
  const tools = [{ name: "run_shell", description: "Run", label: "Run", parameters: Type.Object({ command: Type.String() }), execute: async () => { calls++; return { content: [] }; } }];
  for (const output of ["bad json", decision("run_shell", '{"command":4}'), decision("run_shell", "null")]) {
    await assert.rejects(runPlatformDecisions(request({ tools }), async () => {}, async () => output));
  }
  assert.equal(calls, 0);
  let turn = 0;
  await assert.rejects(runPlatformDecisions(request({ tools }), async () => {}, async () => {
    if (turn++) throw new SpecialistUnavailableError("Provider unavailable");
    return decision("run_shell", '{"command":"echo ok"}');
  }), error => error instanceof Error && !(error instanceof SpecialistUnavailableError));
  assert.equal(calls, 1);
});

test("shared dispatch cancellation prevents work and declared-only handoff remains explicit", async () => {
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(runPlatformDecisions(request({ signal: cancelled.signal }), async () => {}, async () => { assert.fail("cancelled"); }), { name: "AbortError" });
  const outputs = [decision("declare_artifact"), decision()];
  const result = await runPlatformDecisions(request({ tools: [{ name: "declare_artifact", description: "Declare", label: "Declare", parameters: Type.Object({}), execute: async () => ({ content: [], details: { id: "verified" } }) }] }), async () => {}, async () => outputs.shift()!);
  assert.deepEqual(result.artifacts, [{ id: "verified" }]);
});

test("main agent configures settings; runtime secrets remain session/provider scoped across reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "sd-p3-config-"));
  try {
    let store = new SessionStore(root); await store.load();
    const project = await store.createProject("P3");
    const session = await store.createSession(project.id, "P3", {}, {}, { allowUnconfiguredModel: true });
    for (const kind of ["codex", "claude-code", "acp"] as const) {
      const specialist = await store.createSpecialist({ name: kind, description: "test", instructions: "test", runtime: { kind } });
      await mainRuntimeConfigTool(store).execute("config", { specialistId: specialist.id, settings: { model: "requested-model", fallback: false } });
      assert.equal(store.getSpecialist(specialist.id)?.runtime?.kind, kind);
      let child = await store.createSubagent(session.id, "lead", { specialistId: specialist.id, description: "test", prompt: "work" });
      child = await store.updateSubagent({ ...child, runtimeInput: { id: kind, runtime: kind, state: "pending" } });
      store.configureRuntime(child.id, kind, `${kind}-secret`);
      assert.equal(store.runtimeApiKey(session.id, kind), `${kind}-secret`);
      await store.updateSubagent({ ...child, runtimeDiagnostics: { fallbackCount: 1, failureReason: "unavailable", sandboxProbe: { ok: false, mode: "sandbox" } } });
    }
    assert.doesNotMatch(await readFile(join(root, "catalog.json"), "utf8").catch(() => JSON.stringify(store.listSubagents(session.id))), /codex-secret|claude-code-secret|acp-secret/);
    store = new SessionStore(root); await store.load();
    for (const kind of ["codex", "claude-code", "acp"] as const) assert.equal(store.runtimeApiKey(session.id, kind), `${kind}-secret`);
    assert.ok(store.listSubagents(session.id).every(child => child.runtimeDiagnostics?.fallbackCount === 1));
  } finally { await rm(root, { recursive: true, force: true }); }
});
