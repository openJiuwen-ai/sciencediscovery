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

import type { ArtifactReviewRun, RunStreamEvent, Subagent } from "@sciencediscovery/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { reduceRunTimeline, RunTimeline, skillDraftNameFromTrace, type RunTimelineEntry } from "../src/RunTimeline.js";

function apply(events: RunStreamEvent[]): RunTimelineEntry[] {
  return events.reduce(reduceRunTimeline, [] as RunTimelineEntry[]);
}

function timelineSubagent(id: string, createdAt: string, overrides: Partial<Subagent> = {}): Subagent {
  return {
    createdAt,
    id,
    input: { description: `Research lane ${id}`, prompt: `Investigate ${id}` },
    maxTurns: 12,
    parentTurnId: "run-1",
    sessionId: "session-1",
    status: "running",
    steps: [],
    timeoutSeconds: 300,
    turnCount: 0,
    ...overrides,
  };
}

test("keeps reasoning, tools, and answers in start order", () => {
  const entries = apply([
    {
      model: { id: "model-1", model: "test-model", name: "Test model" },
      runId: "run-1",
      settings: { enabledConnectorIds: [], enabledSkillIds: [], modelId: "model-1", semanticReviewEnabled: false },
      type: "run.started",
    },
    { phase: "thinking", turn: 1, type: "agent.phase" },
    { delta: "I should inspect the data.", turn: 1, type: "assistant.thinking.delta" },
    { trace: { id: "tool-1", name: "run_python", status: "running" }, type: "tool.started" },
    { trace: { id: "tool-1", name: "run_python", status: "completed", summary: "3 rows" }, type: "tool.completed" },
    { phase: "thinking", turn: 2, type: "agent.phase" },
    { delta: "The calculation is complete.", turn: 2, type: "assistant.thinking.delta" },
    { delta: "The result is ", type: "assistant.delta" },
    { delta: "three rows.", type: "assistant.delta" },
  ]);

  assert.deepEqual(entries.map((entry) => entry.type), ["thinking", "tool", "thinking", "assistant"]);
  assert.equal(entries[0]?.type === "thinking" && entries[0].content, "I should inspect the data.");
  assert.equal(entries[0]?.type === "thinking" && entries[0].expanded, false);
  assert.equal(entries[1]?.type === "tool" && entries[1].trace.status, "completed");
  assert.equal(entries[1]?.type === "tool" && entries[1].trace.summary, "3 rows");
  assert.equal(entries[2]?.type === "thinking" && entries[2].expanded, false);
  assert.equal(entries[3]?.type === "assistant" && entries[3].content, "The result is three rows.");
});

test("anchors overlapping SubAgents as one parallel timeline group and updates each lane independently", () => {
  const laneA = timelineSubagent("lane-a", "2026-01-01T00:00:01.000Z");
  const laneB = timelineSubagent("lane-b", "2026-01-01T00:00:02.000Z");
  const entries = apply([
    { phase: "thinking", turn: 1, type: "agent.phase" },
    { delta: "Delegate the evidence checks.", turn: 1, type: "assistant.thinking.delta" },
    { subagent: laneA, type: "subagent.updated" },
    { subagent: laneB, type: "subagent.updated" },
    {
      step: { content: "A started", createdAt: "2026-01-01T00:00:03.000Z", id: "step-a", kind: "assistant" },
      subagentId: laneA.id,
      type: "subagent.step",
    },
    {
      step: { content: "B result", createdAt: "2026-01-01T00:00:03.500Z", id: "step-b", kind: "assistant" },
      subagentId: laneB.id,
      type: "subagent.step",
    },
    {
      step: { content: "A final result", createdAt: "2026-01-01T00:00:03.000Z", id: "step-a", kind: "assistant" },
      subagentId: laneA.id,
      type: "subagent.step",
    },
    {
      subagentId: laneB.id,
      type: "subagent.usage",
      usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
    },
    {
      subagent: {
        ...laneA,
        finishedAt: "2026-01-01T00:00:04.000Z",
        status: "completed",
        turnCount: 2,
      },
      type: "subagent.updated",
    },
    { delta: "Both checks are complete.", type: "assistant.delta" },
  ]);

  assert.deepEqual(entries.map((entry) => entry.type), ["thinking", "subagents", "assistant"]);
  const group = entries[1];
  assert.equal(group?.type, "subagents");
  if (group?.type !== "subagents") return;
  assert.deepEqual(group.subagents.map((subagent) => subagent.id), [laneA.id, laneB.id]);
  assert.equal(group.subagents[0]?.steps[0]?.content, "A final result");
  assert.equal(group.subagents[1]?.steps[0]?.content, "B result", "lane A updates do not overwrite lane B");
  assert.equal(group.subagents[0]?.status, "completed");
  assert.equal(group.subagents[1]?.usage?.totalTokens, 50);

  const html = renderToStaticMarkup(createElement(RunTimeline, {
    entries,
    isRunning: false,
    onOpenSubagent: () => undefined,
    onToggle: () => undefined,
  }));
  assert.match(html, /Subagents/);
  assert.match(html, /class="subagent-list timeline-subagents"/);
  assert.doesNotMatch(html, /timeline-subagents parallel/);
  assert.doesNotMatch(html, /A final result/);
  assert.match(html, /B result/);
  assert.doesNotMatch(html, /aria-expanded=/);
});

