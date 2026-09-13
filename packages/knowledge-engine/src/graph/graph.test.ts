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
  buildResidentSummary,
  conceptExplore,
  deepDive,
  entityUnifiedSearch,
  findGaps,
  resolveFromEntities,
  validateEntities,
  RESIDENT_SUMMARY_HARD_CAP,
  type ExploreDataAccess,
  type ExploreEdge,
  type ExploreEntity,
  type GapEdge,
  type GapEntity,
  type ResidentEntity,
  type ResidentSummaryDataAccess,
} from "../index.js";

function entity(id: string, name: string, overrides: Partial<ExploreEntity> = {}): ExploreEntity {
  return {
    id,
    name,
    type: "protein",
    description: null,
    aliases: [],
    supportCount: 1,
    trustLevel: "low",
    ...overrides,
  };
}

function edge(id: string, srcId: string, dstId: string, type: string, supportCount = 1): ExploreEdge {
  return { id, srcId, dstId, type, supportCount, evidenceQuote: `quote ${id}`, evidenceDocId: "doc1" };
}

function fakeData(entities: ExploreEntity[], edges: ExploreEdge[]): ExploreDataAccess {
  return {
    listEntities: async () => entities,
    listEdgesByEntity: async (_kbId, entityId) =>
      edges.filter((candidate) => candidate.srcId === entityId || candidate.dstId === entityId),
    documentTitle: async (docId) => (docId === "doc1" ? "Paper One" : null),
  };
}

// ------------------------------------------------------------- resolution

void test("resolveFromEntities: exact → alias → substring, ambiguity returns candidates", () => {
  const all = [
    entity("1", "mAb114", { aliases: ["MAB 114"] }),
    entity("2", "REGN3471"),
    entity("3", "REGN3479"),
  ];
  // Exact (case/space-insensitive via alias normalization)
  assert.equal(resolveFromEntities("mab114", all).entity?.id, "1");
  assert.equal(resolveFromEntities("MAB 114", all).entity?.id, "1"); // alias
  // Substring single match
  assert.equal(resolveFromEntities("mAb", all).entity?.id, "1");
  // Substring multiple → candidates, never a guess
  const ambiguous = resolveFromEntities("REGN", all);
  assert.equal(ambiguous.entity, undefined);
  assert.equal(ambiguous.candidates?.length, 2);
  // Unknown
  assert.deepEqual(resolveFromEntities("nonexistent", all), {});
  assert.deepEqual(resolveFromEntities("  ", all), {});
});

// ------------------------------------------------------------- explore

void test("conceptExplore: 1-hop neighbors sorted by edge support, 2-hop expands strongest", async () => {
  const entities = [entity("c", "Center"), entity("a", "A"), entity("b", "B"), entity("d", "D"), entity("e", "E")];
  const edges = [
    edge("e1", "c", "a", "binds", 5),
    edge("e2", "b", "c", "inhibits", 2), // incoming direction
    edge("e3", "a", "d", "uses", 9),
    edge("e4", "a", "e", "uses", 1),
  ];
  const one = await conceptExplore("kb", "center", fakeData(entities, edges), { hops: 1 });
  assert.equal(one.found, true);
  assert.equal(one.neighbors?.length, 2);
  assert.equal(one.neighbors?.[0]?.entity.name, "A"); // higher edge support first
  assert.equal(one.neighbors?.[0]?.direction, "out");
  assert.equal(one.neighbors?.[1]?.direction, "in");

  const two = await conceptExplore("kb", "center", fakeData(entities, edges), { hops: 2 });
  assert.equal(two.neighbors?.length, 4);
  const hop2 = two.neighbors?.filter((neighbor) => neighbor.hop === 2);
  assert.deepEqual(hop2?.map((neighbor) => neighbor.entity.name).sort(), ["D", "E"]);

  // "zzzz" matches nothing (watch out: one-char names substring-match almost
  // anything — the DA substring rule is intentionally permissive).
  const missing = await conceptExplore("kb", "zzzz", fakeData(entities, edges));
  assert.equal(missing.found, false);
});

