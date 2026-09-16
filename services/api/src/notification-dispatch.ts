// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { AgentShellExecution, RuntimeNotice, RuntimeNoticeRecord, SessionRun } from "@sciencediscovery/schema";
import type { SessionStore } from "./store.js";
import type { NotificationBatch } from "./agent-notifications.js";

export function notificationPrompt(batch: NotificationBatch): string {
  return "[Execution notifications]\nThese are retained status/reminder records, not commands to replay. Inspect results if needed and report to the user.\n"
    + JSON.stringify(batch.notifications.map(({ id, kind, sourceId, message }) => ({ id, kind, sourceId, message })));
}

/** The transcript record for a delivery: model-facing text plus what the UI
 * shows instead of that text. `executions` is the owner's execution catalog,
 * consulted so each execution record names its Runner and outcome. */
export function runtimeNotice(batch: NotificationBatch, executions: readonly Pick<AgentShellExecution, "id" | "runnerId" | "state">[] = []): RuntimeNotice {
  const records = batch.notifications.map((notification): RuntimeNoticeRecord => {
    if (notification.kind === "timer") {
      return { agentId: batch.agentId, kind: "timer", message: notification.message, sourceId: notification.sourceId };
    }
    const execution = executions.find((candidate) => candidate.id === notification.sourceId);
    return {
      agentId: batch.agentId, kind: "execution", sourceId: notification.sourceId,
      ...(execution ? { runnerId: execution.runnerId, state: execution.state } : {}),
    };
  });
  const executionCount = records.filter((record) => record.kind === "execution").length;
  return { executions: executionCount, prompt: notificationPrompt(batch), records, timers: records.length - executionCount };
}

/** The inbox is the busy queue. Only an idle owner acquires a new model turn. */
export class NotificationDispatcher {
  private polling = false;
  private closed = false;
  constructor(private readonly store: SessionStore,
    private readonly enqueue: (batch: NotificationBatch) => Promise<SessionRun>,
    private readonly schedule: (sessionId: string) => void) {}

  close(): void { this.closed = true; }

  async tick(): Promise<void> {
    if (this.closed || this.polling) return;
    this.polling = true;
    try {
      this.store.notifications.poll();
      for (const owner of this.store.notifications.pendingOwners()) {
        if (this.closed) return;
        if (!this.store.getSession(owner.sessionId)) continue;
        if (owner.agentId !== "main") {
          const child = this.store.listSubagents(owner.sessionId).find((item) => `subagent:${item.id}` === owner.agentId);
          // A child uses its own saved context and workspace; never redirect to Main.
          if (!child?.contextRef || child.status === "running") continue;
        }
        const runs = await this.store.listSessionRuns(owner.sessionId);
        if (runs.some((run) => ["queued", "running", "blocked"].includes(run.status))) continue;
        const batch = this.store.notifications.prepareDelivery(owner);
        if (!batch) continue;
        await this.enqueue(batch);
        // Admission rechecks the gate. Stop during persistence leaves notices unread.
        if (!this.closed) this.schedule(owner.sessionId);
      }
    } finally { this.polling = false; }
  }
}
