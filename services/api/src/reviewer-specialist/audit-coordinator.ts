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
import { cancelReviewerCheckpoints } from "@sciencediscovery/provenance";

import { SessionStore } from "../store.js";

const DEEP_AUTOMATIC_COOLDOWN_MS = 5 * 60_000;
const TERMINAL = new Set<ReviewerAuditTask["status"]>(["cancelled", "completed", "failed", "superseded"]);

export interface ReviewerAuditExecution {
  run(task: ReviewerAuditTask, signal: AbortSignal): Promise<ArtifactReviewRun[]>;
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
  private readonly draining = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly store: SessionStore,
    private readonly execution: ReviewerAuditExecution,
  ) {}

  async enqueueManual(sessionId: string, messageId: string): Promise<ReviewerAuditTask> {
    const settings = this.store.getReviewerSpecialistSettings();
    if (!settings.enabled) throw new Error("Reviewer Specialist is off");
    return await this.enqueue({
      artifactVersionIds: this.latestArtifactVersionIds(sessionId),
      checkpointMessageId: messageId,
      feedbackPolicy: settings.feedbackPolicy,
      origin: "manual",
      reviewLevel: settings.level,
      sessionId,
    });
  }

  async enqueueArtifactVersion(input: {
    artifactVersionId: string;
    contentHash: string;
    mediaType: string;
    sessionId: string;
  }): Promise<ReviewerAuditTask | undefined> {
    const settings = this.store.getReviewerSpecialistSettings();
    if (!settings.enabled) return undefined;
    // Structured data is always checked deterministically. It must not spend a
    // Deep model call merely because the global selector currently says Deep.
    const reviewLevel: ReviewerSpecialistLevel = /(?:^|\/)json(?:;|$)/i.test(input.mediaType)
      ? "quick"
      : settings.level;
    const taskId = randomUUID();
    return await this.enqueue({
      artifactVersionIds: [input.artifactVersionId],
      checkpointMessageId: taskId,
      feedbackPolicy: settings.feedbackPolicy,
      origin: "artifact_registered",
      reviewLevel,
      sessionId: input.sessionId,
    });
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
        if (tasks.some((item) => item.status === "queued" || item.status === "running")) this.schedule(session.id);
      }
    }
  }

  async cancelSession(sessionId: string): Promise<void> {
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
  }

  private latestArtifactVersionIds(sessionId: string): string[] {
    return this.store.listArtifacts(sessionId)
      .filter((artifact) => artifact.createdInSessionId === sessionId)
      .flatMap((artifact) => this.store.listArtifactVersions(sessionId, artifact.id).at(-1) ?? [])
      .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((version) => version.id);
  }

  private async enqueue(input: {
    artifactVersionIds: string[];
    checkpointMessageId: string;
    feedbackPolicy: ReviewerFeedbackPolicy;
    origin: ReviewerAuditTask["origin"];
    reviewLevel: ReviewerSpecialistLevel;
    sessionId: string;
  }): Promise<ReviewerAuditTask> {
    if (!input.artifactVersionIds.length) throw new Error("No Artifacts to review");
    const now = new Date().toISOString();
    const taskId = randomUUID();
    const inputFingerprint = fingerprint({
      artifactVersionIds: input.artifactVersionIds,
      feedbackPolicy: input.feedbackPolicy,
      ...(input.origin === "manual" ? { manualRequest: input.checkpointMessageId } : {}),
      origin: input.origin,
      reviewLevel: input.reviewLevel,
      version: 1,
    });
    const existing = await this.store.listReviewerAuditTasks(input.sessionId);
    let notBefore: string | undefined;
    if (input.origin === "artifact_registered" && input.reviewLevel === "deep") {
      const latestDeep = existing.filter((task) => task.origin === "artifact_registered" && task.reviewLevel === "deep"
        && task.status === "completed" && task.finishedAt)
        .toSorted((left, right) => (right.finishedAt ?? "").localeCompare(left.finishedAt ?? ""))[0];
      if (latestDeep?.finishedAt) {
        const earliest = new Date(new Date(latestDeep.finishedAt).getTime() + DEEP_AUTOMATIC_COOLDOWN_MS);
        if (earliest.getTime() > Date.now()) notBefore = earliest.toISOString();
      }
    }
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

    // A newly registered version makes an older automatic version stale. It
    // cannot keep consuming a model slot after a newer result exists.
    if (input.origin === "artifact_registered") {
      for (const old of existing.filter((candidate) => candidate.origin === "artifact_registered"
        && !TERMINAL.has(candidate.status) && candidate.id !== task.id)) {
        this.active.get(old.id)?.abort();
        await this.store.updateReviewerAuditTask(input.sessionId, old.id, {
          finishedAt: now,
          status: "superseded",
          supersededBy: task.id,
        });
      }
    }
    await this.store.appendReviewerCheckpointMessage(input.sessionId, input.checkpointMessageId, task.toolCallId);
    this.schedule(input.sessionId);
    return task;
  }

  private schedule(sessionId: string, delayMs = 0): void {
    if (this.draining.has(sessionId) || this.timers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      void this.drain(sessionId);
    }, Math.max(0, delayMs));
    this.timers.set(sessionId, timer);
  }

  private async drain(sessionId: string): Promise<void> {
    if (this.draining.has(sessionId)) return;
    this.draining.add(sessionId);
    let delayedUntil: number | undefined;
    try {
      while (true) {
        const task = (await this.store.listReviewerAuditTasks(sessionId))
          .filter((item) => item.status === "queued")
          .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
        if (!task) return;
        if (task.notBefore && new Date(task.notBefore).getTime() > Date.now()) {
          delayedUntil = new Date(task.notBefore).getTime();
          return;
        }
        if (task.origin === "artifact_registered" && !this.isCurrentVersion(sessionId, task.artifactVersionIds)) {
          await this.store.updateReviewerAuditTask(sessionId, task.id, {
            finishedAt: new Date().toISOString(), status: "superseded",
          });
          continue;
        }
        const running = await this.store.updateReviewerAuditTask(sessionId, task.id, {
          startedAt: new Date().toISOString(), status: "running",
        });
        if (running.status !== "running") continue;
        const controller = new AbortController();
        this.active.set(task.id, controller);
        try {
          const reviews = await this.execution.run(running, controller.signal);
          const settled = await this.store.listReviewerAuditTasks(sessionId);
          if (settled.find((item) => item.id === task.id)?.status === "cancelled") continue;
          const reviewIds = reviews.map((review) => review.id);
          await this.store.updateReviewerAuditTask(sessionId, task.id, {
            finishedAt: new Date().toISOString(), reviewIds, status: "completed",
          });
          await this.store.appendReviewFeedback(this.feedbackFor(running, reviews));
        } catch (error) {
          const cancelled = controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
          const current = (await this.store.listReviewerAuditTasks(sessionId)).find((item) => item.id === task.id);
          if (!current || TERMINAL.has(current.status)) continue;
          await this.store.updateReviewerAuditTask(sessionId, task.id, {
            errorSummary: cancelled ? "Review cancelled by user" : (error instanceof Error ? error.message : "Reviewer Specialist failed"),
            finishedAt: new Date().toISOString(),
            status: cancelled ? "cancelled" : "failed",
          });
        } finally {
          this.active.delete(task.id);
        }
      }
    } finally {
      this.draining.delete(sessionId);
      if (delayedUntil !== undefined) this.schedule(sessionId, delayedUntil - Date.now());
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
    const feedbackFingerprint = fingerprint({ artifactVersionIds: task.artifactVersionIds, reviewIds: reviews.map((review) => review.id), policy: task.feedbackPolicy });
    const recordedOnly = task.feedbackPolicy === "record";
    return {
      artifactVersionIds: task.artifactVersionIds,
      ...(recordedOnly ? { consumedAt: new Date().toISOString() } : {}),
      createdAt: new Date().toISOString(),
      feedbackFingerprint,
      id: randomUUID(),
      findings: findings.slice(0, 12).map((finding) => ({
        code: finding.code,
        evidenceRefs: finding.evidenceRefs.slice(0, 8),
        message: finding.message.slice(0, 500),
        severity: finding.severity,
      })),
      policy: task.feedbackPolicy,
      reviewIds: reviews.map((review) => review.id),
      sessionId: task.sessionId,
      status: recordedOnly ? "consumed" : "ready",
      summary: { critical, inconclusive, warning },
      taskId: task.id,
    };
  }
}
