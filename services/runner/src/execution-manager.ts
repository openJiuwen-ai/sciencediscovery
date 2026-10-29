// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { existsSync, mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { ensureWorkspaceBaseline, poisonWorkspace, RefStore, snapshotWorkspace, VersionStore, withWorkspaceLease, withWorkspaceAdmission, type AgentStateRef } from "@sciencediscovery/cas";
import type { ExecutionLogPage, ExecutionOwner, ManagedExecution, ShellExecutionRequest, ShellExecutionResult } from "@sciencediscovery/schema";

export type ExecutionLogSink = (stream: "stdout" | "stderr", chunk: Buffer) => void;
/** Resolving or rejecting must join every launched child, including cancellation. */
type Operation = (signal: AbortSignal, log: ExecutionLogSink) => Promise<ShellExecutionResult>;
const terminal = (state: ManagedExecution["state"]) => state !== "queued" && state !== "running";

export class ExecutionManagerError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: number) { super(message); }
}

/** Sort object keys recursively, preserving array order and JSON omission semantics. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  });
}
const digest = (value: unknown): string => `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
interface PublicationJournal {
  schemaVersion: 1;
  name: string;
  expected: AgentStateRef | null;
  target: AgentStateRef;
  execution: ManagedExecution;
}
const sameRef = (left: AgentStateRef | null | undefined, right: AgentStateRef | null | undefined) => canonicalJson(left ?? null) === canonicalJson(right ?? null);
const conflict = () => new ExecutionManagerError("EXECUTION_ID_CONFLICT", "Execution ID conflicts with an existing submission", 409);

export interface ExecutionQuarantineDiagnostic {
  phase: "startup" | "runtime" | "publication-recovery";
  executionId: string;
  scope: "runner" | "workspace-and-devices";
  workspaceKeyHash?: string;
  npuDevices?: number[];
}

/** The Runner owns process lifetime; an HTTP request only submits or observes it. */
export class ExecutionManager {
  private readonly db: DatabaseSync;
  private readonly ownership: DatabaseSync;
  private readonly versions: VersionStore;
  private readonly runnerInstanceId: string;
  private readonly runnerBootId = randomUUID();
  private readonly controllers = new Map<string, AbortController>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly failedWorkspaces = new Set<string>();
  private readonly uncertainWorkspaces = new Set<string>();
  private readonly uncertainDevices = new Set<number>();
  private legacyQuarantine = false;
  private readonly reportedQuarantines = new Set<string>();
  private storageHealthy = true;
  private closing = false;
  private recoveryPending = false;
  private readonly recoveringIds = new Set<string>();
  private recovery: Promise<void> = Promise.resolve();

