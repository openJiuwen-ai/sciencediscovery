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

/**
 * Composition-layer tests for the KE tool port: real store, real FTS, real
 * resident-summary wiring. The pure algorithms are covered in
 * packages/knowledge-engine — here we prove the port reads the store
 * correctly end to end.
 */

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { KnowledgeEngineStore } from "./store.js";
import { graphFingerprintOf } from "./graph-roots.js";
import { createKnowledgeEngineTools, KeKbNotFoundError } from "./tools.js";

function tempRoot(name: string): string {
  return resolve(process.cwd(), ".tmp", `${name}-${Date.now()}-${process.pid}`);
}

/** KB with a tiny mAb114 graph: mAb114 —[binds]→ GP, mAb114 —[neutralizes]→ Ebola virus. */
function seedGraph(store: KnowledgeEngineStore, kbId: string): { mab: string; gp: string; ebola: string } {
  store.upsertDocument({
    kbId,
    dedupKey: "doi:10.1/p1",
    title: "mAb114 neutralizes Ebola",
    status: "ready",
    fulltext: "mAb114 binds the Ebola glycoprotein and neutralizes the virus.",
  });
  const mab = store.upsertEntity({ kbId, name: "mAb114", type: "antibody", description: "Monoclonal antibody" });
  const gp = store.upsertEntity({ kbId, name: "GP", type: "protein", aliases: ["glycoprotein"] });
  const ebola = store.upsertEntity({ kbId, name: "Ebola virus", type: "virus" });
  store.upsertEdge({ kbId, srcId: mab.id, dstId: gp.id, type: "binds", evidenceQuote: "mAb114 binds the Ebola glycoprotein", evidenceDocId: null });
  store.upsertEdge({ kbId, srcId: mab.id, dstId: ebola.id, type: "neutralizes", evidenceQuote: "neutralizes the virus", evidenceDocId: null });
  return { mab: mab.id, gp: gp.id, ebola: ebola.id };
}

test("tools: listKnowledgeBases carries stats; unknown kbId throws KeKbNotFoundError", async (context) => {
  const root = tempRoot("ke-tools-list");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const tools = createKnowledgeEngineTools(store);
  const kb = store.createKnowledgeBase({ name: "Ebola" });
  seedGraph(store, kb.id);

  const kbs = (await tools.listKnowledgeBases()) as Array<{ id: string; stats: { entities: number; edges: number } }>;
  assert.equal(kbs.length, 1);
  assert.equal(kbs[0]?.stats.entities, 3);
  assert.equal(kbs[0]?.stats.edges, 2);

  await assert.rejects(() => tools.conceptExplore("missing-kb", "mAb114", {}), KeKbNotFoundError);
});

test("tools: conceptExplore/deepDive/validateEntities read the store correctly", async (context) => {
  const root = tempRoot("ke-tools-read");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const tools = createKnowledgeEngineTools(store);
  const kb = store.createKnowledgeBase({ name: "Ebola" });
  seedGraph(store, kb.id);

  const explore = await tools.conceptExplore(kb.id, "glycoprotein", {}); // alias resolution
  assert.equal(explore.found, true);
  assert.equal(explore.center?.name, "GP");

  const dive = await tools.deepDive(kb.id, "mAb114", {});
  assert.equal(dive.found, true);
  assert.equal(dive.evidence?.length, 2);
  assert.ok(dive.evidence?.every((entry) => entry.evidenceQuote));

  const validation = await tools.validateEntities(kb.id, ["mAb114", "REGN3471"]);
  assert.deepEqual(
    validation.results.map((entry) => entry.status),
    ["found", "unknown"],
  );
});

test("tools: unified search documents section hits FTS over fulltext", async (context) => {
  const root = tempRoot("ke-tools-unified");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const tools = createKnowledgeEngineTools(store);
  const kb = store.createKnowledgeBase({ name: "Ebola" });
  seedGraph(store, kb.id);

  const result = await tools.entityUnifiedSearch(kb.id, "glycoprotein", {});
  assert.equal(result.sources.graph.status, "ok");
  assert.equal(result.sources.evidence.status, "ok");
  assert.equal(result.sources.documents.status, "ok");
  assert.equal(result.sources.documents.hits?.length, 1);
  assert.equal(result.sources.documents.hits?.[0]?.title, "mAb114 neutralizes Ebola");
  // W10: the citations section is live — no citation rows exist for this
  // fixture, so the honest answer is empty (not the old error stub).
  assert.equal(result.sources.citations.status, "empty");
});

