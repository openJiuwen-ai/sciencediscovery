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
  buildEntailmentMessages,
  checkCitationQuoteVerbatim,
  computeCitationMetrics,
  evaluateCitationClaims,
  normalizeForQuoteMatch,
  parseCitationJudgeVerdict,
  type CitationEvalInput,
} from "./citation.js";

test("checkCitationQuoteVerbatim: exact / normalized / missing / no-quote / no-source", () => {
  const source = "mAb114 binds the Ebola virus glyco-protein\nand neutralizes it.";
  assert.equal(checkCitationQuoteVerbatim("mAb114 binds the Ebola virus glyco-protein", source), "exact");
  // Typographic-only differences (double space + case) → normalized.
  assert.equal(checkCitationQuoteVerbatim("MAB114  binds the Ebola virus glyco-protein", source), "normalized");
  // Hyphen-collapse ("glycoprotein" vs "glyco-protein") is NOT typographic — missing.
  assert.equal(checkCitationQuoteVerbatim("MAB114 binds the Ebola virus glycoprotein", source), "missing");
  assert.equal(checkCitationQuoteVerbatim("REGN-EB3 is a cocktail", source), "missing");
  assert.equal(checkCitationQuoteVerbatim(undefined, source), "no-quote");
  assert.equal(checkCitationQuoteVerbatim("  ", source), "no-quote");
  assert.equal(checkCitationQuoteVerbatim("anything", undefined), "no-source");
});

test("normalizeForQuoteMatch folds unicode hyphens, whitespace, case", () => {
  assert.equal(normalizeForQuoteMatch("A‑B−C  D\nE"), "a-b-c d e");
});

test("parseCitationJudgeVerdict: negated form checked first, tail-only", () => {
  assert.equal(parseCitationJudgeVerdict("ENTAILED"), true);
  assert.equal(parseCitationJudgeVerdict("NOT_ENTAILED"), false);
  assert.equal(parseCitationJudgeVerdict("分析过程… NOT ENTAILED"), false);
  assert.equal(parseCitationJudgeVerdict("ENTAILED\n理由是…"), true);
  assert.equal(parseCitationJudgeVerdict("无法判定"), null);
});

test("buildEntailmentMessages: statement + numbered passages, strict verdict format", () => {
  const [system, user] = buildEntailmentMessages("claim X", ["passage one", "passage two"]);
  assert.equal(system!.role, "system");
  assert.match(system!.content, /ENTAILED 或 NOT_ENTAILED/);
  assert.match(user!.content, /【陈述】\nclaim X/);
  assert.match(user!.content, /【证据段落 1】\npassage one/);
  assert.match(user!.content, /【证据段落 2】\npassage two/);
});

test("evaluateCitationClaims: quote precheck runs without a judge", async () => {
  const input: CitationEvalInput = {
    sources: { "doc-a": "The glycoprotein is heavily glycosylated." },
    claims: [
      { id: "c1", statement: "GP is glycosylated", citations: [{ sourceId: "doc-a", quote: "heavily glycosylated" }] },
      { id: "c2", statement: "no citations", citations: [] },
    ],
  };
  const results = await evaluateCitationClaims(input);
  assert.equal(results.length, 2);
  assert.equal(results[0]!.quoteChecks[0]!.status, "exact");
  assert.equal(results[0]!.recall, undefined);
  assert.equal(results[1]!.recall, undefined);
});

test("evaluateCitationClaims: recall + leave-one-out precision with a stub judge", async () => {
  const input: CitationEvalInput = {
    sources: { a: "passage a", b: "passage b" },
    claims: [
      {
        id: "c1",
        statement: "supported by two",
        citations: [{ sourceId: "a" }, { sourceId: "b" }],
      },
      { id: "c2", statement: "unsupported", citations: [{ sourceId: "a" }] },
    ],
  };
  // Stub judge: c1 entailed with both passages AND entailed without "passage a"
  // (b is redundant-ish: dropping a still entails), c2 never entailed.
  const judge = async (statement: string, passages: string[]) => {
    if (statement === "unsupported") return false;
    return passages.some((p) => p.includes("passage b"));
  };
  const results = await evaluateCitationClaims(input, judge);
  assert.equal(results[0]!.recall, true);
  assert.equal(results[0]!.precisionEvaluatedCitations, 2);
  // Leaving out "passage a" still entails (b present) → a redundant; leaving
  // out b leaves only a → not entailed → b not redundant.
  assert.equal(results[0]!.redundantCitations, 1);
  // recall failed → no leave-one-out for c2.
  assert.equal(results[1]!.recall, false);
  assert.equal(results[1]!.precisionEvaluatedCitations, undefined);
});

test("evaluateCitationClaims: judge failure (null) never counts as redundant", async () => {
  const input: CitationEvalInput = {
    sources: { a: "x", b: "y" },
    claims: [{ id: "c1", statement: "s", citations: [{ sourceId: "a" }, { sourceId: "b" }] }],
  };
  let calls = 0;
  const judge = async (): Promise<boolean | null> => {
    calls += 1;
    return calls === 1 ? true : null; // recall passes; both leave-one-out judges fail
  };
  const results = await evaluateCitationClaims(input, judge);
  assert.equal(results[0]!.redundantCitations, 0);
  assert.equal(results[0]!.precisionEvaluatedCitations, 2);
});

test("computeCitationMetrics: aggregates with honest nulls", () => {
  const metrics = computeCitationMetrics([
    {
      id: "c1",
      statement: "s1",
      citationsCount: 2,
      quoteChecks: [
        { sourceId: "a", status: "exact" },
        { sourceId: "b", status: "missing" },
      ],
      recall: true,
      redundantCitations: 1,
      precisionEvaluatedCitations: 2,
    },
    {
      id: "c2",
      statement: "s2",
      citationsCount: 1,
      quoteChecks: [{ sourceId: "a", status: "no-quote" }],
      recall: null, // judge failure — excluded from recall aggregate
    },
  ]);
  assert.equal(metrics.claims, 2);
  assert.equal(metrics.citations, 3);
  assert.equal(metrics.quotesProvided, 2); // no-quote excluded from the precheck denominator
  assert.equal(metrics.quoteVerbatimRate, 50);
  assert.equal(metrics.recallEvaluated, 1);
  assert.equal(metrics.citationRecall, 100);
  assert.equal(metrics.citationPrecision, 50);
  // No-judge run: rates are null, not zero.
  const offline = computeCitationMetrics([
    { id: "c", statement: "s", citationsCount: 0, quoteChecks: [] },
  ]);
  assert.equal(offline.citationRecall, null);
  assert.equal(offline.citationPrecision, null);
  assert.equal(offline.quoteVerbatimRate, null);
});
