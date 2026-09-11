// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { VersionStore, type AgentStateRef } from "@sciencediscovery/cas";
import type { RunnerClient } from "@sciencediscovery/executor";
import type { AgentShellExecution, ExecutionOwner, ManagedExecution, ShellExecutionResult } from "@sciencediscovery/schema";
import type { AgentNotifications } from "./agent-notifications.js";

type Record = Omit<AgentShellExecution, "result"> & { resultRef?: AgentStateRef };
type RecordExecution = (id: string, dispatch: RunnerClient["executeShell"], status: () => "succeeded" | "failed" | "cancelled") => Promise<ShellExecutionResult>;
const terminal = (state: ManagedExecution["state"]) => state !== "queued" && state !== "running";
class RecordedRunnerFailure extends Error {}

/** Tracks accepted work independently of an Agent turn. It never replays commands. */
export class ShellExecutions {
  private readonly active = new Map<string, Promise<void>>();

  constructor(private readonly db: DatabaseSync, private readonly versions: VersionStore,
    private readonly notifications: AgentNotifications, private readonly pollMs = 200) {
    db.exec("CREATE TABLE IF NOT EXISTS shell_executions (id TEXT PRIMARY KEY, session TEXT NOT NULL, agent TEXT NOT NULL, record TEXT NOT NULL)");
    for (const row of db.prepare("SELECT record FROM shell_executions").all()) {
      const execution = JSON.parse(String(row.record)) as Record;
      if (!terminal(execution.state)) this.finish(execution, {
        state: "unknown", provenance: "unconfirmed",
        error: "API restarted before finalization; inspect Runner state. The command was not replayed.",
      });
    }
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

  snapshot(sessionId: string): Record[] {
    return this.db.prepare("SELECT record FROM shell_executions WHERE session = ? ORDER BY rowid").all(sessionId)
      .map((row) => JSON.parse(String(row.record)) as Record);
  }

  list(owner: ExecutionOwner): AgentShellExecution[] {
    return this.snapshot(owner.sessionId).filter((item) => item.agentId === owner.agentId).map(({ resultRef: _, ...item }) => item);
  }

  async get(id: string, owner: ExecutionOwner): Promise<AgentShellExecution> {
    const { resultRef, ...execution } = this.record(id, owner);
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
    runner: () => RunnerClient, recordExecution: RecordExecution): Promise<AgentShellExecution> {
    const execution: Record = { ...owner, ...identity, id: randomUUID(), state: "queued",
      queuedAt: new Date().toISOString(), accepted: false, provenance: "pending" };
    this.save(execution); // intent precedes the only submission attempt
    let acknowledge!: () => void;
    const accepted = new Promise<void>((resolve) => { acknowledge = resolve; });
    let observed: ManagedExecution | undefined;
    const assertOwner = (value: ManagedExecution) => {
      if (value.id !== execution.id || value.sessionId !== owner.sessionId || value.agentId !== owner.agentId) {
        throw new Error("Runner Execution identity mismatch");
      }
    };
    const work = Promise.resolve().then(async () => {
      try {
        const result = await recordExecution(execution.id, async (request) => {
          observed = await runner().startShellExecution(request, AbortSignal.timeout(10_000));
          assertOwner(observed);
          execution.accepted = true;
          this.save(execution);
          acknowledge();
          while (true) {
            assertOwner(observed);
            // When it started, on this machine's clock. The Runner reports its
            // own `startedAt`, and a machine whose clock nobody disciplines can
            // be minutes off — copying it here would file the start before the
            // queue time and scramble every timeline built from these records.
            if (observed.startedAt && !execution.startedAt) execution.startedAt = new Date().toISOString();
            // Runner termination is not API completion until provenance has committed.
            execution.state = observed.state === "queued" ? "queued" : "running";
            this.save(execution);
            if (terminal(observed.state)) break;
            await new Promise<void>((resolve) => setTimeout(resolve, this.pollMs));
            observed = await runner().getShellExecution(execution.id, owner, AbortSignal.timeout(10_000));
          }
          if (!observed.result && (observed.state === "failed" || observed.state === "cancelled")
            && (observed.version || !observed.startedAt)) {
            throw new RecordedRunnerFailure(observed.error ?? `Execution ${observed.state} before producing a result`);
          }
          if (!observed.result || !observed.version || !observed.result.workspaceSnapshot) {
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
        this.finish(execution, { state: recorded ? observed!.state : "unknown", provenance: recorded ? "committed" : "unconfirmed",
          error: error instanceof Error ? error.message : "Execution finalization failed" });
      } finally { acknowledge(); }
    }).catch(() => {
      // Storage failures must not become an unhandled rejection or a successful completion.
      acknowledge();
    }).finally(() => this.active.delete(execution.id));
    this.active.set(execution.id, work);
    await accepted;
    return this.get(execution.id, owner);
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
