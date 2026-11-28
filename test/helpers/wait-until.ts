// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { inspect } from "node:util";

export interface WaitUntilOptions<T> {
  /** Wall-clock budget for the whole wait. */
  timeoutMs?: number;
  /** Pause between two observations. */
  intervalMs?: number;
  /** What is awaited; the timeout message starts with it. */
  description?: string;
  /** How the last observation is reported when the deadline passes. */
  describe?: (value: T) => string;
  /** Replaces the timer pause, for example to let React flush inside `act()`. */
  pause?: (ms: number) => Promise<void>;
}

/**
 * Sixty seconds: long enough for background work on a host shared with other
 * jobs (the same cases run 1.2-3.5 times slower there), short enough that a
 * case whose work is stuck still fails well inside its own timeout.
 */
export const DEFAULT_WAIT_TIMEOUT_MS = 60_000;

const MAX_DESCRIPTION_LENGTH = 2_000;

/**
 * Observe until `done` accepts an observation or a wall-clock deadline passes,
 * and return that observation.
 *
 * A loop of N polls with a fixed sleep has a real budget of N times the sleep
 * plus whatever each poll costs, which a busy host exceeds while the work under
 * test is still correct. The deadline bounds time instead. The first accepted
 * observation still returns at once, so a passing case is not slower; the
 * observation is always repeated once the deadline has passed, so a timeout
 * reports a state that is current, not one from a pause ago.
 *
 * An error thrown by `observe` is not retried: it fails the wait immediately.
 */
export async function waitUntil<T>(
  observe: () => T | Promise<T>,
  done: (value: T) => boolean,
  options: WaitUntilOptions<T> = {},
): Promise<T> {
  const {
    timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    intervalMs = 25,
    description = "condition",
    describe = (value: T) => inspect(value, { breakLength: Infinity, depth: 4 }),
    pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  } = options;
  const started = performance.now();
  for (let checks = 1; ; checks += 1) {
    const value = await observe();
    if (done(value)) return value;
    const elapsed = performance.now() - started;
    if (elapsed >= timeoutMs) {
      let last = describe(value);
      if (last.length > MAX_DESCRIPTION_LENGTH) last = `${last.slice(0, MAX_DESCRIPTION_LENGTH)}…`;
      assert.fail(`${description} was not reached within ${timeoutMs} ms (${checks} checks in ${Math.round(elapsed)} ms); last observed: ${last}`);
    }
    await pause(Math.min(intervalMs, timeoutMs - elapsed));
  }
}
