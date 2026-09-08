// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

import { createHash, randomUUID } from "node:crypto";

import type {
  ArtifactReviewRun,
  ReviewerAuditTask,
  ReviewerFeedbackPolicy,
  ReviewerSpecialistLevel,
  ReviewFeedback,
} from "@sciencediscovery/schema";
import { cancelReviewerCheckpoints, isReviewerReportCandidate } from "@sciencediscovery/provenance";

import { SessionStore } from "../store.js";

const DEEP_AUTOMATIC_COOLDOWN_MS = 5 * 60_000;
const DEEP_BATCH_QUIET_MS = 2 * 60_000;
const QUICK_BATCH_QUIET_MS = 60_000;
const AUTOMATIC_RETRY_WHILE_MAIN_BUSY_MS = 15_000;
const READ_ONLY_FEEDBACK_POLICY: ReviewerFeedbackPolicy = "record";
const TERMINAL = new Set<ReviewerAuditTask["status"]>(["cancelled", "completed", "failed", "superseded"]);

export type ReviewerAuditExecutionResult = ArtifactReviewRun[] | { skipped: true };

export interface ReviewerAuditExecution {
  run(task: ReviewerAuditTask, signal: AbortSignal): Promise<ReviewerAuditExecutionResult>;
}

export interface ReviewerAuditScheduling {
  deepAutomaticCooldownMs?: number;
  deepBatchQuietMs?: number;
  /** Automatic audits are background work and must yield to a live lead Agent. */
  isMainAgentBusy?: (sessionId: string) => boolean | Promise<boolean>;
  mainAgentBusyRetryMs?: number;
  quickBatchQuietMs?: number;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function taskToolCallId(origin: ReviewerAuditTask["origin"], taskId: string, checkpointMessageId: string): string {
  // Keep the pre-existing manual UI's optimistic checkpoint identity stable.
  return `${origin === "manual" ? "manual-review" : "automatic-review"}:${origin === "manual" ? checkpointMessageId : taskId}`;
}

/**
 * Durable, per-session Reviewer task scheduler. The scheduler deliberately
 * owns no HTTP response: artifact registration and manual clicks persist a
 * task, return immediately, and this worker does the expensive work later.
 */
export class ReviewerAuditCoordinator {
  private readonly active = new Map<string, AbortController>();
  /** One automatic audit for the whole API process; manual review is not throttled here. */
  private automaticTaskId: string | undefined;
  private readonly draining = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly store: SessionStore,
    private readonly execution: ReviewerAuditExecution,
    private readonly scheduling: ReviewerAuditScheduling = {},
  ) {}

  async enqueueManual(sessionId: string, messageId: string): Promise<ReviewerAuditTask> {
    if (!this.store.getReviewerSpecialistSettings().enabled) throw new Error("Reviewer Specialist is off");
    const sessionSettings = this.store.getSessionReviewerSpecialistSettings(sessionId);
    return await this.createTask({
      artifactVersionIds: this.latestReportArtifactVersionIds(sessionId),
      checkpointMessageId: messageId,
      feedbackPolicy: READ_ONLY_FEEDBACK_POLICY,
      origin: "manual",
      reviewLevel: sessionSettings.level,
      sessionId,
    }, true);
  }

