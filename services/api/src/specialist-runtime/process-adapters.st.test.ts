// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:st", "sandbox:bubblewrap", "os:linux", "arch:amd64", "arch:arm64", "model:mock"] });
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { Type } from "typebox";
import { AcpSpecialistAdapter, ClaudeCodeSpecialistAdapter } from "./process-adapters.js";
import type { SpecialistRuntimeEvent, SpecialistRuntimeRequest } from "./adapter.js";
import { SpecialistUnavailableError } from "./codex.js";
const binary = fileURLToPath(new URL("../../../../test/api/fixtures-specialist-runtime.cjs", import.meta.url));
const request = (overrides: Partial<SpecialistRuntimeRequest> = {}): SpecialistRuntimeRequest => ({ prompt: "Task", signal: AbortSignal.timeout(10000), maxTurns: 4, tools: [], credential: async () => "phase3-fixture-secret", ...overrides });

test("real sandboxed Claude/ACP transports overlap with independent platform tool bindings and declared handoff", { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "sd-p3-st-"));
  let arrivals = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  try {
    const results = await Promise.all([new ClaudeCodeSpecialistAdapter({ binary }), new AcpSpecialistAdapter({ binary })].map(async (adapter, index) => {
      const file = join(root, `${index}.txt`);
      const observed: SpecialistRuntimeEvent[] = [];
      const result = await adapter.invoke(request({ tools: [
        { name: "run_shell", label: "Run", description: "Run", parameters: Type.Object({ command: Type.String() }), execute: async () => {
          if (++arrivals === 2) release();
          await barrier;
          await writeFile(file, adapter.kind);
          return { content: [] };
        } },
        { name: "declare_artifact", label: "Declare", description: "Declare", parameters: Type.Object({ path: Type.String() }), execute: async () => ({ content: [], details: { verified: await readFile(file, "utf8") } }) },
      ] }), async event => { observed.push(event); });
      assert.ok(observed.some(event => event.type === "sandbox_probe" && event.ok));
      assert.ok(observed.some(event => event.type === "started" && event.runtimeSessionId));
      assert.equal(result.summary, `${adapter.kind} completed`);
      return result.artifacts;
    }));
    assert.equal(arrivals, 2);
    assert.deepEqual(results, [[{ verified: "claude-code" }], [{ verified: "acp" }]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Claude cancellation kills a held transport without fallback", { timeout: 10000 }, async () => {
  await assert.rejects(new ClaudeCodeSpecialistAdapter({ binary }).invoke(request({ prompt: "[hold]", signal: AbortSignal.timeout(1000) }), async () => {}), { name: "TimeoutError" });
});

test("ACP cancellation kills a held transport without fallback", { timeout: 10000 }, async () => {
  await assert.rejects(new AcpSpecialistAdapter({ binary }).invoke(request({ prompt: "[hold]", signal: AbortSignal.timeout(1000) }), async () => {}), { name: "TimeoutError" });
});

test("launch failure reports a failed sandbox probe with sanitized unavailability", async () => {
  const events: SpecialistRuntimeEvent[] = [];
  await assert.rejects(new AcpSpecialistAdapter({ binary: "/missing/phase3-fixture-secret" }).invoke(request(), async event => { events.push(event); }), error => error instanceof SpecialistUnavailableError && !error.message.includes("phase3-fixture-secret"));
  assert.ok(events.some(event => event.type === "sandbox_probe" && !event.ok));
});


test("ACP native permission requests are denied rather than authorizing local exec", async () => {
  const result = await new AcpSpecialistAdapter({ binary, args: ["--native-permission"] }).invoke(request(), async () => {});
  assert.equal(result.summary, "permission denied");
  assert.deepEqual(result.artifacts, []);
});

test("ACP native tool updates fail closed without runtime fallback", async () => {
  await assert.rejects(new AcpSpecialistAdapter({ binary, args: ["--native-tool"] }).invoke(request(), async () => {}), error => error instanceof Error && !(error instanceof SpecialistUnavailableError) && /disabled native tool/.test(error.message));
});
