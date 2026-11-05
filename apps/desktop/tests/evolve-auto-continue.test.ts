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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";

import { lastAnswer } from "../src/evolve/use-auto-continue.js";
import { emptyRunStream } from "../src/run-stream/model.js";

function streamed(content: string) {
  return {
    responses: [{ content, responseId: "response-1", settled: true, truncated: false }],
    subagents: [],
    thinking: "",
    thinkingTruncated: false,
    tools: [],
    turn: 1,
  };
}

test("the completed answer is read, not the deltas that assembled it", () => {
  // `run.completed` carries the persisted message; a stream whose early frames
  // were dropped can hold half of it in `turns`. The decision to continue must
  // read the whole answer, because the card is at its end.
  const run = { ...emptyRunStream(), finalContent: "完整回答", status: "completed" as const, turns: [streamed("完整回")] };
  assert.equal(lastAnswer(run), "完整回答");
});

test("a stream with no completion falls back to its last non-empty response", () => {
  const run = {
    ...emptyRunStream(),
    turns: [streamed("第一段"), { ...streamed("第二段"), turn: 2 }],
  };
  assert.equal(lastAnswer(run), "第二段");
  // Empty turns are skipped rather than returned as "".
  assert.equal(lastAnswer({ ...emptyRunStream(), turns: [streamed("有"), { ...streamed(" "), turn: 2 }] }), "有");
  assert.equal(lastAnswer(emptyRunStream()), undefined);
});
