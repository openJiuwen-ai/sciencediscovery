// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { ResearchContinuationOperation } from "@sciencediscovery/schema";
import type { ApiClient } from "../api.js";

export type ContinuationTask = {
  sourceSessionId: string; requestId: string; operation?: ResearchContinuationOperation;
  state: "copying" | "ready" | "failed"; error?: string;
};
const storageKey = "research-continuation-tasks:v1";
type StoragePort = Pick<Storage, "getItem" | "setItem">;

/** Owned by the application, never by a Session or dialog. The server owns the copy. */
export class ContinuationTasks {
  tasks: ContinuationTask[] = [];
  private listeners = new Set<() => void>();
  private running = new Set<string>();
  private disposed = false;
  private hydrated = false;
  constructor(private client: Pick<ApiClient, "createResearchContinuation" | "getResearchContinuation">,
    private storage: StoragePort | undefined, private onReady: (task: ContinuationTask) => void,
    private delay = () => new Promise<void>((resolve) => setTimeout(resolve, 1000)), private onStart?: (task: ContinuationTask) => void) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.tasks;
  private publish() {
    this.tasks = [...this.tasks];
    try { this.storage?.setItem(storageKey, JSON.stringify(this.tasks)); } catch { /* Memory tracking still works when storage is unavailable. */ }
    for (const listener of this.listeners) listener();
  }
  resume() {
    this.disposed = false;
    if (!this.hydrated) try {
      const saved: unknown = JSON.parse(this.storage?.getItem(storageKey) ?? "[]");
      if (Array.isArray(saved)) this.tasks = saved.filter((task): task is ContinuationTask => task && typeof task.sourceSessionId === "string" && typeof task.requestId === "string" && ["copying", "ready", "failed"].includes(task.state));
    } catch { /* Ignore invalid local progress, never touch the source snapshot. */ }
    this.hydrated = true;
    this.publish();
    for (const task of this.tasks) if (task.state === "copying") void this.track(task);
  }
  dispose() { this.disposed = true; }
  start(sourceSessionId: string) {
    const existing = this.tasks.find((task) => task.sourceSessionId === sourceSessionId && task.state === "copying");
    if (existing) { void this.track(existing); return existing; }
    const task: ContinuationTask = { sourceSessionId, requestId: crypto.randomUUID(), state: "copying" };
    this.onStart?.(task);
    this.tasks = [...this.tasks.filter((item) => item.sourceSessionId !== sourceSessionId), task];
    this.publish(); void this.track(task); return task;
  }
  dismiss(requestId: string) { this.tasks = this.tasks.filter((task) => task.requestId !== requestId || task.state === "copying"); this.publish(); }
  private async track(task: ContinuationTask) {
    if (this.running.has(task.requestId) || this.disposed) return;
    this.running.add(task.requestId);
    try {
      while (!this.disposed && task.state === "copying") {
        try {
          const operation = task.operation
            ? await this.client.getResearchContinuation(task.sourceSessionId, task.operation.id)
            : await this.client.createResearchContinuation(task.sourceSessionId, task.requestId);
          if (this.disposed) return;
          task.operation = operation; task.error = undefined;
          if (operation.state === "ready" && (!operation.entrySessionId || !operation.sessionIds?.length)) throw new Error("复制结果缺少会话信息，正在重试查询。");
          task.state = operation.state;
          if (operation.state === "failed") task.error = operation.error || "复制未完成，请重试。";
          this.publish();
          if (task.state === "ready") this.onReady(task);
        } catch (reason) {
          if (this.disposed) return;
          const status = (reason as { status?: number }).status;
          // A transport error must retain the same request identity to avoid duplicate copies.
          if (status && [400, 403, 404, 409].includes(status)) task.state = "failed";
          task.error = reason instanceof Error ? reason.message : "连接中断，正在重试查询…";
          this.publish();
        }
        if (task.state === "copying" && !this.disposed) await this.delay();
      }
    } finally { this.running.delete(task.requestId); }
  }
}
