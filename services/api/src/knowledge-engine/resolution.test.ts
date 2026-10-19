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
 * Entity-resolution service tests: online write-time gates inside extraction
 * (off/shadow/on), the offline batch job (merge, reject-cache resume, shadow
 * previews), and the graph-roots caching service (fingerprint + SWR).
 */

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { BIOMEDICAL_SCHEMA, type EntityResolutionMode } from "@sciencediscovery/knowledge-engine";

import { createGraphRootsService, parseNamingResponse } from "./graph-roots.js";
import { KeJobRunner } from "./job-runner.js";
import { KeOrchestrator, KE_EXTRACT_JOB, KE_ENTITY_RESOLUTION_JOB } from "./orchestrator.js";
import { runEntityResolution } from "./resolution-runner.js";
import { KnowledgeEngineStore } from "./store.js";
import { buildSourceChain } from "./connectors/source-chain.js";
import type { ScholarlyTransport } from "./connectors/transport.js";

function tempRoot(name: string): string {
  return resolve(process.cwd(), ".tmp", `${name}-${Date.now()}-${process.pid}`);
}

const JATS = `<?xml version="1.0"?>
<article>
  <front><article-meta>
    <title-group><article-title>mAb114 neutralizes Ebola virus glycoprotein</article-title></title-group>
    <abstract><p>mAb114 neutralizes Ebola virus by binding the glycoprotein core.</p></abstract>
  </article-meta></front>
  <body><sec><title>Results</title>
    <p>mAb114 neutralizes Ebola virus by binding the glycoprotein core.</p>
    <p>NPC1 serves as the entry receptor for Ebola virus.</p>
  </sec></body>
</article>`;

/** Extraction response: "GP" is the resolution candidate (alias of the
 *  pre-seeded entity), everything else anchors the graph. */
const EXTRACTION_RESPONSE = JSON.stringify({
  entities: [
    { name: "mAb114", type: "antibody" },
    { name: "GP", type: "protein" },
    { name: "Ebola virus", type: "virus" },
  ],
  relations: [
    {
      source: "mAb114",
      target: "GP",
      type: "binds",
      evidence_quote: "mAb114 neutralizes Ebola virus by binding the glycoprotein core.",
    },
  ],
});

const EPMC_SEARCH = JSON.stringify({
  resultList: {
    result: [
      {
        title: "mAb114 neutralizes Ebola virus glycoprotein",
        authorString: "Smith A",
        pubYear: "2024",
        doi: "10.1/mab114",
        pmcid: "PMC100",
        abstractText: "mAb114 neutralizes Ebola virus.",
        fullTextUrlList: { fullTextUrl: [] },
      },
    ],
  },
});

function stubTransport(): ScholarlyTransport {
  return {
    async get(url: string) {
      const body = url.includes("/search?query=") ? EPMC_SEARCH : url.includes("fullTextXML") ? JATS : null;
      if (!body) throw new Error(`unexpected url: ${url}`);
      const bytes = new TextEncoder().encode(body);
      return {
        status: 200,
        url,
        header: () => null,
        text: async () => body,
        json: async () => JSON.parse(body),
        bytes: async () => bytes,
      };
    },
  };
}

const JUDGE_PROMPT_MARKER = "判断以下两个实体";

function createHarness(
  root: string,
  options: {
    mode?: () => EntityResolutionMode;
    judge?: (prompt: string) => string;
    onWarn?: (message: string, detail?: unknown) => void;
  } = {},
) {
  const store = KnowledgeEngineStore.open(root);
  const chain = buildSourceChain({ transport: stubTransport() });
  const judgeCalls: string[] = [];
  const orchestrator = new KeOrchestrator({
    store,
    chain,
    transport: stubTransport(),
    schema: BIOMEDICAL_SCHEMA,
    resolveEndpoint: () => ({ baseUrl: "http://stub", model: "m" }),
    llmInvoke: async (_endpoint, _system, user) => {
      if (user.includes(JUDGE_PROMPT_MARKER)) {
        judgeCalls.push(user);
        return options.judge ? options.judge(user) : JSON.stringify({ verdict: "unrelated" });
      }
      return EXTRACTION_RESPONSE;
    },
    assertUrl: async () => {},
    ...(options.mode ? { resolutionMode: options.mode } : {}),
    ...(options.onWarn ? { onWarn: options.onWarn } : {}),
  });
  const runner = new KeJobRunner(store);
  orchestrator.registerJobs(runner);
  return { store, orchestrator, runner, judgeCalls };
}

