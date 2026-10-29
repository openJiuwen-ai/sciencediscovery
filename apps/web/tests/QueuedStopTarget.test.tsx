// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { ComposerRunButton } from "../src/composer/model.js";
import { App } from "../src/App.js";
import { LocaleProvider } from "../src/i18n/index.js";
import { requestRunStop } from "../src/run-stream/model.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

/** Minimal browser surface the mounted App touches; captures only the 5s Stop grace timer. */
function installBrowserStubs() {
  const location = { pathname: "/", search: "", hash: "" };
  const grace: Array<() => void> = [];
  const realSetTimeout = globalThis.setTimeout;
  const otherTimers = new Set<ReturnType<typeof setTimeout>>();
  const applyUrl = (url: string) => {
    const parsed = new URL(url, "http://localhost");
    location.pathname = parsed.pathname; location.search = parsed.search; location.hash = parsed.hash;
  };
  Object.assign(globalThis, {
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined, clear: () => undefined, key: () => null, length: 0 },
    document: { addEventListener: () => undefined, removeEventListener: () => undefined, querySelector: () => null, documentElement: { style: {} } },
    setTimeout: ((callback: () => void, delayMs?: number) => {
      if (delayMs === 5_000) { grace.push(callback); return 0 as unknown as ReturnType<typeof setTimeout>; }
      const timer = realSetTimeout(callback, delayMs);
      otherTimers.add(timer);
      return timer;
    }) as typeof setTimeout,
    window: {
      location,
      history: { replaceState: (_s: unknown, _t: string, url?: string | URL | null) => { if (url) applyUrl(String(url)); }, pushState: (_s: unknown, _t: string, url?: string | URL | null) => { if (url) applyUrl(String(url)); } },
      addEventListener: () => undefined, removeEventListener: () => undefined,
      setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
      setInterval, clearInterval,
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    },
  });
  return {
    graceCount: () => grace.length,
    fireGrace: () => { for (const callback of grace.splice(0)) callback(); },
    restore: () => { for (const timer of otherTimers) clearTimeout(timer); globalThis.setTimeout = realSetTimeout; },
  };
}

const session = { id: "session-1", projectId: "project-1", title: "Queued stop", messages: [], enabledConnectorIds: [], enabledSkillIds: [], modelId: "model-1", settingsOverrides: {} };
const runA = { id: "run-a", prompt: "first", references: [], annotationIds: [], sessionId: session.id, status: "running", createdAt: "now", settingsSnapshot: { enabledConnectorIds: [], enabledSkillIds: [], modelId: "model-1", semanticReviewEnabled: false } };
const model = { id: "model-1", model: "m1", name: "M1", providerId: "p", baseUrl: "http://127.0.0.1:1/v1", apiProtocol: "openai-chat-completions", apiVariant: "openai", facts: {}, hasApiToken: true };

function startupBody(path: string): unknown {
  const url = path.split("?")[0] ?? path;
  if (url === "/api/projects") return [{ id: "project-1", name: "Alpha", remoteRunnerHostIds: [], localRunnerEnabled: true }];
  if (url === "/api/providers") return { presets: [], providers: [] };
  if (url === "/api/quota-settings") return { uploadMaxFileBytes: 1, uploadMaxRequestBytes: 2, runnerMaxWorkspaceBytes: 3 };
  if (url === "/api/model-catalog") return { models: [model] };
  if (url === "/api/models") return [model];
  if (url === "/api/mcp/proxy-policies") return { policies: {} };
  if (url === "/api/search") return { results: [], hasMore: false, total: 0 };
  if (url === "/api/settings") return { overrides: {}, effective: {}, sources: {} };
  if (url === "/api/memory/settings") return { enabled: false };
  if (url === "/api/memory/subgraph") return { nodes: [], edges: [], reason: "memory_graph_disabled" };
  if (url === "/api/projects/project-1/sessions") return [session];
  if (url === "/api/sessions/session-1") return session;
  if (url === "/api/sessions/session-1/runs") return [];
  if (url === "/api/sessions/session-1/agent-activity") return { executions: [], timers: [], transfers: [], agents: [] };
  if (url === "/api/sessions/session-1/usage") return { totals: {}, byRun: [], byModel: [], bySession: [] };
  if (/\/configuration\/preflight$/.test(url)) return { status: "not_applicable" };
  if (/configuration-requests$/.test(url)) return { items: [] };
  if (url === "/api/connectors") return [];
  if (url === "/api/specialists") return [];
  return [];
}

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); });
}

