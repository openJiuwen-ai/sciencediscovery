// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { SessionRun } from "@sciencediscovery/schema";
import { AgentNotifications } from "./agent-notifications.js";
import { NotificationDispatcher, notificationPrompt } from "./notification-dispatch.js";
import type { SessionStore } from "./store.js";

test("busy inbox waits; idle dispatch persists context once without reopening stopped gates", async (t) => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  let archived = false; let now = 1000; let busy = true; let enqueued = 0; let scheduled = 0;
  const notifications = new AgentNotifications(db, () => archived, () => now);
  const owner = { sessionId: "session", agentId: "main" };
  const runs: SessionRun[] = [];
  const store = { notifications, getSession: () => ({}), listSessionRuns: async () => busy ? [{ status: "running" }] : runs } as unknown as SessionStore;
  const dispatcher = new NotificationDispatcher(store, async (batch) => {
    enqueued++; const run = { status: "queued", notificationDelivery: batch } as SessionRun; runs.push(run); return run;
  }, () => { scheduled++; });
  notifications.complete(owner, "execution", "finished, inspect result");
  await dispatcher.tick(); assert.equal(enqueued, 0);
  busy = false; await dispatcher.tick(); await dispatcher.tick();
  assert.equal(enqueued, 1); assert.equal(scheduled, 1); assert.equal(notifications.unread(owner).length, 1);
  const batch = runs[0]!.notificationDelivery!;
  notifications.stop(owner.sessionId);
  assert.equal(notifications.pendingDelivery(batch), undefined);
  runs.length = 0; await dispatcher.tick(); assert.equal(enqueued, 1);
  notifications.resume(owner.sessionId);
  const restored = notifications.prepareDelivery(owner)!;
  assert.match(notificationPrompt(restored), /not commands to replay/);
  notifications.acknowledge(restored); assert.equal(notifications.pendingDelivery(restored), undefined);
  notifications.createTimer(owner, { dueAt: 2000, message: "check later" });
  archived = true; now = 3000; await dispatcher.tick();
  assert.equal(notifications.timers(owner)[0]!.state, "cancelled"); assert.equal(enqueued, 1);
});

test("failed enqueue retains unread; child notices are never redirected to Main", async (t) => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const notifications = new AgentNotifications(db, () => false);
  const main = { sessionId: "session", agentId: "main" };
  notifications.complete({ ...main, agentId: "subagent:child" }, "child-job", "child done");
  const store = { notifications, getSession: () => ({}), listSubagents: () => [], listSessionRuns: async () => [] } as unknown as SessionStore;
  let attempts = 0;
  const dispatcher = new NotificationDispatcher(store, async () => { attempts++; throw new Error("storage failed"); }, () => assert.fail());
  await dispatcher.tick(); assert.equal(attempts, 0);
  notifications.complete(main, "job", "done");
  await assert.rejects(dispatcher.tick(), /storage failed/);
  assert.equal(notifications.unread(main).length, 1);
  dispatcher.close(); await dispatcher.tick(); assert.equal(attempts, 1);
});

test("child dispatch preserves owner and requires a saved idle context", async (t) => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const notifications = new AgentNotifications(db, () => false);
  const owner = { sessionId: "session", agentId: "subagent:child" };
  const child = { id: "child", status: "running", contextRef: {} };
  const store = { notifications, getSession: () => ({}), listSubagents: () => [child], listSessionRuns: async () => [] } as unknown as SessionStore;
  let count = 0;
  const dispatcher = new NotificationDispatcher(store, async (batch) => {
    assert.equal(batch.agentId, owner.agentId); count++; return {} as SessionRun;
  }, () => {});
  notifications.complete(owner, "job", "done");
  await dispatcher.tick(); assert.equal(count, 0);
  child.status = "completed"; await dispatcher.tick(); assert.equal(count, 1);
  notifications.stopAgent(owner); await dispatcher.tick(); assert.equal(count, 1);
});