test("tools: gapCandidates finds the structural hole between GP and Ebola virus", async (context) => {
  const root = tempRoot("ke-tools-gaps");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const tools = createKnowledgeEngineTools(store);
  const kb = store.createKnowledgeBase({ name: "Ebola" });
  const kbId = kb.id;
  // GP and Ebola share 3 neighbors (mAb114, R, S) but have no direct edge.
  const gp = store.upsertEntity({ kbId, name: "GP", type: "protein" });
  const ebola = store.upsertEntity({ kbId, name: "Ebola virus", type: "virus" });
  for (const name of ["mAb114", "R", "S"]) {
    const shared = store.upsertEntity({ kbId, name, type: "antibody" });
    store.upsertEdge({ kbId, srcId: gp.id, dstId: shared.id, type: "binds" });
    store.upsertEdge({ kbId, srcId: ebola.id, dstId: shared.id, type: "binds" });
  }

  const gaps = await tools.gapCandidates(kb.id, {});
  assert.equal(gaps.holes.length, 1);
  assert.deepEqual(
    [gaps.holes[0]?.a.name, gaps.holes[0]?.b.name].sort(),
    ["Ebola virus", "GP"],
  );
  assert.deepEqual(gaps.holes[0]?.commonNeighbors.sort(), ["R", "S", "mAb114"].sort());
});

test("tools: residentSummary stages by engine state and stays under the cap", async (context) => {
  const root = tempRoot("ke-tools-resident");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const tools = createKnowledgeEngineTools(store);
  const kb = store.createKnowledgeBase({ name: "Ebola" });

  // Empty graph → null (no section injected).
  assert.equal(await tools.residentSummary(kb.id), null);

  seedGraph(store, kb.id);
  const early = await tools.residentSummary(kb.id);
  assert.equal(early?.stage, "early");
  assert.match(early!.section, /mAb114/);

  store.updateEngineState(kb.id, { converged: true, cycleId: "c1" });
  const converged = await tools.residentSummary(kb.id);
  assert.equal(converged?.stage, "converged");
  assert.match(converged!.section, /最强关系/);
  assert.ok(converged!.section.length <= 2500);
});

test("tools: kbSearch returns anchor-level passage hits from FTS recall", async (context) => {
  const root = tempRoot("ke-tools-kbsearch");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const tools = createKnowledgeEngineTools(store);
  const kb = store.createKnowledgeBase({ name: "Ebola" });
  const doc = store.upsertDocument({
    kbId: kb.id,
    dedupKey: "doi:10.1/p1",
    title: "mAb114 neutralizes Ebola",
    status: "ready",
    fulltext: "mAb114 binds the Ebola glycoprotein and neutralizes the virus.",
  });
  store.upsertDocument({
    kbId: kb.id,
    dedupKey: "doi:10.1/p2",
    title: "Unrelated climate paper",
    status: "ready",
    fulltext: "Sea surface temperature rose by two degrees.",
  });

  const result = await tools.kbSearch(kb.id, "glycoprotein neutralizes", {});
  assert.equal(result.hits.length, 1);
  const hit = result.hits[0]!;
  assert.equal(hit.docId, doc.id);
  assert.equal(hit.docTitle, "mAb114 neutralizes Ebola");
  assert.equal(hit.anchorId, `${doc.id}:paragraph:0`);
  assert.equal(hit.blockType, "paragraph");
  assert.ok(hit.snippet.includes("glycoprotein"));
  assert.ok(hit.matchedTerms.includes("neutralizes"));

  const empty = await tools.kbSearch(kb.id, "zebraquantum", {});
  assert.deepEqual(empty.hits, []);
  assert.equal(empty.note, "no documents matched the keyword recall");

  await assert.rejects(
    () => tools.kbSearch("nonexistent", "x", {}),
    (error: unknown) => error instanceof KeKbNotFoundError,
  );
});

