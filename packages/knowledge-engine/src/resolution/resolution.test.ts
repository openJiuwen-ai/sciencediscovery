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

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildClusterJudgePrompt,
  buildComponents,
  buildGraphRoots,
  buildJudgePrompt,
  buildMemoryRepo,
  chooseCanonical,
  computeMetrics,
  detectCommunities,
  everyPairCached,
  extractAbbrevPairs,
  findLongForm,
  isLowEntropyName,
  pairKey,
  parseClusterJudgeResponse,
  parseErDataset,
  parseJudgeVerdict,
  resolveEntityCandidate,
  runErItem,
  scoreItem,
  trimOversized,
  ER_GATE,
  DEFAULT_RESOLVER_THRESHOLDS,
  goldClusterOf,
  type ErDataset,
  type ErItem,
  type ResolverEntity,
  type ResolverRepo,
  type ScoredItem,
} from "../index.js";

// --- abbrev (Schwartz–Hearst) --------------------------------------------------

test("extractAbbrevPairs finds Full Name (ABBR) pairs", () => {
  // Schwartz–Hearst returns the MINIMAL long form: the word containing the
  // first aligned character — "Ebola virus glycoprotein (GP)" yields
  // "glycoprotein", not the full noun phrase (DA-faithful).
  const text = "The Ebola virus glycoprotein (GP) mediates entry. GP is cleaved.";
  const pairs = extractAbbrevPairs(text);
  assert.equal(pairs.get("gp"), "glycoprotein");
});

test("findLongForm aligns right-to-left and rejects non-aligning text", () => {
  assert.equal(findLongForm("GP", "the Ebola virus glycoprotein"), "glycoprotein");
  assert.equal(findLongForm("XYZ", "the Ebola virus glycoprotein"), null);
  // "mAb" legitimately aligns against "monoclonal antibody" (m…a…b)
  assert.equal(findLongForm("mAb", "monoclonal antibody"), "monoclonal antibody");
  // 'g' never appears → alignment impossible
  assert.equal(findLongForm("GP", "the spike protein"), null);
  // Same-letter constraint: 'm' aligns mid-word in "immune", so the derived
  // long form starts with 'i' ≠ 'm' → rejected.
  assert.equal(findLongForm("ME", "immune response"), null);
});

test("extractAbbrevPairs: first definition wins, CJK long forms fail silent", () => {
  const pairs = extractAbbrevPairs("埃博拉糖蛋白 (GP) 和 glycoprotein 2 (GP2) 不同。");
  assert.equal(pairs.has("gp"), false); // CJK preceding text does not align
  assert.equal(pairs.get("gp2"), "glycoprotein 2");
});

// --- resolver L0–L2 (deterministic) ---------------------------------------------

function fixtureRepo(entities: ResolverEntity[]): ResolverRepo {
  return {
    getByName: async (_kb, name) => entities.find((e) => e.canonicalName === name),
    findByAlias: async (_kb, alias) => entities.find((e) => e.aliases.includes(alias)),
  };
}

