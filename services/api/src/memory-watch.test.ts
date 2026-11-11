// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { API_MAX_OLD_SPACE_ENV, heapBudget } from "./heap-budget.js";
import { createMemoryWatch, type MemorySample } from "./memory-watch.js";

const MiB = 1024 * 1024;

function recorder() {
  const events: Array<{ level: string; event: string; fields: Record<string, unknown> }> = [];
  return {
    events,
    log: {
      info(event: string, fields?: Record<string, unknown>) { events.push({ level: "info", event, fields: fields ?? {} }); },
      warn(event: string, fields?: Record<string, unknown>) { events.push({ level: "warn", event, fields: fields ?? {} }); },
    },
  };
}

const sampleWith = (heapUsedMb: number, limitMb = 3264): (() => MemorySample) => () => ({
  rssBytes: 2048 * MiB, heapUsedBytes: heapUsedMb * MiB, heapTotalBytes: Math.min(heapUsedMb, limitMb) * MiB,
  externalBytes: 256 * MiB, heapLimitBytes: limitMb * MiB,
});

const budget = (explicitMb: number | undefined) => heapBudget({
  env: explicitMb === undefined ? {} : { [API_MAX_OLD_SPACE_ENV]: String(explicitMb) },
  execArgv: explicitMb === undefined ? [] : [`--max-old-space-size=${explicitMb}`],
  heapLimitBytes: 3264 * MiB,
});

test("the boot line states the budget the process really runs under", () => {
  const { events, log } = recorder();
  const applied = recorder();
  createMemoryWatch({ log, sample: sampleWith(100, 3264), budget: budget(3072), scheduler: () => ({ cancel() {} }) }).start();
  const boot = events.find((entry) => entry.event === "api_heap_budget");
  assert.ok(boot);
  assert.equal(boot.fields.budgetMb, 3072);
  assert.equal(boot.fields.explicitMb, 3072);
  assert.equal(boot.fields.guidance, undefined);
  // The sample right after the boot line is what makes a long run's start point visible.
  assert.ok(events.some((entry) => entry.event === "api_memory_sample"));

  createMemoryWatch({ log: applied.log, sample: sampleWith(100, 4288), budget: budget(undefined), scheduler: () => ({ cancel() {} }) }).start();
  const implicit = applied.events.find((entry) => entry.event === "api_heap_budget_implicit");
  assert.ok(implicit, "an unapplied budget must be reported, not assumed");
  assert.match(String(implicit.fields.guidance), /No --max-old-space-size reached this process/);
});

test("the ratio is taken against V8's limit, not against the committed heap", () => {
  const { events, log } = recorder();
  const watch = createMemoryWatch({ log, sample: sampleWith(1632, 3264), budget: budget(3072) });
  // 1632 of 3264 is half; the committed heap is 1632 as well, so a ratio against
  // heapTotal would read 1.0 and warn, which is the bug this avoids.
  assert.equal(watch.sampleOnce().heapRatio, 0.5);
  assert.equal(events.filter((entry) => entry.level === "warn").length, 0);
});

test("pressure and the critical threshold are reported once each, before the process dies", () => {
  const { events, log } = recorder();
  let used = 1000;
  const watch = createMemoryWatch({
    log, sample: () => sampleWith(used)(), budget: budget(3072),
  });
  watch.sampleOnce();
  used = 2450; // 75% of 3264
  watch.sampleOnce();
  watch.sampleOnce();
  used = 3000; // 92%
  watch.sampleOnce();
  watch.sampleOnce();

  const pressure = events.filter((entry) => entry.event === "api_memory_pressure");
  const critical = events.filter((entry) => entry.event === "api_memory_critical");
  assert.equal(pressure.length, 1);
  assert.equal(critical.length, 1);
  assert.match(String(pressure[0]!.fields.guidance), /75% of the 3072 MiB budget/);
  assert.match(String(critical[0]!.fields.guidance), /92% of the budget/);
  // Every sample still reaches the log, so the timeline is continuous.
  assert.equal(events.filter((entry) => entry.event === "api_memory_sample").length, 5);
});

test("the sampling stops when the returned function is called", () => {
  const { events, log } = recorder();
  let tick: (() => void) | undefined, cancelled = false;
  const watch = createMemoryWatch({
    log, sample: sampleWith(100), budget: budget(3072),
    scheduler: (callback, intervalMs) => {
      assert.equal(intervalMs, 30_000);
      tick = callback;
      return { cancel() { cancelled = true; } };
    },
  });
  const stop = watch.start();
  const afterStart = events.length;
  tick!();
  assert.ok(events.length > afterStart, "the scheduler drives the samples");
  stop();
  assert.equal(cancelled, true);
});
