// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { ApiClient } from "../src/api.js";
import { ApiRequestError } from "../src/api/auth.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "os:macos", "arch:amd64", "arch:arm64"] });

function stream(frames: string, disconnect = false): Response {
  let sent = false;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(frames)); }
      else if (disconnect) controller.error(new TypeError("Connection lost"));
      else controller.close();
    },
  }));
}
const accepted = 'id: 12\ndata: {"type":"run.status","status":"running","run":{"id":"run-1","status":"running"}}\n\n';
const completed = 'id: 14\ndata: {"type":"run.completed","message":{"id":"answer-1","role":"assistant","content":"done"},"files":[]}\n\n';

for (const disconnect of [true, false]) test(`accepted POST recovers ${disconnect ? "connection loss" : "silent EOF"} through GET without resubmitting`, async context => {
  const urls: string[] = []; const methods: string[] = []; const sequences: Array<number | undefined> = [];
  context.mock.method(globalThis, "fetch", async (input, init) => {
    urls.push(String(input)); methods.push(init?.method ?? "GET");
    if (init?.method === "POST") return stream(accepted, disconnect);
    assert.match(String(input), /runs\/run-1\/events\?after=12$/);
    return stream(accepted + 'data: {"type":"subagent.step","subagentId":"child-1","step":{}}\n\nid: 13\ndata: {"type":"assistant.delta","delta":"done"}\n\n' + completed);
  });
  await new ApiClient("test-only").streamMessage("session-1", { content: "research" }, (_event, sequence) => sequences.push(sequence));
  assert.deepEqual(methods, ["POST", "GET"]);
  assert.equal(urls.length, 2);
  assert.deepEqual(sequences, [12, undefined, 13, 14], "Replay duplicates are ignored and child frames never advance the main cursor");
});

test("an unaccepted POST failure never creates an automatic retry", async context => {
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => { calls++; throw new TypeError("offline"); });
  await assert.rejects(new ApiClient("test-only").streamMessage("session-1", { content: "keep this draft" }, () => {}), /offline/);
  assert.equal(calls, 1);
});

for (const mode of ["partial-disconnect", "empty-eof", "no-body"]) test(`accepted identity survives ${mode} before the first complete SSE frame`, async context => {
  const methods: string[] = []; const acceptedIds: string[] = [];
  context.mock.method(globalThis, "fetch", async (input, init) => {
    methods.push(init?.method ?? "GET");
    if (init?.method === "POST") {
      const response = mode === "no-body" ? new Response(null) : stream(mode === "partial-disconnect" ? 'data: {"type":' : "", mode === "partial-disconnect");
      response.headers.set("x-sciencediscovery-run-id", "run-accepted");
      return response;
    }
    assert.deepEqual(acceptedIds, ["run-accepted"], "App learns acceptance before recovery reads");
    assert.match(String(input), /runs\/run-accepted\/events\?after=0$/);
    return stream(completed);
  });
  await new ApiClient("test-only").streamMessage("session-1", { content: "submit once" }, () => {}, undefined, id => acceptedIds.push(id));
  assert.deepEqual(methods, ["POST", "GET"]);
});

test("run stream authorization errors stop immediately", async context => {
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ error: "Unauthorized" }, { status: 401 }); });
  await assert.rejects(new ApiClient("test-only").subscribeRunEvents("session-1", "run-1", 12, () => {}), error => error instanceof ApiRequestError && error.status === 401);
  assert.equal(calls, 1);
});

test("Stop cancels recovery before another subscription is opened", async context => {
  const abort = new AbortController(); let calls = 0;
  context.mock.method(globalThis, "fetch", async input => {
    calls++;
    if (String(input).endsWith("/runs")) {
      abort.abort(new DOMException("Stopped", "AbortError"));
      return Response.json([{ id: "run-1", status: "running" }]);
    }
    return stream("");
  });
  await assert.rejects(new ApiClient("test-only").subscribeRunEvents("session-1", "run-1", 12, () => {}, abort.signal), error => error instanceof Error && error.name === "AbortError");
  assert.equal(calls, 2, "Only the first stream and authoritative status read were attempted");
});

test("EOF after the persisted run finished does not reconnect forever", async context => {
  const urls: string[] = [];
  context.mock.method(globalThis, "fetch", async input => {
    urls.push(String(input));
    return String(input).endsWith("/runs") ? Response.json([{ id: "run-1", status: "completed" }]) : stream("");
  });
  await new ApiClient("test-only").subscribeRunEvents("session-1", "run-1", 14, () => {});
  assert.equal(urls.length, 2);
});

test("Stop aborts a pending authoritative status read during recovery", async context => {
  const abort = new AbortController(); let calls = 0;
  context.mock.method(globalThis, "fetch", async (input, init) => {
    calls++;
    if (!String(input).endsWith("/runs")) return stream("");
    assert.equal(init?.signal, abort.signal);
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      queueMicrotask(() => abort.abort(new DOMException("Stopped", "AbortError")));
    });
  });
  await assert.rejects(new ApiClient("test-only").subscribeRunEvents("session-1", "run-1", 12, () => {}, abort.signal), error => error instanceof Error && error.name === "AbortError");
  assert.equal(calls, 2);
});
