// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
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

import {
  applyRelativeGrading,
  docIdFromAnchor,
  expandAnchor,
  extractQueryTerms,
  grepDocuments,
  hybridSearchBlocks,
  searchBlocks,
  type KbSearchHit,
  type KbSearchDocumentInput,
} from "./search.js";

const DOC_A: KbSearchDocumentInput = {
  docId: "doc-a",
  title: "Antibodycocktail",
  fulltext: [
    "# Antibody cocktail study",
    "",
    "## Methods",
    "",
    "The neutralization assay used a cocktail of mAb114 and REGN3471 at 4 nM each.",
    "",
    "$$",
    "K_d = 4.2\\,\\mathrm{nM}",
    "$$",
    "",
    "## References",
    "",
    "- [b1] Corti 2016 Science",
  ].join("\n"),
};

const DOC_B: KbSearchDocumentInput = {
  docId: "doc-b",
  title: "Structural basis",
  fulltext: "# Structural basis of neutralization\n\nThe GP trimer is the sole target of neutralizing antibodies in vivo.",
};

test("extractQueryTerms drops stopwords and single ascii letters, keeps CJK", () => {
  assert.deepEqual(extractQueryTerms("The mAb114 and antibody"), ["mab114", "antibody"]);
  assert.deepEqual(extractQueryTerms("抗体 中和"), ["抗体", "中和"]);
  assert.deepEqual(extractQueryTerms("a of to"), []);
});

test("searchBlocks returns anchor-level hits ranked by term coverage", () => {
  const result = searchBlocks({ kbId: "kb1", query: "mAb114 neutralization assay", documents: [DOC_A, DOC_B] });
  assert.equal(result.hits.length > 0, true);
  const top = result.hits[0]!;
  assert.equal(top.docId, "doc-a");
  assert.equal(top.blockType, "paragraph");
  assert.match(top.anchorId, /^doc-a:paragraph:0$/);
  assert.ok(top.matchedTerms.includes("mab114"));
  assert.ok(top.snippet.includes("mAb114"));
  // Formula and reference blocks can surface, headings too — types are real.
  for (const hit of result.hits) {
    assert.ok(hit.score > 0);
    assert.match(hit.anchorId, /^doc-[ab]:(heading|paragraph|formula):\d+$/);
  }
});

test("searchBlocks spreads hits across documents and flags truncation", () => {
  const result = searchBlocks({ kbId: "kb1", query: "neutralizing neutralization antibodies", documents: [DOC_A, DOC_B], topK: 1 });
  // topK=1: only the single best block survives; anything cut sets truncated.
  assert.equal(result.hits.length, 1);
  assert.equal(result.truncated, true);

  const spread = searchBlocks({ kbId: "kb1", query: "neutralization", documents: [DOC_A, DOC_A], maxPerDoc: 1 });
  // Both doc-a copies are distinct docIds in real usage; same-id copies obey the per-doc cap.
  assert.ok(spread.hits.length <= 1);
});

test("searchBlocks reports empty queries and no-match honestly", () => {
  const noTerms = searchBlocks({ kbId: "kb1", query: "the of a", documents: [DOC_A] });
  assert.deepEqual(noTerms.hits, []);
  assert.equal(noTerms.note, "query has no searchable terms");

  const noDocs = searchBlocks({ kbId: "kb1", query: "mAb114", documents: [] });
  assert.equal(noDocs.note, "no documents matched the keyword recall");

  const noMatch = searchBlocks({ kbId: "kb1", query: "zebraquantum", documents: [DOC_A] });
  assert.deepEqual(noMatch.hits, []);
  assert.equal(noMatch.note, "terms matched no passage blocks");
});

test("searchBlocks skips reference blocks and is deterministic", () => {
  const once = searchBlocks({ kbId: "kb1", query: "Corti", documents: [DOC_A] });
  assert.deepEqual(once.hits, [], "bibliography rows are not passage hits");
  const again = searchBlocks({ kbId: "kb1", query: "mAb114", documents: [DOC_A] });
  const third = searchBlocks({ kbId: "kb1", query: "mAb114", documents: [DOC_A] });
  assert.deepEqual(again, third);
});

test("docIdFromAnchor parses from the right and rejects short shapes", () => {
  assert.equal(docIdFromAnchor("doc-a:paragraph:0"), "doc-a");
  assert.equal(docIdFromAnchor("weird:id:formula:3"), "weird:id");
  assert.equal(docIdFromAnchor("nocolonatall"), null);
  assert.equal(docIdFromAnchor("only:one"), null);
  assert.equal(docIdFromAnchor(""), null);
});

