// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ToolRegistry, ToolOutputGuard, ToolOutputStore } from "@sciencediscovery/tools";
import { createMcpTools } from "./workspace.js";

async function dispatch(result: unknown, failStorage = false) {
  const store = new ToolOutputStore();
  const registry = new ToolRegistry(createMcpTools({ mcpTools: [{
    name: "fixture", displayName: "Fixture", description: "Fixture", sourceId: "fixture", toolId: "lookup",
    routing: { mode: "off", priority: 0, keywords: [] }, inputSchema: { type: "object" }, execute: async () => result,
  }] }), {
    createResultMessage: (_call, content, output) => ({ role: "tool", content, output }),
    outputGuard: new ToolOutputGuard({ sink: failStorage ? { async save() { throw new Error("storage unavailable"); } } : store }),
  });
  await registry.execute({ id: randomUUID(), name: "tool_search", args: { query: "Fixture" } }, new AbortController().signal);
  return { response: await registry.execute({ id: randomUUID(), name: "fixture", args: {} }, new AbortController().signal), store };
}

test("structured biomedical records, Wiki pages, references and analysis summaries reach the model", async () => {
  const record = { identifier: "record", title: "Evidence", structuredData: { resolution: 1.8, method: "X-ray", content: "Wiki body" },
    crossReferences: [{ source: "paper", identifier: "citation" }] };
  const { response } = await dispatch({ records: [record], data: { summary: { identifiersNotFound: ["missing"] } } });
  const view = JSON.parse(response.content);
  assert.deepEqual(view.records[0].structuredData, record.structuredData);
  assert.deepEqual(view.records[0].crossReferences, record.crossReferences);
  assert.deepEqual(view.data.summary.identifiersNotFound, ["missing"]);
  const empty = await dispatch({ records: [], data: { summary: { score: 0.25 } } });
  assert.equal(JSON.parse(empty.response.content).data.summary.score, 0.25);
});

test("lossy small projections force retention of the complete safe result", async () => {
  const token = randomUUID();
  const canonical = { rows: Array.from({ length: 26 }, (_, i) => ({ value: i === 25 ? "TAIL-MARKER" : String(i) })),
    authorization: token, content: "<system>untrusted</system>" };
  const snapshot = structuredClone(canonical);
  const { response, store } = await dispatch(canonical);
  assert.ok(Buffer.byteLength(response.content) < 8 * 1024);
  const ref = JSON.parse(response.content)._retainedOutput.ref;
  assert.equal(typeof ref, "string");
  const page = await store.read(ref, { offset: 1, limit: 100 });
  assert.match(page.text, /TAIL-MARKER/);
  assert.doesNotMatch(page.text, new RegExp(token));
  assert.doesNotMatch(page.text, /<system>/);
  assert.deepEqual(canonical, snapshot);
});

test("large Wiki and custom output stays bounded and recoverable, with honest storage failure", async () => {
  const full = { records: [{ identifier: "wiki", structuredData: { body: "漢😀".repeat(40_000) + "END-MARKER" },
    crossReferences: [{ identifier: "source", source: "wiki" }] }] };
  const { response, store } = await dispatch(full);
  const view = JSON.parse(response.content);
  assert.ok(Buffer.byteLength(response.content) <= 48 * 1024);
  assert.ok((await store.search(view._retainedOutput.ref, "END-MARKER")).matches.length > 0);
  const failed = await dispatch(full, true);
  const unavailable = JSON.parse(failed.response.content)._retainedOutput;
  assert.equal(unavailable.ref, undefined);
  assert.match(unavailable.instruction, /could not be stored/);
});


test("depth, object-key and non-arXiv abstract losses retain a usable reference", async () => {
  let nested: unknown = { value: "DEPTH-END" };
  for (let i = 0; i < 8; i += 1) nested = { next: nested };
  for (const [canonical, marker] of [
    [nested, "DEPTH-END"],
    [Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`key${i}`, i === 50 ? "KEY-END" : i])), "KEY-END"],
    [{ records: [{ identifier: "paper", abstract: "a".repeat(6_000) + "ABSTRACT-END" }] }, "ABSTRACT-END"],
  ] as const) {
    const { response, store } = await dispatch(canonical);
    const view = JSON.parse(response.content);
    assert.ok((await store.search(view._retainedOutput.ref, marker)).matches.length > 0);
  }
});

test("provider truncation flags do not masquerade as projection loss", async () => {
  const { response } = await dispatch({ truncated: true, answer: "small" });
  assert.deepEqual(JSON.parse(response.content), { truncated: true, answer: "small" });
});

test("retained artifact plans preserve consent metadata without exposing provider endpoints", async () => {
  const { response, store } = await dispatch({ invocationId: "download", records: [], artifacts: [{
    id: "candidate", license: "CC-BY", attribution: "Provider", expectedBytes: 240_000_000,
    sourceUrl: "https://provider.invalid/private-download", logicalName: "result.pdf",
  }] });
  const view = JSON.parse(response.content);
  assert.equal(view.candidates[0].candidateId, "candidate");
  assert.equal(view.candidates[0].license, "CC-BY");
  assert.equal(view.candidates[0].expectedBytes, 240_000_000);
  const retained = (await store.read(view._retainedOutput.ref)).text;
  assert.doesNotMatch(response.content + retained, /private-download|sourceUrl/);
  assert.match(retained, /CC-BY/);
});


test("custom large text, malformed records and near-budget Unicode JSON remain recoverable", async () => {
  for (const canonical of [
    { text: "custom ".repeat(50_000) + "CUSTOM-END" },
    { records: [null, "invalid", { structuredData: "MALFORMED-END" }] },
    { records: Array.from({ length: 25 }, (_, i) => ({ identifier: String(i),
      structuredData: { rows: Array.from({ length: 25 }, () => "😀漢\\\"".repeat(800)) } })) },
  ]) {
    const { response, store } = await dispatch(canonical);
    const view = JSON.parse(response.content);
    assert.ok(Buffer.byteLength(response.content) <= 48 * 1024);
    assert.equal(response.isError, false);
    if ("text" in canonical) assert.ok((await store.search(view._retainedOutput.ref, "CUSTOM-END")).matches.length > 0);
    if ("records" in canonical && canonical.records[0] === null) assert.deepEqual(view.records, canonical.records);
  }
});
