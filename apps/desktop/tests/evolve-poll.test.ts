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

/**
 * What a failed run-list read does to the poll.
 *
 * The list is only polled while a search is active, which is what keeps an
 * idle session from costing a request every three seconds. The catch is that
 * the poll has to re-arm itself: a rejection changes none of the effect's
 * dependencies, so a branch that returns without scheduling is a branch that
 * ends the poll — and a shelf frozen on "running" is indistinguishable from a
 * search that is still expanding.
 */

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
import { createElement } from "react";
import type { EvolveRun } from "@sciencediscovery/schema";

import { act, create, type ReactTestRenderer } from "./support/dom-renderer.js";
import type { ApiClient } from "../src/api/client.js";
import { useEvolve, type EvolveHandle } from "../src/evolve/use-evolve.js";

function run(status: EvolveRun["status"]): EvolveRun {
  return { id: "run-1", sessionId: "s", status } as unknown as EvolveRun;
}

/** The timers this hook armed, without letting them fire: a 3-second cadence
 *  is longer than a unit test may wait, and what is under test is that a
 *  callback was scheduled at all, not when it lands. */
function clock(): { armed: () => number; fire: () => Promise<void>; restore: () => void } {
  const armed = new Map<number, () => void>();
  let nextId = 1;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  // The hook's only timers are its polls; nothing else in this test schedules.
  // The handle has to be real enough that the effect's cleanup can cancel it —
  // a cleared poll is a poll that is not armed.
  globalThis.setTimeout = ((callback: () => void) => {
    const id = nextId;
    nextId += 1;
    armed.set(id, callback);
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    armed.delete(id);
  }) as unknown as typeof clearTimeout;
  return {
    armed: () => armed.size,
    fire: async () => {
      const entry = [...armed.entries()][0];
      assert.ok(entry, "a poll was armed");
      armed.delete(entry[0]);
      const [, callback] = entry;
      await act(async () => {
        callback();
        // The callback starts a request whose `.then`/`.catch` set state; let
        // the microtask queue drain inside the same act().
        for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
      });
    },
    restore: () => {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

function Harness({ api, onHandle, sessionId }: {
  api: ApiClient;
  onHandle: (value: EvolveHandle) => void;
  sessionId: string;
}) {
  onHandle(useEvolve(api, sessionId));
  return null;
}

function mount(
  client: ApiClient,
  handle: (value: EvolveHandle) => void,
  sessionId = "s",
): Promise<ReactTestRenderer> {
  return act(async () => create(createElement(Harness, { api: client, onHandle: handle, sessionId })));
}

/** Answers `/api/evolve/status` as ready, then hands the run-list reads to the
 *  caller's queue in order. */
function client(reads: Array<() => Promise<EvolveRun[]>>): ApiClient {
  return {
    request: async (path: string) => {
      if (path === "/api/evolve/status") return { canInitialize: false, state: "ready" };
      const next = reads.shift();
      assert.ok(next, `unexpected run-list read: ${path}`);
      return next();
    },
  } as unknown as ApiClient;
}

test("a live search keeps polling through a failed read", async () => {
  const timers = clock();
  try {
    const api = client([
      async () => [run("running")],
      async () => {
        throw new Error("proxy hiccup");
      },
      async () => [run("succeeded")],
    ]);
    let latest: EvolveHandle | undefined;
    const renderer = await mount(api, (value) => {
      latest = value;
    });
    // The first read saw an active search, so the next poll is armed.
    assert.equal(timers.armed(), 1);

    await timers.fire();
    // The read failed, but nothing says the search ended: the cadence the last
    // good read set is kept rather than dropped.
    assert.equal(timers.armed(), 1);
    assert.match(latest?.error ?? "", /proxy hiccup/);
    // And the shelf still shows what the last good read said.
    assert.equal(latest?.runs[0]?.status, "running");

    await timers.fire();
    // The search finished: the list is terminal, nothing polls on its own, and
    // the error the failure raised has cleared.
    assert.equal(timers.armed(), 0);
    assert.equal(latest?.runs[0]?.status, "succeeded");
    assert.equal(latest?.error, undefined);
    renderer.unmount();
  } finally {
    timers.restore();
  }
});

test("a failed read on an idle session does not start polling it", async () => {
  // The counterpart: after a terminal list the session costs nothing, and a
  // failure there must not turn an idle session into a request loop.
  const timers = clock();
  try {
    const api = client([
      async () => [run("succeeded")],
      async () => {
        throw new Error("server restarting");
      },
    ]);
    let latest: EvolveHandle | undefined;
    const renderer = await mount(api, (value) => {
      latest = value;
    });
    assert.equal(timers.armed(), 0);

    await act(async () => {
      await latest?.refresh();
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
    });
    assert.equal(timers.armed(), 0);
    assert.match(latest?.error ?? "", /server restarting/);
    renderer.unmount();
  } finally {
    timers.restore();
  }
});

test("a session switch does not inherit the previous session's poll", async () => {
  // Session A has a live search; the user switches to B, whose first read
  // fails. The cadence belonged to A's list, so B is not polled — and the
  // shelf does not keep showing A's running run under B's header.
  const timers = clock();
  try {
    const api = client([
      async () => [run("running")],
      async () => {
        throw new Error("session B unavailable");
      },
    ]);
    let latest: EvolveHandle | undefined;
    const renderer = await mount(api, (value) => {
      latest = value;
    });
    assert.equal(timers.armed(), 1);
    assert.equal(latest?.runs[0]?.status, "running");

    await act(async () => {
      renderer.update(createElement(Harness, {
        api,
        onHandle: (value) => {
          latest = value;
        },
        sessionId: "t",
      }));
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
    });
    // A's poll was cleared with the effect that armed it, and B's failed read
    // arms nothing — an endpoint that is failing is not polled for a session
    // that has no run.
    assert.equal(timers.armed(), 0);
    assert.deepEqual(latest?.runs, []);
    assert.match(latest?.error ?? "", /session B unavailable/);
    renderer.unmount();
  } finally {
    timers.restore();
  }
});