test("expandAnchor returns the block with neighbours and honest misses", () => {
  const hit = expandAnchor({ kbId: "kb1", anchorId: "doc-a:paragraph:0", document: DOC_A });
  assert.equal(hit.found, true);
  if (hit.found) {
    // paragraph:0 is the Methods paragraph; its neighbours are the Methods
    // heading (before) and the display formula (after).
    assert.equal(hit.docTitle, "Antibodycocktail");
    assert.equal(hit.before?.type, "heading");
    assert.equal(hit.after?.type, "formula");
    assert.ok(hit.block.text.includes("neutralization assay"));
    assert.match(hit.before!.anchorId, /^doc-a:heading:\d+$/);
  }
  const miss = expandAnchor({ kbId: "kb1", anchorId: "doc-a:paragraph:99", document: DOC_A });
  assert.deepEqual(miss, { found: false, reason: "anchor-not-found" });
  const wrongType = expandAnchor({ kbId: "kb1", anchorId: "doc-a:zebra:0", document: DOC_A });
  assert.equal(wrongType.found, false);
});

test("grepDocuments matches case-insensitively with line numbers and caps", () => {
  const result = grepDocuments({ kbId: "kb1", pattern: "mAb114", documents: [DOC_A, DOC_B] });
  assert.equal(result.error, undefined);
  assert.equal(result.scannedDocs, 2);
  assert.equal(result.matches.length, 1);
  const match = result.matches[0]!;
  assert.equal(match.docId, "doc-a");
  assert.equal(match.line, 5);
  assert.ok(match.text.includes("mAb114"));

  // Regex semantics (not plain keywords) and case-insensitivity by default.
  const kd = grepDocuments({ kbId: "kb1", pattern: "k_d\\s*=", documents: [DOC_A] });
  assert.equal(kd.matches.length, 1);
  assert.equal(kd.matches[0]!.line, 8);

  const capped = grepDocuments({ kbId: "kb1", pattern: "nM|antibod", documents: [DOC_A, DOC_B], maxMatches: 1 });
  assert.equal(capped.matches.length, 1);
  assert.equal(capped.truncated, true);
});

test("grepDocuments returns structured errors, never throws", () => {
  const invalid = grepDocuments({ kbId: "kb1", pattern: "([unclosed", documents: [DOC_A] });
  assert.deepEqual(invalid.matches, []);
  assert.match(invalid.error ?? "", /invalid regex/i);

  const empty = grepDocuments({ kbId: "kb1", pattern: "", documents: [DOC_A] });
  assert.match(empty.error ?? "", /1-200/);

  const none = grepDocuments({ kbId: "kb1", pattern: "zebraquantum", documents: [DOC_A] });
  assert.deepEqual(none.matches, []);
  assert.equal(none.error, undefined);
  assert.equal(none.truncated, false);
});

// ------------------------------------------------------------------ Z8 hybrid

test("hybridSearchBlocks: an anchor found by both arms outranks single-arm finds", () => {
  const result = hybridSearchBlocks({
    kbId: "kb1",
    query: "mAb114 neutralization assay",
    documents: [DOC_A, DOC_B],
    // Vector arm ranks doc-b's paragraph first, doc-a's second — inverted
    // versus the keyword arm, which has doc-a on top.
    vectorCandidates: [
      { docId: "doc-b", anchorId: "doc-b:paragraph:0", score: 0.92 },
      { docId: "doc-a", anchorId: "doc-a:paragraph:0", score: 0.71 },
    ],
  });
  assert.deepEqual(result.sources, ["fts", "vector"]);
  // Both arms agree on doc-a:paragraph:0 → RRF sum wins over either rank-1.
  assert.match(result.hits[0]!.anchorId, /^doc-a:paragraph:0$/);
  assert.ok(result.hits[0]!.matchedTerms.includes("mab114"));
  assert.ok(result.hits.some((hit) => hit.anchorId === "doc-b:paragraph:0"));
});

test("hybridSearchBlocks: a vector-only anchor still resolves full block metadata", () => {
  const result = hybridSearchBlocks({
    kbId: "kb1",
    query: "mAb114",
    documents: [DOC_A],
    vectorCandidates: [{ docId: "doc-b", anchorId: "doc-b:paragraph:0", score: 0.9 }],
    // doc-b is NOT loaded — the candidate must be skipped, not crashed.
  });
  assert.equal(result.hits.every((hit) => hit.docId !== "doc-b"), true);

  const loaded = hybridSearchBlocks({
    kbId: "kb1",
    query: "mAb114",
    documents: [DOC_A, DOC_B],
    vectorCandidates: [{ docId: "doc-b", anchorId: "doc-b:paragraph:0", score: 0.9 }],
  });
  const vectorOnly = loaded.hits.find((hit) => hit.anchorId === "doc-b:paragraph:0");
  assert.ok(vectorOnly);
  assert.equal(vectorOnly.docTitle, "Structural basis");
  assert.equal(vectorOnly.blockType, "paragraph");
  assert.deepEqual(vectorOnly.matchedTerms, []);
});

