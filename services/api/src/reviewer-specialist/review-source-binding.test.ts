// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
import type { ReviewerAuditTask, SessionReviewerSpecialistSettings } from "@sciencediscovery/schema";
import { reviewerQualityMetrics } from "@sciencediscovery/provenance";
import { SessionStore } from "../store.js";
import { ReviewerAuditCoordinator, type ReviewerAuditScheduling } from "./audit-coordinator.js";

async function fixture(context: { after(callback: () => Promise<void>): void }) {
  const parent = resolve(process.cwd(), ".tmp"), root = resolve(parent, `review-source-${randomUUID()}`);
  const store = new SessionStore(root); await store.load();
  const project = await store.createProject("Exact reviewer source");
  const session = await store.createSession(project.id, "Source binding", {}, {}, { allowUnconfiguredModel: true });
  await store.updateReviewerSpecialistSettings({ enabled: true });
  // Observe completed public writes rather than polling the JSON file while a
  // background worker atomically replaces it (Windows may deny that rename).
  const settled = new Map<string, ReviewerAuditTask>(), waiters = new Map<string, (task: ReviewerAuditTask) => void>();
  const updateTask = store.updateReviewerAuditTask.bind(store);
  const checkpointSettled = new Set<string>(), checkpointWaiters = new Map<string, () => void>();
  const updateCheckpoint = store.updateReviewerCheckpointMessage.bind(store);
  store.updateReviewerCheckpointMessage = async (sessionId, messageId, update) => {
    const message = await updateCheckpoint(sessionId, messageId, update);
    if (update.status === "failed" || update.status === "completed" || update.status === "skipped") {
      checkpointSettled.add(messageId); checkpointWaiters.get(messageId)?.(); checkpointWaiters.delete(messageId);
    }
    return message;
  };
  const waitCheckpoint = async (id: string) => checkpointSettled.has(id) ? undefined : new Promise<void>((done, reject) => {
    const timeout = setTimeout(() => { checkpointWaiters.delete(id); reject(new Error("Reviewer checkpoint did not settle")); }, 5_000);
    checkpointWaiters.set(id, () => { clearTimeout(timeout); done(); });
  });
  store.updateReviewerAuditTask = async (sessionId, taskId, update) => {
    const task = await updateTask(sessionId, taskId, update);
    if (["completed", "superseded", "failed", "cancelled", "skipped"].includes(task.status)) {
      settled.set(task.id, task); waiters.get(task.id)?.(task); waiters.delete(task.id);
    }
    return task;
  };
  const waitTerminal = async (taskId: string): Promise<ReviewerAuditTask> => settled.get(taskId) ?? new Promise((done, reject) => {
    const timeout = setTimeout(() => { waiters.delete(taskId); reject(new Error("Reviewer source binding did not settle")); }, 5_000);
    waiters.set(taskId, task => { clearTimeout(timeout); done(task); });
  });
  const coordinators: ReviewerAuditCoordinator[] = [], executions: ReviewerAuditTask[] = [];
  context.after(async () => {
    for (const coordinator of coordinators) await coordinator.cancelSession(session.id);
    store.close(); assert.ok(root.startsWith(parent + sep));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  });
  const coordinator = (settings: ReviewerAuditScheduling = { quickBatchQuietMs: 60_000, deepBatchQuietMs: 60_000 }) => {
    const value = new ReviewerAuditCoordinator(store, { run: async task => { executions.push(task); return []; } }, settings);
    coordinators.push(value); return value;
  };
  const run = async (settings: SessionReviewerSpecialistSettings) => {
    await store.updateSessionReviewerSpecialistSettings(session.id, settings);
    return store.createSessionRun({ sessionId: session.id, prompt: "Produce a report", settingsSnapshot: store.resolveRuntimeSettings(session.id).effective });
  };
  const report = async (name: string, turnId?: string) => store.createArtifactVersion({
    content: { hash: createHash("sha256").update(name).digest("hex"), size: 3 }, kind: "markdown", logicalName: `${name}.md`,
    mediaType: "text/markdown", origin: "llm_declared", sessionId: session.id, sourcePath: `${name}.md`, ...(turnId ? { turnId } : {}),
  });
  const enqueue = async (worker: ReviewerAuditCoordinator, artifact: Awaited<ReturnType<typeof report>>) => worker.enqueueArtifactVersion({
    sessionId: session.id, artifactVersionId: artifact.version.id, contentHash: artifact.version.content.hash, mediaType: artifact.version.mediaType,
  });
  return { root, store, session, run, report, coordinator, enqueue, executions, waitTerminal, waitCheckpoint };
}

