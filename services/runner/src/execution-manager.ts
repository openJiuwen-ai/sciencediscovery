// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { poisonWorkspace, RefStore, snapshotWorkspace, VersionStore, withWorkspaceLease } from "@sciencediscovery/cas";
import type { ExecutionLogPage, ExecutionOwner, ManagedExecution, ShellExecutionRequest, ShellExecutionResult } from "@sciencediscovery/schema";

export type ExecutionLogSink = (stream: "stdout" | "stderr", chunk: Buffer) => void;
type Operation = (signal: AbortSignal, log: ExecutionLogSink) => Promise<ShellExecutionResult>;
const terminal = (state: ManagedExecution["state"]) => state !== "queued" && state !== "running";

/** The Runner owns process lifetime; an HTTP request only submits or observes it. */
export class ExecutionManager {
  private readonly db: DatabaseSync;
  private readonly versions: VersionStore;
  private readonly controllers = new Map<string, AbortController>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly failedWorkspaces = new Set<string>();
  private closing = false;

  constructor(dataDir: string) {
    const root = resolve(dataDir, "runner-executions");
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(resolve(root, "executions.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS executions (id TEXT PRIMARY KEY, session TEXT NOT NULL, agent TEXT NOT NULL, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS logs (execution TEXT NOT NULL, cursor INTEGER NOT NULL, stream TEXT NOT NULL, text TEXT NOT NULL,
        PRIMARY KEY(execution, cursor));`);
    this.versions = new VersionStore(dataDir);
    for (const row of this.db.prepare("SELECT record FROM executions").all()) {
      const execution = JSON.parse(String(row.record)) as ManagedExecution;
      if (!terminal(execution.state)) {
        this.save({ ...execution, state: "unknown", finishedAt: new Date().toISOString(),
          error: "Runner restarted before completion was recorded; the command was not replayed" });
      }
    }
  }

  start(request: ShellExecutionRequest, operation: Operation): ManagedExecution {
    if (this.closing) throw new Error("Runner is shutting down");
    if (!/^[A-Za-z0-9_:.-]{1,160}$/.test(request.executionId)) throw new Error("Invalid Execution ID");
    const owner = { agentId: request.agentId, sessionId: request.permissionEpoch.sessionId };
    if (this.failedWorkspaces.has(request.workspaceRoot)) throw new Error("Workspace version commit failed; repair storage before restarting the Runner");
    if (this.db.prepare("SELECT id FROM executions WHERE id = ?").get(request.executionId)) {
      throw new Error("Execution ID has already been used; query it instead of replaying the command");
    }
    const execution: ManagedExecution = { ...owner, id: request.executionId, state: "queued", queuedAt: new Date().toISOString() };
    this.save(execution);
    const controller = new AbortController();
    this.controllers.set(execution.id, controller);
    const key = request.workspaceRoot; // already canonicalized by the authenticated endpoint
    const previous = this.queues.get(key) ?? Promise.resolve();
    const work = previous.then(() => withWorkspaceLease(key, async () => {
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
        execution.state = controller.signal.aborted ? "cancelled" : execution.result.exitCode === 0 ? "completed" : "failed";
      } catch (error) {
        execution.state = controller.signal.aborted ? "cancelled" : "failed";
        execution.error = error instanceof Error ? error.message : "Execution failed";
      }
      try {
        if (changed) {
          // The operation must have joined its child before returning, including cancellation.
          const workspace = await snapshotWorkspace(this.versions, request.workspaceRoot);
          const readLog = (stream: string) => this.db.prepare("SELECT text FROM logs WHERE execution = ? AND stream = ? ORDER BY cursor")
            .all(execution.id, stream).map((row) => String(row.text)).join("");
          const stdout = await this.versions.put("agent-state", readLog("stdout") || execution.result?.stdout || "");
          const stderr = await this.versions.put("agent-state", readLog("stderr") || execution.result?.stderr || execution.error || "");
          const code = await this.versions.put("agent-state", request.code);
          const version = await this.versions.putRecord("WorkspaceExecution", {
            executionId: execution.id, ...owner, workspace, code, stdout, stderr,
            environmentRevisionId: execution.result?.environmentRevisionId ?? null,
            state: execution.state,
          });
          const refs = await RefStore.open(this.versions);
          try {
            const name = `workspaces/${createHash("sha256").update(key).digest("hex")}/head`;
            await refs.commit(this.versions, name, refs.head(name), version);
            execution.version = version;
          } finally { refs.close(); }
        }
      } catch (error) {
        execution.state = "failed";
        this.failedWorkspaces.add(key);
        await poisonWorkspace(key).catch(() => undefined);
        execution.error = `Execution ended, but workspace version commit failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      execution.finishedAt = new Date().toISOString();
      this.save(execution); // before releasing this Workspace queue
    }, controller.signal)).catch((error) => {
      if (!controller.signal.aborted) this.failedWorkspaces.add(key);
      execution.state = controller.signal.aborted ? "cancelled" : "failed";
      execution.finishedAt = new Date().toISOString();
      execution.error = error instanceof Error ? error.message : "Workspace admission failed";
      this.save(execution);
    }).finally(() => {
      this.controllers.delete(execution.id);
      if (this.queues.get(key) === work) this.queues.delete(key);
    });
    // Avoid unhandled rejections from storage failure; subsequent jobs must not overtake a failed commit.
    void work.catch(() => undefined);
    this.queues.set(key, work);
    return structuredClone(execution);
  }

  get(id: string, owner: ExecutionOwner): ManagedExecution {
    const row = this.db.prepare("SELECT record FROM executions WHERE id = ? AND session = ? AND agent = ?")
      .get(id, owner.sessionId, owner.agentId);
    if (!row) throw new Error("Execution not found for this Agent");
    return JSON.parse(String(row.record)) as ManagedExecution;
  }

  logs(id: string, owner: ExecutionOwner, cursor = 0): ExecutionLogPage {
    const execution = this.get(id, owner);
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
    await Promise.allSettled(this.queues.values());
    this.db.close();
  }

  private save(execution: ManagedExecution): void {
    this.db.prepare("INSERT INTO executions VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record")
      .run(execution.id, execution.sessionId, execution.agentId, JSON.stringify(execution));
  }
}
