// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ExecutionOwner } from "@sciencediscovery/schema";

export interface AgentNotification extends ExecutionOwner {
  id: string;
  kind: "execution" | "timer";
  sourceId: string;
  message: string;
  createdAt: number;
  readAt?: number;
}

export interface AgentTimer extends ExecutionOwner {
  id: string;
  dueAt: number;
  message: string;
  executionId?: string;
  state: "pending" | "fired" | "cancelled";
}

export interface NotificationBatch extends ExecutionOwner {
  epoch: number;
  agentEpoch: number;
  notifications: AgentNotification[];
}

/** A durable inbox, not a command queue. Delivery never stores or replays executable code. */
export class AgentNotifications {
  constructor(private readonly db: DatabaseSync, private readonly archived: (sessionId: string) => boolean,
    private readonly clock = Date.now) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_wake_gates (
        session TEXT PRIMARY KEY, stopped INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS agent_instance_wake_gates (
        session TEXT NOT NULL, agent TEXT NOT NULL, stopped INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(session, agent));
      CREATE TABLE IF NOT EXISTS agent_notifications (
        id TEXT PRIMARY KEY, session TEXT NOT NULL, agent TEXT NOT NULL, kind TEXT NOT NULL,
        source TEXT NOT NULL, message TEXT NOT NULL, created INTEGER NOT NULL, read_at INTEGER,
        UNIQUE(session, agent, kind, source));
      CREATE TABLE IF NOT EXISTS agent_timers (
        id TEXT PRIMARY KEY, session TEXT NOT NULL, agent TEXT NOT NULL, due INTEGER NOT NULL,
        message TEXT NOT NULL, execution TEXT, state TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS agent_notifications_unread ON agent_notifications(session, agent, read_at);
      CREATE INDEX IF NOT EXISTS agent_timers_due ON agent_timers(state, due);
    `);
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("SAVEPOINT notification_change");
    try {
      const value = operation();
      this.db.exec("RELEASE notification_change");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK TO notification_change; RELEASE notification_change");
      throw error;
    }
  }

  private gate(sessionId: string): { stopped: number; epoch: number } {
    this.db.prepare("INSERT OR IGNORE INTO agent_wake_gates(session) VALUES (?)").run(sessionId);
    return this.db.prepare("SELECT stopped, epoch FROM agent_wake_gates WHERE session = ?").get(sessionId) as unknown as { stopped: number; epoch: number };
  }

  canWake(sessionId: string): boolean { return !this.archived(sessionId) && !this.gate(sessionId).stopped; }

  generation(sessionId: string): number { return this.gate(sessionId).epoch; }

  private agentGate(owner: ExecutionOwner): { stopped: number; epoch: number } {
    this.db.prepare("INSERT OR IGNORE INTO agent_instance_wake_gates(session, agent) VALUES (?, ?)").run(owner.sessionId, owner.agentId);
    return this.db.prepare("SELECT stopped, epoch FROM agent_instance_wake_gates WHERE session = ? AND agent = ?")
      .get(owner.sessionId, owner.agentId) as unknown as { stopped: number; epoch: number };
  }

  canWakeAgent(owner: ExecutionOwner): boolean { return this.canWake(owner.sessionId) && !this.agentGate(owner).stopped; }

  stopAgent(owner: ExecutionOwner): void {
    this.transaction(() => {
      this.agentGate(owner);
      this.db.prepare("UPDATE agent_instance_wake_gates SET stopped = 1, epoch = epoch + 1 WHERE session = ? AND agent = ?")
        .run(owner.sessionId, owner.agentId);
      this.db.prepare("UPDATE agent_timers SET state = 'cancelled' WHERE session = ? AND agent = ? AND state = 'pending'")
        .run(owner.sessionId, owner.agentId);
    });
  }

  resumeAgent(owner: ExecutionOwner): void {
    if (!this.canWake(owner.sessionId)) throw new Error("Resume the Session before resuming this Agent");
    this.agentGate(owner);
    this.db.prepare("UPDATE agent_instance_wake_gates SET stopped = 0, epoch = epoch + 1 WHERE session = ? AND agent = ?")
      .run(owner.sessionId, owner.agentId);
  }

  /** Stop dominates outstanding delivery batches, including a batch already read by a scheduler. */
  stop(sessionId: string): void {
    this.transaction(() => {
      this.gate(sessionId);
      this.db.prepare("UPDATE agent_wake_gates SET stopped = 1, epoch = epoch + 1 WHERE session = ?").run(sessionId);
      this.db.prepare("UPDATE agent_timers SET state = 'cancelled' WHERE session = ? AND state = 'pending'").run(sessionId);
    });
  }

  /** Only a user-originated resume may call this; restoring an archive is not an implicit resume. */
  resume(sessionId: string, expectedEpoch?: number): boolean {
    if (this.archived(sessionId)) throw new Error("Archived Session cannot resume automatic wakeups");
    if (expectedEpoch !== undefined && this.gate(sessionId).epoch !== expectedEpoch) return false;
    this.gate(sessionId);
    this.db.prepare("UPDATE agent_wake_gates SET stopped = 0, epoch = epoch + 1 WHERE session = ?").run(sessionId);
    return true;
  }

  deleteSession(sessionId: string): void {
    this.transaction(() => {
      for (const table of ["agent_timers", "agent_notifications", "agent_instance_wake_gates", "agent_wake_gates"]) {
        this.db.prepare(`DELETE FROM ${table} WHERE session = ?`).run(sessionId);
      }
    });
  }

  /** Complete authority records for the existing turn-level State Pool, not a second version store. */
  snapshot(sessionId: string): unknown {
    return {
      gate: this.gate(sessionId),
      agents: this.db.prepare("SELECT agent, stopped, epoch FROM agent_instance_wake_gates WHERE session = ? ORDER BY agent").all(sessionId),
      notifications: this.db.prepare("SELECT * FROM agent_notifications WHERE session = ? ORDER BY created, id").all(sessionId),
      timers: this.db.prepare("SELECT * FROM agent_timers WHERE session = ? ORDER BY due, id").all(sessionId),
    };
  }

  unread(owner: ExecutionOwner, limit = 100): AgentNotification[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Notification page must contain 1-100 entries");
    return this.db.prepare(`SELECT * FROM agent_notifications WHERE session = ? AND agent = ? AND read_at IS NULL
      ORDER BY created, id LIMIT ?`).all(owner.sessionId, owner.agentId, limit).map((row) => ({
        id: String(row.id), sessionId: String(row.session), agentId: String(row.agent),
        kind: row.kind as AgentNotification["kind"], sourceId: String(row.source), message: String(row.message), createdAt: Number(row.created),
      }));
  }

  prepareDelivery(owner: ExecutionOwner): NotificationBatch | undefined {
    if (!this.canWakeAgent(owner)) return undefined;
    const notifications = this.unread(owner);
    return notifications.length ? { ...owner, epoch: this.gate(owner.sessionId).epoch, agentEpoch: this.agentGate(owner).epoch, notifications } : undefined;
  }

  pendingOwners(): ExecutionOwner[] {
    return this.db.prepare("SELECT DISTINCT session, agent FROM agent_notifications WHERE read_at IS NULL")
      .all().map((row) => ({ sessionId: String(row.session), agentId: String(row.agent) }));
  }

  deliveryAllowed(batch: NotificationBatch): boolean {
    return this.canWakeAgent(batch) && this.gate(batch.sessionId).epoch === batch.epoch && this.agentGate(batch).epoch === batch.agentEpoch;
  }

  pendingDelivery(batch: NotificationBatch): NotificationBatch | undefined {
    if (!this.deliveryAllowed(batch)) return undefined;
    const unread = new Set(this.unread(batch).map((notice) => notice.id));
    const notifications = batch.notifications.filter((notice) => unread.has(notice.id));
    return notifications.length ? { ...batch, notifications } : undefined;
  }

  /** Acknowledge only after durable context delivery. A failed or interrupted wake retains unread records. */
  acknowledge(batch: NotificationBatch): boolean {
    return this.transaction(() => {
      if (!this.deliveryAllowed(batch)) return false;
      const mark = this.db.prepare("UPDATE agent_notifications SET read_at = ? WHERE id = ? AND session = ? AND agent = ? AND read_at IS NULL");
      for (const notice of batch.notifications) mark.run(this.clock(), notice.id, batch.sessionId, batch.agentId);
      return true;
    });
  }

  complete(owner: ExecutionOwner, executionId: string, message: string): void {
    this.transaction(() => {
      this.insert(owner, "execution", executionId, message);
      // A completion supersedes a reminder for the same execution, not unrelated timers.
      this.db.prepare("UPDATE agent_timers SET state = 'cancelled' WHERE session = ? AND agent = ? AND execution = ? AND state = 'pending'")
        .run(owner.sessionId, owner.agentId, executionId);
    });
  }

  createTimer(owner: ExecutionOwner, input: { dueAt: number; message: string; executionId?: string }): AgentTimer {
    if (!this.canWakeAgent(owner)) throw new Error("Agent is stopped or Session is archived; resume before creating a timer");
    if (!Number.isSafeInteger(input.dueAt) || input.dueAt <= this.clock()) throw new Error("Timer must specify a future timestamp");
    const message = this.validateMessage(input.message);
    if (input.executionId && this.db.prepare("SELECT id FROM agent_notifications WHERE session = ? AND agent = ? AND kind = 'execution' AND source = ?")
      .get(owner.sessionId, owner.agentId, input.executionId)) throw new Error("Execution already completed; inspect its result instead of setting a reminder");
    const timer: AgentTimer = { sessionId: owner.sessionId, agentId: owner.agentId, id: randomUUID(),
      dueAt: input.dueAt, ...(input.executionId ? { executionId: input.executionId } : {}), message, state: "pending" };
    this.db.prepare("INSERT INTO agent_timers VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(timer.id, owner.sessionId, owner.agentId, timer.dueAt, timer.message, timer.executionId ?? null, timer.state);
    return timer;
  }

  timers(owner: ExecutionOwner): AgentTimer[] {
    return this.db.prepare("SELECT * FROM agent_timers WHERE session = ? AND agent = ? ORDER BY due, id")
      .all(owner.sessionId, owner.agentId).map((row) => ({
        id: String(row.id), ...owner, dueAt: Number(row.due), message: String(row.message),
        ...(row.execution ? { executionId: String(row.execution) } : {}), state: row.state as AgentTimer["state"],
      }));
  }

  cancelTimer(owner: ExecutionOwner, id: string): void {
    if (!this.db.prepare("SELECT id FROM agent_timers WHERE id = ? AND session = ? AND agent = ?").get(id, owner.sessionId, owner.agentId)) {
      throw new Error("Timer not found for this Agent");
    }
    this.db.prepare("UPDATE agent_timers SET state = 'cancelled' WHERE id = ? AND state = 'pending'").run(id);
  }

  /** Polling can restart freely: marking fired and recording the notice are one transaction. */
  poll(): void {
    this.transaction(() => {
      for (const row of this.db.prepare("SELECT * FROM agent_timers WHERE state = 'pending' AND due <= ?").all(this.clock())) {
        const owner = { sessionId: String(row.session), agentId: String(row.agent) };
        const canWake = this.canWakeAgent(owner);
        if (canWake) this.insert(owner, "timer", String(row.id), String(row.message));
        this.db.prepare("UPDATE agent_timers SET state = ? WHERE id = ?").run(canWake ? "fired" : "cancelled", row.id!);
      }
    });
  }

  private validateMessage(message: string): string {
    if (typeof message !== "string" || !message.trim() || message.length > 4_000) throw new Error("Notification message must contain 1-4000 characters");
    return message;
  }

  private insert(owner: ExecutionOwner, kind: AgentNotification["kind"], source: string, message: string): void {
    this.db.prepare("INSERT OR IGNORE INTO agent_notifications(id, session, agent, kind, source, message, created) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), owner.sessionId, owner.agentId, kind, source, this.validateMessage(message), this.clock());
  }
}