test("a queued acceptance does not steal Stop from the active run", async () => {
  const browser = installBrowserStubs();
  const previousFetch = globalThis.fetch;
  const posts: Array<{ signal?: AbortSignal; push: (chunk: string) => void; close: () => void }> = [];
  let messagePosts = 0;
  let cancels = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const path = url.split("?")[0] ?? url;
    if (path === "/api/sessions/session-1/messages" && init?.method === "POST") {
      messagePosts++;
      const runId = messagePosts === 1 ? "run-a" : "run-b";
      let push = (_chunk: string) => {}; let close = () => {};
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          push = (chunk: string) => controller.enqueue(encoder.encode(chunk));
          close = () => controller.close();
        },
      });
      posts.push({ signal: init.signal ?? undefined, push, close });
      const response = new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "x-sciencediscovery-run-id": runId } });
      queueMicrotask(() => {
        if (messagePosts === 1) push(`data: ${JSON.stringify({ type: "run.started", runId: "run-a", model: { name: "M1" }, settings: {} })}\n\n`);
        else push(`data: ${JSON.stringify({ type: "run.queued", run: { ...runA, id: "run-b", prompt: "second", status: "queued" } })}\n\n`);
      });
      return response;
    }
    if (path === "/api/sessions/session-1/runs/current/cancel") { cancels++; return jsonResponse({ ...runA, status: "cancelled" }); }
    return jsonResponse(startupBody(url));
  }) as typeof fetch;

  let view: ReactTestRenderer | undefined;
  try {
    await act(async () => { view = create(createElement(LocaleProvider, { initialLocale: "en" }, createElement(App, { initialToken: "test-token" }))); });
    await settle();
    await act(async () => { view!.root.findByType("textarea").props.onChange({ target: { value: "first" } }); });
    await act(async () => { view!.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    await settle();
    assert.equal(messagePosts, 1, "the first message starts one accepted run");
    assert.equal(posts[0]?.signal?.aborted, false);

    // A second message while run-a is active is accepted by the server but queued behind it.
    await act(async () => { view!.root.findByType("textarea").props.onChange({ target: { value: "second" } }); });
    await act(async () => { view!.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    await settle();
    assert.equal(messagePosts, 2, "the queued message is posted once");
    const [runAPost, runBPost] = posts;
    assert.equal(runBPost?.signal?.aborted, false);

    // Stop now: the server cancels its current run (run-a); run-b's stream must survive.
    await act(async () => { view!.root.findByType(ComposerRunButton).props.onStop(); });
    await settle();
    assert.equal(cancels, 1, "Stop asks the server to cancel the Session's current run");
    assert.equal(browser.graceCount(), 1, "one grace timer is armed for the active stream");
    browser.fireGrace();
    assert.equal(runAPost?.signal?.aborted, true, "the active run's stream is the one the grace abort drops");
    assert.equal(runBPost?.signal?.aborted, false, "a queued acceptance must not replace the active run's abort target");
  } finally {
    await act(async () => { view?.unmount(); });
    for (const post of posts) { try { post.close(); } catch { /* already closed */ } }
    globalThis.fetch = previousFetch;
    browser.restore();
  }
});

test("once the queued run started it is the Stop target and its stream is the one dropped", async () => {
  const controllers = new Map<string, AbortController>();
  const started = new AbortController();
  controllers.set("session-1", started);
  const scheduled: Array<() => void> = [];
  const cancelled: string[] = [];
  await requestRunStop({
    cancelRun: async (sessionId) => { cancelled.push(sessionId); },
    controllers,
    graceMs: 5_000,
    schedule: (callback) => { scheduled.push(callback); },
    sessionId: "session-1",
  });
  assert.deepEqual(cancelled, ["session-1"], "Stop targets the Session whose started run is on screen");
  assert.equal(started.signal.aborted, false, "the server gets the grace period first");
  for (const callback of scheduled.splice(0)) callback();
  assert.equal(started.signal.aborted, true, "the started run's own stream is the fallback abort target");
});
