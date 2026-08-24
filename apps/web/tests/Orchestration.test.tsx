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

import type { SessionPlan, Subagent } from "@sciencediscovery/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ApiClient } from "../src/api.js";
import { BuiltInReviewerSpecialist, OrchestrationPanel, SpecialistManager, SubagentCards } from "../src/Orchestration.js";
import { activityCardId } from "../src/session/run-activity.js";

const timestamp = "2026-07-15T00:00:00.000Z";
const noopToggle = () => undefined;

test("built-in Reviewer Specialist exposes the configured Quick/Deep control", () => {
  const html = renderToStaticMarkup(createElement(BuiltInReviewerSpecialist, {
    busy: true,
    enabled: true,
    level: "deep",
    onLevelChange: () => undefined,
    onToggle: noopToggle,
  }));

  assert.match(html, /aria-label="Reviewer Specialist level"/);
  assert.match(html, /<option value="quick">Quick<\/option>/);
  assert.match(html, /<option value="deep" selected="">Deep<\/option>/);
  assert.doesNotMatch(html, /value="smart"/);
  assert.match(html, /<select[^>]*disabled=""/);
  assert.match(html, /aria-checked="true"/);
});

function buildPlan(overrides: Partial<SessionPlan> = {}): SessionPlan {
  return {
    caveats: ["Validate external references"],
    createdAt: timestamp,
    feasibilityConfidence: "medium",
    id: "plan-1",
    mode: "recorded",
    scope: "Compare two independent methods",
    sessionId: "session-1",
    state: "recorded",
    steps: [{ description: "Run both methods", id: "step-1", status: "pending" }],
    updatedAt: timestamp,
    version: 1,
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

test("recorded plan collapses to a saved-plan summary without live-progress wording", () => {
  const html = renderToStaticMarkup(createElement(OrchestrationPanel, {
    expandedCards: {},
    onToggleCard: noopToggle,
    plans: [buildPlan()],
  }));

  assert.match(html, /Saved plan · v1/);
  assert.match(html, /1 steps · saved, not live progress · medium feasibility/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /recorded mode/);
  // Scope and step list stay folded away until the card is expanded.
  assert.doesNotMatch(html, /Compare two independent methods/);
  assert.doesNotMatch(html, /Run both methods/);
});

test("completed plan summary reports completed step counts", () => {
  const plan = buildPlan({
    state: "completed",
    steps: [
      { description: "Run both methods", id: "step-1", status: "completed" },
      { description: "Summarize", id: "step-2", status: "pending" },
    ],
  });
  const html = renderToStaticMarkup(createElement(OrchestrationPanel, {
    expandedCards: {},
    onToggleCard: noopToggle,
    plans: [plan],
  }));

  assert.match(html, /1\/2 steps completed · medium feasibility/);
  assert.doesNotMatch(html, /saved, not live progress/);
});

test("panel renders every plan it is given, not only the latest", () => {
  const older = buildPlan({ id: "plan-1", version: 1 });
  const newer = buildPlan({ id: "plan-2", version: 2 });
  const html = renderToStaticMarkup(createElement(OrchestrationPanel, {
    expandedCards: {},
    onToggleCard: noopToggle,
    plans: [older, newer],
  }));

  assert.match(html, /Saved plan · v1/);
  assert.match(html, /Saved plan · v2/);
});

test("expanded plan card shows scope, steps, and the recorded-plan note", () => {
  const plan = buildPlan();
  const html = renderToStaticMarkup(createElement(OrchestrationPanel, {
    expandedCards: { [activityCardId("plan", plan.id)]: true },
    onToggleCard: noopToggle,
    plans: [plan],
  }));

  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /Compare two independent methods/);
  assert.match(html, /Run both methods/);
  assert.match(html, /not tracked as live progress/);
});

test("subagent cards default to collapsed summaries with status, turns, and usage", () => {
  const html = renderToStaticMarkup(createElement(SubagentCards, {
    expandedCards: {},
    onToggleCard: noopToggle,
    subagents: [buildSubagent()],
  }));

  assert.match(html, /Method A/);
  assert.match(html, /completed/);
  assert.match(html, /general-purpose · 2\/300 turns · 150 tokens/);
  assert.match(html, /aria-expanded="false"/);
  // Steps and prompt stay folded away until the card is expanded.
  assert.doesNotMatch(html, /Created method-a\.json/);
});

test("running subagents start collapsed as well", () => {
  const running = buildSubagent({ id: "subagent-running", status: "running", steps: [] });
  const html = renderToStaticMarkup(createElement(SubagentCards, {
    expandedCards: {},
    onToggleCard: noopToggle,
    subagents: [running],
  }));

  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /1 running · 1 total/);
});

