// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { AgentNotifications } from "./agent-notifications.js";
import { SessionStore } from "./store.js";
import { versioningAuthorities } from "./agent-run/versioning-authorities.js";
import { VersionStore } from "@sciencediscovery/cas";

const main = { sessionId: "session", agentId: "main" };
const child = { ...main, agentId: "child" };

function fixture(context: TestContext) {
  const db = new DatabaseSync(":memory:");
  context.after(() => db.close());
  let now = 1_000;
  let archived = false;
  const inbox = new AgentNotifications(db, () => archived, () => now);
  return { inbox, db, time: (value: number) => { now = value; }, archive: () => { archived = true; } };
}

test("completion is idempotent, scoped to its Agent, and retained until acknowledged", (context) => {
  const { inbox } = fixture(context);
  inbox.complete(main, "execution-1", "Execution completed; inspect the result");
  inbox.complete(main, "execution-1", "duplicate notification");
  assert.equal(inbox.unread(main).length, 1);
  assert.equal(inbox.unread(child).length, 0);
  const batch = inbox.prepareDelivery(main)!;
  assert.match(batch.notifications[0]!.message, /inspect the result/);
  // Reading is not delivery. A failed wake can read the same notice again.
  assert.deepEqual(inbox.prepareDelivery(main), batch);
  assert.equal(inbox.acknowledge(batch), true);
  assert.equal(inbox.prepareDelivery(main), undefined);
});

test("stop invalidates a prepared delivery and cancels timers but retains completion records", (context) => {
  const { inbox, time } = fixture(context);
  inbox.createTimer(main, { dueAt: 2_000, message: "Check progress" });
  inbox.createTimer(child, { dueAt: 2_000, message: "Check child progress" });
  inbox.complete(main, "execution-1", "Finished before stop");
  const stale = inbox.prepareDelivery(main)!;
  inbox.stop(main.sessionId);
  inbox.complete(main, "execution-2", "Finished after stop");
  assert.equal(inbox.deliveryAllowed(stale), false);
  assert.equal(inbox.acknowledge(stale), false);
  assert.equal(inbox.prepareDelivery(main), undefined);
  assert.throws(() => inbox.createTimer(main, { dueAt: 2_000, message: "Invalid" }), /stopped/);
  time(3_000);
  inbox.poll();
  assert.equal(inbox.timers(main)[0]!.state, "cancelled");
  assert.equal(inbox.timers(child)[0]!.state, "cancelled");
  inbox.resume(main.sessionId);
  assert.equal(inbox.acknowledge(stale), false, "resume must not validate a pre-stop batch");
  const resumed = inbox.prepareDelivery(main)!;
  assert.equal(resumed.notifications.length, 2);
  assert.ok(resumed.notifications.every((item) => item.kind === "execution"));
  assert.equal(inbox.acknowledge(resumed), true);
});

test("stopping a child does not stop its parent or sibling; Session resume does not undo child stop", (context) => {
  const { inbox } = fixture(context);
  inbox.createTimer(child, { dueAt: 2_000, message: "Child reminder" });
  inbox.createTimer(main, { dueAt: 2_000, message: "Parent reminder" });
  inbox.stopAgent(child);
  inbox.complete(child, "child-execution", "Child result ready");
  assert.equal(inbox.prepareDelivery(child), undefined);
  assert.equal(inbox.canWakeAgent(main), true);
  assert.equal(inbox.timers(main)[0]!.state, "pending");
  inbox.stop(main.sessionId);
  inbox.resume(main.sessionId);
  assert.equal(inbox.canWakeAgent(child), false);
  inbox.resumeAgent(child);
  assert.equal(inbox.prepareDelivery(child)!.notifications.length, 1);
});

test("one-shot timers fire once and completion supersedes only its own pending reminder", (context) => {
  const { inbox, time } = fixture(context);
  inbox.createTimer(main, { dueAt: 2_000, message: "Check task", executionId: "one" });
  const timer = inbox.createTimer(main, { dueAt: 2_000, message: "Other task", executionId: "two" });
  inbox.createTimer(child, { dueAt: 2_000, message: "Child task", executionId: "one" });
  inbox.complete(main, "one", "Task one finished");
  assert.throws(() => inbox.createTimer(main, { dueAt: 2_000, message: "Too late", executionId: "one" }), /already completed/);
  time(2_000);
  inbox.poll();
  inbox.poll();
  assert.deepEqual(inbox.unread(main).map((notice) => notice.kind).sort(), ["execution", "timer"]);
  assert.equal(inbox.unread(main).find((notice) => notice.kind === "timer")!.sourceId, timer.id);
  assert.equal(inbox.unread(child).length, 1);
});

