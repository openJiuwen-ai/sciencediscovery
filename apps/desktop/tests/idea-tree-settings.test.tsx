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
  await act(async () => { typeNumber(view, "最大深度", "7"); });
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

function inputByLabel(view: ReactTestRenderer, label: string) {
  return view.root.findAll((node) => node.type === "input" && node.props["aria-label"] === label)[0]!;
}

function textareaByLabel(view: ReactTestRenderer, label: string) {
  return view.root.findAll((node) => node.type === "textarea" && node.props["aria-label"] === label)[0]!;
}

function saveButton(view: ReactTestRenderer) {
  return view.root.findAll((node) => node.type === "button" && JSON.stringify(node.props.children).includes("保存"))[0]!;
}

/** Fire the event the browser sends for this field. The fallback to `onChange`
 *  keeps these regressions meaningful on the pre-fix component, which had no
 *  `onInput`; the assertions then describe the old behaviour instead of failing
 *  on a missing prop. */
function typeNumber(view: ReactTestRenderer, label: string, value: string, badInput = false) {
  const input = inputByLabel(view, label);
  const handler = input.props.onInput ?? input.props.onChange;
  const field = { value, validity: { badInput } };
  handler({ currentTarget: field, target: field });
}

function numberAlerts(view: ReactTestRenderer) {
  return view.root.findAll((node) => node.type === "small" && node.props.role === "alert" && String(node.props.className ?? "").includes("row-note is-error"));
}

async function openPane(api: ApiClient & { calls: unknown[] }) {
  let view!: ReactTestRenderer;
  await act(async () => { view = create(React.createElement(IdeaTreeSettings, { client: api })); });
  await act(async () => { await flush(); });
  return view;
}

test("an invalid token limit is refused instead of silently becoming 'no cap'", async () => {
  for (const typed of ["-5", "1e999", "0", "1.5"]) {
    const api = client();
    const view = await openPane(api);
    await act(async () => { typeNumber(view, "token 上限", typed); });
    assert.equal(inputByLabel(view, "token 上限").props.value, typed, `${typed} stays visible in the box`);
    assert.equal(inputByLabel(view, "token 上限").props["aria-invalid"], true, `${typed} is marked invalid on the input`);
    assert.equal(numberAlerts(view).length, 1, `${typed} shows one visible error`);
    assert.equal(numberAlerts(view)[0]!.props.children, "请输入不小于 1 的整数；留空表示不额外限制。");
    assert.equal(saveButton(view).props.disabled, true, `${typed} blocks Save`);
    // React-test-renderer still calls onClick with the disabled prop, so this also
    // proves the guard in save() refuses, not just the button appearance.
    await act(async () => { saveButton(view).props.onClick(); });
    await act(async () => { await flush(); });
    assert.equal(api.calls.filter((call) => call.method === "PUT").length, 0, `${typed} must not leave as a PUT`);
    view.unmount();
  }
});

test("maxDepth and maxNodes refuse values outside the store's ranges", async () => {
  // The notes name the range each field enforces: depth 1..20, nodes 2..10000.
  const cases = [
    ["最大深度", "0", "请输入 1 到 20 的整数。"],
    ["最大深度", "21", "请输入 1 到 20 的整数。"],
    ["最大深度", "-2", "请输入 1 到 20 的整数。"],
    ["最大深度", "2.5", "请输入 1 到 20 的整数。"],
    ["最大深度", "", "请输入 1 到 20 的整数。"],
    ["最大节点数", "0", "请输入 2 到 10000 的整数。"],
    ["最大节点数", "1", "请输入 2 到 10000 的整数。"],
    ["最大节点数", "10001", "请输入 2 到 10000 的整数。"],
    ["最大节点数", "2.5", "请输入 2 到 10000 的整数。"],
    ["最大节点数", "", "请输入 2 到 10000 的整数。"],
  ] as const;
  for (const [label, typed, note] of cases) {
    const api = client();
    const view = await openPane(api);
    await act(async () => { typeNumber(view, label, typed); });
    assert.equal(inputByLabel(view, label).props["aria-invalid"], true, `${label}=${typed} is marked invalid`);
    assert.equal(numberAlerts(view).length, 1, `${label}=${typed} shows one visible error`);
    assert.equal(numberAlerts(view)[0]!.props.role, "alert");
    assert.equal(numberAlerts(view)[0]!.props.children, note);
    // The note is the input's description, so assistive tech names the field.
    assert.equal(inputByLabel(view, label).props["aria-describedby"], numberAlerts(view)[0]!.props.id);
    assert.equal(saveButton(view).props.disabled, true, `${label}=${typed} blocks Save`);
    await act(async () => { saveButton(view).props.onClick(); });
    await act(async () => { await flush(); });
    assert.equal(api.calls.filter((call) => call.method === "PUT").length, 0, `${label}=${typed} must not be saved`);
    view.unmount();
  }
});

