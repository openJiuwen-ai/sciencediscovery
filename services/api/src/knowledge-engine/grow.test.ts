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
 * Grow-cycle integration tests: the deterministic crawl loop driven through
 * the real job runner against a real store, with only the outer world
 * (download / citation resolution / search / embedding) stubbed via the
 * orchestrator's grow-deps seam. Route-level coverage for the grow API lives
 * here too (handler + fake response, same pattern as routes.test.ts).
 */

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { BIOMEDICAL_SCHEMA } from "@sciencediscovery/knowledge-engine";

import { KeJobRunner } from "./job-runner.js";
import { KeOrchestrator, KE_GROW_JOB } from "./orchestrator.js";
import { KnowledgeEngineStore } from "./store.js";
import { buildSourceChain } from "./connectors/source-chain.js";
import { NotFoundError, paperDedupKey, type PaperRef } from "./connectors/types.js";
import { handleKeGetGrow, handleKeStartGrow, KeApiError } from "./routes.js";

function tempRoot(name: string): string {
  return resolve(process.cwd(), ".tmp", `${name}-${Date.now()}-${process.pid}`);
}

function makeRef(sourceId: string, title: string, abstract: string | null = "relevant paper"): PaperRef {
  return {
    title,
    authors: ["Tester A"],
    year: 2024,
    doi: null,
    arxivId: null,
    abstract,
    pdfUrl: null,
    citationCount: null,
    source: "test",
    sourceId,
  };
}

interface GrowStubs {
  download: (title: string, ref: PaperRef) => Promise<void>;
  citations: Record<string, PaperRef[]>;
  searchCalls: string[];
  downloadCalls: string[];
}

interface Harness {
  store: KnowledgeEngineStore;
  orchestrator: KeOrchestrator;
  runner: KeJobRunner;
}

/** Orchestrator with the grow deps fully stubbed (the default sub-chain would
 *  hit the network, so every test MUST override all four metadata deps). */
function createHarness(root: string, stubs: GrowStubs): Harness {
  const store = KnowledgeEngineStore.open(root);
  const chain = buildSourceChain({ transport: { async get() { throw new Error("network disabled in grow tests"); } } });
  const orchestrator = new KeOrchestrator({
    store,
    chain,
    transport: { async get() { throw new Error("network disabled in grow tests"); } },
    schema: BIOMEDICAL_SCHEMA,
    grow: {
      download: async (kbId, ref) => {
        stubs.downloadCalls.push(ref.title);
        await stubs.download(ref.title, ref);
        const doc = store.upsertDocument({
          kbId,
          dedupKey: paperDedupKey(ref),
          title: ref.title,
          status: "ready",
          fulltext: "full text ".repeat(100),
          sourceMeta: { paperRef: ref as unknown as Record<string, unknown>, ingested_at: new Date().toISOString() },
        });
        return { documentId: doc.id };
      },
      resolveCitations: async (ref) => stubs.citations[ref.sourceId] ?? [],
      resolveForward: async () => [],
      searchPapers: async (query) => {
        stubs.searchCalls.push(query);
        return [];
      },
      embed: async (text) => (text.includes("relevant") ? new Float32Array([1, 0]) : new Float32Array([0, 1])),
    },
  });
  const runner = new KeJobRunner(store);
  orchestrator.registerJobs(runner);
  return { store, orchestrator, runner };
}

/** A ready, extraction-watermarked seed document (grow seeds resolve its citations). */
function addSeedDoc(store: KnowledgeEngineStore, kbId: string, sourceId: string): void {
  const ref = makeRef(sourceId, `Seed ${sourceId}`);
  store.upsertDocument({
    kbId,
    dedupKey: paperDedupKey(ref),
    title: ref.title,
    status: "ready",
    fulltext: "seed text ".repeat(100),
    sourceUri: `doi:${sourceId}`,
    sourceMeta: {
      paperRef: ref as unknown as Record<string, unknown>,
      ingested_at: new Date().toISOString(),
      extracted_at: new Date().toISOString(),
    },
  });
}

async function drain(runner: KeJobRunner, maxTicks = 30): Promise<void> {
  for (let index = 0; index < maxTicks; index += 1) {
    if (!(await runner.tick())) return;
  }
  throw new Error("queue did not drain");
}

// ------------------------------------------------------------------ cycles