function fixture(id: string, canonicalName: string, overrides: Partial<ResolverEntity> = {}): ResolverEntity {
  return {
    id,
    canonicalName,
    aliases: [],
    entityType: "protein",
    definition: null,
    supportCount: 1,
    trustLevel: "candidate",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

test("L0: exact normalized-name hit merges", async () => {
  const repo = fixtureRepo([fixture("e1", "ebola virus glycoprotein")]);
  const decision = await resolveEntityCandidate(repo, "kb", { name: "Ebola Virus  Glycoprotein", type: "protein" });
  assert.equal(decision.action, "merge");
  assert.equal(decision.targetId, "e1");
  assert.equal(decision.via, "exact");
  assert.deepEqual(decision.attachNames, ["ebola virus glycoprotein"]);
});

test("L1: alias hit merges; candidate aliases probe canonical names too", async () => {
  const repo = fixtureRepo([
    fixture("e1", "ebola virus glycoprotein", { aliases: ["gp"] }),
    fixture("e2", "monoclonal antibody 114"),
  ]);
  const byAlias = await resolveEntityCandidate(repo, "kb", { name: "GP", type: "protein" });
  assert.equal(byAlias.targetId, "e1");
  assert.equal(byAlias.via, "alias");
  const byCandidateAlias = await resolveEntityCandidate(repo, "kb", {
    name: "mAb114",
    type: "antibody",
    aliases: ["Monoclonal Antibody 114"],
  });
  assert.equal(byCandidateAlias.targetId, "e2");
  assert.equal(byCandidateAlias.via, "alias");
});

test("L2: document-internal abbrev pair merges abbreviation into long form", async () => {
  // Schwartz–Hearst yields the minimal long form "glycoprotein" here.
  const repo = fixtureRepo([fixture("e1", "glycoprotein")]);
  const docText = "The Ebola virus glycoprotein (GP) mediates entry.";
  const abbrevMap = extractAbbrevPairs(docText);
  const decision = await resolveEntityCandidate(repo, "kb", { name: "GP", type: "protein" }, { abbrevMap });
  assert.equal(decision.action, "merge");
  assert.equal(decision.targetId, "e1");
  assert.equal(decision.via, "abbrev");
});

test("L2 reverse: long form merges into a graph that only knows the abbreviation", async () => {
  const repo = fixtureRepo([fixture("e1", "gp", { entityType: "protein" })]);
  const abbrevMap = new Map([["gp", "Ebola virus glycoprotein"]]);
  const decision = await resolveEntityCandidate(
    repo,
    "kb",
    { name: "Ebola virus glycoprotein", type: "protein" },
    { abbrevMap },
  );
  assert.equal(decision.targetId, "e1");
  assert.equal(decision.via, "abbrev");
});

test("fail-open: no layers configured and no deterministic hit → new", async () => {
  const repo = fixtureRepo([fixture("e1", "ebola virus glycoprotein")]);
  const decision = await resolveEntityCandidate(repo, "kb", { name: "REGN-EB3", type: "antibody" });
  assert.deepEqual(decision, { action: "new", via: "none" });
});

// --- resolver L3/L4 (embedding + judge, mocked) ---------------------------------

test("L3: cosine ≥ embedHigh + same type + non-core merges directly", async () => {
  const target = fixture("e1", "ebola glycoprotein");
  const repo: ResolverRepo = {
    ...fixtureRepo([target]),
    nearestByEmbedding: async () => [{ ...target, cosine: 0.97 }],
  };
  const decision = await resolveEntityCandidate(
    repo,
    "kb",
    { name: "EBOV GP", type: "protein" },
    { embed: async () => [1, 0, 0] },
  );
  assert.equal(decision.via, "embedding");
  assert.equal(decision.targetId, "e1");
  assert.equal(decision.score, 0.97);
});

test("L3: high cosine but core target does NOT merge directly — judge decides", async () => {
  const core = fixture("e1", "ebola glycoprotein", { trustLevel: "core" });
  const repo: ResolverRepo = {
    ...fixtureRepo([core]),
    nearestByEmbedding: async () => [{ ...core, cosine: 0.99 }],
  };
  const judgedNo = await resolveEntityCandidate(
    repo,
    "kb",
    { name: "EBOV GP", type: "protein" },
    {
      embed: async () => [1, 0, 0],
      judge: async () => ({ verdict: "similar-but-distinct" }),
      budget: { judgeLeft: 2 },
    },
  );
  assert.equal(judgedNo.action, "new");
  const judgedYes = await resolveEntityCandidate(
    repo,
    "kb",
    { name: "EBOV GP", type: "protein" },
    {
      embed: async () => [1, 0, 0],
      judge: async () => ({ verdict: "same", canonical: "Ebola glycoprotein", reason: "same protein" }),
      budget: { judgeLeft: 2 },
    },
  );
  assert.equal(judgedYes.action, "merge");
  assert.equal(judgedYes.via, "llm");
  assert.equal(judgedYes.targetId, "e1");
});

test("L3.5: low-entropy names recall via trgm and judge, never direct-merge on embeddings", async () => {
  // canonicalName "gp1" ≠ candidate "gp" (no L0), aliases empty (no L1),
  // no abbrevMap (no L2) — the trgm channel must drive the merge.
  const target = fixture("e1", "gp1", { entityType: "protein" });
  let embeddingRecallUsed = false;
  const repo: ResolverRepo = {
    ...fixtureRepo([target]),
    similarByName: async () => [{ ...target, sim: 0.9 }],
    nearestByEmbedding: async () => {
      embeddingRecallUsed = true;
      return [{ ...target, cosine: 0.99 }];
    },
  };
  const decision = await resolveEntityCandidate(
    repo,
    "kb",
    { name: "GP", type: "protein" },
    {
      embed: async () => [1],
      judge: async () => ({ verdict: "same", reason: "same" }),
      budget: { judgeLeft: 3 },
    },
  );
  // L1 alias miss (alias list empty) → L3.5 trgm recall → judge same → merge.
  assert.equal(decision.action, "merge");
  assert.equal(decision.via, "llm");
  assert.equal(embeddingRecallUsed, false); // trgm recalled → embedding channel skipped
});

test("L4: judge walks ALL gray-zone neighbors in recall order, not just top-1", async () => {
  const wrong = fixture("e1", "generic protein", { entityType: "protein" });
  const right = fixture("e2", "ebola glycoprotein", { entityType: "protein" });
  const repo: ResolverRepo = {
    ...fixtureRepo([wrong, right]),
    nearestByEmbedding: async () => [
      { ...wrong, cosine: 0.9 },
      { ...right, cosine: 0.85 },
      { ...fixture("e3", "below floor", { entityType: "protein" }), cosine: 0.7 },
    ],
  };
  const decision = await resolveEntityCandidate(
    repo,
    "kb",
    { name: "EBOV GP", type: "protein" },
    {
      embed: async () => [1, 0, 0],
      judge: async (_a, b) => ({
        verdict: b.name === "ebola glycoprotein" ? "same" : "similar-but-distinct",
      }),
      budget: { judgeLeft: 5 },
    },
  );
  assert.equal(decision.targetId, "e2");
  assert.equal(decision.score, 0.85);
});

test("L4: budget exhaustion and judge failure both fail open to new", async () => {
  const target = fixture("e1", "ebola glycoprotein");
  const repo: ResolverRepo = {
    ...fixtureRepo([target]),
    nearestByEmbedding: async () => [{ ...target, cosine: 0.9 }],
  };
  const broke = await resolveEntityCandidate(
    repo,
    "kb",
    { name: "EBOV GP", type: "protein" },
    {
      embed: async () => [1],
      judge: async () => {
        throw new Error("model down");
      },
      budget: { judgeLeft: 3 },
    },
  );
  assert.equal(broke.action, "new");
  const noBudget = await resolveEntityCandidate(
    repo,
    "kb",
    { name: "EBOV GP", type: "protein" },
    {
      embed: async () => [1],
      judge: async () => ({ verdict: "same" }),
      budget: { judgeLeft: 0 },
    },
  );
  assert.equal(noBudget.action, "new");
});

test("isLowEntropyName: ≤4 normalized chars", () => {
  assert.equal(isLowEntropyName("gp"), true);
  assert.equal(isLowEntropyName("mab1"), true);
  assert.equal(isLowEntropyName("mab114"), false);
});

test("judge prompt/parse round-trip incl. code fences and salvage", () => {
  const prompt = buildJudgePrompt({ name: "GP", type: "protein" }, { name: "glycoprotein", type: "protein" });
  assert.match(prompt, /实体 A/);
  const verdict = parseJudgeVerdict('```json\n{"verdict": "same", "canonical": "glycoprotein", "reason": "abbr"}\n```');
  assert.deepEqual(verdict, { verdict: "same", canonical: "glycoprotein", reason: "abbr" });
  assert.equal(parseJudgeVerdict("no json here"), null);
  assert.equal(parseJudgeVerdict('{"verdict": "maybe"}'), null);
});

// --- merge policy -----------------------------------------------------------------

test("chooseCanonical: LLM suggestion > support > core > informativeness > age", () => {
  const a = { id: "a", canonicalName: "GP", supportCount: 5, trustLevel: "candidate", createdAt: "2026-01-01" };
  const b = { id: "b", canonicalName: "Ebola virus glycoprotein", supportCount: 3, trustLevel: "candidate", createdAt: "2026-01-02" };
  // LLM suggestion wins over support
  assert.equal(chooseCanonical(a, b, "ebola virus glycoprotein").id, "b");
  // Otherwise support wins
  assert.equal(chooseCanonical(a, b).id, "a");
  // Equal support → more informative (longer, non-abbrev) name wins
  const c = { ...a, supportCount: 3 };
  assert.equal(chooseCanonical(c, b).id, "b");
  // Core trust beats informativeness
  const core = { ...a, supportCount: 3, trustLevel: "core" };
  assert.equal(chooseCanonical(core, b).id, "a");
  // Full tie → earlier created
  const d = { ...b, canonicalName: "Ebola virus glycoprotein", createdAt: "2026-01-03" };
  assert.equal(chooseCanonical(b, d).id, "b");
});

// --- batch helpers ------------------------------------------------------------------

test("pairKey orders ids; buildComponents unions transitively and drops singletons", () => {
  assert.equal(pairKey("b", "a"), "a|b");
  const pairs = [
    { aId: "a", bId: "b", score: 0.9 },
    { aId: "b", bId: "c", score: 0.8 },
    { aId: "x", bId: "y", score: 0.85 },
  ];
  const components = buildComponents(pairs);
  assert.equal(components.length, 2);
  const sizes = components.map((c) => c.length).sort();
  assert.deepEqual(sizes, [2, 3]);
  assert.deepEqual(buildComponents([{ aId: "a", bId: "a", score: 1 }]), []);
});

test("trimOversized drops weakest edges until no component exceeds maxSize", () => {
  // Chain of 5 nodes, maxSize 3 → weakest links removed until pieces fit.
  const chain = [
    { aId: "a", bId: "b", score: 0.9 },
    { aId: "b", bId: "c", score: 0.5 },
    { aId: "c", bId: "d", score: 0.8 },
    { aId: "d", bId: "e", score: 0.7 },
  ];
  const trimmed = trimOversized(chain, 3);
  const components = buildComponents(trimmed);
  assert.ok(components.every((c) => c.length <= 3));
  assert.ok(trimmed.length < chain.length);
});

test("everyPairCached requires ALL unordered pairs present", () => {
  const cache = new Set([pairKey("a", "b"), pairKey("a", "c")]);
  assert.equal(everyPairCached(["a", "b", "c"], cache), false);
  cache.add(pairKey("b", "c"));
  assert.equal(everyPairCached(["a", "b", "c"], cache), true);
});

test("cluster judge prompt/parse: valid groups kept, junk dropped", () => {
  const prompt = buildClusterJudgePrompt([
    { name: "GP", type: "protein" },
    { name: "glycoprotein", type: "protein", definition: "surface protein" },
  ]);
  assert.match(prompt, /1\. GP \(protein\)/);
  const groups = parseClusterJudgeResponse(
    '{"groups": [{"canonical": "glycoprotein", "members": [1, 2], "reason": "abbr"}, {"canonical": "x", "members": [9]}, {"canonical": "y", "members": "no"}]}',
    2,
  );
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]!.members, [1, 2]);
  assert.equal(parseClusterJudgeResponse("garbage", 3).length, 0);
});