test("the inputs declare the store's bounds", async () => {
  const view = await openPane(client());
  const depth = inputByLabel(view, "最大深度");
  const nodes = inputByLabel(view, "最大节点数");
  const tokens = inputByLabel(view, "token 上限");
  assert.equal(depth.props.min, 1);
  assert.equal(depth.props.max, 20);
  assert.equal(nodes.props.min, 2);
  assert.equal(nodes.props.max, 10000);
  assert.equal(tokens.props.min, 1);
  view.unmount();
});

test("the boundary values at both ends of each range still save", async () => {
  const low = client();
  const lowView = await openPane(low);
  await act(async () => { typeNumber(lowView, "最大深度", "1"); });
  await act(async () => { typeNumber(lowView, "最大节点数", "2"); });
  await act(async () => { typeNumber(lowView, "token 上限", "1"); });
  await act(async () => { saveButton(lowView).props.onClick(); });
  await act(async () => { await flush(); });
  const lowPut = low.calls.filter((call) => call.method === "PUT")[0]!;
  assert.deepEqual(
    { maxDepth: (lowPut.body as { maxDepth: number }).maxDepth, maxNodes: (lowPut.body as { maxNodes: number }).maxNodes, maxTokens: (lowPut.body as { maxTokens: number }).maxTokens },
    { maxDepth: 1, maxNodes: 2, maxTokens: 1 },
  );
  lowView.unmount();

  const high = client();
  const highView = await openPane(high);
  await act(async () => { typeNumber(highView, "最大深度", "20"); });
  await act(async () => { typeNumber(highView, "最大节点数", "10000"); });
  await act(async () => { typeNumber(highView, "token 上限", String(Number.MAX_SAFE_INTEGER)); });
  await act(async () => { saveButton(highView).props.onClick(); });
  await act(async () => { await flush(); });
  const highPut = high.calls.filter((call) => call.method === "PUT")[0]!;
  assert.deepEqual(
    { maxDepth: (highPut.body as { maxDepth: number }).maxDepth, maxNodes: (highPut.body as { maxNodes: number }).maxNodes, maxTokens: (highPut.body as { maxTokens: number }).maxTokens },
    { maxDepth: 20, maxNodes: 10000, maxTokens: Number.MAX_SAFE_INTEGER },
  );
  highView.unmount();
});

test("a reload that lands after an edit does not overwrite the refused text", async () => {
  const calls: Array<{ method: string; body?: unknown }> = [];
  let gets = 0;
  let releaseReload!: () => void;
  const gate = new Promise<void>((resolve) => { releaseReload = resolve; });
  const stub = {
    request: async (path: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      calls.push({ method, body: init?.body ? JSON.parse(init.body) : undefined });
      if (method === "PUT") return { ...SETTINGS, ...(JSON.parse(init!.body!) as object) };
      gets += 1;
      if (gets === 1) return SETTINGS;
      await gate;
      return { ...SETTINGS, maxDepth: 3 };
    },
  };
  let view!: ReactTestRenderer;
  await act(async () => { view = create(React.createElement(IdeaTreeSettings, { client: stub as unknown as ApiClient })); });
  await act(async () => { await flush(); });
  await act(async () => { typeNumber(view, "最大深度", "7"); });
  await act(async () => { saveButton(view).props.onClick(); });
  await act(async () => { await flush(); });
  // save() reloads; while that GET is pending the user edits the same field.
  await act(async () => { typeNumber(view, "最大深度", "-5"); });
  await act(async () => { releaseReload(); await flush(); });
  assert.equal(inputByLabel(view, "最大深度").props.value, "-5", "typed text survives the late reload");
  assert.equal(inputByLabel(view, "最大深度").props["aria-invalid"], true, "the refused field is not healed");
  assert.equal(numberAlerts(view).length, 1);
  view.unmount();
});

