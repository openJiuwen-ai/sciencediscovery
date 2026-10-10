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

const terminal = new Set(["cancelled", "completed", "failed", "interrupted"]);

/** Stateful quiescence check shared by real E2Es and its deterministic unit tests. */
export class RunChainSettler<T extends RunChainRun> {
  private quietFingerprint?: string;
  private quietSince = 0;

  observe(
    runs: readonly T[],
    executions: readonly RunChainExecution[],
    rootRunId: string,
    now: number,
    quietMs: number,
  ): { run: T; runs: T[] } | undefined {
    const root = runs.find((run) => run.id === rootRunId);
    if (!root) return undefined;
    const rootOrder = root.queueOrder ?? 0;
    const chain = runs.filter((run) => run.id === rootRunId || (run.automaticWake
      && run.notificationDelivery?.agentId === "main" && (run.queueOrder ?? 0) > rootOrder))
      .toSorted((left, right) => (left.queueOrder ?? 0) - (right.queueOrder ?? 0));
    const activeRun = chain.some((run) => !terminal.has(run.status));
    const mainExecutions = executions.filter((execution) => execution.agentId === "main");
    const activeExecution = mainExecutions.some((execution) => execution.state === "queued" || execution.state === "running");
    const fingerprint = JSON.stringify({ executions: mainExecutions.map(({ id, state }) => [id, state]),
      runs: chain.map(({ id, status }) => [id, status]) });
    if (activeRun || activeExecution) {
      this.quietFingerprint = undefined;
      this.quietSince = 0;
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
