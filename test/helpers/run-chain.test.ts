// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createTest } from "../support/tagged/compat.mjs";
import { RunChainSettler, type RunChainRun } from "./run-chain.ts";
import { deliveryStatus, finalReferences } from "./real-delivery.mjs";
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

test("run-chain settling waits through its quiet window for a late wake", () => {
  const settler = new RunChainSettler<RunChainRun>();
  assert.equal(settler.observe([root("completed")], [], "root", 10, 3_000), undefined);
  assert.equal(settler.observe([root("completed")], [], "root", 2_000, 3_000), undefined);
  assert.equal(settler.observe([root("completed"), wake("running")], [], "root", 2_500, 3_000), undefined);
  assert.equal(settler.observe([root("completed"), wake("completed")], [], "root", 3_000, 3_000), undefined);
  assert.equal(settler.observe([root("completed"), wake("completed")], [], "root", 6_000, 3_000)?.run.id, "wake");
});

test("run-chain settling ignores automatic wakes and executions owned by subagents", () => {
  const childWake = { ...wake("running"), id: "child-wake", notificationDelivery: { agentId: "subagent:child" } };
  const result = new RunChainSettler<RunChainRun>().observe([root("completed"), childWake],
    [{ agentId: "subagent:child", id: "child-execution", state: "running" }], "root", 0, 0);
  assert.equal(result?.run.id, "root");
  assert.deepEqual(result?.runs.map((run) => run.id), ["root"]);
});


test("the first Run can finish before the final wake delivers an artifact", () => {
  const first = { ...root("completed"), assistantMessageId: "initial-message" };
  const final = { ...wake("completed"), assistantMessageId: "wake-message" };
  const messages = [
    { id: "initial-message", role: "assistant", content: "Background work is still running." },
    { id: "wake-message", role: "assistant", content: "Completed answer.txt" },
  ];
  const artifact = { id: "artifact", logicalName: "answer.txt", versions: [{ id: "version", version: 1 }] };

  // The old single-Run waiter would return here: the foreground Run is terminal,
  // but its background execution is still running and no artifact is delivered.
  assert.equal(first.status, "completed");
  const early = finalReferences(first, messages, [artifact]);
  assert.equal(deliveryStatus(first.status, early.selected), "failed");

  const settler = new RunChainSettler();
  assert.equal(settler.observe([first], [{ agentId: "main", id: "execution", state: "running" }], "root", 0, 0), undefined);
  assert.equal(settler.observe([first, { ...final, status: "running" }],
    [{ agentId: "main", id: "execution", state: "completed" }], "root", 1, 0), undefined);
  const settled = settler.observe([first, final],
    [{ agentId: "main", id: "execution", state: "completed" }], "root", 2, 0);
  assert.equal(settled?.run.id, "wake");
  const delivered = finalReferences(settled!.run, messages, [artifact]);
  assert.deepEqual(delivered.selected.map((item: { id: string }) => item.id), ["artifact"]);
  assert.equal(deliveryStatus(settled!.run.status, delivered.selected), "passed");
});
