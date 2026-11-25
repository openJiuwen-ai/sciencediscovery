// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import React from "react";
import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { act, create, type ReactTestRenderer } from "./support/dom-renderer.js";
import type { ApiClient } from "../src/api/client.js";
import { useWorkspace } from "../src/app/use-workspace.js";
import { SEARCH_DEBOUNCE_MS } from "../src/app/session-search.js";
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
// `browserStorage()` reads the global, not `window`.
(globalThis as { localStorage?: unknown }).localStorage =
  (globals.window as { localStorage: unknown }).localStorage;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const KEY = "sciencediscovery-desktop:search-narrowing";

function session(id: string, projectId: string, title: string) {
  return { createdAt: "2026-10-01T00:00:00.000Z", id, projectId, title, updatedAt: "2026-10-01T00:00:00.000Z" };
}

function backend() {
  const client = {
    token: "",
    request: async (path: string) => {
      if (path.endsWith("/artifact-outputs")) return [];
      if (path.startsWith("/api/search")) {
        // Two session hits, one from each Project: the query's own answer, so the
        // assertion can tell a narrowed result apart from an empty one.
        return {
          hasMore: false, limit: 20, offset: 0, total: 2,
          results: [
            { detail: "P", id: "session:s1", kind: "session", label: "one", projectId: "p", projectName: "P", sessionId: "s1" },
            { detail: "Q", id: "session:s2", kind: "session", label: "two", projectId: "q", projectName: "Q", sessionId: "s2" },
          ],
        };
      }
      if (path === "/api/inbox") return { id: "inbox" };
      if (/^\/api\/projects\/[^/]+\/sessions/.test(path)) {
        if (path.includes("/p/sessions")) return [session("s1", "p", "one")];
        if (path.includes("/q/sessions")) return [session("s2", "q", "two")];
        return [];
      }
      if (path.startsWith("/api/projects")) return [{ id: "p", name: "P" }, { id: "q", name: "Q" }];
      if (path.endsWith("/runs")) return [];
      if (path === "/api/models") return [];
      if (path === "/api/providers") return { presets: [], providers: [] };
      if (path.endsWith("/settings")) return { overrides: {}, effective: {} };
      return [];
    },
    fetchStream: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } })),
  } as unknown as ApiClient;
  return { client };
}

async function mount(client: ApiClient) {
  let handle!: ReturnType<typeof useWorkspace>;
  let renderer!: ReactTestRenderer;
  function Harness() { handle = useWorkspace(client, () => {}); return null; }
  await act(async () => { renderer = create(<Harness />); });
  return { get handle() { return handle; }, close: () => act(async () => renderer.unmount()) };
}

async function listed(over: Record<string, unknown>) {
  STORE.set(KEY, JSON.stringify({ onlyRunning: false, onlyWithArtifacts: false, projectIds: [], window: "all", ...over }));
  const view = await mount(backend().client);
  await act(async () => { await view.handle.actions.refreshSessions(); await tick(); });
  return view;
}

test("with no query the Project selection narrows the column itself", async () => {
  // #1251's fourth criterion: the list is narrowable, not only the results.
  const view = await listed({ projectIds: ["p"] });
  const byProject = view.handle.state.sessionsByProject as Record<string, { id: string }[]>;
  assert.deepEqual(byProject.p.map(row => row.id), ["s1"], "the chosen Project keeps its Sessions");
  assert.deepEqual(byProject.q.map(row => row.id), [], "another Project's fold is narrowed away");
  await view.close();
  STORE.clear();
});

test("with no narrowing the column lists every active Session", async () => {
  const view = await listed({});
  const byProject = view.handle.state.sessionsByProject as Record<string, { id: string }[]>;
  assert.deepEqual(byProject.p.map(row => row.id), ["s1"]);
  assert.deepEqual(byProject.q.map(row => row.id), ["s2"], "no selection means no fold is filtered");
  await view.close();
  STORE.clear();
});

test("with a query the column keeps every active Session", async () => {
  // Only the no-query half narrows the column; a query narrows its results and
  // the column stays whole. Dropping the `searchQuery` half of `columnNarrowed`
  // has to fail somewhere, and this is the case that says so.
  const view = await listed({ projectIds: ["p"] });
  await act(async () => {
    view.handle.actions.search("one");
    // The field debounces the route, so the answer lands after SEARCH_DEBOUNCE_MS;
    // `act` flushes the state that answer sets when this callback resolves.
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 200));
  });
  const byProject = view.handle.state.sessionsByProject as Record<string, { id: string }[]>;
  assert.deepEqual(byProject.p.map(row => row.id), ["s1"]);
  assert.deepEqual(byProject.q.map(row => row.id), ["s2"],
    "a query narrows the results, not the folds");
  const hits = view.handle.state.searchResults?.results.map(hit => hit.sessionId);
  assert.deepEqual(hits, ["s1"], "the query's own results are narrowed to the chosen Project");
  await view.close();
  STORE.clear();
});
