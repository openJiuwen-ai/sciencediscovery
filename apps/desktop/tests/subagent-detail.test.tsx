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

// The test runner compiles JSX with the classic runtime, so React has to be in
// scope even though the app itself uses the automatic one.
import React from "react";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { createTest } from "../../../test/support/tagged/compat.mjs";
import type { Subagent, SubagentStep } from "../src/api/types.js";
import { finalSteps } from "../src/run-stream/subagent.js";
import { TEXT } from "../src/text.js";
import { SubagentDetail } from "../src/views/SubagentDetail.js";

const { describe, it } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});

function step(overrides: Partial<SubagentStep> & { id: string }): SubagentStep {
  return {
    content: "",
    createdAt: "2026-10-27T10:00:00.000Z",
    kind: "assistant",
    status: "completed",
    ...overrides,
  };
}

function child(overrides: Partial<Subagent> = {}): Subagent {
  return {
    createdAt: "2026-10-27T09:59:00.000Z",
    id: "sa1",
    input: { description: "第二轮复审", prompt: "复审第一轮的结论" },
    maxTurns: 20,
    parentTurnId: "turn-1",
    sessionId: "s1",
    status: "running",
    steps: [],
    timeoutSeconds: 600,
    turnCount: 2,
    ...overrides,
  };
}

function html(subagent: Subagent): string {
  return renderToStaticMarkup(<SubagentDetail subagent={subagent} />);
}

/** The 输出 section, which is the last thing the panel draws. */
function outputOf(markup: string): string {
  const start = markup.indexOf('class="subagent-output"');
  return start < 0 ? "" : markup.slice(start);
}

describe("the steps that make up a child's answer", () => {
  it("joins the steps one message was split into", () => {
    const steps = [step({ content: "第一", id: "a" }), step({ content: "轮通过", id: "b" })];
    assert.deepEqual(finalSteps(steps).map((entry) => entry.id), ["a", "b"]);
  });

  it("stops at whatever the child did between messages", () => {
    const steps = [
      step({ content: "先看看数据", id: "a" }),
      step({ content: "read_file", id: "t", kind: "tool", toolName: "read_file" }),
      step({ content: "结论是 A", id: "b" }),
    ];
    assert.deepEqual(finalSteps(steps).map((entry) => entry.id), ["b"]);
  });

  it("falls back to the last message that said something", () => {
    const steps = [step({ content: "结论是 A", id: "a" }), step({ content: "  ", id: "b" })];
    assert.deepEqual(finalSteps(steps).map((entry) => entry.id), ["a"]);
  });

  it("is nothing when the child never wrote prose", () => {
    assert.deepEqual(finalSteps([step({ content: "写笔记", id: "t", kind: "thinking" })]), []);
  });
});

describe("the subagent panel's 输出", () => {
  it("does not exist while the child is still working", () => {
    const markup = html(child({
      status: "running",
      steps: [step({ content: "Now I have everything I need. Writing the audit.", id: "a" })],
    }));
    assert.equal(outputOf(markup), "", "a reply mid-run is progress, not a deliverable");
    assert.match(markup, /Now I have everything I need/, "and it stays where it was said");
  });

  it("shows the whole answer when the runtime split it across steps", () => {
    const markup = html(child({
      status: "completed",
      steps: [
        step({ content: "均值 8.5 未达 ROBUST，无硬门槛触发；第一", id: "a" }),
        step({ content: "轮失败的唯一硬门槛已经核实通过。", id: "b" }),
      ],
    }));
    const output = outputOf(markup);
    assert.match(output, /第一轮失败的唯一硬门槛已经核实通过。/, "the sentence is not cut in half");
    assert.equal((markup.match(/轮失败/g) ?? []).length, 1, "and is not also left in the timeline");
  });

  it("keeps the rest of the child's prose in the timeline", () => {
    const markup = html(child({
      status: "completed",
      steps: [
        step({ content: "先看看数据", id: "a" }),
        step({ content: "read_file", id: "t", kind: "tool", toolName: "read_file" }),
        step({ content: "结论是 A", id: "b" }),
      ],
    }));
    assert.match(markup, /先看看数据/);
    assert.doesNotMatch(outputOf(markup), /先看看数据/);
    assert.match(outputOf(markup), /结论是 A/);
  });

  it("is labelled as the panel's own section", () => {
    const markup = html(child({
      status: "completed",
      steps: [step({ content: "结论是 A", id: "a" })],
    }));
    assert.match(outputOf(markup), new RegExp(TEXT.subagent.output));
  });
});
