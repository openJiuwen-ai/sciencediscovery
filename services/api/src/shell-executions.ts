// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { VersionStore, type AgentStateRef } from "@sciencediscovery/cas";
import type { ShellExecutionContext } from "@sciencediscovery/provenance";
import type { RunnerClient } from "@sciencediscovery/executor";
import type { AgentShellExecution, ExecutionOwner, ManagedExecution, ShellExecutionResult } from "@sciencediscovery/schema";
import type { AgentNotifications } from "./agent-notifications.js";

type Record = Omit<AgentShellExecution, "result"> & {
  resultRef?: AgentStateRef;
  candidateResultRef?: AgentStateRef;
  candidateFailure?: AuthoritativeFailure;
  recoveryContext?: ShellExecutionContext;
  expectedRunnerInstanceId?: string;
  catalogRevision?: number;
  submissionDigest?: string;
};
type AuthoritativeFailure = { state: "failed" | "cancelled"; finishedAt: string; startedAt?: string; error?: string };
export interface ExecutionRecoveryHandlers {
  /** Must re-check current Session/Agent/Runner authorization on every call. */
  runner(execution: AgentShellExecution): RunnerClient;
  finalize(context: ShellExecutionContext, result: ShellExecutionResult, runner: RunnerClient,
    status: "succeeded" | "failed" | "cancelled"): Promise<ShellExecutionResult>;
  finalizeFailure?(context: ShellExecutionContext, failure: AuthoritativeFailure): Promise<void>;
}
const statusOf = (state: ManagedExecution["state"]) => state === "completed" ? "succeeded" : state === "cancelled" ? "cancelled" : "failed";
const publicRecord = ({ recoveryContext: _, expectedRunnerInstanceId: __, catalogRevision: ___, submissionDigest: ______, candidateResultRef: ____, candidateFailure: _____, ...record }: Record) => record;
const stableDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)).digest("hex");
class RecoveryError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
type RecordExecution = (id: string, dispatch: RunnerClient["executeShell"], status: () => "succeeded" | "failed" | "cancelled") => Promise<ShellExecutionResult>;
const terminal = (state: ManagedExecution["state"]) => state !== "queued" && state !== "running";
const MAX_CONSECUTIVE_OBSERVATION_FAILURES = 5;
const MAX_OBSERVATION_RETRY_DELAY_MS = 5_000;
// Fixed safe display text for the structured non-retryable conflict codes, used
// at the persistence boundary. Whatever the source of the error (a remote
// Runner body or a local finalizer), the raw message is never written into
// execution.error / lastError.message under these codes — only this fixed text.
// Written as an object literal type because the local `Record` type below
// shadows the global `Record<K, V>` utility here.
const RUNNER_CONFLICT_MESSAGES: Readonly<{
  RESULT_DIGEST_MISMATCH: string;
  EXECUTION_RESULT_CONFLICT: string;
}> = {
  RESULT_DIGEST_MISMATCH: "Runner execution result digest mismatch",
  EXECUTION_RESULT_CONFLICT: "Runner execution result conflict",
};
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

/** Tracks accepted work independently of an Agent turn. It never replays commands. */
export class ShellExecutions {
  private readonly active = new Map<string, Promise<void>>();
  private readonly leaseOwner = randomUUID();
  private recovery?: ExecutionRecoveryHandlers;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private scan?: Promise<void>;
  private recoveryWake = false;

  constructor(private readonly db: DatabaseSync, private readonly versions: VersionStore,
    private readonly notifications: AgentNotifications, private readonly pollMs = 200,
    private readonly waitForPoll: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
    db.exec(`CREATE TABLE IF NOT EXISTS shell_executions (id TEXT PRIMARY KEY, session TEXT NOT NULL, agent TEXT NOT NULL, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shell_execution_leases (id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);`);
    for (const row of db.prepare("SELECT record FROM shell_executions").all()) {
      const execution = JSON.parse(String(row.record)) as Record;
      if (!terminal(execution.state) && !this.db.prepare("SELECT 1 FROM shell_execution_leases WHERE id = ? AND expires > ?").get(execution.id, Date.now())) {
        execution.state = "unknown";
        execution.provenance = "unconfirmed";
        execution.error = "API restarted before finalization; recovering the original Runner execution. The command was not replayed.";
        execution.observation = { ...execution.observation, status: "stale", failureCount: 0 };
        delete execution.finishedAt;
        this.save(execution);
      }
    }
  }

