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
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { ApiClient } from "../src/api.js";
import { BuiltInReviewerSpecialist, OrchestrationPanel, SpecialistManager, SubagentCards } from "../src/Orchestration.js";
import { activityCardId } from "../src/session/run-activity.js";
import type { RunPlanSnapshot } from "../src/session/run-activity.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const timestamp = "2026-07-15T00:00:00.000Z";
const noopToggle = () => undefined;

test("built-in Reviewer Specialist explains that Quick/Deep is chosen per Session", () => {
  const html = renderToStaticMarkup(createElement(BuiltInReviewerSpecialist, {
    busy: true,
    enabled: true,
    onToggle: noopToggle,
  }));

  assert.match(html, /Choose the level of Quick\/Deep per Session\./);
  assert.doesNotMatch(html, /<select/);
  assert.doesNotMatch(html, /Completed-review handoff/);
  assert.match(html, /<button[^>]*disabled=""/);
  assert.match(html, /aria-checked="true"/);
});

function buildPlan(overrides: Partial<RunPlanSnapshot> = {}): RunPlanSnapshot {
  return {
    agentId: "main",
    explanation: "Compare two independent methods",
    items: [{ status: "pending", step: "Run both methods" }],
    runId: "run-1",
    toolCallId: "call-plan-1",
    turn: 1,
    updatedAt: timestamp,
    ...overrides,
  };
}

function buildSubagent(overrides: Partial<Subagent> = {}): Subagent {
  return {
    createdAt: timestamp,
    id: "subagent-1",
    input: {
      description: "Method A",
      prompt: "Run method A and return a JSON result.",
      subagentType: "general-purpose",
    },
    maxTurns: 300,
    model: { id: "model-1", model: "science-model", name: "Science model" },
    parentTurnId: "turn-1",
    sessionId: "session-1",
    status: "completed",
    steps: [{
      content: "stdout:\nCreated method-a.json\nstderr: (empty)\ncreated files: method-a.json",
      createdAt: timestamp,
      id: "step-1",
      input: "print('Created method-a.json')",
      kind: "tool",
      status: "completed",
      toolName: "run_python",
    }],
    timeoutSeconds: 7_200,
    turnCount: 2,
    usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    ...overrides,
  };
}

test("recorded plan collapses to a live Todo summary", () => {
  const html = renderToStaticMarkup(createElement(OrchestrationPanel, {
    expandedCards: {},
    onToggleCard: noopToggle,
    plans: [buildPlan()],
  }));

  assert.match(html, /Plan · main/);
  assert.match(html, /0\/1 completed/);
  assert.match(html, /<i>Pending<\/i>/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /recorded mode/);
  // Scope and step list stay folded away until the card is expanded.
  assert.doesNotMatch(html, /Compare two independent methods/);
  assert.doesNotMatch(html, /Run both methods/);
});

test("completed plan summary reports completed step counts", () => {
  const plan = buildPlan({
    items: [
      { step: "Run both methods", status: "completed" },
      { step: "Summarize", status: "pending" },
    ],
  });
  const html = renderToStaticMarkup(createElement(OrchestrationPanel, {
    expandedCards: {},
    onToggleCard: noopToggle,
    plans: [plan],
  }));

  assert.match(html, /1\/2 completed/);
  assert.match(html, /completed/);
});

test("panel renders independent plan snapshots for different agents", () => {
  const main = buildPlan({ agentId: "main" });
  const worker = buildPlan({ agentId: "subagent:worker-1", toolCallId: "call-plan-2" });
  const html = renderToStaticMarkup(createElement(OrchestrationPanel, {
    expandedCards: {},
    onToggleCard: noopToggle,
    plans: [main, worker],
  }));

  assert.match(html, /Plan · main/);
  assert.match(html, /Plan · subagent:worker-1/);
});

