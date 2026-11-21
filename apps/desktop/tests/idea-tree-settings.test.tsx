// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { ApiRequestError, type ApiClient } from "../src/api/client.js";
import { IdeaTreeSettings } from "../src/views/settings/IdeaTreeSettings.js";

const SETTINGS = {
  templateId: "scientific-hypothesis-general/v1",
  explorationIntensity: "standard",
  maxTokens: null,
  maxDepth: 5,
  maxNodes: 100,
  scoreDirection: "maximize",
  designSystemPrompt: "",
};

function client(options: { failRead?: boolean } = {}) {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const stub = {
    calls,
    request: async (path: string, init?: { method?: string; body?: string }) => {
      calls.push({ path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined });
      if (options.failRead) throw new ApiRequestError("Evolve is not initialized or unavailable", 503);
      if ((init?.method ?? "GET") === "PUT") return { ...SETTINGS, ...(JSON.parse(init!.body!) as object) };
      return SETTINGS;
    },
  };
  return stub as unknown as ApiClient & { calls: typeof calls };
}

async function flush(times = 8): Promise<void> {
  for (let tick = 0; tick < times; tick += 1) await Promise.resolve();
}

test("the pane renders only the settings the API accepts", async () => {
  const api = client();
  let view!: ReactTestRenderer;
  await act(async () => { view = create(React.createElement(IdeaTreeSettings, { client: api })); });
  await act(async () => { await flush(); });
  const text = JSON.stringify(view.toJSON());
  assert.match(text, /研究模板/);
  assert.match(text, /探索强度/);
  assert.match(text, /评分方向/);
  assert.match(text, /最大深度/);
  assert.match(text, /最大节点数/);
  // The retired engine fields must not come back through this pane.
  assert.doesNotMatch(text, /最多轮次/);
  assert.doesNotMatch(text, /每轮候选数/);
  assert.doesNotMatch(text, /评估提示词/);
  // Every stage follows the research model's thinking level, so the pane's
  // per-stage effort rows stay out; the values are no longer configurable.
  assert.doesNotMatch(text, /各阶段思考强度/);
  assert.doesNotMatch(text, /跟随模型/);
  // The save row sits at the right edge of the page, like the other settings
  // pages' actions: `is-end` is the shared modifier that does it.
  const actions = view.root.findAll((node) => node.type === "div" && String(node.props.className ?? "").includes("settings-actions"));
  assert.equal(actions.length, 1, "one action row");
  assert.equal(actions[0]!.props.className, "settings-actions is-end");
  view.unmount();
});

test("saving sends the live field set", async () => {
  const api = client();
  let view!: ReactTestRenderer;
  await act(async () => { view = create(React.createElement(IdeaTreeSettings, { client: api })); });
  await act(async () => { await flush(); });
  const depth = view.root.findAll((node) => node.type === "input" && node.props["aria-label"] === "最大深度")[0]!;
  await act(async () => { depth.props.onChange({ target: { value: "7" } }); });
  const save = view.root.findAll((node) => node.type === "button" && JSON.stringify(node.props.children).includes("保存"))[0]!;
  await act(async () => { save.props.onClick(); });
  await act(async () => { await flush(); });
  const put = api.calls.find((call) => call.method === "PUT");
  assert.ok(put, "the pane PUTs the settings");
  assert.equal(put!.path, "/api/settings/idea-tree");
  assert.equal((put!.body as { maxDepth: number }).maxDepth, 7);
  assert.equal((put!.body as { templateId: string }).templateId, "scientific-hypothesis-general/v1");
  assert.equal("rounds" in (put!.body as object), false, "retired fields are not sent");
  assert.equal("roleThinkingEfforts" in (put!.body as object), false, "stages follow the model, so no effort map is sent");
  view.unmount();
});

test("a 503 is shown as a prerequisite, not as an empty form", async () => {
  const api = client({ failRead: true });
  let view!: ReactTestRenderer;
  await act(async () => { view = create(React.createElement(IdeaTreeSettings, { client: api })); });
  await act(async () => { await flush(); });
  const text = JSON.stringify(view.toJSON());
  assert.match(text, /尚未就绪/);
  view.unmount();
});
