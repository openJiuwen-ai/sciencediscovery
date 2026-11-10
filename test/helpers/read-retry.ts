// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

/** Retry an idempotent read only; callers must apply the remaining timeout. */
export async function retryRead<T>(
  label: string,
  read: (timeoutMs: number) => Promise<T>,
  timeoutMs = 10_000,
): Promise<T> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await read(Math.max(1, deadline - Date.now()));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const delayMs = attempt * 100;
      if (/-> \d{3}:/.test(message) || attempt >= 3 || Date.now() + delayMs >= deadline
        || !/ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up/i.test(message)) throw error;
      console.warn(`[read-retry] ${label}: attempt ${attempt}/3 failed after ${Date.now() - startedAt}ms; retry in ${delayMs}ms: ${message}`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}