  constructor(dataDir: string, private readonly onQuarantine?: (detail: ExecutionQuarantineDiagnostic) => void) {
    const root = resolve(dataDir, "runner-executions");
    const ledgerPath = resolve(root, "executions.sqlite");
    const existingLedger = existsSync(ledgerPath);
    // SQLite treats an empty or missing file as a fresh database. That is unsafe
    // once the ledger directory existed: it could forget all previously used IDs.
    if (existsSync(root) && (!existsSync(ledgerPath) || statSync(ledgerPath).size === 0)) {
      throw new ExecutionManagerError("EXECUTION_LEDGER_UNAVAILABLE", "Execution ledger is missing or empty; restore its original data before accepting submissions", 503);
    }
    mkdirSync(root, { recursive: true });
    // A separate SQLite writer transaction is an OS-owned lifetime lock, just
    // like Workspace leases. It releases on crash without trusting a stale PID.
    // The execution ledger itself remains free for short durable transactions.
    this.ownership = new DatabaseSync(resolve(root, "runner-owner.sqlite"));
    try { this.ownership.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE"); }
    catch (error) {
      this.ownership.close();
      if ([5, 6].includes((error as { errcode?: number }).errcode ?? -1)) {
        throw new ExecutionManagerError("RUNNER_ALREADY_ACTIVE", "Another Runner already owns this execution ledger", 503);
      }
      throw new ExecutionManagerError("EXECUTION_LEDGER_UNAVAILABLE", "Execution ledger ownership cannot be established", 503);
    }
    try { this.db = new DatabaseSync(ledgerPath); }
    catch (error) { this.ownership.close(); throw error; }
    try {
      const schemaVersion = Number(this.db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
      if (schemaVersion > 1) throw new Error("Execution ledger schema is newer than this Runner");
      if (existingLedger) {
        const tables = new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
        if (!tables.has("executions") || !tables.has("logs")) throw new Error("Execution ledger tables are missing");
      }
      const integrity = this.db.prepare("PRAGMA integrity_check").all();
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw new Error("Execution ledger integrity check failed");
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS executions (id TEXT PRIMARY KEY, session TEXT NOT NULL, agent TEXT NOT NULL, record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS logs (execution TEXT NOT NULL, cursor INTEGER NOT NULL, stream TEXT NOT NULL, text TEXT NOT NULL,
          PRIMARY KEY(execution, cursor));
        CREATE TABLE IF NOT EXISTS execution_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS execution_publications (id TEXT PRIMARY KEY, record TEXT NOT NULL);`);
      this.db.exec("BEGIN IMMEDIATE");
      const records = this.db.prepare("SELECT id, session, agent, record FROM executions").all();
      const identity = this.db.prepare("SELECT value FROM execution_metadata WHERE key = 'runnerInstanceId'").get();
      // Never replace missing identity metadata if receipts already depended on it.
      if (!identity && records.some(row => (JSON.parse(String(row.record)) as ManagedExecution).receipt)) {
        throw new Error("Execution ledger identity is missing");
      }
      this.runnerInstanceId = identity ? String(identity.value) : randomUUID();
      if (!/^[a-f0-9-]{36}$/i.test(this.runnerInstanceId)) throw new Error("Execution ledger identity is invalid");
      if (!identity) this.db.prepare("INSERT INTO execution_metadata VALUES ('runnerInstanceId', ?)").run(this.runnerInstanceId);
      this.db.exec("PRAGMA user_version=1");
      for (const row of records) {
        const execution = JSON.parse(String(row.record)) as ManagedExecution;
        if (!execution || execution.id !== row.id || execution.sessionId !== row.session || execution.agentId !== row.agent
          || !["queued", "running", "completed", "failed", "cancelled", "unknown"].includes(execution.state)
          || !execution.queuedAt || (execution.receipt && (execution.receipt.runnerInstanceId !== this.runnerInstanceId
            || !Number.isSafeInteger(execution.receipt.revision) || execution.receipt.revision < 1))) {
          throw new Error("Execution ledger contains an invalid record");
        }
        if (!terminal(execution.state)) {
          execution.state = "unknown";
          delete execution.finishedAt;
          execution.error = "Runner restarted before completion was recorded; process state is unverified and the command was not replayed";
          // Preserve real exit evidence if it was durably recorded before a commit interruption.
          this.save(execution);
        }
        if (execution.state === "unknown") this.quarantine(execution, "startup");
        // Exit without a rooted version is not a safely committed Workspace, even across restart.
        if (execution.state === "failed" && execution.startedAt && execution.evidence?.processTerminated && !execution.version) this.quarantine(execution, "startup");
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* no transaction may have begun */ }
      this.db.close();
      this.ownership.close();
      throw new ExecutionManagerError("EXECUTION_LEDGER_UNAVAILABLE", `Execution ledger cannot be trusted; new submissions are disabled: ${error instanceof Error ? error.message : String(error)}`, 503);
    }
    this.versions = new VersionStore(dataDir);
    if (this.db.prepare("SELECT 1 FROM execution_publications LIMIT 1").get()) {
      this.recoveryPending = true;
      for (const row of this.db.prepare("SELECT id FROM execution_publications").all()) this.recoveringIds.add(String(row.id));
      this.recovery = this.recoverPublications().finally(() => { this.recoveryPending = false; });
      void this.recovery.catch(() => { this.storageHealthy = false; });
    }
  }

  /** Startup publication recovery never dispatches computation. Observers may keep polling meanwhile. */
  ready(): Promise<void> { return this.recovery; }

  get identity(): { runnerInstanceId: string; runnerBootId: string } {
    return { runnerInstanceId: this.runnerInstanceId, runnerBootId: this.runnerBootId };
  }

  /** Also guard synchronous Runner entry points sharing these resources. */
  assertResourcesAvailable(request: Pick<ShellExecutionRequest, "workspaceRoot" | "npuDevices">): void {
    if (!this.storageHealthy) throw new ExecutionManagerError("EXECUTION_LEDGER_UNAVAILABLE", "Execution ledger cannot be trusted; new submissions are disabled", 503);
    if (this.recoveryPending) throw new ExecutionManagerError("EXECUTION_RECOVERY_PENDING", "Runner is verifying interrupted result publications; retry observation shortly", 503);
    const devices = request.npuDevices ?? [];
    if (!Array.isArray(devices) || devices.some(device => !Number.isSafeInteger(device) || device < 0)) throw new Error("Invalid NPU device selection");
    if (this.legacyQuarantine || this.uncertainWorkspaces.has(request.workspaceRoot) || devices.some(device => this.uncertainDevices.has(device))) {
      throw new ExecutionManagerError("EXECUTION_RESOURCE_QUARANTINED", "An earlier execution has unverified process state; affected workspace or NPU resources cannot accept new work", 409);
    }
    if (this.failedWorkspaces.has(request.workspaceRoot)) throw new ExecutionManagerError("WORKSPACE_COMMIT_FAILED", "Workspace version commit failed; repair storage before restarting the Runner", 409);
  }

  start(request: ShellExecutionRequest, operation: Operation): ManagedExecution {
    return this.submit(request, operation).execution;
  }

  submit(request: ShellExecutionRequest, operation: Operation): { execution: ManagedExecution; accepted: boolean } {
    if (this.closing) throw new ExecutionManagerError("RUNNER_SHUTTING_DOWN", "Runner is shutting down", 503);
    if (!this.storageHealthy) throw new ExecutionManagerError("EXECUTION_LEDGER_UNAVAILABLE", "Execution ledger cannot be trusted; new submissions are disabled", 503);
    if (!/^[A-Za-z0-9_:.-]{1,160}$/.test(request.executionId)) throw new Error("Invalid Execution ID");
    // Bind the deferred admission and the digest to one immutable request snapshot.
    request = structuredClone(request);
    const owner = { agentId: request.agentId, sessionId: request.permissionEpoch.sessionId };
    const requestDigest = digest(request);
    const key = request.workspaceRoot; // already canonicalized by the authenticated endpoint
    const npuDevices = request.npuDevices ?? [];
    if (!Array.isArray(npuDevices) || npuDevices.some(device => !Number.isSafeInteger(device) || device < 0)) throw new Error("Invalid NPU device selection");
    const acceptedAt = new Date().toISOString();
    const execution: ManagedExecution = { ...owner, id: request.executionId, state: "queued", queuedAt: acceptedAt,
      workspaceKey: key, npuDevices: [...npuDevices],
      receipt: { ...this.identity, revision: 1, requestDigest, acceptedAt } };
    // Duplicate lookup and insert share the transaction. No operation is scheduled until COMMIT.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT session, agent, record FROM executions WHERE id = ?").get(request.executionId);
      if (row) {
        if (row.session !== owner.sessionId || row.agent !== owner.agentId) throw conflict();
        const existing = JSON.parse(String(row.record)) as ManagedExecution;
        if (!existing.receipt || existing.receipt.requestDigest !== requestDigest) throw conflict();
        if (this.recoveringIds.has(existing.id)) throw this.recoveryInProgress();
        this.db.exec("COMMIT");
        return { execution: existing, accepted: false };
      }
      this.assertResourcesAvailable(request);
      this.db.prepare("INSERT INTO executions VALUES (?, ?, ?, ?)").run(execution.id, owner.sessionId, owner.agentId, JSON.stringify(execution));
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve the original error */ }
      if (!(error instanceof ExecutionManagerError)) this.storageHealthy = false;
      throw error;
    }
    const controller = new AbortController();
    this.controllers.set(execution.id, controller);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const work = previous.then(() => withWorkspaceAdmission(this.versions, key, () => withWorkspaceLease(key, async () => {
      if (!request.explicitHandoff) await ensureWorkspaceBaseline(this.versions, key);
      let changed = false;
      let cursor = 0;
      let retained = 0;
      const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
      const log: ExecutionLogSink = (stream, chunk) => {
        // Bound retained logs independently of process lifetime; observation must not kill a job.
        const budget = request.maxOutputBytes ?? 10_000_000;
        if (budget > 0 && retained + chunk.length > budget && !execution.logTruncated) {
          execution.logTruncated = true;
          this.save(execution);
        }
        if (budget > 0 && retained >= budget) return;
        const bytes = budget > 0 ? chunk.subarray(0, Math.max(0, budget - retained)) : chunk;
        // Small chunks make cursor pagination bounded even for a single very long line.
        const characters = Array.from(decoders[stream].write(bytes));
        for (let offset = 0; offset < characters.length; offset += 4096) {
          const text = characters.slice(offset, offset + 4096).join("");
          this.db.prepare("INSERT INTO logs VALUES (?, ?, ?, ?)").run(execution.id, ++cursor, stream, text);
        }
        retained += bytes.length;
      };
      try {
        if (this.failedWorkspaces.has(key)) throw new Error("Workspace version commit failed; repair storage before restarting the Runner");
        if (controller.signal.aborted) throw new Error("Execution cancelled before start");
        execution.state = "running";
        execution.startedAt = new Date().toISOString();
        this.save(execution);
        changed = true;
        execution.result = await operation(controller.signal, log);
        execution.state = controller.signal.aborted ? "cancelled" : execution.result.exitCode === 0 && !execution.result.networkDeniedHosts?.length ? "completed" : "failed";
      } catch (error) {
        execution.state = controller.signal.aborted ? "cancelled" : "failed";
        execution.error = error instanceof Error ? error.message : "Execution failed";
      }
      const endedState = execution.state;
      execution.evidence = { ...this.identity, revision: execution.receipt!.revision, processTerminated: true,
        terminationReason: changed ? controller.signal.aborted ? "cancelled" : execution.result ? "exited" : "operation_rejected_after_join" : "not_started" };
      // Journal process exit before asynchronous result publication. A crash here remains
      // unknown with truthful exit evidence, not a fabricated committed terminal result.
      execution.state = "running";
      this.save(execution);
      execution.state = endedState;
      try {
        if (changed) {
          const workspace = request.explicitHandoff ? undefined : await snapshotWorkspace(this.versions, request.workspaceRoot);
          const readLog = (stream: string) => this.db.prepare("SELECT text FROM logs WHERE execution = ? AND stream = ? ORDER BY cursor")
            .all(execution.id, stream).map((row) => String(row.text)).join("");
          const stdout = await this.versions.put("agent-state", readLog("stdout") || execution.result?.stdout || "");
          const stderr = await this.versions.put("agent-state", readLog("stderr") || execution.result?.stderr || execution.error || "");
          const code = await this.versions.put("agent-state", request.code);
          const version = await this.versions.putRecord("WorkspaceExecution", {
            executionId: execution.id, ...owner, ...(workspace ? { workspace } : {}), code, stdout, stderr,
            environmentRevisionId: execution.result?.environmentRevisionId ?? null,
            state: execution.state,
          });
          const refs = await RefStore.open(this.versions);
          try {
            const name = `workspaces/${createHash("sha256").update(key).digest("hex")}/head`;
            const completed = structuredClone(execution);
            completed.version = version;
            completed.finishedAt = new Date().toISOString();
            completed.evidence!.workspaceVersionDigest = version.digest;
            if (completed.result) {
              completed.result.workspaceSnapshot = workspace;
              completed.result.workspaceVersion = version;
              completed.evidence!.resultDigest = digest(completed.result);
            }
            const journal: PublicationJournal = { schemaVersion: 1, name, expected: refs.head(name), target: version, execution: completed };
            // Persist the exact immutable target before publishing its head. Crash recovery
            // can finish this transaction, but has neither request code nor a launch closure.
            this.db.prepare("INSERT INTO execution_publications VALUES (?, ?)").run(execution.id, JSON.stringify(journal));
            await refs.commit(this.versions, name, journal.expected, version);
            Object.assign(execution, this.finishPublication(journal));
            return;
          } finally { refs.close(); }
        }
      } catch (error) {
        this.failedWorkspaces.add(key);
        if (this.db.prepare("SELECT 1 FROM execution_publications WHERE id = ?").get(execution.id)) {
          execution.state = "unknown";
          delete execution.finishedAt;
          execution.error = `Execution ended, but result publication is pending recovery: ${error instanceof Error ? error.message : String(error)}`;
          this.quarantine(execution);
          this.save(execution);
          return;
        }
        execution.state = "failed";
        await poisonWorkspace(key).catch(() => undefined);
        execution.error = `Execution ended, but workspace version commit failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      execution.finishedAt = new Date().toISOString();
      this.save(execution); // before releasing this Workspace queue
    }, controller.signal), controller.signal)).then(() => {
      // Keep the journal until the Workspace lease (including its active marker)
      // was released. A crash after index commit can still retain a write fence.
      if (execution.version) this.clearPublication(execution.id);
    }).catch((error) => {
      if (execution.version && execution.evidence?.processTerminated) {
        // Publication already committed. Failure to clear its journal must not
        // rewrite the authoritative terminal state; startup can finish cleanup.
        this.storageHealthy = false;
        this.failedWorkspaces.add(key);
        return;
      }
      if (!controller.signal.aborted && (error as { code?: string }).code !== "WORKSPACE_RETIRED") this.failedWorkspaces.add(key);
      execution.state = controller.signal.aborted ? "cancelled" : "failed";
      execution.finishedAt = new Date().toISOString();
      execution.error = error instanceof Error ? error.message : "Workspace admission failed";
      // Admission failed before launch. Never invent exit evidence for an operation
      // which started but failed to persist its joined-process receipt.
      if (!execution.startedAt) execution.evidence = { ...this.identity, revision: execution.receipt!.revision,
        processTerminated: true, terminationReason: "not_started" };
      this.save(execution);
    }).finally(() => {
      this.controllers.delete(execution.id);
      if (this.queues.get(key) === work) this.queues.delete(key);
    });
    // Avoid unhandled rejections from storage failure; subsequent jobs must not overtake a failed commit.
    void work.catch(() => undefined);
    this.queues.set(key, work);
    return { execution: structuredClone(execution), accepted: true };
  }