test("grow cycle: seed → crawl → expand → finalize, engine state persisted", async (context) => {
  const root = tempRoot("ke-grow-full");
  context.after(() => rm(root, { force: true, recursive: true }));
  const candA = makeRef("a", "Candidate A relevant");
  const candB = makeRef("b", "Candidate B relevant");
  const candC = makeRef("c", "Candidate C relevant");
  const candD = makeRef("d", "Candidate D relevant");
  const candE = makeRef("e", "Candidate E relevant");
  const stubs: GrowStubs = {
    download: async () => {},
    citations: {
      seed1: [candA, candB],
      seed2: [candA, candC],
      a: [candD, candE],
      b: [candD, candE],
      c: [candD, candE],
    },
    searchCalls: [],
    downloadCalls: [],
  };
  const { store, orchestrator, runner } = createHarness(root, stubs);
  context.after(() => store.close());

  const kb = store.createKnowledgeBase({ name: "Ebola relevant" });
  addSeedDoc(store, kb.id, "seed1");
  addSeedDoc(store, kb.id, "seed2");
  // One entity so the entity_query phase has an anchor to search for.
  store.upsertEntity({ kbId: kb.id, name: "mAb114", type: "antibody" });

  const handle = orchestrator.startGrow(kb.id, "ebola relevant", { maxPapers: 50, maxDepth: 1, maxPerPaper: 5 });
  assert.equal(handle.reused, false);
  await drain(runner);

  // Grow job succeeded; all three seed phases watermarked.
  assert.equal(store.listJobs({ type: KE_GROW_JOB, status: "succeeded" }).length, 1);
  const phases = JSON.parse(store.getSetting(`grow_seed_phase:${handle.cycleId}`) ?? "[]") as string[];
  assert.deepEqual(phases, ["backward", "entity_query", "forward"]);
  // The entity anchor produced a patch query.
  assert.ok(stubs.searchCalls.some((query) => query.includes("mAb114")));

  // Frontier: A/B/C (depth 0) + D/E (depth 1), all downloaded and done.
  const counts = store.frontierCounts(handle.cycleId);
  assert.deepEqual(counts, { total: 5, pending: 0, done: 5, failed: 0, skipped: 0 });

  // Depths recorded; D was rediscovered by three parents → hub threshold hit.
  const items = store.frontierList(handle.cycleId);
  const byKey = new Map(items.map((item) => [item.dedupKey, item]));
  assert.equal(byKey.get(paperDedupKey(candA))?.depth, 0);
  assert.equal(byKey.get(paperDedupKey(candD))?.depth, 1);
  assert.ok((byKey.get(paperDedupKey(candD))?.citeHits ?? 0) >= 3);

  // AA support: candidate A's doc carries its resolved reference keys.
  const docA = store.findDocumentByDedupKey(kb.id, paperDedupKey(candA));
  assert.deepEqual([...(docA?.refIds ?? [])].sort(), [paperDedupKey(candD), paperDedupKey(candE)].sort());

  // Engine state: persisted convergence with the cycle id.
  const engineState = store.getKnowledgeBase(kb.id)?.engineState as {
    cycleId?: string;
    converged?: boolean;
    signals?: { citationCoverage?: { met: boolean }; frontierExhaustion?: { met: boolean } };
    updatedAt?: string;
    directives?: string[];
  };
  assert.equal(engineState.cycleId, handle.cycleId);
  assert.equal(engineState.converged, true); // coverage + exhaustion met, recall dimension n/a
  assert.equal(engineState.signals?.citationCoverage?.met, true);
  assert.equal(engineState.signals?.frontierExhaustion?.met, true);
  assert.ok(engineState.updatedAt);

  // C3③: the converged cycle's reflection is persisted for the next cycle —
  // engine state carries the directive texts, the per-KB setting the full
  // structured form. This cycle had low duplication (5/10), so it must NOT
  // have narrowed the queries; convergence yields the hold directive.
  assert.ok(engineState.directives?.some((text) => text.includes("prefer depth")));
  const persisted = JSON.parse(store.getSetting(`grow_directives:${kb.id}`) ?? "null") as {
    cycleId?: string;
    directives?: Array<{ kind: string; text: string }>;
  } | null;
  assert.equal(persisted?.cycleId, handle.cycleId);
  assert.ok(persisted?.directives?.some((directive) => directive.kind === "converged-hold"));

  // 2 seeds + 5 candidates, all ready.
  assert.equal(store.listDocuments(kb.id).length, 7);
});