test("tools: kbSearch fuses the semantic arm when an embedding client is configured", async (context) => {
  const root = tempRoot("ke-tools-hybrid");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  // Fake embedding client: the query vector points at the climate paper's
  // chunk (which the keyword arm cannot reach — its terms don't match).
  const climate = new Float32Array([1, 0, 0]);
  const query = new Float32Array([0.9, 0.1, 0]);
  const calls: string[] = [];
  const embedding = {
    embedOne: async (text: string) => {
      calls.push(text);
      return query;
    },
    embed: async (texts: readonly string[]) => texts.map(() => query),
  } as unknown as import("./embedding.js").EmbeddingClient;
  const tools = createKnowledgeEngineTools(store, { embedding });
  const kb = store.createKnowledgeBase({ name: "Ebola" });
  const antibodyDoc = store.upsertDocument({
    kbId: kb.id,
    dedupKey: "doi:10.1/p1",
    title: "mAb114 neutralizes Ebola",
    status: "ready",
    fulltext: "mAb114 binds the Ebola glycoprotein and neutralizes the virus.",
  });
  const climateDoc = store.upsertDocument({
    kbId: kb.id,
    dedupKey: "doi:10.1/p2",
    title: "Unrelated climate paper",
    status: "ready",
    fulltext: "Sea surface temperature rose by two degrees.",
  });
  store.replaceDocChunks(kb.id, climateDoc.id, [
    { anchorId: `${climateDoc.id}:paragraph:0`, blockType: "paragraph", section: null, text: "Sea surface temperature rose by two degrees." },
  ]);
  store.updateDocChunkEmbeddings(climateDoc.id, new Map([
    [`${climateDoc.id}:paragraph:0`, new Uint8Array(climate.buffer.slice(0))],
  ]));

  const result = await tools.kbSearch(kb.id, "glycoprotein neutralizes", {});
  assert.deepEqual(result.sources, ["fts", "vector"]);
  assert.equal(calls.length, 1); // one query embedding
  // The keyword hit (antibody doc) and the semantic-only hit (climate doc,
  // loaded on demand for its block metadata) both surface.
  const docIds = result.hits.map((hit) => hit.docId);
  assert.ok(docIds.includes(antibodyDoc.id));
  assert.ok(docIds.includes(climateDoc.id));
  const semanticOnly = result.hits.find((hit) => hit.docId === climateDoc.id)!;
  assert.deepEqual(semanticOnly.matchedTerms, []);
  assert.equal(semanticOnly.docTitle, "Unrelated climate paper");
});

test("tools: kbSearch degrades to keyword-only when the embedding call fails", async (context) => {
  const root = tempRoot("ke-tools-hybrid-degrade");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const embedding = {
    embedOne: async () => {
      throw new Error("embedding provider down");
    },
    embed: async () => {
      throw new Error("embedding provider down");
    },
  } as unknown as import("./embedding.js").EmbeddingClient;
  const tools = createKnowledgeEngineTools(store, { embedding });
  const kb = store.createKnowledgeBase({ name: "Ebola" });
  store.upsertDocument({
    kbId: kb.id,
    dedupKey: "doi:10.1/p1",
    title: "mAb114 neutralizes Ebola",
    status: "ready",
    fulltext: "mAb114 binds the Ebola glycoprotein and neutralizes the virus.",
  });

  const result = await tools.kbSearch(kb.id, "glycoprotein", {});
  assert.deepEqual(result.sources, undefined); // legacy keyword-only shape
  assert.equal(result.hits.length, 1);
});

test("tools: kbExpand resolves anchors with structured miss reasons", async (context) => {
  const root = tempRoot("ke-tools-kbexpand");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const tools = createKnowledgeEngineTools(store);
  const kb = store.createKnowledgeBase({ name: "Ebola" });
  const doc = store.upsertDocument({
    kbId: kb.id,
    dedupKey: "doi:10.1/p1",
    title: "mAb114 neutralizes Ebola",
    status: "ready",
    fulltext: "# Intro\n\nmAb114 binds the Ebola glycoprotein and neutralizes the virus.",
  });
  const otherKb = store.createKnowledgeBase({ name: "Other" });

  const hit = await tools.kbExpand(kb.id, `${doc.id}:paragraph:0`);
  assert.equal(hit.found, true);
  if (hit.found) {
    assert.equal(hit.docId, doc.id);
    assert.ok(hit.block.text.includes("neutralizes"));
    assert.equal(hit.before?.type, "heading");
    assert.equal(hit.after, null);
  }

  const badIndex = await tools.kbExpand(kb.id, `${doc.id}:paragraph:9`);
  assert.deepEqual(badIndex, { found: false, reason: "anchor-not-found" });

  const unparsed = store.upsertDocument({
    kbId: kb.id,
    dedupKey: "doi:10.1/pending",
    title: "Pending",
    status: "pending",
  });
  assert.deepEqual(await tools.kbExpand(kb.id, `${unparsed.id}:paragraph:0`), {
    found: false,
    reason: "document-not-parsed",
  });

  // A doc from another KB must not be readable through this KB's tool call.
  assert.deepEqual(await tools.kbExpand(otherKb.id, `${doc.id}:paragraph:0`), {
    found: false,
    reason: "document-not-found",
  });
  assert.deepEqual(await tools.kbExpand(kb.id, "not-an-anchor"), {
    found: false,
    reason: "document-not-found",
  });
});

