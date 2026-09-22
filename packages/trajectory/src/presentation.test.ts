// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { contentSections, internalEntry, recordGroups, timelineEnd, timelineRows, timelineScale, visibleKinds } from "./presentation.js";
import type { TrajectoryEntry, TrajectoryIndex, TrajectoryKind } from "./index.js";

const entry = (values: Partial<TrajectoryEntry> = {}): TrajectoryEntry => ({ id: "e", agentId: "main:s", kind: "lifecycle", label: "event", timestamp: null, ...values });
const sections = (kind: TrajectoryKind, value: unknown) => contentSections({ entry: entry({ kind }), value }, true);

test("hide every lifecycle and state category, but retain model and tool evidence", () => {
  assert.deepEqual(visibleKinds, ["input", "output", "thinking", "tool", "mcp"]);
  for (const agentId of ["main:s", "subagent:child"]) {
    for (const kind of ["state", "lifecycle"] as const) {
      for (const eventType of ["run.started", "run.completed", "run.failed", "run.cancelled", "context_recovery", "subagent.updated", "unknown"]) {
        assert.equal(internalEntry(entry({ agentId, kind, eventType })), true);
      }
    }
    for (const kind of ["input", "thinking", "tool", "mcp"] as const) {
      assert.equal(internalEntry(entry({ agentId, kind, status: "failed" })), false);
    }
  }
});

test("main and child trajectories show final responses only, keeping thinking", () => {
  for (const agentId of ["main:s", "subagent:child"]) {
    for (const eventType of ["assistant.delta", "subagent.step", "model_delta", "text_delta"]) {
      assert.equal(internalEntry(entry({ agentId, kind: "output", eventType })), true);
    }
    for (const id of ["event:response", "journal:response", "action:legacy:0"]) {
      assert.equal(internalEntry(entry({ id, agentId, kind: "output", eventType: "model.completed" })), false);
    }
    assert.equal(internalEntry(entry({ agentId, kind: "thinking", eventType: "model_delta" })), false);
    assert.equal(internalEntry(entry({ agentId, kind: "lifecycle", eventType: "run.failed" })), true);
    // No final response exists: a partial stream must still not look completed.
    assert.deepEqual([entry({ agentId, kind: "output", eventType: "assistant.delta" })].filter(e => !internalEntry(e)), []);
  }
});

test("timeline separates model and tools and packs overlapping intervals without moving timestamps", () => {
  const at = (n: number) => new Date(n).toISOString();
  const values = [
    entry({ id: "model", kind: "thinking", timestamp: at(0), endTime: at(100) }),
    entry({ id: "tool", kind: "tool", timestamp: at(0), endTime: at(100) }),
    entry({ id: "other-model", kind: "output", timestamp: at(50) }),
    entry({ id: "near-point", kind: "input", timestamp: at(51) }),
    entry({ id: "later", kind: "input", timestamp: at(101) }),
    entry({ id: "unknown-time", kind: "input", timestamp: null }),
  ];
  const rows = timelineRows(values);
  assert.deepEqual(rows.map(r => [r.category, r.entries.map(e => e.id)]), [
    ["model", ["model", "later"]], ["model", ["other-model", "near-point"]], ["tools", ["tool"]],
  ]);
  assert.equal(values[0]!.timestamp, at(0));
});

test("real overlap, touching ends and coincident points determine rows independently of drawing", () => {
  const at = (n: number) => new Date(n).toISOString();
  const values = [
    entry({ id: "a", kind: "tool", timestamp: at(0), endTime: at(100) }),
    entry({ id: "b", kind: "tool", timestamp: at(50), endTime: at(100) }),
    entry({ id: "c", kind: "tool", timestamp: at(100) }),
    entry({ id: "d", kind: "tool", timestamp: at(100) }),
    entry({ id: "e", kind: "tool", timestamp: at(101), endTime: "invalid" }),
    entry({ id: "f", kind: "tool", timestamp: at(102), endTime: at(90) }),
    entry({ id: "invalid", kind: "tool", timestamp: "invalid" }),
  ];
  const expected = [["a", "c", "e", "f"], ["b", "d"]];
  assert.deepEqual(timelineRows(values).map(row => row.entries.map(e => e.id)), expected);
  assert.deepEqual(timelineRows([...values].reverse()).map(row => row.entries.map(e => e.id)), expected);
  for (const width of [450, 900, 3600, 7200]) {
    const scale = timelineScale(values, width);
    assert.deepEqual(timelineRows(values).map(row => row.entries.map(e => e.id)), expected);
    for (const row of timelineRows(values)) {
      for (let i = 1; i < row.entries.length; i++) {
        const previous = row.entries[i - 1]!, current = row.entries[i]!;
        const previousLeft = scale.x(Date.parse(previous.timestamp!));
        const previousRight = previousLeft + Math.max(8, scale.x(timelineEnd(previous)) - previousLeft - 2);
        assert.ok(scale.x(Date.parse(current.timestamp!)) - previousRight >= 1.99);
      }
    }
  }
});

