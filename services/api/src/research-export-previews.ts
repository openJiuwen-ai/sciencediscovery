// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { setImmediate } from "node:timers/promises";
import type { ResearchPackageExportProfile } from "@sciencediscovery/research-package";
import { ApiStatusError } from "./http/api-status-error.js";

export type ExportPreviewOptions = { projectId: string; sessionId?: string; level: "necessary" | "complete"; selectedFiles?: Set<string>; includeFullTrajectory: boolean; includeFullMemoryGraph?: boolean };
export type ResearchExportPreview = { revision: string; estimatedBytes: number; estimateKind: "uncompressed"; files: Array<{ path: string; size: number; selected?: boolean }>; omissions: string[]; exportProfile?: ResearchPackageExportProfile };
export type DefaultExportPreviews = {
  revision: string;
  necessary: ResearchExportPreview;
  complete: ResearchExportPreview;
  completeWithTrajectory: ResearchExportPreview;
  completeWithMemoryGraph: ResearchExportPreview;
  completeWithTrajectoryAndMemoryGraph: ResearchExportPreview;
};
type WarmMemo = { revision?: string; allowed?: boolean; pendingRevision?: string; pending?: Promise<boolean> };
const WATCH_IDLE_MS = 30_000;

/** Bounded metadata cache and serial work queue; never retain an export payload. */
export class ResearchExportPreviews {
  private readonly entries = new Map<string, Promise<ResearchExportPreview>>();
  private readonly completed = new WeakMap<Promise<ResearchExportPreview>, ResearchExportPreview>();
  private readonly watching = new Map<string, { projectId: string; sessionId: string; lastSeenAt: number }>();
  private readonly revisions = new Map<string, Promise<string>>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private ticking = false;
  constructor(private readonly revision: (projectId: string, sessionId?: string) => Promise<string>,
    private readonly calculate: (options: ExportPreviewOptions, revision: string) => Promise<ResearchExportPreview>,
    private readonly canWarm: (projectId: string, sessionId: string) => Promise<boolean> = async () => true,
    private readonly now: () => number = () => Date.now()) {}

  private currentRevision(projectId: string, sessionId?: string): Promise<string> {
    const key = JSON.stringify([projectId, sessionId]);
    const existing = this.revisions.get(key);
    if (existing) return existing;
    const work = this.revision(projectId, sessionId);
    this.revisions.set(key, work);
    void work.finally(() => { if (this.revisions.get(key) === work) this.revisions.delete(key); }).catch(() => undefined);
    return work;
  }

  private key(options: ExportPreviewOptions, revision: string): string {
    return JSON.stringify([options.projectId, options.sessionId, revision, options.level,
      options.level === "complete" && options.includeFullTrajectory,
      options.level === "complete" && options.includeFullMemoryGraph,
      options.selectedFiles ? [...options.selectedFiles].sort() : null]);
  }

  private remember(key: string, work: Promise<ResearchExportPreview>): void {
    this.entries.set(key, work);
    while (this.entries.size > 192) this.entries.delete(this.entries.keys().next().value!);
  }

  watch(projectId: string, sessionId: string): void {
    if (this.closed) return;
    const key = JSON.stringify([projectId, sessionId]);
    this.watching.delete(key);
    this.watching.set(key, { projectId, sessionId, lastSeenAt: this.now() });
    if (this.watching.size > 16) this.watching.delete(this.watching.keys().next().value!);
    void this.warm(projectId, sessionId).catch(() => undefined);
  }

  private async warm(projectId: string, sessionId: string): Promise<void> {
    // Chat owns the runtime while evidence is changing. Keep watching and warm
    // the terminal revision later, without repeatedly exporting an active run.
    if (this.closed || !await this.canWarm(projectId, sessionId)) return;
    await this.defaults(projectId, sessionId, true, { allowed: true });
  }

  private async assertCanCalculate(options: ExportPreviewOptions, deferWhileRunning: boolean, memo?: WarmMemo): Promise<string | undefined> {
    if (this.closed) throw new Error("Export preview service is closed");
    if (!deferWhileRunning || !options.sessionId) return undefined;
    const current = await this.currentRevision(options.projectId, options.sessionId);
    let allowed: boolean;
    if (memo?.revision === current && memo.allowed !== undefined) allowed = memo.allowed;
    else if (memo && memo.revision === undefined && memo.allowed !== undefined) allowed = memo.allowed;
    else if (memo?.pendingRevision === current && memo.pending) allowed = await memo.pending;
    else {
      const pending = this.canWarm(options.projectId, options.sessionId);
      if (memo) { memo.pendingRevision = current; memo.pending = pending; }
      allowed = await pending;
      if (memo?.pending === pending) { memo.revision = current; memo.allowed = allowed; memo.pending = undefined; }
    }
    if (!allowed) throw new ApiStatusError(409, "Export preview is pending", "EXPORT_PREVIEW_PENDING");
    return current;
  }