test("tools: docGrep regex-scans ready documents with structured errors", async (context) => {
  const root = tempRoot("ke-tools-docgrep");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const tools = createKnowledgeEngineTools(store);
  const kb = store.createKnowledgeBase({ name: "Ebola" });
  store.upsertDocument({
    kbId: kb.id,
    dedupKey: "doi:10.1/p1",
    title: "Binding study",
    status: "ready",
    fulltext: "The IC50 was 4 nM.\nNo effect on mice.",
  });
  // Pending docs are out of scope for grep.
  store.upsertDocument({
    kbId: kb.id,
    dedupKey: "doi:10.1/pending",
    title: "Pending",
    status: "pending",
    fulltext: "IC50 pending",
  });

  const result = await tools.docGrep(kb.id, "ic\\d+", {});
  assert.equal(result.error, undefined);
  assert.equal(result.scannedDocs, 1);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0]!.line, 1);
  assert.ok(result.matches[0]!.text.includes("IC50"));

  const invalid = await tools.docGrep(kb.id, "([unclosed", {});
  assert.match(invalid.error ?? "", /invalid regex/i);

  const none = await tools.docGrep(kb.id, "zebraquantum", {});
  assert.deepEqual(none.matches, []);

  await assert.rejects(
    () => tools.docGrep("nonexistent", "x", {}),
    (error: unknown) => error instanceof KeKbNotFoundError,
  );
});

test("tools: driftSearch runs both stages over the store — reports select, members and evidence land", async (context) => {
  const root = tempRoot("ke-tools-drift");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const tools = createKnowledgeEngineTools(store);
  const kb = store.createKnowledgeBase({ name: "Ebola" });
  const { mab, gp, ebola } = seedGraph(store, kb.id);
  store.setCommunityIds(kb.id, new Map([[mab, 1], [gp, 1], [ebola, 1]]));
  const fingerprint = graphFingerprintOf(store, kb.id);
  store.upsertCommunityReport({
    kbId: kb.id,
    fingerprint,
    communityId: 1,
    title: "Antibody neutralization of Ebola",
    summary: "mAb114 binds the glycoprotein spike and neutralizes Ebola virus.",
    rating: 8,
    ratingExplanation: "central therapeutic cluster",
    findings: JSON.stringify([{ summary: "mAb114 neutralizes Ebola virus", explanation: "via the glycoprotein" }]),
    status: "ready",
    error: null,
    model: "test",
  });

  const result = await tools.driftSearch(kb.id, "Ebola glycoprotein", {});
  assert.equal(result.status, "ok");
  assert.equal(result.fingerprint, fingerprint);
  assert.equal(result.communities.length, 1);
  const section = result.communities[0]!;
  assert.equal(section.communityId, 1);
  assert.equal(section.title, "Antibody neutralization of Ebola");
  assert.ok(section.reportMatchedTerms.includes("ebola"));
  assert.ok(section.reportMatchedTerms.includes("glycoprotein"));
  assert.equal(section.memberCount, 3);

  // Seeds: "Ebola virus" matches by name; the rest arrive as support-ranked
  // orientation entries (matchedTerms empty) — the report prose matched, not
  // the member names.
  const byName = new Map(section.seedEntities.map((seed) => [seed.name, seed]));
  assert.deepEqual(byName.get("Ebola virus")?.matchedTerms, ["ebola"]);
  assert.equal(byName.get("mAb114")?.matchedTerms.length, 0);
  assert.equal(byName.get("GP")?.matchedTerms.length, 0);

  // Evidence: the "binds the Ebola glycoprotein" quote hits both terms and
  // outranks the neutralizes edge (endpoint match only).
  assert.equal(section.evidenceEdges.length, 2);
  assert.equal(section.evidenceEdges[0]!.source, "mAb114");
  assert.equal(section.evidenceEdges[0]!.target, "GP");
  assert.ok(section.evidenceEdges[0]!.matchedTerms.includes("glycoprotein"));
  assert.equal(section.evidenceEdges[1]!.target, "Ebola virus");

  // Unknown KB: same guard as every other tool.
  await assert.rejects(
    () => tools.driftSearch("nonexistent", "x", {}),
    (error: unknown) => error instanceof KeKbNotFoundError,
  );
});

