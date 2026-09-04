// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import assert from "node:assert/strict";
import test from "node:test";

import type { Subagent } from "@sciencediscovery/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SubagentConversation, subagentTimelineEntries } from "../src/SubagentConversation.js";

const timestamp = "2026-07-15T00:00:00.000Z";

function buildSubagent(overrides: Partial<Subagent> = {}): Subagent {
  return {
    createdAt: timestamp,
    id: "subagent-1",
    input: {
      description: "Compare method A",
      prompt: "Run method A and return the evidence.",
      specialistId: "specialist-code",
      subagentType: "code-engineer",
    },
    maxTurns: 12,
    model: { id: "model-1", model: "science-model", name: "Science model" },
    parentTurnId: "run-1",
    sessionId: "session-1",
    status: "completed",
    steps: [
      { content: "Prepare a reproducible comparison.", createdAt: timestamp, id: "setup", kind: "system" },
      { content: "Turn 2 started", createdAt: timestamp, id: "turn-2", kind: "system" },
      { content: "I should inspect the source data first.", createdAt: timestamp, id: "thinking-1", kind: "thinking", status: "completed" },
      {
        content: "stdout:\nCreated method-a.json\nstderr: (empty)\ncreated files: method-a.json",
        createdAt: timestamp,
        id: "tool-1",
        input: "print('Created method-a.json')",
        kind: "tool",
        status: "completed",
        toolCallId: "call-1",
        toolName: "run_python",
      },
      { content: "Method A completed successfully.", createdAt: timestamp, id: "answer-1", kind: "assistant", status: "completed" },
    ],
    timeoutSeconds: 7_200,
    turnCount: 2,
    usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    ...overrides,
  };
}

test("SubAgent child steps project into the main run timeline", () => {
  const entries = subagentTimelineEntries(buildSubagent());

  assert.deepEqual(entries.map((entry) => entry.type), ["thinking", "tool", "assistant"]);
  const thinking = entries[0];
  assert.equal(thinking?.type === "thinking" && thinking.turn, 2);
  assert.equal(thinking?.type === "thinking" && thinking.expanded, false);
  const tool = entries[1];
  assert.equal(tool?.type === "tool" && tool.trace.name, "run_python");
  assert.equal(tool?.type === "tool" && tool.trace.input, "print('Created method-a.json')");
  assert.match(tool?.type === "tool" ? tool.trace.output ?? "" : "", /Created method-a\.json/);
});

test("the page-level SubAgent view reuses conversation and timeline UI without a composer", () => {
  const html = renderToStaticMarkup(createElement(SubagentConversation, {
    onBack: () => undefined,
    projectName: "Vitamin C study",
    sessionTitle: "Evidence review",
    specialistName: "code-engineer",
    subagent: buildSubagent(),
    workspaceSessionId: "session-1",
  }));

  assert.match(html, /class="conversation subagent-conversation"/);
  assert.match(html, /aria-label="Back to main Agent"/);
  assert.match(html, /Vitamin C study/);
  assert.match(html, /Evidence review/);
  assert.match(html, /Run method A and return the evidence/);
  assert.match(html, /SUBAGENT · CODE-ENGINEER · SCIENCE MODEL/i);
  assert.match(html, /Thought process · turn 2/);
  assert.match(html, /run_python/);
  assert.match(html, /Method A completed successfully/);
  assert.match(html, /150 tokens · 120 in \/ 30 out/);
  assert.doesNotMatch(html, /Prepare a reproducible comparison/);
  assert.doesNotMatch(html, /Turn 2 started/);
  assert.doesNotMatch(html, /<form/);
  assert.doesNotMatch(html, /<textarea/);
});

test("completed SubAgent tool I/O remains fully inspectable on the page", () => {
  const longOutput = "x".repeat(650);
  const subagent = buildSubagent({
    steps: [{
      content: `stdout:\n${longOutput}\nstderr: (empty)`,
      createdAt: timestamp,
      id: "long-tool",
      input: "print('x' * 650)",
      kind: "tool",
      status: "completed",
      toolName: "run_python",
    }],
  });
  const html = renderToStaticMarkup(createElement(SubagentConversation, {
    onBack: () => undefined,
    projectName: "Project",
    sessionTitle: "Session",
    subagent,
  }));

  assert.match(html, /<span class="tool-io-label">Input<\/span>/);
  assert.match(html, /<span class="tool-io-label">stdout<\/span>/);
  assert.match(html, new RegExp(`x{${longOutput.length}}`));
});

test("running steps stay expanded and failed SubAgents expose their error", () => {
  const runningEntries = subagentTimelineEntries(buildSubagent({
    status: "running",
    steps: [{
      content: "Waiting for results",
      createdAt: timestamp,
      id: "active-tool",
      input: "vitamin C trials",
      kind: "tool",
      status: "running",
      toolName: "search_papers",
    }],
  }));
  assert.equal(runningEntries[0]?.type === "tool" && runningEntries[0].expanded, true);
  assert.equal(runningEntries[0]?.type === "tool" && runningEntries[0].trace.output, undefined);

  const html = renderToStaticMarkup(createElement(SubagentConversation, {
    onBack: () => undefined,
    projectName: "Project",
    sessionTitle: "Session",
    subagent: buildSubagent({ error: "Provider interrupted the child run", status: "failed" }),
  }));
  assert.match(html, /Provider interrupted the child run/);
  assert.match(html, /class="failed">failed<\/em>/);
});