test("places non-overlapping SubAgents in separate timeline groups", () => {
  const laneA = timelineSubagent("lane-a", "2026-01-01T00:00:01.000Z");
  const completedA = {
    ...laneA,
    finishedAt: "2026-01-01T00:00:02.000Z",
    status: "completed" as const,
  };
  const laneB = timelineSubagent("lane-b", "2026-01-01T00:00:03.000Z");
  const entries = apply([
    { subagent: laneA, type: "subagent.updated" },
    { subagent: completedA, type: "subagent.updated" },
    { content: "Between delegated tasks", type: "assistant.snapshot" },
    { subagent: laneB, type: "subagent.updated" },
  ]);

  assert.deepEqual(entries.map((entry) => entry.type), ["subagents", "assistant", "subagents"]);
});

test("keeps streamed SubAgent steps when a terminal snapshot omits its process", () => {
  const lane = timelineSubagent("lane-a", "2026-01-01T00:00:01.000Z");
  const entries = apply([
    { subagent: lane, type: "subagent.updated" },
    {
      step: {
        content: "Evidence search completed",
        createdAt: "2026-01-01T00:00:02.000Z",
        id: "search-step",
        kind: "tool",
        status: "completed",
        toolName: "search_papers",
      },
      subagentId: lane.id,
      type: "subagent.step",
    },
    {
      subagent: {
        ...lane,
        finishedAt: "2026-01-01T00:00:03.000Z",
        status: "completed",
        steps: [],
      },
      type: "subagent.updated",
    },
  ]);

  const group = entries[0];
  assert.equal(group?.type === "subagents" && group.subagents[0]?.status, "completed");
  assert.equal(group?.type === "subagents" && group.subagents[0]?.steps[0]?.content, "Evidence search completed");
});

test("Idea Tree phases are ordered, deduplicated, rendered, and closed at terminal events", () => {
  const entries = apply([
    { phase: "preflight_research", treeId: "tree-1", type: "idea_tree.phase" },
    { phase: "preflight_research", treeId: "tree-1", type: "idea_tree.phase" },
    { nodeId: "node-2", phase: "executing_leaf", treeId: "tree-1", type: "idea_tree.phase" },
    { reason: "Run cancelled by test", type: "run.cancelled" },
  ]);

  assert.deepEqual(entries.map((entry) => entry.type), ["idea-tree-phase", "idea-tree-phase"]);
  assert.deepEqual(entries.map((entry) => entry.type === "idea-tree-phase" && entry.status), ["completed", "completed"]);
  const html = renderToStaticMarkup(createElement(RunTimeline, {
    entries,
    isRunning: false,
    onToggle: () => undefined,
  }));
  assert.match(html, /Researching literature/);
  assert.match(html, /Executing leaf/);
  assert.match(html, /node-2/);
  assert.equal((html.match(/idea-tree-phase completed/g) ?? []).length, 2);
});