void test("deepDive returns evidence with verbatim quotes and doc titles", async () => {
  const entities = [entity("c", "Center"), entity("a", "A")];
  const edges = [edge("e1", "c", "a", "binds", 3)];
  const result = await deepDive("kb", "center", fakeData(entities, edges));
  assert.equal(result.found, true);
  assert.equal(result.evidence?.length, 1);
  assert.equal(result.evidence?.[0]?.evidenceQuote, "quote e1");
  assert.equal(result.evidence?.[0]?.evidenceDocName, "Paper One");
  assert.equal(result.evidence?.[0]?.direction, "out");
});

// ------------------------------------------------------------- validate

void test("validateEntities classifies found/ambiguous/unknown", async () => {
  const data = fakeData(
    [entity("1", "mAb114"), entity("2", "REGN3471"), entity("3", "REGN3479")],
    [],
  );
  const result = await validateEntities("kb", ["mAb114", "REGN", "fiction-protein"], data);
  assert.deepEqual(
    result.results.map((entry) => entry.status),
    ["found", "ambiguous", "unknown"],
  );
  assert.equal(result.found, 1);
  assert.equal(result.ambiguous, 1);
  assert.equal(result.unknown, 1);
});

// ------------------------------------------------------------- unified

void test("entityUnifiedSearch: independent sections, merged candidates, documents via dep", async () => {
  const entities = [entity("1", "GP"), entity("2", "NPC1")];
  const edges = [edge("e1", "1", "2", "binds", 2)];
  const data = fakeData(entities, edges);
  const result = await entityUnifiedSearch("kb", "GP", data, {}, {
    searchDocuments: async () => [{ docId: "doc1", title: "Paper One", snippet: "GP binds NPC1 …" }],
  });
  assert.equal(result.sources.graph.status, "ok");
  assert.equal(result.sources.graph.center?.name, "GP");
  assert.equal(result.sources.evidence.status, "ok");
  assert.equal(result.sources.documents.status, "ok");
  assert.equal(result.sources.documents.hits?.length, 1);
  // Citations section: explicitly not enabled in this build.
  assert.equal(result.sources.citations.status, "error");

  // Ambiguity merges candidates from graph + evidence (deduped by id).
  const ambiguous = await entityUnifiedSearch("kb", "G", {
    ...data,
    listEntities: async () => [entity("1", "GP"), entity("2", "GP1")],
  });
  assert.equal(ambiguous.sources.graph.status, "ambiguous");
  assert.ok(ambiguous.candidates && ambiguous.candidates.length >= 2);

  // A failing source degrades alone.
  const broken = await entityUnifiedSearch("kb", "GP", data, {}, {
    searchDocuments: async () => {
      throw new Error("fts down");
    },
  });
  assert.equal(broken.sources.documents.status, "error");
  assert.equal(broken.sources.graph.status, "ok");
});

// ------------------------------------------------------------- gaps

void test("findGaps: holes need ≥3 shared neighbors and no direct edge", () => {
  const entities: GapEntity[] = [
    { id: "a", name: "A", type: "t", supportCount: 10, communityId: 1 },
    { id: "b", name: "B", type: "t", supportCount: 9, communityId: 2 },
    { id: "s1", name: "S1", type: "t", supportCount: 5, communityId: 1 },
    { id: "s2", name: "S2", type: "t", supportCount: 4, communityId: 1 },
    { id: "s3", name: "S3", type: "t", supportCount: 3, communityId: 1 },
  ];
  const links: GapEdge[] = [
    { id: "1", srcId: "a", dstId: "s1", type: "binds", supportCount: 1, evidenceQuote: null },
    { id: "2", srcId: "a", dstId: "s2", type: "binds", supportCount: 1, evidenceQuote: null },
    { id: "3", srcId: "a", dstId: "s3", type: "binds", supportCount: 1, evidenceQuote: null },
    { id: "4", srcId: "b", dstId: "s1", type: "binds", supportCount: 1, evidenceQuote: null },
    { id: "5", srcId: "b", dstId: "s2", type: "binds", supportCount: 1, evidenceQuote: null },
    { id: "6", srcId: "b", dstId: "s3", type: "binds", supportCount: 1, evidenceQuote: null },
  ];
  const result = findGaps(entities, links);
  assert.equal(result.holes.length, 1);
  assert.equal(result.holes[0]?.score, 3);
  assert.deepEqual(result.holes[0]?.commonNeighbors, ["S1", "S2", "S3"]); // by support desc
  assert.equal(result.holes[0]?.crossCommunity, true); // different communities
});

