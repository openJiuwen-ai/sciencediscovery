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
  await store.updateReviewerSpecialistSettings({ enabled: true });
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
  }, { quickBatchQuietMs: 0 });

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
  assert.equal(feedback[0]?.policy, "record");
  assert.equal(feedback[0]?.status, "ready");
});

test("feedback persistence failure leaves the audit task failed instead of completed", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `reviewer-feedback-failure-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  await store.load();
  const project = await store.createProject("Reviewer feedback failure");
  const session = await store.createSession(project.id, "Audit", {}, {}, { allowUnconfiguredModel: true });
  await store.updateReviewerSpecialistSettings({ enabled: true });
  const registered = await store.createArtifactVersion({
    content: { hash: "1".repeat(64), size: 3 },
    kind: "markdown",
    logicalName: "result.md",
    mediaType: "text/markdown",
    origin: "llm_declared",
    sessionId: session.id,
    sourcePath: "result.md",
  });
  const originalAppend = store.appendReviewFeedback.bind(store);
  store.appendReviewFeedback = async (feedback) => {
    throw new Error("feedback write failed");
  };
  const coordinator = new ReviewerAuditCoordinator(store, {
    run: async (task): Promise<ArtifactReviewRun[]> => [{
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
    }],
  }, { quickBatchQuietMs: 0 });

  const task = await coordinator.enqueueArtifactVersion({
    artifactVersionId: registered.version.id,
    contentHash: registered.version.content.hash,
    mediaType: registered.version.mediaType,
    sessionId: session.id,
  });
  assert.ok(task);
  await waitFor(async () => (await store.listReviewerAuditTasks(session.id))[0]?.status === "failed");
  assert.equal((await store.listReviewerAuditTasks(session.id))[0]?.errorSummary, "feedback write failed");
  const checkpoint = (await store.getSessionDetail(session.id))?.messages.find((message) => message.id === task.checkpointMessageId);
  assert.equal(checkpoint?.reviewerCheckpoint?.status, "failed");
  assert.equal(checkpoint?.reviewerCheckpoint?.error, "feedback write failed");
  assert.deepEqual(await store.listReviewFeedback(session.id), []);
  store.appendReviewFeedback = originalAppend;
  const retry = await coordinator.enqueueArtifactVersion({
    artifactVersionId: registered.version.id,
    contentHash: registered.version.content.hash,
    mediaType: registered.version.mediaType,
    sessionId: session.id,
  });
  assert.ok(retry);
  assert.notEqual(retry.id, task.id, "a failed automatic audit must allow the same Artifact version to retry");
  await waitFor(async () => (await store.listReviewerAuditTasks(session.id)).some((item) => item.id === retry.id && item.status === "completed"));
});

test("automatic lane is released when checkpoint admission fails", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `reviewer-lane-failure-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  await store.load();
  const project = await store.createProject("Reviewer lane failure");
  const session = await store.createSession(project.id, "Audit", {}, {}, { allowUnconfiguredModel: true });
  await store.updateReviewerSpecialistSettings({ enabled: true });
  const first = await store.createArtifactVersion({
    content: { hash: "2".repeat(64), size: 1 }, kind: "markdown", logicalName: "first.md", mediaType: "text/markdown",
    origin: "llm_declared", sessionId: session.id, sourcePath: "first.md",
  });
  const second = await store.createArtifactVersion({
    content: { hash: "3".repeat(64), size: 1 }, kind: "markdown", logicalName: "second.md", mediaType: "text/markdown",
    origin: "llm_declared", sessionId: session.id, sourcePath: "second.md",
  });
  const originalAppend = store.appendReviewerCheckpointMessage.bind(store);
  let failOnce = true;
  store.appendReviewerCheckpointMessage = async (...args) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("checkpoint write failed");
    }
    return await originalAppend(...args);
  };
  let executions = 0;
  const coordinator = new ReviewerAuditCoordinator(store, {
    run: async () => {
      executions += 1;
      return [];
    },
  }, { quickBatchQuietMs: 0 });

  const firstTask = await coordinator.enqueueArtifactVersion({
    artifactVersionId: first.version.id,
    contentHash: first.version.content.hash,
    mediaType: first.version.mediaType,
    sessionId: session.id,
  });
  assert.ok(firstTask);
  await waitFor(async () => (await store.listReviewerAuditTasks(session.id))[0]?.status === "failed");
  const secondTask = await coordinator.enqueueArtifactVersion({
    artifactVersionId: second.version.id,
    contentHash: second.version.content.hash,
    mediaType: second.version.mediaType,
    sessionId: session.id,
  });
  assert.ok(secondTask);
  await waitFor(async () => (await store.listReviewerAuditTasks(session.id)).some((item) => item.id === secondTask.id && item.status === "completed"));
  assert.equal(executions, 1);
  store.appendReviewerCheckpointMessage = originalAppend;
});