async function drain(runner: KeJobRunner, maxTicks = 20): Promise<void> {
  for (let index = 0; index < maxTicks; index += 1) {
    if (!(await runner.tick())) return;
  }
  throw new Error("queue did not drain");
}

/** Seed one doc through the real pipeline (JATS in, extraction out). */
async function seedOne(
  orchestrator: KeOrchestrator,
  runner: KeJobRunner,
  store: KnowledgeEngineStore,
  kbId: string,
): Promise<void> {
  await orchestrator.seedKb(kbId, "ebola glycoprotein antibody", 5);
  await drain(runner);
  assert.equal(store.listJobs({ type: KE_EXTRACT_JOB, status: "succeeded" }).length, 1);
}

// ------------------------------------------------------------ online track

test("resolution off (default): extraction writes byte-identical, zero audit rows", async (context) => {
  const root = tempRoot("ke-res-online-off");
  const { store, orchestrator, runner } = createHarness(root);
  context.after(() => store.close());
  context.after(() => rm(root, { force: true, recursive: true }));

  const kb = store.createKnowledgeBase({ name: "Ebola" });
  // Pre-seed the alias target the resolver WOULD hit if it were on.
  store.upsertEntity({ kbId: kb.id, name: "Glycoprotein", type: "protein", aliases: ["GP"] });
  await seedOne(orchestrator, runner, store, kb.id);

  // 3 extracted + 1 pre-seeded, no attach, no audit.
  assert.equal(store.listEntities(kb.id).length, 4);
  assert.equal(store.listEntityMerges(kb.id).length, 0);
});

test("resolution on: alias candidate attaches to the existing entity and edges bind to it", async (context) => {
  const root = tempRoot("ke-res-online-on");
  const { store, orchestrator, runner } = createHarness(root, { mode: () => "on" });
  context.after(() => store.close());
  context.after(() => rm(root, { force: true, recursive: true }));

  const kb = store.createKnowledgeBase({ name: "Ebola" });
  const target = store.upsertEntity({ kbId: kb.id, name: "Glycoprotein", type: "protein", aliases: ["GP"] });
  await seedOne(orchestrator, runner, store, kb.id);

  const entities = store.listEntities(kb.id);
  // GP did NOT create a second protein node: 3 entities total.
  assert.equal(entities.length, 3);
  assert.ok(!entities.some((e) => e.name === "GP"));
  const attached = store.getEntity(target.id)!;
  assert.ok(attached.supportCount >= 2); // pre-seed 1 + attach +1
  // The edge binds to the TARGET, not a new node.
  const edges = store.listEdges(kb.id);
  assert.equal(edges.length, 1);
  assert.equal(edges[0]!.dstId, target.id);
  // Audit row: online attach via alias.
  const merges = store.listEntityMerges(kb.id);
  assert.equal(merges.length, 1);
  assert.equal(merges[0]!.decidedBy, "alias");
  assert.equal(merges[0]!.canonicalId, target.id);
  assert.match(merges[0]!.absorbedId, /^candidate:gp$/);
});

test("resolution shadow: decision audited with shadow: prefix, writes unchanged", async (context) => {
  const root = tempRoot("ke-res-online-shadow");
  const { store, orchestrator, runner } = createHarness(root, { mode: () => "shadow" });
  context.after(() => store.close());
  context.after(() => rm(root, { force: true, recursive: true }));

  const kb = store.createKnowledgeBase({ name: "Ebola" });
  store.upsertEntity({ kbId: kb.id, name: "Glycoprotein", type: "protein", aliases: ["GP"] });
  await seedOne(orchestrator, runner, store, kb.id);

  // GP is still its own node (shadow never alters writes)…
  assert.equal(store.listEntities(kb.id).length, 4);
  // …but the decision is on record.
  const merges = store.listEntityMerges(kb.id);
  assert.equal(merges.length, 1);
  assert.equal(merges[0]!.decidedBy, "shadow:alias");
});