void test("findGaps: conflicts rank by support; transfers need a uses-edge and no dst-method link", () => {
  const entities: GapEntity[] = [
    { id: "a", name: "A", type: "t", supportCount: 10, communityId: null },
    { id: "b", name: "B", type: "t", supportCount: 9, communityId: null },
    { id: "m", name: "Method M", type: "method", supportCount: 8, communityId: null },
    { id: "s1", name: "S1", type: "t", supportCount: 5, communityId: null },
    { id: "s2", name: "S2", type: "t", supportCount: 5, communityId: null },
    { id: "x", name: "X", type: "t", supportCount: 7, communityId: null },
    { id: "y", name: "Y", type: "t", supportCount: 6, communityId: null },
  ];
  const links: GapEdge[] = [
    { id: "c1", srcId: "x", dstId: "y", type: "contradicts", supportCount: 4, evidenceQuote: "conflict quote" },
    { id: "1", srcId: "a", dstId: "s1", type: "binds", supportCount: 1, evidenceQuote: null },
    { id: "2", srcId: "a", dstId: "s2", type: "binds", supportCount: 1, evidenceQuote: null },
    { id: "3", srcId: "b", dstId: "s1", type: "binds", supportCount: 1, evidenceQuote: null },
    { id: "4", srcId: "b", dstId: "s2", type: "binds", supportCount: 1, evidenceQuote: null },
    { id: "5", srcId: "a", dstId: "m", type: "uses", supportCount: 1, evidenceQuote: null },
  ];
  const result = findGaps(entities, links);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0]?.edgeType, "contradicts");
  assert.equal(result.conflicts[0]?.sampleQuote, "conflict quote");
  // A uses M; B shares S1,S2 with A; B has no link to M → transfer M: A→B.
  assert.equal(result.transfers.length, 1);
  assert.equal(result.transfers[0]?.method.name, "Method M");
  assert.equal(result.transfers[0]?.from.name, "A");
  assert.equal(result.transfers[0]?.to.name, "B");
  // minCommon=3 default means the A-B pair (2 shared) is NOT a hole.
  assert.equal(result.holes.length, 0);
});

// ------------------------------------------------------------- resident summary

function fakeResidentData(
  entities: ResidentEntity[],
  edges: Array<{ srcId: string; dstId: string; type: string; supportCount: number }>,
  engineState: { converged?: boolean } | null,
): ResidentSummaryDataAccess {
  return {
    countEntities: async () => entities.length,
    countEdges: async () => edges.length,
    engineState: async () => engineState,
    topEntitiesBySupport: async (_kbId, limit) => entities.slice(0, limit),
    topEdgesBySupport: async (_kbId, limit) => edges.slice(0, limit),
    entityName: async (id) => entities.find((entity) => entity.id === id)?.name ?? null,
  };
}

const residentEntity = (id: string, name: string, support = 1): ResidentEntity => ({
  id,
  name,
  type: "protein",
  description: `${name} definition`,
  supportCount: support,
  trustLevel: "medium",
});

void test("resident summary: null for empty graph; early stage lists names only", async () => {
  assert.equal(await buildResidentSummary("kb", fakeResidentData([], [], null)), null);

  const early = await buildResidentSummary(
    "kb",
    fakeResidentData([residentEntity("1", "GP"), residentEntity("2", "NPC1")], [], null),
  );
  assert.equal(early?.stage, "early");
  assert.match(early!.section, /GP、NPC1/);
  assert.doesNotMatch(early!.section, /definition/); // no definitions at early stage
});

