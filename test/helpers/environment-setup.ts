// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

interface EnvironmentSetup {
  message: string;
  state: string;
}

/** Observe the runner's existing installation; the reader must not start another one. */
export async function waitForEnvironmentSetup(
  read: (timeoutMs: number) => Promise<EnvironmentSetup>,
): Promise<EnvironmentSetup> {
  const timeoutMs = 180_000;
  const requestTimeoutMs = 10_000;
  const started = Date.now();
  let requestTimer: ReturnType<typeof setTimeout> | undefined;
  let latest: EnvironmentSetup = {
    state: "unknown",
    message: "No environment setup status received before the readiness deadline",
  };
  let expired = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    deadlineTimer = setTimeout(() => {
      expired = true;
      resolve(undefined);
    }, timeoutMs);
  });

  try {
    while (!expired) {
      // Bound both the HTTP request and the wait, including a reader that
      // ignores its transport timeout. A late response cannot open the gate.
      const remaining = Math.max(1, timeoutMs - (Date.now() - started));
      const requestBudget = Math.min(requestTimeoutMs, remaining);
      let setup: EnvironmentSetup | undefined;
      try {
        setup = await Promise.race([
          read(requestBudget),
          new Promise<undefined>(resolve => { requestTimer = setTimeout(resolve, requestBudget); }),
          deadline,
        ]);
      } finally {
        clearTimeout(requestTimer);
      }
      if (expired) break;
      if (!setup) throw new Error(`Environment setup request did not complete within ${requestBudget} ms`);
      latest = setup;
      if (["ready", "failed", "disabled"].includes(setup.state)) return setup;
      await Promise.race([
        new Promise<void>((resolve) => { pollTimer = setTimeout(resolve, 5_000); }),
        deadline,
      ]);
    }
    return latest;
  } finally {
    clearTimeout(requestTimer);
    clearTimeout(deadlineTimer);
    clearTimeout(pollTimer);
  }
}