test("automatic audit batches artifacts and retains only each Artifact's newest queued version", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `reviewer-batch-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  await store.load();
  const project = await store.createProject("Reviewer batch");
  const session = await store.createSession(project.id, "Audit", {}, {}, { allowUnconfiguredModel: true });
  await store.updateReviewerSpecialistSettings({ enabled: true });
  const first = await store.createArtifactVersion({
    content: { hash: "b".repeat(64), size: 1 }, kind: "markdown", logicalName: "report.md", mediaType: "text/markdown",
    origin: "llm_declared", sessionId: session.id, sourcePath: "report.md",
  });
  const second = await store.createArtifactVersion({
    content: { hash: "c".repeat(64), size: 2 }, kind: "markdown", logicalName: "report.md", mediaType: "text/markdown",
    origin: "llm_declared", sessionId: session.id, sourcePath: "report.md",
  });
  const summary = await store.createArtifactVersion({
    content: { hash: "d".repeat(64), size: 2 }, kind: "other", logicalName: "summary.txt", mediaType: "text/plain",
    origin: "llm_declared", sessionId: session.id, sourcePath: "summary.txt",
  });
  let executed: ReviewerAuditTask | undefined;
  const coordinator = new ReviewerAuditCoordinator(store, {
    run: async (task) => { executed = task; return []; },
  }, { quickBatchQuietMs: 100 });
  const firstTask = await coordinator.enqueueArtifactVersion({ artifactVersionId: first.version.id, contentHash: first.version.content.hash, mediaType: first.version.mediaType, sessionId: session.id });
  const updatedTask = await coordinator.enqueueArtifactVersion({ artifactVersionId: second.version.id, contentHash: second.version.content.hash, mediaType: second.version.mediaType, sessionId: session.id });
  const ignoredText = await coordinator.enqueueArtifactVersion({ artifactVersionId: summary.version.id, contentHash: summary.version.content.hash, mediaType: summary.version.mediaType, sessionId: session.id });
  assert.ok(firstTask && updatedTask);
  assert.equal(ignoredText, undefined, "plain text is not automatically treated as a report deliverable");
  assert.equal(firstTask.id, updatedTask.id);
  assert.deepEqual(updatedTask.artifactVersionIds, [second.version.id]);
  await waitFor(async () => (await store.listReviewerAuditTasks(session.id))[0]?.status === "completed");
  assert.deepEqual(executed?.artifactVersionIds, [second.version.id]);
});

test("a generated Artifact registered during a running audit waits for the next batch", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `reviewer-next-batch-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  await store.load();
  const project = await store.createProject("Reviewer next batch");
  const session = await store.createSession(project.id, "Audit", {}, {}, { allowUnconfiguredModel: true });
  await store.updateReviewerSpecialistSettings({ enabled: true });
  const first = await store.createArtifactVersion({
    content: { hash: "e".repeat(64), size: 1 }, kind: "markdown", logicalName: "first.md", mediaType: "text/markdown",
    origin: "llm_declared", sessionId: session.id, sourcePath: "first.md",
  });
  const second = await store.createArtifactVersion({
    content: { hash: "f".repeat(64), size: 1 }, kind: "markdown", logicalName: "second.md", mediaType: "text/markdown",
    origin: "llm_declared", sessionId: session.id, sourcePath: "second.md",
  });
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const executions: string[][] = [];
  const coordinator = new ReviewerAuditCoordinator(store, {
    run: async (task) => {
      executions.push(task.artifactVersionIds);
      if (executions.length === 1) await gate;
      return [];
    },
  }, { quickBatchQuietMs: 0 });
  const active = await coordinator.enqueueArtifactVersion({ artifactVersionId: first.version.id, contentHash: first.version.content.hash, mediaType: first.version.mediaType, sessionId: session.id });
  assert.ok(active);
  await waitFor(async () => (await store.listReviewerAuditTasks(session.id)).some((task) => task.id === active.id && task.status === "running"));
  const following = await coordinator.enqueueArtifactVersion({ artifactVersionId: second.version.id, contentHash: second.version.content.hash, mediaType: second.version.mediaType, sessionId: session.id });
  assert.ok(following);
  assert.notEqual(following.id, active.id);
  assert.equal((await store.listReviewerAuditTasks(session.id)).find((task) => task.id === active.id)?.status, "running");
  release();
  await waitFor(async () => (await store.listReviewerAuditTasks(session.id)).every((task) => task.status === "completed"));
  assert.deepEqual(executions, [[first.version.id], [second.version.id]]);
});

