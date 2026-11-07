// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ToolRegistry, ToolOutputGuard, ToolOutputStore } from "@sciencediscovery/tools";
import { createMcpTools } from "./workspace.js";

async function dispatch(result: unknown, failStorage = false, sourceId = "fixture", toolId = "lookup") {
  const store = new ToolOutputStore();
  const registry = new ToolRegistry(createMcpTools({ mcpTools: [{
    name: "fixture", displayName: "Fixture", description: "Fixture", sourceId, toolId,
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

test("oversized record payloads preserve identity and warnings with actionable recovery", async () => {
  const large = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
    `section${index}`, "漢😀".repeat(1_200) + "EVIDENCE-END",
  ]));
  for (const payload of [
    { structuredData: large },
    { crossReferences: Object.values(large) },
    { structuredData: large, crossReferences: Object.values(large) },
  ]) {
    const record = { identifier: "4HHB", title: "Hemoglobin", year: "1984",
      url: "https://www.rcsb.org/structure/4HHB", warnings: ["Verify source"], ...payload };
    const canonical = { records: [record] };
    const snapshot = structuredClone(canonical);
    for (const failStorage of [false, true]) {
      const { response, store } = await dispatch(canonical, failStorage);
      const view = JSON.parse(response.content);
      assert.equal(response.isError, false);
      assert.ok(Buffer.byteLength(response.content) <= 48 * 1024);
      assert.equal(view.records.length, 1);
      assert.equal(view.records[0].id, record.identifier);
      assert.equal(view.records[0].title, record.title);
      assert.equal(view.records[0].year, record.year);
      assert.equal(view.records[0].url, record.url);
      assert.deepEqual(view.warnings, record.warnings);
      assert.equal(view.truncated, true);
      assert.match(view.instruction, /_retainedOutput/);
      assert.doesNotMatch(view.instruction, /lower.*limit|refine/i);
      for (const key of Object.keys(payload)) {
        assert.deepEqual(view.records[0][key], { truncated: true, reason: "maximum size reached" });
      }
      if (failStorage) {
        assert.equal(view._retainedOutput.ref, undefined);
        assert.match(view._retainedOutput.instruction, /could not be stored/);
      } else {
        assert.ok((await store.search(view._retainedOutput.ref, "EVIDENCE-END")).matches.length > 0);
      }
      assert.deepEqual(canonical, snapshot);
    }
  }
});

test("literature searches shed duplicated provider payload before abstract text", async () => {
  const abstract = "A".repeat(3_000);
  const providerPayload = (index: number) => Object.fromEntries(Array.from({ length: 6 }, (_, key) => [
    `field${key}`, `${index}:${"P".repeat(996)}`,
  ]));
  const canonical = { records: Array.from({ length: 8 }, (_, index) => ({
    abstract,
    contentScope: "abstract",
    identifier: `PMC${100 + index}`,
    peerReviewStatus: "peer-reviewed",
    primaryCitation: { identifier: `PMC${100 + index}`, source: "europe-pmc",
      markdown: `[Europe PMC:PMC${100 + index}](https://europepmc.org/article/PMC/${100 + index})` },
    structuredData: providerPayload(index),
    title: `Literature result ${index}`,
  })) };
  const snapshot = structuredClone(canonical);
  const { response, store } = await dispatch(canonical, false, "europe-pmc", "search");
  const view = JSON.parse(response.content);
  assert.ok(Buffer.byteLength(response.content) <= 48 * 1024);
  assert.equal(view.records.length, 8);
  for (const record of view.records) {
    assert.equal(record.abstract, abstract);
    assert.equal(record.abstractTruncated, undefined);
    assert.match(record.title, /^Literature result /);
    assert.match(record.citation, /Europe PMC:PMC/);
  }
  assert.ok(view.records.some((record: { structuredData?: { truncated?: boolean } }) => record.structuredData?.truncated === true));
  assert.equal(view.truncated, true);
  assert.match(view.instruction, /_retainedOutput/);
  assert.deepEqual(canonical, snapshot);
  assert.ok((await store.search(view._retainedOutput.ref, "PPPP")).matches.length > 0);
});

test("structured sources keep provider payload while reducing abstract text", async () => {
  const abstract = "A".repeat(3_000);
  const structuredData = Object.fromEntries(Array.from({ length: 5 }, (_, key) => [`field${key}`, `${key}:${"S".repeat(996)}`]));
  const canonical = { records: Array.from({ length: 8 }, (_, index) => ({
    abstract,
    identifier: `4HHB${index}`,
    structuredData,
    title: `Structure ${index}`,
    url: `https://www.rcsb.org/structure/4HHB${index}`,
  })) };
  const { response } = await dispatch(canonical, false, "pdb", "lookup_structure");
  const view = JSON.parse(response.content);
  assert.ok(Buffer.byteLength(response.content) <= 48 * 1024);
  assert.equal(view.records.length, 8);
  for (const [index, record] of view.records.entries()) {
    assert.equal(record.id, `4HHB${index}`);
    assert.equal(record.title, `Structure ${index}`);
    assert.deepEqual(record.structuredData, structuredData);
    assert.equal(record.abstractTruncated, true);
    assert.ok(Buffer.byteLength(record.abstract) < Buffer.byteLength(abstract));
  }
  assert.equal(view.truncated, true);
});

test("oversized result data preserves all small record identities", async () => {
  const { response } = await dispatch({ records: [
    { identifier: "first", title: "First" }, { identifier: "second", title: "Second" },
  ], data: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`section${index}`, "x".repeat(4_000)])) });
  const view = JSON.parse(response.content);
  assert.deepEqual(view.records.map((record: { id: string }) => record.id), ["first", "second"]);
  assert.deepEqual(view.data, { truncated: true, reason: "maximum size reached" });
  assert.equal(view.truncated, true);
  assert.ok(Buffer.byteLength(response.content) <= 48 * 1024);
  assert.equal(typeof view._retainedOutput.ref, "string");
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
    sourceUrl: "https://provider.invalid/private-download", logicalName: "result.pdf", checksum: "provider-checksum",
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
    if ("records" in canonical && canonical.records?.[0] === null) assert.deepEqual(view.records, canonical.records);
  }
});