test("hybridSearchBlocks: missing vector arm degrades to keyword-only with a note", () => {
  const degraded = hybridSearchBlocks({
    kbId: "kb1",
    query: "mAb114 assay",
    documents: [DOC_A],
    vectorCandidates: undefined,
  });
  assert.deepEqual(degraded.sources, ["fts"]);
  assert.match(degraded.note ?? "", /keyword-only/);
  // An explicitly EMPTY vector list is the same honest keyword-only state.
  const empty = hybridSearchBlocks({
    kbId: "kb1",
    query: "mAb114 assay",
    documents: [DOC_A],
    vectorCandidates: [],
  });
  assert.deepEqual(empty.sources, ["fts"]);
});

test("hybridSearchBlocks: the vector arm answers when the query has no keyword terms", () => {
  const result = hybridSearchBlocks({
    kbId: "kb1",
    query: "the of to",
    documents: [DOC_A],
    vectorCandidates: [{ docId: "doc-a", anchorId: "doc-a:paragraph:0", score: 0.8 }],
  });
  assert.deepEqual(result.sources, ["vector"]);
  assert.equal(result.hits.length, 1);
  assert.match(result.hits[0]!.anchorId, /^doc-a:paragraph:0$/);
});

// --------------------------------------------------- V1-Z2 relative grading

test("applyRelativeGrading annotates scoreRatio and relevance tiers, order preserved", () => {
  const hits = [
    { docId: "a", anchorId: "a:paragraph:0", score: 4 },
    { docId: "b", anchorId: "b:paragraph:0", score: 3.2 },
    { docId: "c", anchorId: "c:paragraph:0", score: 1.6 },
    { docId: "d", anchorId: "d:paragraph:0", score: 0.4 },
  ] as unknown as KbSearchHit[];
  const graded = applyRelativeGrading(hits);
  assert.deepEqual(graded.map((hit) => hit.docId), ["a", "b", "c", "d"]);
  assert.equal(graded[0]?.scoreRatio, 1);
  assert.equal(graded[0]?.relevance, "high");
  assert.equal(graded[1]?.scoreRatio, 0.8);
  assert.equal(graded[1]?.relevance, "high");
  assert.equal(graded[2]?.scoreRatio, 0.4);
  assert.equal(graded[2]?.relevance, "low");
  assert.equal(graded[3]?.relevance, "low");
});

test("applyRelativeGrading drops the tail below minScoreRatio of the best hit", () => {
  const hits = [
    { docId: "a", anchorId: "a:paragraph:0", score: 10 },
    { docId: "b", anchorId: "b:paragraph:0", score: 6 },
    { docId: "c", anchorId: "c:paragraph:0", score: 2 },
  ] as unknown as KbSearchHit[];
  const graded = applyRelativeGrading(hits, 0.5);
  assert.deepEqual(graded.map((hit) => hit.docId), ["a", "b"]);
  // Edge: exactly at the floor survives (>=).
  const edge = applyRelativeGrading([
    { docId: "a", anchorId: "a:paragraph:0", score: 10 },
    { docId: "b", anchorId: "b:paragraph:0", score: 5 },
  ] as unknown as KbSearchHit[], 0.5);
  assert.deepEqual(edge.map((hit) => hit.docId), ["a", "b"]);
});

test("searchBlocks grades hits relative to the batch best", () => {
  const result = searchBlocks({ kbId: "kb1", query: "mAb114 neutralization assay", documents: [DOC_A, DOC_B] });
  assert.ok(result.hits.length >= 2);
  assert.equal(result.hits[0]?.scoreRatio, 1);
  assert.equal(result.hits[0]?.relevance, "high");
  for (const hit of result.hits) {
    assert.ok(hit.scoreRatio !== undefined && hit.scoreRatio > 0 && hit.scoreRatio <= 1);
    assert.ok(hit.relevance !== undefined);
  }
  const cut = searchBlocks({ kbId: "kb1", query: "mAb114 neutralization assay", documents: [DOC_A, DOC_B], minScoreRatio: 0.9 });
  assert.ok(cut.hits.length <= result.hits.length);
  if (cut.hits.length > 0) {
    assert.equal(cut.hits[0]?.docId, result.hits[0]?.docId);
    for (const hit of cut.hits) {
      assert.ok(hit.score >= (cut.hits[0]?.score ?? 0) * 0.9 - 1e-9);
    }
  }
});

test("hybridSearchBlocks grades RRF hits on the fused scale", () => {
  const result = hybridSearchBlocks({
    kbId: "kb1",
    query: "mAb114 neutralization assay",
    documents: [DOC_A, DOC_B],
    vectorCandidates: [{ docId: "doc-b", anchorId: "doc-b:paragraph:0", score: 0.9 }],
  });
  assert.ok(result.hits.length >= 2);
  assert.equal(result.hits[0]?.scoreRatio, 1);
  for (const hit of result.hits) {
    assert.ok(hit.relevance !== undefined);
  }
});
