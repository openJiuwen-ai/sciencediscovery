// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { act, create } from "./support/dom-renderer.js";
import { ApiRequestError, type ApiClient } from "../src/api/client.js";
import { useWorkspace } from "../src/app/use-workspace.js";

test("model polling retries quietly, recovers, and still reports explicit refresh and auth failures", async t => {
  const intervals = new Map<number, () => void>();
  const fakeWindow = Object.assign(new EventTarget(), {
    setInterval: (callback: () => void, ms: number) => {
      assert.equal(ms, 5_000);
      intervals.set(1, callback); return 1;
    },
    clearInterval: (id: number) => { intervals.delete(id); },
    setTimeout: (callback: () => void, ms: number) => { const timer = setTimeout(callback, ms); timer.unref(); return timer; },
  });
  const fakeDocument = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const restoreGlobals: Array<() => void> = [];
  for (const [key, value] of [["window", fakeWindow], ["document", fakeDocument], ["IS_REACT_ACT_ENVIRONMENT", true]] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    restoreGlobals.push(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
  let failure: Error | undefined;
  let modelReads = 0;
  const client = { token: randomUUID(), request: async (path: string) => {
    if (path === "/api/health") return { status: "ok" };
    if (path === "/api/models") {
      modelReads++;
      if (failure) throw failure;
      return [{ id: "m", name: "Model", model: "model" }];
    }
    if (path === "/api/providers") return { providers: [], presets: [] };
    if (path === "/api/settings" || path === "/api/projects/inbox/settings") return { overrides: { modelId: "m" }, effective: { modelId: "m" } };
    if (path === "/api/inbox") return { id: "inbox" };
    if (path === "/api/projects" || path === "/api/projects/inbox/sessions?state=active") return [];
    assert.fail(`Unexpected request: ${path}`);
  } } as unknown as ApiClient;
  let handle: ReturnType<typeof useWorkspace> | undefined;
  let authFailures = 0;
  const rejectAuth = () => { authFailures++; };
  function Harness() { handle = useWorkspace(client, rejectAuth); return null; }
  let renderer: ReturnType<typeof create> | undefined;
  t.after(async () => {
    try { await act(async () => renderer?.unmount()); }
    finally { for (const restore of restoreGlobals.reverse()) restore(); }
  });
  await act(async () => { renderer = create(createElement(Harness)); });
  assert.ok(handle);
  assert.equal(handle.boot, "ready");
  assert.deepEqual(handle.state.toasts, []);
  const refresh = intervals.get(1);
  assert.ok(refresh);
  const initialReads = modelReads;
  failure = new Error("backend restarting");
  await act(async () => { refresh(); });
  await act(async () => { refresh(); });
  await act(async () => { fakeWindow.dispatchEvent(new Event("focus")); });
  await act(async () => { fakeDocument.dispatchEvent(new Event("visibilitychange")); });
  assert.equal(modelReads, initialReads + 4);
  assert.deepEqual(handle.state.toasts, []);
  failure = undefined;
  await act(async () => { refresh(); });
  assert.equal(handle.state.models[0]?.id, "m");
  assert.deepEqual(handle.state.toasts, []);
  failure = new Error("explicit refresh failed");
  await act(async () => { await handle?.actions.refreshCatalog(); });
  assert.equal(handle.state.toasts.length, 1);
  failure = new ApiRequestError("credential rejected", 401);
  await act(async () => { refresh(); });
  assert.equal(authFailures, 1);
});
