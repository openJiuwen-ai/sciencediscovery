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

import type { ChatMessage, RunStreamEvent, SessionRun, SessionRunEvent } from "@science-agent/schema";
import { ApiRequestError } from "../src/api.js";
import { mergePermissionRequestSnapshot } from "../src/permission-state.js";

import {
  buildConversationBlocks,
  clearSessionTimeline,
  collectTimelinePermissionRequestIds,
  hydrateTerminalRunTimelines,
  forgetSession,
  hydrateSessionRunTimeline,
  permissionRequestFromConflict,
  reconcilePermissionTimeline,
  reconcileSessionTimelinePermissions,
  recordSessionTimelineEvent,
  routeRunStreamEvent,
  selectSessionReplayRun,
  type SessionRunTimeline,
  type SessionRunTimelines,
} from "../src/App.js";

const thinkingStart: RunStreamEvent = { phase: "thinking", turn: 1, type: "agent.phase" };
const thought: RunStreamEvent = { delta: "Inspecting the dataset.", turn: 1, type: "assistant.thinking.delta" };
const toolStarted: RunStreamEvent = { trace: { id: "tool-1", name: "run_shell", status: "running" }, type: "tool.started" };
const toolFinished: RunStreamEvent = {
  trace: { id: "tool-1", name: "run_shell", status: "completed", summary: "12 rows" },
  type: "tool.completed",
};

/** Mirrors the App's dispatch: buffer into the run's own Session, then gate the shared panels. */
function dispatch(
  timelines: SessionRunTimelines,
  runSessionId: string,
  displayedSessionId: string | undefined,
  events: RunStreamEvent[],
): { timelines: SessionRunTimelines; touchedSharedPanels: number } {
  let next = timelines;
  let touchedSharedPanels = 0;
  for (const event of events) {
    next = recordSessionTimelineEvent(next, runSessionId, event);
    if (routeRunStreamEvent(event, { isDisplayed: displayedSessionId === runSessionId }).updatesSessionView) {
      touchedSharedPanels += 1;
    }
  }
  return { timelines: next, touchedSharedPanels };
}

function toolEntry(timeline: SessionRunTimeline | undefined) {
  return timeline?.entries.find((entry) => entry.type === "tool");
}

// When Session A keeps running while the user starts a run in Session B,
// returning to A must show its complete timeline instead of only the user
// message; A's in-flight events must not be dropped while it is off screen.
test("a run whose Session is off screen keeps recording its own timeline", () => {
  const started = dispatch({}, "session-a", "session-a", [thinkingStart, thought, toolStarted]);
  assert.equal(started.timelines["session-a"]?.entries.length, 2, "A shows a thought and a tool while it is displayed");

  // The user switches to B; A is still streaming.
  const inBackground = dispatch(started.timelines, "session-a", "session-b", [toolFinished]);

  assert.equal(
    inBackground.touchedSharedPanels,
    0,
    "a background run must not write into the Session that is on screen",
  );
  const timeline = inBackground.timelines["session-a"];
  assert.equal(timeline?.entries.length, 2, "switching away does not discard what A already streamed");
  assert.equal(toolEntry(timeline)?.type === "tool" && toolEntry(timeline)?.trace.status, "completed");
  assert.equal(
    toolEntry(timeline)?.type === "tool" && toolEntry(timeline)?.trace.summary,
    "12 rows",
    "progress that arrived while A was off screen is still there when the user returns",
  );
});

test("a run in one Session never writes into another Session's timeline", () => {
  const withA = recordSessionTimelineEvent({}, "session-a", thinkingStart);
  const withBoth = recordSessionTimelineEvent(withA, "session-b", toolStarted);

  assert.deepEqual(Object.keys(withBoth).toSorted(), ["session-a", "session-b"]);
  assert.equal(withBoth["session-a"]?.entries.length, 1);
  assert.equal(withBoth["session-a"]?.entries[0]?.type, "thinking");
  assert.equal(withBoth["session-b"]?.entries.length, 1);
  assert.equal(withBoth["session-b"]?.entries[0]?.type, "tool");
  assert.equal(withBoth["session-a"], withA["session-a"], "an untouched Session keeps its exact buffer");
});

test("starting a run clears only that Session's timeline", () => {
  const timelines = dispatch({}, "session-a", "session-a", [thinkingStart, toolStarted]).timelines;
  const withB = dispatch(timelines, "session-b", "session-b", [thinkingStart]).timelines;

  const afterRerunOfB = clearSessionTimeline(withB, "session-b");

  assert.equal(afterRerunOfB["session-b"]?.entries.length, 0, "B starts over");
  // A had an empty thinking step (no reasoning text) followed by a tool; the
  // empty thinking is dropped so it doesn't show a blank card, leaving the tool.
  assert.equal(afterRerunOfB["session-a"]?.entries.length, 1, "A keeps the run it still has going (empty thinking dropped)");
});