// --- Louvain -------------------------------------------------------------------------

test("detectCommunities: two obvious clusters partition cleanly and deterministically", () => {
  // Cluster 1: a-b-c fully interconnected; cluster 2: x-y-z; one weak bridge.
  const edges = [
    { source: "a", target: "b", weight: 5 },
    { source: "a", target: "c", weight: 5 },
    { source: "b", target: "c", weight: 5 },
    { source: "x", target: "y", weight: 5 },
    { source: "x", target: "z", weight: 5 },
    { source: "y", target: "z", weight: 5 },
    { source: "c", target: "x", weight: 1 },
  ];
  const nodeIds = ["a", "b", "c", "x", "y", "z"];
  const first = detectCommunities({ nodeIds, edges });
  const second = detectCommunities({ nodeIds: [...nodeIds].reverse(), edges });
  // Deterministic: same partition shape regardless of input order is NOT
  // guaranteed (id order is the tiebreak), but identical inputs must agree.
  assert.deepEqual([...detectCommunities({ nodeIds, edges }).entries()], [...first.entries()]);
  assert.equal(first.get("a"), first.get("b"));
  assert.equal(first.get("b"), first.get("c"));
  assert.equal(first.get("x"), first.get("y"));
  assert.equal(first.get("y"), first.get("z"));
  assert.notEqual(first.get("a"), first.get("x"));
  // second run (reversed input) still yields exactly two communities
  assert.equal(new Set(second.values()).size, 2);
});