test("renders completed activity as collapsible disclosures", () => {
  const entries = apply([
    { phase: "thinking", turn: 1, type: "agent.phase" },
    { delta: "Use the local calculator.", turn: 1, type: "assistant.thinking.delta" },
    { trace: { id: "tool-1", name: "run_python", status: "running" }, type: "tool.started" },
    { trace: { id: "tool-1", name: "run_python", status: "completed", summary: "42" }, type: "tool.completed" },
    { delta: "**Answer:** 42", type: "assistant.delta" },
  ]);
  const html = renderToStaticMarkup(createElement(RunTimeline, {
    entries,
    isRunning: false,
    modelName: "Test model",
    onToggle: () => undefined,
  }));

  // Two top-level disclosures (thinking + tool card), both closed after
  // completion, plus the tool card's I/O section disclosures which default open.
  assert.match(html, /<details class="timeline-disclosure thinking completed">/);
  assert.match(html, /<details class="timeline-disclosure tool completed">/);
  assert.equal((html.match(/<details/g) ?? []).length, 3);
  assert.match(html, /<details class="tool-io-section" open="">/);
  assert.match(html, /Thought process · turn 1/);
  assert.match(html, /run_python/);
  assert.match(html, /<strong>Answer:<\/strong> 42/);
});

test("tool cards render labeled I/O sections, each with its own copy control", () => {
  const input = "{\n  \"code\": \"print(42)\"\n}";
  const entries = apply([
    { trace: { id: "tool-1", input, name: "run_python", status: "running" }, type: "tool.started" },
    {
      trace: {
        id: "tool-1",
        name: "run_python",
        output: "stdout:\n42\nstderr:\nDeprecationWarning: x\ncreated files: out.csv",
        status: "completed",
      },
      type: "tool.completed",
    },
  ]);
  const html = renderToStaticMarkup(createElement(RunTimeline, {
    entries,
    isRunning: false,
    onToggle: () => undefined,
  }));

  const sections = html.match(/<details class="tool-io-section" open="">/g) ?? [];
  assert.equal(sections.length, 4);
  for (const label of ["Input", "stdout", "stderr", "Created files"]) {
    assert.match(html, new RegExp(`<span class="tool-io-label">${label}</span>`));
    assert.match(html, new RegExp(`aria-label="Copy ${label}"`));
  }
  assert.match(html, /print\(42\)/);
  assert.match(html, /42/);
  assert.match(html, /DeprecationWarning: x/);
  assert.match(html, /out\.csv/);
});

test("empty runner placeholder sections are omitted from the tool card", () => {
  const entries = apply([
    { trace: { id: "tool-1", input: "{}", name: "run_python", status: "running" }, type: "tool.started" },
    {
      trace: {
        id: "tool-1",
        name: "run_python",
        output: "stdout:\n42\nstderr: (empty)\ncreated files: none",
        status: "completed",
      },
      type: "tool.completed",
    },
  ]);
  const html = renderToStaticMarkup(createElement(RunTimeline, {
    entries,
    isRunning: false,
    onToggle: () => undefined,
  }));

  assert.match(html, /<span class="tool-io-label">stdout<\/span>/);
  assert.doesNotMatch(html, /<span class="tool-io-label">stderr<\/span>/);
  assert.doesNotMatch(html, /Created files/);
});

test("a failed tool card shows Input and a separate Error section", () => {
  const entries = apply([
    { trace: { id: "tool-1", input: "{\n  \"code\": \"1/0\"\n}", name: "run_python", status: "running" }, type: "tool.started" },
    {
      trace: {
        id: "tool-1",
        name: "run_python",
        output: "{\"error\": \"ZeroDivisionError: division by zero\"}",
        status: "failed",
      },
      type: "tool.completed",
    },
  ]);
  const html = renderToStaticMarkup(createElement(RunTimeline, {
    entries,
    isRunning: false,
    onToggle: () => undefined,
  }));

  assert.match(html, /<span class="tool-io-label">Input<\/span>/);
  assert.match(html, /<span class="tool-io-label">Error<\/span>/);
  assert.match(html, /ZeroDivisionError: division by zero/);
  // The error content must not leak into the Input section.
  const inputBody = html.slice(html.indexOf(">Input<"), html.indexOf(">Error<"));
  assert.doesNotMatch(inputBody, /ZeroDivisionError/);
});

