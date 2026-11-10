// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { TestContext } from "node:test";
import { SessionStore } from "../store.js";
import { installApiTestModelCatalog } from "../model-catalog.fixture.js";
import { scheduleSessionRuns, streamStoredRunEvents } from "./index.js";

function refusal() {
  return Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
}

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 5_000;
  while (!await predicate()) {
    assert.ok(performance.now() < deadline, "scheduler did not reach the expected state");
    await setImmediate();
  }
}

async function settle() {
  for (let i = 0; i < 50; i += 1) await setImmediate();
}

async function fixture(context: TestContext) {
  installApiTestModelCatalog();
  const root = resolve(".tmp/r", `scheduler-${randomUUID()}`);
  const store = new SessionStore(root);
  await store.load();
  const project = await store.createProject("Scheduler recovery");
  const session = await store.createSession(project.id, "Task", {}, {}, { allowUnconfiguredModel: true });
  const run = await store.createSessionRun({ sessionId: session.id, prompt: "Run once",
    settingsSnapshot: store.resolveRuntimeSettings(session.id).effective });
  const tasks: Promise<void>[] = [];
  let fakeTimers = false;
  const enableTimers = () => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    fakeTimers = true;
    return context.mock.method(globalThis, "setTimeout");
  };
  context.after(async () => {
    // A persisted status is visible before its event append and final queue
    // reads finish. Drain the actual tasks before closing/removing their store.
    context.mock.restoreAll();
    if (fakeTimers) context.mock.timers.tick(30_000);
    await Promise.all(tasks);
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const start = () => {
    const task = scheduleSessionRuns(store, undefined as never, undefined as never, undefined as never,
      undefined as never, undefined as never, undefined as never, undefined as never, undefined as never,
      undefined as never, undefined as never, undefined as never, undefined as never, undefined as never,
      undefined as never, session.id, undefined as never, null, undefined, { sandboxed: async () => true });
    // The real API's listening socket keeps recovery alive. This unit fixture
    // owns a handle while awaiting the scheduler's deliberately unref'ed timers.
    const keepAlive = setInterval(() => {}, 60_000);
    const completion = task.finally(() => clearInterval(keepAlive));
    tasks.push(completion);
    return completion;
  };
  return { store, session, run, start, enableTimers };
}

test("a rejected run event is contained, broadcast without storage, and persisted as interrupted without replay", async (context) => {
  const { store, session, run, start } = await fixture(context);
  const chunks: string[] = [];
  let ended = false;
  const response = Object.assign(new EventEmitter(), {
    writeHead() {}, flushHeaders() {}, write(chunk: string) { chunks.push(chunk); return true; }, end() { ended = true; },
  });
  context.after(() => response.emit("close"));
  await streamStoredRunEvents(response as unknown as ServerResponse, store, session.id, run.id, 0, true);
  const append = store.appendSessionRunEvent.bind(store);
  let attempts = 0;
  context.mock.method(store, "appendSessionRunEvent", async (...args: Parameters<typeof append>) => {
    attempts += 1;
    if (attempts === 1) throw refusal();
    return append(...args);
  });
  let starts = 0;
  const transition = store.updateSessionRunStatusIfCurrent.bind(store);
  context.mock.method(store, "updateSessionRunStatusIfCurrent", async (...args: Parameters<typeof transition>) => {
    if (args[3] === "running") starts += 1;
    return transition(...args);
  });
  const task = start();
  await until(() => chunks.some((chunk) => chunk.includes('"status":"interrupted"')));
  assert.equal(attempts, 1, "the live error does not attempt another persistence write");
  assert.match(chunks.join(""), /EPERM/);
  assert.equal(ended, true, "the live terminal diagnostic closes the subscription");
  await task;
  assert.equal(starts, 1, "the failed turn must not execute again");
  const persisted = await store.getSessionRun(session.id, run.id);
  assert.match(persisted?.error ?? "", /disk space.*permissions/);
  assert.ok(persisted?.finishedAt);
  assert.ok((await store.listSessionRunEvents(session.id, run.id)).some(({ event }) => event.type === "run.status" && event.status === "interrupted"));
});

test("persistent transition and recovery failures back off, retain ownership, and recover after a long outage", async (context) => {
  const { store, session, run, start, enableTimers } = await fixture(context);
  const timers = enableTimers();
  const transition = store.updateSessionRunStatusIfCurrent.bind(store);
  let available = false;
  let attempts = 0;
  context.mock.method(store, "updateSessionRunStatusIfCurrent", async (...args: Parameters<typeof transition>) => {
    attempts += 1;
    if (!available) throw refusal();
    return transition(...args);
  });
  const task = start();
  await until(() => attempts === 1 && timers.mock.callCount() === 1);
  start();
  await settle();
  assert.equal(attempts, 1, "another wake must not bypass the backoff");
  // A reconnect must still receive the diagnostic even if the data directory
  // cannot be read, and must not need the failed durable event write.
  const readRun = context.mock.method(store, "getSessionRun", async () => { throw refusal(); });
  const readEvents = context.mock.method(store, "listSessionRunEvents", async () => { throw refusal(); });
  const chunks: string[] = [];
  let ended = false;
  const response = Object.assign(new EventEmitter(), {
    writeHead() {}, flushHeaders() {}, write(chunk: string) { chunks.push(chunk); return true; }, end() { ended = true; },
  });
  await streamStoredRunEvents(response as unknown as ServerResponse, store, session.id, run.id, 0, true);
  response.emit("close");
  readRun.mock.restore();
  readEvents.mock.restore();
  assert.match(chunks.join(""), /EPERM/);
  assert.equal(ended, true);
  for (const delay of [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const before: number = attempts;
    context.mock.timers.tick(delay - 1);
    await settle();
    assert.equal(attempts, before, "recovery must not spin between retries");
    context.mock.timers.tick(1);
    await until(() => attempts === before + 1 && timers.mock.callCount() === before + 1);
  }
  available = true;
  context.mock.timers.tick(30000);
  await task;
  assert.equal((await store.getSessionRun(session.id, run.id))?.status, "interrupted");
  assert.equal(attempts, 10, "recovery continues beyond five failures without replaying execution");
});

test("a final queue re-read failure is retried instead of silently abandoning scheduling", async (context) => {
  const { store, session, run, start, enableTimers } = await fixture(context);
  await store.updateSessionRunStatus(session.id, run.id, "completed");
  const timers = enableTimers();
  const list = store.listSessionRuns.bind(store);
  let reads = 0;
  context.mock.method(store, "listSessionRuns", async (sessionId: string) => {
    reads += 1;
    if (reads === 2) throw refusal();
    return list(sessionId);
  });
  const task = start();
  await until(() => reads === 2 && timers.mock.callCount() === 1);
  context.mock.timers.tick(499);
  await settle();
  assert.equal(reads, 2);
  context.mock.timers.tick(1);
  await task;
  assert.equal(reads, 4);
  assert.equal((await store.getSessionRun(session.id, run.id))?.status, "completed");
});

test("a persisted terminal result survives a subsequent event write failure", async (context) => {
  const { store, session, run, start } = await fixture(context);
  const append = store.appendSessionRunEvent.bind(store);
  let first = true;
  context.mock.method(store, "appendSessionRunEvent", async (...args: Parameters<typeof append>) => {
    if (first) {
      first = false;
      await store.updateSessionRunStatus(session.id, run.id, "completed");
      throw refusal();
    }
    return append(...args);
  });
  await start();
  assert.ok((await store.listSessionRunEvents(session.id, run.id)).some(({ event }) => event.type === "run.status" && event.status === "completed"));
  assert.equal((await store.getSessionRun(session.id, run.id))?.status, "completed");
});

test("an old scheduler's final read failure cannot clear a newer scheduler's ownership", async (context) => {
  const { store, session, run, start } = await fixture(context);
  await store.updateSessionRunStatus(session.id, run.id, "completed");
  const list = store.listSessionRuns.bind(store);
  const oldRead = Promise.withResolvers<void>();
  const newRead = Promise.withResolvers<void>();
  let reads = 0;
  context.mock.method(store, "listSessionRuns", async (sessionId: string) => {
    reads += 1;
    if (reads === 2) await oldRead.promise;
    if (reads === 3) await newRead.promise;
    return list(sessionId);
  });
  const oldTask = start();
  let newTask: Promise<void> | undefined;
  try {
    await until(() => reads === 2);
    newTask = start();
    await until(() => reads === 3);
    oldRead.reject(refusal());
    await oldTask;
    await start();
    assert.equal(reads, 3, "the old owner's catch/finally must not unlock the new scheduler");
    newRead.resolve();
    // Releasing the read only makes the new scheduler runnable. Its promise,
    // rather than a number of event-loop turns, proves it released ownership.
    await newTask;
    await start();
    assert.equal(reads, 6, "a subsequent scheduler starts after the new owner finishes");
  } finally {
    oldRead.resolve();
    newRead.resolve();
    await oldTask;
    await newTask;
  }
});

test("recovery does not overwrite a cancellation that wins the status transition", async (context) => {
  const { store, session, run, start } = await fixture(context);
  const append = store.appendSessionRunEvent.bind(store);
  let first = true;
  context.mock.method(store, "appendSessionRunEvent", async (...args: Parameters<typeof append>) => {
    if (first) { first = false; throw refusal(); }
    return append(...args);
  });
  const transition = store.updateSessionRunStatusIfCurrent.bind(store);
  context.mock.method(store, "updateSessionRunStatusIfCurrent", async (...args: Parameters<typeof transition>) => {
    if (args[3] === "interrupted") {
      await store.updateSessionRunStatus(session.id, run.id, "cancelled");
    }
    return transition(...args);
  });
  await start();
  assert.ok((await store.listSessionRunEvents(session.id, run.id)).some(({ event }) => event.type === "run.status" && event.status === "cancelled"));
  assert.equal((await store.getSessionRun(session.id, run.id))?.status, "cancelled");
});

test("scheduler completion waits for the recovery event after interrupted status is already readable", async (context) => {
  const { store, session, run, start, enableTimers } = await fixture(context);
  const timers = enableTimers();
  const append = store.appendSessionRunEvent.bind(store);
  let releaseEvent: () => void = () => {};
  const eventGate = new Promise<void>((resolve) => { releaseEvent = resolve; });
  let appends = 0;
  context.mock.method(store, "appendSessionRunEvent", async (...args: Parameters<typeof append>) => {
    appends += 1;
    if (appends === 1) throw refusal();
    await eventGate;
    return append(...args);
  });
  let completed = false;
  const task = start().then(() => { completed = true; });
  try {
    await until(() => timers.mock.callCount() === 1);
    context.mock.timers.tick(500);
    await until(() => appends === 2);
    assert.equal((await store.getSessionRun(session.id, run.id))?.status, "interrupted");
    assert.equal(completed, false, "readable terminal state does not mean the scheduler has finished writing");
    assert.equal((await store.listSessionRunEvents(session.id, run.id)).length, 0);
  } finally {
    releaseEvent();
    await task;
  }
  assert.ok((await store.listSessionRunEvents(session.id, run.id)).some(({ event }) => event.type === "run.status" && event.status === "interrupted"));
});