test("resolution on: deterministic miss + judge unrelated → new entity (fail-open chain)", async (context) => {
  const root = tempRoot("ke-res-online-new");
  // Judge always says unrelated; nothing deterministic matches → all new.
  const { store, orchestrator, runner } = createHarness(root, { mode: () => "on" });
  context.after(() => store.close());
  context.after(() => rm(root, { force: true, recursive: true }));

  const kb = store.createKnowledgeBase({ name: "Ebola" });
  await seedOne(orchestrator, runner, store, kb.id);
  assert.equal(store.listEntities(kb.id).length, 3);
  assert.equal(store.listEntityMerges(kb.id).length, 0);
});

test("resolution on: resolver failure falls back to plain upsert (job survives)", async (context) => {
  const root = tempRoot("ke-res-online-failopen");
  const warnings: string[] = [];
  const { store, orchestrator, runner } = createHarness(root, {
    mode: () => "on",
    onWarn: (message) => warnings.push(message),
  });
  context.after(() => store.close());
  context.after(() => rm(root, { force: true, recursive: true }));

  const kb = store.createKnowledgeBase({ name: "Ebola" });
  store.upsertEntity({ kbId: kb.id, name: "Glycoprotein", type: "protein", aliases: ["GP"] });
  // Break the L1 repo path mid-extraction: the resolver throws on every
  // candidate — every write must fall back to the plain upsert.
  const breaking = store.findEntityByAlias.bind(store);
  store.findEntityByAlias = (kbId, alias) => {
    void kbId;
    void alias;
    throw new Error("simulated resolver repo outage");
  };

  await seedOne(orchestrator, runner, store, kb.id);

  // Extraction succeeded despite the outage (fail-open), writes unchanged.
  assert.equal(store.listJobs({ type: KE_EXTRACT_JOB, status: "succeeded" }).length, 1);
  assert.equal(store.listEntities(kb.id).length, 4);
  assert.ok(warnings.includes("ke_resolution_attach_failed"));
  store.findEntityByAlias = breaking;
});

// ------------------------------------------------------------ batch track

const CLUSTER_JUDGE_MARKER = "指向同一概念";

function batchDeps(
  store: KnowledgeEngineStore,
  options: {
    mode: () => EntityResolutionMode;
    judgeResponse?: string;
    noEndpoint?: boolean;
    judgeCalls?: string[];
  },
) {
  return {
    store,
    ...(options.noEndpoint ? {} : { resolveEndpoint: () => ({ baseUrl: "http://stub", model: "m" }) }),
    llmInvoke: async (_endpoint: unknown, _system: string, user: string) => {
      assert.ok(user.includes(CLUSTER_JUDGE_MARKER));
      options.judgeCalls?.push(user);
      return options.judgeResponse ?? JSON.stringify({ groups: [] });
    },
    mode: options.mode,
  };
}

test("batch resolution off → skipped no-op; missing endpoint → clear failure", async (context) => {
  const root = tempRoot("ke-res-batch-off");
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  context.after(() => rm(root, { force: true, recursive: true }));
  const kb = store.createKnowledgeBase({ name: "Ebola" });
  store.upsertEntity({ kbId: kb.id, name: "Ebola virus glycoprotein", type: "protein" });
  store.upsertEntity({ kbId: kb.id, name: "Ebola virus glycoproteins", type: "protein" });

  const fakeJob = { id: "job-1", payload: { kbId: kb.id } } as unknown as import("./store.js").KeJobRow;
  const skipped = await runEntityResolution(batchDeps(store, { mode: () => "off" }), fakeJob);
  assert.match(String(skipped["skipped"]), /mode off/);

  await assert.rejects(
    runEntityResolution(batchDeps(store, { mode: () => "on", noEndpoint: true }), fakeJob),
    /no pipeline model configured/,
  );
});