test("unstructured tool output stays whole in a residual Result section", () => {
  const entries = apply([
    { trace: { id: "tool-1", name: "web_fetch", status: "running" }, type: "tool.started" },
    {
      trace: {
        id: "tool-1",
        name: "web_fetch",
        output: "HTTP 200 OK\nPage body without any labels",
        status: "completed",
      },
      type: "tool.completed",
    },
  ]);
  const html = renderToStaticMarkup(createElement(RunTimeline, {
    entries,
    isRunning: false,
    onToggle: () => undefined,
  }));

  assert.match(html, /<span class="tool-io-label">Result<\/span>/);
  assert.match(html, /HTTP 200 OK/);
  assert.match(html, /Page body without any labels/);
  assert.match(html, /aria-label="Copy Result"/);
});

test("a stopped run closes the tool that was still in flight", () => {
  const entries = apply([
    { phase: "thinking", turn: 1, type: "agent.phase" },
    { delta: "Fetching the file.", turn: 1, type: "assistant.thinking.delta" },
    { trace: { id: "tool-1", name: "run_python", status: "running" }, type: "tool.started" },
    { reason: "Run cancelled by the user", type: "run.cancelled" },
  ]);

  assert.equal(entries[0]?.type === "thinking" && entries[0].status, "completed");
  assert.equal(entries[1]?.type === "tool" && entries[1].trace.status, "failed");
  assert.equal(entries[1]?.type === "tool" && entries[1].trace.summary, "Run cancelled by the user");
});

test("cancelling a parallel batch preserves completed tools and closes every started tool", () => {
  const entries = apply([
    { trace: { id: "tool-completed", name: "web_search", status: "running" }, type: "tool.started" },
    { trace: { id: "tool-running-a", name: "web_search", status: "running" }, type: "tool.started" },
    { trace: { id: "tool-running-b", name: "task", status: "running" }, type: "tool.started" },
    {
      trace: { id: "tool-completed", name: "web_search", status: "completed", summary: "Found 3 results" },
      type: "tool.completed",
    },
    { reason: "Run cancelled by the user", type: "run.cancelled" },
  ]);

  const tools = entries.filter((entry): entry is Extract<RunTimelineEntry, { type: "tool" }> => entry.type === "tool");
  assert.deepEqual(tools.map((entry) => entry.trace.id), ["tool-completed", "tool-running-a", "tool-running-b"]);
  assert.equal(tools[0]?.trace.status, "completed");
  assert.equal(tools[0]?.trace.summary, "Found 3 results");
  for (const tool of tools.slice(1)) {
    assert.equal(tool.trace.status, "failed");
    assert.equal(tool.trace.summary, "Run cancelled by the user");
    assert.equal(tool.expanded, false);
  }
  assert.equal(tools.some((entry) => entry.trace.id === "tool-not-started"), false);
});

test("replay snapshots replace text and permission decisions stay in timeline order", () => {
  const pending = {
    action: "code" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "permission-1",
    resource: "workspace-code",
    sessionId: "session-1",
    state: "pending" as const,
    summary: "Run Python in the Session workspace",
  };
  const entries = apply([
    { content: "First persisted thought", turn: 1, type: "assistant.thinking.snapshot" },
    { content: "Complete persisted thought", turn: 1, type: "assistant.thinking.snapshot" },
    { request: pending, type: "permission.required" },
    {
      request: {
        ...pending,
        decidedAt: "2026-01-01T00:00:05.000Z",
        decision: "allowed",
        state: "allowed",
      },
      type: "permission.resolved",
    },
    { content: "Persisted answer", type: "assistant.snapshot" },
  ]);
  assert.deepEqual(entries.map((entry) => entry.type), ["thinking", "permission", "assistant"]);
  assert.equal(entries[0]?.type === "thinking" && entries[0].content, "Complete persisted thought");
  assert.equal(entries[1]?.type === "permission" && entries[1].request.state, "allowed");

  const html = renderToStaticMarkup(createElement(RunTimeline, {
    entries,
    isRunning: false,
    modelName: "Test model",
    onPermissionDecision: async () => undefined,
    onToggle: () => undefined,
  }));
  assert.match(html, /Permission granted/);
  assert.match(html, /Run Python in the Session workspace/);
  assert.doesNotMatch(html, /Allow once/);
  assert.match(html, /Persisted answer/);
});

