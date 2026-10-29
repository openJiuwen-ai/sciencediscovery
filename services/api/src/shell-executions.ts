// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { VersionStore, type AgentStateRef } from "@sciencediscovery/cas";
import type { RunnerClient } from "@sciencediscovery/executor";
import { shortErrorMessage, type OperationalLogger } from "@sciencediscovery/operational-logging";
import type { AgentShellExecution, ExecutionOwner, ManagedExecution, ShellExecutionResult } from "@sciencediscovery/schema";
import type { AgentNotifications } from "./agent-notifications.js";
import { apiLog } from "./logging.js";
import { portableShellResult } from "./research-shell-result.js";

type Record = Omit<AgentShellExecution, "result"> & { resultRef?: AgentStateRef; historical?: boolean };
type RecordExecution = (id: string, dispatch: RunnerClient["executeShell"], status: () => "succeeded" | "failed" | "cancelled") => Promise<ShellExecutionResult>;
type RunnerResolver = (runnerId: string) => RunnerClient;
const terminal = (state: ManagedExecution["state"]) => state !== "queued" && state !== "running";
const MAX_CONSECUTIVE_OBSERVATION_FAILURES = 5;
const MAX_OBSERVATION_RETRY_DELAY_MS = 5_000;
const RUNNER_REQUEST_TIMEOUT_MS = 10_000;
class RecordedRunnerFailure extends Error {}
type ObservationFailure = { cause?: unknown; code?: unknown; message?: unknown; name?: unknown; statusCode?: unknown };
const observationFailureChain = (error: unknown): ObservationFailure[] => {
  const chain: ObservationFailure[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current) && chain.length < 8) {
    seen.add(current);
    const failure = current as ObservationFailure;
    chain.push(failure);
    current = failure.cause;
  }
  return chain;
};
const observationHttpStatus = (chain: ObservationFailure[]): number | undefined => {
  for (const failure of chain) {
    if (typeof failure.statusCode === "number") return failure.statusCode;
    const match = typeof failure.message === "string"
      ? /Runner request failed \((\d{3})\)/i.exec(failure.message) : null;
    if (match) return Number(match[1]);
  }
  return undefined;
};
const retryableObservationFailure = (error: unknown): boolean => {
  const chain = observationFailureChain(error);
  const status = observationHttpStatus(chain);
  if (status !== undefined) return status === 502 || status === 503 || status === 504;
  return chain.some((failure) =>
    failure.name === "TimeoutError" || failure.name === "AbortError"
    || (typeof failure.message === "string" && /fetch failed|operation was aborted|Remote runner is not connected/i.test(failure.message))
    || (typeof failure.code === "string" && /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|UND_ERR_[A-Z0-9_]+)$/i.test(failure.code)));
};
const errorDetail = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const chain = observationFailureChain(error);
  const code = chain.map((failure) => failure.code).find((value): value is string => typeof value === "string");
  if (code) return `${error.message} (${code})`;
  const status = observationHttpStatus(chain);
  return status !== undefined && !error.message.includes(String(status)) ? `${error.message} (HTTP ${status})` : error.message;
};
/** Log fields naming what actually failed: `fetch failed` alone does not say whether a socket, a gateway or the Runner did. */
const failureFields = (error: unknown) => {
  const chain = observationFailureChain(error);
  const causes = chain.slice(1).flatMap((failure) => typeof failure.message === "string" && failure.message ? [failure.message] : []);
  const code = chain.map((failure) => failure.code).find((value): value is string => typeof value === "string");
  const status = observationHttpStatus(chain);
  return {
    errorMessage: shortErrorMessage(error),
    ...(causes.length ? { errorCause: shortErrorMessage(causes.join(": ")) } : {}),
    ...(code ? { errorCode: code } : {}),
    ...(status !== undefined ? { httpStatus: status } : {}),
  };
};
const correlation = (execution: Record) => ({
  executionId: execution.id, runnerId: execution.runnerId, sessionId: execution.sessionId, agentId: execution.agentId,
});
const ownerOf = (execution: Record): ExecutionOwner => ({ sessionId: execution.sessionId, agentId: execution.agentId });
const assertOwner = (execution: Record, value: ManagedExecution) => {
  if (value.id !== execution.id || value.sessionId !== execution.sessionId || value.agentId !== execution.agentId) {
    throw new Error("Runner Execution identity mismatch");
  }
};
/** The API lost track of the outcome; the Runner that owns this Execution ID may still know it. */
const reconcilable = (execution: Record) => execution.state === "unknown" && execution.provenance === "unconfirmed";

