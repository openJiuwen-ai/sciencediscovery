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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentMemoryEntry } from "@sciencediscovery/schema";

import { SessionStore } from "../store.js";
import {
  BackgroundReviewManager,
  gateExtractedNotes,
  transcriptTail,
} from "./background-review.js";

async function setupStore(prefix: string, context: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  context.after(() => rm(dir, { force: true, recursive: true }));
  const store = new SessionStore(dir);
  store.setAvailableSkillIds([]);
  await store.load();
  return store;
}

test("agent memory add dedupes on (category, content); list filters by status", async (context) => {
  const store = await setupStore("sd-agent-mem-add-", context);
  const entry = store.addAgentMemory({
    category: "tool_technique",
    content: "kb_search 先宽后窄，第二跳用相对分级截尾",
    source: "agent_tool",
    provenance: { kind: "agent_proposal", requiresReview: true, actorId: "s1" },
  });
  assert.ok(entry);
  assert.equal(entry!.status, "active");
  assert.equal(entry!.confidence, 0.7);
  assert.equal(entry!.provenance?.requiresReview, true);
  // Exact duplicate is a no-op.
  assert.equal(store.addAgentMemory({ category: "tool_technique", content: "kb_search 先宽后窄，第二跳用相对分级截尾", source: "agent_tool" }), null);
  // Same content in another category is a distinct entry.
  assert.ok(store.addAgentMemory({ category: "workflow", content: "kb_search 先宽后窄，第二跳用相对分级截尾", source: "agent_tool" }));
  assert.equal(store.listAgentMemories({ status: "active" }).length, 2);
  assert.equal(store.listAgentMemories({ category: "workflow" }).length, 1);
});

test("promote clears requiresReview and lifts confidence into the verified band", async (context) => {
  const store = await setupStore("sd-agent-mem-promote-", context);
  const entry = store.addAgentMemory({
    category: "lesson_learned",
    content: "长报告先出大纲再分章写，避免上下文漂移",
    source: "background_review",
    provenance: { kind: "background_review", requiresReview: true, source: "s1" },
  })!;
  const promoted = store.promoteAgentMemory(entry.id);
  assert.equal(promoted.provenance?.requiresReview, false);
  assert.equal(promoted.confidence, 0.8);
  assert.ok(promoted.reviewedAt);
  assert.equal(promoted.provenance?.kind, "background_review"); // origin preserved
});

test("replace resets verification; supersede archives the old entry atomically", async (context) => {
  const store = await setupStore("sd-agent-mem-supersede-", context);
  const entry = store.addAgentMemory({
    category: "convention",
    content: "项目报告一律中英双语标题",
    source: "agent_tool",
    provenance: { kind: "agent_proposal", requiresReview: true },
  })!;
  store.promoteAgentMemory(entry.id);

  const replaced = store.replaceAgentMemoryContent(entry.id, "项目报告一律中英双语标题与摘要", {
    kind: "agent_proposal",
    requiresReview: true,
    actorId: "s2",
  });
  assert.equal(replaced.provenance?.requiresReview, true, "an edited memory loses its verified label");
  assert.equal(replaced.reviewedAt, null);

  const promoted = store.promoteAgentMemory(entry.id);
  const next = store.supersedeAgentMemory(promoted.id, {
    content: "项目报告标题中英双语，摘要中文即可",
    provenance: { kind: "manual", requiresReview: false },
  });
  assert.equal(next.supersedesId, promoted.id);
  assert.equal(next.status, "active");
  assert.equal(store.getAgentMemory(promoted.id)!.status, "archived");

  // Conflicting replacement rolls back: the old entry stays active.
  const other = store.addAgentMemory({ category: "convention", content: "已有条目", source: "agent_tool" })!;
  assert.throws(
    () => store.supersedeAgentMemory(other.id, { content: next.content, provenance: { kind: "manual" } }),
    /conflicts/,
  );
  assert.equal(store.getAgentMemory(other.id)!.status, "active");
});