test("a valid edit typed while the post-save reload is in flight is what Save sends next", async () => {
  const calls: Array<{ method: string; body?: unknown }> = [];
  let server: Record<string, unknown> = { ...SETTINGS };
  let gets = 0;
  let releaseReload!: () => void;
  const gate = new Promise<void>((resolve) => { releaseReload = resolve; });
  const stub = {
    request: async (path: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      calls.push({ method, body: init?.body ? JSON.parse(init.body) : undefined });
      if (method === "PUT") { server = { ...server, ...(JSON.parse(init!.body!) as object) }; return server; }
      gets += 1;
      if (gets === 2) await gate;
      return server;
    },
  };
  let view!: ReactTestRenderer;
  await act(async () => { view = create(React.createElement(IdeaTreeSettings, { client: stub as unknown as ApiClient })); });
  await act(async () => { await flush(); });
  await act(async () => { typeNumber(view, "最大深度", "7"); });
  await act(async () => { saveButton(view).props.onClick(); });
  await act(async () => { await flush(); });
  // The reload is in flight; type a valid 9. The old effect put the server's 7
  // back into the draft, so the next Save would have sent 7 while the box showed 9.
  await act(async () => { typeNumber(view, "最大深度", "9"); });
  await act(async () => { releaseReload(); await flush(); });
  assert.equal(inputByLabel(view, "最大深度").props.value, "9", "typed 9 survives the late reload");
  assert.equal(inputByLabel(view, "最大深度").props["aria-invalid"], false);
  await act(async () => { saveButton(view).props.onClick(); });
  await act(async () => { await flush(); });
  const puts = calls.filter((call) => call.method === "PUT");
  assert.equal(puts.length, 2);
  assert.equal((puts[1]!.body as { maxDepth: number }).maxDepth, 9, "the next Save sends what the box shows");
  assert.equal(inputByLabel(view, "最大深度").props.value, "9");
  view.unmount();
});

test("a prompt edit typed while the post-save reload is in flight survives", async () => {
  const calls: Array<{ method: string; body?: unknown }> = [];
  let server: Record<string, unknown> = { ...SETTINGS };
  let gets = 0;
  let releaseReload!: () => void;
  const gate = new Promise<void>((resolve) => { releaseReload = resolve; });
  const stub = {
    request: async (path: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      calls.push({ method, body: init?.body ? JSON.parse(init.body) : undefined });
      if (method === "PUT") { server = { ...server, ...(JSON.parse(init!.body!) as object) }; return server; }
      gets += 1;
      if (gets === 2) await gate;
      return server;
    },
  };
  let view!: ReactTestRenderer;
  await act(async () => { view = create(React.createElement(IdeaTreeSettings, { client: stub as unknown as ApiClient })); });
  await act(async () => { await flush(); });
  await act(async () => { typeNumber(view, "最大深度", "7"); });
  await act(async () => { saveButton(view).props.onClick(); });
  await act(async () => { await flush(); });
  // A non-number edit marks the pane dirty too: the late reload must not reseed it.
  await act(async () => { textareaByLabel(view, "设计阶段").props.onChange({ target: { value: "keep this prompt" } }); });
  await act(async () => { releaseReload(); await flush(); });
  assert.equal(textareaByLabel(view, "设计阶段").props.value, "keep this prompt");
  await act(async () => { saveButton(view).props.onClick(); });
  await act(async () => { await flush(); });
  const puts = calls.filter((call) => call.method === "PUT");
  assert.equal(puts.length, 2);
  assert.equal((puts[1]!.body as { designSystemPrompt: string }).designSystemPrompt, "keep this prompt");
  assert.equal(textareaByLabel(view, "设计阶段").props.value, "keep this prompt");
  view.unmount();
});

test("an edit typed while the PUT is in flight is not replaced by its response", async () => {
  const calls: Array<{ method: string; body?: unknown }> = [];
  let server: Record<string, unknown> = { ...SETTINGS };
  let releasePut!: () => void;
  const gate = new Promise<void>((resolve) => { releasePut = resolve; });
  const stub = {
    request: async (path: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      calls.push({ method, body: init?.body ? JSON.parse(init.body) : undefined });
      if (method === "PUT") {
        await gate;
        server = { ...server, ...(JSON.parse(init!.body!) as object) };
        return server;
      }
      return server;
    },
  };
  let view!: ReactTestRenderer;
  await act(async () => { view = create(React.createElement(IdeaTreeSettings, { client: stub as unknown as ApiClient })); });
  await act(async () => { await flush(); });
  await act(async () => { typeNumber(view, "最大深度", "7"); });
  await act(async () => { saveButton(view).props.onClick(); });
  await act(async () => { await flush(); });
  assert.equal(saveButton(view).props.disabled, true, "the PUT is in flight");
  await act(async () => { typeNumber(view, "最大深度", "9"); });
  await act(async () => { releasePut(); await flush(); });
  assert.equal(inputByLabel(view, "最大深度").props.value, "9", "typed 9 is not replaced by the response's 7");
  const saved = view.root.findAll((node) => node.type === "small" && node.props.role === "status");
  assert.equal(saved.length, 0, "the pane does not claim the typed 9 was saved");
  await act(async () => { saveButton(view).props.onClick(); });
  await act(async () => { await flush(); });
  const puts = calls.filter((call) => call.method === "PUT");
  assert.equal(puts.length, 2);
  assert.equal((puts[1]!.body as { maxDepth: number }).maxDepth, 9);
  assert.equal(inputByLabel(view, "最大深度").props.value, "9");
  view.unmount();
});

