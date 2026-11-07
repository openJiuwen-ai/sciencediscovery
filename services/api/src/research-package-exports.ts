// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export type ResearchPackageExportOptions = {
  projectId: string;
  sessionId?: string;
  level: "necessary" | "complete";
  selectedFiles?: string[];
  includeFullTrajectory: boolean;
  includeFullMemoryGraph: boolean;
  revision: string;
};
export type ResearchPackageExportStatus = {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  filename: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
};
type StoredTask = ResearchPackageExportStatus & { projectId: string; outputPath?: string };
const RETENTION_MS = 24 * 60 * 60 * 1000;

/** Runs heavyweight package creation independently of the browser request. */
export class ResearchPackageExports {
  private readonly tasks = new Map<string, StoredTask>();
  private queue: Promise<void> = Promise.resolve();
  private ready?: Promise<void>;

  constructor(
    private readonly root: string,
    private readonly currentRevision: (projectId: string, sessionId?: string) => Promise<string>,
    private readonly createPackage: (options: ResearchPackageExportOptions) => Promise<Uint8Array>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private timestamp(): string { return new Date(this.now()).toISOString(); }

  private isExpired(task: StoredTask): boolean {
    const updatedAt = Date.parse(task.updatedAt);
    return !Number.isFinite(updatedAt) || this.now() - updatedAt > RETENTION_MS;
  }

  private async removeTaskFiles(id: string): Promise<void> {
    await Promise.all([
      rm(resolve(this.root, `${id}.json`), { force: true }),
      rm(resolve(this.root, `${id}.sdresearch`), { force: true }),
    ]);
  }

  private async pruneExpiredTasks(): Promise<void> {
    for (const task of [...this.tasks.values()]) {
      if (!this.isExpired(task)) continue;
      this.tasks.delete(task.id);
      await this.removeTaskFiles(task.id);
    }
  }

  private initialize(): Promise<void> {
    return this.ready ??= (async () => {
      await mkdir(this.root, { recursive: true });
      for (const name of await readdir(this.root)) {
        if (!name.endsWith(".json")) continue;
        const metadataPath = resolve(this.root, name);
        let task: StoredTask;
        try { task = JSON.parse(await readFile(metadataPath, "utf8")) as StoredTask; }
        catch { await rm(metadataPath, { force: true }); continue; }
        if (!/^[a-f0-9-]{36}$/.test(task.id ?? "")) { await rm(metadataPath, { force: true }); continue; }
        if (this.isExpired(task)) {
          await this.removeTaskFiles(task.id);
          continue;
        }
        if (task.status === "queued" || task.status === "running") {
          task = { ...task, status: "failed", error: "服务重启时导出尚未完成，请重新导出。", updatedAt: this.timestamp() };
          await this.persist(task);
        }
        if (task.status === "completed") {
          try { await stat(resolve(this.root, `${task.id}.sdresearch`)); task.outputPath = resolve(this.root, `${task.id}.sdresearch`); }
          catch { task = { ...task, status: "failed", error: "导出文件已过期，请重新导出。" }; }
        }
        this.tasks.set(task.id, task);
      }
    })();
  }

  private async persist(task: StoredTask): Promise<void> {
    const temporary = resolve(this.root, `${task.id}.json.tmp`);
    await writeFile(temporary, JSON.stringify({ ...task, outputPath: undefined }), "utf8");
    await rename(temporary, resolve(this.root, `${task.id}.json`));
  }

  async start(options: ResearchPackageExportOptions, filename: string): Promise<ResearchPackageExportStatus> {
    await this.initialize();
    await this.pruneExpiredTasks();
    const now = this.timestamp(), id = randomUUID();
    const active = [...this.tasks.values()].filter((task) => task.status === "queued" || task.status === "running").length;
    if (active >= 8) throw new Error("后台证据包导出任务较多，请稍后重试。");
    const task: StoredTask = { id, status: "queued", projectId: options.projectId, filename, createdAt: now, updatedAt: now };
    this.tasks.set(id, task);
    await this.persist(task);
    const work = this.queue.then(() => this.run(task, structuredClone(options)));
    this.queue = work.catch(() => undefined);
    return this.publicTask(task);
  }

  private async run(task: StoredTask, options: ResearchPackageExportOptions): Promise<void> {
    try {
      task.status = "running"; task.updatedAt = this.timestamp(); await this.persist(task);
      const before = await this.currentRevision(options.projectId, options.sessionId);
      if (before !== options.revision) throw new Error("会话内容已更新，请使用最新大小预览重新导出。");
      const bytes = await this.createPackage(options);
      const after = await this.currentRevision(options.projectId, options.sessionId);
      if (after !== options.revision) throw new Error("导出期间会话内容发生变化，请基于最新内容重新导出。");
      const outputPath = resolve(this.root, `${task.id}.sdresearch`);
      await writeFile(outputPath, bytes, { flag: "wx" });
      task.status = "completed"; task.outputPath = outputPath; task.updatedAt = this.timestamp();
    } catch (reason) {
      task.status = "failed"; task.error = reason instanceof Error ? reason.message : "证据包导出失败，请重试。"; task.updatedAt = this.timestamp();
    }
    try { await this.persist(task); } catch { /* Task result remains available for this process. */ }
  }

  async get(id: string, projectId: string): Promise<ResearchPackageExportStatus | undefined> {
    await this.initialize();
    await this.pruneExpiredTasks();
    const task = this.tasks.get(id);
    return task?.projectId === projectId ? this.publicTask(task) : undefined;
  }

  async download(id: string, projectId: string): Promise<{ path: string; filename: string } | undefined> {
    await this.initialize();
    await this.pruneExpiredTasks();
    const task = this.tasks.get(id);
    if (!task || task.projectId !== projectId || task.status !== "completed" || !task.outputPath) return undefined;
    return { path: task.outputPath, filename: task.filename };
  }

  async close(): Promise<void> { await this.queue; }

  private publicTask(task: StoredTask): ResearchPackageExportStatus {
    const { id, status, filename, createdAt, updatedAt, error } = task;
    return { id, status, filename, createdAt, updatedAt, ...(error ? { error } : {}) };
  }
}
