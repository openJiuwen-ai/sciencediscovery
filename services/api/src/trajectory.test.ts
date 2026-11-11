// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import { SessionStore } from "./store.js";
import {
  DEFAULT_TRAJECTORY_MAX_EVENTS,
  MAX_TRAJECTORY_MAX_EVENTS,
  MIN_TRAJECTORY_MAX_EVENTS,
  TRAJECTORY_MAX_EVENTS_ENV,
  sessionTrajectory,
  trajectoryMaxEvents,
} from "./trajectory.js";

const signal = () => new AbortController().signal;

async function sessionWithRuns(context: { after: (fn: () => Promise<void>) => void }, runs: number, perRun: number) {
  const root = resolve(process.cwd(), ".tmp", `trajectory-budget-${randomUUID()}`);
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.load();
  const project = await store.createProject("Trajectory budget");
  const session = await store.createSession(project.id, "Long session", {}, {}, { allowUnconfiguredModel: true });
  type Recorded = Awaited<ReturnType<SessionStore["listRunStreamEvents"]>>[number];
  const events = (run: number): Recorded[] => Array.from({ length: perRun }, (_, index) => ({
    sessionId: session.id, runId: `run-${run}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, run * 1_000 + index)).toISOString(),
    sequence: index + 1,
    event: { type: "tool.completed", trace: { id: `call-${run}-${index}`, name: "run_shell", status: "completed" } },
  }));
  const runIds: string[] = [];
  for (let run = 1; run <= runs; run += 1) {
    const created = await store.createSessionRun({
      sessionId: session.id, prompt: `Run ${run}`,
      settingsSnapshot: store.resolveRuntimeSettings(session.id).effective,
    });
    await store.restoreRunStream(session.id, created.id, "main", events(run));
    runIds.push(created.id);
  }
  return { store, session, runIds };
}

const eventIds = (index: { entries: Array<{ id: string }>; untimedEntries?: Array<{ id: string }> }) =>
  [...index.entries, ...(index.untimedEntries ?? [])].map((entry) => entry.id).filter((id) => id.startsWith("event:"));

test("the override is read, defaulted and refused instead of clamped", () => {
  assert.equal(trajectoryMaxEvents({}), DEFAULT_TRAJECTORY_MAX_EVENTS);
  assert.equal(trajectoryMaxEvents({ [TRAJECTORY_MAX_EVENTS_ENV]: " 2000 " }), 2000);
  for (const raw of ["0", "abc", "1.5", String(MIN_TRAJECTORY_MAX_EVENTS - 1), String(MAX_TRAJECTORY_MAX_EVENTS + 1)]) {
    assert.throws(() => trajectoryMaxEvents({ [TRAJECTORY_MAX_EVENTS_ENV]: raw }), /SCIENCE_AGENT_TRAJECTORY_MAX_EVENTS/, raw);
  }
});

test("past the budget the view keeps the newest events and says how many it dropped", async (context) => {
  const { store, session, runIds } = await sessionWithRuns(context, 4, 5);
  const view = await sessionTrajectory(store, session.id, signal(), { maxEvents: 6 });
  const ids = eventIds(view.index);

  // Every entry that came from a Run event is one of the last six, and nothing
  // below that survives: the array is a tail, not a random sample.
  assert.equal(ids.length, 6);
  assert.deepEqual(ids, [
    `event:${runIds[2]}:main:5`,
    ...[1, 2, 3, 4, 5].map((sequence) => `event:${runIds[3]}:main:${sequence}`),
  ]);
  const warning = view.index.warnings.find((line) => line.includes("left out to keep this view within its budget"));
  assert.ok(warning, `the bounded view must say so: ${JSON.stringify(view.index.warnings)}`);
  assert.match(warning, /^Only the newest 6 recorded Run events are shown; 14 older events were left out/);
  assert.match(warning, /SCIENCE_AGENT_TRAJECTORY_MAX_EVENTS/);

  // The dropped entries are not addressable any more, which is what makes the
  // warning the only way a reader could be misled.
  assert.equal(await view.detail(`event:${runIds[0]}:main:1`), undefined);
  assert.ok(await view.detail(`event:${runIds[3]}:main:5`));
});

test("a session inside its budget is unchanged, and carries no warning", async (context) => {
  const { store, session } = await sessionWithRuns(context, 2, 3);
  const bounded = await sessionTrajectory(store, session.id, signal(), { maxEvents: 1_000 });
  const unbounded = await sessionTrajectory(store, session.id, signal(), { maxEvents: 5_000_000 });

  assert.deepEqual(eventIds(bounded.index), eventIds(unbounded.index));
  assert.equal(eventIds(bounded.index).length, 6);
  assert.equal(bounded.index.warnings.some((line) => line.includes("within its budget")), false);
  assert.deepEqual(
    [...bounded.index.entries].map((entry) => entry.id),
    [...unbounded.index.entries].map((entry) => entry.id),
  );
});