test("an empty token limit still means the API's null, and valid counts still save", async () => {
  const api = client();
  const view = await openPane(api);
  await act(async () => { typeNumber(view, "token 上限", "4096"); });
  await act(async () => { typeNumber(view, "token 上限", ""); });
  await act(async () => { typeNumber(view, "最大节点数", "200"); });
  assert.equal(inputByLabel(view, "token 上限").props["aria-invalid"], false);
  assert.equal(saveButton(view).props.disabled, false, "valid values keep Save enabled");
  await act(async () => { saveButton(view).props.onClick(); });
  await act(async () => { await flush(); });
  const puts = api.calls.filter((call) => call.method === "PUT");
  assert.equal(puts.length, 1, "one PUT for valid values");
  assert.equal((puts[0]!.body as { maxTokens: number | null }).maxTokens, null, "empty stays null");
  assert.equal((puts[0]!.body as { maxNodes: number }).maxNodes, 200);
  assert.equal((puts[0]!.body as { maxDepth: number }).maxDepth, 5);
  view.unmount();
});

test("correcting a refused value clears the error and saves the corrected number", async () => {
  const api = client();
  const view = await openPane(api);
  await act(async () => { typeNumber(view, "token 上限", "-5"); });
  assert.equal(numberAlerts(view).length, 1);
  await act(async () => { typeNumber(view, "token 上限", "4096"); });
  assert.equal(inputByLabel(view, "token 上限").props["aria-invalid"], false);
  assert.equal(numberAlerts(view).length, 0, "the error disappears once the value is valid");
  assert.equal(saveButton(view).props.disabled, false);
  await act(async () => { saveButton(view).props.onClick(); });
  await act(async () => { await flush(); });
  const puts = api.calls.filter((call) => call.method === "PUT");
  assert.equal(puts.length, 1);
  assert.equal((puts[0]!.body as { maxTokens: number }).maxTokens, 4096);
  view.unmount();
});

test("a number input's badInput state is refused instead of read as an empty box", async () => {
  // Chromium reports "1e999" in <input type="number"> as value="" with
  // validity.badInput=true; treating that as empty is what saved maxTokens: null.
  for (const label of ["最大深度", "最大节点数"]) {
    const api = client();
    const view = await openPane(api);
    await act(async () => { typeNumber(view, label, "", true); });
    assert.equal(inputByLabel(view, label).props["aria-invalid"], true, `${label}: badInput is invalid`);
    assert.equal(numberAlerts(view).length, 1, `${label}: one alert`);
    assert.equal(saveButton(view).props.disabled, true, `${label}: badInput blocks Save`);
    await act(async () => { saveButton(view).props.onClick(); });
    await act(async () => { await flush(); });
    assert.equal(api.calls.filter((call) => call.method === "PUT").length, 0, `${label}: no PUT`);
    view.unmount();
  }

  const api = client();
  const view = await openPane(api);
  await act(async () => { typeNumber(view, "token 上限", "", true); });
  assert.equal(inputByLabel(view, "token 上限").props["aria-invalid"], true, "tokens: badInput is invalid");
  assert.equal(numberAlerts(view).length, 1, "tokens: one alert");
  assert.equal(numberAlerts(view)[0]!.props.children, "请输入不小于 1 的整数；留空表示不额外限制。");
  assert.equal(saveButton(view).props.disabled, true, "tokens: badInput blocks Save");
  await act(async () => { saveButton(view).props.onClick(); });
  await act(async () => { await flush(); });
  assert.equal(api.calls.filter((call) => call.method === "PUT").length, 0, "badInput must not become maxTokens: null");

  // The field recovers as soon as the text is a real number again.
  await act(async () => { typeNumber(view, "token 上限", "12"); });
  assert.equal(inputByLabel(view, "token 上限").props["aria-invalid"], false);
  assert.equal(numberAlerts(view).length, 0);
  await act(async () => { saveButton(view).props.onClick(); });
  await act(async () => { await flush(); });
  const puts = api.calls.filter((call) => call.method === "PUT");
  assert.equal(puts.length, 1);
  assert.equal((puts[0]!.body as { maxTokens: number }).maxTokens, 12);
  view.unmount();
});