test("listDiverseAgentMemories picks each category's top entry before filling", async (context) => {
  const store = await setupStore("sd-agent-mem-diverse-", context);
  const reviewed = { kind: "manual" as const, requiresReview: false };
  for (let index = 0; index < 5; index += 1) {
    store.addAgentMemory({ category: "workflow", content: `workflow note ${index}`, source: "t", relevance: 9 - index, provenance: reviewed });
  }
  store.addAgentMemory({ category: "convention", content: "convention note", source: "t", relevance: 1, provenance: reviewed });
  store.addAgentMemory({ category: "lesson_learned", content: "unreviewed candidate", source: "t", relevance: 10, provenance: { kind: "agent_proposal", requiresReview: true } });

  const diverse = store.listDiverseAgentMemories(3);
  // reviewedOnly default: the high-scoring unreviewed candidate is excluded.
  assert.ok(diverse.every((entry) => entry.provenance?.requiresReview !== true));
  // First two slots cover both categories despite workflow dominating the scores.
  const categories = new Set(diverse.slice(0, 2).map((entry) => entry.category));
  assert.deepEqual(categories, new Set(["workflow", "convention"]));
  assert.equal(diverse.length, 3);

  const withCandidates = store.listDiverseAgentMemories(10, { reviewedOnly: false });
  assert.ok(withCandidates.some((entry) => entry.provenance?.requiresReview === true));
});

test("stale/remove/meta round out the lifecycle", async (context) => {
  const store = await setupStore("sd-agent-mem-life-", context);
  const entry = store.addAgentMemory({ category: "workflow", content: "先检索后综合", source: "t" })!;
  assert.equal(store.markAgentMemoryStale(entry.id).status, "stale");
  store.removeAgentMemory(entry.id);
  assert.equal(store.getAgentMemory(entry.id), null);

  assert.equal(store.getAgentMemoryMeta("k"), null);
  store.setAgentMemoryMeta("k", { runsSinceLastReview: 3 });
  assert.deepEqual(store.getAgentMemoryMeta("k"), { runsSinceLastReview: 3 });
  store.setAgentMemoryMeta("k", { runsSinceLastReview: 4 });
  assert.deepEqual(store.getAgentMemoryMeta("k"), { runsSinceLastReview: 4 });
});

// ------------------------------------------------------------ review manager

interface FakeStoreCalls {
  added: Array<{ category: string; content: string }>;
  meta: Map<string, unknown>;
  messages: Array<{ content: string; role: string }>;
}

function fakeStore(calls: FakeStoreCalls): SessionStore {
  return {
    addAgentMemory: (input: { category: string; content: string }) => {
      calls.added.push(input);
      return { id: `m${calls.added.length}` } as AgentMemoryEntry;
    },
    getAgentMemoryMeta: (id: string) => calls.meta.get(id) ?? null,
    readMessages: async () => calls.messages,
    setAgentMemoryMeta: (id: string, value: unknown) => {
      calls.meta.set(id, value);
    },
  } as unknown as SessionStore;
}

const ENDPOINT = { baseUrl: "http://model", model: "test-model" };

test("background review fires on cadence and writes gated candidates", async () => {
  const calls: FakeStoreCalls = {
    added: [],
    meta: new Map(),
    messages: [
      { content: "帮我调研 IL-6 抑制剂", role: "user" },
      { content: "先用 kb_search 宽检索，再按相对分级截尾，效果好", role: "assistant" },
    ],
  };
  let invocations = 0;
  const manager = new BackgroundReviewManager({
    enabled: () => true,
    invoke: async () => {
      invocations += 1;
      return '{"notes":[{"category":"tool_technique","content":"kb_search 宽检索后接相对分级截尾"}]}';
    },
    nudgeInterval: 2,
    resolveEndpoint: () => ENDPOINT,
    store: fakeStore(calls),
  });
  manager.recordCompletedRun("s1");
  assert.equal(invocations, 0, "first completion only counts");
  manager.recordCompletedRun("s1");
  await (manager as unknown as { inFlight: Promise<void> }).inFlight;
  assert.equal(invocations, 1);
  assert.equal(calls.added.length, 1);
  assert.equal(calls.added[0]!.category, "tool_technique");

  // Counter drained before the run — the next review needs two more completions.
  manager.recordCompletedRun("s1");
  await Promise.resolve();
  assert.equal(invocations, 1);
});

