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
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import type { ToolTrace } from "@sciencediscovery/schema";
import { ProcessRecord, WorkspaceFolder } from "../src/ProcessRecord.js";
import { isMemoryGraphVisible, MemoryGraphView } from "../src/MemoryGraphView.js";
import { AgentActivityPanel } from "../src/AgentActivityPanel.js";
import { ApiClient } from "../src/api.js";
import type { AgentActivity } from "../src/api/runs.js";
import { SkillReviewRecords, skillDraftFromOutput } from "../src/SkillReviewRecords.js";
import { reduceRunTimeline, RunTimeline, setTimelineEntryExpanded, type RunTimelineEntry } from "../src/timeline/RunTimeline.js";

test("only terminal processes use borderless disclosures; top-level folders default open", () => {
  const child = createElement("article", { className: "original-card" }, "output");
  const live = renderToStaticMarkup(createElement(ProcessRecord, { active: true, label: "task", children: child }));
  assert.match(live, /class="process-live" open=""/);
  assert.match(live, /class="original-card"/);
  assert.doesNotMatch(live, /class="process-record /);
  const failed = renderToStaticMarkup(createElement(ProcessRecord, { failed: true, label: "task failed", children: child }));
  assert.match(failed, /process-record .*failed/);
  assert.match(failed, /record-failure-dot/);
  assert.doesNotMatch(failed, /open=""/);
  assert.doesNotMatch(failed.slice(0, failed.indexOf("</summary>")), /<svg/);
  assert.ok(failed.indexOf("record-failure-dot") > failed.indexOf("task failed"));
  const folder = renderToStaticMarkup(createElement(WorkspaceFolder, { label: "Files", name: "files", children: child }));
  assert.match(folder, /data-folder="files"/);
  assert.match(folder, /open=""/);
  assert.equal(folder.match(/<svg/g)?.length, 1);
});

test("workspace folders retain independent toggle state through rerenders and reset on a new session key", async () => {
  const render = (session: string, revision: number) => createElement("div", {},
    ...["files", "tasks", "memory"].map((name) => createElement(WorkspaceFolder, {
      key: `${name}:${session}`, name, label: name, children: createElement("span", {}, revision),
    })));
  let view: ReturnType<typeof create>;
  await act(async () => { view = create(render("first", 0)); });
  const folders = () => view!.root.findAllByType("details");
  try {
    assert.deepEqual(folders().map((node) => node.props.open), [true, true, true]);
    const closed = { open: false };
    await act(async () => folders()[0]!.props.onToggle({ target: closed, currentTarget: closed }));
    await act(async () => view!.update(render("first", 1)));
    assert.deepEqual(folders().map((node) => node.props.open), [false, true, true]);
    await act(async () => folders()[1]!.props.onToggle({ target: closed, currentTarget: { open: false } }));
    assert.equal(folders()[1]!.props.open, true, "nested details must not toggle the folder state");
    const opened = { open: true };
    await act(async () => folders()[0]!.props.onToggle({ target: opened, currentTarget: opened }));
    assert.equal(folders()[0]!.props.open, true);
    await act(async () => folders()[0]!.props.onToggle({ target: closed, currentTarget: closed }));
    await act(async () => view!.update(render("second", 2)));
    assert.deepEqual(folders().map((node) => node.props.open), [true, true, true]);
  } finally { await act(async () => view!.unmount()); }
});

test("assistant identity appears once per reply across interleaved tool calls", () => {
  const entries: RunTimelineEntry[] = [
    { type: "assistant", id: "intro", content: "Before tool" },
    { type: "tool", id: "tool", expanded: false, trace: { id: "one", name: "task", status: "completed" } },
    { type: "assistant", id: "conclusion", content: "After tool" },
  ];
  const html = renderToStaticMarkup(createElement(RunTimeline, {
    entries, isRunning: false, onToggle: () => undefined, modelName: "deepseek-v4-flash",
  }));
  assert.equal(html.match(/class="avatar"/g)?.length, 1);
  assert.equal(html.match(/class="message-role"/g)?.length, 1);
  assert.equal(html.match(/class="message-body"/g)?.length, 2);
  assert.match(html, /assistant-continuation/);
  assert.match(html, /Before tool/);
  assert.match(html, /After tool/);
  assert.ok(html.indexOf("run-identity") < html.indexOf("Before tool"));
});

test("reply identity precedes activity even before any assistant prose arrives", () => {
  for (const status of ["running", "completed"] as const) {
    const entries: RunTimelineEntry[] = [
      { type: "tool", id: "tool", expanded: false, trace: { id: "one", name: "task", status } },
    ];
    const render = (items: RunTimelineEntry[]) => renderToStaticMarkup(createElement(RunTimeline, {
      entries: items, isRunning: status === "running", onToggle: () => undefined, modelName: "deepseek-v4-flash",
    }));
    for (const html of [render(entries), render([...entries, { type: "assistant", id: "answer", content: "Final answer" }])]) {
      assert.equal(html.match(/class="avatar"/g)?.length, 1);
      assert.equal(html.match(/class="message-role"/g)?.length, 1);
      assert.ok(html.indexOf("deepseek-v4-flash") < html.indexOf("timeline-disclosure tool"));
    }
  }
});

test("explicit expansion survives tool success, failure and interrupted runs", () => {
  for (const terminal of ["completed", "failed", "interrupted"] as const) {
    let entries = reduceRunTimeline([], { type: "tool.started", trace: { id: "one", name: "run_shell", status: "running" } });
    entries = setTimelineEntryExpanded(entries, "tool-one", true);
    entries = terminal === "interrupted"
      ? reduceRunTimeline(entries, { type: "run.error", reason: "cancelled" })
      : reduceRunTimeline(entries, { type: "tool.completed", trace: { id: "one", name: "run_shell", status: terminal } });
    assert.equal(entries[0]?.type === "tool" && entries[0].expanded, true);
  }
  let entries = reduceRunTimeline([], { type: "agent.phase", phase: "thinking", turn: 1 });
  entries = reduceRunTimeline(entries, { type: "assistant.thinking.delta", delta: "visible model summary", turn: 1 });
  entries = setTimelineEntryExpanded(entries, "thinking-1", true);
  entries = reduceRunTimeline(entries, { type: "assistant.delta", delta: "answer" });
  assert.equal(entries[0]?.type === "thinking" && entries[0].expanded, true);
});

test("disabled memory leaves no empty entry while empty and unreachable enabled graphs keep their status", () => {
  const empty = { nodes: [], edges: [], total: 0, truncated: false };
  assert.equal(isMemoryGraphVisible(null, "unknown"), false);
  for (const [subgraph, health] of [[empty, "disabled"], [{ ...empty, reason: "memory_graph_disabled" }, "healthy"]] as const) {
    assert.equal(isMemoryGraphVisible(subgraph, health), false);
    assert.equal(renderToStaticMarkup(createElement(MemoryGraphView, { subgraph, health, onOpenExplorer: () => undefined })), "");
  }
  for (const subgraph of [empty, { ...empty, reason: "memory_graph_unreachable" }]) {
    assert.equal(isMemoryGraphVisible(subgraph, "degraded"), true);
    assert.match(renderToStaticMarkup(createElement(MemoryGraphView, { subgraph, health: "degraded", onOpenExplorer: () => undefined })), /memory-graph-empty/);
  }
});

test("activity headers show total records rather than only running records", async () => {
  const activity: AgentActivity = {
    executions: ["a", "b"].map((id) => ({ id, sessionId: "s", agentId: "main", runnerId: "local", workspaceId: "w", turnId: "turn",
      state: "completed", queuedAt: "2026-09-11T00:00:00Z", accepted: true, provenance: "committed" })),
    transfers: [{ id: "transfer", sessionId: "s", agentId: "main", sourceWorkspaceId: "a", targetWorkspaceId: "b", files: [], progress: [], state: "completed", createdAt: "2026-09-11T00:00:00Z" }],
    timers: [{ id: "timer", agentId: "main", dueAt: 0, message: "reminder", state: "fired" }], agents: [],
  };
  const client = new ApiClient("unit-test");
  client.getAgentActivity = async () => activity;
  let view: ReturnType<typeof create>;
  await act(async () => { view = create(createElement(AgentActivityPanel, { client, sessionId: "s" })); });
  try {
    const counts = view!.root.findAll((node) => node.type === "span" && node.props.className === "fold-meta");
    assert.deepEqual(counts.map((node) => node.children.join("")), ["2", "1", "1"]);
  } finally { await act(async () => view!.unmount()); }
});

test("zero activity sections disappear without losing a stopped agent's resume action", async () => {
  const client = new ApiClient("unit-test");
  client.getAgentActivity = async () => ({ executions: [], transfers: [], timers: [], agents: [{ agentId: "subagent:one", stopped: true }] });
  let view: ReturnType<typeof create>;
  await act(async () => { view = create(createElement(AgentActivityPanel, { client, sessionId: "s" })); });
  try {
    assert.equal(view!.root.findAllByType("details").length, 0);
    assert.equal(view!.root.findAllByType("button").length, 1);
  } finally { await act(async () => view!.unmount()); }
});

test("authorization uses exact tool ID and disappears with the permission card", () => {
  const permission: RunTimelineEntry = { type: "permission", id: "approval", request: {
    id: "p", action: "code", resource: "workspace-code", sessionId: "s", createdAt: "2026-09-11T00:00:00Z",
    state: "allowed", summary: "sensitive approval summary", toolCallId: "one",
  } };
  const tools: RunTimelineEntry[] = ["one", "two"].map((id) => ({ type: "tool", id, expanded: false,
    trace: { id, name: "run_shell", status: "running" } }));
  const render = (entries: RunTimelineEntry[]) => renderToStaticMarkup(createElement(RunTimeline, {
    entries, isRunning: true, onToggle: () => undefined,
  }));
  const live = render([permission, ...tools]);
  assert.equal(live.match(/class="tool-authorization"/g)?.length, 1);
  assert.doesNotMatch(live, /sensitive approval summary|permission-card/);
  const denied = { ...permission, request: { ...permission.request, state: "denied" as const } };
  assert.doesNotMatch(render([denied, ...tools]), /tool-authorization|permission-card/);
  const completed = tools.map((entry) => entry.type === "tool" ? { ...entry, trace: { ...entry.trace, status: "completed" as const } } : entry);
  assert.doesNotMatch(render([permission, ...completed]), /tool-authorization|permission-card/);
});

test("draft parsing uses stable IDs, not similarly named installed Skills", () => {
  assert.deepEqual(skillDraftFromOutput('{"draftId":"draft-a","name":"same"}\n\nThe Skill is a pending draft and is not active yet.'), { draftId: "draft-a", name: "same" });
  assert.equal(skillDraftFromOutput('{"name":"same"}'), undefined);
  assert.equal(skillDraftFromOutput("invalid"), undefined);
});

test("pending and processed same-name drafts have independent presentation", async () => {
  const traces: ToolTrace[] = ["a", "b"].map((draftId) => ({ id: draftId, name: "create_skill", status: "completed",
    output: JSON.stringify({ draftId, name: "same" }) }));
  let view: ReturnType<typeof create>;
  await act(async () => { view = create(createElement(SkillReviewRecords, {
    traces, onOpen: () => undefined, listDrafts: async () => [{ draftId: "b", name: "same", fileCount: 1, createdAt: "", updatedAt: "" }],
  })); });
  try {
    const records = view!.root.findAllByType(ProcessRecord);
    assert.deepEqual(records.map((item) => item.props.active), [false, true]);
  } finally { await act(async () => view!.unmount()); }
});

test("unavailable review status never reports a draft as processed", async () => {
  let view: ReturnType<typeof create>;
  await act(async () => { view = create(createElement(SkillReviewRecords, {
    traces: [{ id: "a", name: "create_skill", status: "completed", output: '{"draftId":"a"}' }],
    onOpen: () => undefined, listDrafts: async () => { throw new Error("offline"); },
  })); });
  try { assert.equal(view!.root.findByType(ProcessRecord).props.active, true); }
  finally { await act(async () => view!.unmount()); }
});
