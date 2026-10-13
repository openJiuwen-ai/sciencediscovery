// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

export interface ShutdownRun { id: string; status: string }
export interface ShutdownExecution { id: string; state: string }
export interface ShutdownTimer { id: string; state: string }
export interface ShutdownAgent { agentId: string; stopped: boolean }

export interface SessionActivity {
  agents: ShutdownAgent[];
  executions: ShutdownExecution[];
  timers: ShutdownTimer[];
}

export interface SessionSnapshot<R extends ShutdownRun> {
  runs: R[];
  activity: SessionActivity;
}

export interface SessionShutdownAdapter<R extends ShutdownRun> {
  stop(timeoutMs: number): Promise<void>;
  snapshot(timeoutMs: number): Promise<SessionSnapshot<R>>;
  cancelRun(id: string, timeoutMs: number): Promise<void>;
  cancelExecution(id: string, timeoutMs: number): Promise<void>;
  cancelTimer(id: string, timeoutMs: number): Promise<void>;
}

export interface SessionShutdownResult<R extends ShutdownRun> {
  status: "stopped" | "cleanup_failed" | "unverified";
  runs: R[] | null;
  activeRuns: Array<{ id: string; status: string }>;
  activeExecutions: Array<{ id: string; state: string }>;
  pendingTimers: string[];
  wakeGatesClosed: boolean | null;
  errors: string[];
}

const activeRun = (run: ShutdownRun) => ["blocked", "queued", "running"].includes(run.status);
const activeExecution = (execution: ShutdownExecution) => ["queued", "running", "unknown"].includes(execution.state);
const pendingTimer = (timer: ShutdownTimer) => timer.state === "pending";

function summarize<R extends ShutdownRun>(
  status: SessionShutdownResult<R>["status"],
  snapshot: SessionSnapshot<R> | undefined,
  errors: string[],
): SessionShutdownResult<R> {
  return {
    status,
    runs: snapshot?.runs ?? null,
    activeRuns: snapshot?.runs.filter(activeRun).map(({ id, status }) => ({ id, status })) ?? [],
    activeExecutions: snapshot?.activity.executions.filter(activeExecution).map(({ id, state }) => ({ id, state })) ?? [],
    pendingTimers: snapshot?.activity.timers.filter(pendingTimer).map(({ id }) => id) ?? [],
    wakeGatesClosed: snapshot ? snapshot.activity.agents.length > 0 && snapshot.activity.agents.every((agent) => agent.stopped) : null,
    errors,
  };
}

/** Stop automatic wake admission, cancel accepted work, then verify fresh Session snapshots within one deadline. */
export async function stopAndVerifySession<R extends ShutdownRun>(
  adapter: SessionShutdownAdapter<R>,
  options: { timeoutMs?: number; quietMs?: number; pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<SessionShutdownResult<R>> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeoutMs ?? 45_000);
  const quietMs = options.quietMs ?? 1_000;
  const pollMs = options.pollMs ?? 250;
  const errors: string[] = [];
  const attemptedRuns = new Set<string>();
  const attemptedExecutions = new Set<string>();
  const attemptedTimers = new Set<string>();
  let latest: SessionSnapshot<R> | undefined;
  let lastReadFailed = false;
  let quietSince: number | undefined;

  const remaining = () => Math.max(1, deadline - now());
  const record = (operation: string, error: unknown) => {
    if (errors.length < 20) errors.push(`${operation}: ${error instanceof Error ? error.message : String(error)}`);
  };
  const stop = async () => {
    if (now() >= deadline) return;
    try { await adapter.stop(remaining()); } catch (error) { record("stop", error); }
  };
  await stop();
  while (now() <= deadline) {
    let snapshot: SessionSnapshot<R>;
    try {
      snapshot = await adapter.snapshot(remaining());
      latest = snapshot;
      lastReadFailed = false;
    } catch (error) {
      record("snapshot", error);
      lastReadFailed = true;
      quietSince = undefined;
      await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
      continue;
    }

    const runs = snapshot.runs.filter(activeRun);
    const executions = snapshot.activity.executions.filter(activeExecution);
    const timers = snapshot.activity.timers.filter(pendingTimer);
    const gatesClosed = snapshot.activity.agents.length > 0 && snapshot.activity.agents.every((agent) => agent.stopped);
    if (!gatesClosed) await stop();
    for (const run of runs) {
      if (attemptedRuns.has(run.id)) continue;
      if (now() >= deadline) break;
      try { await adapter.cancelRun(run.id, remaining()); attemptedRuns.add(run.id); }
      catch (error) { record(`cancel run ${run.id}`, error); }
    }
    for (const execution of executions) {
      if (attemptedExecutions.has(execution.id)) continue;
      if (now() >= deadline) break;
      try { await adapter.cancelExecution(execution.id, remaining()); attemptedExecutions.add(execution.id); }
      catch (error) { record(`cancel execution ${execution.id}`, error); }
    }
    for (const timer of timers) {
      if (attemptedTimers.has(timer.id)) continue;
      if (now() >= deadline) break;
      try { await adapter.cancelTimer(timer.id, remaining()); attemptedTimers.add(timer.id); }
      catch (error) { record(`cancel timer ${timer.id}`, error); }
    }

    if (gatesClosed && !runs.length && !executions.length && !timers.length) {
      quietSince ??= now();
      if (now() - quietSince >= quietMs) return summarize("stopped", snapshot, errors);
    } else {
      quietSince = undefined;
    }
    await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
  }
  return summarize(lastReadFailed || !latest ? "unverified" : "cleanup_failed", latest, errors);
}
