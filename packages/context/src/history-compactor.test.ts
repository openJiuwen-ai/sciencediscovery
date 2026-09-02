// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeMessage } from "@sciencediscovery/runtime-core";

import { HistoryCompactor } from "./history-compactor.js";
import type { TokenEstimator } from "./token-estimator.js";

const estimator: TokenEstimator = {
  estimateMessage(message) {
    return (typeof message.content === "string" ? message.content.length : 0) + 1;
  },
  estimateSystemPrompt(value) { return value.length; },
  estimateTools() { return 0; },
};

test("token pressure prunes tool bodies before spending a summary model call", async () => {
  let summaries = 0;
  const compactor = new HistoryCompactor<RuntimeMessage>(async () => {
    summaries += 1;
    return "summary";
  });
  const history = [
    { role: "user", content: "task" },
    { role: "assistant", content: "", tool_calls: [{ id: "call-1" }] },
    { role: "tool", tool_call_id: "call-1", content: `The full output is stored as ref "tool-output-abcdef12".\n${"x".repeat(100)}` },
    { role: "assistant", content: "continue" },
  ];
  const result = await compactor.compactDetailed(history, new AbortController().signal, () => undefined, {
    estimator,
    pressureTokens: 170,
    retainTokens: 10,
  });
  assert.equal(result.statistics.reason, "token-pressure");
  assert.equal(result.statistics.prunedToolResults, 1);
  assert.equal(result.statistics.summarizedMessages, 0);
  assert.equal(summaries, 0);
  assert.match(String(result.history[2]?.content), /tool-output-abcdef12/u);
  assert.equal(result.history[2]?.tool_call_id, "call-1");
});

test("compaction summarizes old closed work inside one user request and keeps the recent tail", async () => {
  const compactor = new HistoryCompactor<RuntimeMessage>(async () => "goal and completed work");
  const result = await compactor.compactDetailed([
    { role: "user", content: "one long autonomous research task" },
    { role: "assistant", content: "first finding ".repeat(8) },
    { role: "assistant", content: "second finding ".repeat(8) },
    { role: "assistant", content: "current reasoning" },
  ], new AbortController().signal, () => undefined, {
    estimator,
    pressureTokens: 60,
    retainTokens: 20,
  });
  assert.equal(result.history[0]?.name, "summary");
  assert.equal(result.history.at(-1)?.content, "current reasoning");
  assert.ok(result.statistics.summarizedMessages >= 1);
});

test("forced recovery never summarizes an incomplete tool-call contract", async () => {
  const compactor = new HistoryCompactor<RuntimeMessage>(async () => "task summary");
  const result = await compactor.compactDetailed([
    { role: "user", content: "task" },
    { role: "assistant", content: "older work" },
    { role: "assistant", content: "", tool_calls: [{ id: "pending" }] },
  ], new AbortController().signal, () => undefined, {
    estimator,
    force: true,
    pressureTokens: 10,
    retainTokens: 1,
  });
  assert.equal(result.history.at(-1)?.tool_calls instanceof Array, true);
  assert.equal((result.history.at(-1)?.tool_calls as Array<{ id: string }>)[0]?.id, "pending");
});