test("a generated Artifact registered while drain is exiting schedules a new wakeup", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `reviewer-exit-wakeup-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  await store.load();
  const project = await store.createProject("Reviewer exit wakeup");
  const session = await store.createSession(project.id, "Audit", {}, {}, { allowUnconfiguredModel: true });
  await store.updateReviewerSpecialistSettings({ enabled: true });
  const first = await store.createArtifactVersion({
    content: { hash: "1".repeat(64), size: 1 }, kind: "markdown", logicalName: "first.md", mediaType: "text/markdown",
    origin: "llm_declared", sessionId: session.id, sourcePath: "first.md",
  });
  const second = await store.createArtifactVersion({
    content: { hash: "2".repeat(64), size: 1 }, kind: "markdown", logicalName: "second.md", mediaType: "text/markdown",
    origin: "llm_declared", sessionId: session.id, sourcePath: "second.md",
  });
  let executions = 0;
  const coordinator = new ReviewerAuditCoordinator(store, { run: async () => { executions += 1; return []; } }, { quickBatchQuietMs: 0 });
  const originalList = store.listReviewerAuditTasks.bind(store);
  let registeredAtExit = false;
  store.listReviewerAuditTasks = async (sessionId) => {
    const tasks = await originalList(sessionId);
    if (!registeredAtExit && executions === 1 && tasks.every((task) => task.status !== "queued" && task.status !== "running")) {
      registeredAtExit = true;
      await coordinator.enqueueArtifactVersion({
        artifactVersionId: second.version.id,
        contentHash: second.version.content.hash,
        mediaType: second.version.mediaType,
        sessionId,
      });
    }
    return tasks;
  };
  context.after(() => { store.listReviewerAuditTasks = originalList; });

  await coordinator.enqueueArtifactVersion({
    artifactVersionId: first.version.id,
    contentHash: first.version.content.hash,
    mediaType: first.version.mediaType,
    sessionId: session.id,
  });
  await waitFor(async () => executions === 2);
  assert.equal(registeredAtExit, true);
});

test("uploads and Agent code/data outputs remain Artifacts but are not automatically audited", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `reviewer-upload-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  await store.load();
  const project = await store.createProject("Reviewer uploads");
  const session = await store.createSession(project.id, "Audit", {}, {}, { allowUnconfiguredModel: true });
  await store.updateReviewerSpecialistSettings({ enabled: true });
  const upload = await store.createArtifactVersion({
    content: { hash: "9".repeat(64), size: 1 }, kind: "markdown", logicalName: "input.md", mediaType: "text/markdown",
    origin: "user_upload", sessionId: session.id, sourcePath: "input.md",
  });
  const coordinator = new ReviewerAuditCoordinator(store, { run: async () => [] }, { quickBatchQuietMs: 0 });
  const task = await coordinator.enqueueArtifactVersion({ artifactVersionId: upload.version.id, contentHash: upload.version.content.hash, mediaType: upload.version.mediaType, sessionId: session.id });
  assert.equal(task, undefined);
  for (const [hash, kind, logicalName, mediaType] of [
    ["4".repeat(64), "other", "g2m_enrichment_analysis.py", "text/x-python"],
    ["5".repeat(64), "other", "GSEA_gmt.gmt", "text/plain"],
    ["6".repeat(64), "dataset", "enrichment_results.csv", "text/csv"],
    ["7".repeat(64), "dataset", "TS7.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["b".repeat(64), "other", "execution.log", "text/plain"],
  ] as const) {
    const generated = await store.createArtifactVersion({
      content: { hash, size: 1 }, kind, logicalName, mediaType,
      origin: "llm_declared", sessionId: session.id, sourcePath: logicalName,
    });
    assert.equal(await coordinator.enqueueArtifactVersion({
      artifactVersionId: generated.version.id,
      contentHash: generated.version.content.hash,
      mediaType: generated.version.mediaType,
      sessionId: session.id,
    }), undefined, `${logicalName} is not a report candidate`);
  }
  assert.deepEqual(await store.listReviewerAuditTasks(session.id), []);
});