  async get(options: ExportPreviewOptions, deferWhileRunning = false, memo?: WarmMemo): Promise<ResearchExportPreview> {
    const admitted = await this.assertCanCalculate(options, deferWhileRunning, memo);
    if (this.closed) throw new Error("Export preview service is closed");
    const revision = admitted ?? await this.currentRevision(options.projectId, options.sessionId);
    if (this.closed) throw new Error("Export preview service is closed");
    const key = this.key(options, revision);
    const cached = this.entries.get(key);
    if (cached) return cached;
    const work = this.queue.then(async () => {
      await setImmediate();
      if (this.closed) throw new Error("Export preview service is closed");
      // Recheck when admitted: a newer reply may have arrived while queued.
      for (let attempt = 0; attempt < 3; attempt++) {
        // A run may start after an idle poll queued all five profiles. Stop
        // those jobs here, rather than repeatedly exporting changing evidence.
        await this.assertCanCalculate(options, deferWhileRunning, memo);
        const current = await this.currentRevision(options.projectId, options.sessionId);
        // An older queued request may already have calculated this revision.
        // Only consume completed work here: awaiting later queue entries deadlocks.
        const existing = this.entries.get(this.key(options, current));
        const ready = existing && this.completed.get(existing);
        if (ready) return ready;
        const result = await this.calculate(options, current);
        await this.assertCanCalculate(options, deferWhileRunning, memo);
        if (this.closed) throw new Error("Export preview service is closed");
        if (current === await this.currentRevision(options.projectId, options.sessionId)) {
          // Work admitted for an older revision may finish at a newer one.
          // Publish under that revision too so the next poll reuses it.
          const currentKey = this.key(options, current);
          this.completed.set(work, result);
          this.remember(currentKey, work);
          return result;
        }
        await setImmediate();
      }
      throw new ApiStatusError(409, "Export preview is pending", "EXPORT_PREVIEW_PENDING");
    });
    this.queue = work.catch(() => undefined);
    this.remember(key, work);
    void work.catch(() => { if (this.entries.get(key) === work) this.entries.delete(key); });
    return work;
  }

  async defaults(projectId: string, sessionId: string, deferWhileRunning = false, memo: WarmMemo = {}): Promise<DefaultExportPreviews> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const [necessary, complete, completeWithTrajectory, completeWithMemoryGraph, completeWithTrajectoryAndMemoryGraph] = await Promise.all([
        this.get({ projectId, sessionId, level: "necessary", includeFullTrajectory: false, includeFullMemoryGraph: false }, deferWhileRunning, memo),
        this.get({ projectId, sessionId, level: "complete", includeFullTrajectory: false, includeFullMemoryGraph: false }, deferWhileRunning, memo),
        this.get({ projectId, sessionId, level: "complete", includeFullTrajectory: true, includeFullMemoryGraph: false }, deferWhileRunning, memo),
        this.get({ projectId, sessionId, level: "complete", includeFullTrajectory: false, includeFullMemoryGraph: true }, deferWhileRunning, memo),
        this.get({ projectId, sessionId, level: "complete", includeFullTrajectory: true, includeFullMemoryGraph: true }, deferWhileRunning, memo),
      ]);
      if ([complete, completeWithTrajectory, completeWithMemoryGraph, completeWithTrajectoryAndMemoryGraph].every((preview) => preview.revision === necessary.revision))
        return { revision: necessary.revision, necessary, complete, completeWithTrajectory, completeWithMemoryGraph, completeWithTrajectoryAndMemoryGraph };
    }
    throw new ApiStatusError(409, "Export preview is pending", "EXPORT_PREVIEW_PENDING");
  }

  async tick(): Promise<void> {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      const cutoff = this.now() - WATCH_IDLE_MS;
      for (const [key, watcher] of this.watching) if (watcher.lastSeenAt < cutoff) this.watching.delete(key);
      for (const { projectId, sessionId } of [...this.watching.values()].reverse()) {
        if (this.closed) break;
        try { await this.warm(projectId, sessionId); } catch { /* Retry on the next tick; never block chat. */ }
      }
    } finally { this.ticking = false; }
  }

  async close(): Promise<void> {
    this.closed = true; this.watching.clear(); this.entries.clear();
    // Finish admitted work before its store or workspace can be disposed.
    await Promise.allSettled([this.queue, ...this.revisions.values()]);
  }
}
