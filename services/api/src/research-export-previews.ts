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

/**
 * How long a `defaults=1` request may hold its socket open before it answers the
 * pending contract instead.
 *
 * The five profiles a dialog asks for are not cheap on a long session — two of
 * them walk the whole trajectory closure, which has been measured at ~56 s each
 * — and the browser gives up anyway. Holding the request for a minute produces
 * a 200 that nobody receives, which is why the server log looked healthy while
 * the dialog showed a failure (#1140). Answering 202 with `Prefer: respond-async`
 * is the contract this route already implements and the client already maps to a
 * localized "still calculating, it will retry" message.
 *
 * The work itself keeps running on the queue and is memoized, so the next poll
 * usually finds it done instead of starting over.
 */
const DEFAULT_PREVIEW_BUDGET_MS = 20_000;

/**
 * Resolve `work` or answer the pending contract after `budgetMs`, whichever is
 * first. The abandoned work keeps a handler attached, so a late rejection is not
 * an unhandled one.
 */
async function withBudget<T>(work: Promise<T>, budgetMs: number): Promise<T> {
  if (budgetMs <= 0) return await work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ExportPreviewInvalidatedError()), budgetMs);
    timer.unref?.();
  });
  void work.catch(() => undefined);
  try {
    return await Promise.race([work, expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const isMissingPreviewFile = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";

/** A sibling Session changed this preview's dependency set; its own scope survives. */
class ExportPreviewInvalidatedError extends ApiStatusError {
  constructor() { super(409, "Export preview is pending", "EXPORT_PREVIEW_PENDING"); }
}

const serviceClosed = () => new ApiStatusError(503, "Export preview service is closed", "EXPORT_PREVIEW_SERVICE_CLOSED");

/** Bounded metadata cache and serial work queue; never retain an export payload. */
export class ResearchExportPreviews {
  private readonly entries = new Map<string, Promise<ResearchExportPreview>>();
  private readonly completed = new WeakMap<Promise<ResearchExportPreview>, ResearchExportPreview>();
  private readonly watching = new Map<string, { projectId: string; sessionId: string; lastSeenAt: number }>();
  private readonly revisions = new Map<string, Promise<string>>();
  private readonly controllers = new Map<AbortController, ExportPreviewOptions>();
  /**
   * One serial chain *per session*, not one for the whole service.
   *
   * The five profiles a dialog asks for share a session's evidence and must stay
   * ordered against each other — the intra-session hazard below (awaiting a
   * queue entry admitted later would deadlock) is unchanged, because within one
   * session the ordering is exactly what it was. What changes is that session A's
   * dialog no longer serialises behind session B's, and an aborted dialog cannot
   * make the next session wait behind work nobody wants (#1140 §7.5).
   */
  private readonly queues = new Map<string, Promise<unknown>>();
  private closed = false;
  private ticking = false;
  constructor(private readonly revision: (projectId: string, sessionId?: string) => Promise<string>,
    private readonly calculate: (options: ExportPreviewOptions, revision: string, signal: AbortSignal) => Promise<ResearchExportPreview>,
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
    // Preheat only the profile the dialog shows first. The other four are
    // complete-trajectory / complete-memory-graph materialisations of every
    // run stream and object; building them here queued five full exports per
    // watched session and per 3 s tick, enough to exhaust the default 4 GB
    // heap on large projects (#1085). They are computed on demand when the
    // export dialog asks for `defaults`.
    await this.get({ projectId, sessionId, level: "necessary", includeFullTrajectory: false, includeFullMemoryGraph: false }, true, { allowed: true });
  }

  private async assertCanCalculate(options: ExportPreviewOptions, deferWhileRunning: boolean, memo?: WarmMemo): Promise<string | undefined> {
    if (this.closed) throw serviceClosed();
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
    for (let attempt = 0; ; attempt++) {
      try { return await this.getAttempt(options, deferWhileRunning, memo); }
      catch (error) {
        // A run can begin after admission but before trajectory/CAS files are
        // published, so a read inside the preview can hit a file that is not on
        // disk yet. That is a retry, not a client error: an explicit preview used
        // to keep the raw ENOENT, which the server maps to 404 "File not found"
        // and a browser logs as a resource error — enough to red a @mocked
        // journey on its own (#1099). Both the warmed defaults and the explicit
        // previews now answer the pending contract the client already handles.
        if (isMissingPreviewFile(error)) {
          throw new ApiStatusError(409, "Export preview is pending", "EXPORT_PREVIEW_PENDING");
        }
        // Recompute once for a surviving scope after a sibling was deleted.
        // Repeated invalidation uses the existing pending HTTP/polling contract.
        if (!(error instanceof ExportPreviewInvalidatedError) || attempt >= 1) throw error;
      }
    }
  }

  private async getAttempt(options: ExportPreviewOptions, deferWhileRunning: boolean, memo?: WarmMemo): Promise<ResearchExportPreview> {
    const admitted = await this.assertCanCalculate(options, deferWhileRunning, memo);
    if (this.closed) throw serviceClosed();
    const revision = admitted ?? await this.currentRevision(options.projectId, options.sessionId);
    if (this.closed) throw serviceClosed();
    const key = this.key(options, revision);
    const cached = this.entries.get(key);
    if (cached) return cached;
    const controller = new AbortController();
    this.controllers.set(controller, options);
    const signal = controller.signal;
    const queueKey = `${options.projectId}:${options.sessionId ?? ""}`;
    const tail = this.queues.get(queueKey) ?? Promise.resolve();
    const work = tail.then(async () => {
      await setImmediate();
      signal.throwIfAborted();
      if (this.closed) throw serviceClosed();
      // Recheck when admitted: a newer reply may have arrived while queued.
      for (let attempt = 0; attempt < 3; attempt++) {
        // A run may start after an idle poll queued all five profiles. Stop
        // those jobs here, rather than repeatedly exporting changing evidence.
        await this.assertCanCalculate(options, deferWhileRunning, memo);
        signal.throwIfAborted();
        const current = await this.currentRevision(options.projectId, options.sessionId);
        signal.throwIfAborted();
        // An older queued request may already have calculated this revision.
        // Only consume completed work here: awaiting later queue entries deadlocks.
        const existing = this.entries.get(this.key(options, current));
        const ready = existing && this.completed.get(existing);
        if (ready) return ready;
        const result = await this.calculate(options, current, signal);
        signal.throwIfAborted();
        await this.assertCanCalculate(options, deferWhileRunning, memo);
        signal.throwIfAborted();
        if (this.closed) throw serviceClosed();
        const latest = await this.currentRevision(options.projectId, options.sessionId);
        signal.throwIfAborted();
        if (current === latest) {
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
    }).catch((error: unknown) => {
      // A concurrent deletion may make an awaited store read fail first.
      // Preserve the intentional cancellation outcome rather than that race.
      signal.throwIfAborted();
      throw error;
    });
    const next = work.catch(() => undefined);
    this.queues.set(queueKey, next);
    // Drop the chain once it is idle, so a long-lived service does not keep one
    // settled promise per session it has ever served.
    void next.then(() => { if (this.queues.get(queueKey) === next) this.queues.delete(queueKey); });
    this.remember(key, work);
    void work.finally(() => this.controllers.delete(controller)).catch(() => {
      if (this.entries.get(key) === work) this.entries.delete(key);
    });
    return work;
  }

  async defaults(projectId: string, sessionId: string, deferWhileRunning = false, memo: WarmMemo = {},
    budgetMs = DEFAULT_PREVIEW_BUDGET_MS): Promise<DefaultExportPreviews> {
    return await withBudget(this.defaultsWithin(projectId, sessionId, deferWhileRunning, memo), budgetMs);
  }

  private async defaultsWithin(projectId: string, sessionId: string, deferWhileRunning: boolean, memo: WarmMemo): Promise<DefaultExportPreviews> {
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

  cancel(projectId: string, sessionId?: string): void {
    for (const [key, watcher] of this.watching) {
      if (watcher.projectId === projectId && (!sessionId || watcher.sessionId === sessionId)) this.watching.delete(key);
    }
    for (const [controller, options] of this.controllers) {
      // Necessary previews of other sessions can depend on this session too.
      if (options.projectId === projectId) {
        const deleted = !sessionId || options.sessionId === sessionId;
        controller.abort(deleted
          ? new ApiStatusError(404, "Export preview resource was deleted", "EXPORT_PREVIEW_RESOURCE_DELETED")
          : new ExportPreviewInvalidatedError());
      }
    }
    for (const key of this.entries.keys()) {
      const [project] = JSON.parse(key) as [string];
      if (project === projectId) this.entries.delete(key);
    }
  }

  async close(): Promise<void> {
    this.closed = true; this.watching.clear(); this.entries.clear();
    for (const controller of this.controllers.keys()) controller.abort(serviceClosed());
    // Finish admitted work before its store or workspace can be disposed.
    await Promise.allSettled([...this.queues.values(), ...this.revisions.values()]);
  }
}