test("batch resolution on: cluster judge merges the split pair; judged pairs never re-judged", async (context) => {
  const root = tempRoot("ke-res-batch-on");
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  context.after(() => rm(root, { force: true, recursive: true }));
  const kb = store.createKnowledgeBase({ name: "Ebola" });
  // Trigram-similar singular/plural split (sim ≈ 0.97 ≥ embedLow) — string
  // channel alone forms the component (no embeddings configured).
  store.upsertEntity({ kbId: kb.id, name: "Ebola virus glycoprotein", type: "protein" });
  store.upsertEntity({ kbId: kb.id, name: "Ebola virus glycoproteins", type: "protein" });
  // A same-type but dissimilar entity must NOT be recalled.
  store.upsertEntity({ kbId: kb.id, name: "Interferon gamma", type: "protein" });

  const judgeCalls: string[] = [];
  const judgeResponse = JSON.stringify({
    groups: [{ canonical: "Ebola virus glycoprotein", members: [1, 2], reason: "singular/plural" }],
  });
  const fakeJob = { id: "job-1", payload: { kbId: kb.id } } as unknown as import("./store.js").KeJobRow;

  const result = await runEntityResolution(
    batchDeps(store, { mode: () => "on", judgeResponse, judgeCalls }),
    fakeJob,
  );
  assert.equal(result["merged"], 1);
  assert.equal(store.listEntities(kb.id).length, 2); // 3 − 1 merged
  const merges = store.listEntityMerges(kb.id).filter((m) => m.decidedBy === "batch-llm");
  assert.equal(merges.length, 1);
  assert.equal(judgeCalls.length, 1);

  // Resume: the merged pair is cached; nothing is re-judged.
  const again = await runEntityResolution(
    batchDeps(store, { mode: () => "on", judgeResponse, judgeCalls }),
    fakeJob,
  );
  assert.equal(again["merged"], 0);
  assert.equal(judgeCalls.length, 1);
});

test("batch resolution: judge rejections are cached as llm-reject rows", async (context) => {
  const root = tempRoot("ke-res-batch-reject");
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  context.after(() => rm(root, { force: true, recursive: true }));
  const kb = store.createKnowledgeBase({ name: "Ebola" });
  store.upsertEntity({ kbId: kb.id, name: "Ebola virus glycoprotein", type: "protein" });
  store.upsertEntity({ kbId: kb.id, name: "Ebola virus glycoproteins", type: "protein" });

  const judgeCalls: string[] = [];
  const fakeJob = { id: "job-1", payload: { kbId: kb.id } } as unknown as import("./store.js").KeJobRow;
  // Judge groups nothing → the pair is a cached rejection.
  await runEntityResolution(batchDeps(store, { mode: () => "on", judgeCalls }), fakeJob);
  assert.equal(store.listEntities(kb.id).length, 2);
  const rejects = store.listEntityMerges(kb.id).filter((m) => m.decidedBy === "llm-reject");
  assert.equal(rejects.length, 1);
  assert.equal(judgeCalls.length, 1);

  // Second run: every pair cached → judge never fires again.
  await runEntityResolution(batchDeps(store, { mode: () => "on", judgeCalls }), fakeJob);
  assert.equal(judgeCalls.length, 1);
});

test("batch resolution shadow: preview rows only, graph untouched", async (context) => {
  const root = tempRoot("ke-res-batch-shadow");
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  context.after(() => rm(root, { force: true, recursive: true }));
  const kb = store.createKnowledgeBase({ name: "Ebola" });
  store.upsertEntity({ kbId: kb.id, name: "Ebola virus glycoprotein", type: "protein" });
  store.upsertEntity({ kbId: kb.id, name: "Ebola virus glycoproteins", type: "protein" });

  const judgeResponse = JSON.stringify({
    groups: [{ canonical: "Ebola virus glycoprotein", members: [1, 2], reason: "same" }],
  });
  const fakeJob = { id: "job-1", payload: { kbId: kb.id } } as unknown as import("./store.js").KeJobRow;
  await runEntityResolution(batchDeps(store, { mode: () => "shadow", judgeResponse }), fakeJob);

  assert.equal(store.listEntities(kb.id).length, 2); // untouched
  const previews = store.listEntityMerges(kb.id).filter((m) => m.decidedBy === "shadow:batch-llm");
  assert.equal(previews.length, 1);
  assert.equal((previews[0]!.absorbedSnapshot as { batchPreview?: boolean }).batchPreview, true);
});