test("an event that changes nothing keeps the same record identity", () => {
  const timelines = recordSessionTimelineEvent({}, "session-a", thinkingStart);
  const ignored: RunStreamEvent = {
    model: { id: "model-1", model: "test-model", name: "Test model" },
    runId: "run-1",
    settings: { enabledConnectorIds: [], enabledSkillIds: [], modelId: "model-1", semanticReviewEnabled: false },
    type: "run.started",
  };

  const withRunIdentity = recordSessionTimelineEvent(timelines, "session-a", ignored);
  assert.equal(withRunIdentity["session-a"]?.entries, timelines["session-a"]?.entries);
  assert.equal(withRunIdentity["session-a"]?.runId, "run-1");
  assert.equal(clearSessionTimeline(timelines, "session-b"), timelines, "clearing an empty Session is a no-op");
});

test("a deleted Session's buffer does not outlive it", () => {
  const timelines = recordSessionTimelineEvent({}, "session-a", toolStarted);
  const both = recordSessionTimelineEvent(timelines, "session-b", toolStarted);

  const afterDelete = forgetSession(both, "session-a");
  assert.deepEqual(Object.keys(afterDelete), ["session-b"]);
  assert.equal(forgetSession(afterDelete, "session-a"), afterDelete, "forgetting an absent Session is a no-op");

  const messageIds = forgetSession({ "session-a": "message-1", "session-b": "message-2" }, "session-a");
  assert.deepEqual(messageIds, { "session-b": "message-2" });
});

function sessionRun(id: string, queueOrder: number, status: SessionRun["status"]): SessionRun {
  return {
    annotationIds: [],
    createdAt: `2026-01-01T00:00:0${queueOrder}.000Z`,
    id,
    prompt: id,
    queueOrder,
    references: [],
    sessionId: "session-a",
    settingsSnapshot: {
      enabledConnectorIds: [],
      enabledSkillIds: [],
      modelId: "model-1",
      semanticReviewEnabled: false,
    },
    status,
  };
}

test("hydrate restores the active run before a newer queued run and deduplicates by sequence", () => {
  const completed = sessionRun("run-completed", 1, "completed");
  const active = sessionRun("run-active", 2, "blocked");
  const queued = sessionRun("run-queued", 3, "queued");
  assert.equal(selectSessionReplayRun([completed, active, queued])?.id, active.id);
  assert.equal(selectSessionReplayRun([completed, queued])?.id, completed.id);

  const records: SessionRunEvent[] = [
    {
      createdAt: "2026-01-01T00:00:02.000Z",
      event: { content: "Persisted thought", turn: 1, type: "assistant.thinking.snapshot" },
      runId: active.id,
      sequence: 2,
      sessionId: active.sessionId,
    },
    {
      createdAt: "2026-01-01T00:00:03.000Z",
      event: { trace: { id: "tool-1", name: "run_python", status: "running" }, type: "tool.started" },
      runId: active.id,
      sequence: 3,
      sessionId: active.sessionId,
    },
  ];
  const hydrated = hydrateSessionRunTimeline({}, active.sessionId, active, records);
  assert.deepEqual(hydrated[active.sessionId]?.entries.map((entry) => entry.type), ["thinking", "tool"]);
  assert.equal(hydrated[active.sessionId]?.lastSequence, 3);

  const duplicate = recordSessionTimelineEvent(
    hydrated,
    active.sessionId,
    records[1]!.event,
    { runId: active.id, sequence: 3 },
  );
  assert.equal(duplicate, hydrated);
  const resumed = recordSessionTimelineEvent(
    duplicate,
    active.sessionId,
    { trace: { id: "tool-1", name: "run_python", status: "completed", summary: "42" }, type: "tool.completed" },
    { runId: active.id, sequence: 4 },
  );
  assert.equal(toolEntry(resumed[active.sessionId])?.type === "tool"
    && toolEntry(resumed[active.sessionId])?.trace.status, "completed");
});

