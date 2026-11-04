// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { AgentActivityPanel } from "../src/AgentActivityPanel.js";
import type { ApiClient } from "../src/api/client.js";

/** The API treats `unknown` as terminal: it stamps `finishedAt` and stores the reason
 * ("API restarted; inspect completed files and target state before explicitly retrying").
 * The panel must agree, or a finished record reads as work in progress forever. */
function unknownOutcome() {
  return {
    executions: [{ id: "lost", agentId: "main", runnerId: "local", workspaceId: "ws_a",
      state: "unknown", provenance: "unconfirmed", error: "Runner restarted before completion was recorded" }],
    transfers: [{ id: "t1", sessionId: "session", agentId: "main", state: "unknown",
      createdAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:05.000Z",
      sourceWorkspaceId: "ws_a", targetWorkspaceId: "ws_b",
      files: [{ sourcePath: "a.csv", targetPath: "a.csv" }],
      error: "API restarted; inspect completed files and target state before explicitly retrying.",
      progress: [{ sourcePath: "a.csv", targetPath: "a.csv", size: 1, sha256: "a".repeat(64), bytes: 0, state: "unknown" }] }],
    timers: [], agents: [],
  };
}

function inFlight() {
  return {
    executions: [{ id: "job", agentId: "main", runnerId: "local", workspaceId: "ws_a",
      state: "running", provenance: "pending" }],
    transfers: [{ id: "t2", sessionId: "session", agentId: "main", state: "queued",
      createdAt: "2026-01-01T00:00:00.000Z", sourceWorkspaceId: "ws_a", targetWorkspaceId: "ws_b",
      files: [{ sourcePath: "b.csv", targetPath: "b.csv" }], progress: [] }],
    timers: [], agents: [],
  };
}

async function renderWith(activity: unknown): Promise<ReactTestRenderer> {
  const client = { getAgentActivity: async () => activity } as unknown as ApiClient;
  let view: ReactTestRenderer;
  await act(async () => { view = create(createElement(AgentActivityPanel, { client, sessionId: "session" })); });
  return view!;
}

test("a record whose outcome is unknown is finished, not live", async () => {
  const view = await renderWith(unknownOutcome());
  try {
    const live = view.root.findAll((node) => node.type === "details" && String(node.props.className).includes("process-live"));
    assert.equal(live.length, 0, "unknown is terminal, so no record may render as process-live");
    const records = view.root.findAll((node) => node.type === "details" && String(node.props.className).includes("process-record"));
    assert.equal(records.length, 2, "both the execution and the transfer read as foldable history");
    // The reason the API stored is what the reader sees, so the record explains itself.
    assert.match(JSON.stringify(view.toJSON()), /Runner restarted before completion was recorded/);
    assert.match(JSON.stringify(view.toJSON()), /inspect completed files and target state/);
  } finally { await act(async () => view.unmount()); }
});

test("an unknown record offers no action that implies it is still running", async () => {
  const view = await renderWith(unknownOutcome());
  try {
    const button = (label: string) => view.root.findAllByType("button").find((node) => node.children.join("") === label);
    assert.equal(button("Cancel execution")?.props.disabled, true, "unknown is terminal, so Cancel execution is disabled");
    assert.equal(button("Cancel transfer")?.props.disabled, true, "unknown is terminal, so Cancel transfer is disabled");
  } finally { await act(async () => view.unmount()); }
});

test("queued and running records stay live and cancellable", async () => {
  const view = await renderWith(inFlight());
  try {
    const live = view.root.findAll((node) => node.type === "details" && String(node.props.className).includes("process-live"));
    assert.equal(live.length, 2, "in-flight work keeps the live surface");
    const button = (label: string) => view.root.findAllByType("button").find((node) => node.children.join("") === label);
    assert.equal(button("Cancel execution")?.props.disabled, false);
    assert.equal(button("Cancel transfer")?.props.disabled, false);
  } finally { await act(async () => view.unmount()); }
});
