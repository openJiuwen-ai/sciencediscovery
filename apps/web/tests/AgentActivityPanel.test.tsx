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

test("activity API uses Session-scoped control routes", async (t) => {
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (path: string) => { paths.push(path); return new Response("{}"); });
  const client = new ApiClient("");
  await client.getAgentActivity("a/b"); await client.executionLogs("a/b", "c/d");
  await client.cancelActivity("a/b", "timers", "t"); await client.resumeSubagent("a/b", "child");
  assert.deepEqual(paths, ["/api/sessions/a%2Fb/agent-activity", "/api/sessions/a%2Fb/agent-activity/executions/c%2Fd/logs",
    "/api/sessions/a%2Fb/agent-activity/timers/t/cancel", "/api/sessions/a%2Fb/subagents/child/resume"]);
});