test("hydrate merges newer records into the same run without resetting disclosure state", () => {
  const active = sessionRun("run-active", 1, "blocked");
  const pending = {
    action: "code" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "permission-1",
    resource: "workspace-code",
    sessionId: active.sessionId,
    state: "pending" as const,
    summary: "Run Python",
  };
  const current = recordSessionTimelineEvent({}, active.sessionId, toolStarted, {
    runId: active.id,
    sequence: 1,
  });
  const collapsed: SessionRunTimelines = {
    ...current,
    [active.sessionId]: {
      ...current[active.sessionId]!,
      entries: current[active.sessionId]!.entries.map((entry) =>
        entry.type === "tool" ? { ...entry, expanded: false } : entry),
    },
  };
  const records: SessionRunEvent[] = [
    {
      createdAt: "2026-01-01T00:00:01.000Z",
      event: toolStarted,
      runId: active.id,
      sequence: 1,
      sessionId: active.sessionId,
    },
    {
      createdAt: "2026-01-01T00:00:02.000Z",
      event: { request: pending, type: "permission.required" },
      runId: active.id,
      sequence: 2,
      sessionId: active.sessionId,
    },
  ];

  const hydrated = hydrateSessionRunTimeline(collapsed, active.sessionId, active, records);
  assert.equal(toolEntry(hydrated[active.sessionId])?.type === "tool"
    && toolEntry(hydrated[active.sessionId])?.expanded, false);
  assert.deepEqual(hydrated[active.sessionId]?.entries.map((entry) => entry.type), ["tool", "permission"]);
  assert.equal(hydrated[active.sessionId]?.lastSequence, 2);
});

test("hydrate replays approval terminal state, tool payloads, and pending-panel dedup after a refresh", () => {
  const finished = sessionRun("run-finished", 1, "completed");
  const pending = {
    action: "code" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "permission-1",
    resource: "workspace-code",
    sessionId: finished.sessionId,
    state: "pending" as const,
    summary: "Run Python",
  };
  const input = "{\n  \"code\": \"print(42)\"\n}";
  const records: SessionRunEvent[] = [
    {
      createdAt: "2026-01-01T00:00:01.000Z",
      event: { trace: { id: "tool-1", input, name: "run_python", status: "running" }, type: "tool.started" },
      runId: finished.id,
      sequence: 1,
      sessionId: finished.sessionId,
    },
    {
      createdAt: "2026-01-01T00:00:02.000Z",
      event: { request: pending, type: "permission.required" },
      runId: finished.id,
      sequence: 2,
      sessionId: finished.sessionId,
    },
    {
      createdAt: "2026-01-01T00:00:03.000Z",
      event: {
        request: { ...pending, decidedAt: "2026-01-01T00:00:03.000Z", decision: "allowed", state: "allowed" },
        type: "permission.resolved",
      },
      runId: finished.id,
      sequence: 3,
      sessionId: finished.sessionId,
    },
    {
      createdAt: "2026-01-01T00:00:04.000Z",
      event: {
        trace: { id: "tool-1", input, name: "run_python", output: "stdout:\n42", status: "completed", summary: "stdout:\n42" },
        type: "tool.completed",
      },
      runId: finished.id,
      sequence: 4,
      sessionId: finished.sessionId,
    },
    {
      createdAt: "2026-01-01T00:00:05.000Z",
      event: { run: finished, status: "completed", type: "run.status" },
      runId: finished.id,
      sequence: 5,
      sessionId: finished.sessionId,
    },
  ];

  const hydrated = hydrateSessionRunTimeline({}, finished.sessionId, finished, records);
  const timeline = hydrated[finished.sessionId];
  assert.deepEqual(timeline?.entries.map((entry) => entry.type), ["tool", "permission"]);
  const tool = timeline?.entries[0];
  assert.equal(tool?.type === "tool" && tool.trace.input, input);
  assert.equal(tool?.type === "tool" && tool.trace.output, "stdout:\n42");
  const approval = timeline?.entries[1];
  assert.equal(approval?.type === "permission" && approval.request.state, "allowed");
  assert.equal(approval?.type === "permission" && approval.request.decidedAt, "2026-01-01T00:00:03.000Z");

  const timelineIds = collectTimelinePermissionRequestIds(timeline?.entries ?? []);
  const panelRequests = [
    { ...pending, decidedAt: "2026-01-01T00:00:03.000Z", decision: "allowed" as const, state: "allowed" as const },
    { ...pending, id: "permission-2", resource: "other" },
  ].filter((request) => !timelineIds.has(request.id));
  assert.deepEqual(panelRequests.map((request) => request.id), ["permission-2"]);
});

