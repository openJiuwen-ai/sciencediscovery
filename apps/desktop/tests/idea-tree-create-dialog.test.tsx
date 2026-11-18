// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { ApiClient } from "../src/api/client.js";
import { IdeaTreeCreateDialog } from "../src/views/idea/IdeaTreeCreateDialog.js";
import { ideaTreeCommandTask, isIdeaTreeCommand } from "../src/idea/command.js";

const SETTINGS = {
  templateId: "scientific-hypothesis-general/v1",
  explorationIntensity: "standard",
  maxTokens: null,
  maxTokensPerCall: 32768,
  maxDepth: 5,
  maxNodes: 100,
  scoreDirection: "maximize",
};

function fakeClient() {
  const calls: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
  const stub = {
    calls,
    request: async (path: string, init?: { method?: string; body?: string }) => {
      calls.push({ path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) as Record<string, unknown> : undefined });
      if (path === "/api/settings/idea-tree") return SETTINGS;
      return { research: { id: "research-1", status: "running", phase: "building_tree", round: 0, batch: [], batchCompleted: 0, tokens: 0, usageKnown: false, reason: null, modelId: "m", objective: "目标", settings: {} }, graph: { nodes: [], edges: [], objective: "", revision: 0, treeId: "t", updatedAt: "" } };
    },
  };
  return stub as unknown as ApiClient & { calls: typeof calls };
}

const flush = async (times = 10) => { for (let i = 0; i < times; i += 1) await Promise.resolve(); };

test("the command is a task, not a message", () => {
  assert.equal(isIdeaTreeCommand("/idea-tree 研究膜通量"), true);
  assert.equal(isIdeaTreeCommand("/idea-tree-team 研究膜通量"), true);
  assert.equal(isIdeaTreeCommand("/evolve-design x"), false);
  assert.equal(ideaTreeCommandTask("/idea-tree 研究膜通量"), "研究膜通量");
  assert.equal(ideaTreeCommandTask("/idea-tree-team 研究膜通量"), "研究膜通量");
});

test("off means the stored defaults: the create call carries no settings", async () => {
  const api = fakeClient();
  let started = 0;
  let view!: ReactTestRenderer;
  await act(async () => { view = create(React.createElement(IdeaTreeCreateDialog, {
    client: api, onClose: () => undefined, onStarted: () => { started += 1; }, sessionId: "s1", task: "研究膜通量",
  })); });
  await act(async () => { await flush(); });
  const start = view.root.findAll((node) => node.type === "button").at(-1)!;
  await act(async () => { start.props.onClick(); });
  await act(async () => { await flush(); });
  const create_call = api.calls.find((call) => call.method === "POST")!;
  assert.equal(create_call.body?.operation, "create");
  assert.equal(create_call.body?.content, "研究膜通量");
  assert.equal("settings" in (create_call.body ?? {}), false, "the switch was off");
  assert.equal(started, 1);
  view.unmount();
});

test("on means this research alone is configured", async () => {
  const api = fakeClient();
  let view!: ReactTestRenderer;
  await act(async () => { view = create(React.createElement(IdeaTreeCreateDialog, {
    client: api, onClose: () => undefined, onStarted: () => undefined, sessionId: "s1", task: "研究膜通量",
  })); });
  await act(async () => { await flush(); });
  const toggle = view.root.findAll((node) => node.props?.role === "switch")[0]!;
  await act(async () => { toggle.props.onClick(); });
  const start = view.root.findAll((node) => node.type === "button").at(-1)!;
  await act(async () => { start.props.onClick(); });
  await act(async () => { await flush(); });
  const create_call = api.calls.find((call) => call.method === "POST")!;
  const settings = create_call.body?.settings as Record<string, unknown> | undefined;
  assert.ok(settings, "the switch was on");
  assert.equal(settings!.maxDepth, 5);
  assert.equal("rounds" in (settings ?? {}), false, "retired fields are not sent");
  view.unmount();
});
