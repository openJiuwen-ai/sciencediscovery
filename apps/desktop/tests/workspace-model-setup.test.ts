// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { createElement } from "react";
import { act, create } from "./support/dom-renderer.js";
import type { ApiClient } from "../src/api/client.js";
import { useWorkspace } from "../src/app/use-workspace.js";

async function workspace(t: TestContext, initiallyEmpty = false) {
  const fakeWindow = Object.assign(new EventTarget(), {
    setInterval: () => 1,
    clearInterval: () => {},
  });
  const fakeDocument = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const restoreGlobals: Array<() => void> = [];
  for (const [key, value] of [["window", fakeWindow], ["document", fakeDocument], ["IS_REACT_ACT_ENVIRONMENT", true]] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    restoreGlobals.push(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
  const data = {
    models: initiallyEmpty ? [] : [{ id: "first", name: "A", model: "a" }, { id: "second", name: "B", model: "b" }],
    globalModel: undefined as string | undefined,
    projectModel: undefined as string | undefined,
  };
  const calls: string[] = [];
  const client = { token: randomUUID(), request: async (path: string) => {
    calls.push(path);
    if (path === "/api/health") return { status: "ok" };
    if (path === "/api/models") return data.models;
    if (path === "/api/providers") return { providers: [], presets: [] };
    if (path === "/api/settings") return { overrides: { modelId: data.globalModel } };
    if (path === "/api/projects/inbox/settings") return { effective: { modelId: data.projectModel ?? data.globalModel } };
    if (path === "/api/inbox") return { id: "inbox" };
    // Deliberately include history: it must never bypass an empty catalog gate.
    if (path === "/api/projects") return [{ id: "old-project", name: "Existing history" }];
    if (/^\/api\/projects\/[^/]+\/sessions\?state=active$/u.test(path)) return [];
    assert.fail(`Unexpected request: ${path}`);
  } } as unknown as ApiClient;
  let handle: ReturnType<typeof useWorkspace> | undefined;
  const rejectAuth = () => assert.fail("Unexpected auth failure");
  function Harness() { handle = useWorkspace(client, rejectAuth); return null; }
  let renderer: ReturnType<typeof create> | undefined;
  t.after(async () => {
    try { await act(async () => renderer?.unmount()); }
    finally { for (const restore of restoreGlobals.reverse()) restore(); }
  });
  await act(async () => { renderer = create(createElement(Harness)); });
  return { data, calls, current: () => { assert.ok(handle); return handle; } };
}

test("an empty model catalog requires setup without reading or exposing history", async t => {
  const { current, calls } = await workspace(t, true);
  assert.equal(current().boot, "setup");
  assert.equal(current().state.selectedModelId, undefined);
  assert.ok(!calls.includes("/api/projects"));
  assert.ok(!calls.includes("/api/inbox"));
});

test("new drafts automatically select a model while preserving project and explicit choices", async t => {
  const { current, data } = await workspace(t);
  assert.equal(current().boot, "ready");
  assert.equal(current().state.selectedModelId, "first");
  assert.equal(current().state.defaultModelId, undefined);
  data.globalModel = "second";
  await act(async () => { await current().actions.refreshCatalog(); });
  assert.equal(current().state.selectedModelId, "second");
  data.projectModel = "first";
  await act(async () => { await current().actions.refreshCatalog(); });
  assert.equal(current().state.selectedModelId, "first");
  await act(async () => { await current().actions.selectModel("second"); });
  await act(async () => { await current().actions.refreshCatalog(); });
  assert.equal(current().state.selectedModelId, "second");
});

test("losing the last model returns to mandatory setup and configuration unlocks the workspace", async t => {
  const { current, data } = await workspace(t);
  await act(async () => { await current().actions.selectModel("second"); });
  data.models = [];
  await act(async () => { await current().actions.refreshCatalog(); });
  assert.equal(current().boot, "setup");
  assert.equal(current().state.selectedModelId, undefined);
  data.models = [{ id: "new", name: "New model", model: "new" }];
  data.globalModel = "new";
  await act(async () => { await current().actions.refreshCatalog(); });
  assert.equal(current().boot, "setup", "saving a model still requires finishing the wizard");
  await act(async () => { current().actions.finishSetup(); });
  assert.equal(current().boot, "ready");
  assert.equal(current().state.selectedModelId, "new");
});