test("plan badge follows completion and terminal state without repeating the summary", () => {
  for (const [items, terminal, badge] of [
    [[{ step: "Done", status: "completed" }], false, "Completed"],
    [[{ step: "Done", status: "completed" }], true, "Completed"],
    [[{ step: "Unfinished", status: "in_progress" }], true, "Finished"],
    [[{ step: "Working", status: "in_progress" }], false, "In progress"],
    [[], true, "cleared"],
  ] as const) {
    const html = renderToStaticMarkup(createElement(OrchestrationPanel, {
      expandedCards: {}, onToggleCard: noopToggle,
      plans: [buildPlan({ items: [...items] })],
      terminalRunIds: new Set(terminal ? ["run-1"] : []),
    }));
    assert.ok(html.includes(`<i>${badge}</i>`));
    assert.equal((html.match(/\d\/\d completed/g) ?? []).length, 1);
    assert.doesNotMatch(html, /process-record/);
    if (terminal) assert.doesNotMatch(html, /1 in progress/);
  }
});

test("expanded plan card shows the live scope and step states", () => {
  const plan = buildPlan({
    items: [
      { step: "Collect papers", status: "completed" },
      { step: "Compare results", status: "in_progress" },
      { step: "Write report", status: "pending" },
    ],
  });
  const html = renderToStaticMarkup(createElement(OrchestrationPanel, {
    expandedCards: { [activityCardId("plan", `${plan.runId}:${plan.agentId}`)]: true },
    onToggleCard: noopToggle,
    plans: [plan],
  }));

  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /Compare two independent methods/);
  assert.match(html, /Collect papers/);
  assert.match(html, /Compare results/);
  assert.match(html, /Write report/);
  assert.match(html, /aria-label="Completed"/);
  assert.match(html, /aria-label="In progress"/);
  assert.match(html, /aria-label="Pending"/);
  assert.match(html, /plan-item-status completed/);
  assert.match(html, /plan-item-status in_progress/);
  assert.match(html, /plan-item-status pending/);
  assert.match(html, /data-status="pending"/);
});

test("subagent cards link to a page-level view without embedding their process", () => {
  const html = renderToStaticMarkup(createElement(SubagentCards, {
    onOpenSubagent: () => undefined,
    subagents: [buildSubagent()],
  }));

  assert.match(html, /Method A/);
  assert.match(html, /completed/);
  assert.match(html, /general-purpose · 2\/300 turns · 150 tokens/);
  assert.match(html, /class="subagent-open-icon"/);
  assert.doesNotMatch(html, /aria-expanded=/);
  assert.doesNotMatch(html, /Created method-a\.json/);
  assert.doesNotMatch(html, /Run method A and return a JSON result/);
});

test("a running subagent card shows the current streamed step", () => {
  const running = buildSubagent({
    id: "subagent-running",
    status: "running",
    steps: [{
      content: "Searching the evidence catalog",
      createdAt: timestamp,
      id: "step-running",
      input: "vitamin C randomized trials",
      kind: "tool",
      status: "running",
      toolName: "search_papers",
    }],
  });
  const html = renderToStaticMarkup(createElement(SubagentCards, {
    onOpenSubagent: () => undefined,
    subagents: [running],
  }));

  assert.match(html, /1 running · 1 total/);
  assert.match(html, /Current: search_papers · vitamin C randomized trials/);
  assert.doesNotMatch(html, /Subagent steps/);
});

test("a running subagent without a step reports that it is starting", () => {
  const running = buildSubagent({ id: "subagent-running", status: "running", steps: [] });
  const html = renderToStaticMarkup(createElement(SubagentCards, {
    onOpenSubagent: () => undefined,
    subagents: [running],
  }));

  assert.match(html, /1 running · 1 total/);
  assert.match(html, /Starting…/);
});

test("clicking a subagent card selects that SubAgent for navigation", async () => {
  const subagent = buildSubagent();
  let selected: Subagent | undefined;
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(createElement(SubagentCards, {
      onOpenSubagent: (candidate) => { selected = candidate; },
      subagents: [subagent],
    }));
  });

  await act(async () => renderer!.root.findByType("button").props.onClick());
  assert.equal(selected, subagent);
  await act(async () => renderer!.unmount());
});

test("specialist editor starts collapsed behind the specialist list", () => {
  const html = renderToStaticMarkup(createElement(SpecialistManager, {
    client: {} as ApiClient,
    connectors: [],
    onChanged: () => undefined,
    onError: () => undefined,
    skills: [],
  }));

  // The list-type setting shows the list first; the blank create form only
  // opens after "New specialist" is clicked.
  assert.match(html, />＋ New specialist</);
  assert.doesNotMatch(html, /specialist-form-card/);
  assert.doesNotMatch(html, /specialist-description-card/);
});
