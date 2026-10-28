// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
import type { ReviewerAuditTask, SessionReviewerSpecialistSettings } from "@sciencediscovery/schema";
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
    if (update.status === "failed" || update.status === "completed") {
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
    if (["completed", "superseded", "failed", "cancelled"].includes(task.status)) {
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
  return { store, session, run, report, coordinator, enqueue, executions, waitTerminal, waitCheckpoint };
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
  assert.equal(settled.status, "superseded");
  assert.equal(settled.errorSummary, "Automatic review skipped: Reviewer Specialist is off in System configuration → Specialists.");
  await f.waitCheckpoint(task.checkpointMessageId);
  const checkpoint = (await f.store.readMessages(f.session.id)).find(message => message.id === task.checkpointMessageId);
  assert.equal(checkpoint?.reviewerCheckpoint?.status, "completed");
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
  assert.equal(settled.status, "superseded"); assert.equal(f.executions.length, 0);
  assert.equal(settled.errorSummary, "Automatic review skipped: Reviewer Specialist is off in System configuration → Specialists.");
  await f.waitCheckpoint(task.checkpointMessageId);
  const checkpoint = (await f.store.readMessages(f.session.id)).find(message => message.id === task.checkpointMessageId);
  assert.equal(checkpoint?.reviewerCheckpoint?.status, "completed");
  assert.equal(checkpoint?.content, settled.errorSummary);
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
