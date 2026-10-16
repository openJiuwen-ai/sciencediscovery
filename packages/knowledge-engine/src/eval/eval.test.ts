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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateGapHit,
  checkQuoteVerbatim,
  computeGrowthEvalMetrics,
  computeIntegrity,
  detectOverclaims,
  extractQuotedSpans,
  extractVerdict,
  findGaps,
  loadDiscovererDataset,
  loadGapHitDataset,
  matchGapHits,
  pairKeyOf,
  precheckQuotes,
  producedPairs,
  runGapHitItem,
  scoreDiscoverer,
  type DiscovererItem,
  type DiscovererItemResult,
  type GapAnalysis,
  type GapHitItem,
} from "../index.js";

// --- growth-eval metrics -----------------------------------------------------------

test("computeGrowthEvalMetrics: gap detection, recall@k, negative share", () => {
  const groups = [
    [
      { key: "a", isPositive: true },
      { key: "b", isPositive: false },
    ],
    [
      { key: "c", isPositive: false },
      { key: "d", isPositive: true },
    ],
    // No positives — excluded from the gap-detection denominator.
    [{ key: "e", isPositive: false }],
  ];
  const m = computeGrowthEvalMetrics(groups, 1);
  assert.equal(m.queries, 3);
  assert.equal(m.gapDetectionRate, 0.5); // 1 of 2 gap groups hit at k=1
  assert.equal(m.recallAtK, 0.5); // 1 of 2 positives found
  assert.equal(m.negativeShareAtK, 2 / 3);
  assert.equal(m.positivesTotal, 2);
  assert.throws(() => computeGrowthEvalMetrics([], 0), RangeError);
});

// --- dataset validation --------------------------------------------------------------

test("loadDiscovererDataset validates kind, verdicts and evidence source refs", () => {
  assert.throws(() => loadDiscovererDataset(JSON.stringify({ id: "x", kind: "nope" })), /unknown dataset kind/);
  assert.throws(
    () =>
      loadDiscovererDataset(
        JSON.stringify({
          id: "x",
          kind: "novelty-triage",
          items: [{ id: "i1", claim: "c", gold: "maybe" }],
        }),
      ),
    /illegal gold/,
  );
  assert.throws(
    () =>
      loadDiscovererDataset(
        JSON.stringify({
          id: "x",
          kind: "novelty-triage",
          items: [{ id: "i1", claim: "c", gold: "novel", evidenceSources: ["missing-src"] }],
        }),
      ),
    /unknown evidenceSource/,
  );
});

// --- verdict extraction --------------------------------------------------------------

test("extractVerdict: last Answer line wins, zh aliases, junk ignored", () => {
  assert.equal(extractVerdict("Answer: novel"), "novel");
  assert.equal(extractVerdict("Answer: similar found\nAnswer: novel"), "novel");
  assert.equal(extractVerdict("答案: 已有相似"), undefined); // requires the Answer: marker
  assert.equal(extractVerdict("Answer: 无法判定"), "inconclusive");
  assert.equal(extractVerdict("no verdict here"), undefined);
  assert.equal(extractVerdict("Answer: **similar-found**"), "similar-found");
});

// --- three-way scoring -----------------------------------------------------------------

test("scoreDiscoverer: accuracy, per-class recall, falseNovel/falseSimilar/overCautious", () => {
  const items: DiscovererItem[] = [
    { id: "n1", gold: "novel", goldAccept: ["novel", "inconclusive"], claim: "c" },
    { id: "s1", gold: "similar-found", claim: "c" },
    { id: "s2", gold: "similar-found", claim: "c" },
    { id: "s3", gold: "similar-found", claim: "c" },
  ];
  const results: DiscovererItemResult[] = [
    { id: "n1", gold: "novel", extracted: "inconclusive", correct: true, durationMs: 1 },
    { id: "s1", gold: "similar-found", extracted: "novel", correct: false, durationMs: 1 },
    { id: "s2", gold: "similar-found", extracted: "inconclusive", correct: false, durationMs: 1 },
    { id: "s3", gold: "similar-found", extracted: "similar-found", correct: true, durationMs: 1 },
  ];
  const m = scoreDiscoverer(results, items);
  assert.equal(m.accuracy, 50);
  assert.equal(m.falseNovel, 1); // s1 — the dangerous miss
  assert.equal(m.overCautious, 1); // s2
  assert.equal(m.falseSimilar, 0);
  assert.ok(Math.abs(m.perClass["similar-found"]!.recall - 100 / 3) < 1e-9);
  assert.equal(m.perClass["novel"]!.recall, 100);
});

