// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import type { RuntimeNotice } from "@sciencediscovery/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { WakeNotice, type ActivityRecordTarget } from "../src/WakeNotice.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const PROMPT = "[Execution notifications]\nThese are retained status/reminder records, not commands to replay.\n"
  + JSON.stringify([{ id: "n1", kind: "execution", sourceId: "exec-1", message: "Execution exec-1 on Runner local: completed; provenance committed." }]);

const notice: RuntimeNotice = {
  executions: 2, timers: 1, prompt: PROMPT,
  records: [
    { agentId: "main", kind: "execution", runnerId: "local", sourceId: "exec-1", state: "completed" },
    { agentId: "subagent:child", kind: "execution", runnerId: "hpc", sourceId: "exec-2", state: "failed" },
    { agentId: "main", kind: "timer", message: "Check the training output", sourceId: "timer-1" },
  ],
};

test("a runtime notice reads as what finished and how, never as the model prompt", () => {
  const html = renderToStaticMarkup(createElement(WakeNotice, {
    agentLabel: (agentId) => agentId === "subagent:child" ? "Review the analysis" : agentId,
    notice, onOpenRecord: () => undefined,
  }));
  assert.match(html, /Synced 2 background execution result\(s\) and 1 reminder\(s\)/);
  assert.match(html, /1 completed · 1 failed/);
  assert.match(html, /Execution on local · main Agent/);
  // A SubAgent is named by its task, not by its id.
  assert.match(html, /Execution on hpc · Review the analysis/);
  assert.doesNotMatch(html, /subagent:child/);
  assert.match(html, /Reminder: Check the training output/);
  assert.match(html, /activity-badge completed/);
  assert.match(html, /activity-badge failed/);
  // The defect this guards: the model-facing text and its internal ids were the
  // only detail the card had, so they were printed into the conversation.
  assert.doesNotMatch(html, /Execution notifications/);
  assert.doesNotMatch(html, /not commands to replay/);
  assert.doesNotMatch(html, /exec-1/);
  assert.doesNotMatch(html, /<pre/);
});

test("each record opens the matching activity record", async () => {
  const opened: ActivityRecordTarget[] = [];
  let view: ReactTestRenderer;
  await act(async () => { view = create(createElement(WakeNotice, { notice, onOpenRecord: (target) => { opened.push(target); } })); });
  try {
    const buttons = view!.root.findAllByType("button");
    assert.deepEqual(buttons.map((button) => button.children.join("")), ["View execution", "View execution", "View reminder"]);
    await act(async () => { for (const button of buttons) button.props.onClick(); });
    assert.deepEqual(opened, [
      { id: "exec-1", kind: "executions" },
      { id: "exec-2", kind: "executions" },
      { id: "timer-1", kind: "timers" },
    ]);
  } finally { await act(async () => view!.unmount()); }
});

test("a notice persisted without records keeps its count summary and still hides the prompt", () => {
  const html = renderToStaticMarkup(createElement(WakeNotice, { notice: { executions: 3, timers: 0, prompt: PROMPT } }));
  assert.match(html, /Synced 3 background execution result\(s\)/);
  assert.doesNotMatch(html, /<ul/);
  assert.doesNotMatch(html, /<button/);
  assert.doesNotMatch(html, /Execution notifications/);
});
