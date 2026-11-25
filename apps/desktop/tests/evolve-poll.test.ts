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
 * What a failed run-list read does to the poll, and that a ready runtime is
 * still watched.
 *
 * The list is only polled while a search is active, which is what keeps an
 * idle session from costing a request every three seconds. The catch is that
 * the poll has to re-arm itself: a rejection changes none of the effect's
 * dependencies, so a branch that returns without scheduling is a branch that
 * ends the poll — and a card frozen on "running" is indistinguishable from a
 * search that is still expanding.
 *
 * The runtime is the same story at a different speed: a status read that stops
 * at `ready` never sees the sidecar die, which is what let the create dialog go
 * on offering 开始设计 over a runtime that could not run it.
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
import type { EvolveStatus } from "../src/api/evolve.js";
import { useEvolve, type EvolveHandle } from "../src/evolve/use-evolve.js";

function run(status: EvolveRun["status"]): EvolveRun {
  return { id: "run-1", sessionId: "s", status } as unknown as EvolveRun;
}

/** The unready cadence, and the band a ready runtime must be re-read in. These
 *  are written out rather than read from the hook: a test that imported the
 *  constant would pass even if it drifted out of the 30–60 s the dialog needs. */
const ACTIVE_POLL_MS = 3_000;
const UNREADY_POLL_MS = 4_000;
const READY_POLL_MIN_MS = 30_000;
const READY_POLL_MAX_MS = 60_000;

/** The timers the hook armed, without letting them fire: the cadences are
 *  longer than a unit test may wait, and what is under test is that a callback
 *  was scheduled and at what interval. The delay is recorded because there are
 *  now two status cadences — slow while ready, quick while not — and a helper
 *  that fired "the first timer armed" would fire whichever chain happened to
 *  arm first. */
function clock(): {
  armed: (delay?: number) => number;
  delays: () => number[];
  fire: (delay?: number) => Promise<void>;
  ready: () => number;
  restore: () => void;
} {
  const armed = new Map<number, { callback: () => void; delay: number }>();
  let nextId = 1;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  // The hook's only timers are its polls; nothing else in this test schedules.
  // The handle has to be real enough that the effect's cleanup can cancel it —
  // a cleared poll is a poll that is not armed.
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    const id = nextId;
    nextId += 1;
    armed.set(id, { callback, delay: delay ?? 0 });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    armed.delete(id);
  }) as unknown as typeof clearTimeout;
  const delays = () => [...armed.values()].map((entry) => entry.delay);
  const ready = () => {
    const found = delays().find((delay) => delay >= READY_POLL_MIN_MS && delay <= READY_POLL_MAX_MS);
    assert.ok(found !== undefined, `a ready runtime is re-read within 30–60 s (armed: ${delays().join(", ")})`);
    return found;
  };
  return {
    armed: (delay?: number) => (delay === undefined
      ? armed.size
      : delays().filter((value) => value === delay).length),
    delays,
    fire: async (delay?: number) => {
      const entry = [...armed.entries()].find(([, value]) => delay === undefined || value.delay === delay);
      assert.ok(entry, `a poll was armed at ${delay ?? "any"} ms (armed: ${delays().join(", ")})`);
      armed.delete(entry[0]);
      const [, value] = entry;
      await act(async () => {
        value.callback();
        // The callback starts a request whose `.then`/`.catch` set state; let
        // the microtask queue drain inside the same act().
        for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
      });
    },
    ready,
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

/** Answers `/api/evolve/status` from `statuses` in order — an entry that is an
 *  `Error` rejects — repeating the last answer once the list runs out — and
 *  hands the run-list reads to the caller's queue in order. */
function client(
  reads: Array<() => Promise<EvolveRun[]>>,
  statuses: EvolveStatus | Array<Error | EvolveStatus> = { canInitialize: false, state: "ready" },
): ApiClient {
  const queue = Array.isArray(statuses) ? [...statuses] : undefined;
  let last: Error | EvolveStatus = Array.isArray(statuses)
    ? statuses[statuses.length - 1] ?? { canInitialize: false, state: "ready" }
    : statuses;
  return {
    request: async (path: string) => {
      if (path === "/api/evolve/status") {
        if (queue !== undefined && queue.length > 0) last = queue.shift() ?? last;
        if (last instanceof Error) throw last;
        return last;
      }
      const next = reads.shift();
      assert.ok(next, `unexpected run-list read: ${path}`);
      return next();
    },
  } as unknown as ApiClient;
}

test("a restored run is read while the runtime is not initialized", async () => {
  // A session imported from a research package opens before Init Evolve: the
  // list is on disk and must be shown, so readiness must not gate the read.
  const timers = clock();
  try {
    const api = client(
      [async () => [run("succeeded")]],
      { canInitialize: true, state: "not_initialized" },
    );
    let latest: EvolveHandle | undefined;
    const renderer = await mount(api, (value) => {
      latest = value;
    });
    assert.equal(latest?.status.state, "not_initialized");
    assert.equal(latest?.runs[0]?.status, "succeeded",
      "the restored card is shown before the runtime is initialized");
    // The cadence is the status poll's alone: a terminal list is not re-read,
    // and an unready runtime keeps its quick cadence.
    assert.deepEqual(timers.delays(), [UNREADY_POLL_MS]);
    renderer.unmount();
  } finally {
    timers.restore();
  }
});

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
    // The first read saw an active search, so the next poll is armed; the
    // ready runtime is also watched, slowly.
    assert.equal(timers.armed(ACTIVE_POLL_MS), 1);
    timers.ready();

    await timers.fire(ACTIVE_POLL_MS);
    // The read failed, but nothing says the search ended: the cadence the last
    // good read set is kept rather than dropped.
    assert.equal(timers.armed(ACTIVE_POLL_MS), 1);
    assert.match(latest?.error ?? "", /proxy hiccup/);
    // And the cards still show what the last good read said.
    assert.equal(latest?.runs[0]?.status, "running");

    await timers.fire(ACTIVE_POLL_MS);
    // The search finished: the list is terminal, nothing polls on its own, and
    // the error the failure raised has cleared.
    assert.equal(timers.armed(ACTIVE_POLL_MS), 0);
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
    assert.equal(timers.armed(ACTIVE_POLL_MS), 0);

    await act(async () => {
      await latest?.refresh();
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
    });
    // Re-reading the list neither starts a list poll nor adds a second status
    // chain: the one slow status poll is still the only timer.
    assert.equal(timers.armed(ACTIVE_POLL_MS), 0);
    assert.equal(timers.armed(), 1);
    assert.match(latest?.error ?? "", /server restarting/);
    renderer.unmount();
  } finally {
    timers.restore();
  }
});

