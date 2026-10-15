// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

export interface RunChainRun {
  automaticWake?: boolean;
  id: string;
  notificationDelivery?: { agentId: string };
  queueOrder?: number;
  status: string;
}

export interface RunChainExecution {
  agentId?: string;
  id?: string;
  state?: string;
}

export interface RunChainTimer {
  agentId?: string;
  id?: string;
  state?: string;
}

const terminal = new Set(["cancelled", "completed", "failed", "interrupted"]);

/** Delivery candidates exclude child Runs, even if a child is the newest Session Run. */
export function mainRunChain<T extends RunChainRun>(runs: readonly T[], rootRunId: string): T[] {
  const root = runs.find((run) => run.id === rootRunId);
  if (!root) return [];
  const rootOrder = root.queueOrder ?? 0;
  return runs.filter((run) => run.id === rootRunId || (run.automaticWake
    && run.notificationDelivery?.agentId === "main" && (run.queueOrder ?? 0) > rootOrder))
    .toSorted((left, right) => (left.queueOrder ?? 0) - (right.queueOrder ?? 0));
}

/** Stateful quiescence check shared by real E2Es and its deterministic unit tests. */
export class RunChainSettler<T extends RunChainRun> {
  private quietFingerprint?: string;
  private quietSince = 0;

  resetQuiet(): void {
    this.quietFingerprint = undefined;
    this.quietSince = 0;
  }

  observe(
    runs: readonly T[],
    executions: readonly RunChainExecution[],
    rootRunId: string,
    now: number,
    quietMs: number,
    timers: readonly RunChainTimer[] = [],
  ): { run: T; runs: T[] } | undefined {
    const chain = mainRunChain(runs, rootRunId);
    if (!chain.length) return undefined;
    // Any active Run in these isolated Sessions can delay admission of the next main-Agent wake.
    const activeRun = runs.some((run) => !terminal.has(run.status));
    const mainExecutions = executions.filter((execution) => execution.agentId === "main");
    const activeExecution = mainExecutions.some((execution) => execution.state === "queued" || execution.state === "running");
    const mainTimers = timers.filter((timer) => timer.agentId === "main");
    // Fired timers remain in the store; their state change restarts the quiet window without blocking forever.
    const activeTimer = mainTimers.some((timer) => timer.state === "pending");
    const fingerprint = JSON.stringify({ executions: mainExecutions.map(({ id, state }) => [id, state]),
      runs: chain.map(({ id, status }) => [id, status]), timers: mainTimers.map(({ id, state }) => [id, state]) });
    if (activeRun || activeExecution || activeTimer) {
      this.resetQuiet();
      return undefined;
    }
    if (this.quietFingerprint !== fingerprint) {
      this.quietFingerprint = fingerprint;
      this.quietSince = now;
    }
    if (now - this.quietSince < quietMs) return undefined;
    const last = chain.at(-1);
    return last && terminal.has(last.status) ? { run: last, runs: chain } : undefined;
  }
}