test("C3③: a persisted narrow-queries directive caps the next cycle's patch queries", async (context) => {
  const root = tempRoot("ke-grow-directives");
  context.after(() => rm(root, { force: true, recursive: true }));
  const stubs: GrowStubs = { download: async () => {}, citations: {}, searchCalls: [], downloadCalls: [] };
  const { store, orchestrator, runner } = createHarness(root, stubs);
  context.after(() => store.close());

  const kb = store.createKnowledgeBase({ name: "Ebola" });
  addSeedDoc(store, kb.id, "seed1");
  // Five isolated entities → three anchor patch queries without a cap.
  for (const name of ["mAb114", "REGN3470", "KZ52", "13C6", "2G4"]) {
    store.upsertEntity({ kbId: kb.id, name, type: "antibody" });
  }
  // The previous cycle's reflection: saturated corpus → keep 1 query.
  store.setSetting(`grow_directives:${kb.id}`, JSON.stringify({
    cycleId: "previous-cycle",
    createdAt: new Date().toISOString(),
    directives: [{
      kind: "narrow-queries",
      text: "Discovery is saturating — keep only the most specific patch queries.",
      patchQueryCap: 1,
    }],
  }));

  const handle = orchestrator.startGrow(kb.id, "ebola", { maxPapers: 50, maxDepth: 0, maxPerPaper: 5 });
  await drain(runner);
  assert.equal(store.listJobs({ type: KE_GROW_JOB, status: "succeeded" }).length, 1);

  // Exactly one entity-anchored patch query was issued (the engine-query
  // recall sampling calls are filtered out by the entity names).
  const patchQueries = stubs.searchCalls.filter((query) =>
    ["mAb114", "REGN3470", "KZ52", "13C6", "2G4"].some((name) => query.includes(name)));
  assert.equal(patchQueries.length, 1);

  // The new cycle's own reflection replaced the injected one.
  const persisted = JSON.parse(store.getSetting(`grow_directives:${kb.id}`) ?? "null") as {
    cycleId?: string;
    directives?: unknown[];
  } | null;
  assert.equal(persisted?.cycleId, handle.cycleId);
});

test("startGrow reuses the active cycle instead of creating a second one", async (context) => {
  const root = tempRoot("ke-grow-reuse");
  context.after(() => rm(root, { force: true, recursive: true }));
  const stubs: GrowStubs = { download: async () => {}, citations: {}, searchCalls: [], downloadCalls: [] };
  const { store, orchestrator } = createHarness(root, stubs);
  context.after(() => store.close());
  const kb = store.createKnowledgeBase({ name: "Ebola" });

  const first = orchestrator.startGrow(kb.id, "ebola");
  const second = orchestrator.startGrow(kb.id, "ebola");
  assert.equal(second.reused, true);
  assert.equal(second.cycleId, first.cycleId);
  assert.equal(store.listJobs({ type: KE_GROW_JOB }).length, 1);
});

test("budget hard stop: extra candidates are skipped once maxPapers is reached", async (context) => {
  const root = tempRoot("ke-grow-budget");
  context.after(() => rm(root, { force: true, recursive: true }));
  const stubs: GrowStubs = {
    download: async () => {},
    citations: { seed1: [makeRef("a", "A relevant"), makeRef("b", "B relevant"), makeRef("c", "C relevant")] },
    searchCalls: [],
    downloadCalls: [],
  };
  const { store, orchestrator, runner } = createHarness(root, stubs);
  context.after(() => store.close());
  const kb = store.createKnowledgeBase({ name: "Ebola relevant" });
  addSeedDoc(store, kb.id, "seed1");

  const handle = orchestrator.startGrow(kb.id, "ebola relevant", { maxPapers: 1, maxDepth: 0, maxPerPaper: 5 });
  await drain(runner);

  const counts = store.frontierCounts(handle.cycleId);
  assert.equal(counts.done, 1);
  assert.equal(counts.skipped, 2);
  assert.equal(store.listJobs({ type: KE_GROW_JOB, status: "succeeded" }).length, 1);
});

test("definitive no-full-text marks the item failed but does not doom the cycle", async (context) => {
  const root = tempRoot("ke-grow-notfound");
  context.after(() => rm(root, { force: true, recursive: true }));
  const stubs: GrowStubs = {
    download: async (title) => {
      if (title.startsWith("Paywalled")) throw new NotFoundError("No downloadable PDF from any source");
    },
    citations: { seed1: [makeRef("a", "Open A relevant"), makeRef("b", "Paywalled B relevant")] },
    searchCalls: [],
    downloadCalls: [],
  };
  const { store, orchestrator, runner } = createHarness(root, stubs);
  context.after(() => store.close());
  const kb = store.createKnowledgeBase({ name: "Ebola relevant" });
  addSeedDoc(store, kb.id, "seed1");

  const handle = orchestrator.startGrow(kb.id, "ebola relevant", { maxPapers: 10, maxDepth: 0, maxPerPaper: 5 });
  await drain(runner);

  const counts = store.frontierCounts(handle.cycleId);
  assert.equal(counts.done, 1);
  assert.equal(counts.failed, 1);
  // The cycle completed cleanly (NotFound is neutral for the doom counter).
  assert.equal(store.listJobs({ type: KE_GROW_JOB, status: "succeeded" }).length, 1);
});