test("batch shadow → on: shadow previews do NOT poison the judged-pair cache", async (context) => {
  const root = tempRoot("ke-res-batch-shadow-on");
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  context.after(() => rm(root, { force: true, recursive: true }));
  const kb = store.createKnowledgeBase({ name: "Ebola" });
  store.upsertEntity({ kbId: kb.id, name: "Ebola virus glycoprotein", type: "protein" });
  store.upsertEntity({ kbId: kb.id, name: "Ebola virus glycoproteins", type: "protein" });

  const judgeResponse = JSON.stringify({
    groups: [{ canonical: "Ebola virus glycoprotein", members: [1, 2], reason: "same" }],
  });
  const fakeJob = { id: "job-1", payload: { kbId: kb.id } } as unknown as import("./store.js").KeJobRow;

  // Shadow first: preview rows only, graph untouched.
  await runEntityResolution(batchDeps(store, { mode: () => "shadow", judgeResponse }), fakeJob);
  assert.equal(store.listEntities(kb.id).length, 2);
  assert.equal(store.listEntityMerges(kb.id).filter((m) => m.decidedBy === "shadow:batch-llm").length, 1);

  // Then on: the shadow positives are NOT treated as judged — the cluster is
  // re-judged and the merge actually executes.
  const judgeCalls: string[] = [];
  const result = await runEntityResolution(
    batchDeps(store, { mode: () => "on", judgeResponse, judgeCalls }),
    fakeJob,
  );
  assert.equal(judgeCalls.length, 1);
  assert.equal(result["merged"], 1);
  assert.equal(store.listEntities(kb.id).length, 1);
});

// ------------------------------------------------------------ graph roots

test("graph roots: first load computes + persists communities, fingerprint cache serves repeats", async (context) => {
  const root = tempRoot("ke-roots-cache");
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  context.after(() => rm(root, { force: true, recursive: true }));
  const kb = store.createKnowledgeBase({ name: "Ebola" });

  // Two tight clusters with one weak bridge.
  const ids: Record<string, string> = {};
  for (const name of ["a1", "a2", "a3", "b1", "b2", "b3"]) {
    ids[name] = store.upsertEntity({ kbId: kb.id, name, type: "protein" }).id;
  }
  const link = (a: string, b: string, w = 1) => {
    for (let i = 0; i < w; i++) store.upsertEdge({ kbId: kb.id, srcId: ids[a]!, dstId: ids[b]!, type: `t${i}` });
  };
  link("a1", "a2", 5); link("a1", "a3", 5); link("a2", "a3", 5);
  link("b1", "b2", 5); link("b1", "b3", 5); link("b2", "b3", 5);
  link("a1", "b1", 1);

  const service = createGraphRootsService({ store }); // no endpoint → rep-name fallback
  const roots = await service.getGraphRoots(kb.id);
  assert.equal(roots.method, "louvain");
  assert.equal(roots.entityCount, 6);
  assert.equal(roots.communities.length, 2);
  assert.equal(roots.communities[0]!.size, 3);
  assert.equal(roots.communityEdges.length, 1);

  // community_id persisted on rows
  const a1 = store.getEntity(ids["a1"]!)!;
  const b1 = store.getEntity(ids["b1"]!)!;
  assert.ok(a1.communityId !== null && b1.communityId !== null);
  assert.notEqual(a1.communityId, b1.communityId);

  // Repeat with unchanged graph → cached payload, identical fingerprint
  const again = await service.getGraphRoots(kb.id);
  assert.deepEqual(again, roots);
});

