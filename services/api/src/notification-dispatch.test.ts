// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import type { SessionRun } from "@sciencediscovery/schema";
import { AgentNotifications } from "./agent-notifications.js";
import { NotificationDispatcher, notificationPrompt, runtimeNotice } from "./notification-dispatch.js";
import type { SessionStore } from "./store.js";
import { messagePromptContent } from "./workbench/index.js";

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

test("a delivery is counted for the transcript and re-attached only for the model", async (t) => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  let now = 1000;
  const notifications = new AgentNotifications(db, () => false, () => now);
  const owner = { sessionId: "session", agentId: "main" };
  // Records are delivered in creation order, so each one gets its own instant.
  notifications.complete(owner, "job-one", "first execution done");
  now = 1500; notifications.complete(owner, "job-two", "second execution done");
  const timer = notifications.createTimer(owner, { dueAt: 2000, message: "check later" });
  now = 3000; notifications.poll();
  const notice = runtimeNotice(notifications.prepareDelivery(owner)!, [
    { id: "job-one", runnerId: "local", state: "completed" },
    { id: "job-two", runnerId: "hpc", state: "failed" },
  ]);
  assert.deepEqual({ executions: notice.executions, timers: notice.timers }, { executions: 2, timers: 1 });
  // The UI gets what finished and how, keyed for the activity panel; it never
  // has to parse the prompt to find that out.
  assert.deepEqual(notice.records, [
    { agentId: "main", kind: "execution", runnerId: "local", sourceId: "job-one", state: "completed" },
    { agentId: "main", kind: "execution", runnerId: "hpc", sourceId: "job-two", state: "failed" },
    { agentId: "main", kind: "timer", message: "check later", sourceId: timer.id },
  ]);
  const unknown = runtimeNotice(notifications.prepareDelivery(owner)!);
  assert.deepEqual(unknown.records![0], { agentId: "main", kind: "execution", sourceId: "job-one" }, "a record without a catalog entry carries no guessed outcome");

  // A wake carries no user-authored body, so the transcript body stays empty
  // while the model still receives the full record set.
  assert.equal(messagePromptContent({ content: "", runtimeNotice: notice }), notice.prompt);
  assert.match(messagePromptContent({ content: "", runtimeNotice: notice }), /^\[Execution notifications\]/);
  // A real request keeps its own text first and is never rewritten by the delivery.
  assert.equal(messagePromptContent({ content: "summarize the run", runtimeNotice: notice }),
    `summarize the run\n\n${notice.prompt}`);
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

test("resuming one child after Session Stop admits Main and other unstopped children", async (t) => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const notifications = new AgentNotifications(db, () => false);
  const owners = ["main", "subagent:a", "subagent:b"].map((agentId) => ({ sessionId: "session", agentId }));
  const children = ["a", "b"].map((id) => ({ id, status: "completed", contextRef: {} }));
  const admitted: string[] = [];
  const store = { notifications, getSession: () => ({}), listSubagents: () => children,
    listSessionRuns: async () => [] } as unknown as SessionStore;
  const dispatcher = new NotificationDispatcher(store, async (batch) => {
    admitted.push(batch.agentId); return {} as SessionRun;
  }, () => {});
  notifications.stop("session");
  for (const owner of owners) notifications.complete(owner, `job-${owner.agentId}`, "done");
  await dispatcher.tick();
  assert.deepEqual(admitted, []);
  notifications.resumeAgent(owners[1]!);
  await dispatcher.tick();
  assert.deepEqual(admitted.sort(), owners.map((owner) => owner.agentId).sort());
});
