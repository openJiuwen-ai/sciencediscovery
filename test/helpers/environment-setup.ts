// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

interface EnvironmentSetupComponent {
  error?: string | null;
}

export interface EnvironmentSetup {
  message: string;
  state: string;
  /** Credential-redacted provisioning transcript, when the setup failed. */
  error?: string | null;
  components?: {
    /** Conda-compatible Python base and the named environments derived from it. */
    conda?: EnvironmentSetupComponent;
    /** Standalone managed or configured micromamba executable. */
    micromamba?: EnvironmentSetupComponent;
  };
}

/**
 * Longest setup-error transcript kept in a BLOCKED reason (#1239). Same bound
 * as the provisioning transcript kept for `check_runner` (#1108).
 */
export const ENVIRONMENT_SETUP_ERROR_LIMIT = 1200;

/**
 * Render a setup as the `state: message` text the journeys already print,
 * plus the failure transcript when the API carried one. A setup without an
 * `error` renders exactly as before. A `components.conda.error` that differs
 * from `setup.error` is appended (labelled) instead of silently replacing it,
 * so the next occurrence can be attributed to an external channel/network
 * problem or to a repository defect. That branch is defensive: the store's
 * `failSetup` writes the same redacted string to both fields, so in every
 * snapshot the store produces today they are identical or the component one
 * is null — the branch only matters if a future store change reports a
 * distinct per-component transcript. Pass/fail semantics are unchanged: this
 * only changes what the BLOCKED reason says.
 */
export function formatEnvironmentSetupBlockedReason(setup: EnvironmentSetup): string {
  const base = `${setup.state}: ${setup.message}`;
  const bounded = (transcript: string): string => (
    transcript.length <= ENVIRONMENT_SETUP_ERROR_LIMIT
      ? transcript
      : `${transcript.slice(0, ENVIRONMENT_SETUP_ERROR_LIMIT)}… (transcript truncated; see the Runner log for the rest)`
  );
  const parts = [base];
  const error = setup.error?.trim() ?? "";
  if (error.length > 0) parts.push(bounded(error));
  const condaError = setup.components?.conda?.error?.trim() ?? "";
  if (condaError.length > 0 && condaError !== error) parts.push(`conda: ${bounded(condaError)}`);
  return parts.join("\n");
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