test("expanded subagent card renders nested steps and token usage from lifted state", () => {
  const subagent = buildSubagent();
  const html = renderToStaticMarkup(createElement(SubagentCards, {
    expandedCards: { [activityCardId("subagent", subagent.id)]: true },
    onToggleCard: noopToggle,
    subagents: [subagent],
  }));

  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /Created method-a\.json/);
  assert.match(html, /150 tokens/);
  assert.match(html, /120 in \/ 30 out/);
});

test("expanded subagent card shows mounted specialist name or id", () => {
  const subagent = buildSubagent({
    input: {
      description: "Code work",
      prompt: "Implement the change.",
      specialistId: "specialist-code",
      subagentType: "code-engineer",
    },
    specialistId: "specialist-code",
  });
  const html = renderToStaticMarkup(createElement(SubagentCards, {
    expandedCards: { [activityCardId("subagent", subagent.id)]: true },
    onToggleCard: noopToggle,
    specialists: [{
      connectorIds: [],
      createdAt: timestamp,
      description: "Builds and debugs analysis code.",
      enabledSkillIds: [],
      id: "specialist-code",
      instructions: "Implement and verify code changes.",
      name: "code-engineer",
      updatedAt: timestamp,
    }],
    subagents: [subagent],
  }));
  const fallbackHtml = renderToStaticMarkup(createElement(SubagentCards, {
    expandedCards: { [activityCardId("subagent", subagent.id)]: true },
    onToggleCard: noopToggle,
    subagents: [subagent],
  }));

  assert.match(html, /Specialist: code-engineer/);
  assert.match(fallbackHtml, /Specialist: specialist-code/);
});

test("subagent tool steps reuse raw sectioned I/O with per-section copy controls", () => {
  const subagent = buildSubagent();
  const html = renderToStaticMarkup(createElement(SubagentCards, {
    expandedCards: { [activityCardId("subagent", subagent.id)]: true },
    onToggleCard: noopToggle,
    subagents: [subagent],
  }));

  assert.equal((html.match(/<details class="tool-io-section" open="">/g) ?? []).length, 3);
  for (const label of ["Input", "stdout", "Created files"]) {
    assert.match(html, new RegExp(`<span class="tool-io-label">${label}</span>`));
    assert.match(html, new RegExp(`aria-label="Copy ${label}"`));
  }
  assert.match(html, /print\(&#x27;Created method-a\.json&#x27;\)/);
  assert.doesNotMatch(html, /<span class="tool-io-label">stderr<\/span>/);
});

test("failed subagent tool steps keep raw input separate from the error", () => {
  const subagent = buildSubagent({
    steps: [{
      content: '{"error":"ZeroDivisionError: division by zero"}',
      createdAt: timestamp,
      id: "failed-tool",
      input: "1 / 0",
      kind: "tool",
      status: "failed",
      toolName: "run_python",
    }],
  });
  const html = renderToStaticMarkup(createElement(SubagentCards, {
    expandedCards: { [activityCardId("subagent", subagent.id)]: true },
    onToggleCard: noopToggle,
    subagents: [subagent],
  }));

  assert.match(html, /<span class="tool-io-label">Input<\/span>/);
  assert.match(html, /<span class="tool-io-label">Error<\/span>/);
  assert.match(html, /1 \/ 0/);
  assert.match(html, /ZeroDivisionError: division by zero/);
  assert.match(html, /aria-label="Copy Error"/);
});

test("subagent tool sections render content beyond the former 400-character summary", () => {
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
  const html = renderToStaticMarkup(createElement(SubagentCards, {
    expandedCards: { [activityCardId("subagent", subagent.id)]: true },
    onToggleCard: noopToggle,
    subagents: [subagent],
  }));

  assert.match(html, new RegExp(`x{${longOutput.length}}`));
});

test("specialist form uses the primary action button skeleton", () => {
  const html = renderToStaticMarkup(createElement(SpecialistManager, {
    client: {} as ApiClient,
    connectors: [],
    onChanged: () => undefined,
    onError: () => undefined,
    skills: [],
  }));

  assert.match(html, /class="primary-button"[^>]*>Create specialist</);
  assert.doesNotMatch(html, /specialist-description-card/);
  assert.match(html, />Description<\/span><textarea required="" rows="4" maxLength="500"/);
});
