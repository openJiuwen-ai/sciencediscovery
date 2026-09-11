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
  extractQuotedSpans,
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

test("generic checklist carries the abstain and verify-before-verbatim discipline", () => {
  const text = buildFinishGateDirective(["systematic-review"]);
  assert.match(text, /verify_citation/);
  assert.match(text, /did not contain the answer/);
  assert.match(text, /what was searched/);
});

test("directive points at selected audit companions via read_skill; absent companions stay generic", () => {
  const withCompanion = buildFinishGateDirective(["tree-search"], ["audit-tree-search"]);
  assert.match(withCompanion, /read_skill/);
  assert.match(withCompanion, /`audit-tree-search`/);
  const without = buildFinishGateDirective(["tree-search"]);
  assert.ok(!without.includes("read_skill"), "no audit pointer without a selected companion");
});

test("gate names the audit companion only when it is selected for the run", async () => {
  const withCompanion = gate({ skills: [
    { id: "hypothesis-tournament", preFinishAudit: true },
    { id: "audit-hypothesis-tournament" },
  ] });
  const decisionWith = await withCompanion.beforeFinish(finishInput([]));
  assert.match(String((decisionWith as { message?: { content?: unknown } })?.message?.content), /audit-hypothesis-tournament/);

  const withoutCompanion = gate({ skills: [{ id: "hypothesis-tournament", preFinishAudit: true }] });
  const decisionWithout = await withoutCompanion.beforeFinish(finishInput([]));
  assert.ok(!String((decisionWithout as { message?: { content?: unknown } })?.message?.content).includes("audit-hypothesis-tournament"));
});

// --- Stage 2: groundedness enforcement (V2-C3) ------------------------------

const QUOTE_A = "Helical parameters were locally searched based on previously reported values, resulting in a twist and rise";
const QUOTE_B = "The nucleocapsid helix condenses upon incorporation into the progeny virion during assembly";

function verifyCitationCall(quote: string) {
  return {
    role: "assistant",
    tool_calls: [{ function: { arguments: JSON.stringify({ kbId: "kb1", quote }), name: "verify_citation" }, id: "v1" }],
  };
}

test("extractQuotedSpans pulls paired-quote and blockquote spans, filters noise", () => {
  const text = `Intro "not a quote" short.\nClaim: “${QUOTE_A}” end.\n> ${QUOTE_B}\nCode: "x=1" and ids "04d3a509-daf0-4bf2-91df-75d2a9059c14-aaaa" here.`;
  const spans = extractQuotedSpans(text);
  assert.deepEqual(spans, [QUOTE_A, QUOTE_B]);
});

test("stage 2 fires on unverified spans; verified spans via verify_citation args are covered", async () => {
  const lifecycle = gate({ skills: [] });
  const history = [
    { role: "user", content: "go" },
    verifyCitationCall(QUOTE_A),
    { role: "tool", name: "verify_citation", tool_call_id: "v1", content: "{\"state\":\"verbatim\"}" },
  ];
  const draft = `Answer: “${QUOTE_A}” and also “${QUOTE_B}” done.`;
  const decision = await lifecycle.beforeFinish({
    history: [...history, { role: "assistant", content: draft }],
    modelTurn: { assistantMessage: { role: "assistant", content: draft }, toolCalls: [] },
    turn: 3,
  });
  assert.equal(decision?.action, "continue");
  const text = String((decision as { message?: { content?: unknown } })?.message?.content);
  assert.ok(text.includes("Pre-finish grounding enforcement"));
  assert.ok(!text.includes(QUOTE_A.slice(0, 40)), "the verified span must not be listed");
  assert.ok(text.includes(QUOTE_B.slice(0, 40)), "the unverified span must be listed");
  // Fires once: the next finish attempt passes through.
  const second = await lifecycle.beforeFinish({
    history: [...history, { role: "assistant", content: draft }],
    modelTurn: { assistantMessage: { role: "assistant", content: draft }, toolCalls: [] },
    turn: 4,
  });
  assert.equal(second, undefined);
});

