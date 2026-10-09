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

import type { ChatMessage } from "@sciencediscovery/schema";

import {
  FINISH_GATE_AUDIT_DIRECTIVE_PREFIX,
  FINISH_GATE_GROUNDING_DIRECTIVE_PREFIX,
  FINISH_GATE_INTERVENTION_DIRECTIVE_PREFIX,
  FINISH_GATE_REVIEW_TOOL,
} from "../native-agent/finish-gate.js";
import { chainRootIndex, evaluatePostRunFinishGate } from "./finish-gate-followup.js";

const AUDIT_SKILL = { id: "tree-search", preFinishAudit: true };

function user(content: string, kind?: ChatMessage["kind"]): ChatMessage {
  return { content, createdAt: "2026-10-09T00:00:00Z", id: `u-${content.length}-${Math.random()}`, role: "user", ...(kind ? { kind } : {}) };
}

/** A persisted assistant message whose modelContext carries the run trajectory. */
function assistant(text: string, trajectory: Array<Record<string, unknown>> = []): ChatMessage {
  return {
    content: text,
    createdAt: "2026-10-09T00:00:00Z",
    id: `a-${Math.random()}`,
    modelContext: [...trajectory, { content: text, role: "assistant" }],
    role: "assistant",
  };
}

function toolCallAssistant(calls: Array<{ args: unknown; id: string; name: string }>): Record<string, unknown> {
  return {
    content: "",
    role: "assistant",
    tool_calls: calls.map((call) => ({
      function: { arguments: JSON.stringify(call.args), name: call.name },
      id: call.id,
      type: "function",
    })),
  };
}

function toolResult(id: string, name: string, result: unknown): Record<string, unknown> {
  return { content: JSON.stringify(result), name, role: "tool", tool_call_id: id };
}

const BASE_INPUT = {
  quoteVerificationAvailable: false,
  reviewCheckpointAvailable: true,
  skills: [AUDIT_SKILL],
} as const;

test("stage 1 fires when an audit-skill run finished without a review checkpoint", async () => {
  const gate = await evaluatePostRunFinishGate({
    ...BASE_INPUT,
    messages: [
      user("比较三条候选路径并给出结论。"),
      assistant("初步结论：B 最优。", [
        toolCallAssistant([{ args: { query: "candidate paths" }, id: "c1", name: "kb_search" }]),
        toolResult("c1", "kb_search", { hits: [] }),
      ]),
    ],
  });
  assert.equal(gate.capped, false);
  assert.equal(gate.verdict?.stage, "audit");
  assert.ok(gate.verdict?.directive.startsWith(FINISH_GATE_AUDIT_DIRECTIVE_PREFIX));
  assert.ok(gate.verdict?.directive.includes("tree-search"));
});

test("stage 1 stays silent once a review_checkpoint result exists in the chain", async () => {
  const gate = await evaluatePostRunFinishGate({
    ...BASE_INPUT,
    messages: [
      user("比较三条候选路径并给出结论。"),
      assistant("初步结论：B 最优。"),
      user(`${FINISH_GATE_AUDIT_DIRECTIVE_PREFIX} tree-search. …`),
      assistant("审计完成：每条依据均已对照轨迹核实。", [
        toolCallAssistant([{ args: { reason: "audit done" }, id: "c2", name: FINISH_GATE_REVIEW_TOOL }]),
        toolResult("c2", FINISH_GATE_REVIEW_TOOL, { recorded: true }),
      ]),
    ],
  });
  assert.equal(gate.capped, false);
  assert.equal(gate.verdict, undefined);
});

test("stage 1 stays silent when the audit directive was already issued (native in-loop parity)", async () => {
  // Native executor: the in-loop directive persists inside the run's
  // modelContext; the model ignored it and finished anyway. One audit
  // directive per chain — the post-run gate must not re-fire it.
  const gate = await evaluatePostRunFinishGate({
    ...BASE_INPUT,
    messages: [
      user("比较三条候选路径并给出结论。"),
      assistant("最终结论：B 最优。", [
        { content: "初步结论：B 最优。", role: "assistant" },
        { content: `${FINISH_GATE_AUDIT_DIRECTIVE_PREFIX} tree-search. …`, role: "user" },
      ]),
    ],
  });
  assert.equal(gate.capped, false);
  assert.equal(gate.verdict, undefined);
});

test("the shared directive cap stops the chain and reports capped when conditions stay unmet", async () => {
  const directive = `${FINISH_GATE_AUDIT_DIRECTIVE_PREFIX} tree-search. …`;
  const gate = await evaluatePostRunFinishGate({
    ...BASE_INPUT,
    messages: [
      user("比较三条候选路径并给出结论。"),
      // Three grounding directives (stage 2 re-fires) spend the budget while
      // the audit stage has never been issued and never reviewed.
      assistant("draft one"),
      user(`${FINISH_GATE_GROUNDING_DIRECTIVE_PREFIX} one`),
      assistant("draft two"),
      user(`${FINISH_GATE_GROUNDING_DIRECTIVE_PREFIX} two`),
      assistant("draft three"),
      user(`${FINISH_GATE_GROUNDING_DIRECTIVE_PREFIX} three`),
      assistant("最终答案，没有审计也没有核实。"),
    ],
  });
  assert.equal(gate.verdict, undefined);
  assert.equal(gate.capped, true);
});

