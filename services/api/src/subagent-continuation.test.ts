// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import type { Subagent } from "@sciencediscovery/schema";
import { reopenSubagentForContinuation, settleSubagentContinuation } from "./subagent-continuation.js";

function subagent(overrides: Partial<Subagent>): Subagent {
  return {
    createdAt: "2026-09-16T00:00:00.000Z", id: "child", input: { description: "Check the run", prompt: "check" },
    maxTurns: 10, parentTurnId: "run-1", sessionId: "session", status: "completed", steps: [], timeoutSeconds: 60, turnCount: 2,
    ...overrides,
  };
}

test("reopening a child for a wake turn keeps when and how its task ended", () => {
  const failed = subagent({ status: "failed", error: "Result validation failed", finishedAt: "2026-09-16T01:00:00.000Z" });
  const reopened = reopenSubagentForContinuation(failed);
  assert.equal(reopened.status, "running");
  assert.equal(reopened.error, "Result validation failed");
  assert.equal(reopened.finishedAt, "2026-09-16T01:00:00.000Z");
  assert.equal(reopened.turnCount, 2);
});

test("a wake turn that closes normally does not turn a failed task into a clean success", () => {
  const failed = subagent({ status: "failed", error: "Result validation failed", finishedAt: "2026-09-16T01:00:00.000Z" });
  const turn = subagent({ status: "completed", error: "Result validation failed", finishedAt: "2026-09-16T02:00:00.000Z", turnCount: 3 });
  const settled = settleSubagentContinuation(failed, turn);
  assert.equal(settled.status, "failed");
  assert.equal(settled.error, "Result validation failed");
  assert.equal(settled.finishedAt, "2026-09-16T02:00:00.000Z", "the latest turn's end is still recorded");
  assert.equal(settled.turnCount, 3);
  for (const status of ["timed_out", "cancelled"] as const) {
    assert.equal(settleSubagentContinuation(subagent({ status, error: "cap" }), turn).status, status);
  }
});

test("reopening an interrupted child drops the placeholder the API exit left behind", () => {
  const interrupted = subagent({
    error: "API process exited before this child finished", finishedAt: "2026-09-16T01:00:00.000Z",
    interruptedByRestart: true, status: "failed", turnCount: 1,
  });
  const reopened = reopenSubagentForContinuation(interrupted);
  assert.equal(reopened.status, "running");
  assert.equal(reopened.error, undefined, "the placeholder reason is not an outcome to preserve");
  assert.equal(reopened.finishedAt, undefined, "the task has not ended yet");
  assert.equal(reopened.interruptedByRestart, undefined);
  assert.equal(reopened.turnCount, 1, "the committed part of the task is kept");
  assert.equal(reopened.input.description, "Check the run");
});

test("a continuation that finishes an interrupted child records what that turn concluded", () => {
  const interrupted = subagent({
    error: "API process exited before this child finished", finishedAt: "2026-09-16T01:00:00.000Z",
    interruptedByRestart: true, status: "failed",
  });
  const finished = subagent({ status: "completed", finishedAt: "2026-09-16T02:00:00.000Z", turnCount: 3 });
  assert.deepEqual(settleSubagentContinuation(interrupted, finished), finished);
  // A continuation that fails on its own terms still reports its own failure.
  const failedTurn = subagent({ status: "failed", error: "Provider rejected request", finishedAt: "2026-09-16T02:00:00.000Z" });
  assert.deepEqual(settleSubagentContinuation(interrupted, failedTurn), failedTurn);
});

test("a wake turn's own failure and a completed task's normal wake turn are recorded as they happened", () => {
  const completed = subagent({ status: "completed", finishedAt: "2026-09-16T01:00:00.000Z" });
  const failedTurn = subagent({ status: "failed", error: "Provider rejected request", finishedAt: "2026-09-16T02:00:00.000Z" });
  assert.deepEqual(settleSubagentContinuation(completed, failedTurn), failedTurn);
  const normalTurn = subagent({ status: "completed", finishedAt: "2026-09-16T02:00:00.000Z", turnCount: 3 });
  assert.deepEqual(settleSubagentContinuation(completed, normalTurn), normalTurn);
  // A failed task whose wake turn also fails reports the newer failure.
  const failed = subagent({ status: "failed", error: "old reason" });
  assert.equal(settleSubagentContinuation(failed, failedTurn).error, "Provider rejected request");
});
