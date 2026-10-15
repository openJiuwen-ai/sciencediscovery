// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createTest } from "../support/tagged/compat.mjs";
import { waitForEnvironmentSetup } from "./environment-setup.ts";

const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "os:macos", "arch:amd64", "arch:arm64"],
});

const installing = { state: "installing", message: "Creating the managed Python base environment" };
const ready = { state: "ready", message: "Managed Python base is ready" };
const failed = { state: "failed", message: "Managed Python base installation failed" };

test("a ready Python base opens the gate without waiting", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const read = context.mock.fn(async () => ready);
  assert.deepEqual(await waitForEnvironmentSetup(read), ready);
  assert.equal(read.mock.callCount(), 1);
});

test("an installing Python base is polled every five seconds until ready", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const states = [installing, installing, ready];
  const read = context.mock.fn(async () => states.shift()!);
  const result = waitForEnvironmentSetup(read);
  await setImmediate();
  assert.equal(read.mock.callCount(), 1);
  context.mock.timers.tick(4_999);
  await setImmediate();
  assert.equal(read.mock.callCount(), 1);
  context.mock.timers.tick(1);
  await setImmediate();
  assert.equal(read.mock.callCount(), 2);
  context.mock.timers.tick(5_000);
  assert.deepEqual(await result, ready);
  assert.equal(read.mock.callCount(), 3);
});

test("a failed Python base stops immediately and preserves its diagnostic", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const read = context.mock.fn(async () => failed);
  assert.deepEqual(await waitForEnvironmentSetup(read), failed);
  context.mock.timers.tick(180_000);
  await setImmediate();
  assert.equal(read.mock.callCount(), 1);
});

test("an installation that fails while polling stops before another read", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const states = [installing, failed, ready];
  const read = context.mock.fn(async () => states.shift()!);
  const result = waitForEnvironmentSetup(read);
  await setImmediate();
  context.mock.timers.tick(5_000);
  assert.deepEqual(await result, failed);
  context.mock.timers.tick(180_000);
  await setImmediate();
  assert.equal(read.mock.callCount(), 2);
});

test("an installing Python base stops at 180 seconds without returning ready", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const read = context.mock.fn(async () => installing);
  let settled = false;
  const result = waitForEnvironmentSetup(read).then((setup) => { settled = true; return setup; });
  await setImmediate();
  for (let seconds = 5; seconds < 180; seconds += 5) {
    context.mock.timers.tick(5_000);
    await setImmediate();
  }
  context.mock.timers.tick(4_999);
  await setImmediate();
  assert.equal(settled, false);
  assert.equal(read.mock.callCount(), 36);
  context.mock.timers.tick(1);
  assert.deepEqual(await result, installing);
  context.mock.timers.tick(5_000);
  await setImmediate();
  assert.equal(read.mock.callCount(), 36);
});

test("a GET completing after the deadline cannot return ready", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let finishRead!: (setup: typeof ready) => void;
  const pending = new Promise<typeof ready>((resolve) => { finishRead = resolve; });
  const states = [Promise.resolve(installing), pending];
  const read = context.mock.fn(async () => states.shift()!);
  const result = waitForEnvironmentSetup(read);
  await setImmediate();
  context.mock.timers.tick(5_000);
  await setImmediate();
  context.mock.timers.tick(175_000);
  assert.deepEqual(await result, installing);
  finishRead(ready);
  await setImmediate();
  assert.deepEqual(await result, installing);
  assert.equal(read.mock.callCount(), 2);
});

test("a first GET that never completes still stops at the deadline", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const read = context.mock.fn(() => new Promise<typeof ready>(() => {}));
  const result = waitForEnvironmentSetup(read);
  context.mock.timers.tick(180_000);
  const setup = await result;
  assert.equal(setup.state, "unknown");
  assert.match(setup.message, /No environment setup status received/);
  assert.equal(read.mock.callCount(), 1);
});

test("reader errors remain failures instead of being converted to readiness", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const error = new Error("environment setup request failed");
  const read = context.mock.fn(async () => { throw error; });
  await assert.rejects(waitForEnvironmentSetup(read), error);
  context.mock.timers.tick(180_000);
  await setImmediate();
  assert.equal(read.mock.callCount(), 1);
});