test("background review backs off after empty reviews and stays off when gated", async () => {
  const calls: FakeStoreCalls = {
    added: [],
    meta: new Map(),
    messages: [{ content: "hello", role: "user" }],
  };
  let invocations = 0;
  const manager = new BackgroundReviewManager({
    enabled: () => true,
    invoke: async () => {
      invocations += 1;
      return '{"notes":[]}';
    },
    nudgeInterval: 1,
    resolveEndpoint: () => ENDPOINT,
    store: fakeStore(calls),
  });
  manager.recordCompletedRun("s1");
  await (manager as unknown as { inFlight: Promise<void> }).inFlight;
  assert.equal(invocations, 1);
  let state = calls.meta.get("background_review_state") as { consecutiveEmpty: number };
  assert.equal(state.consecutiveEmpty, 1);
  // Backoff ×2: one more completion is not enough for the next review.
  manager.recordCompletedRun("s1");
  await Promise.resolve();
  assert.equal(invocations, 1);
  manager.recordCompletedRun("s1");
  await (manager as unknown as { inFlight: Promise<void> }).inFlight;
  assert.equal(invocations, 2);

  // Gated off: completions count but never fire.
  const gatedCalls: FakeStoreCalls = { added: [], meta: new Map(), messages: [{ content: "x", role: "user" }] };
  const gated = new BackgroundReviewManager({
    enabled: () => false,
    invoke: async () => {
      throw new Error("must not fire");
    },
    nudgeInterval: 1,
    resolveEndpoint: () => ENDPOINT,
    store: fakeStore(gatedCalls),
  });
  gated.recordCompletedRun("s1");
  await Promise.resolve();
  assert.equal(gatedCalls.added.length, 0);
});

test("background review fails open: LLM errors consume the slot without counting empty", async () => {
  const calls: FakeStoreCalls = {
    added: [],
    meta: new Map(),
    messages: [{ content: "hi", role: "user" }],
  };
  const logged: string[] = [];
  const manager = new BackgroundReviewManager({
    enabled: () => true,
    invoke: async () => {
      throw new Error("model down");
    },
    log: (event) => logged.push(event),
    nudgeInterval: 1,
    resolveEndpoint: () => ENDPOINT,
    store: fakeStore(calls),
  });
  manager.recordCompletedRun("s1");
  await (manager as unknown as { inFlight: Promise<void> }).inFlight;
  assert.deepEqual(logged, ["background_review_failed"]);
  const state = calls.meta.get("background_review_state") as { consecutiveEmpty: number; runsSinceLastReview: number };
  assert.equal(state.consecutiveEmpty, 0);
  assert.equal(state.runsSinceLastReview, 0, "threshold consumed");
});

test("gateExtractedNotes drops placeholders, short notes and bad categories", () => {
  const gated = gateExtractedNotes({
    notes: [
      { category: "workflow", content: "先检索后综合，不要边检索边写" },
      { category: "workflow", content: "短" },
      { category: "workflow", content: "信息不足，无法提取" },
      { category: "not-a-category", content: "类别非法的条目应被丢弃" },
      "not-an-object",
    ],
  });
  assert.deepEqual(gated, [{ category: "workflow", content: "先检索后综合，不要边检索边写" }]);
  assert.equal(gateExtractedNotes({}).length, 0, "missing notes yields empty");
});

test("transcriptTail keeps the tail within budget and skips empty content", () => {
  const tail = transcriptTail(
    [
      { content: "u1", role: "user" },
      { content: "", role: "assistant" },
      { content: "a1", role: "assistant" },
    ],
    100,
  );
  assert.equal(tail, "[user] u1\n[assistant] a1");
  const long = transcriptTail([{ content: "x".repeat(500), role: "user" }], 100);
  assert.equal(long.length, 100);
});

test("reviewedOnly is fail-CLOSED: a null provenance never reaches the prompt pool", async (context) => {
  const store = await setupStore("sd-agent-mem-closed-", context);
  // Legacy/manual rows without provenance metadata must NOT pass the review
  // gate — only an explicit requiresReview:false may.
  store.addAgentMemory({ category: "workflow", content: "no provenance row", source: "t", provenance: null });
  store.addAgentMemory({ category: "workflow", content: "reviewed row", source: "t", provenance: { kind: "manual", requiresReview: false } });
  const pool = store.listDiverseAgentMemories(10);
  assert.deepEqual(pool.map((entry) => entry.content), ["reviewed row"]);
  const all = store.listDiverseAgentMemories(10, { reviewedOnly: false });
  assert.equal(all.length, 2);
});

test("promoting an archived (superseded) entry is rejected", async (context) => {
  const store = await setupStore("sd-agent-mem-archpromote-", context);
  const entry = store.addAgentMemory({ category: "convention", content: "旧规则", source: "t" })!;
  store.supersedeAgentMemory(entry.id, { content: "新规则", provenance: { kind: "manual", requiresReview: false } });
  assert.throws(() => store.promoteAgentMemory(entry.id), /archived/);
});
