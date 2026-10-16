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

import {
  aaCouplingScore,
  blendAaScores,
  buildRefInvertedIndex,
  CITATION_PRIOR_CAP,
  CITATION_PRIOR_WEIGHT,
  mmrSelect,
  rankCandidatePool,
  type ScoredPaper,
} from "./selection.js";
import { assessConvergence, estimateRecallLp, type ConvergenceDataAccess } from "./convergence.js";
import { buildPatchQueries, pruneSeeds } from "./patch-queries.js";

function paper(title: string, overrides: Partial<ScoredPaper> = {}): ScoredPaper & { id: string } {
  return { id: title, title, abstract: `${title} abstract`, ...overrides };
}

function emb(values: number[]): Float32Array {
  return new Float32Array(values);
}

// --------------------------------------------------------------- selection

void test("rankCandidatePool scores by cosine with citation prior, sorts best-first", async () => {
  const queryEmb = emb([1, 0]);
  const embed = async (text: string) => (text.includes("close") ? emb([0.9, 0.1]) : emb([0, 1]));
  const ranked = await rankCandidatePool(
    [paper("far"), paper("close", { citationCount: 100 })],
    queryEmb,
    embed,
    10,
  );
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0]?.ref.title, "close");
  // cosine([1,0],[0.9,0.1]) = 0.9/sqrt(0.82) ≈ 0.9939, plus the citation prior.
  const cosine = 0.9 / Math.sqrt(0.82);
  const expected = cosine + Math.log1p(Math.min(100, CITATION_PRIOR_CAP)) * CITATION_PRIOR_WEIGHT;
  assert.ok(Math.abs(ranked[0]!.score! - expected) < 1e-9, `score ${ranked[0]!.score} ≈ ${expected}`);
});

void test("rankCandidatePool keeps scoreless candidates last", async () => {
  const ranked = await rankCandidatePool([paper("no-abstract", { abstract: null })], emb([1, 0]), async () => null, 10);
  assert.equal(ranked[0]?.score, null);
  assert.equal(ranked[0]?.emb, null);
});

void test("mmrSelect diversifies: second pick avoids near-duplicate of first", () => {
  const candidates = [
    { ref: paper("a"), score: 0.9, emb: emb([1, 0]) },
    { ref: paper("a-dup"), score: 0.89, emb: emb([0.99, 0.01]) },
    { ref: paper("b"), score: 0.8, emb: emb([0, 1]) },
  ];
  const selected = mmrSelect(candidates, 0.7, 2);
  assert.equal(selected[0]?.ref.title, "a");
  assert.equal(selected[1]?.ref.title, "b"); // diversity beats a-dup's higher score
});

void test("mmrSelect appends embedding-less candidates as fallback", () => {
  const candidates = [
    { ref: paper("a"), score: 0.9, emb: emb([1, 0]) },
    { ref: paper("no-emb"), score: null, emb: null },
  ];
  const selected = mmrSelect(candidates, 0.7, 2);
  assert.deepEqual(selected.map((candidate) => candidate.ref.title), ["a", "no-emb"]);
});

void test("aaCouplingScore rewards shared references with library-view degree", () => {
  const inverted = buildRefInvertedIndex([
    { id: "doc1", refIds: ["z1", "z2"] },
    { id: "doc2", refIds: ["z1"] },
  ]);
  assert.ok(aaCouplingScore(["z1", "z2"], inverted) > 0);
  assert.equal(aaCouplingScore(["z-unknown"], inverted), 0);
  assert.equal(aaCouplingScore([], inverted), 0);
});

void test("blendAaScores blends alpha*cosine+(1-alpha)*normAA and re-sorts", () => {
  const candidateA = { ref: paper("a"), score: 0.9, emb: null };
  const candidateB = { ref: paper("b"), score: 0.7, emb: null };
  const aaMap = new Map([[candidateB, 5]]);
  const blended = blendAaScores([candidateA, candidateB], aaMap);
  // B: 0.6*0.7 + 0.4*1 = 0.82; A: 0.6*0.9 = 0.54 → B first.
  assert.equal(blended[0]?.ref.title, "b");
  assert.ok(Math.abs(blended[0]!.score! - 0.82) < 1e-9);
});

// -------------------------------------------------------------- convergence

function fakeData(overrides: Partial<ConvergenceDataAccess> = {}): ConvergenceDataAccess {
  return {
    extractionCompletions: async () => [],
    countEntitiesCreatedSince: async () => 0,
    countEdgesCreatedSince: async () => 0,
    frontierCounts: async () => ({ total: 10, pending: 0, done: 9, failed: 1, skipped: 0 }),
    frontierSourceStats: async () => ({ observed: 0, f1: 0, f2: 0, unsourced: 0 }),
    documentDedupKeys: async () => ({ count: 0, dedupKeys: [] }),
    ...overrides,
  };
}