test("manual review selects report deliverables and ignores code/data Artifacts", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `reviewer-manual-reports-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  await store.load();
  const project = await store.createProject("Reviewer manual reports");
  const session = await store.createSession(project.id, "Audit", {}, {}, { allowUnconfiguredModel: true });
  await store.updateReviewerSpecialistSettings({ enabled: true });
  const report = await store.createArtifactVersion({
    content: { hash: "8".repeat(64), size: 1 }, kind: "markdown", logicalName: "analysis_summary.md", mediaType: "text/markdown",
    origin: "llm_declared", sessionId: session.id, sourcePath: "analysis_summary.md",
  });
  const data = await store.createArtifactVersion({
    content: { hash: "a".repeat(64), size: 1 }, kind: "dataset", logicalName: "enrichment_results.csv", mediaType: "text/csv",
    origin: "llm_declared", sessionId: session.id, sourcePath: "enrichment_results.csv",
  });
  const coordinator = new ReviewerAuditCoordinator(store, { run: async () => [] }, { quickBatchQuietMs: 500 });
  const task = await coordinator.enqueueManual(session.id, "manual-report-only");
  assert.deepEqual(task.artifactVersionIds, [report.version.id]);
  assert.ok(!task.artifactVersionIds.includes(data.version.id));
  await coordinator.cancelSession(session.id);
});

test("Session automatic-review settings skip background work but set the manual review level", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `reviewer-session-settings-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  await store.load();
  const project = await store.createProject("Reviewer Session settings");
  const session = await store.createSession(project.id, "Audit", {}, {}, { allowUnconfiguredModel: true });
  await store.updateReviewerSpecialistSettings({ enabled: true });
  await store.updateSessionReviewerSpecialistSettings(session.id, {
    automaticReviewEnabled: false,
    level: "deep",
  });
  const report = await store.createArtifactVersion({
    content: { hash: "e".repeat(64), size: 1 }, kind: "markdown", logicalName: "report.md", mediaType: "text/markdown",
    origin: "llm_declared", sessionId: session.id, sourcePath: "report.md",
  });
  const coordinator = new ReviewerAuditCoordinator(store, { run: async () => [] }, { quickBatchQuietMs: 0 });
  assert.equal(await coordinator.enqueueArtifactVersion({
    artifactVersionId: report.version.id,
    contentHash: report.version.content.hash,
    mediaType: report.version.mediaType,
    sessionId: session.id,
  }), undefined);
  const manual = await coordinator.enqueueManual(session.id, "manual-session-level");
  assert.equal(manual.reviewLevel, "deep");
  await coordinator.cancelSession(session.id);
});

