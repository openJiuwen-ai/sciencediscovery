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
  DRIFT_EVIDENCE_MAX_CHARS,
  driftSearch,
  type DriftDataAccess,
  type DriftIntraEdge,
  type DriftMember,
  type DriftReportCard,
} from "./drift.js";

interface Fixture {
  fingerprint?: string | null;
  reports: DriftReportCard[];
  membersByCommunity: Map<number, DriftMember[]>;
  edgesByCommunity: Map<number, DriftIntraEdge[]>;
  latestReadyFingerprint?: string | null;
  latestReadyCalls?: number;
}

function dataAccess(fixture: Fixture): DriftDataAccess {
  return {
    graphFingerprint: async () => fixture.fingerprint ?? null,
    listCommunityReports: async (_kbId, fingerprint) =>
      fixture.fingerprint === fingerprint ? fixture.reports : [],
    listEntitiesByCommunity: async (_kbId, communityId) =>
      fixture.membersByCommunity.get(communityId) ?? [],
    listEdgesWithinCommunity: async (_kbId, communityId) =>
      fixture.edgesByCommunity.get(communityId) ?? [],
    latestReadyFingerprint: async () => {
      fixture.latestReadyCalls = (fixture.latestReadyCalls ?? 0) + 1;
      return fixture.latestReadyFingerprint ?? null;
    },
  };
}

function member(id: string, name: string, supportCount: number, description: string | null = null): DriftMember {
  return { id, name, type: "entity", description, supportCount };
}

function edge(id: string, srcId: string, dstId: string, quote: string | null, supportCount = 1, evidenceDocId: string | null = null): DriftIntraEdge {
  return { id, srcId, dstId, type: "relates_to", supportCount, evidenceQuote: quote, evidenceDocId };
}

function report(communityId: number, title: string, summary: string, findings: string[] = [], rating: number | null = 5): DriftReportCard {
  return { communityId, communityName: `Community #${communityId}`, title, summary, rating, findingSummaries: findings };
}

test("drift: empty states are honest — no graph, no terms, never-generated, stale generation", async () => {
  const noGraph = await driftSearch("kb", "interferon signaling", dataAccess({ reports: [], membersByCommunity: new Map(), edgesByCommunity: new Map() }));
  assert.equal(noGraph.status, "no-graph");
  assert.match(noGraph.note ?? "", /no graph has been computed/);

  const fixture: Fixture = {
    fingerprint: "fp-now",
    reports: [],
    membersByCommunity: new Map(),
    edgesByCommunity: new Map(),
    latestReadyFingerprint: null,
  };
  const never = await driftSearch("kb", "interferon signaling", dataAccess(fixture));
  assert.equal(never.status, "no-reports");
  assert.match(never.note ?? "", /no community reports exist for the current graph generation/);
  assert.equal(fixture.latestReadyCalls, 1);

  fixture.latestReadyFingerprint = "fp-old";
  const stale = await driftSearch("kb", "interferon signaling", dataAccess(fixture));
  assert.equal(stale.status, "no-reports");
  assert.match(stale.note ?? "", /older graph generation/);

  // No letters or digits at all — a genuinely termless query. (A lone Han
  // character WOULD be a searchable term by design.)
  const noTerms = await driftSearch("kb", "  -- && ?? ", dataAccess({
    fingerprint: "fp-now",
    reports: [report(1, "T", "interferon cluster summary")],
    membersByCommunity: new Map(),
    edgesByCommunity: new Map(),
  }));
  assert.equal(noTerms.status, "no-terms");
});

test("drift: stage 1 selects the matching community and explains the match", async () => {
  const fixture: Fixture = {
    fingerprint: "fp-1",
    reports: [
      report(7, "Antibody engineering", "mAb114 and REGN3471 bind the Ebola glycoprotein spike."),
      report(2, "Interferon signaling", "Type I interferon responses drive ISG expression after infection.", ["ISG15 is an interferon-stimulated gene."], 9),
    ],
    membersByCommunity: new Map([[2, [member("e1", "interferon-alpha", 4), member("e2", "ISG15", 3)]]]),
    edgesByCommunity: new Map(),
  };
  const result = await driftSearch("kb", "interferon stimulated genes", dataAccess(fixture));

  assert.equal(result.status, "ok");
  assert.equal(result.fingerprint, "fp-1");
  assert.equal(result.communities.length, 1);
  const section = result.communities[0]!;
  assert.equal(section.communityId, 2);
  assert.equal(section.title, "Interferon signaling");
  assert.ok(section.reportMatchedTerms.includes("interferon"));
  // Title hits weigh double but community 7 has no term at all.
  assert.equal(section.reportScore > 0, true);
});

