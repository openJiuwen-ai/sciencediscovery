// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createTest } from "../support/tagged/compat.mjs";
import {
  ENVIRONMENT_SETUP_ERROR_LIMIT,
  formatEnvironmentSetupBlockedReason,
  waitForEnvironmentSetup,
} from "./environment-setup.ts";

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

test("a disabled Python base fails its readiness precondition without polling", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const disabled = { state: "disabled", message: "Scientific environments are disabled" };
  const read = context.mock.fn(async () => disabled);
  assert.deepEqual(await waitForEnvironmentSetup(read), disabled);
  assert.equal(read.mock.callCount(), 1);
});

test("a hung GET fails after ten seconds even if the reader ignores its timeout", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let finishRead!: (setup: typeof ready) => void;
  const read = context.mock.fn((_timeoutMs: number) => new Promise<typeof ready>(resolve => { finishRead = resolve; }));
  let settled = false;
  const result = waitForEnvironmentSetup(read).finally(() => { settled = true; });
  const rejected = assert.rejects(result, /request did not complete within 10000 ms/);
  assert.equal(read.mock.calls[0]?.arguments[0], 10_000);
  context.mock.timers.tick(9_999);
  await setImmediate();
  assert.equal(settled, false);
  context.mock.timers.tick(1);
  await rejected;
  finishRead(ready);
  await setImmediate();
  assert.equal(read.mock.callCount(), 1);
});

const failedWithTranscript = {
  state: "failed",
  message: "Conda environment setup failed",
  error: "LibMambaUnsatisfiableError: Encountered problems while solving:\n  - package python-3.12.0 requires openssl >=3.0",
  components: {
    conda: {
      state: "failed",
      message: "Conda environment setup failed",
      error: "LibMambaUnsatisfiableError: Encountered problems while solving:\n  - package python-3.12.0 requires openssl >=3.0",
    },
    micromamba: { state: "ready", message: "micromamba is ready", error: null },
  },
};

test("a failed Python base preserves its error transcript instead of stripping it", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const read = context.mock.fn(async () => failedWithTranscript);
  assert.deepEqual(await waitForEnvironmentSetup(read), failedWithTranscript);
  assert.equal(read.mock.callCount(), 1);
});

test("a failed setup with an error transcript includes it in the BLOCKED reason", () => {
  const reason = formatEnvironmentSetupBlockedReason(failedWithTranscript);
  assert.ok(reason.startsWith("failed: Conda environment setup failed"));
  assert.match(reason, /LibMambaUnsatisfiableError/);
  assert.match(reason, /openssl >=3\.0/);
});

test("a failed setup without an error renders exactly as before", () => {
  assert.equal(
    formatEnvironmentSetupBlockedReason(failed),
    "failed: Managed Python base installation failed",
  );
  assert.equal(
    formatEnvironmentSetupBlockedReason({ ...failed, error: null, components: { conda: { error: null } } }),
    "failed: Managed Python base installation failed",
  );
  assert.equal(
    formatEnvironmentSetupBlockedReason({ ...failed, error: "   " }),
    "failed: Managed Python base installation failed",
  );
  assert.equal(
    formatEnvironmentSetupBlockedReason({ ...failed, error: "" }),
    "failed: Managed Python base installation failed",
  );
  assert.equal(
    formatEnvironmentSetupBlockedReason({ ...failed, error: null, components: {} }),
    "failed: Managed Python base installation failed",
  );
  assert.equal(
    formatEnvironmentSetupBlockedReason({ ...failed, error: null, components: { conda: {} } }),
    "failed: Managed Python base installation failed",
  );
});

test("a conda error that differs from the setup error is appended after it", () => {
  const setup = {
    ...failedWithTranscript,
    error: "conda channel https://conda.anaconda.org/conda-forge unreachable (ECONNRESET)",
  };
  const reason = formatEnvironmentSetupBlockedReason(setup);
  assert.ok(reason.indexOf("ECONNRESET") < reason.indexOf("LibMambaUnsatisfiableError"));
  assert.match(reason, /conda: LibMambaUnsatisfiableError/);
});

test("an identical conda error is not repeated in the BLOCKED reason", () => {
  const reason = formatEnvironmentSetupBlockedReason(failedWithTranscript);
  assert.equal(reason.match(/LibMambaUnsatisfiableError/g)?.length, 1);
});

test("a transcript longer than the bound is truncated with a marker", () => {
  const longError = "x".repeat(ENVIRONMENT_SETUP_ERROR_LIMIT + 50);
  const reason = formatEnvironmentSetupBlockedReason({ ...failed, error: longError });
  const marker = "… (transcript truncated)";
  assert.ok(reason.endsWith(marker));
  assert.ok(reason.includes("x".repeat(ENVIRONMENT_SETUP_ERROR_LIMIT)));
  assert.ok(!reason.includes("x".repeat(ENVIRONMENT_SETUP_ERROR_LIMIT + 1)));
});

test("the last GET receives only the remaining total readiness budget", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const budgets: number[] = [];
  const read = async (timeoutMs: number) => { budgets.push(timeoutMs); return installing; };
  const result = waitForEnvironmentSetup(read);
  await setImmediate();
  for (let seconds = 5; seconds <= 175; seconds += 5) {
    context.mock.timers.tick(5_000);
    await setImmediate();
  }
  assert.equal(budgets[0], 10_000);
  assert.equal(budgets.at(-1), 5_000);
  context.mock.timers.tick(5_000);
  assert.deepEqual(await result, installing);
  assert.equal(budgets.length, 36);
});