/** Tracks accepted work independently of an Agent turn. It never replays commands. */
export class ShellExecutions {
  private readonly active = new Map<string, Promise<void>>();
  private readonly reconciling = new Map<string, Promise<void>>();
  private runnerConnection?: (runnerId: string) => string;

  constructor(private readonly db: DatabaseSync, private readonly versions: VersionStore,
    private readonly notifications: AgentNotifications, private readonly pollMs = 200,
    private readonly waitForPoll: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly log: Pick<OperationalLogger, "info" | "warn"> = apiLog) {
    db.exec("CREATE TABLE IF NOT EXISTS shell_executions (id TEXT PRIMARY KEY, session TEXT NOT NULL, agent TEXT NOT NULL, record TEXT NOT NULL)");
    for (const row of db.prepare("SELECT record FROM shell_executions").all()) {
      const execution = JSON.parse(String(row.record)) as Record;
      if (terminal(execution.state)) continue;
      this.log.warn("shell_execution_orphaned", { ...correlation(execution), state: execution.state, accepted: execution.accepted });
      this.finish(execution, {
        state: "unknown", provenance: "unconfirmed",
        error: "API restarted before finalization; execution_status reconciles it with the Runner. The command was not replayed.",
      });
    }
  }

  /** Names the connection each Runner request went through, so a lost observation is not read as a failed job. */
  describeRunnerConnections(describe: (runnerId: string) => string): void {
    this.runnerConnection = describe;
  }

  private connection(runnerId: string): { runnerConnection?: string } {
    if (!this.runnerConnection) return {};
    try { return { runnerConnection: this.runnerConnection(runnerId) }; }
    catch { return { runnerConnection: "unavailable" }; }
  }

  private save(execution: Record): void {
    this.db.prepare("INSERT INTO shell_executions VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record")
      .run(execution.id, execution.sessionId, execution.agentId, JSON.stringify(execution));
  }

  private record(id: string, owner: ExecutionOwner): Record {
    const row = this.db.prepare("SELECT record FROM shell_executions WHERE id = ? AND session = ? AND agent = ?")
      .get(id, owner.sessionId, owner.agentId);
    if (!row) throw new Error("Execution not found for this Agent");
    return JSON.parse(String(row.record)) as Record;
  }

  snapshot(sessionId: string, agentId?: string): Record[] {
    const where = agentId === undefined ? "session = ?" : "session = ? AND agent = ?";
    const args = agentId === undefined ? [sessionId] : [sessionId, agentId];
    return this.db.prepare(`SELECT record FROM shell_executions WHERE ${where} ORDER BY rowid`).all(...args)
      .map((row) => JSON.parse(String(row.record)) as Record);
  }

  list(owner: ExecutionOwner): AgentShellExecution[] {
    return this.snapshot(owner.sessionId).filter((item) => item.agentId === owner.agentId).map(({ resultRef: _, historical: _historical, ...item }) => item);
  }

  /** The catalog entry alone: state and timestamps without reading the result payload. */
  find(id: string, owner: ExecutionOwner): AgentShellExecution {
    const { resultRef: _, historical: _historical, ...execution } = this.record(id, owner);
    return execution;
  }

  async get(id: string, owner: ExecutionOwner): Promise<AgentShellExecution> {
    const { resultRef, historical: _historical, ...execution } = this.record(id, owner);
    if (!resultRef) return execution;
    const result = JSON.parse((await this.versions.readState(resultRef)).toString()) as ShellExecutionResult;
    if (execution.runnerId === "local") return { ...execution, result };
    // Runner-owned objects are external evidence. Exposing them as local
    // ObjectRefs makes Agent turn closure validation read absent API blobs.
    // Convert on read so results persisted by older APIs are safe to inspect too.
    const { workspaceSnapshot, workspaceVersion, ...output } = result;
    const scoped = ({ digest, ...ref }: AgentStateRef) => ({ ...ref, runnerId: execution.runnerId, objectId: digest });
    return { ...execution, result: { ...output,
      ...(workspaceSnapshot ? { workspaceSnapshot: scoped(workspaceSnapshot) } : {}),
      ...(workspaceVersion ? { workspaceVersion: scoped(workspaceVersion) } : {}),
    } };
  }

