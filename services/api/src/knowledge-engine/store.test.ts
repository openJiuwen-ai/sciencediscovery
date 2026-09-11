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
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { KnowledgeEngineStore, normalizeEntityName } from "./store.js";

function tempRoot(name: string): string {
  return resolve(process.cwd(), ".tmp", `${name}-${Date.now()}-${process.pid}`);
}

test("normalizeEntityName folds case, accents and whitespace", () => {
  assert.equal(normalizeEntityName("  Ebola   Virus "), "ebola virus");
  assert.equal(normalizeEntityName("Förster  Resonance"), "förster resonance");
  assert.equal(normalizeEntityName("GP1,2"), "gp1,2");
});

test("open applies migrations idempotently and persists data", async (context) => {
  const root = tempRoot("ke-store-open");
  context.after(() => rm(root, { force: true, recursive: true }));

  const store = KnowledgeEngineStore.open(root);
  const kb = store.createKnowledgeBase({ name: "Ebola GP", description: "demo" });
  store.close();

  // Re-open: migrations must not re-run or fail, data must survive.
  const reopened = KnowledgeEngineStore.open(root);
  const loaded = reopened.getKnowledgeBase(kb.id);
  assert.equal(loaded?.name, "Ebola GP");
  reopened.close();

  // Sidecar read-only verification, same pattern as the catalog store tests.
  const sidecar = new DatabaseSync(resolve(root, "knowledge-engine", "knowledge-engine.sqlite"), { readOnly: true });
  const migrations = sidecar.prepare("SELECT version, name FROM ke_migrations ORDER BY version").all() as Array<{
    version: number;
    name: string;
  }>;
  assert.deepEqual(migrations.map((row) => row.version), [1, 2, 3, 4, 5, 6]);
  sidecar.close();
});

test("doc chunks round-trip with embeddings and rewrite idempotently", async (context) => {
  const root = tempRoot("ke-store-chunks");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const kb = store.createKnowledgeBase({ name: "kb" });
  const doc = store.upsertDocument({ kbId: kb.id, dedupKey: "doi:10.1/x", title: "Paper A", fulltext: "# T\n\nBody." });

  const written = store.replaceDocChunks(kb.id, doc.id, [
    { anchorId: `${doc.id}:paragraph:0`, blockType: "paragraph", section: "Methods", text: "The assay used mAb114." },
    { anchorId: `${doc.id}:heading:0`, blockType: "heading", section: null, text: "Methods" },
  ]);
  assert.equal(written, 2);
  assert.deepEqual(store.countDocChunks(kb.id), { total: 2, embedded: 0 });
  assert.deepEqual(store.listDocChunksWithEmbedding(kb.id), []);

  const vector = new Float32Array([0.5, 0.25, -1]);
  const updated = store.updateDocChunkEmbeddings(doc.id, new Map([
    [`${doc.id}:paragraph:0`, new Uint8Array(vector.buffer.slice(0))],
    [`${doc.id}:heading:0`, new Uint8Array(new Float32Array([1, 0, 0]).buffer.slice(0))],
    // Absent anchor — skipped, never a failure.
    [`${doc.id}:paragraph:99`, new Uint8Array(4)],
  ]));
  assert.equal(updated, 2);
  assert.deepEqual(store.countDocChunks(kb.id), { total: 2, embedded: 2 });
  const embedded = store.listDocChunksWithEmbedding(kb.id);
  assert.equal(embedded.length, 2);
  // Ordering is (created_at, anchor_id) — same timestamp, so heading sorts first.
  const paragraph = embedded.find((chunk) => chunk.anchorId.endsWith(":paragraph:0"));
  assert.equal(paragraph?.text, "The assay used mAb114.");
  assert.ok(paragraph?.embedding instanceof Uint8Array);

  // Rewrite replaces the document's chunks wholesale (idempotent derivation).
  store.replaceDocChunks(kb.id, doc.id, [
    { anchorId: `${doc.id}:paragraph:0`, blockType: "paragraph", section: null, text: "Rewritten." },
  ]);
  assert.deepEqual(store.countDocChunks(kb.id), { total: 1, embedded: 0 });
});