test("archived Sessions fail closed even if a timer was created before an archive gate was written", (context) => {
  const { inbox, time, archive } = fixture(context);
  inbox.createTimer(main, { dueAt: 2_000, message: "Pending reminder" });
  inbox.complete(main, "one", "Finished");
  const batch = inbox.prepareDelivery(main)!;
  archive();
  time(3_000);
  inbox.poll();
  assert.equal(inbox.acknowledge(batch), false);
  assert.equal(inbox.prepareDelivery(main), undefined);
  assert.throws(() => inbox.resume(main.sessionId), /Archived/);
  assert.equal(inbox.timers(main)[0]!.state, "cancelled");
  assert.equal(inbox.unread(main).length, 1);
});

test("timer polling rollback cannot leave a fired timer without its notification", (context) => {
  const { inbox, time, db } = fixture(context);
  inbox.createTimer(main, { dueAt: 2_000, message: "Reminder" });
  db.exec("CREATE TRIGGER reject_notice BEFORE INSERT ON agent_notifications BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END;");
  time(3_000);
  assert.throws(() => inbox.poll(), /storage unavailable/);
  assert.equal(inbox.timers(main)[0]!.state, "pending");
  assert.equal(inbox.unread(main).length, 0);
  db.exec("DROP TRIGGER reject_notice");
  inbox.poll();
  assert.equal(inbox.timers(main)[0]!.state, "fired");
  assert.equal(inbox.unread(main).length, 1);
});

test("timer ownership and bounded message/time/page validation", (context) => {
  const { inbox } = fixture(context);
  const timer = inbox.createTimer(main, { dueAt: 2_000, message: "Reminder" });
  assert.throws(() => inbox.cancelTimer(child, timer.id), /not found/);
  inbox.cancelTimer(main, timer.id);
  inbox.cancelTimer(main, timer.id);
  assert.equal(inbox.timers(main)[0]!.state, "cancelled");
  for (const dueAt of [NaN, Infinity, 0, 1_000, 1_000.5]) assert.throws(() => inbox.createTimer(main, { dueAt, message: "Bad time" }), /timestamp/);
  assert.throws(() => inbox.createTimer(main, { dueAt: 2_000, message: "x".repeat(4_001) }), /characters/);
  assert.throws(() => inbox.unread(main, 101), /1-100/);
});

test("a delayed user request cannot reopen a gate closed by a later Stop", (context) => {
  const { inbox } = fixture(context);
  const generation = inbox.generation(main.sessionId);
  inbox.stop(main.sessionId);
  assert.equal(inbox.resume(main.sessionId, generation), false);
  assert.equal(inbox.canWake(main.sessionId), false);
  assert.equal(inbox.resume(main.sessionId, inbox.generation(main.sessionId)), true);
});

test("completion records, cancelled timers, and stop survive a database restart", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "inbox-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  let db = new DatabaseSync(join(root, "inbox.sqlite"));
  let inbox = new AgentNotifications(db, () => false, () => 1_000);
  inbox.createTimer(main, { dueAt: 2_000, message: "Old timer" });
  inbox.stop(main.sessionId);
  inbox.complete(main, "one", "Result retained");
  db.close();
  db = new DatabaseSync(join(root, "inbox.sqlite"));
  context.after(() => db.close());
  inbox = new AgentNotifications(db, () => false, () => 3_000);
  inbox.poll();
  assert.equal(inbox.prepareDelivery(main), undefined);
  assert.equal(inbox.unread(main).length, 1);
  assert.equal(inbox.timers(main)[0]!.state, "cancelled");
  inbox.resume(main.sessionId);
  assert.equal(inbox.prepareDelivery(main)!.notifications[0]!.sourceId, "one");
});

test("SessionStore archive closes the gate; restoring the Session retains records without auto-resume", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "inbox-store-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  await store.load();
  const project = await store.createProject("Inbox lifecycle");
  const session = await store.createSession(project.id, "Archive lifecycle", {}, {}, { allowUnconfiguredModel: true });
  const owner = { ...main, sessionId: session.id };
  store.notifications.createTimer(owner, { dueAt: Date.now() + 60_000, message: "Reminder" });
  await store.archiveSession(session.id);
  store.notifications.complete(owner, "one", "Background result retained");
  await store.restoreSession(session.id);
  assert.equal(store.notifications.prepareDelivery(owner), undefined);
  assert.equal(store.notifications.timers(owner)[0]!.state, "cancelled");
  store.notifications.resume(session.id);
  assert.equal(store.notifications.prepareDelivery(owner)!.notifications.length, 1);
  const versions = new VersionStore(root);
  const ref = await versions.putRecord("NotificationAuthorityTest", await versioningAuthorities(store, session.id, "request")());
  await versions.validateClosure(ref);
  const captured = (await versions.readRecord<{ notifications: { notifications: unknown[]; timers: { state: string }[] } }>(ref, "NotificationAuthorityTest")).value;
  assert.equal(captured.notifications.notifications.length, 1);
  assert.equal(captured.notifications.timers[0]!.state, "cancelled");
  await store.deleteSession(session.id, session.id);
  assert.equal(store.notifications.unread(owner).length, 0);
  assert.equal(store.notifications.timers(owner).length, 0);
});