  get(id: string, owner: ExecutionOwner): ManagedExecution {
    const execution = this.readStored(id, owner); // check owner before revealing recovery status
    if (this.recoveringIds.has(id)) throw this.recoveryInProgress();
    return execution;
  }

  private recoveryInProgress(): ExecutionManagerError {
    return new ExecutionManagerError("EXECUTION_RECOVERY_PENDING", "Runner is verifying interrupted result publication; retry observation shortly", 503);
  }

  private readStored(id: string, owner: ExecutionOwner): ManagedExecution {
    const row = this.db.prepare("SELECT record FROM executions WHERE id = ? AND session = ? AND agent = ?")
      .get(id, owner.sessionId, owner.agentId);
    if (!row) throw new ExecutionManagerError("EXECUTION_NOT_FOUND", "Execution not found for this Agent", 404);
    return JSON.parse(String(row.record)) as ManagedExecution;
  }

  logs(id: string, owner: ExecutionOwner, cursor = 0): ExecutionLogPage {
    const execution = this.readStored(id, owner);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid log cursor");
    const rows = this.db.prepare("SELECT cursor, stream, text FROM logs WHERE execution = ? AND cursor > ? ORDER BY cursor LIMIT 4").all(id, cursor);
    const chunks = rows.map((row) => ({ cursor: Number(row.cursor), stream: String(row.stream) as "stdout" | "stderr", text: String(row.text) }));
    const nextCursor = chunks.at(-1)?.cursor ?? cursor;
    return { chunks, nextCursor, retentionTruncated: execution.logTruncated === true,
      truncated: Boolean(this.db.prepare("SELECT 1 FROM logs WHERE execution = ? AND cursor > ? LIMIT 1").get(id, nextCursor)) };
  }

