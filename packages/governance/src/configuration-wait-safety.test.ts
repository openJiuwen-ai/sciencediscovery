// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { ExecutionBlocks } from "./execution-blocks.js";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
const owner = { sessionId: "session-a", runId: "run-a", requestId: "configuration-a", stopGeneration: 4 };
const runner = { sessionId: owner.sessionId, executionId: owner.runId, runnerId: "local", operationId: owner.requestId,
  reason: "sandbox unavailable", alternatives: [{ runnerId: "remote", label: "Authorized alternative" }] };
const binding = (extra = {}) => ({ ...owner, expiresAt: Date.now() + 60_000, ...extra });

test("configuration waits cannot be listed or decided through the public execution-repair interface", async context => {
  const queue = new ExecutionBlocks(); context.after(() => queue.close());
  let resolved = false;
  const configuration = queue.waitForConfiguration(binding()).then(result => { resolved = true; return result; });
  assert.deepEqual(queue.list(owner.sessionId), []);
  for (const action of ["retry", "cancel"] as const) {
    assert.throws(() => queue.decide(owner.sessionId, owner.requestId, { action }));
  }
  assert.throws(() => queue.decide(owner.sessionId, owner.requestId, { action: "switch", runnerId: "remote" }));
  const repair = queue.wait(runner);
  const [visible] = queue.list(owner.sessionId); assert.ok(visible);
  queue.decide(owner.sessionId, visible.id, { action: "retry" });
  assert.deepEqual(await repair, { action: "retry" });
  assert.equal(resolved, false, "A repair decision must not release a configuration with the same operation ID");
  assert.ok(queue.configurationWait(owner));
  assert.equal(queue.settleConfiguration(owner), true);
  assert.equal(await configuration, "settled");
  assert.equal(queue.settleConfiguration(owner), false);
});

test("configuration completion requires the complete session/run/request/Stop-generation owner", async context => {
  const queue = new ExecutionBlocks(); context.after(() => queue.close());
  const pending = queue.waitForConfiguration(binding());
  for (const change of [{ sessionId: "foreign" }, { runId: "foreign" }, { requestId: "foreign" }, { stopGeneration: 5 }]) {
    const wrong = { ...owner, ...change };
    assert.equal(queue.configurationWait(wrong), undefined);
    assert.equal(queue.settleConfiguration(wrong), false);
    assert.ok(queue.configurationWait(owner));
  }
  const sibling = { ...owner, sessionId: "session-b" };
  const other = queue.waitForConfiguration({ ...binding(), ...sibling });
  assert.equal(queue.settleConfiguration(owner), true);
  assert.equal(await pending, "settled");
  assert.ok(queue.configurationWait(sibling), "Equal request IDs in another session remain independent");
  assert.equal(queue.settleConfiguration(sibling), true);
  assert.equal(await other, "settled");
});

test("duplicate configuration bindings cannot replace the original activation callback or abort signal", async context => {
  const queue = new ExecutionBlocks<() => string>(); context.after(() => queue.close());
  const controller = new AbortController(), duplicateController = new AbortController();
  const activation = () => "original";
  const pending = queue.waitForConfiguration({ ...binding(), activate: activation }, controller.signal);
  assert.throws(() => queue.waitForConfiguration({ ...binding(), activate: () => "replacement" }, duplicateController.signal));
  duplicateController.abort();
  assert.equal(queue.configurationWait(owner)?.activate, activation);
  assert.equal(queue.configurationWait(owner)?.signal, controller.signal);
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  assert.equal(getEventListeners(duplicateController.signal, "abort").length, 0);
  controller.abort();
  assert.equal(await pending, "cancelled");
  assert.equal(queue.configurationWait(owner), undefined);
  assert.equal(queue.settleConfiguration(owner), false);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("configuration expiry uses its absolute deadline without shortening existing Runner/MCP repair waits", async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_700_000_000_000 });
  const queue = new ExecutionBlocks(); context.after(() => queue.close());
  const controller = new AbortController();
  const configuration = queue.waitForConfiguration(binding({ expiresAt: Date.now() + 25 }), controller.signal);
  const repair = queue.wait(runner);
  const mcp = queue.wait({ ...runner, kind: "mcp", runnerId: "MCP", operationId: "mcp-operation" });
  context.mock.timers.tick(24);
  assert.ok(queue.configurationWait(owner));
  assert.equal(queue.list(owner.sessionId).length, 2);
  context.mock.timers.tick(1);
  assert.equal(await configuration, "timed_out");
  assert.equal(queue.configurationWait(owner), undefined);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(queue.settleConfiguration(owner), false);
  assert.equal(queue.list(owner.sessionId).length, 2);
  context.mock.timers.tick(600_000 - 26);
  assert.equal(queue.list(owner.sessionId).length, 2, "Existing repair waits retain their ten-minute deadline");
  context.mock.timers.tick(1);
  assert.deepEqual(await Promise.all([repair, mcp]), [{ action: "cancel" }, { action: "cancel" }]);
  assert.deepEqual(queue.list(owner.sessionId), []);
});