test("drift: seeds prefer query-matched members, then support-fill with orientation entries", async () => {
  const fixture: Fixture = {
    fingerprint: "fp-1",
    reports: [report(3, "Antiviral defense", "Interferon-mediated antiviral defense around RIG-I-like sensors.")],
    membersByCommunity: new Map([
      [3, [
        member("m1", "Interferon-alpha", 10),
        member("m2", "ISG15", 8, "interferon-stimulated gene"),
        member("m3", "HighSupportUnrelated", 50),
        member("m4", "RIG-I", 6, "cytosolic RNA sensor"),
      ]],
    ]),
    edgesByCommunity: new Map(),
  };
  const result = await driftSearch("kb", "interferon alpha", dataAccess(fixture), { seedsPerCommunity: 3 });

  const seeds = result.communities[0]!.seedEntities;
  assert.equal(seeds.length, 3);
  // m1 matches "interferon"+"alpha" in the name, m2 matches "interferon" via
  // description; the third slot goes to the support fill (m3, top support
  // among the unmatched) with EMPTY matchedTerms — orientation, not a claim
  // of lexical relevance.
  assert.deepEqual(
    seeds.map((seed) => seed.name).sort(),
    ["HighSupportUnrelated", "ISG15", "Interferon-alpha"],
  );
  const byName = new Map(seeds.map((seed) => [seed.name, seed]));
  assert.deepEqual([...(byName.get("Interferon-alpha")?.matchedTerms ?? [])].sort(), ["alpha", "interferon"]);
  assert.equal(byName.get("HighSupportUnrelated")?.matchedTerms.length, 0);

  // Shrink the matched set to one: the support-fill takes over (top support
  // among unmatched), and the fill carries empty matchedTerms.
  const narrow = await driftSearch("kb", "rig-i sensors", dataAccess(fixture), { seedsPerCommunity: 2 });
  const narrowSeeds = narrow.communities[0]!.seedEntities;
  assert.equal(narrowSeeds.length, 2);
  assert.equal(narrowSeeds[0]!.name, "RIG-I");
  assert.deepEqual(narrowSeeds[0]!.matchedTerms, ["rig"]);
  assert.equal(narrowSeeds[1]!.matchedTerms.length, 0);
  assert.equal(narrowSeeds[1]!.name, "HighSupportUnrelated");
});

test("drift: evidence edges rank by term hits with full tie-breaks; unmatched edges never pad", async () => {
  const fixture: Fixture = {
    fingerprint: "fp-1",
    reports: [report(4, "Ebola therapeutics", "antibody therapy against Ebola virus")],
    membersByCommunity: new Map([
      [4, [member("a", "mAb114", 9), member("b", "GP", 8), member("c", "Ebola virus", 7)]],
    ]),
    edgesByCommunity: new Map([
      [4, [
        edge("x1", "a", "b", "mAb114 binds the Ebola glycoprotein", 1),
        edge("x2", "a", "c", "mAb114 neutralizes the virus", 5),
        edge("x3", "b", "c", "unrelated quote about something else", 9),
      ]],
    ]),
  };
  const result = await driftSearch("kb", "Ebola glycoprotein", dataAccess(fixture));

  const evidence = result.communities[0]!.evidenceEdges;
  // Every edge that mentions a query term in its quote OR endpoint names is
  // in (x3 via the "Ebola virus" endpoint); ranking is term score first, then
  // support (x3 support 9 beats x2's 5 at equal score).
  assert.deepEqual(
    evidence.map((entry) => `${entry.source}->${entry.target}`),
    ["mAb114->GP", "GP->Ebola virus", "mAb114->Ebola virus"],
  );
  assert.equal(result.communities[0]!.edgeTruncated, false);
  for (const entry of evidence) {
    assert.ok(entry.matchedTerms.length > 0);
    assert.ok((entry.evidenceQuote ?? "").length <= DRIFT_EVIDENCE_MAX_CHARS);
  }
});

test("drift: a query that lexically misses every report returns ok with an honest note", async () => {
  const fixture: Fixture = {
    fingerprint: "fp-1",
    reports: [report(1, "Antibody engineering", "mAb114 binds the glycoprotein")],
    membersByCommunity: new Map(),
    edgesByCommunity: new Map(),
  };
  const result = await driftSearch("kb", "crispr cas9 editing", dataAccess(fixture));
  assert.equal(result.status, "ok");
  assert.deepEqual(result.communities, []);
  assert.match(result.note ?? "", /no community report lexically matches/);
});

test("drift: long evidence quotes are clamped and edge truncation is surfaced", async () => {
  const longQuote = "Ebola ".repeat(200).trim();
  const edges: DriftIntraEdge[] = Array.from({ length: 9 }, (_, i) =>
    edge(`x${i}`, "a", "b", `${longQuote} #${i}`, 9 - i));
  const fixture: Fixture = {
    fingerprint: "fp-1",
    reports: [report(1, "Ebola community", "Ebola topics")],
    membersByCommunity: new Map([[1, [member("a", "Ebola virus", 9), member("b", "GP", 8)]]]),
    edgesByCommunity: new Map([[1, edges]]),
  };
  const result = await driftSearch("kb", "Ebola", dataAccess(fixture));
  const section = result.communities[0]!;
  assert.equal(section.evidenceEdges.length, 6); // DRIFT_EDGES_PER_COMMUNITY
  assert.equal(section.edgeTruncated, true);
  for (const entry of section.evidenceEdges) {
    assert.ok((entry.evidenceQuote ?? "").length <= DRIFT_EVIDENCE_MAX_CHARS + 1);
    assert.ok((entry.evidenceQuote ?? "").endsWith("…"));
  }
});

test("drift: report ranking is score desc then rating then communityId (deterministic)", async () => {
  const fixture: Fixture = {
    fingerprint: "fp-1",
    reports: [
      report(11, "Interferon A", "interferon", [], 2),
      report(5, "Interferon B", "interferon", [], 8),
      report(9, "Interferon C", "interferon", [], 8),
      report(1, "Unrelated", "nothing matching", [], 10),
    ],
    membersByCommunity: new Map(),
    edgesByCommunity: new Map(),
  };
  const result = await driftSearch("kb", "interferon", dataAccess(fixture), { maxCommunities: 3 });
  assert.deepEqual(
    result.communities.map((section) => section.communityId),
    [5, 9, 11],
  );
});