  cancel(id: string, owner: ExecutionOwner): ManagedExecution {
    const execution = this.get(id, owner);
    if (!terminal(execution.state)) this.controllers.get(id)?.abort();
    return this.get(id, owner); // terminal only after process exit and version commit
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([this.recovery, ...this.queues.values()]);
    try { this.db.close(); } finally { this.ownership.close(); }
  }

  private finishPublication(journal: PublicationJournal): ManagedExecution {
    const previous = this.readStored(journal.execution.id, journal.execution);
    if (previous.state === journal.execution.state && previous.finishedAt === journal.execution.finishedAt
      && sameRef(previous.version, journal.target) && previous.evidence?.resultDigest === journal.execution.evidence?.resultDigest
      && canonicalJson(previous.result) === canonicalJson(journal.execution.result) && previous.error === journal.execution.error) return previous;
    const completed = structuredClone(journal.execution);
    completed.receipt!.revision = previous.receipt!.revision;
    this.db.exec("BEGIN IMMEDIATE");
    try { this.save(completed); this.db.exec("COMMIT"); }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return completed;
  }

  private clearPublication(id: string): void {
    this.db.prepare("DELETE FROM execution_publications WHERE id = ?").run(id);
  }

  private async recoverPublications(): Promise<void> {
    for (const row of this.db.prepare("SELECT id, record FROM execution_publications ORDER BY id").all()) {
      let previous: ManagedExecution | undefined;
      try {
        const journal = JSON.parse(String(row.record)) as PublicationJournal;
        const completed = journal.execution;
        previous = this.readStored(String(row.id), completed);
        const receipt = completed.receipt;
        if (journal.schemaVersion !== 1 || completed.id !== row.id || !receipt || !previous.receipt
          || receipt.runnerInstanceId !== this.runnerInstanceId || receipt.runnerBootId !== previous.receipt.runnerBootId
          || receipt.requestDigest !== previous.receipt.requestDigest || receipt.acceptedAt !== previous.receipt.acceptedAt
          || completed.workspaceKey !== previous.workspaceKey || !completed.workspaceKey
          || canonicalJson(completed.npuDevices) !== canonicalJson(previous.npuDevices)
          || completed.queuedAt !== previous.queuedAt || completed.startedAt !== previous.startedAt
          || !previous.evidence?.processTerminated
          || !["completed", "failed", "cancelled"].includes(completed.state) || !completed.finishedAt
          || !completed.evidence?.processTerminated || completed.evidence.runnerInstanceId !== receipt.runnerInstanceId
          || completed.evidence.runnerBootId !== receipt.runnerBootId || completed.evidence.revision !== receipt.revision
          || !sameRef(completed.version, journal.target)
          || completed.evidence.workspaceVersionDigest !== journal.target.digest
          || journal.name !== `workspaces/${createHash("sha256").update(completed.workspaceKey).digest("hex")}/head`
          || (completed.result && (completed.evidence.resultDigest !== digest(completed.result) || !sameRef(completed.result.workspaceVersion, journal.target)))) {
          throw new Error("Publication journal identity or result evidence is invalid");
        }
        await this.versions.validateClosure(journal.target);
        const value = (await this.versions.readRecord<{ executionId: string; sessionId: string; agentId: string; state: string; workspace?: AgentStateRef }>(journal.target, "WorkspaceExecution")).value;
        if (value.executionId !== completed.id || value.sessionId !== completed.sessionId || value.agentId !== completed.agentId
          || value.state !== completed.state || (completed.result && !sameRef(value.workspace, completed.result.workspaceSnapshot))) {
          throw new Error("Publication target does not match the original execution");
        }
        const refs = await RefStore.open(this.versions);
        try {
          const head = refs.head(journal.name);
          const alreadyRooted = sameRef(head, journal.target) || refs.history(journal.name).some(ref => sameRef(ref, journal.target));
          if (!alreadyRooted) {
            if (!sameRef(head, journal.expected)) throw new Error("Workspace head changed before interrupted publication could commit");
            await refs.commit(this.versions, journal.name, journal.expected, journal.target);
          }
          this.finishPublication(journal);
        } finally { refs.close(); }
        // No private CAS lock paths or generic active-marker deletion here. A
        // real crash may leave its write fence: recover the result, but require
        // verified/manual fence recovery before admitting another writer.
        const busy = async (): Promise<void> => { throw new Error("Workspace recovery lease is busy"); };
        await withWorkspaceAdmission(this.versions, completed.workspaceKey,
          () => withWorkspaceLease(completed.workspaceKey!, async () => {}, undefined, busy), undefined, busy);
        this.clearPublication(completed.id);
      } catch (error) {
        if (!previous) { this.storageHealthy = false; continue; }
        const current = this.readStored(previous.id, previous);
        if (!current.version) {
          current.state = "unknown";
          delete current.finishedAt;
          current.error = `Result publication recovery is blocked: ${error instanceof Error ? error.message : String(error)}`;
          this.save(current);
        }
        this.quarantine(current, "publication-recovery");
      } finally {
        this.recoveringIds.delete(String(row.id));
      }
    }
    // Release only scopes whose entire unresolved set was repaired. A remaining
    // journal is also a persisted fence, even when its terminal result is readable.
    this.uncertainWorkspaces.clear(); this.uncertainDevices.clear(); this.legacyQuarantine = false;
    const pending = new Set(this.db.prepare("SELECT id FROM execution_publications").all().map(row => String(row.id)));
    for (const row of this.db.prepare("SELECT record FROM executions").all()) {
      const execution = JSON.parse(String(row.record)) as ManagedExecution;
      if (execution.state === "unknown" || (execution.state === "failed" && execution.startedAt && !execution.version)) this.quarantine(execution, "publication-recovery");
      else if (pending.has(execution.id)) this.quarantine({ ...execution, npuDevices: [] }, "publication-recovery");
    }
  }

