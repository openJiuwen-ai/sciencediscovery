// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import React from "react";
import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { act, create, type ReactTestRenderer } from "./support/dom-renderer.js";
import type { ApiClient } from "../src/api/client.js";
import type { WorkbenchSearchResult } from "../src/api/types.js";
import { useWorkspace } from "../src/app/use-workspace.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
const globals = globalThis as { window?: unknown; IS_REACT_ACT_ENVIRONMENT?: boolean };
const STORE = new Map<string, string>();
globals.window = {
  localStorage: {
    getItem: (key: string) => STORE.get(key) ?? null,
    removeItem: (key: string) => { STORE.delete(key); },
    setItem: (key: string, value: string) => { STORE.set(key, value); },
  },
  setTimeout: (callback: () => void, ms: number) => { const timer = setTimeout(callback, ms); timer.unref(); return timer; },
};
globals.IS_REACT_ACT_ENVIRONMENT = true;
// `browserStorage()` reads the global, not `window`: the harness has to
// publish the same object there or persistence is never exercised.
(globalThis as { localStorage?: unknown }).localStorage =
  (globals.window as { localStorage: unknown }).localStorage;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function backend() {
  const calls: { path: string; method?: string }[] = [];
  const client = {
    token: "",
    request: async (path: string, init?: RequestInit) => {
      calls.push({ path, method: init?.method });
      if (path.endsWith("/artifact-outputs")) return [];
      if (/^\/api\/sessions\/[^/]+$/.test(path)) {
        const id = path.split("/").pop()!;
        return { id, projectId: "p", messages: [] };
      }
      if (path.endsWith("/runs")) return [];
      if (path === "/api/models") return [];
      if (path === "/api/providers") return { presets: [], providers: [] };
      if (path.endsWith("/settings")) return { overrides: {}, effective: {} };
      if (path === "/api/inbox") return { id: "inbox" };
      if (path.startsWith("/api/projects")) return [{ id: "p", name: "P" }];
      return [];
    },
    fetchStream: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } })),
  } as unknown as ApiClient;
  return { client, calls };
}

async function mount(client: ApiClient) {
  let handle!: ReturnType<typeof useWorkspace>;
  let renderer!: ReactTestRenderer;
  function Harness() { handle = useWorkspace(client, () => {}); return null; }
  await act(async () => { renderer = create(<Harness />); });
  return { get handle() { return handle; }, close: () => act(async () => renderer.unmount()) };
}

function hit(over: Partial<WorkbenchSearchResult> = {}): WorkbenchSearchResult {
  return { detail: "", id: "artifact:doc", kind: "artifact", label: "doc.md", projectId: "p", sessionId: "b", ...over };
}

test("an artifact hit for another Session starts that Session's read", async () => {
  // The regression this guards: the artifact branch returned before
  // `openSession`, so the pending wait was registered and then cleared by an
  // effect that saw the Session never changed — the click opened nothing at all.
  const api = backend();
  const view = await mount(api.client);
  await act(async () => { await view.handle.actions.openSession("a"); });
  api.calls.length = 0;

  await act(async () => { view.handle.actions.openSearchResult(hit()); await tick(); });

  assert.ok(api.calls.some(call => call.path === "/api/sessions/b"),
    "the hit names Session b, so reading b is what has to begin");
  await view.close();
});

test("a Project hit switches to that Project's bare id, not the prefixed one", async () => {
  const api = backend();
  const view = await mount(api.client);
  api.calls.length = 0;

  await act(async () => {
    view.handle.actions.openSearchResult(hit({ id: "project:p", kind: "project", projectId: "p", sessionId: undefined }));
    await tick();
  });

  const settings = api.calls.filter(call => call.path.startsWith("/api/projects/") && call.path.endsWith("/settings"));
  assert.ok(settings.length > 0, "switching Projects reads its settings");
  assert.ok(settings.every(call => !call.path.includes("project:")),
    "the kind prefix must not reach the route: " + settings.map(call => call.path).join(", "));
  await view.close();
});
