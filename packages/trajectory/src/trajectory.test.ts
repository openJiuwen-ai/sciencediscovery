// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CasStore, RefStore, VersionStore } from "@sciencediscovery/cas";
import { contextBlocks, eventKind, redact } from "./index.js";
import { openSessionTrajectory, orderEvents, type RecordedEvent } from "./server.js";
import { readAgentJournal, type JournalEvent } from "./journal.js";
import { internalEntry } from "./presentation.js";

test("exact admitted system sections preserve order and separators, not rejected proposals", () => {
  const input = { systemPrompt: "rules\nscience", history: [{ role: "user", content: "question" }], tools: [{ name: "search" }] };
  const assembly = { trace: { used: "dynamic", admitted: { sections: [
    { id: "science", content: "science", contributorId: "skill", slot: "capabilities" },
    { id: "rules", content: "rules", contributorId: "governance", slot: "governance" },
  ] }, rendered: { sectionIds: ["rules", "science"] } } };
  const blocks = contextBlocks(input, assembly);
  assert.deepEqual(blocks.slice(0, 2).map(b => b.source), ["governance", "skill"]);
  assert.equal(blocks.slice(0, 2).map(b => b.content).join(""), input.systemPrompt);
  assert.equal(blocks[2]!.attribution, "unavailable");
  assert.equal(contextBlocks({ ...input, systemPrompt: "fallback" }, assembly)[0]!.attribution, "unavailable");
});
test("an external executor's whole prompt is one recorded section, still checked against what was sent", () => {
  // JiuwenSwarm assembles the prompt itself and reports it as the single section it is.
  const input = { systemPrompt: "assembled elsewhere", history: [{ role: "user", content: "question" }], tools: [] };
  const assembly = { trace: { selectedPath: "external", admitted: { sections: [
    { id: "jiuwenswarm-system", content: "assembled elsewhere", contributorId: "jiuwenswarm", slot: "system" },
  ] }, renderedContext: { sectionIds: ["jiuwenswarm-system"] } } };
  const [system] = contextBlocks(input, assembly);
  assert.equal(system!.attribution, "recorded");
  assert.equal(system!.source, "jiuwenswarm");
  assert.equal(system!.content, input.systemPrompt);
  // The equality is what earns "recorded": a section that is not what was sent falls back.
  assert.equal(contextBlocks({ ...input, systemPrompt: "something else" }, assembly)[0]!.attribution, "unavailable");
});
test("classification and structured credential redaction", () => {
  assert.equal(eventKind({ type: "model_delta", kind: "thinking" }), "thinking");
  assert.equal(eventKind({ type: "subagent.step", step: { kind: "tool" } }), "tool");
  assert.equal(eventKind({ type: "mcp.invocation" }), "mcp");
  assert.deepEqual(redact({ authorization: "secret", nested: [{ api_key: "secret", answer: "hello" }] }), { authorization: "[REDACTED]", nested: [{ api_key: "[REDACTED]", answer: "hello" }] });
});
test("failed attempts remain inspectable, scoped, immutable and self-contained in NDJSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "trajectory-"));
  const store = new VersionStore(directory), refs = await RefStore.open(store);
  const agentId = "main:session", trajectoryId = "attempt";
  try {
    const state = await store.putRecord("AgentStateSnapshot", { agentId, checkpoint: { revision: "frozen" } });
    const modelContext = await store.putRecord("ModelContextSnapshot", { input: { systemPrompt: "exact", history: [], tools: [] } });
    const assembly = await store.putRecord("ContextAssemblyRecord", { state, modelContext, turn: 0, capturedAt: "2026-09-14T10:00:00.000Z" });
    const start = await store.putRecord("TrajectoryStart", { state });
    await refs.commit(store, `agents/${encodeURIComponent(agentId)}/trajectories/${trajectoryId}`, null, start);
    await refs.commit(store, `attempts/${trajectoryId}/0`, null, assembly);
    const segment = await store.putRecord("EventSegment", { stream: agentId, events: [{ type: "model_delta", kind: "thinking", delta: "returned reasoning", recordedAt: "2026-09-14T10:00:01.000Z", contextRef: assembly }] });
    await refs.commit(store, `trajectory-events/${trajectoryId}/main`, null, segment);
    const view = await openSessionTrajectory(directory, { sessionId: "session", agents: [{ id: agentId, label: "Main" }], events: [
      { id: "foreign", agentId: "main:another-session", createdAt: "2026-09-14T10:00:00Z", runId: "r", event: { type: "assistant.delta", delta: "private" } },
    ] }, new AbortController().signal);
    assert.equal(view.index.entries.length, 1);
    assert.deepEqual(view.index.historicalEntries, []);
    const thinking = view.index.entries.find(e => e.kind === "thinking")!;
    assert.equal(thinking.timestamp, "2026-09-14T10:00:01.000Z");
    assert.deepEqual((await view.detail(thinking.id))!.context!.input, { systemPrompt: "exact", history: [], tools: [] });
    assert.equal(await view.detail(`context:sha256:${"0".repeat(64)}`), undefined);
    assert.equal(refs.head(`agents/${encodeURIComponent(agentId)}/head`), null);
    const lines: unknown[] = [];
    for await (const line of view.exportRecords()) lines.push(JSON.parse(line));
    assert.equal((lines.at(-1) as { type: string }).type, "complete");
    assert.equal(JSON.stringify(lines).includes("private"), false);
    const other = await openSessionTrajectory(directory, { sessionId: "other", agents: [{ id: "main:other", label: "Other" }], events: [] }, new AbortController().signal);
    assert.equal(other.index.entries.length, 0);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(openSessionTrajectory(directory, { sessionId: "session", agents: [{ id: agentId, label: "Main" }], events: [] }, controller.signal));
  } finally { refs.close(); await rm(directory, { recursive: true, force: true }); }
});