test("replay preserves assistant and thinking segments separated by a tool", () => {
  const started = { id: "tool-1", name: "run_python", status: "running" as const };
  const completed = { ...started, status: "completed" as const, summary: "42" };
  const live = apply([
    { phase: "thinking", turn: 1, type: "agent.phase" },
    { delta: "Plan it.", turn: 1, type: "assistant.thinking.delta" },
    { delta: "Let me check the file.", type: "assistant.delta" },
    { trace: started, type: "tool.started" },
    { trace: completed, type: "tool.completed" },
    { phase: "thinking", turn: 2, type: "agent.phase" },
    { delta: "Now answer.", turn: 2, type: "assistant.thinking.delta" },
    { delta: "The answer is 42.", type: "assistant.delta" },
  ]);
  const replay = apply([
    { phase: "thinking", turn: 1, type: "agent.phase" },
    { content: "Plan it.", turn: 1, type: "assistant.thinking.snapshot" },
    { content: "Let me check the file.", type: "assistant.snapshot" },
    { trace: started, type: "tool.started" },
    { trace: completed, type: "tool.completed" },
    { phase: "thinking", turn: 2, type: "agent.phase" },
    { content: "Now answer.", turn: 2, type: "assistant.thinking.snapshot" },
    { content: "The answer is 42.", type: "assistant.snapshot" },
  ]);

  assert.deepEqual(replay, live);
  assert.deepEqual(
    replay.map((entry) => entry.type === "assistant" || entry.type === "thinking"
      ? `${entry.type}:${entry.content}`
      : `${entry.type}:${entry.trace.status}`),
    [
      "thinking:Plan it.",
      "assistant:Let me check the file.",
      "tool:completed",
      "thinking:Now answer.",
      "assistant:The answer is 42.",
    ],
  );
});

test("thinking snapshots start a new same-turn segment after an interruption", () => {
  const started = { id: "tool-1", name: "run_python", status: "running" as const };
  const live = apply([
    { delta: "First thought.", turn: 1, type: "assistant.thinking.delta" },
    { trace: started, type: "tool.started" },
    { delta: "Second thought.", turn: 1, type: "assistant.thinking.delta" },
  ]);
  const replay = apply([
    { content: "First thought.", turn: 1, type: "assistant.thinking.snapshot" },
    { trace: started, type: "tool.started" },
    { content: "Second thought.", turn: 1, type: "assistant.thinking.snapshot" },
  ]);

  assert.deepEqual(replay, live.map((entry) => entry.type === "thinking"
    ? { ...entry, expanded: false, status: "completed" as const }
    : entry));
  assert.deepEqual(replay.map((entry) => entry.id), ["thinking-1", "tool-tool-1", "thinking-1-2"]);
});

test("pending permissions are actionable only while the run is active", () => {
  const entries = apply([{
    request: {
      action: "code",
      createdAt: "2026-01-01T00:00:00.000Z",
      id: "permission-1",
      resource: "workspace-code",
      sessionId: "session-1",
      state: "pending",
      summary: "Run Python",
    },
    type: "permission.required",
  }]);
  const render = (isRunning: boolean) => renderToStaticMarkup(createElement(RunTimeline, {
    entries,
    isRunning,
    onPermissionDecision: async () => undefined,
    onToggle: () => undefined,
  }));

  assert.doesNotMatch(render(false), /Allow once/);
  const activeHtml = render(true);
  assert.equal(activeHtml.match(/class="secondary-button"/g)?.length, 2);
  assert.match(activeHtml, /class="danger-button"[^>]*>Deny</);
});