test("a session switch does not inherit the previous session's poll", async () => {
  // Session A has a live search; the user switches to B, whose first read
  // fails. The cadence belonged to A's list, so B is not polled — and the
  // cards do not keep showing A's running run under B's answer.
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
    assert.equal(timers.armed(ACTIVE_POLL_MS), 1);
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
    assert.equal(timers.armed(ACTIVE_POLL_MS), 0);
    assert.deepEqual(latest?.runs, []);
    assert.match(latest?.error ?? "", /session B unavailable/);
    renderer.unmount();
  } finally {
    timers.restore();
  }
});

test("a ready runtime that dies is noticed by the slow poll alone", async () => {
  // The bug: the poll stopped at `ready`, so a sidecar that died afterwards was
  // still shown as 就绪 — no banner, and 开始设计 went through — until the page
  // was reloaded. One slow re-read is enough to correct it.
  const timers = clock();
  try {
    const api = client(
      [async () => []],
      [
        { canInitialize: true, state: "ready" },
        { canInitialize: false, state: "error" },
      ],
    );
    let latest: EvolveHandle | undefined;
    const renderer = await mount(api, (value) => {
      latest = value;
    });
    assert.equal(latest?.status.state, "ready");
    const slow = timers.ready();

    await timers.fire(slow);
    // The second read answered "the runtime is gone", so the state is no longer
    // ready — with no run activity and no reload in between.
    assert.equal(latest?.status.state, "error");
    // And the quick cadence takes over, so a runtime that comes back is seen
    // just as promptly.
    assert.deepEqual(timers.delays(), [UNREADY_POLL_MS]);
    await act(async () => {
      renderer.unmount();
    });
    assert.equal(timers.armed(), 0, "unmounting cancels the poll");
  } finally {
    timers.restore();
  }
});

test("refreshStatus re-reads the runtime through the poll's one chain", async () => {
  // The dialog calls this when it opens. It must actually read — a no-op would
  // leave the 就绪 it was handed — and it must not start a second timer chain:
  // the next poll still belongs to the cadence the new state asks for.
  const timers = clock();
  try {
    const api = client(
      [async () => []],
      [
        { canInitialize: true, state: "ready" },
        { canInitialize: true, state: "not_initialized" },
      ],
    );
    let latest: EvolveHandle | undefined;
    const renderer = await mount(api, (value) => {
      latest = value;
    });
    timers.ready();

    await act(async () => {
      await latest?.refreshStatus();
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
    });
    assert.equal(latest?.status.state, "not_initialized");
    assert.deepEqual(timers.delays(), [UNREADY_POLL_MS],
      "one chain, re-armed at the unready cadence");
    renderer.unmount();
  } finally {
    timers.restore();
  }
});

