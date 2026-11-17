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
  /** Creation and update bodies, so a case can read what actually went on the wire. */
  const writes: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  const sessions = new Map<string, { id: string; projectId: string; modelId: string; messages: unknown[] }>();
  let counter = 0;
  const client = { token: randomUUID(), request: async (path: string, init: RequestInit = {}) => {
    calls.push(path);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    if (method !== "GET") writes.push({ method, path, body });
    if (path === "/api/health") return { status: "ok" };
    if (path === "/api/models") return data.models;
    if (path === "/api/providers") return { providers: [], presets: [] };
    if (path === "/api/settings") return { overrides: { modelId: data.globalModel }, effective: { modelId: data.globalModel, defaultApprovalMode: "ask_for_dangerous" } };
    if (path === "/api/projects/inbox/settings") return { effective: { modelId: data.projectModel ?? data.globalModel } };
    if (path === "/api/inbox") return { id: "inbox" };
    // Deliberately include history: it must never bypass an empty catalog gate.
    if (path === "/api/projects" && method === "GET") return [{ id: "old-project", name: "Existing history" }];
    if (method === "POST" && path === "/api/projects") {
      const firstSession = { id: "project-first", projectId: "new-project", modelId: "first", messages: [] };
      sessions.set(firstSession.id, firstSession);
      return { project: { id: "new-project", name: String(body?.name ?? "") }, firstSession };
    }
    if (method === "POST" && path === "/api/projects/inbox/sessions") {
      counter += 1;
      const overrides = (body?.settingsOverrides ?? {}) as Record<string, unknown>;
      const created = { id: `created-${counter}`, projectId: "inbox", modelId: String(overrides.modelId ?? body?.modelId ?? "first"), messages: [] };
      sessions.set(created.id, created);
      return created;
    }
    const sessionMatch = /^\/api\/sessions\/([^/]+)(\/.*)?$/u.exec(path);
    if (sessionMatch) {
      const id = decodeURIComponent(sessionMatch[1]!);
      const rest = sessionMatch[2] ?? "";
      const current = sessions.get(id) ?? { id, projectId: "old-project", modelId: "first", messages: [] };
      if (method === "PATCH" && rest === "") {
        const next = { ...current, modelId: String(body?.modelId ?? current.modelId) };
        sessions.set(id, next);
        return next;
      }
      if (method === "GET" && rest === "") { sessions.set(id, current); return current; }
      if (rest === "/runs" || rest === "/files" || rest === "/artifact-outputs" || rest === "/artifacts") return [];
    }
    if (/^\/api\/projects\/[^/]+\/sessions\?state=active$/u.test(path)) return [];
    assert.fail(`Unexpected request: ${method} ${path}`);
  } } as unknown as ApiClient;
  let handle: ReturnType<typeof useWorkspace> | undefined;
  const rejectAuth = () => assert.fail("Unexpected auth failure");
  function Harness() { handle = useWorkspace(client, rejectAuth); return null; }
  let renderer: ReturnType<typeof create> | undefined;
  t.after(async () => {
    try { await act(async () => renderer?.unmount()); }
    finally {
      restoreGlobals.reverse();
      for (const restore of restoreGlobals) restore();
    }
  });
  await act(async () => { renderer = create(createElement(Harness)); });
  return { data, calls, writes, current: () => { assert.ok(handle); return handle; } };
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

/** Let a creation started by an action reach the fake server. */
async function settle() {
  for (let turn = 0; turn < 5; turn += 1) await act(async () => { await Promise.resolve(); });
}

test("a draft pick becomes the task model of the created conversation, not its review model", async t => {
  const { writes, current } = await workspace(t);
  await act(async () => { await current().actions.selectModel("second"); });
  await act(async () => { current().actions.newSession(); });
  await settle();
  const created = writes.filter((w) => w.method === "POST" && w.path === "/api/projects/inbox/sessions").at(-1);
  assert.ok(created, "the conversation was created");
  assert.deepEqual(created.body, { settingsOverrides: { modelId: "second" } },
    "only the task model follows the pick; the top-level shortcut would pin the review model too");
});

test("a new project's first conversation is switched to the same task model", async t => {
  const { writes, current } = await workspace(t);
  await act(async () => { await current().actions.selectModel("second"); });
  await act(async () => { await current().actions.createProject("New project"); });
  const update = writes.filter((w) => w.method === "PATCH" && w.path === "/api/sessions/project-first").at(-1);
  assert.deepEqual(update?.body, { modelId: "second" },
    "the project path changes the task model only, so both paths leave the review model alone");
});
