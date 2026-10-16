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
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { embeddingToBlob } from "@sciencediscovery/knowledge-engine";

import { KnowledgeEngineStore } from "./store.js";

function tempRoot(name: string): string {
  return resolve(process.cwd(), ".tmp", `${name}-${Date.now()}-${process.pid}`);
}

function setup(name: string): { store: KnowledgeEngineStore; kbId: string; cleanup: () => Promise<void> } {
  const root = tempRoot(name);
  const store = KnowledgeEngineStore.open(root);
  const kb = store.createKnowledgeBase({ name: "Ebola GP" });
  return { store, kbId: kb.id, cleanup: async () => { store.close(); await rm(root, { force: true, recursive: true }); } };
}

test("findEntityByAlias matches normalized aliases; findEntityByName is type-independent", async (context) => {
  const { store, kbId, cleanup } = setup("ke-res-alias");
  context.after(cleanup);

  store.upsertEntity({ kbId, name: "Ebola virus glycoprotein", type: "protein", aliases: ["GP"] });
  // Same normalized name under a SECOND type — L0 must still find a row.
  store.upsertEntity({ kbId, name: "glycoprotein", type: "concept" });

  const byAlias = store.findEntityByAlias(kbId, "gp");
  assert.equal(byAlias?.name, "Ebola virus glycoprotein");
  assert.equal(store.findEntityByAlias(kbId, "nope"), undefined);

  const byName = store.findEntityByName(kbId, "glycoprotein");
  assert.equal(byName?.type, "concept");
  // Upsert by (name,type) dedup still intact
  assert.equal(store.listEntities(kbId).length, 2);
});

test("similarEntitiesByName ranks trigram neighbors deterministically", async (context) => {
  const { store, kbId, cleanup } = setup("ke-res-trgm");
  context.after(cleanup);

  store.upsertEntity({ kbId, name: "Ebola virus glycoprotein", type: "protein" });
  store.upsertEntity({ kbId, name: "Ebola virus glycoproteins", type: "protein" });
  store.upsertEntity({ kbId, name: "Interferon gamma", type: "protein" });

  const hits = store.similarEntitiesByName(kbId, "ebola virus glycoprotein", 0.5, 10);
  assert.equal(hits.length >= 2, true);
  assert.equal(hits[0]!.name, "Ebola virus glycoprotein");
  assert.equal(hits[0]!.sim, 1);
  assert.ok(hits[1]!.sim > 0.8); // singular/plural ≈ 0.85–0.88 band
  assert.ok(store.similarEntitiesByName(kbId, "ebola virus glycoprotein", 0.99, 10).every((h) => h.sim >= 0.99));
});

test("nearestEntitiesByEmbedding returns cosine-ranked embedded entities", async (context) => {
  const { store, kbId, cleanup } = setup("ke-res-embed");
  context.after(cleanup);

  const a = store.upsertEntity({ kbId, name: "alpha", type: "protein" });
  const b = store.upsertEntity({ kbId, name: "beta", type: "protein" });
  store.upsertEntity({ kbId, name: "no-vector", type: "protein" });
  store.updateEntityEmbedding(a.id, embeddingToBlob([1, 0]));
  store.updateEntityEmbedding(b.id, embeddingToBlob([0, 1]));

  const hits = store.nearestEntitiesByEmbedding(kbId, [0.9, 0.1], 5);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.id, a.id);
  assert.ok(hits[0]!.cosine > hits[1]!.cosine);
});

test("attachToEntity unions aliases, bumps support, records doc detail", async (context) => {
  const { store, kbId, cleanup } = setup("ke-res-attach");
  context.after(cleanup);

  const doc = store.upsertDocument({ kbId, dedupKey: "d1", title: "Paper", status: "ready" });
  const d2 = store.upsertDocument({ kbId, dedupKey: "d2", title: "Paper 2", status: "ready" });
  const target = store.upsertEntity({ kbId, name: "Ebola virus glycoprotein", type: "protein", firstSeenDoc: doc.id });

  // Attach from a NEW document earns the distinct-doc bump.
  const attached = store.attachToEntity(target.id, {
    name: "GP",
    aliases: ["EBOV GP", "GP"], // dup of name → attached once
    description: "surface glycoprotein",
    docId: d2.id,
  });
  assert.equal(attached.supportCount, target.supportCount + 1);
  assert.ok(attached.aliases.includes("GP"));
  assert.ok(attached.aliases.includes("EBOV GP"));
  assert.equal(attached.aliases.filter((a) => a === "GP").length, 1);
  assert.equal(attached.description, "surface glycoprotein");
  // L1 now resolves the new alias
  assert.equal(store.findEntityByAlias(kbId, "ebov gp")?.id, target.id);
});

