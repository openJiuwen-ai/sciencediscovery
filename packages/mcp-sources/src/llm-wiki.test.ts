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
import type { JsonValue, McpRawResult } from "@sciencediscovery/schema";
import { createBuiltinMcpSourceRegistry } from "./builtins.js";
import { createLlmWikiSource } from "./llm-wiki.js";

const source = createLlmWikiSource("http://127.0.0.1:8100");
function normalize(toolId: string, payload: JsonValue, textOnly = false) {
  const raw: McpRawResult = textOnly
    ? { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false }
    : { content: [], structuredContent: payload, isError: false };
  return source.normalizeResult({ source: source.manifest, tool: source.manifest.tools[toolId]!, retrievedAt: "2026-09-07T00:00:00Z" }, raw);
}

test("Wiki input bounds reject traversal, unknown arguments and oversized batches", () => {
  for (const path of ["../secret", "/etc/passwd", "a/../b", "a\\b", "%2e%2e/x", "a?x", "a#x", "https://evil.test", "a\n", "a//b"]) {
    assert.equal(source.validateInput("get_page", { path }).valid, false, path);
    assert.equal(source.validateInput("get_pages", { paths: [path] }).valid, false, path);
  }
  for (const input of [{ query: " " }, { query: "Overview", limit: 26 }, { query: "Overview", url: "http://evil.test" }]) {
    assert.equal(source.validateInput("search", input).valid, false);
  }
  assert.equal(source.validateInput("get_pages", { paths: Array(21).fill("a.md") }).valid, false);
  assert.equal(source.validateInput("get_pages", { paths: ["a.md"], max_tokens: 99 }).valid, false);
  assert.deepEqual(source.validateInput("search", { query: " Overview " }), { valid: true, input: { query: "Overview", limit: 5 } });
  assert.deepEqual(source.validateInput("get_pages", { paths: ["知识/Overview.md"] }), { valid: true, input: { paths: ["知识/Overview.md"], max_tokens: 8000 } });
  assert.equal(source.manifest.enabledByDefault, false);
  assert.equal(source.manifest.cache.enabled, false);
  assert.equal(source.manifest.cache.scope, "session");
  assert.equal(source.manifest.governance.dataClassification, "private");
});

test("search keeps Wiki identity and original references without claiming paper full text", async () => {
  const result = await normalize("search", { sources: [{
    page_id: "知识/Overview (1).md", title: "Overview", summary: "Summary", chunk_content: "Evidence",
    source_refs: ["doi:10.1234/example"], relevance_score: 0.8, url: "https://evil.test",
  }] });
  const record = result.records[0]!;
  assert.equal(record.source, "llm-wiki");
  assert.equal(record.identifier, "知识/Overview (1).md");
  assert.equal(new URL(record.url).origin, "http://127.0.0.1:8100");
  assert.equal(record.fullTextRetrieved, false);
  assert.equal(record.contentScope, "curated-record");
  assert.equal(record.crossReferences[0]?.identifier, "doi:10.1234/example");
  assert.equal(record.primaryCitation.url, record.url);
  assert.match(record.primaryCitation.markdown, /\]\(http:/);
  assert.ok(record.url.endsWith("Overview%20%281%29.md"));
  assert.equal(result.untrusted, true);
});

test("search normalizes Windows-style index paths so page lookups round-trip", async () => {
  const result = await normalize("search", { sources: [
    { page_id: "debates\\fusion_v3_1_3_二烯.md", title: "Diene", source_refs: ["paper.md"], relevance_score: 0.8 },
    { path: "concepts\\mechanisms\\phase-transfer-catalysis.md", title: "PTC", sources: ["manual:ptc"] },
  ] });
  assert.deepEqual(result.records.map((record) => record.identifier), [
    "debates/fusion_v3_1_3_二烯.md",
    "concepts/mechanisms/phase-transfer-catalysis.md",
  ]);
  for (const record of result.records) {
    assert.ok(record.identifier.includes("/"));
    assert.ok(!record.identifier.includes("\\"));
    assert.ok(record.url.startsWith("http://127.0.0.1:8100/api/v1/wiki/"));
  }
});

test("pages from different domains retain their metadata and source references", async () => {
  const pages: JsonValue[] = [
    { path: "software/transactions.md", title: "Transactions", category: "databases", tags: ["ACID"], sources: ["manual:transactions"], content: "Isolation levels", isolation: "serializable" },
    { path: "history/trade.md", title: "Trade routes", category: "history", tags: ["trade"], sources: ["archive:trade"], content: "Trade routes", period: "medieval" },
  ];
  const result = await normalize("get_pages", { pages, missing: [] });
  assert.deepEqual(result.records.map((record) => record.structuredData), pages);
  assert.deepEqual(result.records.map((record) => record.crossReferences[0]?.identifier), ["manual:transactions", "archive:trade"]);
  assert.deepEqual(source.manifest.kinds, ["knowledge-base"]);
});

test("page snapshots change with content and text-only MCP responses are supported", async () => {
  const page = { path: "engineering/Overview.md", title: "Overview", content: "first", sources: ["paper.md"], updated_at: "today" };
  const first = await normalize("get_page", page, true);
  const second = await normalize("get_page", { ...page, content: "second" });
  assert.equal((first.records[0]?.structuredData as Record<string, JsonValue>).content, "first");
  assert.notEqual(first.records[0]?.primaryCitation.sourceVersion, second.records[0]?.primaryCitation.sourceVersion);
  await assert.rejects(normalize("get_page", { path: "../secret" }), /path/);
  await assert.rejects(normalize("search", { answer: "No evidence" }), /pages/);
});

test("batch normalization retains budget and missing-page diagnostics without duplicating pages", async () => {
  const result = await normalize("get_pages", {
    pages: [{ path: "a.md", content: "A" }], missing: ["b.md"], omitted_paths: ["c.md"],
    truncated_by_budget: true, token_budget_used: 100, token_budget_limit: 100,
  });
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.data, { missing: ["b.md"], omitted_paths: ["c.md"], truncated_by_budget: true, token_budget_used: 100, token_budget_limit: 100 });
});

test("Wiki service configuration accepts only an explicit HTTP(S) origin", () => {
  for (const url of ["file:///tmp", "http://user:pass@localhost", "http://localhost/api", "http://localhost?token=x"]) {
    assert.throws(() => createLlmWikiSource(url), /origin/);
  }
});

test("An invalid Wiki origin degrades to an unregistered source, not a registry failure", () => {
  process.env.SCIENCE_AGENT_LLM_WIKI_URL = "http://localhost/api";
  try {
    const registry = createBuiltinMcpSourceRegistry();
    assert.equal(registry.has("llm-wiki"), false);
    assert.ok(registry.get("uniprot"));
    assert.ok(registry.listManifests().some((manifest) => manifest.id === "arxiv"));
  } finally {
    delete process.env.SCIENCE_AGENT_LLM_WIKI_URL;
  }
});