test("a replay truncation marker is visible to the user", () => {
  const entries = apply([
    { droppedEvents: 12, type: "run.history.truncated" },
    { content: "Retained answer", truncated: true, type: "assistant.snapshot" },
  ]);
  const html = renderToStaticMarkup(createElement(RunTimeline, {
    entries,
    isRunning: false,
    onToggle: () => undefined,
  }));
  assert.match(html, /12 run event\(s\) were removed/);
  assert.match(html, /approval records are kept/);
  assert.match(html, /retention policy/);
});

test("the dedicated Reviewer card replaces routine review_checkpoint tool chrome", () => {
  const render = (status: "failed" | "running") => renderToStaticMarkup(createElement(RunTimeline, {
    entries: apply([{
      trace: {
        id: "review-tool",
        name: "review_checkpoint",
        status,
        ...(status === "failed" ? { summary: "Reviewer model is unavailable" } : {}),
      },
      type: status === "running" ? "tool.started" : "tool.completed",
    }]),
    isRunning: status === "running",
    onToggle: () => undefined,
  }));

  assert.doesNotMatch(render("running"), /review_checkpoint/);
  assert.match(render("failed"), /review_checkpoint/);
  assert.match(render("failed"), /Reviewer model is unavailable/);
});

test("Reviewer Specialist renders at its review_checkpoint timeline position", () => {
  const entries = apply([
    { content: "Before reviewer.", type: "assistant.snapshot" },
    { trace: { id: "review-call", name: "review_checkpoint", status: "running" }, type: "tool.started" },
    { trace: { id: "review-call", name: "review_checkpoint", status: "completed" }, type: "tool.completed" },
    { content: "After reviewer.", type: "assistant.snapshot" },
  ]);
  const review: ArtifactReviewRun = {
    artifactContentHash: "a".repeat(64),
    artifactId: "artifact-1",
    artifactLogicalName: "report.md",
    artifactVersionId: "version-1",
    checkpointId: "checkpoint-1",
    createdAt: "2026-07-30T00:00:00.000Z",
    decision: "ACCEPT_AND_PROCEED",
    findings: [],
    finishedAt: "2026-07-30T00:00:01.000Z",
    id: "review-1",
    reviewerSpecialistVersion: "1.0.0-offline-mvp",
    sessionId: "session-1",
    status: "completed",
    toolCallId: "review-call",
  };
  const html = renderToStaticMarkup(createElement(RunTimeline, {
    artifactReviews: [review],
    entries,
    isRunning: false,
    onToggle: () => undefined,
  }));

  const before = html.indexOf("Before reviewer.");
  const specialist = html.indexOf("Reviewer Specialist");
  const after = html.indexOf("After reviewer.");
  assert.ok(before >= 0 && specialist > before && after > specialist);
  assert.match(html, /report\.md/);
  assert.match(html, />1 artifact · 1 passed</);
});

test("tool cards replay their input and full result", () => {
  const input = "{\n  \"code\": \"print(123457 * 987654)\"\n}";
  const entries = apply([
    { trace: { id: "tool-1", input, name: "run_python", status: "running" }, type: "tool.started" },
    {
      trace: {
        id: "tool-1",
        input,
        name: "run_python",
        output: "stdout:\n121932799878\n\nstderr: (empty)",
        outputTruncated: true,
        status: "completed",
        summary: "stdout:\n121932799878",
      },
      type: "tool.completed",
    },
  ]);
  assert.equal(entries[0]?.type === "tool" && entries[0].trace.input, input);
  assert.equal(entries[0]?.type === "tool" && entries[0].trace.output, "stdout:\n121932799878\n\nstderr: (empty)");

  const html = renderToStaticMarkup(createElement(RunTimeline, {
    entries,
    isRunning: false,
    onToggle: () => undefined,
  }));
  assert.match(html, /Input/);
  assert.match(html, /print\(123457 \* 987654\)/);
  assert.match(html, /121932799878/);
  assert.match(html, /The result was truncated by the retention policy/);
});