test("legacy committed ModelAction remains a final response without inventing a timestamp", async () => {
  const directory = await mkdtemp(join(tmpdir(), "trajectory-final-"));
  const store = new VersionStore(directory), refs = await RefStore.open(store), agentId = "main:s";
  try {
    const state = await store.putRecord("AgentStateSnapshot", { agentId });
    const modelContext = await store.putRecord("ModelContextSnapshot", { input: { systemPrompt: "exact", history: [], tools: [] } });
    const context = await store.putRecord("ContextAssemblyRecord", { state, modelContext, turn: 0 });
    const result = { assistantMessage: { content: "final answer" }, usage: { inputTokens: 7 } };
    const action = await store.putRecord("ModelAction", { modelContext, result });
    const step = await store.putRecord("TrajectoryStep", { agentId, trajectoryId: "r", turn: 0, context, before: state, after: state, actions: [action], eventSegments: [] });
    await refs.commit(store, `agents/${encodeURIComponent(agentId)}/head`, null, step);
    const view = await openSessionTrajectory(directory, { sessionId: "s", agents: [{ id: agentId, label: "Main" }], events: [] }, new AbortController().signal);
    const output = view.index.untimedEntries!.find(e => e.kind === "output")!;
    assert.equal(output.eventType, "model.completed");
    assert.equal(internalEntry(output), false);
    assert.equal(output.timestamp, null);
    assert.deepEqual((await view.detail(output.id))!.value, { modelContext, result });
  } finally { refs.close(); await rm(directory, { recursive: true, force: true }); }
});

