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

import assert from "node:assert/strict";

import { createTest } from "../../../test/support/tagged/compat.mjs";
import {
  changesPanel,
  createPanelRefresh,
  PANEL_REFRESH_MS,
  type PanelTimers,
} from "../src/app/panel-refresh.js";

const { describe, it } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});

/**
 * Timers the test moves by hand. A run's stream arrives in bursts of unknown
 * length, so the throttle is only testable against a clock the test owns.
 */
function fakeClock(): { advance(ms: number): void; pending(): number; timers: PanelTimers } {
  let next = 0;
  let now = 0;
  const scheduled = new Map<number, { at: number; callback: () => void }>();
  return {
    advance(ms: number) {
      now += ms;
      for (const [id, entry] of [...scheduled]) {
        if (entry.at > now) continue;
        scheduled.delete(id);
        entry.callback();
      }
    },
    pending: () => scheduled.size,
    timers: {
      cancel(handle) {
        scheduled.delete(handle as number);
      },
      schedule(callback, delayMs) {
        next += 1;
        scheduled.set(next, { at: now + delayMs, callback });
        return next;
      },
    },
  };
}

describe("the panel's live refresh", () => {
  it("reads on the first event and then at most once per window", () => {
    const clock = fakeClock();
    let reads = 0;
    const refresh = createPanelRefresh(() => { reads += 1; }, { timers: clock.timers });

    refresh.request();
    assert.equal(reads, 1, "the first artifact is listed while the run is still writing");

    refresh.request();
    refresh.request();
    assert.equal(reads, 1, "a burst inside the window does not read again");

    clock.advance(PANEL_REFRESH_MS);
    assert.equal(reads, 2, "the burst reads once when the window closes");

    clock.advance(PANEL_REFRESH_MS);
    assert.equal(reads, 2, "a window that closed with nothing in it reads nothing");
    assert.equal(clock.pending(), 0, "and leaves no armed timer behind");
    refresh.request();
    assert.equal(reads, 3, "a quiet run's next event reads at once again");
  });

  it("keeps reading while the run keeps writing", () => {
    const clock = fakeClock();
    let reads = 0;
    const refresh = createPanelRefresh(() => { reads += 1; }, { timers: clock.timers });

    refresh.request();
    for (let window = 0; window < 3; window += 1) {
      refresh.request();
      refresh.request();
      clock.advance(PANEL_REFRESH_MS);
    }
    assert.equal(reads, 4, "one read per window, not one per event");
  });

  it("drops a read that was waiting when the Session is left", () => {
    const clock = fakeClock();
    let reads = 0;
    const refresh = createPanelRefresh(() => { reads += 1; }, { timers: clock.timers });

    refresh.request();
    refresh.request();
    refresh.cancel();
    clock.advance(PANEL_REFRESH_MS * 4);
    assert.equal(reads, 1, "the pending read never fires for the Session left behind");

    refresh.request();
    assert.equal(reads, 2, "the next Session starts a fresh window");
  });
});

describe("which run events make the panel re-read", () => {
  it("is the two that write into it", () => {
    assert.equal(changesPanel("artifact.upserted"), true);
    assert.equal(changesPanel("workspace.changed"), true);
  });

  it("is nothing else the stream carries", () => {
    for (const type of [
      "assistant.delta",
      "assistant.snapshot",
      "tool.started",
      "tool.completed",
      "tool.output",
      "run.completed",
      "run.status",
      "subagent.step",
      "permission.required",
      "session.updated",
      "plan.updated",
    ]) {
      assert.equal(changesPanel(type), false, `${type} does not write into the panel`);
    }
  });
});