  async restoreHistorical(source: AgentShellExecution): Promise<void> {
    const { result, runnerVersionId: _version, ...execution } = source;
    // Runner workspace receipts address another installation, not this one.
    const output = result ? portableShellResult(result) : undefined;
    const resultRef = result ? await this.versions.put("agent-state", JSON.stringify(output), "application/json") : undefined;
    this.save({ ...execution, historical: true, resultRef,
      state: terminal(source.state) && source.state !== "unknown" ? source.state : "cancelled",
      finishedAt: source.finishedAt ?? new Date().toISOString(),
    });
  }

  /** Return only after the Runner acknowledges acceptance (or an explicit unknown outcome). */
  async start(owner: ExecutionOwner, identity: { runnerId: string; workspaceId: string; turnId: string },
    runner: () => RunnerClient, recordExecution: RecordExecution): Promise<AgentShellExecution> {
    const execution: Record = { ...owner, ...identity, id: randomUUID(), state: "queued",
      queuedAt: new Date().toISOString(), accepted: false, provenance: "pending" };
    this.save(execution); // intent precedes the only submission attempt
    let acknowledge!: () => void;
    const accepted = new Promise<void>((resolve) => { acknowledge = resolve; });
    let observed: ManagedExecution | undefined;
    // Which step lost the outcome: the submission response, an observation
    // of accepted work, or finalization after the Runner reported an end.
    let stage: "submission" | "observation" | "finalization" = "submission";
    const work = Promise.resolve().then(async () => {
      try {
        const result = await recordExecution(execution.id, async (request) => {
          observed = await runner().startShellExecution(request, AbortSignal.timeout(RUNNER_REQUEST_TIMEOUT_MS));
          assertOwner(execution, observed);
          execution.accepted = true;
          this.save(execution);
          acknowledge();
          stage = "observation";
          observed = await this.follow(execution, runner, observed, (value) => { observed = value; });
          stage = "finalization";
          if (!observed.result && (observed.state === "failed" || observed.state === "cancelled")
            && (observed.version || !observed.startedAt)) {
            throw new RecordedRunnerFailure(observed.error ?? `Execution ${observed.state} before producing a result`);
          }
          if (!observed.result || !observed.version || (!request.explicitHandoff && !observed.result.workspaceSnapshot)) {
            throw new Error(observed.error ?? "Runner ended without a committed result; inspect its state before retrying");
          }
          // The envelope receipt is authoritative, including older Runners
          // that do not duplicate it inside the result payload.
          return { ...observed.result, workspaceVersion: observed.version };
        }, () => observed?.state === "cancelled" ? "cancelled" : observed?.state === "completed" ? "succeeded" : "failed");
        execution.resultRef = await this.versions.put("agent-state", JSON.stringify(result), "application/json");
        execution.runnerVersionId = observed!.version!.digest;
        this.finish(execution, { state: observed!.state, provenance: "committed" });
      } catch (error) {
        // A lost submit response or failed provenance does not prove the command did not run.
        const recorded = error instanceof RecordedRunnerFailure;
        if (observed?.version) execution.runnerVersionId = observed.version.digest;
        if (!recorded) {
          this.log.warn("shell_execution_unconfirmed", { ...correlation(execution), accepted: execution.accepted, stage,
            ...failureFields(error), ...this.connection(execution.runnerId) });
        }
        this.finish(execution, { state: recorded ? observed!.state : "unknown", provenance: recorded ? "committed" : "unconfirmed",
          error: error instanceof Error ? errorDetail(error) : "Execution finalization failed" });
      } finally { acknowledge(); }
    }).catch(() => {
      // Storage failures must not become an unhandled rejection or a successful completion.
      acknowledge();
    }).finally(() => this.active.delete(execution.id));
    this.active.set(execution.id, work);
    await accepted;
    return this.get(execution.id, owner);
  }