test("a spent chain with all conditions met is not reported capped", async () => {
  const quote = "the nucleocapsid protein assembles into helical structures with a pitch of thirty nanometers";
  const grounding = `${FINISH_GATE_GROUNDING_DIRECTIVE_PREFIX} x`;
  const gate = await evaluatePostRunFinishGate({
    ...BASE_INPUT,
    quoteVerificationAvailable: true,
    skills: [],
    messages: [
      user("引用原文回答。"),
      assistant("draft one"),
      user(grounding),
      assistant("draft two"),
      user(grounding),
      assistant("draft three"),
      user(grounding),
      // Cap spent (3 directives), but the final answer's only quote carries a
      // verbatim verdict — nothing remains unmet, so capped must be false.
      assistant(`论文指出：“${quote}”。`, [
        toolCallAssistant([{ args: { kbId: "kb1", quote }, id: "v9", name: "verify_citation" }]),
        toolResult("v9", "verify_citation", { state: "verbatim" }),
      ]),
    ],
  });
  assert.equal(gate.verdict, undefined);
  assert.equal(gate.capped, false);
});

test("chainRootIndex picks the last genuine user message", () => {
  const mk = (role: string, content: string, kind?: string) => ({ content, ...(kind ? { kind } : {}), role });
  assert.equal(chainRootIndex([mk("user", "A"), mk("assistant", "a"), mk("user", "B"), mk("assistant", "b")]), 3);
  assert.equal(chainRootIndex([
    mk("user", "A"),
    mk("assistant", "a"),
    mk("user", `${FINISH_GATE_AUDIT_DIRECTIVE_PREFIX} x`, "message"),
    mk("assistant", "b"),
  ]), 1);
  assert.equal(chainRootIndex([mk("user", "A"), mk("user", "", "wake_notice"), mk("assistant", "b")]), 1);
  assert.equal(chainRootIndex([mk("assistant", "a"), mk("assistant", "b")]), 0);
});

test("stage 1.5 fires on an empty final answer, once per chain", async () => {
  const gate = await evaluatePostRunFinishGate({
    ...BASE_INPUT,
    skills: [],
    messages: [user("说点什么。"), assistant("")],
  });
  assert.equal(gate.verdict?.stage, "intervention");
  assert.ok(gate.verdict?.directive.startsWith(FINISH_GATE_INTERVENTION_DIRECTIVE_PREFIX));

  const second = await evaluatePostRunFinishGate({
    ...BASE_INPUT,
    skills: [],
    messages: [
      user("说点什么。"),
      assistant(""),
      user(gate.verdict!.directive),
      assistant(""),
    ],
  });
  // The intervention latch holds; with no audit skills and no quotes the
  // chain closes silently even though the model repeated the empty finish.
  assert.equal(second.verdict, undefined);
});

test("stage 1.5 fires on degenerate repetition across the chain", async () => {
  const repeated = "这份报告分析了候选路径并给出结论。";
  const gate = await evaluatePostRunFinishGate({
    ...BASE_INPUT,
    skills: [],
    messages: [
      user("继续。"),
      assistant(repeated),
      assistant(repeated),
      assistant(repeated),
    ],
  });
  assert.equal(gate.verdict?.stage, "intervention");
  assert.ok(gate.verdict?.directive.includes("three turns in a row"));
});

test("stage 1.5 surfaces unfinished research_state plan items", async () => {
  const gate = await evaluatePostRunFinishGate({
    ...BASE_INPUT,
    pendingPlanItems: async () => [{ id: "p1", text: "对照第三篇论文核实数据" }],
    skills: [],
    messages: [user("研究并总结。"), assistant("这是我的最终总结答案。")],
  });
  assert.equal(gate.verdict?.stage, "intervention");
  assert.ok(gate.verdict?.directive.includes("p1"));
});

test("stage 2 fires on unverified quotes and names the span", async () => {
  const quote = "the nucleocapsid protein assembles into helical structures with a pitch of thirty nanometers";
  const gate = await evaluatePostRunFinishGate({
    ...BASE_INPUT,
    quoteVerificationAvailable: true,
    skills: [],
    messages: [
      user("引用原文回答。"),
      assistant(`论文指出：“${quote}”，因此结论成立。`),
    ],
  });
  assert.equal(gate.verdict?.stage, "grounding");
  assert.ok(gate.verdict?.directive.startsWith(FINISH_GATE_GROUNDING_DIRECTIVE_PREFIX));
});