test("attachToEntity is idempotent on re-run: same doc never double-counts support", async (context) => {
  const { store, kbId, cleanup } = setup("ke-res-attach-rerun");
  context.after(cleanup);

  const doc = store.upsertDocument({ kbId, dedupKey: "d1", title: "Paper", status: "ready" });
  const target = store.upsertEntity({ kbId, name: "Ebola virus glycoprotein", type: "protein", firstSeenDoc: doc.id });

  // Same document re-attaches (extraction job retry): support stays put,
  // aliases still merge, and the MAX() recount cannot resurrect the bump.
  const rerun = store.attachToEntity(target.id, { name: "GP", aliases: ["EBOV GP"], docId: doc.id });
  assert.equal(rerun.supportCount, target.supportCount);
  assert.ok(rerun.aliases.includes("EBOV GP"));
  const rerun2 = store.attachToEntity(target.id, { name: "GP", docId: doc.id });
  assert.equal(rerun2.supportCount, target.supportCount);
  // ...while a genuinely new document still earns +1.
  const d2 = store.upsertDocument({ kbId, dedupKey: "d2", title: "Paper 2", status: "ready" });
  const grown = store.attachToEntity(target.id, { name: "GP", docId: d2.id });
  assert.equal(grown.supportCount, target.supportCount + 1);
});

test("mergeEntities redirects edges, folds collisions, drops self-loops, recounts distinct docs", async (context) => {
  const { store, kbId, cleanup } = setup("ke-res-merge");
  context.after(cleanup);

  const d1 = store.upsertDocument({ kbId, dedupKey: "d1", status: "ready" });
  const d2 = store.upsertDocument({ kbId, dedupKey: "d2", status: "ready" });
  const gp = store.upsertEntity({ kbId, name: "Glycoprotein", type: "protein", firstSeenDoc: d1.id });
  const ebola = store.upsertEntity({ kbId, name: "Ebola virus", type: "virus", firstSeenDoc: d1.id });
  const gpLong = store.upsertEntity({
    kbId, name: "Ebola virus glycoprotein", type: "protein", firstSeenDoc: d2.id, aliases: ["EBOV GP"],
  });

  // Edges: gp→ebola (doc1, support 2 via double upsert), gpLong→ebola (SAME
  // doc1 — collides after redirect and must fold), gp→gpLong (self-loop)
  store.upsertEdge({ kbId, srcId: gp.id, dstId: ebola.id, type: "part_of", evidenceQuote: "q1", evidenceDocId: d1.id });
  store.upsertEdge({ kbId, srcId: gp.id, dstId: ebola.id, type: "part_of", evidenceQuote: "q1", evidenceDocId: d1.id });
  store.upsertEdge({ kbId, srcId: gpLong.id, dstId: ebola.id, type: "part_of", evidenceQuote: "q2", evidenceDocId: d1.id });
  store.upsertEdge({ kbId, srcId: gp.id, dstId: gpLong.id, type: "same_as", evidenceDocId: d1.id });

  const { mergeId } = store.mergeEntities(kbId, gpLong.id, gp.id, { decidedBy: "batch-llm", rationale: "same protein" });

  const survivor = store.getEntity(gpLong.id)!;
  assert.ok(survivor.aliases.includes("Glycoprotein")); // absorbed canonical name preserved as alias
  assert.ok(survivor.aliases.includes("EBOV GP"));
  assert.equal(survivor.embedding, null); // re-embed on next backfill
  assert.equal(store.getEntity(gp.id), undefined);

  const edges = store.listEdges(kbId);
  // Collision: gp→ebola and gpLong→ebola fold into ONE row with 2+1 support.
  assert.equal(edges.length, 1);
  assert.equal(edges[0]!.srcId, gpLong.id);
  assert.equal(edges[0]!.supportCount, 3);

  // Distinct-doc recount: d1 (absorbed docs + edge evidence) ∪ d2 = 2.
  assert.equal(store.getEntity(gpLong.id)!.supportCount, 2);

  // Audit row carries the full snapshot.
  const merges = store.listEntityMerges(kbId);
  assert.equal(merges.length, 1);
  assert.equal(merges[0]!.id, mergeId);
  assert.equal(merges[0]!.decidedBy, "batch-llm");
  const snap = merges[0]!.absorbedSnapshot as { absorbedEdges: unknown[]; absorbed: { name: string } };
  assert.equal(snap.absorbed.name, "Glycoprotein");
  assert.equal(snap.absorbedEdges.length, 2);

  // Judged-pair cache contains the pair.
  const pair = [gpLong.id, gp.id].sort().join("|");
  assert.ok(store.judgedPairKeys(kbId).includes(pair));
});