test("settle, abort, expiry and close release each shared waiter only once and detach all listeners", async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_700_000_000_000 });
  const queue = new ExecutionBlocks();
  const controller = new AbortController();
  let resolutions = 0;
  const pending = queue.waitForConfiguration(binding({ expiresAt: Date.now() + 10 }), controller.signal)
    .then(result => { resolutions++; return result; });
  assert.equal(queue.settleConfiguration(owner), true);
  controller.abort(); context.mock.timers.tick(10); queue.close(); queue.close();
  assert.equal(await pending, "settled"); assert.equal(resolutions, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(queue.configurationWait(owner), undefined);
  assert.equal(queue.settleConfiguration(owner), false);
  const next = new ExecutionBlocks(), secondController = new AbortController();
  const closed = next.waitForConfiguration(binding(), secondController.signal);
  const repaired = next.wait(runner);
  next.close(); secondController.abort(); next.close();
  assert.equal(await closed, "closed");
  assert.deepEqual(await repaired, { action: "cancel" });
  assert.equal(getEventListeners(secondController.signal, "abort").length, 0);
  assert.equal(next.configurationWait(owner), undefined);
  assert.equal(next.settleConfiguration(owner), false);
});

test("a domain expiry notification is one-shot and can leave an accepted decision waiting for activation", async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_700_000_000_000 });
  const queue = new ExecutionBlocks(); context.after(() => queue.close());
  let notifications = 0, resolved = false;
  const pending = queue.waitForConfiguration({ ...binding({ expiresAt: Date.now() + 10 }),
    onExpire: async () => { notifications++; return undefined; } }).then(result => { resolved = true; return result; });
  context.mock.timers.tick(10); await Promise.resolve(); await Promise.resolve();
  assert.equal(notifications, 1); assert.equal(resolved, false);
  assert.ok(queue.configurationWait(owner));
  context.mock.timers.tick(600_000); await Promise.resolve();
  assert.equal(notifications, 1, "Domain expiry is not a second polling loop");
  assert.equal(queue.settleConfiguration(owner), true);
  assert.equal(await pending, "settled");
});

test("an old asynchronous expiry failure cannot release a replacement binding with the same owner", async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_700_000_000_000 });
  const queue = new ExecutionBlocks<() => string>(); context.after(() => queue.close());
  const controller = new AbortController();
  let rejectExpiry!: (error: Error) => void, notifications = 0;
  const expiry = new Promise<"settled" | undefined>((_resolve, reject) => { rejectExpiry = reject; });
  const original = queue.waitForConfiguration({ ...binding({ expiresAt: Date.now() + 10 }),
    onExpire: async () => { notifications++; return expiry; } }, controller.signal);
  context.mock.timers.tick(10); await Promise.resolve();
  assert.equal(notifications, 1);
  controller.abort(); assert.equal(await original, "cancelled");
  const activation = () => "replacement";
  const replacement = queue.waitForConfiguration({ ...binding(), activate: activation });
  rejectExpiry(new Error("Old domain callback failed"));
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
  assert.equal(queue.configurationWait(owner)?.activate, activation);
  assert.equal(queue.settleConfiguration(owner), true);
  assert.equal(await replacement, "settled");
});

test("a failed domain expiry notification fails closed without reporting a configuration decision", async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_700_000_000_000 });
  const queue = new ExecutionBlocks(); context.after(() => queue.close());
  const controller = new AbortController();
  const pending = queue.waitForConfiguration({ ...binding({ expiresAt: Date.now() + 10 }),
    onExpire: async () => { throw new Error("Domain result is unavailable"); } }, controller.signal);
  context.mock.timers.tick(10);
  assert.equal(await pending, "failed");
  assert.equal(queue.configurationWait(owner), undefined);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(queue.settleConfiguration(owner), false);
});
