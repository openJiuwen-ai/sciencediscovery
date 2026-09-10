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

import { extractQueryTerms, searchBlocks, type KbSearchDocumentInput } from "./search.js";

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