void test("resident summary: optional community report titles add one orientation line", async () => {
  const base = fakeResidentData([residentEntity("1", "GP"), residentEntity("2", "NPC1")], [], null);
  // Without the optional port method the summary is unchanged.
  const without = await buildResidentSummary("kb", base);
  assert.doesNotMatch(without!.section, /社区主题/);

  const withReports: ResidentSummaryDataAccess = {
    ...base,
    topCommunityReports: async (_kbId, limit) =>
      [
        { title: "Antibody response to the Ebola glycoprotein", rating: 8 },
        { title: "Innate immune signaling", rating: null },
        { title: "Vaccine design", rating: 5 },
        { title: "Fourth report dropped by the limit", rating: 1 },
      ].slice(0, limit),
  };
  const summary = await buildResidentSummary("kb", withReports);
  assert.match(summary!.section, /社区主题：Antibody response to the Ebola glycoprotein（8\/10）、Innate immune signaling/);
  assert.match(summary!.section, /Vaccine design（5\/10）/);
  assert.doesNotMatch(summary!.section, /Fourth report/);
});

void test("resident summary: engine state → mid; converged → trust levels + strongest edges", async () => {
  const entities = [residentEntity("1", "GP", 10), residentEntity("2", "NPC1", 8)];
  const edges = [{ srcId: "1", dstId: "2", type: "binds", supportCount: 6 }];

  const mid = await buildResidentSummary("kb", fakeResidentData(entities, edges, { converged: false }));
  assert.equal(mid?.stage, "mid");
  assert.match(mid!.section, /GP（protein，10 篇支持）/);
  assert.doesNotMatch(mid!.section, /\[medium\]/); // trust only at converged
  assert.doesNotMatch(mid!.section, /最强关系/);

  const converged = await buildResidentSummary("kb", fakeResidentData(entities, edges, { converged: true }));
  assert.equal(converged?.stage, "converged");
  assert.match(converged!.section, /\[medium\]/);
  assert.match(converged!.section, /GP —\[binds\]→ NPC1（6）/);
  assert.match(converged!.section, /```json/); // JSON slice fits under the cap
});

void test("resident summary: hard cap drops the JSON block whole, never mid-fence", async () => {
  // Sized so the markdown (~2300 chars) fits under the cap but markdown+JSON
  // (~4400) exceeds it — the middle branch: JSON dropped whole.
  const longName = "E".repeat(100);
  const entities = Array.from({ length: 15 }, (_v, index) => ({
    id: String(index),
    name: `${longName}${index}`,
    type: "protein",
    description: "d".repeat(30),
    supportCount: 100 - index,
    trustLevel: "medium",
  }));
  const summary = await buildResidentSummary("kb", fakeResidentData(entities, [], { converged: false }));
  assert.ok(summary);
  assert.equal(summary.stage, "mid");
  // The JSON block was dropped WHOLE: no fence at all, markdown intact to the
  // last entity (i.e. markdown itself was not truncated).
  assert.equal(summary.section.includes("```"), false);
  assert.ok(summary.section.length <= RESIDENT_SUMMARY_HARD_CAP);
  assert.ok(summary.section.includes(`${longName}14`));
});

void test("resident summary: over-cap markdown is sliced with the truncation note", async () => {
  // Markdown alone exceeds the cap → sliced markdown + note, no JSON.
  const longName = "E".repeat(200);
  const entities = Array.from({ length: 15 }, (_v, index) => ({
    id: String(index),
    name: `${longName}${index}`,
    type: "protein",
    description: "d".repeat(120),
    supportCount: 100 - index,
    trustLevel: "medium",
  }));
  const summary = await buildResidentSummary("kb", fakeResidentData(entities, [], { converged: false }));
  assert.ok(summary);
  assert.equal(summary.section.includes("```"), false);
  assert.ok(summary.section.length <= RESIDENT_SUMMARY_HARD_CAP + 100);
  assert.match(summary.section, /摘要已截断/);
});