test("detectCommunities: edgeless graph → every node its own community", () => {
  const partition = detectCommunities({ nodeIds: ["a", "b"], edges: [] });
  assert.notEqual(partition.get("a"), partition.get("b"));
});

// --- graph roots -----------------------------------------------------------------------

test("buildGraphRoots: communities sized/sorted, rep = max support, inter-community edges aggregated", async () => {
  const entities = [
    { id: "a", name: "Alpha", type: "protein", supportCount: 5 },
    { id: "b", name: "Beta", type: "protein", supportCount: 3 },
    { id: "x", name: "Xray", type: "method", supportCount: 4 },
    { id: "y", name: "Yankee", type: "method", supportCount: 2 },
  ];
  const edges = [
    { srcId: "a", dstId: "b", supportCount: 4 },
    { srcId: "x", dstId: "y", supportCount: 3 },
    { srcId: "b", dstId: "x", supportCount: 1 }, // the bridge
  ];
  const { roots, assignments } = await buildGraphRoots(entities, edges, "fp:test", async (comms) =>
    new Map(
      comms.map((c) => [
        c.id,
        c.topEntities.some((e) => e.id === "a") ? "Alpha community" : c.name,
      ]),
    ),
  );
  assert.equal(roots.method, "louvain");
  assert.equal(roots.entityCount, 4);
  assert.equal(roots.communities.length, 2);
  assert.equal(roots.communities[0]!.size, 2);
  // Namer renamed the community containing 'a'
  const alphaComm = roots.communities.find((c) => c.repEntity.id === "a");
  assert.equal(alphaComm?.name, "Alpha community");
  // One inter-community edge with weight 1
  assert.equal(roots.communityEdges.length, 1);
  assert.equal(roots.communityEdges[0]!.weight, 1);
  assert.equal(assignments.size, 4);
});