  /**
   * Query the same Execution ID until the Runner reports a terminal state.
   * A retryable failure only delays the next query and any answer resets the
   * count; MAX_CONSECUTIVE_OBSERVATION_FAILURES in a row ends the observation,
   * never the command, and is never answered by submitting it again.
   */
  private async follow(execution: Record, runner: () => RunnerClient, first: ManagedExecution,
    seen: (value: ManagedExecution) => void = () => undefined): Promise<ManagedExecution> {
    let observed = first;
    let failures = 0;
    let delayMs = this.pollMs;
    while (true) {
      assertOwner(execution, observed);
      seen(observed);
      // When it started, on this machine's clock. The Runner reports its
      // own `startedAt`, and a machine whose clock nobody disciplines can
      // be minutes off — copying it here would file the start before the
      // queue time and scramble every timeline built from these records.
      if (observed.startedAt && !execution.startedAt) execution.startedAt = new Date().toISOString();
      // Runner termination is not API completion until provenance has committed.
      execution.state = observed.state === "queued" ? "queued" : "running";
      this.save(execution);
      if (terminal(observed.state)) return observed;
      await this.waitForPoll(delayMs);
      try {
        observed = await runner().getShellExecution(execution.id, ownerOf(execution), AbortSignal.timeout(RUNNER_REQUEST_TIMEOUT_MS));
        if (failures) this.log.info("shell_execution_observation_recovered", { ...correlation(execution), consecutiveFailures: failures });
        failures = 0;
        delayMs = this.pollMs;
      } catch (error) {
        const retryable = retryableObservationFailure(error);
        failures++;
        const exhausted = !retryable || failures >= MAX_CONSECUTIVE_OBSERVATION_FAILURES;
        // The command has already been accepted. A failed status read is
        // not a failed execution; query the same ID again, never submit it.
        delayMs = Math.min(this.pollMs * 2 ** (failures - 1), MAX_OBSERVATION_RETRY_DELAY_MS);
        this.log.warn("shell_execution_observation_failed", { ...correlation(execution), consecutiveFailures: failures,
          maxConsecutiveFailures: MAX_CONSECUTIVE_OBSERVATION_FAILURES, retryable, ...(exhausted ? {} : { retryInMs: delayMs }),
          ...failureFields(error), ...this.connection(execution.runnerId) });
        if (!retryable) throw error;
        if (exhausted) {
          throw new Error(`Runner status remained unavailable after ${failures} consecutive attempts: ${errorDetail(error)}`, { cause: error });
        }
      }
    }
  }

  /**
   * Ask the Runner for its record of an execution the API could not confirm.
   * Only the same Execution ID is queried: a committed Runner outcome is
   * adopted, a live one is followed again, and anything else stays unknown.
   */
  private async reconcile(id: string, owner: ExecutionOwner, runner: RunnerResolver, signal?: AbortSignal): Promise<void> {
    const execution = this.record(id, owner);
    if (!reconcilable(execution) || this.active.has(id)) return;
    const timeout = AbortSignal.timeout(RUNNER_REQUEST_TIMEOUT_MS);
    let observed: ManagedExecution;
    try {
      observed = await runner(execution.runnerId).getShellExecution(id, ownerOf(execution), signal ? AbortSignal.any([signal, timeout]) : timeout);
      assertOwner(execution, observed);
    } catch (error) {
      // Still unreachable or not recognized: keep the uncertainty, try again on the next inspection.
      this.log.warn("shell_execution_reconcile_failed", { ...correlation(execution), ...failureFields(error), ...this.connection(execution.runnerId) });
      return;
    }
    if (!reconcilable(this.record(id, owner)) || this.active.has(id)) return;
    execution.accepted = true; // the Runner holds this ID, even if its submission response was lost
    if (terminal(observed.state)) {
      await this.settle(execution, observed);
    } else {
      // Still queued or running: the earlier notice reported an outcome that
      // has not happened, so withdraw it and let the real end notify again.
      execution.provenance = "pending";
      delete execution.finishedAt;
      delete execution.error;
      this.notifications.reopenExecution(execution, id);
      const work = this.follow(execution, () => runner(execution.runnerId), observed)
        .then((final) => this.settle(execution, final))
        .catch((error: unknown) => {
          this.log.warn("shell_execution_unconfirmed", { ...correlation(execution), accepted: true, stage: "observation",
            ...failureFields(error), ...this.connection(execution.runnerId) });
          this.finish(execution, { state: "unknown", provenance: "unconfirmed", error: errorDetail(error) });
        })
        .catch(() => undefined)
        .finally(() => this.active.delete(id));
      this.active.set(id, work);
    }
    const reconciled = this.record(id, owner);
    this.log.info("shell_execution_reconciled", { ...correlation(execution), runnerState: observed.state,
      state: reconciled.state, provenance: reconciled.provenance });
  }

