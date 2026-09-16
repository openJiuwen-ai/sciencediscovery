// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { AgentActivityPanel } from "../src/AgentActivityPanel.js";
import { ApiClient } from "../src/api/client.js";

test("Session activity reads logs and cancels explicitly, never starts Shell", async () => {
  const calls: string[] = [];
  const activity = { executions: [{ id: "job", agentId: "main", runnerId: "local", workspaceId: "ws_a", state: "running", provenance: "pending" }],
    transfers: [], timers: [{ id: "timer", agentId: "main", message: "check output", dueAt: 1000, state: "pending" }], agents: [] };
  const client = { getAgentActivity: async () => activity,
    executionLogs: async () => { calls.push("logs"); return { chunks: [{ text: "still running" }] }; },
    cancelActivity: async (_session: string, kind: string) => { calls.push(kind); },
  } as unknown as ApiClient;
  let view: ReactTestRenderer;
  await act(async () => { view = create(createElement(AgentActivityPanel, { client, sessionId: "session" })); });
  try {
    const click = async (label: string) => act(async () => {
      view.root.findAllByType("button").find((button) => button.children.join("") === label)!.props.onClick();
    });
    await click("View logs"); assert.match(JSON.stringify(view!.toJSON()), /still running/);
    await click("Cancel execution"); await click("Cancel reminder");
    assert.deepEqual(calls, ["logs", "executions", "timers"]);
    assert.doesNotMatch(JSON.stringify(view!.toJSON()), /No transfers yet|Transfers/);
  } finally { await act(async () => view!.unmount()); }
});

test("pointing the panel at a record opens its fold and the record itself", async () => {
  const activity = { executions: [
    { id: "older", agentId: "main", runnerId: "local", workspaceId: "ws_a", state: "completed", provenance: "committed" },
    { id: "job", agentId: "main", runnerId: "local", workspaceId: "ws_a", state: "failed", provenance: "committed" },
  ], transfers: [], timers: [], agents: [] };
  const client = { getAgentActivity: async () => activity } as unknown as ApiClient;
  let view: ReactTestRenderer;
  const render = (focus?: { id: string; kind: "executions" | "timers"; token: number }) =>
    createElement(AgentActivityPanel, { client, sessionId: "session", ...(focus ? { focus } : {}) });
  await act(async () => { view = create(render()); });
  try {
    const folds = () => view.root.findAll((node) => node.type === "details" && String(node.props.className).includes("workspace-fold"));
    const records = () => view.root.findAll((node) => node.type === "details" && String(node.props.className).includes("process-record"));
    // Everything starts folded: terminal records are read on demand.
    assert.equal(folds()[0]!.props.open, false);
    assert.deepEqual(records().map((record) => record.props.open), [false, false]);
    await act(async () => { view.update(render({ id: "job", kind: "executions", token: 1 })); });
    assert.equal(folds()[0]!.props.open, true);
    const opened = records().filter((record) => record.props.open);
    assert.equal(opened.length, 1);
    assert.ok(opened[0]!.findAllByType("code").some((code) => code.children.join("") === "job"), "the requested record is the one opened");
  } finally { await act(async () => view!.unmount()); }
});

test("activity API uses Session-scoped control routes", async (t) => {
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (path: string) => { paths.push(path); return new Response("{}"); });
  const client = new ApiClient("");
  await client.getAgentActivity("a/b"); await client.executionLogs("a/b", "c/d");
  await client.cancelActivity("a/b", "timers", "t"); await client.resumeSubagent("a/b", "child");
  assert.deepEqual(paths, ["/api/sessions/a%2Fb/agent-activity", "/api/sessions/a%2Fb/agent-activity/executions/c%2Fd/logs",
    "/api/sessions/a%2Fb/agent-activity/timers/t/cancel", "/api/sessions/a%2Fb/subagents/child/resume"]);
});