// --- overclaim + citation precheck -------------------------------------------------------

test("detectOverclaims: lexicon hits, case-insensitive, deduped", () => {
  assert.deepEqual(detectOverclaims("我们首次发现 X，这是前所未有的。"), ["首次发现", "前所未有"]);
  assert.deepEqual(detectOverclaims("This UNPRECEDENTED result"), ["unprecedented"]);
  assert.deepEqual(detectOverclaims("a neutral statement about prior work"), []);
});

test("checkQuoteVerbatim: exact / normalized (dash+space fold) / missing", () => {
  assert.equal(checkQuoteVerbatim("abc", "xx abc yy"), "exact");
  assert.equal(checkQuoteVerbatim("a–b  c", "x a-b c y"), "normalized"); // en-dash + double space fold
  assert.equal(checkQuoteVerbatim("abc", "def"), "missing");
  assert.equal(checkQuoteVerbatim("", "abc"), "no-quote");
  assert.equal(checkQuoteVerbatim("abc", undefined), "no-source");
});

test("extractQuotedSpans ≥12 chars; precheckQuotes passes on any source", () => {
  const out = '他说 "mAb114 neutralizes Ebola virus" 而短 "引" 不计。';
  const spans = extractQuotedSpans(out);
  assert.deepEqual(spans, ["mAb114 neutralizes Ebola virus"]);
  const agg = precheckQuotes(spans, ["mAb114 neutralizes Ebola virus glycoprotein"]);
  assert.deepEqual(agg, { verbatim: 1, normalized: 0, missing: 0 });
});

test("computeIntegrity: overclaim flagging, abstention split, citation aggregate", () => {
  const items: DiscovererItem[] = [
    { id: "n1", gold: "novel", goldAccept: ["novel", "inconclusive"], claim: "c", evidenceSources: ["s1"] },
    { id: "s1", gold: "similar-found", claim: "c" },
    { id: "s2", gold: "similar-found", claim: "c", supportsStrongClaims: true },
  ];
  const results: DiscovererItemResult[] = [
    { id: "n1", gold: "novel", extracted: "inconclusive", correct: true, durationMs: 1 },
    { id: "s1", gold: "similar-found", extracted: "inconclusive", correct: false, durationMs: 1 },
    { id: "s2", gold: "similar-found", extracted: "similar-found", correct: true, durationMs: 1 },
  ];
  const outputs = new Map([
    ["n1", '无法判定。"quoted span from source"'],
    ["s1", "这是首次发现该现象。"],
    ["s2", "史无前例的支持（该题允许强断言）。"],
  ]);
  const integrity = computeIntegrity(results, items, outputs, { s1: 'quoted span from source, verbatim' }, true);
  assert.equal(integrity.overclaim.evaluated, 3);
  assert.equal(integrity.overclaim.flagged, 1); // s1 only — s2 allows strong claims
  assert.deepEqual(integrity.overclaim.flaggedIds, ["s1"]);
  assert.deepEqual(integrity.abstention, { inconclusive: 2, justified: 1, overCautious: 1 });
  assert.equal(integrity.citation?.quotesFound, 1);
  assert.equal(integrity.citation?.verbatim, 1);
});

// --- gap-hit ------------------------------------------------------------------------------

test("pairKeyOf normalizes and orders; producedPairs dedups holes-first", () => {
  assert.equal(pairKeyOf("GP", "ebola virus"), "ebola virus|gp");
  const analysis = {
    holes: [
      {
        a: { id: "1", name: "GP", type: "t", supportCount: 1 },
        b: { id: "2", name: "Ebola Virus", type: "t", supportCount: 1 },
        commonNeighbors: [],
        score: 1,
        aCommunityId: null,
        bCommunityId: null,
        crossCommunity: false,
      },
    ],
    conflicts: [],
    transfers: [
      {
        method: { id: "1", name: "GP", type: "t", supportCount: 1 },
        from: { id: "9", name: "X", type: "t", supportCount: 1 },
        to: { id: "2", name: "Ebola Virus", type: "t", supportCount: 1 },
        sharedNeighbors: [],
        score: 1,
      },
    ],
    stats: { entities: 2, edges: 0, analyzed: 1, truncated: false },
  } as unknown as GapAnalysis;
  // Same pair produced by holes AND transfers → holes wins (scanned first).
  assert.deepEqual(producedPairs(analysis), [{ pair: "ebola virus|gp", signal: "holes" }]);
});