test("CFG-T33 reviewer source follows nested Subagent parent IDs to its exact frozen root, never the newest run", async context => {
  const f = await fixture(context);
  const root = await f.run({ automaticReviewEnabled: true, level: "quick" });
  const child = await f.store.createSubagent(f.session.id, root.id, { description: "Child report", prompt: "Research" });
  const grandchild = await f.store.createSubagent(f.session.id, child.id, { description: "Nested report", prompt: "Research" });
  const latest = await f.run({ automaticReviewEnabled: false, level: "deep" });
  assert.notEqual(latest.id, root.id);
  const task = await f.enqueue(f.coordinator(), await f.report("nested-report", grandchild.id));
  assert.ok(task); assert.equal(task.sourceRunId, root.id); assert.equal(task.reviewLevel, "quick");
});

test("CFG-T33 reviewer batch keeps different root runs separate even when their review levels match", async context => {
  const f = await fixture(context), worker = f.coordinator();
  const first = await f.run({ automaticReviewEnabled: true, level: "quick" });
  const second = await f.run({ automaticReviewEnabled: true, level: "quick" });
  const a = await f.report("run-a", first.id), b = await f.report("run-b", second.id), c = await f.report("run-a-again", first.id);
  const taskA = await f.enqueue(worker, a), taskB = await f.enqueue(worker, b), updatedA = await f.enqueue(worker, c);
  assert.ok(taskA && taskB && updatedA); assert.notEqual(taskA.id, taskB.id); assert.equal(updatedA.id, taskA.id);
  assert.equal(updatedA.sourceRunId, first.id); assert.equal(taskB.sourceRunId, second.id);
  assert.deepEqual(new Set(updatedA.artifactVersionIds), new Set([a.version.id, c.version.id]));
  assert.deepEqual(taskB.artifactVersionIds, [b.version.id]);
});

test("CFG-T33 unknown and cyclic artifact ancestry use legacy session fallback without inventing a source run", async context => {
  const f = await fixture(context), worker = f.coordinator();
  await f.run({ automaticReviewEnabled: true, level: "quick" });
  await f.store.updateSessionReviewerSpecialistSettings(f.session.id, { automaticReviewEnabled: false, level: "deep" });
  assert.equal(await f.enqueue(worker, await f.report("unknown-disabled", "missing-execution")), undefined,
    "The latest enabled run must not be guessed as the producer");
  const child = await f.store.createSubagent(f.session.id, "missing-root", { description: "Cycle one", prompt: "Research" });
  const nested = await f.store.createSubagent(f.session.id, child.id, { description: "Cycle two", prompt: "Research" });
  await f.store.updateSubagent({ ...child, parentTurnId: nested.id });
  await f.store.updateSessionReviewerSpecialistSettings(f.session.id, { automaticReviewEnabled: true, level: "deep" });
  const task = await f.enqueue(worker, await f.report("cyclic-report", nested.id));
  assert.ok(task); assert.equal(task.sourceRunId, undefined); assert.equal(task.reviewLevel, "deep");
  const historical = await f.enqueue(worker, await f.report("historical-no-turn"));
  assert.ok(historical); assert.equal(historical.sourceRunId, undefined);
});

test("CFG-T33 explicit manual review preserves current-session preferences and has no invented automatic source", async context => {
  const f = await fixture(context);
  const old = await f.run({ automaticReviewEnabled: true, level: "quick" }); await f.report("manual-report", old.id);
  await f.store.updateSessionReviewerSpecialistSettings(f.session.id, { automaticReviewEnabled: false, level: "deep" });
  const task = await f.coordinator().enqueueManual(f.session.id, `manual-${randomUUID()}`);
  assert.equal(task.origin, "manual"); assert.equal(task.sourceRunId, undefined); assert.equal(task.reviewLevel, "deep");
  await f.waitTerminal(task.id);
});

test("CFG-T33 a live global Reviewer off switch suppresses a previously queued frozen automatic audit", async context => {
  const f = await fixture(context), worker = f.coordinator({ quickBatchQuietMs: 50 });
  const run = await f.run({ automaticReviewEnabled: true, level: "quick" });
  const task = await f.enqueue(worker, await f.report("global-switch", run.id)); assert.ok(task);
  await f.store.updateReviewerSpecialistSettings({ enabled: false });
  const settled = await f.waitTerminal(task.id);
  assert.equal(settled.status, "skipped");
  assert.equal(settled.skipReason, "specialist_disabled");
  assert.equal(settled.errorSummary, undefined);
  await f.waitCheckpoint(task.checkpointMessageId);
  const checkpoint = (await f.store.readMessages(f.session.id)).find(message => message.id === task.checkpointMessageId);
  assert.equal(checkpoint?.reviewerCheckpoint?.status, "skipped");
  assert.equal(checkpoint?.reviewerCheckpoint?.error, undefined);
  assert.equal(f.executions.length, 0);
});