test("a run that ends while an approval is pending replays a cancelled card", () => {
  const pending = {
    action: "code" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "permission-1",
    resource: "workspace-code",
    sessionId: "session-1",
    state: "pending" as const,
    summary: "Run Python in the Session workspace",
  };
  const cancelled = apply([
    { request: pending, type: "permission.required" },
    { reason: "Run cancelled", runId: "run-1", type: "run.cancelled" },
  ]);
  assert.equal(cancelled[0]?.type === "permission" && cancelled[0].request.state, "cancelled");

  const failed = apply([
    { request: pending, type: "permission.required" },
    { error: "terminated", type: "run.failed" },
  ]);
  assert.equal(failed[0]?.type === "permission" && failed[0].request.state, "cancelled");

  const html = renderToStaticMarkup(createElement(RunTimeline, {
    entries: cancelled,
    isRunning: false,
    onPermissionDecision: async () => undefined,
    onToggle: () => undefined,
  }));
  assert.match(html, /Permission cancelled/);
  assert.doesNotMatch(html, /Permission required/);
  assert.doesNotMatch(html, /Allow once/);
});

test("a decided approval keeps its terminal state and decision time through a terminal status", () => {
  const decided = {
    action: "code" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    decidedAt: "2026-01-01T00:00:05.000Z",
    decision: "denied" as const,
    id: "permission-1",
    resource: "workspace-code",
    sessionId: "session-1",
    state: "denied" as const,
    summary: "Run Python in the Session workspace",
  };
  const entries = apply([
    { request: { ...decided, decidedAt: undefined, decision: undefined, state: "pending" }, type: "permission.required" },
    { request: decided, type: "permission.resolved" },
    { error: "terminated", type: "run.failed" },
  ]);
  assert.equal(entries[0]?.type === "permission" && entries[0].request.state, "denied");
  const html = renderToStaticMarkup(createElement(RunTimeline, {
    entries,
    isRunning: false,
    onToggle: () => undefined,
  }));
  assert.match(html, /Permission denied/);
  assert.match(html, /Decided/);
});

test("tool completion without repeated input keeps the started arguments", () => {
  const input = "{\n  \"code\": \"print(1)\"\n}";
  const entries = apply([
    { trace: { id: "tool-1", input, name: "run_python", status: "running" }, type: "tool.started" },
    { trace: { id: "tool-1", name: "run_python", output: "stdout:\n1", status: "completed", summary: "stdout:\n1" }, type: "tool.completed" },
  ]);
  assert.equal(entries[0]?.type === "tool" && entries[0].trace.input, input);
  assert.equal(entries[0]?.type === "tool" && entries[0].trace.output, "stdout:\n1");
  assert.equal(entries[0]?.type === "tool" && entries[0].trace.status, "completed");
});

test("a stream-backed tool result renders a loading placeholder until fetched", () => {
  const entries = apply([
    { trace: { id: "tool-1", input: "{}", name: "run_python", status: "running" }, type: "tool.started" },
    {
      trace: { id: "tool-1", name: "run_python", outputChars: 20, outputStream: "tool-tool-1", status: "completed" },
      type: "tool.completed",
    },
  ]).map((entry) => entry.type === "tool" ? { ...entry, expanded: true } : entry);
  const html = renderToStaticMarkup(createElement(RunTimeline, {
    entries,
    isRunning: false,
    onToggle: () => undefined,
  }));
  assert.match(html, /Loading the full result…/);
});

test("permission cards expose their full request in an expandable details block", () => {
  const entries = apply([{
    request: {
      action: "code",
      createdAt: "2026-01-01T00:00:00.000Z",
      decidedAt: "2026-01-01T00:00:05.000Z",
      decision: "allowed",
      executionId: "run-1",
      id: "permission-1",
      resource: "workspace-code",
      sessionId: "session-1",
      state: "allowed",
      toolCallId: "call-9",
      summary: "Run Python in the Session workspace",
    },
    type: "permission.resolved",
  }]);
  const html = renderToStaticMarkup(createElement(RunTimeline, {
    entries,
    isRunning: false,
    onToggle: () => undefined,
  }));
  assert.match(html, /Permission granted/);
  assert.match(html, /Details/);
  assert.match(html, /Action/);
  assert.match(html, /workspace-code/);
  assert.match(html, /call-9/);
  assert.match(html, /run-1/);
});

