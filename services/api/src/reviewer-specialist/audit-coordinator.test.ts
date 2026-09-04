// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import type { ArtifactReviewRun, ReviewerAuditTask } from "@sciencediscovery/schema";

import { SessionStore } from "../store.js";
import { ReviewerAuditCoordinator } from "./audit-coordinator.js";

async function waitFor(check: () => Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("Timed out waiting for reviewer task");
}

test("automatic audit is durable, non-blocking, and creates bounded feedback", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `reviewer-audit-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  await store.load();
  const project = await store.createProject("Reviewer task");
  const session = await store.createSession(project.id, "Audit", {}, {}, { allowUnconfiguredModel: true });
  await store.updateReviewerSpecialistSettings({ enabled: true, feedbackPolicy: "suggest", level: "quick" });
  const registered = await store.createArtifactVersion({
    content: { hash: "a".repeat(64), size: 3 },
    kind: "markdown",
    logicalName: "result.md",
    mediaType: "text/markdown",
    origin: "llm_declared",
    sessionId: session.id,
    sourcePath: "result.md",
  });
  let executions = 0;
  const coordinator = new ReviewerAuditCoordinator(store, {
    run: async (task: ReviewerAuditTask): Promise<ArtifactReviewRun[]> => {
      executions += 1;
      return [{
        artifactContentHash: registered.version.content.hash,
        artifactId: registered.artifact.id,
        artifactLogicalName: registered.artifact.logicalName,
        artifactVersionId: registered.version.id,
        checkpointId: task.id,
        createdAt: new Date().toISOString(),
        decision: "ACCEPT_AND_PROCEED",
        finishedAt: new Date().toISOString(),
        findings: [],
        id: `review-${task.id}`,
        reviewerSpecialistVersion: "test",
        reviewLevel: "quick",
        sessionId: task.sessionId,
        status: "completed",
        toolCallId: task.toolCallId,
      }];
    },
  });

  const task = await coordinator.enqueueArtifactVersion({
    artifactVersionId: registered.version.id,
    contentHash: registered.version.content.hash,
    mediaType: registered.version.mediaType,
    sessionId: session.id,
  });
  assert.ok(task, "registration returns once the task is persisted");
  assert.equal((await store.listReviewerAuditTasks(session.id))[0]?.id, task.id);
  await waitFor(async () => (await store.listReviewerAuditTasks(session.id))[0]?.status === "completed");
  assert.equal(executions, 1);
  const feedback = await store.listReviewFeedback(session.id);
  assert.deepEqual(feedback[0]?.summary, { critical: 0, inconclusive: 0, warning: 0 });
  assert.equal(feedback[0]?.policy, "suggest");
  assert.equal(feedback[0]?.status, "ready");
});

test("a newer automatic version supersedes a queued predecessor", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `reviewer-supersede-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  await store.load();
  const project = await store.createProject("Reviewer supersede");
  const session = await store.createSession(project.id, "Audit", {}, {}, { allowUnconfiguredModel: true });
  await store.updateReviewerSpecialistSettings({ enabled: true, level: "quick" });
  const first = await store.createArtifactVersion({
    content: { hash: "b".repeat(64), size: 1 }, kind: "markdown", logicalName: "report.md", mediaType: "text/markdown",
    origin: "llm_declared", sessionId: session.id, sourcePath: "report.md",
  });
  const second = await store.createArtifactVersion({
    content: { hash: "c".repeat(64), size: 2 }, kind: "markdown", logicalName: "report.md", mediaType: "text/markdown",
    origin: "llm_declared", sessionId: session.id, sourcePath: "report.md",
  });
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const coordinator = new ReviewerAuditCoordinator(store, { run: async () => { await gate; return []; } });
  const oldTask = await coordinator.enqueueArtifactVersion({ artifactVersionId: first.version.id, contentHash: first.version.content.hash, mediaType: first.version.mediaType, sessionId: session.id });
  const newTask = await coordinator.enqueueArtifactVersion({ artifactVersionId: second.version.id, contentHash: second.version.content.hash, mediaType: second.version.mediaType, sessionId: session.id });
  assert.ok(oldTask && newTask);
  await waitFor(async () => (await store.listReviewerAuditTasks(session.id)).some((task) => task.id === oldTask.id && task.status === "superseded"));
  release();
  await waitFor(async () => (await store.listReviewerAuditTasks(session.id)).some((task) => task.id === newTask.id && task.status === "completed"));
});