test("Stop review cancels a quiet-window batch before it starts", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `reviewer-stop-batch-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  await store.load();
  const project = await store.createProject("Reviewer stop batch");
  const session = await store.createSession(project.id, "Audit", {}, {}, { allowUnconfiguredModel: true });
  await store.updateReviewerSpecialistSettings({ enabled: true });
  const generated = await store.createArtifactVersion({
    content: { hash: "1".repeat(64), size: 1 }, kind: "markdown", logicalName: "result.md", mediaType: "text/markdown",
    origin: "llm_declared", sessionId: session.id, sourcePath: "result.md",
  });
  let executions = 0;
  const coordinator = new ReviewerAuditCoordinator(store, {
    run: async () => { executions += 1; return []; },
  }, { quickBatchQuietMs: 500 });
  const task = await coordinator.enqueueArtifactVersion({ artifactVersionId: generated.version.id, contentHash: generated.version.content.hash, mediaType: generated.version.mediaType, sessionId: session.id });
  assert.ok(task);
  assert.equal(await coordinator.cancelSession(session.id), true);
  assert.equal((await store.listReviewerAuditTasks(session.id))[0]?.status, "cancelled");
  await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  assert.equal(executions, 0);
});

test("Stop review settles a stale running checkpoint after its task has already failed", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `reviewer-stop-stale-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  await store.load();
  const project = await store.createProject("Reviewer stale stop");
  const session = await store.createSession(project.id, "Audit", {}, {}, { allowUnconfiguredModel: true });
  await store.updateReviewerSpecialistSettings({ enabled: true });
  const report = await store.createArtifactVersion({
    content: { hash: "f".repeat(64), size: 1 }, kind: "markdown", logicalName: "report.md", mediaType: "text/markdown",
    origin: "llm_declared", sessionId: session.id, sourcePath: "report.md",
  });
  const coordinator = new ReviewerAuditCoordinator(store, { run: async () => { throw new Error("Reviewer model is unavailable"); } }, { quickBatchQuietMs: 0 });
  const task = await coordinator.enqueueArtifactVersion({
    artifactVersionId: report.version.id, contentHash: report.version.content.hash, mediaType: report.version.mediaType, sessionId: session.id,
  });
  assert.ok(task);
  await waitFor(async () => (await store.listReviewerAuditTasks(session.id))[0]?.status === "failed");
  assert.equal((await store.getSessionDetail(session.id))?.messages.find((message) => message.id === task.checkpointMessageId)?.reviewerCheckpoint?.status, "failed");

  // Simulate a checkpoint written by the old worker before this reconciliation
  // was deployed: Stop must repair the user-visible stale running card.
  await store.appendReviewerCheckpointMessage(session.id, "stale-running-checkpoint", "manual-review:stale-running-checkpoint");
  assert.equal(await coordinator.cancelSession(session.id), true);
  const repaired = (await store.getSessionDetail(session.id))?.messages.find((message) => message.id === "stale-running-checkpoint");
  assert.equal(repaired?.reviewerCheckpoint?.status, "failed");
  assert.equal(repaired?.reviewerCheckpoint?.error, "Review stopped because no active Reviewer task remained");
});

test("an automatic audit with no current report is silently superseded without checkpoint or feedback", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `reviewer-skip-stale-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  await store.load();
  const project = await store.createProject("Reviewer stale automatic task");
  const session = await store.createSession(project.id, "Audit", {}, {}, { allowUnconfiguredModel: true });
  await store.updateReviewerSpecialistSettings({ enabled: true });
  const report = await store.createArtifactVersion({
    content: { hash: "c".repeat(64), size: 1 }, kind: "markdown", logicalName: "report.md", mediaType: "text/markdown",
    origin: "llm_declared", sessionId: session.id, sourcePath: "report.md",
  });
  const coordinator = new ReviewerAuditCoordinator(store, { run: async () => ({ skipped: true }) }, { quickBatchQuietMs: 0 });
  const task = await coordinator.enqueueArtifactVersion({
    artifactVersionId: report.version.id, contentHash: report.version.content.hash, mediaType: report.version.mediaType, sessionId: session.id,
  });
  assert.ok(task);
  await waitFor(async () => (await store.listReviewerAuditTasks(session.id))[0]?.status === "superseded");
  assert.deepEqual(await store.readMessages(session.id), []);
  assert.deepEqual(await store.listReviewFeedback(session.id), []);
});

test("automatic audits wait for the lead Agent to be idle", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `reviewer-yield-main-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  await store.load();
  const project = await store.createProject("Reviewer yields to lead");
  const session = await store.createSession(project.id, "Audit", {}, {}, { allowUnconfiguredModel: true });
  await store.updateReviewerSpecialistSettings({ enabled: true });
  const report = await store.createArtifactVersion({
    content: { hash: "d".repeat(64), size: 1 }, kind: "markdown", logicalName: "report.md", mediaType: "text/markdown",
    origin: "llm_declared", sessionId: session.id, sourcePath: "report.md",
  });
  let mainBusy = true;
  let executions = 0;
  const coordinator = new ReviewerAuditCoordinator(store, { run: async () => { executions += 1; return []; } }, {
    isMainAgentBusy: () => mainBusy,
    mainAgentBusyRetryMs: 10,
    quickBatchQuietMs: 0,
  });
  const task = await coordinator.enqueueArtifactVersion({
    artifactVersionId: report.version.id, contentHash: report.version.content.hash, mediaType: report.version.mediaType, sessionId: session.id,
  });
  assert.ok(task);
  await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  assert.equal(executions, 0);
  assert.deepEqual(await store.readMessages(session.id), []);
  mainBusy = false;
  await waitFor(async () => (await store.listReviewerAuditTasks(session.id))[0]?.status === "completed");
  assert.equal(executions, 1);
});

