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
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { EvolveRun } from "@sciencediscovery/schema";
import { useEvolveRunPolling } from "../src/evolve/useEvolveRunPolling.js";

test("active cards poll, terminal and failed lists stop, and unmount clears the timer", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0; let result: EvolveRun[] = [{ id: "one", status: "running" } as EvolveRun];
  let fails = false; const seen: EvolveRun[][] = [];
  const client = { listEvolveRuns: async (sessionId: string) => {
    assert.equal(sessionId, "session"); calls++;
    if (fails) throw new Error("fixture unavailable");
    return result;
  } };
  const onRuns = (runs: EvolveRun[]) => seen.push(runs);
  function Poll({ refresh = 0 }) { useEvolveRunPolling(client, "session", true, refresh, onRuns); return null; }
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(Poll)); });
  try {
    assert.equal(calls, 1); assert.equal(seen.at(-1), result);
    await act(async () => t.mock.timers.tick(2_999)); assert.equal(calls, 1);
    await act(async () => t.mock.timers.tick(1)); assert.equal(calls, 2);
    result = [{ id: "one", status: "succeeded" } as EvolveRun];
    await act(async () => t.mock.timers.tick(3_000)); assert.equal(calls, 3); assert.equal(seen.at(-1), result);
    await act(async () => t.mock.timers.tick(30_000)); assert.equal(calls, 3);
    fails = true;
    await act(async () => renderer!.update(createElement(Poll, { refresh: 1 })));
    assert.equal(calls, 4); assert.deepEqual(seen.at(-1), []);
    await act(async () => t.mock.timers.tick(30_000)); assert.equal(calls, 4);
    fails = false; result = [{ status: "running" } as EvolveRun];
    await act(async () => renderer!.update(createElement(Poll, { refresh: 2 })));
    assert.equal(calls, 5);
  } finally { await act(async () => renderer!.unmount()); }
  await act(async () => t.mock.timers.tick(30_000)); assert.equal(calls, 5);
});

test("a session reads its restored runs before the service is ready, and a readiness change discards a superseded answer", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const requests: { sessionId: string; finish: (runs: EvolveRun[]) => void; fail: (error: Error) => void }[] = [];
  const client = { listEvolveRuns: (sessionId: string) => new Promise<EvolveRun[]>((finish, fail) => requests.push({ sessionId, finish, fail })) };
  const seen: EvolveRun[][] = []; const onRuns = (runs: EvolveRun[]) => seen.push(runs);
  function Poll({ ready = false, sessionId = "session", refresh = 0 }: { ready?: boolean; sessionId?: string; refresh?: number }) {
    useEvolveRunPolling(client, sessionId, ready, refresh, onRuns); return null;
  }
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(Poll)); });
  try {
    // A session that is open while Evolve is not ready still has a list on disk:
    // the restored run a research package wrote is read and shown.
    assert.equal(requests.length, 1); assert.equal(requests[0]!.sessionId, "session");
    const restored = [{ id: "restored", status: "stopped" } as EvolveRun];
    await act(async () => requests[0]!.finish(restored));
    assert.deepEqual(seen.at(-1), restored);
    // Without a session there is nothing to read, and the list is emptied.
    await act(async () => renderer!.update(createElement(Poll, { ready: true, sessionId: "" })));
    assert.equal(requests.length, 1); assert.deepEqual(seen.at(-1), []);
    // Back on the session: the list is read again; dropping readiness re-runs the
    // effect, and the answer the superseded read would have delivered is dropped.
    await act(async () => renderer!.update(createElement(Poll, { ready: true })));
    assert.equal(requests.length, 2);
    await act(async () => renderer!.update(createElement(Poll, { ready: false })));
    assert.equal(requests.length, 3);
    await act(async () => requests[1]!.finish([{ id: "stale", status: "running" } as EvolveRun]));
    assert.deepEqual(seen.at(-1), []);
    const settled = [{ id: "final", status: "succeeded" } as EvolveRun];
    await act(async () => requests[2]!.finish(settled));
    assert.deepEqual(seen.at(-1), settled);
    // A refresh starts one more read; unmounting before it lands discards it.
    await act(async () => renderer!.update(createElement(Poll, { ready: false, refresh: 1 })));
    assert.equal(requests.length, 4);
    const before = seen.length;
    await act(async () => renderer!.unmount());
    await act(async () => requests[3]!.finish([{ id: "late", status: "running" } as EvolveRun]));
    assert.equal(seen.length, before);
    await act(async () => t.mock.timers.tick(30_000)); assert.equal(requests.length, 4);
  } finally { await act(async () => renderer!.unmount()); }
});
