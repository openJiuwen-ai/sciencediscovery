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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import type { AgentHistoryMessage } from "@sciencediscovery/orchestration";
import { seedHistoryText } from "./history-seed.js";

const messages = (input: unknown[]): AgentHistoryMessage[] => input as unknown as AgentHistoryMessage[];

test("an empty transcript folds to nothing", () => {
  assert.equal(seedHistoryText([]), "");
});

test("roles are ordered and labelled, with tool calls and their results recognisable", () => {
  const text = seedHistoryText(messages([
    { role: "user", content: "my sample code is ORCHID-7429" },
    { role: "assistant", content: "Noted.", tool_calls: [{ id: "c1", name: "read_file", arguments: '{"path":"a.txt"}' }] },
    { role: "tool", tool_call_id: "c1", content: "print(1)" },
    { role: "assistant", content: "done" },
  ]));
  assert.ok(text.includes("user: my sample code is ORCHID-7429"));
  assert.ok(text.includes("assistant: Noted."));
  assert.ok(text.includes("tool call: read_file"));
  assert.ok(text.includes("tool result: print(1)"));
  assert.ok(text.includes("assistant: done"));
  assert.ok(text.indexOf("user:") < text.indexOf("tool call:"));
  assert.ok(text.indexOf("tool call:") < text.indexOf("tool result:"));
  assert.ok(text.indexOf("tool result:") < text.indexOf("assistant: done"));
});

test("a long transcript is bounded but keeps the opening user message as an anchor", () => {
  const history = messages([
    { role: "user", content: "the seed fact is FROZEN-001" },
    ...Array.from({ length: 600 }, (_, index) => ({ role: "assistant", content: `filler response ${index}` })),
  ]);
  const text = seedHistoryText(history);
  assert.ok(text.includes("user: the seed fact is FROZEN-001"));
  assert.ok(text.length < 32_000, `folded text is bounded, got ${text.length}`);
});

test("an oversized opening user message is clipped so the budget still holds", () => {
  const text = seedHistoryText(messages([
    { role: "user", content: "X".repeat(200_000) },
    { role: "assistant", content: "tail" },
  ]));
  assert.ok(text.length < 26_000, `folded text is bounded, got ${text.length}`);
  assert.ok(text.includes(`user: ${"X".repeat(500)}`));
  assert.ok(text.includes("assistant: tail"));
});

test("messages with no textual content contribute nothing", () => {
  const text = seedHistoryText(messages([{ role: "assistant", tool_calls: [{ id: "c1", name: "task", arguments: "{}" }] }]));
  assert.ok(text.includes("tool call: task"));
  assert.ok(!text.includes("assistant:"));
});