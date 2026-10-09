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
import type { MemoryGraphSink, ObserveToolCallPayload } from "@sciencediscovery/memory";

import { createKnowledgeEngineGraphMirror, keActivityToProducts } from "./graph-mirror.js";

function captureSink() {
  const emissions: ObserveToolCallPayload[] = [];
  const sink = {
    observeToolCall: (payload: ObserveToolCallPayload) => {
      emissions.push(payload);
    },
  } as unknown as MemoryGraphSink;
  return { emissions, sink };
}

test("kb_search mirrors one DbRecord product per unique hit document", () => {
  const products = keActivityToProducts({
    toolName: "kb_search",
    kbId: "kb1",
    result: {
      kbId: "kb1",
      query: "IC50",
      hits: [
        { docId: "doc-a", docTitle: "Paper A", anchorId: "doc-a:paragraph:0" },
        { docId: "doc-b", docTitle: "Paper B", anchorId: "doc-b:paragraph:3" },
        { docId: "doc-a", docTitle: "Paper A", anchorId: "doc-a:paragraph:7" },
      ],
      truncated: false,
    },
  });
  assert.equal(products.length, 2);
  assert.deepEqual(products[0], {
    productType: "db_record",
    source: "kb",
    identifier: "doc-a",
    title: "Paper A",
    url: "kb://kb1/doc-a",
  });
  assert.deepEqual(products[1], {
    productType: "db_record",
    source: "kb",
    identifier: "doc-b",
    title: "Paper B",
    url: "kb://kb1/doc-b",
  });
});

test("kb_expand mirrors the resolved document only when found", () => {
  const found = keActivityToProducts({
    toolName: "kb_expand",
    kbId: "kb1",
    result: {
      found: true,
      kbId: "kb1",
      docId: "doc-a",
      docTitle: "Paper A",
      block: { anchorId: "doc-a:paragraph:0" },
    },
  });
  assert.equal(found.length, 1);
  assert.equal(found[0]?.identifier, "doc-a");
  assert.equal(found[0]?.url, "kb://kb1/doc-a");

  const missed = keActivityToProducts({
    toolName: "kb_expand",
    kbId: "kb1",
    result: { found: false, reason: "document-not-found" },
  });
  assert.deepEqual(missed, []);
});

test("doc_grep dedups matches per document", () => {
  const products = keActivityToProducts({
    toolName: "doc_grep",
    kbId: "kb1",
    result: {
      kbId: "kb1",
      pattern: "IC50",
      matches: [
        { docId: "doc-a", docTitle: "Paper A", line: 3, text: "IC50 = 5nM" },
        { docId: "doc-a", docTitle: "Paper A", line: 9, text: "the IC50" },
        { docId: "doc-b", docTitle: null, line: 1, text: "IC50" },
      ],
      scannedDocs: 2,
      truncated: false,
    },
  });
  assert.equal(products.length, 2);
  // Null titles are dropped rather than mirrored as "null".
  assert.equal(products[1]?.title, undefined);
});

test("unregistered KE tools produce no products", () => {
  for (const toolName of ["concept_explore", "deep_dive", "novelty_check", "verify_citation", "list_knowledge_bases"]) {
    assert.deepEqual(keActivityToProducts({ toolName, kbId: "kb1", result: { kbId: "kb1" } }), [], toolName);
  }
});

test("the observer gates on the registry and reports resultCount", () => {
  const { emissions, sink } = captureSink();
  const observer = createKnowledgeEngineGraphMirror({ sink, sessionId: "s1", turnId: "r1" });

  // Unregistered tool: the observer fires but nothing reaches the sink.
  observer({ toolName: "concept_explore", kbId: "kb1", result: {} });
  assert.equal(emissions.length, 0);

  observer({
    toolName: "kb_search",
    kbId: "kb1",
    result: { kbId: "kb1", hits: [{ docId: "doc-a", docTitle: "Paper A" }], truncated: false },
  });
  assert.equal(emissions.length, 1);
  const payload = emissions[0]!;
  assert.equal(payload.sessionId, "s1");
  assert.equal(payload.turnId, "r1");
  assert.equal(payload.toolName, "kb_search");
  assert.equal(payload.toolType, "search");
  assert.equal(payload.status, "ok");
  assert.equal(payload.resultCount, 1);
  assert.equal(payload.products.length, 1);
  assert.match(payload.taskId, /^subtask:ke:/);
});

test("a zero-hit search still mirrors the ToolCall with no products", () => {
  const { emissions, sink } = captureSink();
  const observer = createKnowledgeEngineGraphMirror({ sink, sessionId: "s1", turnId: "r1" });
  observer({ toolName: "kb_search", kbId: "kb1", result: { kbId: "kb1", hits: [], truncated: false } });
  assert.equal(emissions.length, 1);
  assert.equal(emissions[0]?.resultCount, 0);
  assert.deepEqual(emissions[0]?.products, []);
});

test("a structured error result mirrors as status error (doc_grep invalid regex)", () => {
  const { emissions, sink } = captureSink();
  const observer = createKnowledgeEngineGraphMirror({ sink, sessionId: "s1", turnId: "r1" });
  observer({
    toolName: "doc_grep",
    kbId: "kb1",
    result: { kbId: "kb1", pattern: "(", matches: [], scannedDocs: 0, truncated: false, error: "invalid regular expression" },
  });
  assert.equal(emissions.length, 1);
  assert.equal(emissions[0]?.status, "error");
  assert.deepEqual(emissions[0]?.products, []);
});

test("kb_expand falls back to the activity kbId when the result omits it", () => {
  const products = keActivityToProducts({
    toolName: "kb_expand",
    kbId: "kb1",
    result: { found: true, docId: "doc-a", docTitle: "Paper A", block: { anchorId: "doc-a:paragraph:0" } },
  });
  assert.equal(products.length, 1);
  assert.equal(products[0]?.url, "kb://kb1/doc-a");
});
