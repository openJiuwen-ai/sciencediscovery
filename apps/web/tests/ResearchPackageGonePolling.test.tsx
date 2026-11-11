// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { AgentActivityPanel } from "../src/AgentActivityPanel.js";
import type { ApiClient } from "../src/api/client.js";

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
