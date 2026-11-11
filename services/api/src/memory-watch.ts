// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { LogFields } from "@sciencediscovery/operational-logging";
import { getHeapStatistics } from "node:v8";

import { API_MAX_OLD_SPACE_ENV, DEFAULT_API_MAX_OLD_SPACE_MB, heapBudget, heapBudgetWarning, type HeapBudget } from "./heap-budget.js";

/**
 * The signal the abort in #1011 did not have.
 *
 * The process died at V8's default old-space limit after 2,641,988 ms of
 * uptime with nothing in the log beforehand, so nobody could tell a long
 * research session was close to the edge. This watch samples
 * `process.memoryUsage()` on an interval, states once which budget it is
 * running under, and warns as the heap approaches that budget — before V8
 * aborts the process.
 *
 * Old space is what `--max-old-space-size` bounds, so the ratios use
 * `heapUsed / heapTotal` growth against V8's own limit rather than RSS: RSS
 * also carries the CAS buffers and typed arrays that the limit does not cover,
 * and comparing it to the old-space budget would warn too early.
 */
export interface MemorySample {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  heapLimitBytes: number;
}

export interface MemoryWatchLog {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
}

export interface MemoryWatch {
  /** Log one sample now, and the thresholds it crossed. */
  sampleOnce(): { heapRatio: number; rssMiB: number; heapUsedMiB: number };
  /** State the budget, then sample every interval. Returns the stop function. */
  start(): () => void;
}

/** The repeating timer, injectable so a test can assert the sampling stopped. */
export interface RepeatingTimer {
  cancel(): void;
}

export type MemoryWatchScheduler = (tick: () => void, intervalMs: number) => RepeatingTimer;

const scheduleWithInterval: MemoryWatchScheduler = (tick, intervalMs) => {
  const timer = setInterval(tick, intervalMs);
  // Never hold the process open for a log line.
  timer.unref?.();
  return { cancel: () => clearInterval(timer) };
};

function nodeMemorySample(): MemorySample {
  const usage = process.memoryUsage();
  return {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    heapTotalBytes: usage.heapTotal,
    externalBytes: usage.external,
    // The ceiling the launch path set, as V8 reports it (old space plus the
    // young generation). `heapTotal` is only the committed heap and would make
    // the ratio meaningless.
    heapLimitBytes: getHeapStatistics().heap_size_limit,
  };
}

const mib = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 10) / 10;

export function createMemoryWatch(options: {
  log: MemoryWatchLog;
  intervalMs?: number;
  sample?: () => MemorySample;
  budget?: HeapBudget;
  heapLimitBytes?: number;
  warnRatio?: number;
  criticalRatio?: number;
  scheduler?: MemoryWatchScheduler;
}): MemoryWatch {
  const { log } = options;
  const sample = options.sample ?? nodeMemorySample;
  const budget = options.budget ?? heapBudget();
  const intervalMs = options.intervalMs ?? 30_000;
  const warnRatio = options.warnRatio ?? 0.75;
  const criticalRatio = options.criticalRatio ?? 0.9;
  const limitBytes = options.heapLimitBytes;
  const scheduler = options.scheduler ?? scheduleWithInterval;
  let warned = false, critical = false;

  const read = (): MemorySample => {
    const value = sample();
    return limitBytes === undefined ? value : { ...value, heapLimitBytes: limitBytes };
  };

  const sampleOnce = () => {
    const value = read();
    const limit = Math.max(value.heapLimitBytes, 1);
    const heapRatio = Math.round((value.heapUsedBytes / limit) * 1000) / 1000;
    const fields: LogFields = {
      rssMiB: mib(value.rssBytes),
      heapUsedMiB: mib(value.heapUsedBytes),
      heapTotalMiB: mib(value.heapTotalBytes),
      externalMiB: mib(value.externalBytes),
      heapRatio,
      budgetMb: budget.budgetMb,
    };
    log.info("api_memory_sample", fields);
    if (heapRatio >= criticalRatio && !critical) {
      critical = true;
      log.warn("api_memory_critical", {
        ...fields,
        guidance: `The heap is at ${Math.round(heapRatio * 100)}% of the budget; V8 aborts at --max-old-space-size=${budget.budgetMb}. Finish or export the running session, or raise ${API_MAX_OLD_SPACE_ENV}.`,
      });
    } else if (heapRatio >= warnRatio && !warned) {
      warned = true;
      log.warn("api_memory_pressure", {
        ...fields,
        guidance: `The heap is at ${Math.round(heapRatio * 100)}% of the ${budget.budgetMb} MiB budget (default ${DEFAULT_API_MAX_OLD_SPACE_MB}).`,
      });
    }
    return { heapRatio, rssMiB: fields.rssMiB as number, heapUsedMiB: fields.heapUsedMiB as number };
  };

  const start = (): (() => void) => {
    const warning = heapBudgetWarning(budget);
    log.info("api_heap_budget", {
      budgetMb: budget.budgetMb,
      explicitMb: budget.explicitMb ?? "unset",
      envMb: budget.envMb ?? "unset",
      effectiveLimitMiB: budget.effectiveLimitMb,
      ...(warning ? { guidance: warning } : {}),
    });
    if (warning) log.warn("api_heap_budget_implicit", { budgetMb: budget.budgetMb, guidance: warning });
    sampleOnce();
    const timer = scheduler(sampleOnce, intervalMs);
    return () => timer.cancel();
  };

  return { sampleOnce, start };
}