  async enqueueArtifactVersion(input: {
    artifactVersionId: string;
    contentHash: string;
    mediaType: string;
    sessionId: string;
  }): Promise<ReviewerAuditTask | undefined> {
    const version = this.store.getArtifactVersion(input.sessionId, input.artifactVersionId);
    const artifact = version ? this.store.getArtifact(input.sessionId, version.artifactId) : undefined;
    // An upload is valuable provenance and graph input, but it is not a
    // platform-produced scientific conclusion. Reviewer Specialist is scoped
    // to readable report deliverables, never code or data intermediates.
    if (!version || !artifact || artifact.origin !== "llm_declared" || !isReviewerReportCandidate(artifact, version)) return undefined;
    if (!this.store.getReviewerSpecialistSettings().enabled) return undefined;
    const sessionSettings = this.store.getSessionReviewerSpecialistSettings(input.sessionId);
    if (!sessionSettings.automaticReviewEnabled) return undefined;
    // Structured data is always checked deterministically. It must not spend a
    // Deep model call merely because this Session selected Deep.
    const reviewLevel: ReviewerSpecialistLevel = /(?:^|\/)json(?:;|$)/i.test(input.mediaType)
      ? "quick"
      : sessionSettings.level;
    const tasks = await this.store.listReviewerAuditTasks(input.sessionId);
    const pending = tasks.find((task) => task.origin === "artifact_registered"
      && task.status === "queued" && !task.checkpointPublishedAt);
    if (pending) {
      const artifactVersionIds = this.mergeLatestArtifactVersions(input.sessionId, [
        ...pending.artifactVersionIds,
        input.artifactVersionId,
      ]);
      const notBefore = this.automaticNotBefore(input.sessionId, pending.reviewLevel, tasks);
      const updated = await this.store.updateReviewerAuditTask(input.sessionId, pending.id, {
        artifactVersionIds,
        inputFingerprint: this.automaticFingerprint(artifactVersionIds, pending.feedbackPolicy, pending.reviewLevel),
        notBefore,
      });
      this.scheduleAt(input.sessionId, new Date(notBefore).getTime());
      return updated;
    }
    const checkpointMessageId = randomUUID();
    const artifactVersionIds = [input.artifactVersionId];
    const task = await this.createTask({
      artifactVersionIds,
      checkpointMessageId,
      feedbackPolicy: READ_ONLY_FEEDBACK_POLICY,
      origin: "artifact_registered",
      reviewLevel,
      sessionId: input.sessionId,
    }, false, this.automaticNotBefore(input.sessionId, reviewLevel, tasks));
    return task;
  }

  async resume(): Promise<void> {
    for (const project of this.store.listProjects()) {
      for (const session of this.store.listSessions(project.id, "all")) {
        const tasks = await this.store.listReviewerAuditTasks(session.id);
        for (const task of tasks.filter((item) => item.status === "running")) {
          await this.store.updateReviewerAuditTask(session.id, task.id, {
            errorSummary: "Reviewer service restarted; audit re-queued safely.",
            status: "queued",
          });
        }
        if (tasks.some((item) => item.status === "queued" || item.status === "running")) {
          // `drain` will respect the persisted notBefore timestamp, so restart
          // recovery never accidentally skips an automatic batch's quiet window.
          this.scheduleAt(session.id, Date.now());
        }
      }
    }
  }

  async cancelSession(sessionId: string): Promise<boolean> {
    const scheduled = this.timers.get(sessionId);
    if (scheduled) clearTimeout(scheduled);
    this.timers.delete(sessionId);
    const tasks = await this.store.listReviewerAuditTasks(sessionId);
    const now = new Date().toISOString();
    for (const task of tasks.filter((item) => item.status === "queued" || item.status === "running")) {
      this.active.get(task.id)?.abort();
      await this.store.updateReviewerAuditTask(sessionId, task.id, {
        errorSummary: "Review cancelled by user",
        finishedAt: now,
        status: "cancelled",
      });
    }
    // Retains compatibility with explicit checkpoint calls issued by the main
    // Agent while remaining fully independent from the main Agent Stop path.
    cancelReviewerCheckpoints(sessionId);
    return tasks.some((task) => task.status === "queued" || task.status === "running");
  }

  private latestReportArtifactVersionIds(sessionId: string): string[] {
    return this.store.listArtifacts(sessionId)
      .filter((artifact) => artifact.createdInSessionId === sessionId)
      .flatMap((artifact) => {
        const version = this.store.listArtifactVersions(sessionId, artifact.id).at(-1);
        return version && isReviewerReportCandidate(artifact, version) ? [version] : [];
      })
      .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((version) => version.id);
  }