test("runGapHitItem: production findGaps over an inline graph, gold matched pairwise", () => {
  // Alpha and Beta share three hubs (h1, h2, h3) with no direct edge —
  // a textbook structural hole at the default minCommon=3.
  const item: GapHitItem = {
    id: "g1",
    graph: {
      entities: [
        { id: "a", name: "Alpha", type: "t" },
        { id: "b", name: "Beta", type: "t" },
        { id: "h1", name: "Hub One", type: "t" },
        { id: "h2", name: "Hub Two", type: "t" },
        { id: "h3", name: "Hub Three", type: "t" },
      ],
      edges: [
        { subject: "a", predicate: "r", object: "h1" },
        { subject: "a", predicate: "r", object: "h2" },
        { subject: "a", predicate: "r", object: "h3" },
        { subject: "b", predicate: "r", object: "h1" },
        { subject: "b", predicate: "r", object: "h2" },
        { subject: "b", predicate: "r", object: "h3" },
      ],
    },
    goldGaps: [
      { type: "missing-edge", subject: "a", object: "b" },
      { type: "missing-entity", entity: "Gamma" },
    ],
  };
  const score = runGapHitItem(item, { minCommon: 3 });
  assert.equal(score.error, undefined);
  // Alpha–Beta share h1,h2,h3 (≥3) → hole produced → gold hit.
  assert.equal(score.goldTotal, 1);
  assert.equal(score.goldHit, 1);
  assert.equal(score.hitRate, 1);
  assert.equal(score.unmatchableGold, 1); // missing-entity honestly aside

  // Matcher-level: the produced pair hits via the holes signal.
  const analysis = findGaps(
    item.graph.entities.map((e) => ({ id: e.id, name: e.name, type: e.type, supportCount: 1, communityId: null })),
    item.graph.edges.map((e, i) => ({ id: `e${i}`, srcId: e.subject, dstId: e.object, type: e.predicate, supportCount: 1, evidenceQuote: null })),
    { minCommon: 3 },
  );
  const matches = matchGapHits(analysis, item);
  assert.equal(matches[0]!.hit, true);
  assert.equal(matches[0]!.matchedSignal, "holes");
  assert.equal(matches[1]!.matchable, false);
});

test("aggregateGapHit: micro/macro hit rate and precision", () => {
  const m = aggregateGapHit([
    {
      id: "g1", durationMs: 1, holesProduced: 2, transfersProduced: 0, producedPairs: 2,
      producedHit: 1, goldTotal: 2, goldHit: 1, unmatchableGold: 0, hitRate: 0.5, precision: 0.5,
    },
    {
      id: "g2", durationMs: 1, holesProduced: 1, transfersProduced: 0, producedPairs: 1,
      producedHit: 1, goldTotal: 1, goldHit: 1, unmatchableGold: 1, hitRate: 1, precision: 1,
    },
  ]);
  assert.equal(m.goldTotal, 3);
  assert.equal(m.goldHit, 2);
  assert.equal(m.microHitRate, 2 / 3);
  assert.equal(m.macroHitRate, 0.75);
  assert.equal(m.microPrecision, 2 / 3);
  assert.equal(m.unmatchableGold, 1);
});

// --- packaged dataset regression pin -------------------------------------------------------

test("packaged gap-hit dataset loads and validates", () => {
  const path = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "test-datasets", "discoverer", "gap-hit.json");
  const ds = loadGapHitDataset(readFileSync(path, "utf-8"));
  assert.ok(ds.items.length > 0);
});

test("packaged gap-hit dataset: production findGaps baseline stays pinned", () => {
  const path = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "test-datasets", "discoverer", "gap-hit.json");
  const ds = loadGapHitDataset(readFileSync(path, "utf-8"));
  const scores = ds.items.map((item) => runGapHitItem(item, ds.thresholds));
  const m = aggregateGapHit(scores);
  // Pinned 2026-09-09 (SD findGaps port): micro 12/18 hits, no errors.
  // A drift here means the gap-finder (or the eval pairing) changed behavior.
  assert.equal(m.errors, 0);
  assert.equal(m.goldTotal, 18);
  assert.equal(m.goldHit, 12);
  assert.equal(m.unmatchableGold, 1);
  assert.ok(Math.abs((m.microHitRate ?? 0) - 12 / 18) < 1e-9);
});

test("packaged novelty-triage dataset loads and validates", () => {
  const path = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "test-datasets", "discoverer", "novelty-triage.json");
  const ds = loadDiscovererDataset(readFileSync(path, "utf-8"));
  assert.equal(ds.kind, "novelty-triage");
  assert.ok((ds.items?.length ?? 0) > 0);
});
