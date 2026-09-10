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

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { KnowledgeEngineStore } from "./store.js";
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
  assert.equal(result.sources.citations.status, "error"); // not enabled in this build
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