  private async createTask(input: {
    artifactVersionIds: string[];
    checkpointMessageId: string;
    feedbackPolicy: ReviewerFeedbackPolicy;
    origin: ReviewerAuditTask["origin"];
    reviewLevel: ReviewerSpecialistLevel;
    sessionId: string;
  }, publishCheckpoint: boolean, notBefore?: string): Promise<ReviewerAuditTask> {
    if (!input.artifactVersionIds.length) throw new Error("No report artifacts to review");
    const now = new Date().toISOString();
    const taskId = randomUUID();
    const inputFingerprint = input.origin === "artifact_registered"
      ? this.automaticFingerprint(input.artifactVersionIds, input.feedbackPolicy, input.reviewLevel)
      : fingerprint({
        artifactVersionIds: input.artifactVersionIds,
        feedbackPolicy: input.feedbackPolicy,
        manualRequest: input.checkpointMessageId,
        origin: input.origin,
        reviewLevel: input.reviewLevel,
        version: 1,
      });
    const task: ReviewerAuditTask = {
      artifactVersionIds: [...input.artifactVersionIds],
      checkpointMessageId: input.checkpointMessageId,
      createdAt: now,
      feedbackPolicy: input.feedbackPolicy,
      id: taskId,
      inputFingerprint,
      ...(notBefore ? { notBefore } : {}),
      origin: input.origin,
      reviewLevel: input.reviewLevel,
      sessionId: input.sessionId,
      status: "queued",
      toolCallId: taskToolCallId(input.origin, taskId, input.checkpointMessageId),
    };
    const persisted = await this.store.createReviewerAuditTask(task);
    if (persisted.id !== task.id) return persisted;
    if (publishCheckpoint) await this.publishCheckpoint(task);
    this.scheduleAt(input.sessionId, notBefore ? new Date(notBefore).getTime() : Date.now());
    return task;
  }

  private automaticFingerprint(
    artifactVersionIds: string[],
    feedbackPolicy: ReviewerFeedbackPolicy,
    reviewLevel: ReviewerSpecialistLevel,
  ): string {
    return fingerprint({ artifactVersionIds, feedbackPolicy, origin: "artifact_registered", reviewLevel, version: 2 });
  }

  private automaticNotBefore(
    sessionId: string,
    reviewLevel: ReviewerSpecialistLevel,
    tasks: ReviewerAuditTask[],
  ): string {
    const quietMs = reviewLevel === "deep"
      ? this.scheduling.deepBatchQuietMs ?? DEEP_BATCH_QUIET_MS
      : this.scheduling.quickBatchQuietMs ?? QUICK_BATCH_QUIET_MS;
    let earliest = Date.now() + quietMs;
    if (reviewLevel === "deep") {
      const latestDeep = tasks.filter((task) => task.origin === "artifact_registered" && task.reviewLevel === "deep"
        && task.status === "completed" && task.finishedAt)
        .toSorted((left, right) => (right.finishedAt ?? "").localeCompare(left.finishedAt ?? ""))[0];
      if (latestDeep?.finishedAt) {
        earliest = Math.max(earliest, new Date(latestDeep.finishedAt).getTime()
          + (this.scheduling.deepAutomaticCooldownMs ?? DEEP_AUTOMATIC_COOLDOWN_MS));
      }
    }
    return new Date(earliest).toISOString();
  }

  private mergeLatestArtifactVersions(sessionId: string, versionIds: string[]): string[] {
    const latestByArtifactId = new Map<string, string>();
    for (const versionId of versionIds) {
      const version = this.store.getArtifactVersion(sessionId, versionId);
      const artifact = version ? this.store.getArtifact(sessionId, version.artifactId) : undefined;
      if (version && artifact && isReviewerReportCandidate(artifact, version)) latestByArtifactId.set(version.artifactId, version.id);
    }
    return [...latestByArtifactId.values()].toSorted((left, right) =>
      (this.store.getArtifactVersion(sessionId, left)?.createdAt ?? "")
        .localeCompare(this.store.getArtifactVersion(sessionId, right)?.createdAt ?? ""));
  }

  private async publishCheckpoint(task: ReviewerAuditTask): Promise<ReviewerAuditTask> {
    if (task.checkpointPublishedAt) return task;
    await this.store.appendReviewerCheckpointMessage(task.sessionId, task.checkpointMessageId, task.toolCallId);
    return await this.store.updateReviewerAuditTask(task.sessionId, task.id, {
      checkpointPublishedAt: new Date().toISOString(),
    });
  }

