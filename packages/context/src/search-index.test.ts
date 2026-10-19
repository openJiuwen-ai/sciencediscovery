// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { SearchIndexContributor, SearchResultIndex } from "./search-index.js";

const call = (name: string, args: Record<string, unknown>) => ({ args, id: `c-${name}`, name });

test("index records retrieval tools with hit counts and titles; section appears once entries exist", () => {
  const index = new SearchResultIndex();
  assert.equal(index.section(), undefined, "empty index contributes nothing");
  index.observe(call("kb_search", { kbId: "kb1", query: "helical parameters" }),
    JSON.stringify({ hits: [{ docTitle: "Cryo-ET paper", snippet: "…" }, { docTitle: "VP24 paper" }], truncated: false }), false);
  index.observe(call("doc_grep", { kbId: "kb1", pattern: "twist" }),
    JSON.stringify({ matches: [{ docId: "d1", line: "twist -30.35" }] }), false);
  index.observe(call("run_python", { code: "print(1)" }), "1", false);
  index.observe(call("web_search", { query: "ignored error" }), "fetch failed", true);
  assert.equal(index.size, 2, "non-retrieval tools and errors are not indexed");
  const section = index.section()!;
  assert.match(section, /do NOT repeat/);
  assert.match(section, /kb_search\(helical parameters\) → 2 \(top: Cryo-ET paper \| VP24 paper\)/);
  assert.match(section, /doc_grep\(twist\) → 1 \(top: d1\)/);
});

test("non-JSON content is recorded by size (web_fetch readable text envelope)", () => {
  const index = new SearchResultIndex();
  // The production web envelope is {content: string, invocation} — readable
  // text inside content (the double-encoded JSON path is covered above).
  index.observe(call("web_fetch", { url: "https://example.test/page" }),
    JSON.stringify({ content: "x".repeat(2_000), invocation: { attempts: 1 } }), false);
  const section = index.section()!;
  assert.match(section, /web_fetch\(https:\/\/example.test\/page\) → 2k chars/);
});

test("web_search's double-encoded results are unwrapped for count and titles", () => {
  const index = new SearchResultIndex();
  index.observe(call("web_search", { query: "ebola VP24" }),
    JSON.stringify({ content: JSON.stringify({ results: [{ title: "Nature paper" }, { title: "NEJM paper" }] }), invocation: {} }), false);
  assert.match(index.section()!, /web_search\(ebola VP24\) → 2 \(top: Nature paper \| NEJM paper\)/);
});

test("structured failures are not indexed (the tool's contract invites a corrected retry)", () => {
  const index = new SearchResultIndex();
  index.observe(call("doc_grep", { pattern: "((bad" }), JSON.stringify({ error: "invalid regex: ((bad", matches: [] }), false);
  index.observe(call("kb_expand", { anchorId: "doc1:paragraph:9" }), JSON.stringify({ found: false, reason: "anchor-not-found" }), false);
  index.observe(call("concept_explore", { entity: "nobody" }), JSON.stringify({ found: false }), false);
  assert.equal(index.size, 0);
  assert.equal(index.section(), undefined, "failed retrievals must not read as 'already searched'");
});

test("concept_explore/deep_dive payloads count neighbors and evidence", () => {
  const index = new SearchResultIndex();
  index.observe(call("concept_explore", { entity: "VP24" }),
    JSON.stringify({ found: true, neighbors: [{ name: "NP" }, { name: "VP35" }], truncated: false }), false);
  index.observe(call("deep_dive", { entity: "VP24" }),
    JSON.stringify({ found: true, evidence: [{ docId: "d1" }, { docId: "d2" }, { docId: "d3" }] }), false);
  const section = index.section()!;
  assert.match(section, /concept_explore\(VP24\) → 2 \(top: NP \| VP35\)/);
  assert.match(section, /deep_dive\(VP24\) → 3 \(top: d1 \| d2 \| d3\)/);
});

test("entries cap at 100 with oldest evicted; section shows the last 30", () => {
  const index = new SearchResultIndex();
  for (let i = 0; i < 110; i += 1) {
    index.observe(call("kb_search", { query: `q${i}` }), JSON.stringify({ hits: [] }), false);
  }
  assert.equal(index.size, 100);
  const section = index.section()!;
  assert.match(section, /plus 70 earlier retrievals/);
  assert.ok(section.includes("q80"), "the window shows the last 30 (q80..q109)");
  assert.ok(section.includes("q109"), "the newest entry survives");
  assert.ok(!section.includes("q79"), "entries beyond the 30-line window fold into the omitted count");
});

test("contributor emits a working-context section and stays optional", async () => {
  const index = new SearchResultIndex();
  const contributor = new SearchIndexContributor(index, ["main"]);
  assert.equal(contributor.required, false);
  assert.deepEqual(await contributor.contribute(), {}, "no entries → no contribution");
  index.observe(call("kb_expand", { anchorId: "doc1:paragraph:0" }), JSON.stringify({ block: { text: "…" } }), false);
  const contribution = await contributor.contribute();
  assert.equal(contribution.systemSections?.length, 1);
  assert.equal(contribution.systemSections?.[0]?.slot, "working_context");
  assert.match(contribution.systemSections?.[0]?.content ?? "", /kb_expand\(doc1:paragraph:0\)/);
});
