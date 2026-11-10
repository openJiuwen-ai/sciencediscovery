// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import React from "react";
import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { act, create, type ReactTestRenderer } from "./support/dom-renderer.js";
import type { ApiClient } from "../src/api/client.js";
import type { ConfigurationRequestView, ConnectorConfigurationRequest } from "@sciencediscovery/schema";
import { useWorkspace } from "../src/app/use-workspace.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
const globals = globalThis as { window?: unknown; IS_REACT_ACT_ENVIRONMENT?: boolean };
globals.window = { setTimeout: (callback: () => void, ms: number) => { const timer = setTimeout(callback, ms); timer.unref(); return timer; } };
globals.IS_REACT_ACT_ENVIRONMENT = true;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function receipt(over: Partial<ConfigurationRequestView> = {}) {
  return { id: "configuration", sessionId: "a", revision: 1, stateVersion: 2, state: "applied",
    resumption: { state: "not_required" }, ...over } as ConfigurationRequestView;
}
function backend() {
  const calls: { path: string; init?: RequestInit }[] = [];
  const streams: { path: string; end: () => void; fail: () => void; emit: (event: unknown) => void }[] = [];
  const reads = new Map<string, ReturnType<typeof deferred<unknown>>>();
  const state = { failSessionReads: 0, failRunReads: 0, failStreams: 0, streamAttempts: 0, model: "old-model", text: "before", runs: [] as { id: string; status: string }[] };
  const client = { token: "", request: async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    const match = /^\/api\/sessions\/([^/]+)$/.exec(path);
    if (match) {
      if (state.failSessionReads > 0) { state.failSessionReads--; throw new Error("temporary session read failure"); }
      const held = reads.get(match[1]!); if (held) { reads.delete(match[1]!); return held.promise; }
      return { id: match[1], projectId: "p", modelId: state.model, messages: [{ id: "m", role: "assistant", content: state.text, createdAt: "2026-11-09T00:00:00Z" }] };
    }
    if (path.endsWith("/runs")) {
      if (state.failRunReads > 0) { state.failRunReads--; throw new Error("temporary run list failure"); }
      return state.runs;
    }
    if (path === "/api/models") return [{ id: state.model, name: state.model }];
    if (path === "/api/providers") return { presets: [], providers: [] };
    if (path.endsWith("/settings")) return { overrides: { modelId: state.model }, effective: { modelId: state.model } };
    if (path === "/api/inbox") return { id: "inbox" };
    return [];
  }, fetchStream: async (path: string, init?: RequestInit) => {
    state.streamAttempts++;
    if (state.failStreams > 0) { state.failStreams--; throw new Error("temporary stream connection failure"); }
    let end!: () => void; let fail!: () => void; let emit!: (event: unknown) => void;
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      let closed = false; end = () => { if (!closed) { closed = true; controller.close(); } };
      fail = () => { if (!closed) { closed = true; controller.error(new Error("temporary stream read failure")); } };
      emit = event => { if (!closed) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); };
      init?.signal?.addEventListener("abort", end, { once: true });
    } });
    streams.push({ path, end, fail, emit });
    return new Response(stream);
  } } as unknown as ApiClient;
  return { client, calls, streams, reads, state };
}
async function mount(client: ApiClient) {
  let handle!: ReturnType<typeof useWorkspace>; let renderer!: ReactTestRenderer;
  const rejectAuth = () => {};
  function Harness() { handle = useWorkspace(client, rejectAuth); return null; }
  await act(async () => { renderer = create(<Harness />); });
  return { get handle() { return handle; }, close: () => act(async () => renderer.unmount()) };
}