  private scheduleAt(sessionId: string, dueAt: number): void {
    const existing = this.timers.get(sessionId);
    if (existing) clearTimeout(existing);
    if (this.draining.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      void this.drain(sessionId);
    }, Math.max(0, dueAt - Date.now()));
    this.timers.set(sessionId, timer);
  }

  private async drain(sessionId: string): Promise<void> {
    if (this.draining.has(sessionId)) return;
    this.draining.add(sessionId);
    let delayedUntil: number | undefined;
    try {
      while (true) {
        const queued = (await this.store.listReviewerAuditTasks(sessionId))
          .filter((item) => item.status === "queued")
          .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
        if (!queued) return;
        const ready = (await this.store.listReviewerAuditTasks(sessionId))
          .filter((item) => item.status === "queued" && (!item.notBefore || new Date(item.notBefore).getTime() <= Date.now()))
          // A user-requested audit should never wait behind an automatic one
          // that is deliberately yielding to the main Agent.
          .toSorted((left, right) => (left.origin === right.origin
            ? left.createdAt.localeCompare(right.createdAt)
            : left.origin === "manual" ? -1 : 1))[0];
        if (!ready) {
          delayedUntil = new Date(queued.notBefore ?? Date.now()).getTime();
          return;
        }
        let task = ready;
        const reportVersionIds = this.mergeLatestArtifactVersions(sessionId, task.artifactVersionIds);
        if (!reportVersionIds.length) {
          await this.store.updateReviewerAuditTask(sessionId, task.id, {
            errorSummary: "No report artifacts were eligible for Reviewer Specialist",
            finishedAt: new Date().toISOString(),
            status: "superseded",
          });
          if (task.checkpointPublishedAt) {
            await this.store.updateReviewerCheckpointMessage(sessionId, task.checkpointMessageId, {
              content: "No report artifacts were eligible for review.", status: "completed",
            });
          }
          continue;
        }
        if (reportVersionIds.length !== task.artifactVersionIds.length
          || reportVersionIds.some((versionId, index) => versionId !== task.artifactVersionIds[index])) {
          task = await this.store.updateReviewerAuditTask(sessionId, task.id, {
            artifactVersionIds: reportVersionIds,
          });
        }
        if (task.origin === "artifact_registered" && !this.isCurrentVersion(sessionId, task.artifactVersionIds)) {
          await this.store.updateReviewerAuditTask(sessionId, task.id, {
            finishedAt: new Date().toISOString(), status: "superseded",
          });
          continue;
        }
        if (task.origin === "artifact_registered") {
          const sessionSettings = this.store.getSessionReviewerSpecialistSettings(sessionId);
          if (!this.store.getReviewerSpecialistSettings().enabled || !sessionSettings.automaticReviewEnabled) {
            await this.store.updateReviewerAuditTask(sessionId, task.id, {
              errorSummary: "Automatic review is disabled",
              finishedAt: new Date().toISOString(),
              status: "superseded",
            });
            continue;
          }
          // Automatic review is intentionally low priority: it never starts
          // while its Session's lead Agent has queued/running work, and the
          // one process-wide lane prevents separate Sessions from piling up
          // concurrent Deep model calls.
          if (this.automaticTaskId) {
            delayedUntil = Date.now() + (this.scheduling.mainAgentBusyRetryMs ?? AUTOMATIC_RETRY_WHILE_MAIN_BUSY_MS);
            return;
          }
          if (await this.scheduling.isMainAgentBusy?.(sessionId)) {
            delayedUntil = Date.now() + (this.scheduling.mainAgentBusyRetryMs ?? AUTOMATIC_RETRY_WHILE_MAIN_BUSY_MS);
            return;
          }
          // The await above lets another Session's drain run, so check the
          // shared lane again before admitting this background task.
          if (this.automaticTaskId) {
            delayedUntil = Date.now() + (this.scheduling.mainAgentBusyRetryMs ?? AUTOMATIC_RETRY_WHILE_MAIN_BUSY_MS);
            return;
          }
          this.automaticTaskId = task.id;
        }
        let controller: AbortController | undefined;
        try {
          // Keep admission inside the same guarded section as execution. A
          // storage failure while publishing the checkpoint or claiming the
          // task must still release the process-wide automatic lane.
          const published = await this.publishCheckpoint(task);
          const running = await this.store.updateReviewerAuditTask(sessionId, task.id, {
            startedAt: new Date().toISOString(), status: "running",
          });
          if (running.status !== "running") continue;
          controller = new AbortController();
          this.active.set(task.id, controller);
          const outcome = await this.execution.run({ ...running, checkpointPublishedAt: published.checkpointPublishedAt }, controller.signal);
          const settled = await this.store.listReviewerAuditTasks(sessionId);
          if (settled.find((item) => item.id === task.id)?.status === "cancelled") continue;
          if (!Array.isArray(outcome)) {
            // A queued automatic Artifact can be replaced/deleted between
            // debounce and admission. This is normal lifecycle churn, not a
            // failed review, so remove the transient card and do not create
            // lead-Agent feedback.
            await this.store.updateReviewerAuditTask(sessionId, task.id, {
              finishedAt: new Date().toISOString(), status: "superseded",
            });
            await this.store.deleteReviewerCheckpointMessage(sessionId, task.checkpointMessageId);
            continue;
          }
          const reviews = outcome;
          const reviewIds = reviews.map((review) => review.id);
          // Persist the handoff before declaring the task complete. Otherwise
          // a transient feedback-file failure can leave a completed task with
          // no ready feedback and no retry path.
          await this.store.appendReviewFeedback(this.feedbackFor(running, reviews));
          await this.store.updateReviewerAuditTask(sessionId, task.id, {
            finishedAt: new Date().toISOString(), reviewIds, status: "completed",
          });
        } catch (error) {
          const cancelled = Boolean(controller?.signal.aborted) || (error instanceof DOMException && error.name === "AbortError");
          const current = (await this.store.listReviewerAuditTasks(sessionId)).find((item) => item.id === task.id);
          if (!current || TERMINAL.has(current.status)) continue;
          await this.store.updateReviewerAuditTask(sessionId, task.id, {
            errorSummary: cancelled ? "Review cancelled by user" : (error instanceof Error ? error.message : "Reviewer Specialist failed"),
            finishedAt: new Date().toISOString(),
            status: cancelled ? "cancelled" : "failed",
          });
        } finally {
          if (controller) this.active.delete(task.id);
          if (this.automaticTaskId === task.id) this.automaticTaskId = undefined;
        }
      }
    } finally {
      this.draining.delete(sessionId);
      if (delayedUntil !== undefined) this.scheduleAt(sessionId, delayedUntil);
    }
  }

  private isCurrentVersion(sessionId: string, versionIds: string[]): boolean {
    return versionIds.every((versionId) => {
      const version = this.store.getArtifactVersion(sessionId, versionId);
      return Boolean(version && this.store.listArtifactVersions(sessionId, version.artifactId).at(-1)?.id === versionId);
    });
  }

  private feedbackFor(task: ReviewerAuditTask, reviews: ArtifactReviewRun[]): ReviewFeedback {
    const findings = reviews.flatMap((review) => review.findings);
    const critical = findings.filter((finding) => finding.severity === "critical").length;
    const warning = findings.filter((finding) => finding.severity === "warning").length;
    const inconclusive = reviews.filter((review) => review.smartStatus === "inconclusive").length;
    const feedbackFingerprint = fingerprint({
      artifactVersionIds: task.artifactVersionIds,
      policy: READ_ONLY_FEEDBACK_POLICY,
      reviewIds: reviews.map((review) => review.id),
    });
    return {
      artifactVersionIds: task.artifactVersionIds,
      createdAt: new Date().toISOString(),
      feedbackFingerprint,
      id: randomUUID(),
      findings: findings.slice(0, 12).map((finding) => ({
        code: finding.code,
        evidenceRefs: finding.evidenceRefs.slice(0, 8),
        message: finding.message.slice(0, 500),
        severity: finding.severity,
      })),
      policy: READ_ONLY_FEEDBACK_POLICY,
      reviewIds: reviews.map((review) => review.id),
      sessionId: task.sessionId,
      // Every completed review is handed to the lead Agent as read-only
      // evidence at the next user-request boundary.
      status: "ready",
      summary: { critical, inconclusive, warning },
      taskId: task.id,
    };
  }
}