test("CFG-T33 a global-off decision during asynchronous Deep admission is checked again before execution", async context => {
  const f = await fixture(context); let entered!: () => void, release!: () => void;
  const atAdmission = new Promise<void>(done => { entered = done; }), continueAdmission = new Promise<void>(done => { release = done; });
  const worker = f.coordinator({ deepBatchQuietMs: 0, isMainAgentBusy: async () => { entered(); await continueAdmission; return false; } });
  const run = await f.run({ automaticReviewEnabled: true, level: "deep" });
  const task = await f.enqueue(worker, await f.report("admission-global-switch", run.id)); assert.ok(task);
  await atAdmission; await f.store.updateReviewerSpecialistSettings({ enabled: false }); release();
  const settled = await f.waitTerminal(task.id);
  assert.equal(settled.status, "skipped"); assert.equal(f.executions.length, 0);
  assert.equal(settled.skipReason, "specialist_disabled");
  assert.equal(settled.errorSummary, undefined);
  await f.waitCheckpoint(task.checkpointMessageId);
  const checkpoint = (await f.store.readMessages(f.session.id)).find(message => message.id === task.checkpointMessageId);
  assert.equal(checkpoint?.reviewerCheckpoint?.status, "skipped");
  assert.equal(checkpoint?.reviewerCheckpoint?.skipReason, "specialist_disabled");
});

test("CFG-T33 an automatic audit with an explicit missing source cannot silently adopt current-session settings", async context => {
  const f = await fixture(context), worker = f.coordinator({ quickBatchQuietMs: 50 });
  const run = await f.run({ automaticReviewEnabled: true, level: "quick" });
  const task = await f.enqueue(worker, await f.report("missing-source-after-enqueue", run.id)); assert.ok(task);
  const getRun = f.store.getSessionRun.bind(f.store);
  f.store.getSessionRun = async (sessionId, runId) => runId === run.id ? undefined : getRun(sessionId, runId);
  const settled = await f.waitTerminal(task.id);
  assert.equal(settled.status, "failed"); assert.equal(f.executions.length, 0);
  assert.equal(settled.errorSummary, "The source Run is no longer available");
  await f.waitCheckpoint(task.checkpointMessageId);
  const checkpoint = (await f.store.readMessages(f.session.id)).find(message => message.id === task.checkpointMessageId);
  assert.equal(checkpoint?.reviewerCheckpoint?.status, "failed");
  assert.equal(checkpoint?.reviewerCheckpoint?.error, settled.errorSummary);
});

for (const afterAdmission of [false, true]) {
  test(`a legacy session opt-out ${afterAdmission ? "during" : "before"} admission is skipped without review results`, async context => {
    const f = await fixture(context);
    let entered!: () => void, release!: () => void;
    const atAdmission = new Promise<void>(done => { entered = done; });
    const continueAdmission = new Promise<void>(done => { release = done; });
    await f.store.updateSessionReviewerSpecialistSettings(f.session.id, { automaticReviewEnabled: true, level: "deep" });
    const worker = f.coordinator(afterAdmission
      ? { deepBatchQuietMs: 0, isMainAgentBusy: async () => { entered(); await continueAdmission; return false; } }
      : { deepBatchQuietMs: 50 });
    // No source Run: legacy artifacts intentionally use the live session gate.
    const task = await f.enqueue(worker, await f.report(`session-opt-out-${afterAdmission}`));
    assert.ok(task);
    if (afterAdmission) await atAdmission;
    await f.store.updateSessionReviewerSpecialistSettings(f.session.id, { automaticReviewEnabled: false, level: "deep" });
    release();
    const settled = await f.waitTerminal(task.id);
    await f.waitCheckpoint(task.checkpointMessageId);
    assert.equal(settled.status, "skipped");
    assert.equal(settled.skipReason, "automatic_review_disabled");
    assert.equal(settled.errorSummary, undefined);
    assert.equal(settled.supersededBy, undefined);
    const checkpoint = (await f.store.readMessages(f.session.id)).find(message => message.id === task.checkpointMessageId)!;
    assert.equal(checkpoint.reviewerCheckpoint?.status, "skipped");
    assert.equal(checkpoint.reviewerCheckpoint?.skipReason, "automatic_review_disabled");
    assert.equal(checkpoint.reviewerCheckpoint?.error, undefined);
    assert.equal(f.executions.length, 0);
    assert.deepEqual(await f.store.listArtifactReviews(f.session.id), []);
    assert.equal(reviewerQualityMetrics(await f.store.listArtifactReviews(f.session.id)).deepReviewCount, 0);
    assert.deepEqual(await f.store.listReviewFeedback(f.session.id), []);
  });
}