test("tools: driftSearch empty states distinguish never-generated from a stale generation", async (context) => {
  const root = tempRoot("ke-tools-drift-empty");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const tools = createKnowledgeEngineTools(store);
  const kb = store.createKnowledgeBase({ name: "Ebola" });

  // No graph at all.
  const noGraph = await tools.driftSearch(kb.id, "interferon", {});
  assert.equal(noGraph.status, "no-graph");

  const { mab, gp, ebola } = seedGraph(store, kb.id);
  store.setCommunityIds(kb.id, new Map([[mab, 1], [gp, 1], [ebola, 1]]));

  // Graph exists, no reports ever written.
  const never = await tools.driftSearch(kb.id, "interferon", {});
  assert.equal(never.status, "no-reports");
  assert.match(never.note ?? "", /no community reports exist for the current graph generation/);

  // Reports exist — but for a fingerprint the graph has moved past.
  store.upsertCommunityReport({
    kbId: kb.id,
    fingerprint: "e0:x-stale",
    communityId: 1,
    title: "Stale",
    summary: "written for an older partition",
    rating: 5,
    ratingExplanation: null,
    findings: "[]",
    status: "ready",
    error: null,
    model: "test",
  });
  const stale = await tools.driftSearch(kb.id, "interferon", {});
  assert.equal(stale.status, "no-reports");
  assert.match(stale.note ?? "", /older graph generation/);

  // A query that lexically misses the only current-fingerprint report comes
  // back ok with the honest theme-level note.
  store.upsertCommunityReport({
    kbId: kb.id,
    fingerprint: graphFingerprintOf(store, kb.id),
    communityId: 1,
    title: "Antibody cluster",
    summary: "antibody engineering summary",
    rating: 5,
    ratingExplanation: null,
    findings: "[]",
    status: "ready",
    error: null,
    model: "test",
  });
  const miss = await tools.driftSearch(kb.id, "crispr cas9", {});
  assert.equal(miss.status, "ok");
  assert.deepEqual(miss.communities, []);
  assert.match(miss.note ?? "", /no community report lexically matches/);
});

test("tools: noveltyCheck probes the store graph and documents", async (context) => {
  const root = tempRoot("ke-tools-novelty");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const tools = createKnowledgeEngineTools(store);
  const kb = store.createKnowledgeBase({ name: "Ebola" });
  seedGraph(store, kb.id);

  // Both endpoints named + the relation quote shares the claim's terms.
  const collision = await tools.noveltyCheck(kb.id, "mAb114 binds GP and thereby neutralizes the virus");
  assert.equal(collision.verdict, "collision");
  assert.ok(collision.relationHits.some((hit) => hit.sourceName === "mAb114" && hit.targetName === "GP"));
  assert.match(collision.note, /already covers|reframe/i);

  const none = await tools.noveltyCheck(kb.id, "zebra quantum entanglement cures everything");
  assert.equal(none.verdict, "no-collision");
  assert.match(none.note, /wider literature|out of scope/i);
  // No external sources injected → the stage is reported as not executed and
  // the combined verdict discloses its internal-only scope.
  assert.equal(none.external, null);
  assert.equal(none.novelty.verdict, "novel");
  assert.match(none.novelty.caveat, /external stage not executed/);

  await assert.rejects(
    () => tools.noveltyCheck("nonexistent", "x", ),
    (error: unknown) => error instanceof KeKbNotFoundError,
  );
});