test("stage 2 accepts a verbatim verdict from an earlier run of the same chain", async () => {
  const quote = "the nucleocapsid protein assembles into helical structures with a pitch of thirty nanometers";
  const gate = await evaluatePostRunFinishGate({
    ...BASE_INPUT,
    quoteVerificationAvailable: true,
    skills: [],
    messages: [
      user("引用原文回答。"),
      // Run 1 verified the quote but the answer still shipped it unreviewed…
      assistant("中间稿。", [
        toolCallAssistant([{ args: { kbId: "kb1", quote }, id: "v1", name: "verify_citation" }]),
        toolResult("v1", "verify_citation", { state: "verbatim" }),
      ]),
      // …a grounding continuation ran, and run 2 quotes the verified span.
      user(`${FINISH_GATE_GROUNDING_DIRECTIVE_PREFIX} earlier draft`),
      assistant(`论文指出：“${quote}”，因此结论成立。`),
    ],
  });
  assert.equal(gate.verdict, undefined);
  assert.equal(gate.capped, false);
});

test("stage 2 escalates the directive when a grounding directive already exists", async () => {
  const quote = "the nucleocapsid protein assembles into helical structures with a pitch of thirty nanometers";
  const gate = await evaluatePostRunFinishGate({
    ...BASE_INPUT,
    quoteVerificationAvailable: true,
    skills: [],
    messages: [
      user("引用原文回答。"),
      assistant(`初稿引用了“${quote}”。`),
      user(`${FINISH_GATE_GROUNDING_DIRECTIVE_PREFIX} earlier draft`),
      assistant(`论文指出：“${quote}”，因此结论成立。`),
    ],
  });
  assert.equal(gate.verdict?.stage, "grounding");
  assert.ok(gate.verdict?.directive.includes("already flagged"));
});

test("stage 2 stays silent without quote-verification tooling in the run", async () => {
  const quote = "the nucleocapsid protein assembles into helical structures with a pitch of thirty nanometers";
  const gate = await evaluatePostRunFinishGate({
    ...BASE_INPUT,
    skills: [],
    messages: [user("引用原文回答。"), assistant(`论文指出：“${quote}”。`)],
  });
  assert.equal(gate.verdict, undefined);
});

test("wake notices and system kinds do not bound the chain", async () => {
  const gate = await evaluatePostRunFinishGate({
    ...BASE_INPUT,
    messages: [
      user("启动这项研究。"),
      assistant("第一轮完成。", [
        toolCallAssistant([{ args: { reason: "done" }, id: "c4", name: FINISH_GATE_REVIEW_TOOL }]),
        toolResult("c4", FINISH_GATE_REVIEW_TOOL, { recorded: true }),
      ]),
      user("", "wake_notice"),
      assistant("后台任务完成，无新发现。"),
    ],
  });
  // The wake run's segment reaches back across the wake notice, sees the
  // review checkpoint from the earlier run, and closes silently.
  assert.equal(gate.verdict, undefined);
});

test("a directive issued before the wake still counts against the cap", async () => {
  const grounding = `${FINISH_GATE_GROUNDING_DIRECTIVE_PREFIX} x`;
  const quote = "the nucleocapsid protein assembles into helical structures with a pitch of thirty nanometers";
  const gate = await evaluatePostRunFinishGate({
    ...BASE_INPUT,
    quoteVerificationAvailable: true,
    skills: [],
    messages: [
      user("引用原文回答。"),
      assistant("draft"),
      user(grounding),
      assistant("draft"),
      user("", "wake_notice"),
      assistant("draft"),
      user(grounding),
      assistant("draft"),
      user(grounding),
      assistant(`论文指出：“${quote}”。`),
    ],
  });
  assert.equal(gate.verdict, undefined);
  assert.equal(gate.capped, true);
});

test("no chain root (directive-only history) evaluates from the start", async () => {
  const gate = await evaluatePostRunFinishGate({
    ...BASE_INPUT,
    messages: [
      user(`${FINISH_GATE_AUDIT_DIRECTIVE_PREFIX} tree-search. …`),
      assistant("答案。"),
    ],
  });
  // One audit directive in the segment, no checkpoint: stage 1 latch holds,
  // nothing else fires.
  assert.equal(gate.verdict, undefined);
  assert.equal(gate.capped, false);
});

test("a session without audit skills or quotes closes silently", async () => {
  const gate = await evaluatePostRunFinishGate({
    ...BASE_INPUT,
    skills: [],
    messages: [user("你好。"), assistant("你好，有什么可以帮你？")],
  });
  assert.equal(gate.verdict, undefined);
  assert.equal(gate.capped, false);
});

test("a fresh user message starts a new chain with a fresh budget", async () => {
  const gate = await evaluatePostRunFinishGate({
    ...BASE_INPUT,
    messages: [
      user("第一个问题。"),
      assistant("回答一。"),
      user(`${FINISH_GATE_AUDIT_DIRECTIVE_PREFIX} tree-search. …`),
      assistant("审计完成。"),
      user(`${FINISH_GATE_GROUNDING_DIRECTIVE_PREFIX} x`),
      assistant("修稿。"),
      user(`${FINISH_GATE_INTERVENTION_DIRECTIVE_PREFIX} x`),
      assistant("收尾。"),
      // A new genuine question resets the chain: its audit duty is unmet.
      user("第二个问题。"),
      assistant("回答二，未审计。"),
    ],
  });
  assert.equal(gate.verdict?.stage, "audit");
  assert.equal(gate.capped, false);
});