test("proposal rejects are recorded (capped) and queryable per KB/doc", async (context) => {
  const root = tempRoot("ke-store-rejects");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const kb = store.createKnowledgeBase({ name: "kb" });
  const doc = store.upsertDocument({ kbId: kb.id, dedupKey: "doi:10.1/x", title: "Paper A" });

  const rejects = [
    { section: "entities", index: 3, reason: "entity.type must be one of: virus, protein", excerpt: '{"name":"X","type":"cell"}' },
    { section: "relations", index: 0, reason: "relation.evidence_quote must be at least 10 characters", excerpt: '{"source":"A","target":"B"}' },
    { section: "response", index: 0, reason: "response is not parseable JSON", excerpt: "I cannot..." },
  ];
  const inserted = store.recordProposalRejects(kb.id, doc.id, rejects, { jobId: "job-1", attempts: 3 });
  assert.equal(inserted, 3);

  const listed = store.listProposalRejects(kb.id);
  assert.equal(listed.length, 3);
  assert.deepEqual(
    listed.map((row) => row.section).sort(),
    ["entities", "relations", "response"],
  );
  assert.ok(listed.every((row) => row.attempts === 3 && row.docId === doc.id));
  assert.equal(listed[0]?.jobId, "job-1");

  // Per-doc filter and the per-run recording cap.
  assert.equal(store.listProposalRejects(kb.id, { docId: doc.id }).length, 3);
  assert.equal(store.listProposalRejects(kb.id, { docId: "missing" }).length, 0);
  const many = Array.from({ length: 80 }, (_unused, index) => ({
    section: "entities", index, reason: "r", excerpt: "e",
  }));
  assert.equal(store.recordProposalRejects(kb.id, doc.id, many), KnowledgeEngineStore.MAX_RECORDED_REJECTS);
});

test("document upsert dedups by (kb, dedupKey) and preserves unset fields", async (context) => {
  const root = tempRoot("ke-store-doc");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const kb = store.createKnowledgeBase({ name: "kb" });

  const created = store.upsertDocument({ kbId: kb.id, dedupKey: "doi:10.1/x", title: "Paper A", abstract: "abs" });
  assert.equal(created.status, "pending");

  const updated = store.upsertDocument({
    kbId: kb.id,
    dedupKey: "doi:10.1/x",
    title: "Paper A",
    fulltext: "# Full text",
    status: "ready",
  });
  assert.equal(updated.id, created.id);
  assert.equal(updated.abstract, "abs");
  assert.equal(updated.fulltext, "# Full text");
  assert.equal(updated.status, "ready");
  assert.equal(store.listDocuments(kb.id).length, 1);
});

test("entity upsert merges by normalized name and records surface-form aliases", async (context) => {
  const root = tempRoot("ke-store-entity");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const kb = store.createKnowledgeBase({ name: "kb" });

  const first = store.upsertEntity({ kbId: kb.id, name: "Ebola virus", type: "virus" });
  const second = store.upsertEntity({ kbId: kb.id, name: "Ebola  Virus", type: "virus" });
  assert.equal(second.id, first.id);
  assert.equal(second.supportCount, 2);
  assert.deepEqual(second.aliases, ["Ebola  Virus"]);

  // Different type → different entity.
  const other = store.upsertEntity({ kbId: kb.id, name: "Ebola virus", type: "disease" });
  assert.notEqual(other.id, first.id);
});