test("historical timestamps remain unknown instead of a fabricated timeline position", async () => {
  const directory = await mkdtemp(join(tmpdir(), "trajectory-legacy-"));
  try {
    const view = await openSessionTrajectory(directory, { sessionId: "s", agents: [{ id: "main:s", label: "Main" }], events: [
      { id: "old", agentId: "main:s", createdAt: "", runId: "r", event: { type: "run.started" } },
    ] }, new AbortController().signal);
    assert.equal(view.index.entries.length, 0);
    assert.equal(view.index.historicalEntries![0]!.timestamp, null);
    assert.deepEqual(view.index.untimedEntries, view.index.historicalEntries);
    assert.ok(view.index.warnings.some(w => w.includes("timestamp")));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("journal entries own order, exact context and run identity without snapshot timeline duplicates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "trajectory-journal-"));
  const store = new VersionStore(directory);
  const agentId = "main:s", signal = new AbortController().signal;
  try {
    for (const runId of ["run-a", "run-b"]) {
      // Construct an old on-disk fixture; production has no journal writer.
      let pending = Promise.resolve(), sequence = 0;
      const journal = { append(fields: Partial<JournalEvent>, payload: unknown) {
        pending = pending.then(async () => {
          const payloadRef = await store.putRecord("TrajectoryEventPayload", payload);
          const folder = join(directory, "trajectories", Buffer.from(agentId).toString("base64url"));
          await mkdir(folder, { recursive: true });
          await appendFile(join(folder, `${Buffer.from(runId).toString("base64url")}.jsonl`), JSON.stringify({
            schemaVersion: 1, agentId, runId, requestExecutionId: runId, sequence: ++sequence,
            recordedAt: new Date().toISOString(), ...fields, payloadRef,
          }) + "\n");
        });
      }, flush: () => pending };
      const state = await store.putRecord("AgentStateSnapshot", { agentId, trajectoryId: runId, checkpoint: { revision: runId } });
      const modelContext = await store.putRecord("ModelContextSnapshot", { input: { systemPrompt: runId, history: [], tools: [] } });
      const context = await store.putRecord("ContextAssemblyRecord", { state, modelContext, turn: 0 });
      journal.append({ type: "context.captured", turn: 0, contextRef: context, stateRef: state }, { contextRef: context });
      journal.append({ type: "model.completed", turn: 0, contextRef: context }, { content: `output-${runId}` });
      journal.append({ type: "tool_execution_start", turn: 0, contextRef: context, callId: "reused" }, { call: { id: "reused", name: "run_shell" } });
      journal.append({ type: "tool_execution_end", turn: 0, contextRef: context, callId: "reused" }, { result: "done" });
      journal.append({ type: "state.committed", turn: 0, contextRef: context, stateRef: state }, { stateRef: state });
      await journal.flush();
    }
    const view = await openSessionTrajectory(directory, { sessionId: "s", agents: [{ id: agentId, label: "Main" }], events: [
      { id: "duplicate", agentId, runId: "run-a", createdAt: new Date().toISOString(), event: { type: "assistant.delta", delta: "output-run-a" } },
      ...["run-a", "run-b"].map(runId => ({ id: runId, agentId, runId, createdAt: new Date().toISOString(), event: { type: "mcp.invocation", toolCallId: "reused" } })),
    ] }, signal);
    assert.equal(view.index.entries.length, 12);
    assert.deepEqual(view.index.historicalEntries, []);
    for (const run of ["run-a", "run-b"]) {
      const entries = view.index.entries.filter(e => e.runId === run && e.streamId === "journal");
      assert.deepEqual(entries.map(e => e.sequence), [1, 2, 3, 4, 5]);
      assert.ok(entries.every(e => e.timestamp && e.turn === 0));
      assert.equal(entries[2]!.endTime, entries[3]!.timestamp);
      assert.equal((await view.detail(`event:${run}`))!.context!.blocks[0]!.content, run);
      assert.equal((await view.detail(entries[4]!.id))!.value && (await view.detail(entries[4]!.id))!.context!.blocks[0]!.content, run);
    }
    const lines: string[] = []; for await (const line of view.exportRecords()) lines.push(line);
    assert.equal(JSON.parse(lines.at(-1)!).entries, 12);
    const foreign = await openSessionTrajectory(directory, { sessionId: "other", agents: [{ id: "main:other", label: "Other" }], events: [] }, signal);
    assert.deepEqual(foreign.index.entries, []);
    // A concurrent append/crash must not turn an incomplete tail into an event.
    await appendFile(join(directory, "trajectories", Buffer.from(agentId).toString("base64url"), `${Buffer.from("run-b").toString("base64url")}.jsonl`), '{"sequence":6');
    const partial = await readAgentJournal(directory, agentId, signal);
    assert.equal(partial.events.length, 10);
    assert.ok(partial.warnings.some(w => w.includes("unfinished")));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("stream sequence wins over equal timestamps, hash IDs and backwards wall clock", () => {
  const entries = [
    { id: "hash-z", sequence: 1, timestamp: "2026-09-15T10:00:02.000Z" },
    { id: "hash-a", sequence: 2, timestamp: "2026-09-15T10:00:01.000Z" },
    { id: "hash-b", sequence: 3, timestamp: "2026-09-15T10:00:02.000Z" },
  ].map(e => ({ ...e, agentId: "main:s", runId: "r", streamId: "journal", kind: "state" as const, label: "state.committed" }));
  assert.deepEqual(orderEvents([entries[2]!, entries[0]!, entries[1]!]).map(e => e.sequence), [1, 2, 3]);
});

test("original Run events carry exact input, state, producer time and per-request usage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "trajectory-run-events-"));
  const store = new VersionStore(directory), agentId = "main:s";
  try {
    const stateRef = await store.putRecord("AgentStateSnapshot", { agentId, trajectoryId: "agent-run" });
    const modelContext = await store.putRecord("ModelContextSnapshot", { input: { systemPrompt: "rules", history: [{ role: "tool", content: "latest result" }], tools: [] } });
    const contextRef = await store.putRecord("ContextAssemblyRecord", { state: stateRef, modelContext, turn: 2 });
    const payloadRef = await store.putRecord("AgentEventPayload", { assistantMessage: { content: "answer" }, usage: { inputTokens: 7, outputTokens: 3 } });
    const evidence = { agentId, agentRunId: "agent-run", requestExecutionId: "r", turn: 2, contextRef, stateRef,
      recordedAt: "2026-09-15T10:00:00.000Z" };
    const events = [
      { type: "agent.record", name: "context.captured", evidence },
      { type: "assistant.thinking.delta", delta: "think", responseId: "response", evidence: { ...evidence, endedAt: "2026-09-15T10:00:01.000Z" } },
      { type: "agent.record", name: "model.completed", payloadRef, evidence: { ...evidence, responseId: "response" } },
    ].map((event, i) => ({ id: `${i}`, agentId, runId: "r", streamId: "main", sequence: i + 1,
      createdAt: "2026-09-15T10:00:09.000Z", event }));
    const view = await openSessionTrajectory(directory, { sessionId: "s", agents: [{ id: agentId, label: "Main" }], events }, new AbortController().signal);
    assert.equal(view.index.entries.length, 3);
    assert.deepEqual(view.index.historicalEntries, []);
    assert.ok(view.index.entries.every(e => e.streamId === "main" && e.runId === "agent-run" && e.turn === 2 && e.timestamp === evidence.recordedAt));
    assert.equal(view.index.entries[1]!.endTime, "2026-09-15T10:00:01.000Z");
    const detail = (await view.detail("event:2"))!;
    assert.equal((detail.value as { usage: { inputTokens: number } }).usage.inputTokens, 7);
    assert.equal(JSON.stringify(detail.context!.input).includes("latest result"), true);
    const exported: string[] = []; for await (const line of view.exportRecords()) exported.push(line);
    assert.equal(JSON.parse(exported.at(-1)!).entries, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("legacy EventSegment and original thinking are one entry only with exact identity and content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "trajectory-duplicates-"));
  const store = new VersionStore(directory), refs = await RefStore.open(store), agentId = "main:s";
  try {
    const state = await store.putRecord("AgentStateSnapshot", { agentId });
    const modelContext = await store.putRecord("ModelContextSnapshot", { input: { systemPrompt: "exact", history: [], tools: [] } });
    const contextRef = await store.putRecord("ContextAssemblyRecord", { state, modelContext, turn: 0 });
    const start = await store.putRecord("TrajectoryStart", { state });
    await refs.commit(store, `agents/${encodeURIComponent(agentId)}/trajectories/r`, null, start);
    const events = [{ type: "model_delta", kind: "thinking", responseId: "same", delta: "same content", contextRef, recordedAt: "2026-09-15T02:10:37.558Z" }];
    const segment = await store.putRecord("EventSegment", { events });
    await refs.commit(store, "trajectory-events/r/main", null, segment);
    const source = { sessionId: "s", agents: [{ id: agentId, label: "Main" }], events: ["same", "different"].map(responseId => ({
      id: responseId, agentId, runId: "r", createdAt: "2026-09-15T02:10:37.559Z", event: { type: "assistant.thinking.delta", responseId, delta: "same content" },
    })) };
    const view = await openSessionTrajectory(directory, source, new AbortController().signal);
    assert.equal(view.index.entries.length, 2, "another response with equal text is not a duplicate");
    assert.ok(view.index.entries.every(e => e.id.startsWith("event:") && e.runId === "r"));
    assert.ok((await view.detail("event:same"))!.context);
    source.events[0]!.event.delta = "partial";
    const partial = await openSessionTrajectory(directory, source, new AbortController().signal);
    assert.equal(partial.index.entries.length, 3, "unequal content must not be silently discarded");
  } finally { refs.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const child of [false, true]) test(`legacy parallel ${child ? "child" : "main"} tools reuse Run records without merging distinct executions`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "trajectory-tool-duplicates-"));
  const store = new VersionStore(directory), refs = await RefStore.open(store);
  const agentId = child ? "subagent:child" : "main:s", runId = "request", trajectoryId = "agent-run";
  try {
    const agentRevision = await store.putRecord("AgentRevision", { agentId, requestExecutionId: runId });
    const state = await store.putRecord("AgentStateSnapshot", { agentId, trajectoryId, agentRevision });
    const modelContext = await store.putRecord("ModelContextSnapshot", { input: { systemPrompt: "exact", history: [], tools: [] } });
    const contextRef = await store.putRecord("ContextAssemblyRecord", { state, modelContext, turn: 0 });
    const start = await store.putRecord("TrajectoryStart", { state });
    await refs.commit(store, `agents/${encodeURIComponent(agentId)}/trajectories/${trajectoryId}`, null, start);
    const source: RecordedEvent[] = [];
    for (const id of ["python", "shell"]) {
      const call = { id, name: "task", args: { description: id } };
      const events = [
        { type: "tool_execution_start", call, contextRef, recordedAt: "2026-09-15T02:10:46.019Z" },
        { type: "tool_execution_end", call, contextRef, recordedAt: "2026-09-15T02:16:06.880Z", content: `result-${id}`, isError: id === "shell" },
      ];
      const segment = await store.putRecord("EventSegment", { events });
      await refs.commit(store, `trajectory-events/${trajectoryId}/${id}`, null, segment);
      for (const [n, event] of [
        { type: "tool.started", trace: { ...call, status: "running" } },
        { type: "tool.output", toolCallId: id, chunk: `result-${id}` },
        { type: "tool.completed", trace: { id, name: "task", status: id === "shell" ? "failed" : "completed", outputStream: `tool-${id}` } },
      ].entries()) source.push({ id: `${id}-${n}`, agentId, runId, sequence: source.length + 1,
        createdAt: n === 0 ? "2026-09-15T02:10:46.027Z" : "2026-09-15T02:16:06.887Z",
        event: child && n !== 1 ? { type: "subagent.step", step: { kind: "tool", toolCallId: id, toolName: "task", args: call.args,
          status: n === 0 ? "running" : id === "shell" ? "failed" : "completed", content: n === 0 ? "input" : `result-${id}` } } : event });
    }
    const open = (events = source) => openSessionTrajectory(directory, { sessionId: "s", agents: [{ id: agentId, label: "Main" }], events }, new AbortController().signal);
    const view = await open();
    assert.equal(view.index.entries.filter(e => e.eventType === "tool.started").length, 2);
    assert.equal(view.index.entries.filter(e => e.id.startsWith("segment:")).length, 0);
    assert.equal(view.index.entries.filter(e => e.endTime).length, 4); // Two tool intervals and two output packets.
    for (const id of ["python", "shell"]) for (const n of [0, 2]) {
      const detail = (await view.detail(`event:${id}-${n}`))!;
      assert.equal(detail.entry.contextId, `context:${contextRef.digest}`);
      assert.ok(detail.context);
      const value = detail.value as { trace?: { args: unknown }; step?: { args: unknown } };
      assert.deepEqual(value.trace?.args ?? value.step?.args, { description: id });
    }
    const exported: string[] = []; for await (const line of view.exportRecords()) exported.push(line);
    assert.equal(JSON.parse(exported.at(-1)!).entries, 6);
    const foreign = await open(source.map(e => ({ ...e, runId: "other-request" })));
    assert.equal(foreign.index.entries.filter(e => e.id.startsWith("segment:")).length, 4, "reused IDs in another execution must remain distinct");
    const changed = structuredClone(source);
    const changedValue = changed[0]!.event as { trace?: { args: unknown }; step?: { args: unknown } };
    (changedValue.trace ?? changedValue.step)!.args = { description: "different" };
    assert.equal((await open(changed)).index.entries.filter(e => e.id.startsWith("segment:")).length, 2, "different inputs cannot suppress either boundary");
    const partial = structuredClone(source);
    if (child) (partial[2]!.event as { step: { content: string } }).step.content = "truncated";
    else (partial[1]!.event as { chunk: string }).chunk = "truncated";
    assert.equal((await open(partial)).index.entries.filter(e => e.id.startsWith("segment:")).length, 1, "incomplete output keeps the complete legacy result");
    assert.equal((await open([...source, { ...source[0]!, id: "repeated-call" }])).index.entries.filter(e => e.id.startsWith("segment:")).length, 2, "ambiguous repeated IDs are not merged");
    const missingArgs = structuredClone(source);
    for (const e of missingArgs) {
      const value = e.event as { trace?: { args?: unknown }; step?: { args?: unknown } };
      if (value.trace) delete value.trace.args;
      if (value.step) delete value.step.args;
    }
    const enriched = await open(missingArgs);
    assert.equal(enriched.index.entries.filter(e => e.id.startsWith("segment:")).length, 0, "unique scoped calls can inherit missing full arguments from legacy evidence");
    const enrichedDetail = (await enriched.detail("event:python-0"))!.value as { trace?: { args: unknown }; step?: { args: unknown } };
    assert.deepEqual(enrichedDetail.trace?.args ?? enrichedDetail.step?.args, { description: "python" });
  } finally { refs.close(); await rm(directory, { recursive: true, force: true }); }
});

test("MCP audit detail resolves owned payloads and redacts credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "trajectory-mcp-"));
  try {
    const cas = new CasStore(directory);
    const request = await cas.put(JSON.stringify({ arguments: { query: "protein" }, authorization: "private-token" }));
    const rawResponse = await cas.put(JSON.stringify({ content: [{ text: "observed result" }] }));
    const view = await openSessionTrajectory(directory, { sessionId: "s", agents: [{ id: "main:s", label: "Main" }], events: [
      { id: "audit", agentId: "main:s", createdAt: "2026-09-14T10:00:00Z", runId: "r", event: { type: "mcp.invocation", request, rawResponse } },
    ] }, new AbortController().signal);
    const detail = await view.detail("event:audit");
    assert.match(JSON.stringify(detail), /observed result/);
    assert.match(JSON.stringify(detail), /protein/);
    assert.doesNotMatch(JSON.stringify(detail), /private-token/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
