// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";

import {
  ACTIVATE_EXECUTION_MODE_TOOL,
  createActivateExecutionModeTool,
  ExecutionModeRegistry,
} from "./index.js";

function tool(name: string) {
  return {
    description: name,
    async execute() { return { content: [], details: {} }; },
    label: name,
    name,
    parameters: Type.Object({}),
  };
}

test("only activation is available until a mode is selected", async () => {
  const directTool = tool("run_python");
  const registry = new ExecutionModeRegistry()
    .register({ descriptor: { description: "Direct", id: "direct", label: "Direct" }, tools: [directTool] })
    .freeze();
  assert.equal(registry.isToolAvailable(ACTIVATE_EXECUTION_MODE_TOOL), true);
  assert.equal(registry.isToolAvailable("run_python"), false);
  const activation = createActivateExecutionModeTool(registry);
  await activation.execute("call-1", { modeId: "direct" }, new AbortController().signal);
  assert.equal(registry.isToolAvailable("run_python"), true);
});

test("activation is stable and cannot switch modes mid-run", () => {
  const shared = tool("read_file");
  const registry = new ExecutionModeRegistry()
    .register({ descriptor: { description: "Direct", id: "direct", label: "Direct" }, tools: [shared] })
    .register({ descriptor: { description: "Plan", id: "plan", label: "Plan" }, tools: [shared] })
    .freeze();
  const first = registry.activate("plan");
  assert.equal(registry.activate("plan").activatedAt, first.activatedAt);
  assert.throws(() => registry.activate("direct"), /already active/u);
});

test("activation takes effect after sibling tool dispatch has observed the old mode", async () => {
  const directTool = tool("run_python");
  const registry = new ExecutionModeRegistry()
    .register({ descriptor: { description: "Direct", id: "direct", label: "Direct" }, tools: [directTool] })
    .freeze();
  const activation = createActivateExecutionModeTool(registry);
  const activationPromise = activation.execute("activate", { modeId: "direct" }, new AbortController().signal);
  assert.equal(registry.isToolAvailable("run_python"), false);
  await activationPromise;
  assert.equal(registry.isToolAvailable("run_python"), true);
});

test("different implementations cannot hide behind one tool name", () => {
  const registry = new ExecutionModeRegistry()
    .register({ descriptor: { description: "A", id: "a", label: "A" }, tools: [tool("same")] })
    .register({ descriptor: { description: "B", id: "b", label: "B" }, tools: [tool("same")] })
    .freeze();
  assert.throws(() => registry.allTools(), /incompatible implementations/u);
});