test("graph roots: stale-while-revalidate serves stale then refreshes in background", async (context) => {
  const root = tempRoot("ke-roots-swr");
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  context.after(() => rm(root, { force: true, recursive: true }));
  const kb = store.createKnowledgeBase({ name: "Ebola" });
  store.upsertEntity({ kbId: kb.id, name: "a", type: "protein" });
  store.upsertEntity({ kbId: kb.id, name: "b", type: "protein" });
  store.upsertEdge({ kbId: kb.id, srcId: store.listEntities(kb.id)[0]!.id, dstId: store.listEntities(kb.id)[1]!.id, type: "x" });

  const service = createGraphRootsService({ store });
  const first = await service.getGraphRoots(kb.id);
  assert.equal(first.entityCount, 2);

  // Change the graph → fingerprint mismatch → stale served immediately…
  store.upsertEntity({ kbId: kb.id, name: "c", type: "protein" });
  const stale = await service.getGraphRoots(kb.id);
  assert.equal(stale.entityCount, 2);

  // …background recompute lands the fresh partition.
  await service.waitForRevalidate(kb.id);
  const fresh = await service.getGraphRoots(kb.id);
  assert.equal(fresh.entityCount, 3);
});

test("graph roots: force bypasses the stale cache and binds to the live store", async (context) => {
  const root = tempRoot("ke-roots-force");
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  context.after(() => rm(root, { force: true, recursive: true }));
  const kb = store.createKnowledgeBase({ name: "Ebola" });
  store.upsertEntity({ kbId: kb.id, name: "a", type: "protein" });
  store.upsertEntity({ kbId: kb.id, name: "b", type: "protein" });
  store.upsertEdge({ kbId: kb.id, srcId: store.listEntities(kb.id)[0]!.id, dstId: store.listEntities(kb.id)[1]!.id, type: "x" });

  const service = createGraphRootsService({ store });
  await service.getGraphRoots(kb.id);

  // The graph moves; the plain read still serves the stale partition…
  store.upsertEntity({ kbId: kb.id, name: "c", type: "protein" });
  const stale = await service.getGraphRoots(kb.id);
  assert.equal(stale.entityCount, 2);

  // …but a force read (community report generation's contract) returns the
  // CURRENT graph synchronously — artifact keying must never lag the store.
  const forced = await service.getGraphRoots(kb.id, { force: true });
  assert.equal(forced.entityCount, 3);
  const liveFingerprint = (() => {
    const entityStats = store.entitySupportStats(kb.id);
    const edgeFp = store.edgeFingerprint(kb.id);
    return `e${entityStats.count}:${entityStats.supportSum}:x${edgeFp.count}:${edgeFp.supportSum}:${edgeFp.maxCreatedAt ?? "none"}`;
  })();
  assert.equal(forced.fingerprint, liveFingerprint);
  // The forced compute also refreshed the cache for plain readers.
  const after = await service.getGraphRoots(kb.id);
  assert.equal(after.entityCount, 3);
});

test("parseNamingResponse: numeric keys only, 30-char cap, garbage → empty", () => {
  const names = parseNamingResponse('{"0": "Glycoprotein entry", "x1": "junk", "2": "' + "长".repeat(40) + '"}');
  assert.equal(names.get(0), "Glycoprotein entry");
  assert.equal(names.has(1), false);
  assert.equal(names.get(2)!.length, 30);
  assert.equal(parseNamingResponse("not json").size, 0);
});

test("orchestrator exposes the resolution job type and enqueue dedup", async (context) => {
  const root = tempRoot("ke-res-enqueue");
  const { store, orchestrator } = createHarness(root);
  context.after(() => store.close());
  context.after(() => rm(root, { force: true, recursive: true }));
  const kb = store.createKnowledgeBase({ name: "Ebola" });

  const first = orchestrator.startResolution(kb.id);
  const second = orchestrator.startResolution(kb.id);
  assert.equal(first.enqueued, true);
  assert.equal(second.enqueued, false);
  assert.equal(first.jobId, second.jobId);
  assert.equal(store.listJobs({ type: KE_ENTITY_RESOLUTION_JOB }).length, 1);
});