for (const recovery of ["restart", "stop"] as const) {
  test(`a skipped task reconciles its interrupted checkpoint on ${recovery} and ignores late callbacks`, async context => {
    const f = await fixture(context), worker = f.coordinator();
    const task = await f.enqueue(worker, await f.report(`skip-recovery-${recovery}`)); assert.ok(task);
    await f.store.appendReviewerCheckpointMessage(f.session.id, task.checkpointMessageId, task.toolCallId);
    await f.store.updateReviewerAuditTask(f.session.id, task.id, {
      checkpointPublishedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      skipReason: "specialist_disabled", status: "skipped",
    });
    // This durable task + still-running card is the crash window before the
    // final checkpoint write, not a fake executed ArtifactReviewRun.
    const restored = new SessionStore(f.root); await restored.load();
    context.after(() => restored.close());
    let executions = 0;
    const recovered = new ReviewerAuditCoordinator(restored, { run: async () => { executions++; return []; } });
    if (recovery === "restart") await recovered.resume();
    else await recovered.cancelSession(f.session.id);
    for (const status of ["queued", "running", "completed", "failed", "superseded"] as const) {
      const late = await restored.updateReviewerAuditTask(f.session.id, task.id, { status, errorSummary: "late", reviewIds: ["invented"] });
      assert.equal(late.status, "skipped"); assert.equal(late.skipReason, "specialist_disabled");
      assert.equal(late.errorSummary, undefined); assert.equal(late.reviewIds, undefined);
    }
    const checkpoint = await restored.updateReviewerCheckpointMessage(f.session.id, task.checkpointMessageId, {
      content: "late completion", status: "completed",
    });
    assert.equal(checkpoint.reviewerCheckpoint?.status, "skipped");
    assert.equal(checkpoint.reviewerCheckpoint?.skipReason, "specialist_disabled");
    assert.notEqual(checkpoint.content, "late completion");
    assert.equal(executions, 0);
    assert.deepEqual(await restored.listArtifactReviews(f.session.id), []);
    assert.deepEqual(await restored.listReviewFeedback(f.session.id), []);
  });
}

test("re-enabling Reviewer can enqueue the same skipped report without a Deep completion cooldown", async context => {
  const f = await fixture(context);
  await f.store.updateSessionReviewerSpecialistSettings(f.session.id, { automaticReviewEnabled: true, level: "deep" });
  await f.store.updateReviewerSpecialistSettings({ enabled: false });
  const report = await f.report("reenable-report"), worker = f.coordinator({ deepBatchQuietMs: 0, deepAutomaticCooldownMs: 60_000 });
  const skipped = await f.enqueue(worker, report); assert.ok(skipped);
  await f.waitTerminal(skipped.id); await f.waitCheckpoint(skipped.checkpointMessageId);
  assert.equal((await f.store.listReviewerAuditTasks(f.session.id))[0]?.status, "skipped");
  await f.store.updateReviewerSpecialistSettings({ enabled: true });
  const retried = await f.enqueue(worker, report); assert.ok(retried);
  assert.notEqual(retried.id, skipped.id);
  assert.equal(retried.inputFingerprint, skipped.inputFingerprint);
  assert.ok(Date.parse(retried.notBefore!) <= Date.now(), "skipped work is not a completed Deep audit for cooldown");
  assert.equal((await f.waitTerminal(retried.id)).status, "completed");
  assert.equal(f.executions.length, 1);
});

test("the executor's final disabled gate preserves skipped reason rather than replacing the artifact", async context => {
  const f = await fixture(context);
  const worker = new ReviewerAuditCoordinator(f.store, { run: async () => ({ skipped: true, skipReason: "specialist_disabled" }) }, { quickBatchQuietMs: 0 });
  context.after(() => worker.cancelSession(f.session.id).then(() => undefined));
  const task = await f.enqueue(worker, await f.report("last-gate")); assert.ok(task);
  const settled = await f.waitTerminal(task.id); await f.waitCheckpoint(task.checkpointMessageId);
  assert.equal(settled.status, "skipped"); assert.equal(settled.skipReason, "specialist_disabled");
  assert.equal(settled.supersededBy, undefined);
  assert.deepEqual(await f.store.listArtifactReviews(f.session.id), []);
  assert.deepEqual(await f.store.listReviewFeedback(f.session.id), []);
});