test("stage 2 covers spans recorded in evidence_ledger when a verify action ran", async () => {
  const lifecycle = gate({ skills: [] });
  const history = [
    { role: "user", content: "go" },
    { role: "assistant", tool_calls: [{ function: { arguments: JSON.stringify({ action: "add", claim: "condensation", quote: QUOTE_B }), name: "evidence_ledger" }, id: "l1" }] },
    { role: "assistant", tool_calls: [{ function: { arguments: JSON.stringify({ action: "verify", kbId: "kb1" }), name: "evidence_ledger" }, id: "l2" }] },
  ];
  const draft = `Answer: “${QUOTE_B}” end.`;
  const decision = await lifecycle.beforeFinish({
    history: [...history, { role: "assistant", content: draft }],
    modelTurn: { assistantMessage: { role: "assistant", content: draft }, toolCalls: [] },
    turn: 2,
  });
  assert.equal(decision, undefined, "ledger add + verify covers the span");
});

test("stage ordering: audit fires first, grounding second, then silence", async () => {
  const lifecycle = gate({ skills: [{ id: "systematic-review", preFinishAudit: true }] });
  const draft = `Answer: “${QUOTE_B}” end.`;
  const finishInput = () => ({
    history: [{ role: "user", content: "go" }, { role: "assistant", content: draft }],
    modelTurn: { assistantMessage: { role: "assistant", content: draft }, toolCalls: [] },
    turn: 1,
  });
  const first = await lifecycle.beforeFinish(finishInput());
  assert.match(String((first as { message?: { content?: unknown } })?.message?.content), /Pre-finish verification required by skill/);
  // The review landed, but the draft still carries an unverified quote.
  const second = await lifecycle.beforeFinish({
    history: [
      { role: "user", content: "go" },
      { role: "assistant", content: draft },
      { role: "tool", name: "review_checkpoint", tool_call_id: "r1", content: "{}" },
    ],
    modelTurn: { assistantMessage: { role: "assistant", content: draft }, toolCalls: [] },
    turn: 2,
  });
  assert.match(String((second as { message?: { content?: unknown } })?.message?.content), /Pre-finish grounding enforcement/);
  const third = await lifecycle.beforeFinish(finishInput());
  assert.equal(third, undefined);
});

test("stage 2 stays silent for quotes verified in a previous run of the same session", async () => {
  const lifecycle = gate({ skills: [] });
  const draft = `Answer: “${QUOTE_A}” end.`;
  // The verify_citation call belongs to a previous run (before the last user message).
  const decision = await lifecycle.beforeFinish({
    history: [
      verifyCitationCall(QUOTE_A),
      { role: "user", content: "new task" },
      { role: "assistant", content: draft },
    ],
    modelTurn: { assistantMessage: { role: "assistant", content: draft }, toolCalls: [] },
    turn: 2,
  });
  assert.ok(decision?.action === "continue", "a previous run's verdict does not cover this run's quotes");
});

test("stage 2 is NOT covered by a ledger add without a verify action", async () => {
  const lifecycle = gate({ skills: [] });
  const history = [
    { role: "user", content: "go" },
    { role: "assistant", tool_calls: [{ function: { arguments: JSON.stringify({ action: "add", claim: "condensation", quote: QUOTE_B }), name: "evidence_ledger" }, id: "l1" }] },
  ];
  const draft = `Answer: “${QUOTE_B}” end.`;
  const decision = await lifecycle.beforeFinish({
    history: [...history, { role: "assistant", content: draft }],
    modelTurn: { assistantMessage: { role: "assistant", content: draft }, toolCalls: [] },
    turn: 2,
  });
  assert.ok(decision?.action === "continue", "recording a quote without verifying it must not count as coverage");
});

test("stage 2 stays silent when quote-verification tooling is unavailable", async () => {
  const lifecycle = new FinishGateLifecycle<M, unknown, never>({
    quoteVerificationAvailable: false,
    reviewCheckpointAvailable: false,
    skills: [],
  });
  const draft = `Answer: “${QUOTE_B}” end.`;
  const decision = await lifecycle.beforeFinish({
    history: [{ role: "user", content: "go" }, { role: "assistant", content: draft }],
    modelTurn: { assistantMessage: { role: "assistant", content: draft }, toolCalls: [] },
    turn: 2,
  });
  assert.equal(decision, undefined, "no gate without a verification tool to point at");
});
