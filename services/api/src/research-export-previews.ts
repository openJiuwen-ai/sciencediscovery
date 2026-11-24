// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { setImmediate } from "node:timers/promises";
import type { ResearchPackageExportProfile } from "@sciencediscovery/research-package";
import { ApiStatusError } from "./http/api-status-error.js";

export type ExportPreviewOptions = { projectId: string; sessionId?: string; level: "necessary" | "complete"; selectedFiles?: Set<string>; includeFullTrajectory: boolean; includeFullMemoryGraph?: boolean };
export type ResearchExportPreview = {
  revision: string; estimatedBytes: number; estimateKind: "uncompressed";
  files: Array<{ path: string; size: number; selected?: boolean }>; omissions: string[]; exportProfile?: ResearchPackageExportProfile;
  /** The one package cap (#1152). Additive: older clients keep their own default. */
  maxBytes?: number;
  /** The exact uncompressed tar size this selection would produce, which is what a refusal is based on. */
  archiveBytes?: number;
  /**
   * Estimated size of the downloaded `.sdresearch` file, which is gzip-compressed.
   *
   * `estimatedBytes`, `archiveBytes` and `maxBytes` above all describe the
   * uncompressed archive and keep their meaning; this is the number the dialog
   * presents to the user, because it is the size of the file they actually save
   * (#1347). Additive, so an older client keeps showing what it always did.
   */
  downloadBytes?: number;
};
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

// There is deliberately no wall-clock budget on `defaults()`. A slow preview and a
// pathological one look identical from the clock: the first-install fixture in
// `research-package-http.test.ts` takes ~49 s for one dialog's five profiles, so a
// threshold low enough to cut a genuinely pathological preview also answers 202 to
// work that was about to finish. What the dialog needed was to stop lying about
// the wait — the client names its own cancellation and shows a retrying state —
// and what the service needed was to stop serialising every session behind one
// chain. A pending-for-slow rule has to key off queue starvation rather than
// elapsed time, and that is a separate change.

const isMissingPreviewFile = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";

/** A sibling Session changed this preview's dependency set; its own scope survives. */
class ExportPreviewInvalidatedError extends ApiStatusError {
  constructor() { super(409, "Export preview is pending", "EXPORT_PREVIEW_PENDING"); }
}

/**
 * One revision walk per preview request.
 *
 * A preview used to read the whole session tree three times per profile: once at
 * admission, once when the queued work started, and once after the build to prove
 * the evidence had not moved (#1365). The five default profiles multiplied that to
 * fifteen walks per dialog. The first read is now the request's snapshot, shared by
 * every profile; the build reports when its own workspace reconcile wrote evidence,
 * and only then does the request take a second walk and retry under the new revision.
 * A preview that writes nothing therefore costs exactly one walk.
 */
class PreviewRevisionScope {
  private initialRead?: Promise<string>;
  private latestRead?: Promise<string>;

  constructor(private readonly read: (projectId: string, sessionId?: string) => Promise<string>) {}

  initial(projectId: string, sessionId?: string): Promise<string> {
    return this.initialRead ??= this.read(projectId, sessionId);
  }

  latest(projectId: string, sessionId?: string): Promise<string> {
    if (this.latestRead) return this.latestRead;
    const work = this.read(projectId, sessionId);
    this.latestRead = work;
    void work.catch(() => { if (this.latestRead === work) this.latestRead = undefined; });
    return work;
  }

  /** A profile observed a newer revision; later profiles start from it. */
  adopt(revision: string): void {
    this.initialRead = Promise.resolve(revision);
    this.latestRead = undefined;
  }

  /** A sibling deletion invalidated the snapshot; the retry must read it again. */
  invalidate(): void {
    this.initialRead = undefined;
    this.latestRead = undefined;
  }
}

/** Scope key the package builder sets when its reconcile actually wrote evidence. */
export const PREVIEW_EVIDENCE_MUTATED = "previewEvidenceMutated";

const serviceClosed = () => new ApiStatusError(503, "Export preview service is closed", "EXPORT_PREVIEW_SERVICE_CLOSED");

