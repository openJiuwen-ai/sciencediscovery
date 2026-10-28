// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { Type } from "typebox";

import { ToolRegistry } from "./registry.js";
import { retiredToolGuidance } from "./retired-tools.js";

const resultMessage = (call: { id: string; name: string }, content: string) => ({
  role: "tool" as const,
  name: call.name,
  tool_call_id: call.id,
  content,
});

test("retiredToolGuidance covers removed Python and R entry points only", () => {
  assert.match(retiredToolGuidance("run_python")!, /run_shell/);
  assert.match(retiredToolGuidance("run_python")!, /command|scriptPath/);
  assert.match(retiredToolGuidance("run_r")!, /run_shell/);
  assert.equal(retiredToolGuidance("run_shell"), undefined);
  assert.equal(retiredToolGuidance("missing"), undefined);
});

test("calling retired run_python returns recoverable RETIRED_TOOL guidance", async () => {
  const registry = new ToolRegistry([{
    name: "run_shell",
    label: "Shell",
    description: "Shell",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text" as const, text: "ok" }], details: {} };
    },
  }], { createResultMessage: resultMessage });

  const result = await registry.execute(
    { args: { code: "print(1)" }, id: "py-1", name: "run_python" },
    new AbortController().signal,
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /run_shell/);
  assert.match(result.content, /removed/i);
  assert.deepEqual(result.details, {
    ok: false,
    error: {
      code: "RETIRED_TOOL",
      message: retiredToolGuidance("run_python"),
      retryable: true,
    },
  });
});

test("calling retired run_r returns recoverable RETIRED_TOOL guidance", async () => {
  const registry = new ToolRegistry([], { createResultMessage: resultMessage });
  const result = await registry.execute(
    { args: {}, id: "r-1", name: "run_r" },
    new AbortController().signal,
  );
  assert.equal(result.isError, true);
  assert.equal((result.details as { error: { code: string; retryable: boolean } }).error.code, "RETIRED_TOOL");
  assert.equal((result.details as { error: { retryable: boolean } }).error.retryable, true);
  assert.match(result.content, /Rscript|run_shell/);
});

test("truly unknown tools stay UNKNOWN_TOOL and non-retryable", async () => {
  const registry = new ToolRegistry([], { createResultMessage: resultMessage });
  const result = await registry.execute(
    { args: {}, id: "x-1", name: "totally_missing" },
    new AbortController().signal,
  );
  assert.equal(result.isError, true);
  assert.deepEqual(result.details, {
    ok: false,
    error: {
      code: "UNKNOWN_TOOL",
      message: "Unknown tool: totally_missing",
      retryable: false,
    },
  });
});
