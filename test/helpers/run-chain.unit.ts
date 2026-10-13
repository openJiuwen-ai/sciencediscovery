// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createTest } from "../support/tagged/compat.mjs";
import { RunChainSettler, type RunChainRun } from "./run-chain.ts";
import { deliveryStatus, selectFinalOutputs } from "./real-delivery.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "arch:amd64", "arch:arm64"] });

const root = (status: string): RunChainRun => ({ id: "root", queueOrder: 1, status });
const wake = (status: string): RunChainRun => ({ automaticWake: true, id: "wake",
  notificationDelivery: { agentId: "main" }, queueOrder: 2, status });

test("run-chain settling follows deferred execution into the automatic main-Agent wake", () => {
  const settler = new RunChainSettler<RunChainRun>();
  assert.equal(settler.observe([root("running")], [{ agentId: "main", id: "execution", state: "running" }], "root", 0, 0), undefined);
  assert.equal(settler.observe([root("completed")], [{ agentId: "main", id: "execution", state: "running" }], "root", 1, 0), undefined);
  assert.equal(settler.observe([root("completed"), wake("running")], [{ agentId: "main", id: "execution", state: "completed" }], "root", 2, 0), undefined);
  const result = settler.observe([root("completed"), wake("completed")], [{ agentId: "main", id: "execution", state: "completed" }], "root", 3, 0);
  assert.equal(result?.run.id, "wake");
  assert.deepEqual(result?.runs.map((run) => run.id), ["root", "wake"]);
});

test("run-chain settling waits for a pending main-Agent timer and its wake", () => {
  const settler = new RunChainSettler<RunChainRun>();
  const pending = [{ agentId: "main", id: "timer", state: "pending" }];
  const fired = [{ agentId: "main", id: "timer", state: "fired" }];
  assert.equal(settler.observe([root("completed")], [], "root", 0, 3_000, pending), undefined);
  assert.equal(settler.observe([root("completed")], [], "root", 4_000, 3_000, pending), undefined);
  assert.equal(settler.observe([root("completed")], [], "root", 5_000, 3_000, fired), undefined);
  assert.equal(settler.observe([root("completed"), wake("running")], [], "root", 5_500, 3_000, fired), undefined);
  assert.equal(settler.observe([root("completed"), wake("completed")], [], "root", 6_000, 3_000, fired), undefined);
  assert.equal(settler.observe([root("completed"), wake("completed")], [], "root", 9_000, 3_000, fired)?.run.id, "wake");
});

test("a fired or cancelled timer does not keep the run chain active forever", () => {
  for (const state of ["fired", "cancelled"]) {
    const settler = new RunChainSettler<RunChainRun>();
    const timers = [{ agentId: "main", id: "timer", state }];
    assert.equal(settler.observe([root("completed")], [], "root", 0, 3_000, timers), undefined);
    assert.equal(settler.observe([root("completed")], [], "root", 3_000, 3_000, timers)?.run.id, "root");
  }
});

test("run-chain settling waits through its quiet window for a late wake", () => {
  const settler = new RunChainSettler<RunChainRun>();
  assert.equal(settler.observe([root("completed")], [], "root", 10, 3_000), undefined);
  assert.equal(settler.observe([root("completed")], [], "root", 2_000, 3_000), undefined);
  assert.equal(settler.observe([root("completed"), wake("running")], [], "root", 2_500, 3_000), undefined);
  assert.equal(settler.observe([root("completed"), wake("completed")], [], "root", 3_000, 3_000), undefined);
  assert.equal(settler.observe([root("completed"), wake("completed")], [], "root", 6_000, 3_000)?.run.id, "wake");
});

test("an active child Run delays main wake dispatch but never becomes the delivery candidate", () => {
  for (const status of ["queued", "running", "blocked"]) {
    const settler = new RunChainSettler<RunChainRun>();
    const childWake = { ...wake(status), id: "child-wake", notificationDelivery: { agentId: "subagent:child" } };
    assert.equal(settler.observe([root("completed"), childWake], [], "root", 0, 3_000), undefined);
    assert.equal(settler.observe([root("completed"), childWake], [], "root", 4_000, 3_000), undefined);
    const completedChild = { ...childWake, status: "completed" };
    assert.equal(settler.observe([root("completed"), completedChild], [], "root", 5_000, 3_000), undefined);
    assert.equal(settler.observe([root("completed"), completedChild, wake("running")], [], "root", 5_500, 3_000), undefined);
    assert.equal(settler.observe([root("completed"), completedChild, wake("completed")], [], "root", 9_000, 3_000), undefined);
    const settled = settler.observe([root("completed"), completedChild, wake("completed")], [], "root", 12_000, 3_000);
    assert.equal(settled?.run.id, "wake");
    assert.deepEqual(settled?.runs.map((run) => run.id), ["root", "wake"]);
  }
});

test("subagent background resources alone do not delay main delivery", () => {
  const completedChild = { ...wake("completed"), id: "child-wake", notificationDelivery: { agentId: "subagent:child" } };
  const result = new RunChainSettler<RunChainRun>().observe([root("completed"), completedChild],
    [{ agentId: "subagent:child", id: "child-execution", state: "running" }], "root", 0, 0,
    [{ agentId: "subagent:child", id: "child-timer", state: "pending" }]);
  assert.equal(result?.run.id, "root");
  assert.deepEqual(result?.runs.map((run) => run.id), ["root"]);
});

test("a failed poll resets the quiet window", () => {
  const settler = new RunChainSettler<RunChainRun>();
  assert.equal(settler.observe([root("completed")], [], "root", 0, 3_000), undefined);
  settler.resetQuiet();
  assert.equal(settler.observe([root("completed")], [], "root", 4_000, 3_000), undefined);
  assert.equal(settler.observe([root("completed")], [], "root", 7_000, 3_000)?.run.id, "root");
});


test("the first Run can finish before the final wake delivers an artifact", () => {
  const first = { ...root("completed"), assistantMessageId: "initial-message" };
  const final = { ...wake("completed"), assistantMessageId: "wake-message" };
  const output = { artifact: { id: "artifact", name: "answer.txt" },
    version: { id: "version", version: 1, turnId: "wake" } };

  // The old single-Run waiter would return here: the foreground Run is terminal,
  // but its background execution is still running and no artifact is delivered.
  assert.equal(first.status, "completed");
  const early = selectFinalOutputs([], ["root"], []);
  assert.equal(deliveryStatus(first.status, early.selected), "failed");

  const settler = new RunChainSettler();
  assert.equal(settler.observe([first], [{ agentId: "main", id: "execution", state: "running" }], "root", 0, 0), undefined);
  assert.equal(settler.observe([first, { ...final, status: "running" }],
    [{ agentId: "main", id: "execution", state: "completed" }], "root", 1, 0), undefined);
  const settled = settler.observe([first, final],
    [{ agentId: "main", id: "execution", state: "completed" }], "root", 2, 0);
  assert.equal(settled?.run.id, "wake");
  const delivered = selectFinalOutputs([output], ["root", "wake"], []);
  assert.deepEqual(delivered.selected.map((item: { artifact: { id: string } }) => item.artifact.id), ["artifact"]);
  assert.equal(deliveryStatus(settled!.run.status, delivered.selected), "passed");
});