  /** Adopt the Runner's terminal record under the same rules as an uninterrupted observation. */
  private async settle(execution: Record, observed: ManagedExecution): Promise<void> {
    if (observed.version) execution.runnerVersionId = observed.version.digest;
    if (observed.state !== "unknown" && observed.result && observed.version) {
      execution.resultRef = await this.versions.put("agent-state",
        JSON.stringify({ ...observed.result, workspaceVersion: observed.version }), "application/json");
      delete execution.error;
      this.finish(execution, { state: observed.state, provenance: "committed" });
      return;
    }
    if ((observed.state === "failed" || observed.state === "cancelled") && (observed.version || !observed.startedAt)) {
      this.finish(execution, { state: observed.state, provenance: "committed",
        error: observed.error ?? `Execution ${observed.state} before producing a result` });
      return;
    }
    // A Runner restart or an uncommitted end leaves the Runner itself without an outcome.
    const error = `Runner could not confirm the outcome: ${observed.error ?? "it ended without a committed result"}. The command was not replayed.`;
    if (execution.state === "unknown") this.save({ ...execution, error });
    else this.finish(execution, { state: "unknown", provenance: "unconfirmed", error });
  }

  private finish(execution: Record, patch: Pick<Record, "state" | "provenance"> & { error?: string }): void {
    const next = { ...execution, ...patch, finishedAt: new Date().toISOString() };
    this.db.exec("SAVEPOINT shell_completion");
    try {
      this.save(next);
      this.notifications.complete(execution, execution.id,
        `Execution ${execution.id} on Runner ${execution.runnerId}: ${next.state}; provenance ${next.provenance}. Use execution_status / execution_logs to inspect. Do not replay the command.`);
      this.db.exec("RELEASE shell_completion");
    } catch (error) {
      this.db.exec("ROLLBACK TO shell_completion; RELEASE shell_completion");
      throw error;
    }
  }

  /**
   * A wait deadline never reaches the process controller. With a Runner
   * resolver, an unconfirmed execution is first reconciled with its Runner.
   */
  async wait(id: string, owner: ExecutionOwner, waitMs: number, signal?: AbortSignal, runner?: RunnerResolver): Promise<AgentShellExecution> {
    const execution = this.record(id, owner);
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30_000) throw new Error("wait_ms must be between 0 and 30000");
    if (runner && reconcilable(execution) && !this.active.has(id)) {
      // Concurrent inspections share one Runner query instead of racing to adopt the same answer.
      let reconciliation = this.reconciling.get(id);
      if (!reconciliation) {
        reconciliation = this.reconcile(id, owner, runner, signal).catch((error: unknown) => {
          this.log.warn("shell_execution_reconcile_failed", { ...correlation(execution), ...failureFields(error) });
        }).finally(() => this.reconciling.delete(id));
        this.reconciling.set(id, reconciliation);
      }
      await reconciliation;
    }
    const work = this.active.get(id);
    if (work && waitMs > 0 && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, waitMs);
        signal?.addEventListener("abort", done, { once: true });
        void work.then(done);
      });
    }
    return this.get(id, owner);
  }

  async logs(id: string, owner: ExecutionOwner, runner: (id: string) => RunnerClient, cursor = 0) {
    const execution = this.record(id, owner);
    if (execution.historical) {
      const { result } = await this.get(id, owner);
      const chunks = ([{ stream: "stdout" as const, text: result?.stdout ?? "" }, { stream: "stderr" as const, text: result?.stderr ?? "" }])
        .map((chunk, index) => ({ ...chunk, cursor: index + 1 })).filter((chunk) => chunk.cursor > cursor && chunk.text);
      return { chunks, nextCursor: Math.max(cursor, 2), truncated: false, retentionTruncated: false };
    }
    return runner(execution.runnerId).shellExecutionLogs(id, owner, cursor, AbortSignal.timeout(RUNNER_REQUEST_TIMEOUT_MS));
  }

  async cancel(id: string, owner: ExecutionOwner, runner: (id: string) => RunnerClient): Promise<AgentShellExecution> {
    const execution = this.record(id, owner);
    // Unknown after restart may still be running remotely; cancellation is safe, resubmission is not.
    if (!execution.historical && (!terminal(execution.state) || execution.state === "unknown")) {
      await runner(execution.runnerId).cancelShellExecution(id, owner, AbortSignal.timeout(RUNNER_REQUEST_TIMEOUT_MS));
    }
    return this.get(id, owner);
  }
}
