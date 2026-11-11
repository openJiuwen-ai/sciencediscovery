// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { AgentActivityPanel } from "../src/AgentActivityPanel.js";
import { ApiRequestError } from "../src/api/auth.js";
import type { ApiClient } from "../src/api/client.js";
import { ResearchPackagePreviewMonitor } from "../src/research-package/ResearchPackagePreviewMonitor.js";

/** The monitor schedules with `window.setInterval`; the runner has no DOM. */
function withWindow(run: () => Promise<void>): Promise<void> {
  const target = globalThis as unknown as { window?: typeof globalThis };
  const previous = target.window;
  target.window = globalThis;
  return run().finally(() => {
    if (previous === undefined) delete target.window;
    else target.window = previous;
  });
}

test("a deleted Project ends the preview poll instead of asking again every 3s", async (context) => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  context.mock.timers.enable({ apis: ["setInterval"] });
  await withWindow(async () => {
    let calls = 0;
    const client = {
      getResearchPackagePreviews: async () => {
        calls += 1;
        throw new ApiRequestError("This Project or Session no longer exists, so there is nothing left to preview.", 410, "EXPORT_PREVIEW_RESOURCE_DELETED");
      },
      previewResearchPackage: async () => { throw new Error("unused"); },
    } as unknown as ApiClient;
    let view: ReactTestRenderer;
    await act(async () => { view = create(createElement(ResearchPackagePreviewMonitor, { client, projectId: "project", sessionId: "session", isRunning: false })); });
    try {
      assert.equal(calls, 1);
      // Three further ticks would be three more 404s on a deleted Project.
      for (const _ of [1, 2, 3]) await act(async () => { context.mock.timers.tick(3_000); });
      assert.equal(calls, 1);
    } finally { await act(async () => view!.unmount()); }
  });
  context.mock.timers.reset();
});

test("a live Project keeps its preview poll running", async (context) => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  context.mock.timers.enable({ apis: ["setInterval"] });
  await withWindow(async () => {
    let calls = 0;
    const preview = { revision: "r1", estimatedBytes: 1, files: [], omissions: [] };
    const client = {
      getResearchPackagePreviews: async () => {
        calls += 1;
        return { revision: "r1", necessary: preview, complete: preview, completeWithTrajectory: preview, completeWithMemoryGraph: preview, completeWithTrajectoryAndMemoryGraph: preview };
      },
      previewResearchPackage: async () => preview,
    } as unknown as ApiClient;
    let view: ReactTestRenderer;
    await act(async () => { view = create(createElement(ResearchPackagePreviewMonitor, { client, projectId: "project", sessionId: "session", isRunning: false })); });
    try {
      assert.equal(calls, 1);
      await act(async () => { context.mock.timers.tick(3_000); });
      assert.equal(calls, 2);
    } finally { await act(async () => view!.unmount()); }
  });
  context.mock.timers.reset();
});

test("a deleted Session stops the agent-activity poll after it says so once", async (context) => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  context.mock.timers.enable({ apis: ["setInterval"] });
  let reads = 0;
  let sessionReads = 0;
  const client = {
    getAgentActivity: async () => {
      reads += 1;
      throw new Error("Session not found: session");
    },
    getSession: async () => {
      sessionReads += 1;
      throw new Error("Session not found");
    },
  } as unknown as ApiClient;
  let view: ReactTestRenderer;
  await act(async () => { view = create(createElement(AgentActivityPanel, { client, sessionId: "session" })); });
  try {
    await act(async () => { context.mock.timers.tick(2_000); });
    const readsAfterGone = reads;
    assert.ok(readsAfterGone >= 1);
    assert.equal(sessionReads >= 1, true);
    const alerts = () => view.root.findAllByProps({ role: "alert" });
    assert.deepEqual(alerts().map((alert) => alert.children.join("")), ["Session not found: session"]);
    for (const _ of [1, 2, 3]) await act(async () => { context.mock.timers.tick(2_000); });
    assert.equal(reads, readsAfterGone);
  } finally {
    await act(async () => view!.unmount());
    context.mock.timers.reset();
  }
});
test("a deletion that arrives after a conversation switch does not stop the new scope's poll", async (context) => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  context.mock.timers.enable({ apis: ["setInterval"] });
  await withWindow(async () => {
    // The first request belongs to the previous conversation and answers only
    // after the user has switched. That late answer must not mark the new
    // scope gone: otherwise both effects return early and its poll never runs.
    let settleOld!: () => void;
    const oldAnswered = new Promise<void>((resolve) => { settleOld = resolve; });
    const calls: string[] = [];
    const preview = { revision: "r1", estimatedBytes: 1, files: [], omissions: [] };
    const client = {
      getResearchPackagePreviews: async (projectId: string, sessionId: string) => {
        calls.push(`${projectId}:${sessionId}`);
        if (sessionId === "old") {
          await oldAnswered;
          throw new ApiRequestError("gone", 410, "EXPORT_PREVIEW_RESOURCE_DELETED");
        }
        return { revision: "r1", necessary: preview, complete: preview, completeWithTrajectory: preview, completeWithMemoryGraph: preview, completeWithTrajectoryAndMemoryGraph: preview };
      },
      previewResearchPackage: async () => preview,
    } as unknown as ApiClient;
    let view: ReactTestRenderer;
    await act(async () => { view = create(createElement(ResearchPackagePreviewMonitor, { client, projectId: "project", sessionId: "old", isRunning: false })); });
    try {
      assert.deepEqual(calls, ["project:old"]);
      // Switch conversations while the old poll is still in flight.
      await act(async () => { view!.update(createElement(ResearchPackagePreviewMonitor, { client, projectId: "project", sessionId: "new", isRunning: false })); });
      assert.deepEqual(calls, ["project:old", "project:new"]);
      // The old request now answers "gone"; the new scope must keep polling.
      await act(async () => { settleOld(); await oldAnswered; await Promise.resolve(); });
      await act(async () => { context.mock.timers.tick(3_000); });
      assert.deepEqual(calls, ["project:old", "project:new", "project:new"]);
    } finally { await act(async () => view!.unmount()); }
  });
  context.mock.timers.reset();
});