test("dense spacing uses a shared monotone clock across agents without changing recorded times", () => {
  const values = [0, 1, 2, 10000].map((n, i) => entry({ id: String(i), agentId: `agent-${i % 2}`, timestamp: new Date(n).toISOString() }));
  const original = structuredClone(values);
  for (const width of [450, 3600]) {
    const scale = timelineScale(values, width);
    assert.equal(scale.expanded, true);
    assert.ok(scale.width >= width);
    for (let i = 0; i < values.length; i++) {
      const time = Date.parse(values[i]!.timestamp!);
      assert.ok(Math.abs(scale.time(scale.x(time)) - time) < .001);
      assert.ok(scale.x(time) + 8 <= scale.width);
      if (i) assert.ok(scale.x(time) - scale.x(Date.parse(values[i - 1]!.timestamp!)) >= 10);
    }
  }
  assert.deepEqual(values, original);
  assert.equal(timelineScale([], 450).width, 450);
  assert.equal(timelineScale([values[0]!], 450).x(0), 0);
});

test("one heading per Agent Run; retries retain exact context identities and untimed input placement", () => {
  const index: TrajectoryIndex = { schemaVersion: 1, sessionId: "s", capturedAt: "now", agents: [], warnings: [], entries: [
    entry({ id: "output-a", contextId: "a", runId: "r1", turn: 0, timestamp: "2026-09-15T10:00:00Z" }),
    entry({ id: "output-b", contextId: "b", runId: "r1", turn: 0 }),
    entry({ id: "output-c", contextId: "c", runId: "r2", turn: 0 }),
  ], untimedEntries: [entry({ id: "input-a", kind: "input", contextId: "a", runId: "r1", turn: 0 })] };
  index.historicalEntries = index.untimedEntries;
  const groups = recordGroups(index);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0]!.entries.map(e => e.id), ["input-a", "output-a", "output-b"]);
  assert.deepEqual(groups[0]!.entries.map(e => e.contextId), ["a", "a", "b"]);
  assert.equal(groups[0]!.entries[0]!.timestamp, null);
  assert.equal(index.entries[0]!.id, "output-a");
});

test("thinking and model stream packets render only recorded text", () => {
  assert.equal(sections("thinking", { packets: [{ delta: "先分析" }, { event: { delta: "，再核实。" } }] })[0]!.value, "先分析，再核实。");
  assert.deepEqual(sections("thinking", {}), []);
  assert.equal(sections("output", { assistantMessage: { content: "<script>literal</script>" } })[0]!.value, "<script>literal</script>");
  assert.equal(sections("output", { result: { assistantMessage: { content: "结论" }, toolCalls: [{ name: "search" }] } }).length, 3);
});

test("lifecycle notifications without context no longer create one Agent heading per event", () => {
  const index: TrajectoryIndex = { schemaVersion: 1, sessionId: "s", capturedAt: "now", agents: [], warnings: [], entries: [
    ...["session.updated", "run.queued", "run.status", "run.started"].map(id => entry({ id, runId: "r1" })),
    entry({ id: "model", runId: "r1", contextId: "a" }), entry({ id: "child", agentId: "child", runId: "r1" }),
  ] };
  const groups = recordGroups(index);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]!.entries.length, 5);
  assert.equal(groups[1]!.agentId, "child");
});

test("usage comes from this model result, retains zero and never invents missing counts", () => {
  const usage = (value: unknown) => contentSections({ entry: entry({ kind: "output", eventType: "model.completed" }), value }, true).find(s => s.title === "本次请求用量")!.value;
  assert.deepEqual(usage({ usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28, cacheReadTokens: 0, cacheWriteTokens: null } }), { "输入 Token": 20, "输出 Token": 8, "总 Token": 28, "缓存读取 Token": 0 });
  assert.deepEqual(usage({ usage: { inputTokens: 7 } }), { "输入 Token": 7 });
  assert.equal(usage({}), "未记录");
  assert.deepEqual(usage({ result: { usage: { totalTokens: 9 } } }), { "总 Token": 9 });
});

test("tools parse arguments, retain invalid JSON and show results, MCP payloads and command output", () => {
  assert.deepEqual(sections("tool", { call: { name: "run_shell", args: { command: "printf actual" } } }).map(s => s.value), ["run_shell", { command: "printf actual" }]);
  const tool = sections("tool", { call: { name: "run_shell", arguments: '{"command":"printf ok"}' }, result: { message: { content: "ok" } } });
  assert.deepEqual(tool.map(s => s.value), ["run_shell", { command: "printf ok" }, "ok"]);
  assert.equal(sections("tool", { arguments: "invalid JSON" })[0]!.value, "invalid JSON");
  assert.equal(sections("tool", { type: "tool.output", packets: [{ chunk: "one" }, { chunk: "two" }] })[0]!.value, "onetwo");
  assert.deepEqual(sections("mcp", { payloads: { request: { arguments: { query: "protein" } }, rawResponse: { content: [{ text: "result" }] } } }).map(s => s.value), [{ query: "protein" }, [{ text: "result" }]]);
});

test("input and state summaries use frozen data, not an inferred current state", () => {
  assert.deepEqual(sections("input", { input: { systemPrompt: "rules", history: [{ role: "user", content: "question" }], tools: [] } }).map(s => s.value), ["rules", "question", []]);
  assert.deepEqual(sections("state", { phase: "completed", turn: 2, history: [], checkpoint: { components: [{ id: "plan", revision: "frozen", fidelity: "exact" }] } })[1]!.value, [{ id: "plan", revision: "frozen", fidelity: "exact" }]);
});