test("automatic audits share one process-wide background lane", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `reviewer-global-lane-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  await store.load();
  const project = await store.createProject("Reviewer global lane");
  const firstSession = await store.createSession(project.id, "First", {}, {}, { allowUnconfiguredModel: true });
  const secondSession = await store.createSession(project.id, "Second", {}, {}, { allowUnconfiguredModel: true });
  await store.updateReviewerSpecialistSettings({ enabled: true });
  const first = await store.createArtifactVersion({
    content: { hash: "e".repeat(64), size: 1 }, kind: "markdown", logicalName: "first.md", mediaType: "text/markdown",
    origin: "llm_declared", sessionId: firstSession.id, sourcePath: "first.md",
  });
  const second = await store.createArtifactVersion({
    content: { hash: "f".repeat(64), size: 1 }, kind: "markdown", logicalName: "second.md", mediaType: "text/markdown",
    origin: "llm_declared", sessionId: secondSession.id, sourcePath: "second.md",
  });
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  let executions = 0;
  const coordinator = new ReviewerAuditCoordinator(store, {
    run: async () => {
      executions += 1;
      if (executions === 1) await gate;
      return [];
    },
  }, { mainAgentBusyRetryMs: 10, quickBatchQuietMs: 0 });
  await coordinator.enqueueArtifactVersion({ artifactVersionId: first.version.id, contentHash: first.version.content.hash, mediaType: first.version.mediaType, sessionId: firstSession.id });
  await coordinator.enqueueArtifactVersion({ artifactVersionId: second.version.id, contentHash: second.version.content.hash, mediaType: second.version.mediaType, sessionId: secondSession.id });
  await waitFor(async () => (await store.listReviewerAuditTasks(firstSession.id))[0]?.status === "running");
  await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  assert.equal(executions, 1);
  release();
  await waitFor(async () => (await store.listReviewerAuditTasks(firstSession.id))[0]?.status === "completed"
    && (await store.listReviewerAuditTasks(secondSession.id))[0]?.status === "completed");
  assert.equal(executions, 2);
});

test("the Deep cooldown is applied once to the next automatic batch", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `reviewer-deep-cooldown-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  await store.load();
  const project = await store.createProject("Reviewer Deep cooldown");
  const session = await store.createSession(project.id, "Audit", {}, {}, { allowUnconfiguredModel: true });
  await store.updateReviewerSpecialistSettings({ enabled: true });
  await store.updateSessionReviewerSpecialistSettings(session.id, {
    automaticReviewEnabled: true,
    level: "deep",
  });
  const first = await store.createArtifactVersion({
    content: { hash: "2".repeat(64), size: 1 }, kind: "markdown", logicalName: "first.md", mediaType: "text/markdown",
    origin: "llm_declared", sessionId: session.id, sourcePath: "first.md",
  });
  const second = await store.createArtifactVersion({
    content: { hash: "3".repeat(64), size: 1 }, kind: "markdown", logicalName: "second.md", mediaType: "text/markdown",
    origin: "llm_declared", sessionId: session.id, sourcePath: "second.md",
  });
  const coordinator = new ReviewerAuditCoordinator(store, { run: async () => [] }, {
    deepAutomaticCooldownMs: 200,
    deepBatchQuietMs: 0,
  });
  const firstTask = await coordinator.enqueueArtifactVersion({ artifactVersionId: first.version.id, contentHash: first.version.content.hash, mediaType: first.version.mediaType, sessionId: session.id });
  assert.ok(firstTask);
  await waitFor(async () => (await store.listReviewerAuditTasks(session.id)).find((task) => task.id === firstTask.id)?.status === "completed");
  const nextTask = await coordinator.enqueueArtifactVersion({ artifactVersionId: second.version.id, contentHash: second.version.content.hash, mediaType: second.version.mediaType, sessionId: session.id });
  assert.ok(nextTask?.notBefore);
  assert.ok(new Date(nextTask.notBefore).getTime() - Date.now() >= 150, "cooldown belongs to the whole next Deep batch");
  await coordinator.cancelSession(session.id);
});
