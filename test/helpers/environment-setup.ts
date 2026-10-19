// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

interface EnvironmentSetup {
  message: string;
  state: string;
}

/** Observe the runner's existing installation; the reader must not start another one. */
export async function waitForEnvironmentSetup(
  read: () => Promise<EnvironmentSetup>,
): Promise<EnvironmentSetup> {
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
    }, 180_000);
  });

  try {
    while (!expired) {
      // The deadline also bounds a slow GET; a late ready response cannot open the gate.
      const setup = await Promise.race([read(), deadline]);
      if (expired || !setup) break;
      latest = setup;
      if (setup.state === "ready" || setup.state === "failed") return setup;
      await Promise.race([
        new Promise<void>((resolve) => { pollTimer = setTimeout(resolve, 5_000); }),
        deadline,
      ]);
    }
    return latest;
  } finally {
    clearTimeout(deadlineTimer);
    clearTimeout(pollTimer);
  }
}