test("buildGraphRoots: dangling edges dropped defensively; namer failure falls back to rep name", async () => {
  const entities = [
    { id: "a", name: "Alpha", type: "protein", supportCount: 1 },
    { id: "b", name: "Beta", type: "protein", supportCount: 1 },
  ];
  const edges = [
    { srcId: "a", dstId: "b", supportCount: 2 },
    { srcId: "a", dstId: "ghost", supportCount: 9 }, // dangling — must not reach Louvain
  ];
  const { roots } = await buildGraphRoots(entities, edges, "fp:test", async () => {
    throw new Error("namer down");
  });
  assert.equal(roots.edgeCount, 1);
  assert.equal(roots.communities.length, 1);
  assert.equal(roots.communities[0]!.name, "Alpha");
});

// --- eval harness ------------------------------------------------------------------------

test("parseErDataset validates kind and same→expectTarget integrity", () => {
  const good = JSON.stringify({
    id: "t",
    kind: "entity-resolution",
    graph: [{ id: "e1", name: "GP", type: "protein" }],
    items: [
      { id: "i1", gold: "same", candidate: { name: "gp", type: "protein" }, expectTarget: "e1" },
      { id: "i2", gold: "similar", candidate: { name: "GP2", type: "protein" } },
    ],
  });
  const ds = parseErDataset(good);
  assert.equal(ds.items.length, 2);
  assert.throws(() =>
    parseErDataset(
      JSON.stringify({
        id: "t",
        kind: "entity-resolution",
        graph: [],
        items: [{ id: "i1", gold: "same", candidate: { name: "x", type: "t" }, expectTarget: "ghost" }],
      }),
    ),
  );
  assert.throws(() =>
    parseErDataset(
      JSON.stringify({
        id: "t",
        kind: "entity-resolution",
        graph: [{ id: "e1", name: "x", type: "t" }],
        items: [{ id: "i1", gold: "similar", candidate: { name: "x", type: "t" }, expectTarget: "e1" }],
      }),
    ),
  );
});

