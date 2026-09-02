// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import test from "node:test";

import { applyContextBudget, resolveContextBudget } from "./budget.js";
import type { CollectedContext } from "./contributor.js";

function collected(): CollectedContext {
  return {
    attachments: [{ content: "d".repeat(20), contributorId: "data", id: "data.one", source: "test", trust: "trusted_data" }],
    diagnostics: [],
    messages: [{ role: "user", content: "old" }, { role: "user", content: "new" }],
    sections: [
      { content: "authority", contributorId: "identity", id: "identity", priority: 100, protected: true, slot: "identity" },
      { content: "x".repeat(20), contributorId: "skills", id: "skills", priority: 500, slot: "capabilities" },
    ],
  };
}

test("budget preserves protected authority and deterministically truncates optional context", () => {
  const output = applyContextBudget(collected(), {
    attachmentMaxCharacters: 8,
    compactionPressurePercent: 80,
    compactionRetainPercent: 16,
    contributedMessageBudgetCharacters: 3,
    dataBudgetCharacters: 8,
    maxContributedMessages: 1,
    promptBudgetCharacters: 14,
    sectionMaxCharacters: 10,
  });
  assert.equal(output.sections[0]?.content, "authority");
  assert.equal(output.sections[1]?.content.length, 4);
  assert.equal(output.sections.map((section) => section.content).join("\n").length, 14);
  assert.equal(output.attachments[0]?.content.length, 8);
  assert.deepEqual(output.messages, [{ role: "user", content: "new" }]);
  assert.ok(output.diagnostics.some((item) => item.code === "CONTEXT_SECTION_TRUNCATED"));
});

test("budget rejects protected sections that cannot fit without weakening authority", () => {
  const input = collected();
  assert.throws(() => applyContextBudget(input, {
    attachmentMaxCharacters: 10,
    compactionPressurePercent: 80,
    compactionRetainPercent: 16,
    contributedMessageBudgetCharacters: 10,
    dataBudgetCharacters: 10,
    maxContributedMessages: 1,
    promptBudgetCharacters: 3,
    sectionMaxCharacters: 10,
  }), /Protected context sections require/u);
});

test("budget environment resolves native window settings", () => {
  const budget = resolveContextBudget({
    SCIENCE_AGENT_CONTEXT_COMPACTION_PRESSURE_PERCENT: "75",
    SCIENCE_AGENT_CONTEXT_COMPACTION_RETAIN_PERCENT: "20",
    SCIENCE_AGENT_CONTEXT_PROMPT_BUDGET_CHARS: "1234",
    SCIENCE_AGENT_CONTEXT_MODEL_MAX_TOKENS: "100000",
    SCIENCE_AGENT_CONTEXT_OUTPUT_RESERVE_TOKENS: "12000",
    SCIENCE_AGENT_CONTEXT_WINDOW_MESSAGES: "80",
    SCIENCE_AGENT_CONTEXT_WINDOW_ROUNDS: "12",
    SCIENCE_AGENT_CONTEXT_WINDOW_TOKENS: "64000",
  });
  assert.equal(budget.promptBudgetCharacters, 1234);
  assert.equal(budget.compactionPressurePercent, 75);
  assert.equal(budget.compactionRetainPercent, 20);
  assert.equal(budget.modelContextTokens, 100000);
  assert.equal(budget.outputReserveTokens, 12000);
  assert.equal(budget.windowMessages, 80);
  assert.equal(budget.windowRounds, 12);
  assert.equal(budget.windowTokens, 64000);
  assert.throws(
    () => resolveContextBudget({ SCIENCE_AGENT_CONTEXT_DATA_BUDGET_CHARS: "0" }),
    /must be a positive integer/u,
  );
  assert.throws(
    () => resolveContextBudget({
      SCIENCE_AGENT_CONTEXT_MODEL_MAX_TOKENS: "100",
      SCIENCE_AGENT_CONTEXT_OUTPUT_RESERVE_TOKENS: "100",
    }),
    /must be smaller/u,
  );
  assert.throws(
    () => resolveContextBudget({ SCIENCE_AGENT_CONTEXT_COMPACTION_PRESSURE_PERCENT: "101" }),
    /between 1 and 100/u,
  );
  assert.throws(
    () => resolveContextBudget({
      SCIENCE_AGENT_CONTEXT_COMPACTION_PRESSURE_PERCENT: "80",
      SCIENCE_AGENT_CONTEXT_COMPACTION_RETAIN_PERCENT: "80",
    }),
    /must be smaller/u,
  );
});

test("resolved model facts seed the window while explicit environment remains authoritative", () => {
  assert.equal(resolveContextBudget({}, { modelContextTokens: 200_000 }).modelContextTokens, 200_000);
  assert.equal(resolveContextBudget({ SCIENCE_AGENT_CONTEXT_MODEL_MAX_TOKENS: "300000" }, {
    modelContextTokens: 200_000,
  }).modelContextTokens, 300_000);
});