  private quarantine(execution: ManagedExecution, phase: ExecutionQuarantineDiagnostic["phase"] = "runtime"): void {
    const scoped = typeof execution.workspaceKey === "string" && Boolean(execution.workspaceKey)
      && Array.isArray(execution.npuDevices) && execution.npuDevices.every(device => Number.isSafeInteger(device) && device >= 0);
    if (scoped) {
      this.uncertainWorkspaces.add(execution.workspaceKey!);
      for (const device of execution.npuDevices!) this.uncertainDevices.add(device);
    } else this.legacyQuarantine = true;
    if (this.onQuarantine) {
      // A fence diagnostic, not an assertion that computation failed or that
      // publication cannot recover. Never include command/output/error text.
      const detail: ExecutionQuarantineDiagnostic = { executionId: execution.id, phase,
        scope: scoped ? "workspace-and-devices" : "runner",
        ...(scoped ? { workspaceKeyHash: createHash("sha256").update(execution.workspaceKey!).digest("hex"), npuDevices: [...execution.npuDevices!] } : {}) };
      const key = canonicalJson({ ...detail, npuDevices: detail.npuDevices?.slice().sort((a, b) => a - b) });
      if (this.reportedQuarantines.has(key)) return;
      // Mark before calling the sink: a throwing/reentrant logger cannot flood
      // repeated recovery scans or affect the fence already installed above.
      this.reportedQuarantines.add(key);
      try { this.onQuarantine(detail); }
      catch { /* Logging failure must never change resource admission. */ }
    }
  }

  private save(execution: ManagedExecution): void {
    try {
      if (execution.receipt) {
        execution.receipt.revision += 1;
        if (!Number.isSafeInteger(execution.receipt.revision)) throw new Error("Execution revision exhausted");
        if (execution.evidence) execution.evidence.revision = execution.receipt.revision;
      }
      this.db.prepare("INSERT INTO executions VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record")
        .run(execution.id, execution.sessionId, execution.agentId, JSON.stringify(execution));
    } catch (error) {
      this.storageHealthy = false;
      throw error;
    }
  }
}
