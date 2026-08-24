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
import test from "node:test";

import type { RunStreamEvent } from "@sciencediscovery/schema";

import { requestRunStop, routeRunStreamEvent } from "../src/App.js";
import { reduceRunTimeline, type RunTimelineEntry } from "../src/RunTimeline.js";

/** Collect the grace-period callback instead of waiting five real seconds. */
function captureSchedule() {
  const pending: Array<() => void> = [];
  return {
    fire: () => { for (const callback of pending.splice(0)) callback(); },
    scheduled: () => pending.length,
    schedule: (callback: () => void) => { pending.push(callback); },
  };
}

test("the grace-period abort targets the stopped run, not the next one on the same Session", async () => {
  const controllers = new Map<string, AbortController>();
  const stopped = new AbortController();
  controllers.set("session-a", stopped);
  const schedule = captureSchedule();

  await requestRunStop({
    cancelRun: async () => ({ cancelled: true }),
    controllers,
    graceMs: 5_000,
    schedule: schedule.schedule,
    sessionId: "session-a",
  });

  // The server closes the stream, the finished run drops its controller, and the
  // user starts a new run on the same Session well inside the grace period.
  controllers.delete("session-a");
  const nextRun = new AbortController();
  controllers.set("session-a", nextRun);

  assert.equal(schedule.scheduled(), 1);
  schedule.fire();

  assert.equal(nextRun.signal.aborted, false, "the follow-up run must survive the previous Stop's grace timer");
  assert.equal(stopped.signal.aborted, true, "the stopped run is the one the fallback aborts");
});

test("a still-open stream is dropped locally once the grace period expires", async () => {
  const controllers = new Map<string, AbortController>();
  const stuck = new AbortController();
  controllers.set("session-a", stuck);
  const schedule = captureSchedule();

  await requestRunStop({
    cancelRun: async () => ({ cancelled: true }),
    controllers,
    schedule: schedule.schedule,
    sessionId: "session-a",
  });
  assert.equal(stuck.signal.aborted, false, "the server gets the grace period before the client gives up");
  schedule.fire();
  assert.equal(stuck.signal.aborted, true);
});

test("a failed cancel call aborts the local stream immediately", async () => {
  const controllers = new Map<string, AbortController>();
  const controller = new AbortController();
  controllers.set("session-a", controller);
  const schedule = captureSchedule();

  await requestRunStop({
    cancelRun: async () => { throw new Error("No run is active for this session"); },
    controllers,
    schedule: schedule.schedule,
    sessionId: "session-a",
  });

  assert.equal(controller.signal.aborted, true);
  assert.equal(schedule.scheduled(), 0, "there is nothing left to wait for once the stream was dropped");
});

const cancelled: RunStreamEvent = { reason: "Run cancelled by the user", type: "run.cancelled" };

test("a cancelled run still updates the timeline of the Session on screen", () => {
  const routing = routeRunStreamEvent(cancelled, { isDisplayed: true, sessionTitle: "Session A" });
  assert.equal(routing.updatesSessionView, true, "run.cancelled must reach reduceRunTimeline");
  assert.deepEqual(routing.toast, { detail: "Run cancelled by the user", title: "Run stopped", tone: "info" });
});

test("stopping a run closes out the timeline the way the app applies it", () => {
  const events: RunStreamEvent[] = [
    { phase: "thinking", turn: 1, type: "agent.phase" },
    { delta: "Loading the table.", turn: 1, type: "assistant.thinking.delta" },
    { trace: { id: "tool-1", name: "run_python", status: "running" }, type: "tool.started" },
    cancelled,
  ];
  // Mirrors the App's dispatch: route first, then feed the reducer.
  const entries = events.reduce<RunTimelineEntry[]>((current, event) => {
    const routing = routeRunStreamEvent(event, { isDisplayed: true });
    return routing.updatesSessionView ? reduceRunTimeline(current, event) : current;
  }, []);

  assert.equal(entries[0]?.type === "thinking" && entries[0].status, "completed");
  assert.equal(entries[1]?.type === "tool" && entries[1].trace.status, "failed");
  assert.equal(entries[1]?.type === "tool" && entries[1].trace.summary, "Run cancelled by the user");
});

test("Stop feedback reaches the user even after switching Sessions", () => {
  const routing = routeRunStreamEvent(cancelled, { isDisplayed: false, sessionTitle: "Session A" });
  assert.equal(routing.updatesSessionView, false, "a background run must not write into the visible Session");
  assert.equal(routing.toast?.title, "Run stopped");
});

test("a background run that fails names its Session instead of failing silently", () => {
  const failure: RunStreamEvent = { error: "Gateway is unavailable", type: "run.failed" };

  const background = routeRunStreamEvent(failure, { isDisplayed: false, sessionTitle: "Session A" });
  assert.deepEqual(background.toast, {
    detail: "Gateway is unavailable",
    title: "Run failed · Session A",
    tone: "error",
  });

  // On screen the error banner already reports it, so no duplicate toast.
  const displayed = routeRunStreamEvent(failure, { isDisplayed: true, sessionTitle: "Session A" });
  assert.equal(displayed.toast, undefined);
  assert.equal(displayed.updatesSessionView, true);
});

test("ordinary stream events carry no toast and follow the display gate", () => {
  const delta: RunStreamEvent = { delta: "partial answer", type: "assistant.delta" };
  assert.deepEqual(routeRunStreamEvent(delta, { isDisplayed: true }), { updatesSessionView: true });
  assert.deepEqual(routeRunStreamEvent(delta, { isDisplayed: false }), { updatesSessionView: false });
});
