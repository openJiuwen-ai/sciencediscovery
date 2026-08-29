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

import type { AgentHistoryMessage } from "@sciencediscovery/orchestration";

import { closedModelContext } from "./model-context.js";

const assistantCall = (id: string): AgentHistoryMessage => ({
  role: "assistant",
  content: "",
  tool_calls: [{ id, type: "function", function: { name: "lookup", arguments: "{}" } }],
});
const toolResult = (id: string): AgentHistoryMessage => ({ role: "tool", content: "ok", tool_call_id: id });

test("the 128th model-turn boundary drops an unmatched final assistant call", () => {
  const history: AgentHistoryMessage[] = [];
  for (let turn = 1; turn < 128; turn += 1) {
    history.push(assistantCall(`call-${turn}`), toolResult(`call-${turn}`));
  }
  history.push(assistantCall("call-128"));

  const closed = closedModelContext(history);
  assert.equal(closed.length, 254);
  assert.equal(closed.at(-1)?.role, "tool");
  assert.equal(closed.some((message) => message.tool_call_id === "call-128"), false);
});

test("closed Chat Completions and Responses tool segments replay unchanged", () => {
  const responsesAssistant: AgentHistoryMessage = {
    role: "assistant",
    content: "",
    response_items: [{ type: "function_call", call_id: "response-call", name: "lookup", arguments: "{}" }],
  };
  const history = [
    assistantCall("chat-call"),
    toolResult("chat-call"),
    responsesAssistant,
    toolResult("response-call"),
    { role: "assistant", content: "done" },
  ] satisfies AgentHistoryMessage[];
  assert.deepEqual(closedModelContext(history), history);
});

test("a partial multi-tool result is removed together with its unclosed assistant", () => {
  const assistant: AgentHistoryMessage = {
    role: "assistant",
    content: "",
    tool_calls: [
      { id: "a", type: "function", function: { name: "x", arguments: "{}" } },
      { id: "b", type: "function", function: { name: "y", arguments: "{}" } },
    ],
  };
  assert.deepEqual(closedModelContext([
    { role: "assistant", content: "previous" },
    assistant,
    toolResult("a"),
  ]), [{ role: "assistant", content: "previous" }]);
});