test("authoritative permission snapshots reconcile active and replay timeline cards immediately", () => {
  const pending = {
    action: "code" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "permission-stale",
    resource: "workspace-code",
    sessionId: "session-a",
    state: "pending" as const,
    summary: "Run Python",
  };
  const timelines = recordSessionTimelineEvent(
    {},
    pending.sessionId,
    { request: pending, type: "permission.required" },
    { runId: "run-a", sequence: 1 },
  );
  const allowed = {
    ...pending,
    decidedAt: "2026-01-01T00:00:01.000Z",
    decision: "allowed" as const,
    state: "allowed" as const,
  };

  const reconciled = reconcileSessionTimelinePermissions(timelines, pending.sessionId, [allowed]);
  const approval = reconciled[pending.sessionId]?.entries.find((entry) => entry.type === "permission");
  assert.equal(approval?.type === "permission" && approval.request.state, "allowed");
  assert.equal(approval?.type === "permission" && approval.request.decidedAt, allowed.decidedAt);
  assert.equal(reconcileSessionTimelinePermissions(reconciled, "missing-session", [allowed]), reconciled);

  const replay = reconciled[pending.sessionId]!;
  assert.equal(reconcilePermissionTimeline(replay, [allowed]), replay, "an up-to-date replay keeps its identity");
});

test("a delayed permission-required event cannot regress an already resolved card", () => {
  const pending = {
    action: "code" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "permission-delayed",
    resource: "workspace-code",
    sessionId: "session-a",
    state: "pending" as const,
    summary: "Run Python",
  };
  const allowed = {
    ...pending,
    decidedAt: "2026-01-01T00:00:01.000Z",
    decision: "allowed" as const,
    state: "allowed" as const,
  };
  let timelines = recordSessionTimelineEvent(
    {},
    pending.sessionId,
    { request: pending, type: "permission.required" },
    { runId: "run-a", sequence: 1 },
  );
  timelines = recordSessionTimelineEvent(
    timelines,
    pending.sessionId,
    { request: allowed, type: "permission.resolved" },
    { runId: "run-a", sequence: 2 },
  );
  timelines = recordSessionTimelineEvent(
    timelines,
    pending.sessionId,
    { request: pending, type: "permission.required" },
    { runId: "run-a", sequence: 3 },
  );
  const approval = timelines[pending.sessionId]?.entries.find((entry) => entry.type === "permission");
  assert.equal(approval?.type === "permission" && approval.request.state, "allowed");
  assert.equal(mergePermissionRequestSnapshot(allowed, pending), allowed);
});

test("structured already-resolved conflicts expose the authoritative permission request", () => {
  const request = {
    action: "artifact_download" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    decidedAt: "2026-01-01T00:00:01.000Z",
    id: "permission-download",
    resource: "pubmed:download:paper.pdf",
    sessionId: "session-a",
    state: "cancelled" as const,
    summary: "Download paper.pdf",
  };
  const conflict = new ApiRequestError(
    "Permission request was already resolved",
    409,
    "PERMISSION_ALREADY_RESOLVED",
    { request },
  );
  assert.equal(permissionRequestFromConflict(conflict), request);
  assert.equal(permissionRequestFromConflict(new Error("Permission request was already resolved")), undefined);
});

test("hydrate normalizes an undecided approval from an interrupted run to cancelled", () => {
  const interrupted = sessionRun("run-interrupted", 1, "interrupted");
  const pending = {
    action: "code" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "permission-1",
    resource: "workspace-code",
    sessionId: interrupted.sessionId,
    state: "pending" as const,
    summary: "Run Python",
  };
  const records: SessionRunEvent[] = [
    {
      createdAt: "2026-01-01T00:00:01.000Z",
      event: { request: pending, type: "permission.required" },
      runId: interrupted.id,
      sequence: 1,
      sessionId: interrupted.sessionId,
    },
    {
      createdAt: "2026-01-01T00:00:02.000Z",
      event: { reason: "API process exited", run: interrupted, status: "interrupted", type: "run.status" },
      runId: interrupted.id,
      sequence: 2,
      sessionId: interrupted.sessionId,
    },
  ];
  const hydrated = hydrateSessionRunTimeline({}, interrupted.sessionId, interrupted, records);
  const approval = hydrated[interrupted.sessionId]?.entries.find((entry) => entry.type === "permission");
  assert.equal(approval?.type === "permission" && approval.request.state, "cancelled");
});