test("tools: noveltyCheck runs injected external counter-evidence and composes the verdict", async (context) => {
  const root = tempRoot("ke-tools-novelty-ext");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const claim = "zebra fish regenerate cardiac tissue after cryoinjury";

  const withHit = createKnowledgeEngineTools(store, {
    noveltyExternal: [
      {
        name: "semantic-scholar",
        search: async () => [
          { title: "Zebrafish cardiac regeneration after cryoinjury", year: 2020, url: "https://doi.org/10.1/x", venue: "Nature", abstract: "zebra fish regenerate cardiac tissue following cryoinjury" },
        ],
      },
    ],
  });
  const kbHit = store.createKnowledgeBase({ name: "Hit" });
  const hit = await withHit.noveltyCheck(kbHit.id, claim);
  assert.equal(hit.external?.status, "ok");
  assert.equal(hit.external?.items[0]?.aboveThreshold, true);
  assert.equal(hit.novelty.verdict, "similar-found");
  // The internal verdict stays the first `verdict` key for existing consumers.
  assert.equal(hit.verdict, "no-collision");

  const withFailure = createKnowledgeEngineTools(store, {
    noveltyExternal: [
      { name: "semantic-scholar", search: async () => { throw new Error("Semantic Scholar API HTTP 429"); } },
      { name: "openalex", search: async () => { throw new Error("OpenAlex API HTTP 403"); } },
    ],
  });
  const failed = await withFailure.noveltyCheck(kbHit.id, claim);
  assert.equal(failed.external?.status, "error");
  assert.equal(failed.novelty.verdict, "inconclusive");
  assert.match(failed.novelty.reasons.join(" "), /external counter-evidence failed/);

  // Internal collisions win regardless of external state.
  const collisionTools = createKnowledgeEngineTools(store, {
    noveltyExternal: [
      { name: "semantic-scholar", search: async () => { throw new Error("HTTP 500"); } },
    ],
  });
  const kbCollision = store.createKnowledgeBase({ name: "Collision" });
  seedGraph(store, kbCollision.id);
  const collision = await collisionTools.noveltyCheck(kbCollision.id, "mAb114 binds GP and thereby neutralizes the virus");
  assert.equal(collision.verdict, "collision");
  assert.equal(collision.novelty.verdict, "similar-found");
});

test("tools: verifyCitation checks quotes against ready documents", async (context) => {
  const root = tempRoot("ke-tools-verifycite");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const tools = createKnowledgeEngineTools(store);
  const kb = store.createKnowledgeBase({ name: "Ebola" });
  const doc = store.upsertDocument({
    kbId: kb.id,
    dedupKey: "doi:10.1/p1",
    title: "mAb114 neutralizes Ebola",
    status: "ready",
    fulltext: "mAb114 binds the Ebola glycoprotein and neutralizes the virus.",
  });

  const verbatim = await tools.verifyCitation(kb.id, "neutralizes the virus");
  assert.equal(verbatim.state, "verbatim");
  assert.equal(verbatim.verifiedIn[0]!.docId, doc.id);

  const paraphrase = await tools.verifyCitation(kb.id, "mAb114 binds the Ebola glycoprotein and neutralizes the viruses");
  assert.equal(paraphrase.state, "fuzzy");

  const missing = await tools.verifyCitation(kb.id, "zebra quantum entanglement cures everything");
  assert.equal(missing.state, "none");
  assert.match(missing.note ?? "", /do not present/i);

  await assert.rejects(
    () => tools.verifyCitation("nonexistent", "x"),
    (error: unknown) => error instanceof KeKbNotFoundError,
  );
});

test("tools: kbRiskSignals surfaces conflicts and single-source entities", async (context) => {
  const root = tempRoot("ke-tools-risk");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const tools = createKnowledgeEngineTools(store);
  const kb = store.createKnowledgeBase({ name: "Ebola" });
  const seeded = seedGraph(store, kb.id);
  store.upsertEdge({ kbId: kb.id, srcId: seeded.mab, dstId: seeded.ebola, type: "contradicts", evidenceQuote: "no neutralization observed", evidenceDocId: null });

  const signals = await tools.kbRiskSignals(kb.id);
  assert.equal(signals.kbName, "Ebola");
  assert.equal(signals.conflicts.length, 1);
  assert.equal(signals.conflicts[0]!.type, "contradicts");
  assert.ok(signals.singleSource.length >= 1, "seed entities are single-source until more documents land");

  await assert.rejects(
    () => tools.kbRiskSignals("nonexistent"),
    (error: unknown) => error instanceof KeKbNotFoundError,
  );
});