test("a refresh during a status read already on the wire joins it instead of racing", async () => {
  // The dialog's open refresh arrives while a poll read is still waiting. Two
  // GETs would race, and the older answer lands last: a sidecar that has just
  // died could be re-labelled ready and stay that way for another slow
  // interval. One read at a time, and the answer that read was waiting for is
  // the one that counts.
  const timers = clock();
  try {
    let reads = 0;
    let answer: ((status: EvolveStatus) => void) | undefined;
    const api = {
      request: async (path: string) => {
        if (path === "/api/evolve/status") {
          reads += 1;
          assert.equal(reads, 1, "a second status GET was started");
          return new Promise<EvolveStatus>((resolve) => {
            answer = resolve;
          });
        }
        if (path.startsWith("/api/evolve/runs")) return [];
        throw new Error(`unexpected read: ${path}`);
      },
    } as unknown as ApiClient;

    let latest: EvolveHandle | undefined;
    const renderer = await mount(api, (value) => {
      latest = value;
    });
    // The first read is still on the wire when the form opens.
    assert.equal(reads, 1);

    let refreshed: Promise<void> | undefined;
    await act(async () => {
      refreshed = latest?.refreshStatus();
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
    });
    assert.equal(reads, 1, "the read in flight is reused, not duplicated");

    await act(async () => {
      answer?.({ canInitialize: true, state: "not_initialized" });
      await refreshed;
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
    });
    // The one answer was applied, and the poll continues on the cadence that
    // answer asks for.
    assert.equal(latest?.status.state, "not_initialized");
    assert.equal(reads, 1);
    assert.deepEqual(timers.delays(), [UNREADY_POLL_MS]);
    renderer.unmount();
  } finally {
    timers.restore();
  }
});

test("an unavailable runtime returns to ready once it answers again", async () => {
  // The state was sticky in one direction only: `error` had to be re-read, and
  // the quick poll is what makes that happen without a reload.
  const timers = clock();
  try {
    const api = client(
      [async () => []],
      [
        { canInitialize: false, state: "error" },
        { canInitialize: true, state: "ready" },
      ],
    );
    let latest: EvolveHandle | undefined;
    const renderer = await mount(api, (value) => {
      latest = value;
    });
    assert.equal(latest?.status.state, "error");
    assert.deepEqual(timers.delays(), [UNREADY_POLL_MS]);

    await timers.fire(UNREADY_POLL_MS);
    assert.equal(latest?.status.state, "ready");
    timers.ready();
    renderer.unmount();
  } finally {
    timers.restore();
  }
});

test("one failed status read is a blip; two in a row stop showing ready", async () => {
  // A restarting server or a proxy hiccup must not flip a working setup, but an
  // endpoint that keeps failing must not keep offering a design it cannot run.
  const timers = clock();
  try {
    const api = client(
      [async () => []],
      [
        { canInitialize: true, state: "ready" },
        new Error("sidecar gone"),
        new Error("sidecar gone"),
      ],
    );
    let latest: EvolveHandle | undefined;
    const renderer = await mount(api, (value) => {
      latest = value;
    });
    const slow = timers.ready();

    await timers.fire(slow);
    // Tolerated: the last good read still stands, and the poll is quick again
    // so the next answer is read within seconds.
    assert.equal(latest?.status.state, "ready");
    assert.equal(timers.armed(UNREADY_POLL_MS), 1);

    await timers.fire(UNREADY_POLL_MS);
    // Consecutive: an endpoint that is not answering is not a ready runtime.
    assert.equal(latest?.status.state, "error");
    renderer.unmount();
  } finally {
    timers.restore();
  }
});

test("a hidden window stops polling, and becoming visible reads once", async () => {
  // An idle, hidden window should cost no requests. Coming back is exactly the
  // moment the status is worth re-reading.
  const listeners = new Set<() => void>();
  let visibility: "hidden" | "visible" = "hidden";
  const previousDocument = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = {
    addEventListener: (type: string, listener: () => void) => {
      if (type === "visibilitychange") listeners.add(listener);
    },
    get visibilityState() {
      return visibility;
    },
    removeEventListener: (type: string, listener: () => void) => {
      if (type === "visibilitychange") listeners.delete(listener);
    },
  };
  const timers = clock();
  try {
    const api = client(
      [async () => []],
      [
        { canInitialize: true, state: "ready" },
        { canInitialize: true, state: "ready" },
      ],
    );
    let latest: EvolveHandle | undefined;
    const renderer = await mount(api, (value) => {
      latest = value;
    });
    assert.equal(latest?.status.state, "ready");
    assert.equal(timers.armed(), 0, "nothing is polled while nobody can see it");

    await act(async () => {
      visibility = "visible";
      for (const listener of [...listeners]) listener();
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
    });
    timers.ready();
    await act(async () => {
      renderer.unmount();
    });
    assert.equal(timers.armed(), 0);
    assert.equal(listeners.size, 0, "the visibility listener is removed with the hook");
  } finally {
    timers.restore();
    (globalThis as { document?: unknown }).document = previousDocument;
  }
});