test("terminal-run hydration rebuilds finished timelines and keeps disclosure state when unchanged", () => {
  const finished = sessionRun("run-finished", 1, "completed");
  const records: SessionRunEvent[] = [
    {
      createdAt: "2026-01-01T00:00:01.000Z",
      event: { trace: { id: "tool-1", input: "{}", name: "run_python", status: "running" }, type: "tool.started" },
      runId: finished.id,
      sequence: 1,
      sessionId: finished.sessionId,
    },
    {
      createdAt: "2026-01-01T00:00:02.000Z",
      event: { trace: { id: "tool-1", name: "run_python", outputChars: 9, outputStream: "tool-tool-1", status: "completed" }, type: "tool.completed" },
      runId: finished.id,
      sequence: 2,
      sessionId: finished.sessionId,
    },
  ];
  const hydrated = hydrateTerminalRunTimelines({}, [finished], { [finished.id]: records });
  assert.deepEqual(hydrated[finished.id]?.entries.map((entry) => entry.type), ["tool"]);
  assert.equal(hydrated[finished.id]?.lastSequence, 2);

  const expanded = {
    [finished.id]: {
      ...hydrated[finished.id]!,
      entries: hydrated[finished.id]!.entries.map((entry) =>
        entry.type === "tool" ? { ...entry, expanded: true } : entry),
    },
  };
  const rehydrated = hydrateTerminalRunTimelines(expanded, [finished], { [finished.id]: records });
  assert.equal(rehydrated[finished.id], expanded[finished.id], "an up-to-date replay keeps its objects and disclosure state");

  const withoutEvents = hydrateTerminalRunTimelines({}, [finished], { [finished.id]: [] });
  assert.equal(withoutEvents[finished.id], undefined, "legacy runs without events stay message-rendered");
});

test("conversation blocks interleave finished timelines and skip replayed answers", () => {
  const replayed = { ...sessionRun("run-1", 1, "completed"), assistantMessageId: "answer-1", userMessageId: "user-1" };
  const legacy = { ...sessionRun("run-2", 2, "completed"), assistantMessageId: "answer-2", userMessageId: "user-2" };
  const message = (id: string, role: "assistant" | "user", kind?: "timeout_notice"): ChatMessage => ({
    content: `content-${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    id,
    ...(kind ? { kind } : {}),
    role,
  });
  const blocks = buildConversationBlocks(
    [
      message("user-1", "user"),
      message("answer-1", "assistant"),
      message("notice-1", "assistant", "timeout_notice"),
      message("user-2", "user"),
      message("answer-2", "assistant"),
    ],
    [replayed, legacy],
    new Set([replayed.id]),
  );
  assert.deepEqual(
    blocks.map((block) => block.kind === "message" ? `message:${block.message.id}` : `timeline:${block.runId}`),
    [
      "message:user-1",
      "timeline:run-1",
      "message:notice-1",
      "message:user-2",
      "message:answer-2",
    ],
    "the replayed run renders as its timeline while the legacy run keeps its messages",
  );
});

// Regression coverage: [evidence1]/[artifact1] tokens in a final assistant
// report must render as clickable chips rather than plain text. The run that
// produced the report ended `failed` with an empty assistantMessageId, so the
// assistant answer was neither consumed by a replay timeline nor wired to the
// report's chip references — it fell through to the bare message-render path
// (App.tsx conversation block) which passed no `references`. The fix threads
// `message.references` through that path; this test pins the upstream contract
// that a failed/empty-assistantMessageId run still emits the assistant message
// as an independent message block (the block that must carry the chips).
test("a failed run with no assistantMessageId keeps its assistant message as a message block", () => {
  const failed = { ...sessionRun("run-failed", 1, "failed"), assistantMessageId: "", userMessageId: "user-failed" };
  const message = (id: string, role: "assistant" | "user"): ChatMessage => ({
    content: `content-${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    id,
    role,
  });
  const blocks = buildConversationBlocks(
    [message("user-failed", "user"), message("answer-failed", "assistant")],
    [failed],
    new Set([failed.id]),
  );
  // The assistant message is NOT consumed by a timeline (assistantMessageId is
  // empty), so it must survive as its own message block — the very block the
  // chip-wiring fix targets. A future regression that drops it here would make
  // chips silently disappear again.
  assert.deepEqual(
    blocks.map((block) => block.kind === "message" ? `message:${block.message.id}` : `timeline:${block.runId}`),
    ["message:user-failed", "timeline:run-failed", "message:answer-failed"],
    "the failed run's assistant message survives as a message block so its chip references can render",
  );
  // And that block must expose the message object the wiring reads .references from.
  const assistantBlock = blocks.at(-1);
  assert.equal(assistantBlock?.kind, "message");
  assert.equal(assistantBlock!.kind === "message" && assistantBlock.message.id, "answer-failed");
});