void test("converged when ≥3 of 4 signals met (coverage+exhaustion+boundary)", async () => {
  const data = fakeData({
    extractionCompletions: async () => Array.from({ length: 20 }, (_v, index) => `2026-08-${String(28 - index).padStart(2, "0")}T00:00:00Z`),
    frontierSourceStats: async () => ({ observed: 100, f1: 10, f2: 40, unsourced: 0 }),
  });
  const result = await assessConvergence(data, "kb", "cycle", { maxPapers: 50 });
  assert.equal(result.signals.citationCoverage.met, true);
  assert.equal(result.signals.frontierExhaustion.met, true);
  assert.equal(result.signals.boundaryCoverage.met, true); // 100/(100+100/80)=0.988
  assert.equal(result.converged, true);
});

void test("Chao1 insufficient → recall dimension n/a → ≥2 of 3 rule", async () => {
  const data = fakeData(); // no boundary data, no searchPapers dep
  const result = await assessConvergence(data, "kb", "cycle", { maxPapers: 50 });
  assert.equal(result.signals.boundaryCoverage.insufficientData, true);
  // coverage + exhaustion met = 2 of 3 → converged.
  assert.equal(result.converged, true);
});

void test("not converged when only exhaustion met and boundary n/a", async () => {
  const data = fakeData({
    frontierCounts: async () => ({ total: 10, pending: 1, done: 5, failed: 0, skipped: 0 }),
  });
  const result = await assessConvergence(data, "kb", "cycle", { maxPapers: 50 });
  assert.equal(result.converged, false);
});

void test("Lincoln-Petersen fallback computes Chapman estimate with CI", async () => {
  const ingested = Array.from({ length: 52 }, (_v, index) => `doi:10.1/${index}`);
  const data = fakeData({
    documentDedupKeys: async () => ({ count: 52, dedupKeys: ingested }),
  });
  const sample = [
    ...ingested.slice(0, 25).map((dedupKey) => ({ dedupKey })),
    ...Array.from({ length: 25 }, (_v, index) => ({ dedupKey: `doi:10.2/${index}` })),
  ];
  const estimate = await estimateRecallLp(data, "kb", "ebola", async () => sample);
  assert.equal(estimate.insufficientData, false);
  assert.equal(estimate.n1, 52);
  assert.equal(estimate.n2, 50);
  assert.equal(estimate.m, 25);
  // Chapman N̂ = 53*51/26 - 1 ≈ 102.96; recall ≈ 0.505.
  assert.ok(Math.abs(estimate.estimatedTotal! - 102.96) < 0.5);
  assert.ok(Math.abs(estimate.recall! - 0.505) < 0.01);
  assert.ok(estimate.ciLow! < estimate.estimatedTotal! && estimate.ciHigh! > estimate.estimatedTotal!);
});

void test("L-P insufficient when sample too small or m=0", async () => {
  const data = fakeData({ documentDedupKeys: async () => ({ count: 10, dedupKeys: ["x"] }) });
  const small = await estimateRecallLp(data, "kb", "q", async () => [{ dedupKey: "x" }]);
  assert.equal(small.insufficientData, true);
  const zero = await estimateRecallLp(data, "kb", "q", async () =>
    Array.from({ length: 40 }, (_v, index) => ({ dedupKey: `new-${index}` })),
  );
  assert.equal(zero.insufficientData, true);
});

// ------------------------------------------------------------ patch queries

void test("buildPatchQueries picks anchors and sparse-but-important entities", async () => {
  const entities = [
    { id: "1", name: "GP", supportCount: 10, degree: 8 },
    { id: "2", name: "mAb114", supportCount: 8, degree: 6 },
    { id: "3", name: "EBOV", supportCount: 7, degree: 5 },
    { id: "4", name: "lonely-important", supportCount: 5, degree: 0 },
    { id: "5", name: "minor", supportCount: 1, degree: 0 },
  ];
  const queries = await buildPatchQueries("kb", {
    listEntitiesWithDegree: async () => entities,
    topNeighborNames: async () => new Map([["4", ["GP", "mAb114"]]]),
  });
  assert.equal(queries.filter((query) => query.kind === "anchor").length, 3);
  const sparse = queries.filter((query) => query.kind === "sparse");
  assert.equal(sparse.length, 1);
  assert.equal(sparse[0]?.entityId, "4");
  assert.equal(sparse[0]?.query, "lonely-important GP mAb114");
});

void test("pruneSeeds drops not-ready and proven-zero-yield seeds", () => {
  const docs = [
    { id: "a", status: "ready" },
    { id: "b", status: "error" },
    { id: "c", status: "ready", seedQuality: { admissionRate: 0, total: 8 } },
    { id: "d", status: "ready", seedQuality: { admissionRate: 0, total: 2 } }, // below threshold: kept
    { id: "e", status: "ready", seedQuality: { admissionRate: 0.5, total: 8 } },
  ];
  const result = pruneSeeds(docs);
  assert.deepEqual(result.kept.map((doc) => doc.id), ["a", "d", "e"]);
  assert.equal(result.prunedNotReady, 1);
  assert.equal(result.prunedStale, 1);
});