test("saved configuration refreshes settings and transcript without resending the user's prompt", async () => {
  const api = backend(); const view = await mount(api.client);
  await act(async () => view.handle.actions.openSession("a"));
  api.state.model = "new-model"; api.state.text = "configuration saved";
  await act(async () => { view.handle.actions.refreshConfiguration(receipt()); await tick(); });
  assert.equal(view.handle.state.detail?.messages[0]?.content, "configuration saved");
  assert.equal(view.handle.state.selectedModelId, "new-model");
  assert.ok(api.calls.some(call => call.path === "/api/sessions/a/settings"));
  assert.ok(api.calls.some(call => call.path === "/api/models"));
  assert.equal(api.streams.length, 0);
  assert.equal(api.calls.some(call => call.init?.method === "POST" && call.path !== "/api/inbox"), false);
  await view.close();
});

test("duplicate continuation receipts attach the existing run once and do not submit a message", async () => {
  const api = backend(); const view = await mount(api.client);
  await act(async () => view.handle.actions.openSession("a"));
  api.state.runs = [{ id: "continuation", status: "running" }];
  const saved = receipt({ resumption: { state: "started", runId: "continuation" } as ConfigurationRequestView["resumption"] });
  await act(async () => { view.handle.actions.refreshConfiguration(saved); view.handle.actions.refreshConfiguration({ ...saved }); await tick(); });
  assert.equal(api.streams.length, 1);
  assert.ok(api.streams[0]!.path.includes("/runs/continuation/events"));
  await act(async () => { view.handle.actions.refreshConfiguration({ ...saved }); await tick(); });
  assert.equal(api.streams.length, 1);
  assert.equal(api.calls.some(call => call.init?.method === "POST" && call.path !== "/api/inbox"), false);
  api.state.runs = [];
  await act(async () => {
    api.streams[0]!.emit({ type: "run.status", status: "completed", run: { id: "continuation", status: "completed" } });
    api.streams[0]!.end(); await tick();
  });
  assert.equal(api.streams.length, 1);
  await view.close();
});

test("a duplicate snapshot does not follow the same continuation again after its wire closes", async () => {
  const api = backend(); const view = await mount(api.client);
  await act(async () => view.handle.actions.openSession("a"));
  api.state.runs = [{ id: "continuation", status: "running" }];
  const saved = receipt({ resumption: { state: "started", runId: "continuation" } as ConfigurationRequestView["resumption"] });
  await act(async () => { view.handle.actions.refreshConfiguration(saved); await tick(); });
  await act(async () => { view.handle.actions.refreshConfiguration({ ...saved }); await tick(); });
  // The list read can lag the stream's final frame. It still names the run
  // already followed, so this identical receipt must not attach it twice.
  await act(async () => {
    api.streams[0]!.emit({ type: "run.status", status: "completed", run: { id: "continuation", status: "completed" } });
    api.streams[0]!.end(); await tick();
  });
  const count = api.streams.length;
  api.state.runs = [];
  await act(async () => { for (const stream of api.streams) stream.end(); await tick(); });
  await view.close();
  assert.equal(count, 1);
});

test("a receipt arriving while the original stream runs attaches continuation after that stream ends", async () => {
  const api = backend(); const view = await mount(api.client);
  api.state.runs = [{ id: "original", status: "running" }];
  let opened!: Promise<void>;
  await act(async () => { opened = view.handle.actions.openSession("a"); await tick(); });
  assert.equal(view.handle.state.running, true);
  api.state.runs = [{ id: "continuation", status: "running" }];
  await act(async () => { view.handle.actions.refreshConfiguration(receipt({ resumption: { state: "started", runId: "continuation" } as ConfigurationRequestView["resumption"] })); await tick(); });
  assert.equal(api.streams.length, 1);
  await act(async () => { api.streams[0]!.end(); await opened; await tick(); });
  assert.equal(api.streams.length, 2);
  assert.ok(api.streams[1]!.path.includes("/runs/continuation/events"));
  api.state.runs = [];
  await act(async () => { api.streams[1]!.end(); await tick(); });
  await view.close();
});