test("unmergeEntity restores entities, edges (incl. folded support) and scalars", async (context) => {
  const { store, kbId, cleanup } = setup("ke-res-unmerge");
  context.after(cleanup);

  const d1 = store.upsertDocument({ kbId, dedupKey: "d1", status: "ready" });
  const d2 = store.upsertDocument({ kbId, dedupKey: "d2", status: "ready" });
  const gp = store.upsertEntity({ kbId, name: "Glycoprotein", type: "protein", firstSeenDoc: d1.id });
  const ebola = store.upsertEntity({ kbId, name: "Ebola virus", type: "virus", firstSeenDoc: d1.id });
  const gpLong = store.upsertEntity({ kbId, name: "Ebola virus glycoprotein", type: "protein", firstSeenDoc: d2.id });

  store.upsertEdge({ kbId, srcId: gp.id, dstId: ebola.id, type: "part_of", evidenceDocId: d1.id });
  store.upsertEdge({ kbId, srcId: gp.id, dstId: ebola.id, type: "part_of", evidenceDocId: d1.id });
  // Same evidence doc on both sides → the redirect folds into this row.
  store.upsertEdge({ kbId, srcId: gpLong.id, dstId: ebola.id, type: "part_of", evidenceDocId: d1.id });
  store.upsertEdge({ kbId, srcId: gp.id, dstId: gpLong.id, type: "same_as", evidenceDocId: d1.id });

  const { mergeId } = store.mergeEntities(kbId, gpLong.id, gp.id, { decidedBy: "batch-llm" });
  assert.equal(store.listEdges(kbId).length, 1);

  store.unmergeEntity(mergeId);

  // Absorbed row back under its original id with original scalars
  const restored = store.getEntity(gp.id)!;
  assert.equal(restored.name, "Glycoprotein");
  assert.equal(restored.supportCount, gp.supportCount);
  // Canonical scalars restored (aliases back to pre-merge)
  const canon = store.getEntity(gpLong.id)!;
  assert.deepEqual(canon.aliases, gpLong.aliases);
  assert.equal(canon.supportCount, gpLong.supportCount);

  // All three original edges back: folded support handed back, self-loop reinserted
  const edges = store.listEdges(kbId);
  assert.equal(edges.length, 3);
  const restoredGpEdge = edges.find((e) => e.srcId === gp.id && e.dstId === ebola.id);
  assert.equal(restoredGpEdge?.supportCount, 2);
  const restoredCanonEdge = edges.find((e) => e.srcId === gpLong.id && e.dstId === ebola.id);
  assert.equal(restoredCanonEdge?.supportCount, 1);
  assert.ok(edges.some((e) => e.srcId === gp.id && e.dstId === gpLong.id));

  // Double undo is rejected
  assert.throws(() => store.unmergeEntity(mergeId), /already undone/);
});

test("unmergeEntity rejects online-attach rows and unknown ids", async (context) => {
  const { store, kbId, cleanup } = setup("ke-res-unmerge-guard");
  context.after(cleanup);

  const target = store.upsertEntity({ kbId, name: "Glycoprotein", type: "protein" });
  const attachId = store.recordEntityMerge({
    kbId,
    canonicalId: target.id,
    absorbedId: "candidate:gp",
    snapshot: { onlineAttach: true, candidate: { name: "GP", type: "protein" } },
    decidedBy: "alias",
  });
  assert.throws(() => store.unmergeEntity(attachId), /online attach/);
  assert.throws(() => store.unmergeEntity("nope"), /not found/);
  assert.throws(() => store.mergeEntities(kbId, target.id, target.id, { decidedBy: "manual" }), /into itself/);
  assert.throws(() => store.mergeEntities(kbId, target.id, "ghost", { decidedBy: "manual" }), /not found/);
});