test("scoreItem: merge correctness matrix", () => {
  const same: ErItem = { id: "s", gold: "same", candidate: { name: "x", type: "t" }, expectTarget: "e1" };
  assert.equal(scoreItem(same, { action: "merge", targetId: "e1", via: "exact" }).predicted, "merge-correct");
  assert.equal(scoreItem(same, { action: "merge", targetId: "e2", via: "llm" }).predicted, "merge-wrong-target");
  assert.equal(scoreItem(same, { action: "new", via: "none" }).predicted, "new");
  const sim: ErItem = { id: "d", gold: "similar", candidate: { name: "x", type: "t" } };
  assert.equal(scoreItem(sim, { action: "new", via: "none" }).correct, true);
  assert.equal(scoreItem(sim, { action: "merge", targetId: "e1", via: "alias" }).predicted, "merge-on-new");
});

test("computeMetrics: perfect run passes the ship gate; a false merge sinks precision", () => {
  const perfect: ScoredItem[] = [
    { id: "s1", gold: "same", predicted: "merge-correct", correct: true, decision: { action: "merge", targetId: "e1", via: "alias" } },
    { id: "s2", gold: "same", predicted: "merge-correct", correct: true, decision: { action: "merge", targetId: "e1", via: "exact" } },
    { id: "d1", gold: "similar", predicted: "new", correct: true, decision: { action: "new", via: "none" } },
  ];
  const clusterOf = (id: string) => (id.startsWith("s") ? "g:e1" : `g:${id}`);
  const m = computeMetrics(perfect, clusterOf);
  assert.equal(m.pairwise.precision, 1);
  assert.equal(m.pairwise.recall, 1);
  assert.equal(m.gate.pass, true);

  const withFalseMerge: ScoredItem[] = [
    ...perfect,
    { id: "d2", gold: "similar", predicted: "merge-on-new", correct: false, decision: { action: "merge", targetId: "e1", via: "embedding" } },
  ];
  const m2 = computeMetrics(withFalseMerge, clusterOf);
  assert.equal(m2.pairwise.precision, 2 / 3);
  assert.equal(m2.gate.precisionOk, false);
  assert.equal(m2.gate.pass, false);
  assert.ok(ER_GATE.minPrecision >= 0.95 && ER_GATE.minRecall >= 0.6);
});

test("runErItem + buildMemoryRepo: deterministic L0–L2 over a fixture graph", async () => {
  const dataset: ErDataset = {
    id: "t",
    kind: "entity-resolution",
    graph: [
      { id: "e-gp", name: "Ebola virus glycoprotein", type: "protein", aliases: ["GP"] },
      { id: "e-mab", name: "mAb114", type: "antibody" },
    ],
    items: [
      { id: "i1", gold: "same", candidate: { name: "Ebola Virus Glycoprotein", type: "protein" }, expectTarget: "e-gp" },
      { id: "i2", gold: "same", candidate: { name: "GP", type: "protein" }, expectTarget: "e-gp" },
      { id: "i3", gold: "unrelated", candidate: { name: "Interferon gamma", type: "protein" } },
    ],
  };
  const repo = buildMemoryRepo(dataset.graph);
  const scored = [];
  for (const item of dataset.items) {
    scored.push(await runErItem(item, repo));
  }
  assert.deepEqual(
    scored.map((s) => s.predicted),
    ["merge-correct", "merge-correct", "new"],
  );
  const metrics = computeMetrics(scored, goldClusterOf(dataset));
  assert.equal(metrics.gate.pass, true);
});

test("runErItem: docText drives the L2 abbrev map per item", async () => {
  const dataset: ErDataset = {
    id: "t",
    kind: "entity-resolution",
    graph: [{ id: "e-gp", name: "glycoprotein", type: "protein" }],
    items: [
      {
        id: "i1",
        gold: "same",
        candidate: { name: "GP", type: "protein" },
        docText: "The Ebola virus glycoprotein (GP) mediates entry.",
        expectTarget: "e-gp",
      },
    ],
  };
  const repo = buildMemoryRepo(dataset.graph);
  const scored = await runErItem(dataset.items[0]!, repo);
  assert.equal(scored.predicted, "merge-correct");
  assert.equal(scored.decision.via, "abbrev");
});

test("DEFAULT_RESOLVER_THRESHOLDS stay DA-calibrated", () => {
  assert.deepEqual(DEFAULT_RESOLVER_THRESHOLDS, {
    embedHigh: 0.95,
    embedLow: 0.8,
    trgmCandidate: 0.5,
    maxJudgePerDoc: 8,
    coreEntityListSize: 50,
  });
});