for (const lateResult of ["completion", "failure"] as const) {
  test(`a late executor ${lateResult} cannot replace a skipped task or create feedback`, async context => {
    const f = await fixture(context);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(done => { entered = done; });
    const pending = new Promise<void>(done => { release = done; });
    let calls = 0;
    const worker = new ReviewerAuditCoordinator(f.store, { run: async () => {
      if (++calls === 1) {
        entered(); await pending;
        if (lateResult === "failure") throw new Error("late executor failure");
      }
      return [];
    } }, { quickBatchQuietMs: 0 });
    context.after(() => worker.cancelSession(f.session.id).then(() => undefined));
    const task = await f.enqueue(worker, await f.report(`late-${lateResult}`)); assert.ok(task);
    await started;
    await f.store.updateReviewerAuditTask(f.session.id, task.id, { finishedAt: new Date().toISOString(), skipReason: "specialist_disabled", status: "skipped" });
    await f.store.updateReviewerCheckpointMessage(f.session.id, task.checkpointMessageId, { content: "Review skipped", skipReason: "specialist_disabled", status: "skipped" });
    // A second explicit request proves the drain passed the late callback,
    // without using a sleep as evidence that no feedback was emitted.
    const next = await worker.enqueueManual(f.session.id, `manual-after-${randomUUID()}`);
    release();
    assert.equal((await f.waitTerminal(next.id)).status, "completed");
    const skipped = (await f.store.listReviewerAuditTasks(f.session.id)).find(item => item.id === task.id)!;
    assert.equal(skipped.status, "skipped"); assert.equal(skipped.reviewIds, undefined); assert.equal(skipped.errorSummary, undefined);
    assert.equal((await f.store.listReviewFeedback(f.session.id)).some(item => item.taskId === task.id), false);
    assert.deepEqual(await f.store.listArtifactReviews(f.session.id), []);
    assert.equal((await f.store.readMessages(f.session.id)).find(item => item.id === task.checkpointMessageId)?.reviewerCheckpoint?.status, "skipped");
  });
}

test("Stop wins over a disabled skip that is still publishing its checkpoint", async context => {
  const f = await fixture(context);
  await f.store.updateReviewerSpecialistSettings({ enabled: false });
  let entered!: () => void, release!: () => void, skipped!: (task: ReviewerAuditTask) => void;
  const atPublish = new Promise<void>(done => { entered = done; });
  const continuePublish = new Promise<void>(done => { release = done; });
  const skipAttempted = new Promise<ReviewerAuditTask>(done => { skipped = done; });
  const append = f.store.appendReviewerCheckpointMessage.bind(f.store);
  f.store.appendReviewerCheckpointMessage = async (...args) => {
    const checkpoint = await append(...args);
    entered(); await continuePublish;
    return checkpoint;
  };
  const update = f.store.updateReviewerAuditTask.bind(f.store);
  f.store.updateReviewerAuditTask = async (...args) => {
    const task = await update(...args);
    if (args[2].status === "skipped") skipped(task);
    return task;
  };
  const worker = f.coordinator({ quickBatchQuietMs: 0 });
  const task = await f.enqueue(worker, await f.report("stop-during-skip")); assert.ok(task);
  await atPublish;
  await worker.cancelSession(f.session.id);
  release();
  const settled = await skipAttempted;
  assert.equal(settled.status, "cancelled");
  assert.equal(settled.skipReason, undefined);
  assert.equal(settled.errorSummary, "Review cancelled by user");
  const checkpoint = (await f.store.readMessages(f.session.id)).find(item => item.id === task.checkpointMessageId)!;
  assert.equal(checkpoint.reviewerCheckpoint?.status, "failed");
  assert.equal(checkpoint.reviewerCheckpoint?.error, "Review cancelled by user");
  assert.equal(checkpoint.reviewerCheckpoint?.skipReason, undefined);
  assert.equal(f.executions.length, 0);
  assert.deepEqual(await f.store.listArtifactReviews(f.session.id), []);
  assert.deepEqual(await f.store.listReviewFeedback(f.session.id), []);
});
