// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import test from "node:test";

import { AtomicHistoryWindowPolicy } from "./history-window.js";
import { ConservativeTokenEstimator } from "./token-estimator.js";

const estimator = new ConservativeTokenEstimator();

test("message window keeps the latest user round and tool call/result pair", () => {
  const history = [
    { role: "user", content: "old" },
    { role: "assistant", content: "old answer" },
    { role: "user", content: "new" },
    { role: "assistant", content: "", tool_calls: [{ id: "call-1", function: { name: "search", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call-1", content: "result" },
    { role: "assistant", content: "answer" },
  ];
  const result = new AtomicHistoryWindowPolicy().select(history, {
    maxMessages: 3,
    reservedTokens: 0,
  }, estimator);
  assert.deepEqual(result.history, history.slice(2));
  assert.equal(result.statistics.removedMessages, 2);
});

test("token window preserves summary checkpoint and latest task", () => {
  const checkpoint = {
    role: "user",
    name: "summary",
    content: "summary",
    additional_kwargs: { science_agent_summary_checkpoint: true },
  };
  const result = new AtomicHistoryWindowPolicy().select([
    checkpoint,
    { role: "user", content: "old task" },
    { role: "assistant", content: "x".repeat(100) },
    { role: "user", content: "latest task" },
  ], { maxTokens: 40, reservedTokens: 0 }, estimator);
  assert.equal(result.history[0]?.name, "summary");
  assert.equal(result.history.at(-1)?.content, "latest task");
  assert.ok(result.diagnostics.some((item) => item.code === "CONTEXT_HISTORY_WINDOWED"));
});

test("window recognizes the current ScienceDiscovery summary checkpoint key", () => {
  const policy = new AtomicHistoryWindowPolicy();
  const checkpoint = {
    additional_kwargs: { sciencediscovery_summary_checkpoint: true },
    content: "summary",
    name: "summary",
    role: "assistant",
  };
  const result = policy.select([
    checkpoint,
    { content: "old", role: "user" },
    { content: "old answer", role: "assistant" },
    { content: "latest", role: "user" },
  ], { maxRounds: 1, reservedTokens: 0 }, estimator);

  assert.equal(result.history[0]?.name, "summary");
  assert.equal(result.history.at(-1)?.content, "latest");
});