test("deep and cyclic provider results degrade safely without a false complete-result reference", async () => {
  const credential = randomUUID();
  const cyclic: Record<string, unknown> = { answer: "visible", authorization: credential, sourceUrl: "https://provider.invalid/hidden" };
  cyclic.self = cyclic;
  let deep: unknown = { answer: "deep" };
  for (let index = 0; index < 10_000; index += 1) deep = { next: deep };
  for (const input of [cyclic, { answer: "visible", data: deep }]) {
    const { response } = await dispatch(input);
    assert.equal(response.isError, false);
    const view = JSON.parse(response.content);
    assert.equal(view.answer, "visible");
    assert.equal(view._retainedOutput.ref, undefined);
    assert.match(view._retainedOutput.instruction, /could not be stored/);
    assert.doesNotMatch(response.content, new RegExp(credential));
    assert.doesNotMatch(response.content, /provider.invalid|sourceUrl/);
    assert.ok(Buffer.byteLength(response.content) <= 48 * 1024);
  }
  assert.equal(cyclic.self, cyclic);
  assert.equal(cyclic.authorization, credential);
});

test("complete normalized records and download plans need no recovery reference", async () => {
  const citation = { markdown: "PDB:1", identifier: "1", source: "pdb" };
  const record = { identifier: "1", identifierType: "pdb", title: "Structure", source: "pdb", fullTextRetrieved: false,
    citations: [citation], primaryCitation: citation, warnings: [], structuredData: { resolution: 1.8 }, crossReferences: [] };
  const { response } = await dispatch({ records: [record], warnings: [], artifacts: [], sourceVersion: "v1" });
  const view = JSON.parse(response.content);
  assert.equal(view.records[0].structuredData.resolution, 1.8);
  assert.equal(view._retainedOutput, undefined);
  const plan = await dispatch({ records: [], artifacts: [{ id: "pdf", logicalName: "result.pdf", license: "CC-BY", expectedBytes: 42 }] });
  assert.equal(JSON.parse(plan.response.content)._retainedOutput, undefined);
});


test("distinct supporting citations and unknown business fields still trigger retention", async () => {
  const primary = { identifier: "primary", source: "db", markdown: "Primary" };
  for (const record of [
    { identifier: "record", primaryCitation: primary, citations: [primary, { ...primary, identifier: "supporting" }] },
    { identifier: "record", extraAnalysis: { score: 0.75 } },
  ]) {
    const { response, store } = await dispatch({ records: [record], artifacts: [] });
    const ref = JSON.parse(response.content)._retainedOutput.ref;
    const full = JSON.parse((await store.read(ref)).text);
    assert.deepEqual(full.records[0], record);
  }
});