test("upsertEntity: same-doc re-upsert does not double-count support", async (context) => {
  const { store, kbId, cleanup } = setup("ke-res-support-idem");
  context.after(cleanup);

  const d1 = store.upsertDocument({ kbId, dedupKey: "d1", status: "ready" });
  const d2 = store.upsertDocument({ kbId, dedupKey: "d2", status: "ready" });

  const first = store.upsertEntity({ kbId, name: "Glycoprotein", type: "protein", firstSeenDoc: d1.id });
  assert.equal(first.supportCount, 1);
  // Re-run for the SAME document (e.g. forced re-extract): support unchanged.
  const again = store.upsertEntity({ kbId, name: "Glycoprotein", type: "protein", firstSeenDoc: d1.id });
  assert.equal(again.supportCount, 1);
  // A NEW document earns the bump.
  const secondDoc = store.upsertEntity({ kbId, name: "Glycoprotein", type: "protein", firstSeenDoc: d2.id });
  assert.equal(secondDoc.supportCount, 2);
  // Without a docId the increment stays unconditional (detail-tracking opt-out).
  const noDoc = store.upsertEntity({ kbId, name: "Glycoprotein", type: "protein" });
  assert.equal(noDoc.supportCount, 3);
});

test("attachToEntity promotes to core at 3 distinct supporting docs", async (context) => {
  const { store, kbId, cleanup } = setup("ke-res-attach-core");
  context.after(cleanup);

  // Create with a tracked doc, then two attaches on NEW documents:
  // support and the distinct-doc detail stay in lockstep.
  const d0 = store.upsertDocument({ kbId, dedupKey: "d0", status: "ready" });
  const target = store.upsertEntity({ kbId, name: "Glycoprotein", type: "protein", firstSeenDoc: d0.id });
  assert.equal(target.trustLevel, "candidate");
  for (const key of ["d1", "d2"]) {
    const doc = store.upsertDocument({ kbId, dedupKey: key, status: "ready" });
    store.attachToEntity(target.id, { name: "GP", docId: doc.id });
  }
  const promoted = store.getEntity(target.id)!;
  assert.equal(promoted.supportCount, 3);
  assert.equal(promoted.trustLevel, "core");
});

test("fingerprints track counts, support weights and latest edge creation", async (context) => {
  const { store, kbId, cleanup } = setup("ke-res-fingerprint");
  context.after(cleanup);

  const a = store.upsertEntity({ kbId, name: "A", type: "protein" });
  const b = store.upsertEntity({ kbId, name: "B", type: "protein" });
  assert.deepEqual(store.entitySupportStats(kbId), { count: 2, supportSum: 2 });
  assert.deepEqual(store.edgeFingerprint(kbId), { count: 0, supportSum: 0, maxCreatedAt: null });

  store.upsertEdge({ kbId, srcId: a.id, dstId: b.id, type: "binds" });
  const fp = store.edgeFingerprint(kbId);
  assert.equal(fp.count, 1);
  assert.equal(fp.supportSum, 1);
  assert.ok(fp.maxCreatedAt !== null);

  // A support bump without a count change still moves the fingerprint.
  store.upsertEdge({ kbId, srcId: a.id, dstId: b.id, type: "binds" });
  assert.equal(store.edgeFingerprint(kbId).supportSum, 2);
});

test("setCommunityIds assigns and clears; listEntitiesByIds round-trips", async (context) => {
  const { store, kbId, cleanup } = setup("ke-res-community");
  context.after(cleanup);

  const a = store.upsertEntity({ kbId, name: "A", type: "protein" });
  const b = store.upsertEntity({ kbId, name: "B", type: "protein" });
  store.setCommunityIds(kbId, new Map([[a.id, 0]]));
  assert.equal(store.getEntity(a.id)!.communityId, 0);
  assert.equal(store.getEntity(b.id)!.communityId, null);

  store.setCommunityIds(kbId, new Map([[a.id, 1], [b.id, 1]]));
  assert.equal(store.getEntity(b.id)!.communityId, 1);

  const listed = store.listEntitiesByIds(kbId, [b.id, a.id]);
  assert.equal(listed.length, 2);
  assert.deepEqual(store.listEntitiesByIds(kbId, []), []);
});