test("doom loop: 10 consecutive download failures dead-letter the job after persisting state", async (context) => {
  const root = tempRoot("ke-grow-doom");
  context.after(() => rm(root, { force: true, recursive: true }));
  const candidates = Array.from({ length: 12 }, (_v, index) => makeRef(`c${index}`, `Cand ${index}`, null));
  const stubs: GrowStubs = {
    download: async () => {
      throw new Error("network down");
    },
    citations: { seed1: candidates },
    searchCalls: [],
    downloadCalls: [],
  };
  const { store, orchestrator, runner } = createHarness(root, stubs);
  context.after(() => store.close());
  const kb = store.createKnowledgeBase({ name: "Ebola" });
  addSeedDoc(store, kb.id, "seed1");

  const handle = orchestrator.startGrow(kb.id, "ebola", { maxPapers: 50, maxDepth: 0, maxPerPaper: 25 });
  await drain(runner);

  // The job is DEAD (nonRetryable), not pending-retry — and the engine state
  // was still persisted before the abort.
  const growJobs = store.listJobs({ type: KE_GROW_JOB });
  assert.equal(growJobs[0]?.status, "dead");
  assert.match(growJobs[0]?.error ?? "", /consecutive download failures/);
  const counts = store.frontierCounts(handle.cycleId);
  assert.equal(counts.done, 0);
  assert.equal(counts.skipped, 12);
  const engineState = store.getKnowledgeBase(kb.id)?.engineState as { updatedAt?: string };
  assert.ok(engineState.updatedAt);
});

// ------------------------------------------------------------------ routes

function fakeRequest(body: unknown): IncomingMessage {
  return Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
}

function fakeResponse(): { captured: { status: number; body: string }; response: ServerResponse } {
  const captured = { status: 0, body: "" };
  const response = {
    writeHead(status: number) {
      captured.status = status;
      return response;
    },
    end(body?: string) {
      captured.body = body ?? "";
    },
  } as unknown as ServerResponse;
  return { captured, response };
}

test("grow routes: POST validates input, starts a cycle; GET reports status", async (context) => {
  const root = tempRoot("ke-grow-routes");
  context.after(() => rm(root, { force: true, recursive: true }));
  const stubs: GrowStubs = { download: async () => {}, citations: {}, searchCalls: [], downloadCalls: [] };
  const { store, orchestrator } = createHarness(root, stubs);
  context.after(() => store.close());
  const kb = store.createKnowledgeBase({ name: "Ebola" });

  // 404 for a missing KB.
  await assert.rejects(
    () => handleKeStartGrow(fakeRequest({}), fakeResponse().response, orchestrator, store, "missing"),
    (error: unknown) => error instanceof KeApiError && error.statusCode === 404,
  );
  // 400 for a non-finite budget field.
  await assert.rejects(
    () => handleKeStartGrow(fakeRequest({ budget: { maxPapers: "lots" } }), fakeResponse().response, orchestrator, store, kb.id),
    (error: unknown) => error instanceof KeApiError && error.statusCode === 400,
  );

  // Happy path: 202 with the cycle handle.
  const started = fakeResponse();
  await handleKeStartGrow(
    fakeRequest({ query: "ebola", budget: { maxPapers: 5 } }),
    started.response,
    orchestrator,
    store,
    kb.id,
  );
  assert.equal(started.captured.status, 202);
  const handle = JSON.parse(started.captured.body) as { cycleId: string; reused: boolean };
  assert.equal(handle.reused, false);

  // GET: active cycle + frontier counts visible.
  const status = fakeResponse();
  handleKeGetGrow(status.response, store, kb.id);
  const payload = JSON.parse(status.captured.body) as {
    activeCycle: { cycleId: string; status: string } | null;
    frontier: { total: number } | null;
  };
  assert.equal(payload.activeCycle?.cycleId, handle.cycleId);
  assert.equal(payload.activeCycle?.status, "pending");
  assert.deepEqual(payload.frontier, { total: 0, pending: 0, done: 0, failed: 0, skipped: 0 });
});
