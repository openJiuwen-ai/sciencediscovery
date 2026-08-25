// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { createContextTraceWriter } from "./trace.js";

test("context traces are disabled by default", () => {
  assert.equal(createContextTraceWriter("/tmp/data", {}), undefined);
});

test("context trace exports one private JSON record per model turn", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "context-trace-"));
  const writer = createContextTraceWriter(root, { SCIENCE_AGENT_CONTEXT_TRACE: "1" });
  assert.ok(writer);
  await writer.write("session:run", 2, { llmInput: { systemPrompt: "prompt" }, selectedPath: "dynamic" });
  const path = resolve(root, "context-traces", "session_run", "turn-0002.json");
  const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  assert.equal(record.schemaVersion, 2);
  assert.equal(record.selectedPath, "dynamic");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});
