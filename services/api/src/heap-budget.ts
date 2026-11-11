// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { getHeapStatistics } from "node:v8";

/**
 * The API's heap budget, and the evidence that it was actually applied.
 *
 * A budget is only worth anything if the process can tell whether it got one:
 * the abort in #1011 arrived with no warning because nothing bounded old space
 * and nothing reported it. The launch paths pass
 * `--max-old-space-size` (see `services/api/package.json`,
 * `scripts/start-stack.{sh,mjs}` and `services/launcher/src/serve.ts`), each
 * reading `SCIENCE_AGENT_API_MAX_OLD_SPACE_MB` with the same default; the API
 * then reports the flag it really received, so a launcher that forgets the
 * budget is visible in the log instead of silently falling back to V8's
 * default.
 *
 * `--max-old-space-size` bounds the old generation only. V8's
 * `heap_size_limit` is larger by the young generation, which is why the two
 * numbers are logged separately rather than compared for equality.
 */
export const API_MAX_OLD_SPACE_ENV = "SCIENCE_AGENT_API_MAX_OLD_SPACE_MB";
export const DEFAULT_API_MAX_OLD_SPACE_MB = 3072;
export const MIN_API_MAX_OLD_SPACE_MB = 256;
export const MAX_API_MAX_OLD_SPACE_MB = 32768;

export interface HeapBudget {
  /** The old-space budget this process should have: the flag, else the environment, else the default. */
  budgetMb: number;
  /** The `--max-old-space-size` this process really received, if any. */
  explicitMb: number | undefined;
  /** The environment override, if it is set — launchers read it, the API only reports it. */
  envMb: number | undefined;
  /** V8's own limit in MiB: old space plus the young generation. */
  effectiveLimitMb: number;
}

/** The override from the environment, or `undefined` when a launcher should use the default. */
export function apiMaxOldSpaceMb(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env[API_MAX_OLD_SPACE_ENV]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < MIN_API_MAX_OLD_SPACE_MB || value > MAX_API_MAX_OLD_SPACE_MB) {
    throw new Error(`${API_MAX_OLD_SPACE_ENV} must be an integer between ${MIN_API_MAX_OLD_SPACE_MB} and ${MAX_API_MAX_OLD_SPACE_MB}, received "${raw}"`);
  }
  return value;
}

/** The `--max-old-space-size` a process was started with, from its arguments or `NODE_OPTIONS`. */
export function explicitOldSpaceMb(
  execArgv: readonly string[] = process.execArgv,
  nodeOptions: string = process.env.NODE_OPTIONS ?? "",
): number | undefined {
  const fromArguments = execArgv.find((argument) => argument.startsWith("--max-old-space-size="));
  const fromOptions = nodeOptions.split(/\s+/).find((argument) => argument.startsWith("--max-old-space-size="));
  const flag = fromArguments ?? fromOptions;
  if (!flag) return undefined;
  const value = Number(flag.slice("--max-old-space-size=".length));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function heapBudget(options: {
  env?: NodeJS.ProcessEnv;
  execArgv?: readonly string[];
  nodeOptions?: string;
  heapLimitBytes?: number;
} = {}): HeapBudget {
  const envMb = apiMaxOldSpaceMb(options.env ?? process.env);
  const explicitMb = explicitOldSpaceMb(
    options.execArgv ?? process.execArgv,
    options.nodeOptions ?? options.env?.NODE_OPTIONS ?? process.env.NODE_OPTIONS ?? "",
  );
  const limitBytes = options.heapLimitBytes ?? getHeapStatistics().heap_size_limit;
  return {
    budgetMb: explicitMb ?? envMb ?? DEFAULT_API_MAX_OLD_SPACE_MB,
    explicitMb,
    envMb,
    effectiveLimitMb: Math.round(limitBytes / (1024 * 1024)),
  };
}

/**
 * What is wrong with the budget this process actually runs under, or
 * `undefined` when it is applied and consistent with the environment.
 */
export function heapBudgetWarning(budget: HeapBudget): string | undefined {
  if (budget.explicitMb === undefined) {
    return `No --max-old-space-size reached this process; V8's default limit applies (${budget.effectiveLimitMb} MiB). Set ${API_MAX_OLD_SPACE_ENV} and launch through a path that passes the flag.`;
  }
  if (budget.envMb !== undefined && budget.envMb !== budget.explicitMb) {
    return `${API_MAX_OLD_SPACE_ENV}=${budget.envMb} was ignored: the process was started with --max-old-space-size=${budget.explicitMb}.`;
  }
  return undefined;
}
