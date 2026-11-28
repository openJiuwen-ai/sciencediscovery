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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "os:macos", "os:windows", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";

import { browserSignInAvailable, SIGN_IN_DEADLINE_MS, startBrowserSignIn } from "../src/auth/browser-signin.js";

type Callback = (result: { ticket?: string; error?: string }) => void;

/** Install a fake `window` for the duration of one case, then restore it: the
 *  module feature-detects the shell bridge on `window.sdShell`. */
async function withWindow(value: unknown, run: () => Promise<void>): Promise<void> {
  const had = Object.prototype.hasOwnProperty.call(globalThis, "window");
  const previous = (globalThis as Record<string, unknown>).window;
  (globalThis as Record<string, unknown>).window = value;
  try {
    await run();
  } finally {
    if (had) (globalThis as Record<string, unknown>).window = previous;
    else delete (globalThis as Record<string, unknown>).window;
  }
}

test("without the shell bridge the browser flow is unavailable", async () => {
  await withWindow(undefined, async () => {
    assert.equal(browserSignInAvailable(), false);
    const flow = startBrowserSignIn(() => "https://accounts.test/sign-in");
    assert.equal(await flow.result, null);
  });
});

test("the shell bridge opens the built URL and yields the callback ticket", async () => {
  const opened: string[] = [];
  let deliver: Callback | undefined;
  const bridge = {
    begin: async () => ({ callbackUrl: "http://127.0.0.1:43210/callback" }),
    open: async (url: string) => { opened.push(url); },
    cancel: async () => {},
    onResult: (callback: Callback) => {
      deliver = callback;
      return () => { deliver = undefined; };
    },
  };
  await withWindow({ sdShell: { accountSignIn: bridge } }, async () => {
    assert.equal(browserSignInAvailable(), true);
    const flow = startBrowserSignIn(
      (callbackUrl) => `https://accounts.test/v1/auth/huawei/start?returnUrl=${encodeURIComponent(callbackUrl)}`,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(opened, [
      "https://accounts.test/v1/auth/huawei/start?returnUrl=http%3A%2F%2F127.0.0.1%3A43210%2Fcallback",
    ]);
    deliver?.({ ticket: "ticket-1" });
    assert.deepEqual(await flow.result, { ticket: "ticket-1" });
  });
});

test("the shell bridge reports a failed sign-in", async () => {
  let deliver: Callback | undefined;
  const bridge = {
    begin: async () => ({ callbackUrl: "http://127.0.0.1:43211/callback" }),
    open: async () => {},
    cancel: async () => {},
    onResult: (callback: Callback) => {
      deliver = callback;
      return () => { deliver = undefined; };
    },
  };
  await withWindow({ sdShell: { accountSignIn: bridge } }, async () => {
    const flow = startBrowserSignIn((callbackUrl) => `https://accounts.test/start?returnUrl=${callbackUrl}`);
    await new Promise((resolve) => setImmediate(resolve));
    deliver?.({ error: "access_denied" });
    assert.deepEqual(await flow.result, { error: "access_denied" });
  });
});

test("cancelling resolves the flow and closes the shell callback", async () => {
  let cancelled = false;
  const bridge = {
    begin: async () => ({ callbackUrl: "http://127.0.0.1:43212/callback" }),
    open: async () => {},
    cancel: async () => { cancelled = true; },
    onResult: () => () => {},
  };
  await withWindow({ sdShell: { accountSignIn: bridge } }, async () => {
    const flow = startBrowserSignIn((callbackUrl) => callbackUrl);
    await new Promise((resolve) => setImmediate(resolve));
    flow.cancel();
    assert.equal(await flow.result, null);
    assert.equal(cancelled, true);
  });
});

test("a flow the browser never calls back times out instead of spinning", async () => {
  // The real deadline is minutes away, so the timer is captured and fired by
  // hand: what matters is that a flow without a callback settles at all, and
  // that the shell's loopback server is released with it.
  let cancelled = false;
  let armed: { run: () => void; delay: number } | undefined;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const bridge = {
    begin: async () => ({ callbackUrl: "http://127.0.0.1:43213/callback" }),
    open: async () => {},
    cancel: async () => { cancelled = true; },
    onResult: () => () => {},
  };
  (globalThis as { setTimeout: unknown }).setTimeout = (run: () => void, delay: number) => {
    armed = { run, delay };
    return { unref: () => {} };
  };
  (globalThis as { clearTimeout: unknown }).clearTimeout = () => undefined;
  try {
    await withWindow({ sdShell: { accountSignIn: bridge } }, async () => {
      const flow = startBrowserSignIn((callbackUrl) => callbackUrl);
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(armed, "the flow arms a deadline");
      assert.equal(armed.delay, SIGN_IN_DEADLINE_MS);
      armed.run();
      assert.deepEqual(await flow.result, { error: "timeout" });
      assert.equal(cancelled, true);
    });
  } finally {
    (globalThis as { setTimeout: unknown }).setTimeout = originalSetTimeout;
    (globalThis as { clearTimeout: unknown }).clearTimeout = originalClearTimeout;
  }
});

test("cancelling while the shell is still starting its callback closes it too", async () => {
  // `begin()` may resolve after the reader already gave up; the server it
  // creates belongs to no live flow and must not stay listening.
  let cancels = 0;
  let release: (() => void) | undefined;
  const bridge = {
    begin: () => new Promise<{ callbackUrl: string }>((resolve) => {
      release = () => resolve({ callbackUrl: "http://127.0.0.1:43214/callback/nonce" });
    }),
    open: async () => {},
    cancel: async () => { cancels += 1; },
    onResult: () => () => {},
  };
  await withWindow({ sdShell: { accountSignIn: bridge } }, async () => {
    const flow = startBrowserSignIn((callbackUrl) => callbackUrl);
    flow.cancel();
    assert.equal(await flow.result, null);
    assert.equal(cancels, 1);
    release?.();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancels, 2);
  });
});