test("entity embedding round-trips and withEmbedding filter works", async (context) => {
  const root = tempRoot("ke-store-embed");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const kb = store.createKnowledgeBase({ name: "kb" });

  const entity = store.upsertEntity({ kbId: kb.id, name: "GP", type: "protein" });
  store.upsertEntity({ kbId: kb.id, name: "VP40", type: "protein" });
  const vector = new Float32Array([0.5, 0.25, -1]);
  store.updateEntityEmbedding(entity.id, new Uint8Array(vector.buffer.slice(0)));

  const withEmbedding = store.listEntities(kb.id, { withEmbedding: true });
  assert.equal(withEmbedding.length, 1);
  const restored = new Float32Array(
    withEmbedding[0]!.embedding!.buffer.slice(
      withEmbedding[0]!.embedding!.byteOffset,
      withEmbedding[0]!.embedding!.byteOffset + withEmbedding[0]!.embedding!.byteLength,
    ),
  );
  assert.deepEqual([...restored], [0.5, 0.25, -1]);
});

test("edge upsert increments support on identical key, separates by evidence doc", async (context) => {
  const root = tempRoot("ke-store-edge");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const kb = store.createKnowledgeBase({ name: "kb" });
  const a = store.upsertEntity({ kbId: kb.id, name: "mAb114", type: "antibody" });
  const b = store.upsertEntity({ kbId: kb.id, name: "GP", type: "protein" });

  const first = store.upsertEdge({ kbId: kb.id, srcId: a.id, dstId: b.id, type: "binds", evidenceDocId: "doc1" });
  const second = store.upsertEdge({ kbId: kb.id, srcId: a.id, dstId: b.id, type: "binds", evidenceDocId: "doc1" });
  assert.equal(second.id, first.id);
  assert.equal(second.supportCount, 2);

  const third = store.upsertEdge({ kbId: kb.id, srcId: a.id, dstId: b.id, type: "binds", evidenceDocId: "doc2" });
  assert.notEqual(third.id, first.id);
  assert.equal(store.listEdges(kb.id, { entityId: a.id }).length, 2);
});

test("FTS recall finds entities by name and alias, documents by fulltext", async (context) => {
  const root = tempRoot("ke-store-fts");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const kb = store.createKnowledgeBase({ name: "kb" });

  const entity = store.upsertEntity({ kbId: kb.id, name: "ebolavirus glycoprotein", type: "protein" });
  const doc = store.upsertDocument({
    kbId: kb.id,
    dedupKey: "pmc:1",
    title: "Neutralizing antibodies",
    fulltext: "The glycoprotein mediates viral entry into host cells.",
    status: "ready",
  });

  assert.deepEqual(store.searchEntityIds(kb.id, "glycoprotein"), [entity.id]);
  assert.deepEqual(store.searchDocumentIds(kb.id, "viral entry"), [doc.id]);
  // Hyphenated/punctuated input must not break FTS5 parsing.
  assert.deepEqual(store.searchEntityIds(kb.id, "nonexistent-term-xyz"), []);
  assert.deepEqual(store.searchEntityIds(kb.id, "---"), []);
});

test("job queue: claim order, dedup, backoff, dead-letter and crash recovery", async (context) => {
  const root = tempRoot("ke-store-jobs");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());

  const { job: first, enqueued: firstEnqueued } = store.enqueueJob({
    type: "download",
    payload: { dedupKey: "doi:1", url: "http://x" },
    dedupKey: "doi:1",
  });
  assert.equal(firstEnqueued, true);
  const duplicate = store.enqueueJob({ type: "download", payload: { dedupKey: "doi:1" }, dedupKey: "doi:1" });
  assert.equal(duplicate.enqueued, false);
  assert.equal(duplicate.job.id, first.id);

  const claimed = store.claimNextJob(["download"]);
  assert.equal(claimed?.id, first.id);
  assert.equal(claimed?.attempts, 1);
  assert.equal(store.claimNextJob(["download"]), undefined);

  // Failure below the cap reschedules with a future run_after.
  const failed = store.failJob(first.id, "boom", { backoffBaseMs: 60_000 });
  assert.equal(failed.status, "pending");
  assert.ok(failed.runAfter > new Date().toISOString());
  assert.equal(store.claimNextJob(["download"]), undefined);

  // Exhaust attempts → dead.
  store.enqueueJob({ type: "download", payload: { dedupKey: "doi:2" }, dedupKey: "doi:2", maxAttempts: 1 });
  const doomed = store.claimNextJob(["download"]);
  assert.ok(doomed);
  const dead = store.failJob(doomed!.id, "boom");
  assert.equal(dead.status, "dead");

  // Crash recovery: a job stuck 'running' becomes claimable again.
  const { job: third } = store.enqueueJob({ type: "extract", payload: { docId: "d" } });
  const claimedThird = store.claimNextJob(["extract"]);
  assert.equal(claimedThird?.id, third.id);
  assert.deepEqual(store.recoverStaleJobs(), { recovered: 1, deadLettered: 0 });
  const reclaimed = store.claimNextJob(["extract"]);
  assert.equal(reclaimed?.id, third.id);
  store.completeJob(third.id);
  assert.equal(store.getJob(third.id)?.status, "succeeded");
});