  private save(execution: Record): void {
    const revision = execution.catalogRevision ?? 0;
    const next = { ...execution, catalogRevision: revision + 1 };
    const row = this.db.prepare("SELECT id FROM shell_executions WHERE id = ?").get(execution.id);
    if (!row) {
      this.db.prepare("INSERT INTO shell_executions VALUES (?, ?, ?, ?)")
        .run(execution.id, execution.sessionId, execution.agentId, JSON.stringify(next));
    } else {
      const changed = this.db.prepare("UPDATE shell_executions SET record = ? WHERE id = ? AND coalesce(json_extract(record, '$.catalogRevision'), 0) = ?")
        .run(JSON.stringify(next), execution.id, revision);
      if (!changed.changes) throw new RecoveryError("STALE_OBSERVER", "Execution changed while this observer was reading it");
    }
    execution.catalogRevision = next.catalogRevision;
  }

  private acquire(id: string): boolean {
    return Boolean(this.db.prepare(`INSERT INTO shell_execution_leases VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, expires=excluded.expires WHERE expires <= ?`)
      .run(id, this.leaseOwner, Date.now() + 30_000, Date.now()).changes);
  }

  private release(id: string): void {
    try { this.db.prepare("DELETE FROM shell_execution_leases WHERE id = ? AND owner = ?").run(id, this.leaseOwner); }
    catch { /* database may already be closed during API shutdown */ }
  }

  private heartbeat(id: string): ReturnType<typeof setInterval> {
    const timer = setInterval(() => {
      try { this.db.prepare("UPDATE shell_execution_leases SET expires = ? WHERE id = ? AND owner = ?")
        .run(Date.now() + 30_000, id, this.leaseOwner); } catch { /* shutdown/storage failure: never dispatch */ }
    }, 10_000);
    timer.unref();
    return timer;
  }