test("a late configuration refresh cannot overwrite a newly opened session", async () => {
  const api = backend(); const view = await mount(api.client);
  await act(async () => view.handle.actions.openSession("a"));
  const held = deferred<unknown>(); api.reads.set("a", held);
  await act(async () => { view.handle.actions.refreshConfiguration(receipt()); await tick(); });
  await act(async () => view.handle.actions.openSession("b"));
  await act(async () => { held.resolve({ id: "a", projectId: "p", modelId: "stale", messages: [] }); await tick(); });
  assert.equal(view.handle.state.detail?.id, "b");
  const before = api.calls.length;
  await act(async () => view.handle.actions.refreshConfiguration(receipt()));
  assert.equal(api.calls.length, before);
  await view.close();
});

test("a late refresh from a prior visit cannot overwrite reopening the same session", async () => {
  const api = backend(); const view = await mount(api.client);
  await act(async () => view.handle.actions.openSession("a"));
  const held = deferred<unknown>(); api.reads.set("a", held);
  await act(async () => { view.handle.actions.refreshConfiguration(receipt()); await tick(); });
  await act(async () => view.handle.actions.openSession("b"));
  api.state.text = "current visit";
  await act(async () => view.handle.actions.openSession("a"));
  await act(async () => { held.resolve({ id: "a", projectId: "p", modelId: "stale", messages: [] }); await tick(); });
  assert.equal(view.handle.state.detail?.messages[0]?.content, "current visit");
  await view.close();
});