test("crash recovery dead-letters jobs that already exhausted attempts", async (context) => {
  const root = tempRoot("ke-store-recover-dead");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());

  // attempts == maxAttempts while 'running' = the process crashed on its last
  // allowed try; recovery must dead-letter it, not loop it forever.
  store.enqueueJob({ type: "extract", payload: {}, maxAttempts: 1 });
  const job = store.claimNextJob(["extract"]);
  assert.equal(job?.attempts, 1);
  assert.deepEqual(store.recoverStaleJobs(), { recovered: 0, deadLettered: 1 });
  assert.equal(store.getJob(job!.id)?.status, "dead");
  assert.equal(store.claimNextJob(["extract"]), undefined);
});

test("job dedup works without the caller mirroring dedupKey into payload", async (context) => {
  const root = tempRoot("ke-store-dedup-column");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());

  // The key lives in its own column: payloads that never mention dedupKey
  // still dedup (the old json_extract-on-payload design silently failed here).
  const first = store.enqueueJob({ type: "download", payload: { url: "http://x" }, dedupKey: "doi:9" });
  const second = store.enqueueJob({ type: "download", payload: { other: true }, dedupKey: "doi:9" });
  assert.equal(first.enqueued, true);
  assert.equal(second.enqueued, false);
  assert.equal(second.job.id, first.job.id);
});

test("edge upsert merges NULL-evidence edges via the application-level path", async (context) => {
  const root = tempRoot("ke-store-null-edge");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const kb = store.createKnowledgeBase({ name: "kb" });
  const a = store.upsertEntity({ kbId: kb.id, name: "EBOV", type: "virus" });
  const b = store.upsertEntity({ kbId: kb.id, name: "NPC1", type: "protein" });

  // NULL evidence_doc_id: the SQL UNIQUE constraint cannot dedup these
  // (NULLs never compare equal) — the upsert's SELECT inside its transaction
  // is the only guard and must hold.
  const first = store.upsertEdge({ kbId: kb.id, srcId: a.id, dstId: b.id, type: "enters-via" });
  const second = store.upsertEdge({ kbId: kb.id, srcId: a.id, dstId: b.id, type: "enters-via" });
  assert.equal(second.id, first.id);
  assert.equal(second.supportCount, 2);
  assert.equal(store.listEdges(kb.id).length, 1);
});

test("FTS recall finds entities through recorded aliases", async (context) => {
  const root = tempRoot("ke-store-fts-alias");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const kb = store.createKnowledgeBase({ name: "kb" });

  const entity = store.upsertEntity({ kbId: kb.id, name: "ebolavirus glycoprotein", type: "protein" });
  // A differing surface form of the same normalized name becomes an alias…
  store.upsertEntity({ kbId: kb.id, name: "Ebolavirus  Glycoprotein", type: "protein" });
  const merged = store.getEntity(entity.id);
  assert.ok(merged!.aliases.length > 0);
  // …and the alias text is searchable via the FTS trigger on update.
  assert.deepEqual(store.searchEntityIds(kb.id, "glycoprotein"), [entity.id]);
});
