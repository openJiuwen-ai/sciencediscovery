// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
//
// Measure what a Session's trajectory build costs, and what the event budget in
// services/api/src/trajectory.ts does to that cost.
//
// The abort in #1011 was a 46-minute Session reaching V8's default old-space
// limit, so the question this answers is: how much heap does building the
// trajectory of a Session of a given size take, and does the budget bound it?
// It builds the Session directly through the store (no HTTP, no model calls),
// then samples process.memoryUsage() while sessionTrajectory runs.
//
// Usage (needs the workspace built first, because the API sources import the
// packages' dist):
//   node --import tsx --expose-gc scripts/measure-trajectory-memory.mjs \
//     --runs 120 --events-per-run 1000 [--max-events 120000]
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "../services/api/src/store.ts";
import { sessionTrajectory } from "../services/api/src/trajectory.ts";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const runs = argument("runs", 60);
const eventsPerRun = argument("events-per-run", 1_000);
const maxEvents = argument("max-events", 0) || undefined;

const root = await mkdtemp(join(tmpdir(), `trajectory-memory-${randomUUID()}-`));
const store = new SessionStore(root);
await store.load();
const project = await store.createProject("Trajectory memory measurement");
const session = await store.createSession(project.id, "Measured session", {}, {}, { allowUnconfiguredModel: true });
const settings = store.resolveRuntimeSettings(session.id).effective;

for (let run = 1; run <= runs; run += 1) {
  const created = await store.createSessionRun({ sessionId: session.id, prompt: `Measured run ${run}`, settingsSnapshot: settings });
  const events = Array.from({ length: eventsPerRun }, (_, index) => ({
    sessionId: session.id, runId: created.id,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + (run * eventsPerRun + index) * 1_000).toISOString(),
    sequence: index + 1,
    event: {
      type: "tool.completed",
      trace: {
        id: `call-${run}-${index}`, name: "run_shell", status: "completed",
        // A realistic payload: a shell result with some detail, not an empty object.
        details: { exitCode: 0, stdout: "x".repeat(200) },
        output: "y".repeat(400),
      },
    },
  }));
  await store.restoreRunStream(session.id, created.id, "main", events);
}

const limitBytes = (await import("node:v8")).getHeapStatistics().heap_size_limit;
const baseline = process.memoryUsage();
let peakRss = baseline.rss, peakHeapUsed = baseline.heapUsed;
const sampler = setInterval(() => {
  const usage = process.memoryUsage();
  peakRss = Math.max(peakRss, usage.rss);
  peakHeapUsed = Math.max(peakHeapUsed, usage.heapUsed);
}, 25);
sampler.unref?.();

const startedAt = Date.now();
const view = await sessionTrajectory(store, session.id, new AbortController().signal,
  maxEvents === undefined ? {} : { maxEvents });
const elapsedMs = Date.now() - startedAt;
clearInterval(sampler);
const after = process.memoryUsage();
peakRss = Math.max(peakRss, after.rss);
peakHeapUsed = Math.max(peakHeapUsed, after.heapUsed);

const mib = (bytes) => Math.round((bytes / (1024 * 1024)) * 10) / 10;
console.log(JSON.stringify({
  runs, eventsPerRun, events: runs * eventsPerRun,
  maxEvents: maxEvents ?? "unbounded",
  heapLimitMiB: mib(limitBytes),
  baselineRssMiB: mib(baseline.rss), peakRssMiB: mib(peakRss),
  baselineHeapUsedMiB: mib(baseline.heapUsed), peakHeapUsedMiB: mib(peakHeapUsed),
  peakHeapRatioOfLimit: Math.round((peakHeapUsed / limitBytes) * 1000) / 1000,
  elapsedMs, entries: view.index.entries.length, untimedEntries: view.index.untimedEntries?.length ?? 0,
  budgetWarning: view.index.warnings.find((line) => line.includes("within its budget")) ?? null,
}, null, 2));

store.close();
await rm(root, { recursive: true, force: true });