/** Drive only the retry delay, leaving React's ticks and toast timers real. */
function retryClock() {
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  let sequence = 0;
  const callbacks = new Map<object, () => void>();
  globalThis.setTimeout = ((callback: () => void, delay: number, ...args: unknown[]) => {
    if (delay !== 2_000) return originalSet(callback, delay, ...args);
    const id = { retry: ++sequence };
    callbacks.set(id, callback);
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: unknown) => {
    if (typeof id === "object" && id !== null && callbacks.delete(id)) return;
    originalClear(id as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout;
  return {
    get size() { return callbacks.size; },
    take() {
      const next = callbacks.entries().next().value;
      assert.ok(next, "a bounded retry should be scheduled");
      callbacks.delete(next[0]);
      return next[1];
    },
    restore() { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; },
  };
}

for (const failingRead of ["failSessionReads", "failRunReads"] as const) {
  test(`unchanged continuation receipt retries ${failingRead} failures and attaches once without resending`, async () => {
    const clock = retryClock(); const api = backend(); const view = await mount(api.client);
    try {
      await act(async () => view.handle.actions.openSession("a"));
      api.state.runs = [{ id: "continuation", status: "running" }];
      api.state[failingRead] = 2;
      await act(async () => { view.handle.actions.refreshConfiguration(receipt({ resumption: { state: "started", runId: "continuation" } as ConfigurationRequestView["resumption"] })); await tick(); });
      assert.equal(clock.size, 1); assert.equal(api.streams.length, 0);
      await act(async () => { clock.take()(); await tick(); });
      assert.equal(clock.size, 1); assert.equal(api.streams.length, 0);
      assert.equal(view.handle.state.toasts.length, 1, "background retries must not repeat the same toast");
      // No new onChange call: the existing unchanged receipt recovers by itself.
      await act(async () => { clock.take()(); await tick(); });
      assert.equal(clock.size, 0); assert.equal(api.streams.length, 1);
      assert.ok(api.streams[0]!.path.includes("/runs/continuation/events"));
      assert.equal(api.calls.some(call => call.init?.method === "POST" && call.path !== "/api/inbox"), false);
      api.state.runs = [];
      await act(async () => { api.streams[0]!.end(); await tick(); });
      assert.equal(api.streams.length, 1);
    } finally { await view.close(); clock.restore(); }
  });
}

test("navigation and unmount cancel retries and reject already queued retry callbacks", async () => {
  const clock = retryClock(); const api = backend(); const view = await mount(api.client);
  let closed = false;
  try {
    await act(async () => view.handle.actions.openSession("a"));
    api.state.failSessionReads = 1;
    await act(async () => { view.handle.actions.refreshConfiguration(receipt()); await tick(); });
    const stale = clock.take();
    await act(async () => view.handle.actions.openSession("b"));
    await act(async () => view.handle.actions.openSession("a"));
    const count = api.calls.length;
    await act(async () => { stale(); await tick(); });
    assert.equal(api.calls.length, count);
    api.state.failSessionReads = 1;
    await act(async () => { view.handle.actions.refreshConfiguration(receipt()); await tick(); });
    assert.equal(clock.size, 1);
    await view.close(); closed = true;
    assert.equal(clock.size, 0);
  } finally { if (!closed) await view.close(); clock.restore(); }
});

test("a new user send cancels a failed configuration refresh without overwriting its pending message", async () => {
  const clock = retryClock(); const api = backend(); const view = await mount(api.client);
  try {
    await act(async () => view.handle.actions.openSession("a"));
    api.state.failSessionReads = 1;
    await act(async () => { view.handle.actions.refreshConfiguration(receipt()); await tick(); });
    const stale = clock.take();
    await act(async () => { void view.handle.actions.send("new user prompt"); await tick(); });
    const count = api.calls.length;
    await act(async () => { stale(); await tick(); });
    assert.equal(api.calls.length, count);
    assert.equal(view.handle.state.pendingMessage?.content, "new user prompt");
    assert.equal(api.streams.length, 1);
    assert.equal(clock.size, 0);
  } finally { await view.close(); clock.restore(); }
});

test("a newer configuration snapshot supersedes the failed snapshot's scheduled retry", async () => {
  const clock = retryClock(); const api = backend(); const view = await mount(api.client);
  try {
    await act(async () => view.handle.actions.openSession("a"));
    api.state.failSessionReads = 1;
    await act(async () => { view.handle.actions.refreshConfiguration(receipt()); await tick(); });
    const stale = clock.take();
    api.state.text = "new configuration receipt";
    await act(async () => { view.handle.actions.refreshConfiguration(receipt({ stateVersion: 3 })); await tick(); });
    const count = api.calls.length;
    await act(async () => { stale(); await tick(); });
    assert.equal(api.calls.length, count);
    assert.equal(view.handle.state.detail?.messages[0]?.content, "new configuration receipt");
    assert.equal(clock.size, 0);
  } finally { await view.close(); clock.restore(); }
});


test("legacy receipts follow the server continuation once without a new prompt or generic resume contract", async () => {
  const api = backend(); const view = await mount(api.client);
  await act(async () => view.handle.actions.openSession("a"));
  api.state.runs = [{ id: "legacy-continuation", status: "running" }];
  const saved = { id: "old", sessionId: "a", state: "applied", continuationRunId: "legacy-continuation" } as ConnectorConfigurationRequest;
  await act(async () => { view.handle.actions.refreshConfiguration(saved); await tick(); });
  await act(async () => { view.handle.actions.refreshConfiguration({ ...saved }); await tick(); });
  assert.equal(api.streams.length, 1);
  assert.ok(api.streams[0]!.path.includes("/runs/legacy-continuation/events"));
  assert.equal(api.calls.some(call => call.init?.method === "POST" && call.path !== "/api/inbox"), false);
  api.state.runs = []; await act(async () => { api.streams[0]!.end(); await tick(); });
  await view.close();
});


for (const interruption of ["connect", "read", "eof"] as const) {
  test(`configuration continuation recovers ${interruption} failure without a new receipt or prompt`, async () => {
    const clock = retryClock(); const api = backend(); const view = await mount(api.client);
    try {
      await act(async () => view.handle.actions.openSession("a"));
      api.state.runs = [{ id: "continuation", status: "running" }];
      if (interruption === "connect") api.state.failStreams = 1;
      const saved = receipt({ resumption: { state: "started", runId: "continuation" } as ConfigurationRequestView["resumption"] });
      await act(async () => { view.handle.actions.refreshConfiguration(saved); await tick(); });
      if (interruption !== "connect") await act(async () => {
        api.streams[0]!.emit({ type: "run.queued", run: { id: "continuation", status: "running" } });
        await tick();
        if (interruption === "read") api.streams[0]!.fail(); else api.streams[0]!.end();
        await tick();
      });
      assert.equal(api.state.streamAttempts, 1);
      assert.equal(clock.size, 1, "An interrupted wire must schedule one bounded retry");
      // No new card snapshot is necessary to recover a disconnected wire.
      await act(async () => { clock.take()(); await tick(); });
      assert.equal(api.state.streamAttempts, 2);
      assert.equal(view.handle.state.running, true);
      assert.equal(clock.size, 0);
      const resumed = api.streams.at(-1)!;
      await act(async () => {
        resumed.emit({ type: "run.status", status: "completed", run: { id: "continuation", status: "completed" } });
        resumed.end(); await tick();
      });
      // The run listing may lag its terminal SSE event. Never reconnect it.
      await act(async () => { view.handle.actions.refreshConfiguration({ ...saved }); await tick(); });
      assert.equal(api.state.streamAttempts, 2);
      assert.equal(clock.size, 0);
      assert.equal(api.calls.some(call => call.init?.method === "POST" && call.path !== "/api/inbox"), false);
    } finally { await view.close(); clock.restore(); }
  });
}

test("navigation cancels configuration stream retries and discards an already queued retry callback", async () => {
  const clock = retryClock(); const api = backend(); const view = await mount(api.client);
  try {
    await act(async () => view.handle.actions.openSession("a"));
    api.state.runs = [{ id: "continuation", status: "running" }];
    api.state.failStreams = 1;
    await act(async () => { view.handle.actions.refreshConfiguration(receipt()); await tick(); });
    const stale = clock.take();
    api.state.runs = [];
    await act(async () => view.handle.actions.openSession("b"));
    await act(async () => view.handle.actions.openSession("a"));
    const before = api.calls.length;
    await act(async () => { stale(); await tick(); });
    assert.equal(api.calls.length, before);
    assert.equal(api.state.streamAttempts, 1);
    assert.equal(clock.size, 0);
  } finally { await view.close(); clock.restore(); }
});

test("repeated configuration stream failures remain bounded and unmount cancels recovery", async () => {
  const clock = retryClock(); const api = backend(); const view = await mount(api.client);
  let closed = false;
  try {
    await act(async () => view.handle.actions.openSession("a"));
    api.state.runs = [{ id: "continuation", status: "running" }];
    api.state.failStreams = 3;
    await act(async () => { view.handle.actions.refreshConfiguration(receipt()); await tick(); });
    assert.equal(clock.size, 1);
    await act(async () => { clock.take()(); await tick(); });
    assert.equal(api.state.streamAttempts, 2);
    assert.equal(clock.size, 1);
    assert.equal(view.handle.state.toasts.length, 1, "Automatic reconnection must not repeat the disconnect notice");
    const stale = clock.take();
    await view.close(); closed = true;
    const before = api.calls.length;
    await act(async () => { stale(); await tick(); });
    assert.equal(api.calls.length, before);
    assert.equal(api.state.streamAttempts, 2);
    assert.equal(clock.size, 0);
  } finally { if (!closed) await view.close(); clock.restore(); }
});

test("a newer configuration card supersedes an older continuation's terminal refresh", async () => {
  const api = backend(); const view = await mount(api.client);
  try {
    await act(async () => view.handle.actions.openSession("a"));
    api.state.runs = [{ id: "first-continuation", status: "running" }];
    await act(async () => { view.handle.actions.refreshConfiguration(receipt()); await tick(); });
    const held = deferred<unknown>(); api.reads.set("a", held);
    await act(async () => {
      api.streams[0]!.emit({ type: "run.status", status: "completed", run: { id: "first-continuation", status: "completed" } });
      api.streams[0]!.end(); await tick();
    });
    api.state.text = "second card's current transcript";
    api.state.runs = [{ id: "second-continuation", status: "running" }];
    await act(async () => { view.handle.actions.refreshConfiguration(receipt({ id: "second-card" })); await tick(); });
    assert.equal(api.streams.length, 2);
    await act(async () => {
      api.streams[1]!.emit({ type: "run.queued", run: { id: "second-continuation", status: "running" } });
      await tick();
      held.resolve({ id: "a", projectId: "p", messages: [] }); await tick();
    });
    assert.equal(view.handle.state.detail?.messages[0]?.content, "second card's current transcript");
    assert.equal(view.handle.state.run.runId, "second-continuation");
    assert.equal(view.handle.state.running, true);
    assert.equal(api.calls.some(call => call.init?.method === "POST" && call.path !== "/api/inbox"), false);
  } finally { await view.close(); }
});

test("a new user send cancels configuration stream recovery before retrying", async () => {
  const clock = retryClock(); const api = backend(); const view = await mount(api.client);
  try {
    await act(async () => view.handle.actions.openSession("a"));
    api.state.runs = [{ id: "continuation", status: "running" }];
    api.state.failStreams = 1;
    await act(async () => { view.handle.actions.refreshConfiguration(receipt()); await tick(); });
    const stale = clock.take();
    await act(async () => { void view.handle.actions.send("new user prompt"); await tick(); });
    const before = api.calls.length;
    await act(async () => { stale(); await tick(); });
    assert.equal(api.calls.length, before);
    assert.equal(api.state.streamAttempts, 2, "Only the explicit user send may open another wire");
    assert.equal(view.handle.state.pendingMessage?.content, "new user prompt");
    assert.equal(clock.size, 0);
  } finally { await view.close(); clock.restore(); }
});


test("a duplicate receipt while streaming does not strand reconnection when its epoch supersedes the wire", async () => {
  const clock = retryClock(); const api = backend(); const view = await mount(api.client);
  try {
    await act(async () => view.handle.actions.openSession("a"));
    api.state.runs = [{ id: "continuation", status: "running" }];
    const saved = receipt({ resumption: { state: "started", runId: "continuation" } as ConfigurationRequestView["resumption"] });
    await act(async () => { view.handle.actions.refreshConfiguration(saved); await tick(); });
    await act(async () => { view.handle.actions.refreshConfiguration({ ...saved, stateVersion: 3 }); await tick(); });
    assert.equal(api.state.streamAttempts, 1);
    await act(async () => { api.streams[0]!.fail(); await tick(); });
    if (clock.size) await act(async () => { clock.take()(); await tick(); });
    assert.equal(api.state.streamAttempts, 2, "The pending newer receipt must reconnect the same server run");
    assert.equal(view.handle.state.running, true);
    assert.equal(clock.size, 0);
    await act(async () => { api.streams[1]!.end(); await tick(); });
    assert.equal(clock.size, 1, "A second disconnect must still schedule recovery");
    assert.equal(api.calls.some(call => call.init?.method === "POST" && call.path !== "/api/inbox"), false);
  } finally { await view.close(); clock.restore(); }
});

test("a terminal event followed by a reader failure never reconnects a completed continuation", async () => {
  const clock = retryClock(); const api = backend(); const view = await mount(api.client);
  try {
    await act(async () => view.handle.actions.openSession("a"));
    api.state.runs = [{ id: "continuation", status: "running" }];
    const saved = receipt({ resumption: { state: "started", runId: "continuation" } as ConfigurationRequestView["resumption"] });
    await act(async () => { view.handle.actions.refreshConfiguration(saved); await tick(); });
    await act(async () => {
      api.streams[0]!.emit({ type: "run.status", status: "completed", run: { id: "continuation", status: "completed" } });
      await tick(); api.streams[0]!.fail(); await tick();
    });
    await act(async () => { view.handle.actions.refreshConfiguration({ ...saved }); await tick(); });
    assert.equal(api.state.streamAttempts, 1);
    assert.equal(clock.size, 0);
  } finally { await view.close(); clock.restore(); }
});
