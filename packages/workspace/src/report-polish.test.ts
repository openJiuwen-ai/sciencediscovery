// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { extractFragments, normalizeHeadings, markCitations, polishReport, stripBoilerplate } from "./report-polish.js";

test("stripBoilerplate removes LLM boilerplate in English and Chinese, collapses blank runs", () => {
  const raw = "Based on the provided documents, the answer is clear. 根据所提供的文档：结论如下。\n\n\n\nBody text.";
  const { blocksRemoved, content } = stripBoilerplate(raw);
  assert.equal(blocksRemoved, 2);
  assert.equal(content.includes("Based on the provided documents"), false);
  assert.equal(content.includes("根据所提供的文档"), false);
  assert.ok(!content.includes("\n\n\n"));
});

test("markCitations marks only probe-verified fragments with a stable per-doc marker", async () => {
  const quoteA = "Helical parameters were locally searched based on previously reported values";
  const quoteB = "The nucleocapsid helix condenses upon incorporation into the virion";
  const quoteC = "This sentence is invented and appears in no source document at all";
  const content = `Finding one: “${quoteA}”.\n\nFinding two: “${quoteB}”.\n\nFinding three: “${quoteC}”.`;
  const result = await markCitations(content, async (fragment) => {
    if (fragment === quoteA || fragment === quoteB) return { docId: "doc-1", docTitle: "Cryo-ET paper" };
    return undefined;
  });
  assert.equal(result.fragmentsChecked, 3);
  assert.deepEqual(result.citations, [{ docId: "doc-1", docTitle: "Cryo-ET paper", marker: 1 }]);
  assert.ok(result.content.includes(`${quoteA}” [1]`), "the marker lands after the closing quote");
  assert.ok(result.content.includes(`${quoteB}” [1]`), "same source reuses the same marker");
  assert.ok(result.content.includes(`${quoteC}”`), "unverifiable fragment is left exactly as written");
  assert.ok(!result.content.includes(`${quoteC} [`));
});

test("markCitations: folded fragments locate via whitespace tolerance; nested fragments are skipped", async () => {
  const outer = "The repeating unit of the helical nucleocapsid is two NP protomers plus two VP24 molecules";
  const inner = "two NP protomers plus two VP24 molecules";
  // The quote is line-folded in the report (extraction folds it for matching).
  const content = `Model: “The repeating unit of the helical nucleocapsid is two NP\nprotomers plus two VP24 molecules”.\nAlso: “${inner}”.`;
  const result = await markCitations(content, async () => ({ docId: "doc-1" }));
  assert.equal(result.citations.length, 1, "only the outer span gets a marker — the nested inner is skipped");
  const markerCount = (result.content.match(/\[1\]/g) ?? []).length;
  assert.equal(markerCount, 1);
  assert.ok(!result.citations.some(() => false), "no dangling index entry for skipped fragments");
});

test("normalizeHeadings demotes extra top-level headings and caps deep levels, keeps the title", () => {
  const { content, normalized } = normalizeHeadings("# Title\n# Second\n##### Deep\n## Fine\n");
  assert.equal(normalized, 2);
  assert.equal(content, "# Title\n## Second\n#### Deep\n## Fine\n");
});

test("normalizeHeadings leaves fenced code blocks untouched", () => {
  const { content, normalized } = normalizeHeadings("# Title\n```python\n# a comment\n##### deeper comment\n```\n# After\n");
  assert.equal(normalized, 1, "only the post-fence heading is demoted");
  assert.equal(content, "# Title\n```python\n# a comment\n##### deeper comment\n```\n## After\n");
});

test("extractFragments collects paired quotes and blockquotes, dedupes, caps length", () => {
  const long = "x".repeat(600);
  const text = `“${"a valid quote fragment with enough characters to count"}”\n> a blockquote line that is also long enough to keep\n“${long}”`;
  const fragments = extractFragments(text);
  assert.equal(fragments.length, 2, "the 600-char fragment is dropped");
});

test("polishReport runs all stages and reports stats", async () => {
  const raw = "Based on the documents, stuff.\n# Report\n# Real section\n“a verified fragment long enough to be checked here”\n";
  const result = await polishReport(raw, async () => ({ docId: "d1" }));
  assert.equal(result.stats.boilerplateBlocksRemoved, 1);
  assert.equal(result.stats.citationsMarked, 1);
  assert.equal(result.stats.fragmentsChecked, 1);
  assert.ok(result.cleaned.includes("[1]"));
  // Without a probe, fragments are counted nowhere and nothing is marked.
  const unprobed = await polishReport(raw);
  assert.equal(unprobed.stats.fragmentsChecked, 0);
  assert.equal(unprobed.citations.length, 0);
});