/** Bounded metadata cache and serial work queue; never retain an export payload. */
export class ResearchExportPreviews {
  private readonly entries = new Map<string, Promise<ResearchExportPreview>>();
  private readonly completed = new WeakMap<Promise<ResearchExportPreview>, ResearchExportPreview>();
  private readonly watching = new Map<string, { projectId: string; sessionId: string; lastSeenAt: number }>();
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
    /**
   * @param scope Opaque per-request state, created by `defaults()` for its five
   *   profiles. It exists so work that is only valid within one dialog request — the
   *   complete workspace listing — is shared across those five calls and cannot leak
   *   into the next request, where the workspace may have changed.
   */
  private readonly calculate: (options: ExportPreviewOptions, revision: string, signal: AbortSignal,
    scope?: Map<string, unknown>) => Promise<ResearchExportPreview>,
    private readonly canWarm: (projectId: string, sessionId: string) => Promise<boolean> = async () => true,
    private readonly now: () => number = () => Date.now()) {}

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

  watch(projectId: string, sessionId: string, warmNow = true): void {
    if (this.closed) return;
    const key = JSON.stringify([projectId, sessionId]);
    this.watching.delete(key);
    this.watching.set(key, { projectId, sessionId, lastSeenAt: this.now() });
    if (this.watching.size > 16) this.watching.delete(this.watching.keys().next().value!);
    // A panel asks for `defaults()` immediately after this call. Warming first
    // would spend a second evidence walk on the same request; the watcher is
    // registered here and later ticks still warm it.
    if (warmNow) void this.warm(projectId, sessionId).catch(() => undefined);
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

  private async assertCanCalculate(options: ExportPreviewOptions, deferWhileRunning: boolean, memo?: WarmMemo,
    request = new PreviewRevisionScope(this.revision)): Promise<string | undefined> {
    if (this.closed) throw serviceClosed();
    if (!deferWhileRunning || !options.sessionId) return undefined;
    const current = await request.initial(options.projectId, options.sessionId);
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

  async get(options: ExportPreviewOptions, deferWhileRunning = false, memo?: WarmMemo,
    scope?: Map<string, unknown>, request = new PreviewRevisionScope(this.revision)): Promise<ResearchExportPreview> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.getAttempt(options, deferWhileRunning, memo, scope, request); }
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
        // The request's revision snapshot predates the deletion; retrying with it
        // would calculate the same obsolete evidence again.
        request.invalidate();
      }
    }
  }

  private async getAttempt(options: ExportPreviewOptions, deferWhileRunning: boolean, memo?: WarmMemo,
    scope?: Map<string, unknown>, request = new PreviewRevisionScope(this.revision)): Promise<ResearchExportPreview> {
    const admitted = await this.assertCanCalculate(options, deferWhileRunning, memo, request);
    if (this.closed) throw serviceClosed();
    const requestScope = scope ?? new Map<string, unknown>();
    const revision = admitted ?? await request.initial(options.projectId, options.sessionId);
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
        // Do not reuse the admission memo: it was keyed on the request snapshot,
        // and a delayed profile must ask the store again before it starts work.
        await this.assertCanCalculate(options, deferWhileRunning, undefined, request);
        signal.throwIfAborted();
        // A sibling profile may already have adopted a newer snapshot while this
        // one was queued; reuse it rather than calculating obsolete evidence.
        const current = await request.initial(options.projectId, options.sessionId);
        // An older queued request may already have calculated this revision.
        // Only consume completed work here: awaiting later queue entries deadlocks.
        const currentKey = this.key(options, current);
        const existing = this.entries.get(currentKey);
        const ready = existing && this.completed.get(existing);
        if (ready) {
          // A queued sibling may have adopted a newer revision while this work
          // waited. Its pre-adoption key must not keep handing out that result.
          if (currentKey !== key && this.entries.get(key) === work) this.entries.delete(key);
          return ready;
        }
        requestScope.delete(PREVIEW_EVIDENCE_MUTATED);
        const result = await this.calculate(options, current, signal, requestScope);
        signal.throwIfAborted();
        await this.assertCanCalculate(options, deferWhileRunning, undefined, request);
        signal.throwIfAborted();
        if (this.closed) throw serviceClosed();
        if (requestScope.get(PREVIEW_EVIDENCE_MUTATED) === true) {
          // The build itself moved the revision (its workspace reconcile wrote
          // provenance). That is the one case that needs a fresh walk: retry
          // under the revision its own write produced.
          const latest = await request.latest(options.projectId, options.sessionId);
          signal.throwIfAborted();
          // The old key must not survive adoption: it would hand a caller who
          // asks for the old revision a result computed from the new evidence.
          const obsoleteKey = this.key(options, current);
          if (this.entries.get(obsoleteKey) === work) this.entries.delete(obsoleteKey);
          request.adopt(latest);
          await setImmediate();
          continue;
        }
        // The snapshot and the result agree: no post-build walk is needed. An
        // external change during the build is picked up by the next poll, which
        // asks for the new revision and does not hit this cache entry.
        // If a sibling adopted a newer revision while this profile was queued,
        // this work is published under the final key only; the pre-adoption key
        // it registered at admission must not alias that result.
        if (currentKey !== key && this.entries.get(key) === work) this.entries.delete(key);
        this.completed.set(work, result);
        this.remember(currentKey, work);
        return result;
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

  async defaults(projectId: string, sessionId: string, deferWhileRunning = false, memo: WarmMemo = {}): Promise<DefaultExportPreviews> {
    for (let attempt = 0; attempt < 3; attempt++) {
      // One scope per attempt: the five profiles below ask about the same workspace,
      // and it is the same request, so the scan and the catalog write happen once.
      // A retry gets a fresh scope.
      const scope = new Map<string, unknown>();
      // One revision snapshot for the whole dialog request: five profiles ask
      // about the same evidence, so re-walking the session tree per profile was
      // pure repetition (#1365).
      const request = new PreviewRevisionScope(this.revision);
      const [necessary, complete, completeWithTrajectory, completeWithMemoryGraph, completeWithTrajectoryAndMemoryGraph] = await Promise.all([
        this.get({ projectId, sessionId, level: "necessary", includeFullTrajectory: false, includeFullMemoryGraph: false }, deferWhileRunning, memo, scope, request),
        this.get({ projectId, sessionId, level: "complete", includeFullTrajectory: false, includeFullMemoryGraph: false }, deferWhileRunning, memo, scope, request),
        this.get({ projectId, sessionId, level: "complete", includeFullTrajectory: true, includeFullMemoryGraph: false }, deferWhileRunning, memo, scope, request),
        this.get({ projectId, sessionId, level: "complete", includeFullTrajectory: false, includeFullMemoryGraph: true }, deferWhileRunning, memo, scope, request),
        this.get({ projectId, sessionId, level: "complete", includeFullTrajectory: true, includeFullMemoryGraph: true }, deferWhileRunning, memo, scope, request),
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
    await Promise.allSettled([...this.queues.values()]);
  }
}