test("structured tool arguments render as raw input text without a JSON wrapper", () => {
  const entries = apply([
    { trace: { args: { code: "print(6 * 7)" }, id: "tool-1", name: "run_python", status: "running" }, type: "tool.started" },
    { trace: { id: "tool-1", name: "run_python", outputChars: 2, outputStream: "tool-tool-1", status: "completed" }, type: "tool.completed" },
  ]).map((entry) => entry.type === "tool" ? { ...entry, expanded: true } : entry);
  assert.equal(entries[0]?.type === "tool" && entries[0].trace.args?.code, "print(6 * 7)");
  const html = renderToStaticMarkup(createElement(RunTimeline, {
    entries,
    isRunning: false,
    onToggle: () => undefined,
  }));
  // The Input body is the code itself — no decorative {"code": ...} envelope.
  assert.match(html, />print\(6 \* 7\)<\/pre>/);
  assert.doesNotMatch(html, /&quot;code&quot;/);
  assert.match(html, /Loading the full result…/);
});

test("completed create_skill calls expose a visible review shortcut in the conversation", () => {
  const entries = apply([
    { trace: { id: "tool-1", name: "create_skill", status: "running" }, type: "tool.started" },
    { trace: { id: "tool-1", name: "create_skill", status: "completed", summary: "Draft created" }, type: "tool.completed" },
    { delta: "The Skill draft is ready.", type: "assistant.delta" },
  ]);
  const html = renderToStaticMarkup(createElement(RunTimeline, {
    entries,
    footer: createElement("small", null, "Usage summary"),
    isRunning: false,
    onOpenSkillReviews: () => undefined,
    onToggle: () => undefined,
  }));

  assert.match(html, /skill-review-timeline-cta/);
  assert.match(html, /Skill draft ready for review/);
  assert.match(html, />Review Skill</);
  assert.ok(html.indexOf("Review Skill") > html.indexOf("The Skill draft is ready."));
  assert.ok(html.indexOf("Review Skill") > html.indexOf("Usage summary"));
});

test("create_skill review shortcuts retain the generated Skill identity", () => {
  assert.equal(skillDraftNameFromTrace({
    args: { name: "ppt-analyzer" },
    id: "tool-1",
    name: "create_skill",
    status: "completed",
  }), "ppt-analyzer");
  assert.equal(skillDraftNameFromTrace({
    id: "tool-2",
    input: JSON.stringify({ name: "historical-skill" }),
    name: "create_skill",
    status: "completed",
  }), "historical-skill");
});

test("an approval policy switch stays on the timeline between the steps it separates", () => {
  const entries = apply([
    { trace: { id: "tool-1", name: "run_python", status: "running" }, type: "tool.started" },
    { trace: { id: "tool-1", name: "run_python", status: "completed", summary: "step 1" }, type: "tool.completed" },
    {
      approvalMode: "always_allow",
      permissionEpochId: "epoch-2",
      previousApprovalMode: "ask_for_dangerous",
      type: "session.approval_mode.changed",
    },
    { trace: { id: "tool-2", name: "run_python", status: "running" }, type: "tool.started" },
    { trace: { id: "tool-2", name: "run_python", status: "completed", summary: "step 2" }, type: "tool.completed" },
  ]);

  assert.deepEqual(entries.map((entry) => entry.type), ["tool", "approval-mode", "tool"]);
  const html = renderToStaticMarkup(createElement(RunTimeline, {
    entries,
    isRunning: false,
    onToggle: () => undefined,
  }));
  assert.match(html, /Approval policy changed from “Ask for dangerous actions” to “Always allow”/);
});

test("replaying the same approval switch does not stack duplicate timeline records", () => {
  const change: RunStreamEvent = {
    approvalMode: "ask_for_dangerous",
    permissionEpochId: "epoch-3",
    previousApprovalMode: "always_allow",
    type: "session.approval_mode.changed",
  };
  const entries = apply([change, change]);

  assert.deepEqual(entries.map((entry) => entry.type), ["approval-mode"]);
  assert.equal(entries[0]?.type === "approval-mode" && entries[0].approvalMode, "ask_for_dangerous");
});
