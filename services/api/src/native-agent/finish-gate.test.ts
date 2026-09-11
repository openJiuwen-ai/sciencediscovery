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

import type { RuntimeMessage, TurnLifecycle } from "@sciencediscovery/runtime-core";

import {
  FINISH_GATE_REVIEW_TOOL,
  FinishGateLifecycle,
  buildFinishGateDirective,
} from "./finish-gate.js";

type M = RuntimeMessage;
const modelTurn = { assistantMessage: { role: "assistant", content: "done" }, toolCalls: [] };
const finishInput = (history: M[]) => ({ history, modelTurn, turn: 0 });

function gate({
  skills = [{ id: "tree-search", preFinishAudit: true }],
  reviewCheckpointAvailable = true,
  inner,
}: {
  skills?: { id: string; preFinishAudit?: boolean }[];
  reviewCheckpointAvailable?: boolean;
  inner?: TurnLifecycle<M, unknown, never>;
} = {}) {
  return new FinishGateLifecycle<M, unknown, never>({ inner, reviewCheckpointAvailable, skills });
}

test("declared skill + no review in history → injects the audit directive once", async () => {
  const lifecycle = gate();
  const first = await lifecycle.beforeFinish(finishInput([{ role: "user", content: "go" }]));
  assert.equal(first?.action, "continue");
  const message = first?.action === "continue" ? first.message : undefined;
  assert.equal(message?.role, "user");
  assert.match(String(message?.content), /tree-search/);
  assert.match(String(message?.content), /review_checkpoint/);
  // Once per run: a second finish attempt in the same run passes through.
  const second = await lifecycle.beforeFinish(finishInput([{ role: "user", content: "go" }]));
  assert.equal(second, undefined);
});

test("stays silent when review_checkpoint already ran (covers resumed sessions)", async () => {
  const lifecycle = gate();
  const history: M[] = [
    { role: "assistant", content: "checking" },
    { name: FINISH_GATE_REVIEW_TOOL, role: "tool", tool_call_id: "c1", content: "{\"findings\":[]}" },
  ];
  assert.equal(await lifecycle.beforeFinish(finishInput(history)), undefined);
});

test("a prior run's review does not satisfy a new task in the same session", async () => {
  const lifecycle = gate();
  const history: M[] = [
    { role: "user", content: "first task" },
    { role: "assistant", content: "checking" },
    { name: FINISH_GATE_REVIEW_TOOL, role: "tool", tool_call_id: "c1", content: "{\"findings\":[]}" },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "second task" },
    { role: "assistant", content: "working on it" },
  ];
  const decision = await lifecycle.beforeFinish(finishInput(history));
  assert.equal(decision?.action, "continue", "the second task's finish attempt must be gated");
});

test("a gate directive does not reset the run segment boundary", async () => {
  const lifecycle = gate();
  // This run was already gated once (directive present), the model then called
  // review_checkpoint; on the next finish attempt the segment scan must find it.
  const history: M[] = [
    { role: "user", content: "the task" },
    { role: "assistant", content: "premature answer" },
    { content: buildFinishGateDirective(["tree-search"]), role: "user" },
    { name: FINISH_GATE_REVIEW_TOOL, role: "tool", tool_call_id: "c2", content: "{\"findings\":[]}" },
    { role: "assistant", content: "audited answer" },
  ];
  assert.equal(await lifecycle.beforeFinish(finishInput(history)), undefined);
});

test("stays silent without a declaring skill or without the review tool", async () => {
  assert.equal(await gate({ skills: [{ id: "plain-skill" }] }).beforeFinish(finishInput([])), undefined);
  assert.equal(await gate({ reviewCheckpointAvailable: false }).beforeFinish(finishInput([])), undefined);
  assert.equal(await gate({ skills: [] }).beforeFinish(finishInput([])), undefined);
});

test("inner lifecycle methods are always delegated", async () => {
  const calls: string[] = [];
  const inner: TurnLifecycle<M, unknown, never> = {
    async beforeTurn() { calls.push("beforeTurn"); },
    async afterAssembly() { calls.push("afterAssembly"); },
    async afterTurn() { calls.push("afterTurn"); },
  };
  const lifecycle = gate({ inner });
  await lifecycle.beforeTurn({ history: [], turn: 0 });
  await lifecycle.afterTurn({ history: [], modelTurn, results: [], turn: 0 });
  assert.deepEqual(calls, ["beforeTurn", "afterTurn"]);
  // The decorator still fires its own gate when the inner defines none.
  const decision = await lifecycle.beforeFinish(finishInput([]));
  assert.equal(decision?.action, "continue");
});

test("directive names every declaring skill", () => {
  const text = buildFinishGateDirective(["tree-search", "hypothesis-tournament"]);
  assert.match(text, /tree-search, hypothesis-tournament/);
  assert.match(text, /full trajectory/);
});