  /** Start only after the authenticated Runner resolver and finalizer are ready. */
  configureRecovery(handlers: ExecutionRecoveryHandlers): void {
    this.recovery = handlers;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => { void this.reconcilePending().catch(() => undefined); }, 1_000);
    this.timer.unref();
    void this.reconcilePending(undefined, true).catch(() => undefined);
  }

  close(): void { this.closed = true; if (this.timer) clearInterval(this.timer); }

  /** Bounded polling also detects reconnection, without recreating an execution. */
  async reconcilePending(runnerId?: string, force = false): Promise<void> {
    if (this.scan) {
      if (runnerId || force) this.recoveryWake = true;
      return this.scan;
    }
    const scan = (async () => {
      let target = runnerId;
      let refresh = force;
      do {
        this.recoveryWake = false;
        await this.scanPending(target, refresh);
        // Coalesce reconnect/auth-change events arriving during an older scan.
        target = undefined;
        refresh = true;
      } while (this.recoveryWake && !this.closed);
    })().finally(() => { if (this.scan === scan) this.scan = undefined; });
    this.scan = scan;
    return scan;
  }

  private async scanPending(runnerId?: string, force = false): Promise<void> {
    if (this.closed || !this.recovery) return;
    const rows = this.db.prepare(`SELECT record FROM shell_executions
      WHERE json_extract(record, '$.provenance') != 'committed' AND json_type(record, '$.recoveryContext') = 'object'
      AND (? IS NULL OR json_extract(record, '$.runnerId') = ?)
      AND (? OR coalesce(json_extract(record, '$.observation.lastError.retryable'), 1) != 0)
      AND (? OR coalesce(json_extract(record, '$.observation.nextRetryAt'), '') <= ?)
      ORDER BY coalesce(json_extract(record, '$.observation.nextRetryAt'), ''), rowid LIMIT 100`)
      .all(runnerId ?? null, runnerId ?? null, Number(force || Boolean(runnerId)), Number(force || Boolean(runnerId)), new Date().toISOString());
    const due = rows.map(row => JSON.parse(String(row.record)) as Record).filter(record => !this.active.has(record.id));
    for (let offset = 0; offset < Math.min(due.length, 100); offset += 4) {
      await Promise.all(due.slice(offset, offset + 4).map(record => this.reconcile(record.id, record).catch(() => undefined)));
    }
  }

  private assertObserved(execution: Record, value: ManagedExecution): void {
    if (value.id !== execution.id || value.sessionId !== execution.sessionId || value.agentId !== execution.agentId)
      throw new RecoveryError("EXECUTION_IDENTITY_MISMATCH", "Runner Execution identity mismatch");
    if (execution.expectedRunnerInstanceId && value.receipt?.runnerInstanceId !== execution.expectedRunnerInstanceId)
      throw new RecoveryError("ORIGINAL_RUNNER_MISMATCH", "The original Runner execution ledger is unavailable or was replaced");
    if (execution.receipt && (!value.receipt || value.receipt.requestDigest !== execution.receipt.requestDigest))
      throw new RecoveryError("EXECUTION_ID_CONFLICT", "Runner Execution request digest changed");
    if (execution.candidateFailure && (value.state !== execution.candidateFailure.state || value.result))
      throw new RecoveryError("EXECUTION_ID_CONFLICT", "Runner changed an already observed terminal failure");
    if (execution.candidateResultRef && (execution.runnerVersionId !== value.version?.digest
      || execution.evidence?.resultDigest !== value.evidence?.resultDigest))
      throw new RecoveryError("EXECUTION_ID_CONFLICT", "Runner changed an already observed immutable result");
    if (execution.receipt && value.receipt && value.receipt.revision < execution.receipt.revision)
      throw new RecoveryError("STALE_OBSERVER", "Runner returned an older execution revision");
  }

  private observed(execution: Record, value: ManagedExecution): void {
    this.assertObserved(execution, value);
    execution.accepted = true;
    execution.dispatchPhase = "accepted";
    if (value.receipt) { execution.receipt = value.receipt; execution.expectedRunnerInstanceId = value.receipt.runnerInstanceId; }
    if (value.evidence) execution.evidence = value.evidence;
    if (value.startedAt && !execution.startedAt) execution.startedAt = new Date().toISOString();
    execution.observation = { status: "fresh", lastObservedAt: new Date().toISOString(), lastRunnerState: value.state, failureCount: 0, nextRetryAt: new Date(Date.now() + 1_000).toISOString() };
    execution.state = value.state === "queued" ? "queued" : value.state === "unknown" ? "unknown" : "running";
    execution.finalization = "pending";
    execution.provenance = "pending";
    delete execution.error;
    delete execution.finishedAt;
    this.save(execution);
  }

  private assertTerminalEvidence(observed: ManagedExecution): void {
    if (!observed.receipt) return; // old Runner records remain readable, but cannot be restarted by recovery
    const evidence = observed.evidence;
    if (!evidence?.processTerminated || evidence.runnerInstanceId !== observed.receipt.runnerInstanceId
      || evidence.revision !== observed.receipt.revision)
      throw new RecoveryError("PROCESS_STATE_UNVERIFIABLE", "Runner has not supplied matching process termination evidence");
    if (observed.version && evidence.workspaceVersionDigest !== observed.version.digest)
      throw new RecoveryError("RESULT_NOT_COMMITTED", "Runner workspace receipt does not match its termination evidence");
    if (observed.result && !evidence.resultDigest)
      throw new RecoveryError("RESULT_NOT_COMMITTED", "Runner result has no immutable digest");
  }

  private async commitFailure(execution: Record, observed: ManagedExecution,
    finalizeFailure = this.recovery?.finalizeFailure): Promise<void> {
    if (execution.recoveryContext) {
      if (!finalizeFailure) throw new RecoveryError("PROVENANCE_COMMIT_FAILED", "Authoritative failure finalizer is unavailable");
      execution.candidateFailure ??= { state: observed.state as "failed" | "cancelled",
        finishedAt: observed.finishedAt ?? new Date().toISOString(),
        ...(observed.startedAt ? { startedAt: observed.startedAt } : {}), ...(observed.error ? { error: observed.error } : {}) };
      this.save(execution);
      await finalizeFailure(execution.recoveryContext, execution.candidateFailure);
    }
    this.finish(execution, { state: observed.state, provenance: "committed", error: observed.error });
  }

  private async existingResult(execution: Record, observed: ManagedExecution): Promise<ShellExecutionResult> {
    if (execution.candidateResultRef)
      return JSON.parse((await this.versions.readState(execution.candidateResultRef)).toString()) as ShellExecutionResult;
    const result = { ...observed.result!, workspaceVersion: observed.version! };
    // Pin before invoking any side-effecting finalizer. Runner clock conversion may
    // differ on later requests, but retries must consume these same immutable bytes.
    execution.runnerVersionId = observed.version!.digest;
    execution.candidateResultRef = await this.versions.put("agent-state", JSON.stringify(result), "application/json");
    this.save(execution);
    return result;
  }

  private unavailable(execution: Record, error: unknown, fallback = "OBSERVATION_UNAVAILABLE"): void {
    if (error instanceof RecoveryError && error.code === "STALE_OBSERVER") return;
    const httpStatus = observationHttpStatus(observationFailureChain(error));
    const authorization = error instanceof Error && /not allowed|may not run|may only run|Session.*(?:not found|archived)|not writable|not available to this Agent|Runner.*not.*allow/i.test(error.message);
    const explicitCode = (error as { code?: unknown } | undefined)?.code;
    const code = error instanceof RecoveryError ? error.code
      : explicitCode === "RESULT_DIGEST_MISMATCH" || explicitCode === "EXECUTION_RESULT_CONFLICT" ? explicitCode
      : authorization ? "AUTHORIZATION_REVOKED"
      : httpStatus === 401 || httpStatus === 403 ? "AUTHORIZATION_REVOKED"
      : httpStatus === 404 ? "EXECUTION_NOT_FOUND" : fallback;
    const retryable = !["AUTHORIZATION_REVOKED", "EXECUTION_NOT_FOUND", "ORIGINAL_RUNNER_MISMATCH",
      "EXECUTION_IDENTITY_MISMATCH", "EXECUTION_ID_CONFLICT", "RESULT_DIGEST_MISMATCH", "EXECUTION_RESULT_CONFLICT",
      "PROCESS_STATE_UNVERIFIABLE", "RECOVERY_CONTEXT_UNAVAILABLE"].includes(code)
      && (httpStatus === undefined || httpStatus >= 500);
    const failureCount = (execution.observation?.failureCount ?? 0) + 1;
    // Never retain arbitrary HTTP bodies, command arguments or authentication values.
    const transportCode = observationFailureChain(error).map(failure => failure.code)
      .find((value): value is string => typeof value === "string" && /^(?:E[A-Z0-9_]{1,30}|UND_ERR_[A-Z0-9_]+)$/.test(value));
    const exhausted = error instanceof Error ? /Runner status remained unavailable after (\d+) consecutive attempts/.exec(error.message) : null;
    const detail = error instanceof RecoveryError ? error.message
      : explicitCode === "RESULT_DIGEST_MISMATCH" || explicitCode === "EXECUTION_RESULT_CONFLICT"
        ? RUNNER_CONFLICT_MESSAGES[explicitCode]
      : httpStatus ? `Runner observation returned HTTP ${httpStatus}`
      : `${exhausted ? exhausted[0] : fallback === "PROVENANCE_COMMIT_FAILED"
        ? "Existing execution result could not be committed; retry uses the same result"
        : "Runner observation is unavailable; the original execution was not replayed"}${transportCode ? ` (${transportCode})` : ""}`;
    execution.error = detail;
    execution.state = "unknown";
    execution.provenance = "unconfirmed";
    execution.finalization = fallback === "PROVENANCE_COMMIT_FAILED" ? "failed" : "pending";
    delete execution.finishedAt;
    execution.observation = { ...execution.observation, status: "blocked", failureCount,
      ...(retryable ? { nextRetryAt: new Date(Date.now() + Math.min(1_000 * 2 ** Math.min(failureCount - 1, 6), 60_000)).toISOString() } : {}),
      lastError: { code, message: detail, retryable, ...(httpStatus ? { httpStatus } : {}) } };
    if (!retryable) delete execution.observation.nextRetryAt;
    this.save(execution);
  }

  /** Observation and existing-result finalization only. This method cannot submit. */
  async reconcile(id: string, owner: ExecutionOwner, handlers = this.recovery): Promise<AgentShellExecution> {
    let execution = this.record(id, owner);
    if (execution.provenance === "committed" || this.active.has(id) || !handlers || this.closed) return this.get(id, owner);
    if (!this.acquire(id)) return this.get(id, owner);
    const heartbeat = this.heartbeat(id);
    const work = Promise.resolve().then(async () => {
      execution = this.record(id, owner);
      try {
        if (!execution.recoveryContext || !execution.expectedRunnerInstanceId)
          throw new RecoveryError("RECOVERY_CONTEXT_UNAVAILABLE", "Original execution context or Runner identity is missing; inspect existing logs. A new run is not safe automatically.");
        if (execution.recoveryContext.executionId !== execution.id || execution.recoveryContext.sessionId !== execution.sessionId
          || execution.recoveryContext.agentId !== execution.agentId || execution.recoveryContext.runnerId !== execution.runnerId)
          throw new RecoveryError("EXECUTION_IDENTITY_MISMATCH", "Stored execution context does not match its original owner and Runner");
        execution.observation = { ...execution.observation, status: "reconciling", failureCount: execution.observation?.failureCount ?? 0 };
        this.save(execution);
        const client = handlers.runner(publicRecord(execution));
        const observed = await client.getShellExecution(id, owner, AbortSignal.timeout(10_000));
        handlers.runner(publicRecord(execution)); // permissions may change during the read
        this.observed(execution, observed);
        if (observed.state === "unknown") throw new RecoveryError("PROCESS_STATE_UNVERIFIABLE", "Runner cannot verify the original process state; do not start a replacement");
        if (!terminal(observed.state)) return;
        this.assertTerminalEvidence(observed);
        if (!observed.result && (observed.state === "failed" || observed.state === "cancelled") && (observed.version || !observed.startedAt)) {
          if (observed.version) execution.runnerVersionId = observed.version.digest;
          await this.commitFailure(execution, observed, handlers.finalizeFailure);
          return;
        }
        if (!observed.result || !observed.version || (!execution.recoveryContext.explicitHandoff && !observed.result.workspaceSnapshot))
          throw new RecoveryError("RESULT_NOT_COMMITTED", "Runner terminated without a committed result; recovery will not rerun it");
        const candidate = await this.existingResult(execution, observed);
        const guardedClient = new Proxy(client, { get(target, key) {
          const value = Reflect.get(target, key);
          if (typeof value !== "function") return value;
          return async (...args: unknown[]) => {
            handlers.runner(publicRecord(execution));
            const output: unknown = await value.apply(target, args);
            handlers.runner(publicRecord(execution));
            return output;
          };
        } });
        const result = await handlers.finalize(execution.recoveryContext, candidate, guardedClient, statusOf(observed.state));
        handlers.runner(publicRecord(execution));
        execution.resultRef = await this.versions.put("agent-state", JSON.stringify(result), "application/json");
        this.finish(execution, { state: observed.state, provenance: "committed" });
      } catch (error) { this.unavailable(execution, error, execution.observation?.lastRunnerState && terminal(execution.observation.lastRunnerState) ? "PROVENANCE_COMMIT_FAILED" : "OBSERVATION_UNAVAILABLE"); }
    }).catch(() => undefined).finally(() => { clearInterval(heartbeat); this.release(id); this.active.delete(id); });
    this.active.set(id, work);
    await work;
    return this.get(id, owner);
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
      .map((row) => publicRecord(JSON.parse(String(row.record)) as Record));
  }

  list(owner: ExecutionOwner): AgentShellExecution[] {
    return this.snapshot(owner.sessionId).filter((item) => item.agentId === owner.agentId).map(({ resultRef: _, ...item }) => item);
  }

  /** The catalog entry alone: state and timestamps without reading the result payload. */
  find(id: string, owner: ExecutionOwner): AgentShellExecution {
    const { resultRef: _, ...execution } = publicRecord(this.record(id, owner));
    return execution;
  }

  async get(id: string, owner: ExecutionOwner): Promise<AgentShellExecution> {
    const { resultRef, ...execution } = publicRecord(this.record(id, owner));
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

  /** Return only after the Runner acknowledges acceptance (or an explicit unknown outcome). */
  async start(owner: ExecutionOwner, identity: { runnerId: string; workspaceId: string; turnId: string },
    runner: () => RunnerClient, recordExecution: RecordExecution, context?: (id: string) => ShellExecutionContext, finalizeFailure?: ExecutionRecoveryHandlers["finalizeFailure"]): Promise<AgentShellExecution> {
    if (this.closed) throw new Error("Shell execution storage is closed");
    const execution: Record = { ...owner, ...identity, id: randomUUID(), state: "queued",
      queuedAt: new Date().toISOString(), accepted: false, provenance: "pending", dispatchPhase: "prepared", finalization: "pending" };
    if (context) {
      execution.recoveryContext = context(execution.id);
      if (execution.recoveryContext.toolCallId) {
        // A replay of one logical tool call has the same ID even after API restart.
        execution.id = `shell:${stableDigest({ ...owner, turnId: identity.turnId, toolCallId: execution.recoveryContext.toolCallId })}`;
        execution.recoveryContext.executionId = execution.id;
        const { id: _epochId, createdAt: _epochCreated, reason: _epochReason, memoryLostReason: _memoryReason,
          ...permissionScope } = execution.recoveryContext.permissionEpoch;
        execution.submissionDigest = stableDigest({ identity, context: { ...execution.recoveryContext, permissionEpoch: permissionScope } });
        const existing = this.db.prepare("SELECT record FROM shell_executions WHERE id = ?").get(execution.id);
        if (existing) {
          const original = JSON.parse(String(existing.record)) as Record;
          if (original.submissionDigest !== execution.submissionDigest || original.sessionId !== owner.sessionId || original.agentId !== owner.agentId)
            throw new RecoveryError("EXECUTION_ID_CONFLICT", "Logical submission identity was already used with a different request");
          return this.get(original.id, owner);
        }
      }
    }
    if (context) {
      const uncertain = this.snapshot(owner.sessionId).find(record => record.runnerId === identity.runnerId
        && record.workspaceId === identity.workspaceId && record.state === "unknown");
      if (uncertain?.id === execution.id && execution.submissionDigest) {
        const original = this.record(execution.id, owner);
        if (original.submissionDigest === execution.submissionDigest) return this.get(execution.id, owner);
        throw new RecoveryError("EXECUTION_ID_CONFLICT", "Logical submission identity was already used with a different request");
      }
      // Any unconfirmed outcome in this workspace blocks new work: it must be
      // inspected first and a replacement is never submitted automatically. When
      // the record also lacks a recovery context there is no auto-recovery path
      // at all, so the message explains that limit and how to proceed safely.
      // snapshot() strips recoveryContext via publicRecord, so read the full
      // record here to distinguish a recoverable unknown from a legacy one.
      if (uncertain) {
        const row = this.db.prepare("SELECT record FROM shell_executions WHERE id = ? AND session = ?").get(uncertain.id, owner.sessionId);
        const full = row ? JSON.parse(String(row.record)) as Record : undefined;
        const message = full?.recoveryContext
          ? `Execution ${uncertain.id} has an unconfirmed outcome. Inspect execution_status before starting more work in this workspace; no replacement was submitted.`
          : `Execution ${uncertain.id} has an unconfirmed outcome and no recovery context; it cannot be auto-recovered and keeps this workspace blocked. Inspect execution_status/execution_logs before continuing; no replacement was submitted. New work in a separate workspace is only safe when it shares no mutable resources or external side effects (such as the same external target or remote resource) with this unknown task — switching workspaces is not a generally safe way to re-run it.`;
        throw new RecoveryError("ORIGINAL_EXECUTION_UNCONFIRMED", message);
      }
    }
    try { this.save(execution); } // intent precedes the only submission attempt
    catch (error) {
      // Another API can win between the optimistic lookup and atomic insert/CAS.
      // Return that same intent, never schedule a second dispatch closure.
      if (execution.submissionDigest) {
        const row = this.db.prepare("SELECT record FROM shell_executions WHERE id = ?").get(execution.id);
        if (row) {
          const original = JSON.parse(String(row.record)) as Record;
          if (original.submissionDigest === execution.submissionDigest && original.sessionId === owner.sessionId && original.agentId === owner.agentId)
            return this.get(original.id, owner);
          throw new RecoveryError("EXECUTION_ID_CONFLICT", "Logical submission identity was already used with a different request");
        }
      }
      throw error;
    }
    this.acquire(execution.id);
    const heartbeat = this.heartbeat(execution.id);
    let acknowledge!: () => void;
    const accepted = new Promise<void>((resolve) => { acknowledge = resolve; });
    let observed: ManagedExecution | undefined;
    let consecutiveObservationFailures = 0;
    let nextPollDelayMs = this.pollMs;
    const work = Promise.resolve().then(async () => {
      try {
        const result = await recordExecution(execution.id, async (request) => {
          if (execution.recoveryContext && typeof runner().health === "function") {
            const health = await runner().health();
            execution.expectedRunnerInstanceId = health.runnerInstanceId;
          }
          execution.dispatchPhase = "dispatching";
          this.save(execution);
          observed = await runner().startShellExecution(request, AbortSignal.timeout(10_000));
          this.observed(execution, observed);
          acknowledge();
          while (true) {
            this.observed(execution, observed);
            if (terminal(observed.state)) break;
            await this.waitForPoll(nextPollDelayMs);
            if (this.closed) throw new RecoveryError("API_SHUTDOWN", "API observation stopped; the original Runner execution was not cancelled");
            try {
              observed = await runner().getShellExecution(execution.id, owner, AbortSignal.timeout(10_000));
              runner(); // re-check authorization after network I/O
              consecutiveObservationFailures = 0;
              nextPollDelayMs = this.pollMs;
            } catch (error) {
              if (!retryableObservationFailure(error)) throw error;
              consecutiveObservationFailures++;
              if (consecutiveObservationFailures >= MAX_CONSECUTIVE_OBSERVATION_FAILURES) {
                throw new Error(`Runner status remained unavailable after ${consecutiveObservationFailures} consecutive attempts: ${
                  errorDetail(error)}`, { cause: error });
              }
              // The command has already been accepted. A failed status read is
              // not a failed execution; query the same ID again, never submit it.
              nextPollDelayMs = Math.min(this.pollMs * 2 ** (consecutiveObservationFailures - 1), MAX_OBSERVATION_RETRY_DELAY_MS);
            }
          }
          if (observed.state === "unknown") throw new RecoveryError("PROCESS_STATE_UNVERIFIABLE", "Runner cannot verify the original process state; do not start a replacement");
          this.assertTerminalEvidence(observed);
          if (!observed.result && (observed.state === "failed" || observed.state === "cancelled")
            && (observed.version || !observed.startedAt)) {
            throw new RecordedRunnerFailure(observed.error ?? `Execution ${observed.state} before producing a result`);
          }
          if (!observed.result || !observed.version || (!request.explicitHandoff && !observed.result.workspaceSnapshot)) {
            throw new Error(observed.error ?? "Runner ended without a committed result; inspect its state before retrying");
          }
          // The envelope receipt is authoritative, including older Runners
          // that do not duplicate it inside the result payload.
          return this.existingResult(execution, observed);
        }, () => observed?.state === "cancelled" ? "cancelled" : observed?.state === "completed" ? "succeeded" : "failed");
        execution.resultRef = await this.versions.put("agent-state", JSON.stringify(result), "application/json");
        execution.runnerVersionId = observed!.version!.digest;
        this.finish(execution, { state: observed!.state, provenance: "committed" });
      } catch (error) {
        // A lost submit response or failed provenance does not prove the command did not run.
        const recorded = error instanceof RecordedRunnerFailure;
        if (observed?.version) execution.runnerVersionId = observed.version.digest;
        if (recorded) {
          try { await this.commitFailure(execution, observed!, finalizeFailure); }
          catch (failure) { this.unavailable(execution, failure, "PROVENANCE_COMMIT_FAILED"); }
        } else this.unavailable(execution, error, !execution.accepted ? "SUBMIT_OUTCOME_UNKNOWN" : observed && terminal(observed.state) ? "PROVENANCE_COMMIT_FAILED" : "OBSERVATION_UNAVAILABLE");
      } finally { acknowledge(); }
    }).catch(() => {
      // Storage failures must not become an unhandled rejection or a successful completion.
      acknowledge();
    }).finally(() => { clearInterval(heartbeat); this.release(execution.id); this.active.delete(execution.id); });
    this.active.set(execution.id, work);
    await accepted;
    return this.get(execution.id, owner);
  }

  private finish(execution: Record, patch: Pick<Record, "state" | "provenance"> & { error?: string }): void {
    const next = { ...execution, ...patch, finalization: "committed" as const, finishedAt: new Date().toISOString() };
    if (!patch.error) delete next.error;
    this.db.exec("SAVEPOINT shell_completion");
    try {
      this.save(next);
      this.db.prepare("UPDATE agent_notifications SET source = source || ':legacy-unknown', read_at = coalesce(read_at, ?) WHERE session = ? AND agent = ? AND kind = 'execution' AND source = ? AND message LIKE '%unknown%'")
        .run(Date.now(), execution.sessionId, execution.agentId, execution.id);
      this.notifications.complete(execution, execution.id,
        `Execution ${execution.id} on Runner ${execution.runnerId}: ${next.state}; provenance ${next.provenance}. Use execution_status / execution_logs to inspect. Do not replay the command.`);
      this.db.exec("RELEASE shell_completion");
    } catch (error) {
      this.db.exec("ROLLBACK TO shell_completion; RELEASE shell_completion");
      throw error;
    }
  }

  /** A wait deadline never reaches the process controller. */
  async wait(id: string, owner: ExecutionOwner, waitMs: number, signal?: AbortSignal): Promise<AgentShellExecution> {
    this.record(id, owner);
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30_000) throw new Error("wait_ms must be between 0 and 30000");
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
    return runner(execution.runnerId).shellExecutionLogs(id, owner, cursor, AbortSignal.timeout(10_000));
  }

  async cancel(id: string, owner: ExecutionOwner, runner: (id: string) => RunnerClient): Promise<AgentShellExecution> {
    const execution = this.record(id, owner);
    // Unknown after restart may still be running remotely; cancellation is safe, resubmission is not.
    if (!terminal(execution.state) || execution.state === "unknown") {
      await runner(execution.runnerId).cancelShellExecution(id, owner, AbortSignal.timeout(10_000));
    }
    return this.get(id, owner);
  }
}
