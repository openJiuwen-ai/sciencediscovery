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
import test from "node:test";

import { BIOMEDICAL_SCHEMA } from "@sciencediscovery/knowledge-engine";

import { KeJobRunner } from "./job-runner.js";
import { KeOrchestrator, KE_EXTRACT_JOB, KE_INGEST_JOB, KE_SEED_JOB } from "./orchestrator.js";
import { KnowledgeEngineStore } from "./store.js";
import { buildSourceChain } from "./connectors/source-chain.js";
import type { ScholarlyResponse, ScholarlyTransport } from "./connectors/transport.js";

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

const EXTRACTION_RESPONSE = JSON.stringify({
  entities: [
    { name: "Ebola virus", type: "virus", definition: "Filoviridae pathogen" },
    { name: "mAb114", type: "antibody" },
    { name: "glycoprotein", type: "protein", aliases: ["GP"] },
  ],
  relations: [
    {
      source: "mAb114",
      target: "Ebola virus",
      type: "neutralizes",
      evidence_quote: "mAb114 neutralizes Ebola virus by binding the glycoprotein core.",
    },
    {
      source: "mAb114",
      target: "glycoprotein",
      type: "binds",
      evidence_quote: "mAb114 neutralizes Ebola virus by binding the glycoprotein core.",
    },
    {
      source: "Ebola virus",
      target: "mAb114",
      type: "inhibits",
      evidence_quote: "This sentence was entirely fabricated by the model and never appears.",
    },
  ],
});

/** Scripted transport keyed by URL substring. */
function stubTransport(routes: Array<{ match: string; status: number; body: string }>): ScholarlyTransport {
  return {
    async get(url: string): Promise<ScholarlyResponse> {
      const route = routes.find((candidate) => url.includes(candidate.match));
      if (!route) throw new Error(`unexpected url: ${url}`);
      const bytes = new TextEncoder().encode(route.body);
      return {
        status: route.status,
        url,
        header: () => null,
        text: async () => route.body,
        json: async () => JSON.parse(route.body),
        bytes: async () => bytes,
      };
    },
  };
}

const EPMC_SEARCH = JSON.stringify({
  resultList: {
    result: [
      {
        title: "mAb114 neutralizes Ebola virus glycoprotein",
        authorString: "Smith A, Jones B",
        pubYear: "2024",
        doi: "10.1/mab114",
        pmcid: "PMC100",
        abstractText: "mAb114 neutralizes Ebola virus.",
        fullTextUrlList: { fullTextUrl: [] },
      },
    ],
  },
});

interface Harness {
  store: KnowledgeEngineStore;
  orchestrator: KeOrchestrator;
  runner: KeJobRunner;
  embeddingCalls: string[][];
}

function createHarness(options: { withEmbedding?: boolean } = {}): Harness {
  const root = tempRoot("ke-orchestrator");
  const store = KnowledgeEngineStore.open(root);
  const transport = stubTransport([
    { match: "/search?query=", status: 200, body: EPMC_SEARCH },
    { match: "fullTextXML", status: 200, body: JATS },
  ]);
  const chain = buildSourceChain({ transport });
  const embeddingCalls: string[][] = [];
  const orchestrator = new KeOrchestrator({
    store,
    chain,
    transport,
    schema: BIOMEDICAL_SCHEMA,
    resolveEndpoint: () => ({ baseUrl: "http://stub", model: "m" }),
    llmInvoke: async () => EXTRACTION_RESPONSE,
    assertUrl: async () => {},
    ...(options.withEmbedding
      ? {
          embedding: {
            embed: async (texts: readonly string[]) => {
              embeddingCalls.push([...texts]);
              return texts.map((_text, index) => new Float32Array([index + 1, 0, 0]));
            },
          } as unknown as import("./embedding.js").EmbeddingClient,
        }
      : {}),
  });
  const runner = new KeJobRunner(store);
  orchestrator.registerJobs(runner);
  return { store, orchestrator, runner, embeddingCalls };
}

/** Drain the queue: seed → ingest → extract all run via tick(). */
async function drain(runner: KeJobRunner, maxTicks = 20): Promise<void> {
  for (let index = 0; index < maxTicks; index += 1) {
    if (!(await runner.tick())) return;
  }
  throw new Error("queue did not drain");
}

test("seed → ingest(JATS) → extract: full pipeline builds the graph", async (context) => {
  const root = resolve(process.cwd(), ".tmp");
  context.after(() => rm(root, { force: true, recursive: true }));
  const { store, orchestrator, runner } = createHarness();

  const kb = store.createKnowledgeBase({ name: "Ebola" });
  const { enqueued } = await orchestrator.seedKb(kb.id, "ebola glycoprotein antibody", 10);
  assert.equal(enqueued, true);
  assert.equal(store.listJobs({ type: KE_SEED_JOB }).length, 1);

  await drain(runner);

  // Document: JATS-ingested, ready, watermarked through extraction.
  const docs = store.listDocuments(kb.id);
  assert.equal(docs.length, 1);
  assert.equal(docs[0]?.status, "ready");
  assert.equal(docs[0]?.sourceMeta["ingest_channel"], "europepmc-jats");
  assert.ok(docs[0]?.sourceMeta["extracted_at"]);
  assert.match(docs[0]?.fulltext ?? "", /mAb114 neutralizes Ebola virus/);

  // Graph: 3 entities, 2 verified edges (fabricated relation dropped by the gate).
  const entities = store.listEntities(kb.id);
  assert.equal(entities.length, 3);
  const edges = store.listEdges(kb.id);
  assert.equal(edges.length, 2);
  assert.deepEqual(
    edges.map((edge) => edge.type).sort(),
    ["binds", "neutralizes"],
  );
  // Evidence quotes are stored with the edges.
  assert.ok(edges.every((edge) => edge.evidenceQuote && edge.evidenceDocId === docs[0]?.id));

  // All jobs succeeded.
  assert.equal(store.listJobs({ status: "failed" }).length, 0);
  assert.equal(store.listJobs({ status: "dead" }).length, 0);
  assert.equal(store.listJobs({ type: KE_EXTRACT_JOB, status: "succeeded" }).length, 1);
  assert.equal(store.listJobs({ type: KE_INGEST_JOB, status: "succeeded" }).length, 1);
});

test("extraction writes embeddings when the client is configured", async (context) => {
  const root = resolve(process.cwd(), ".tmp");
  context.after(() => rm(root, { force: true, recursive: true }));
  const { store, orchestrator, runner, embeddingCalls } = createHarness({ withEmbedding: true });

  const kb = store.createKnowledgeBase({ name: "Ebola" });
  await orchestrator.seedKb(kb.id, "ebola", 10);
  await drain(runner);

  assert.equal(embeddingCalls.length, 1);
  assert.equal(embeddingCalls[0]?.length, 3);
  const withEmbedding = store.listEntities(kb.id, { withEmbedding: true });
  assert.equal(withEmbedding.length, 3);
  assert.ok(withEmbedding[0]!.embedding instanceof Uint8Array);
});

test("re-seeding the same query is idempotent (watermarks)", async (context) => {
  const root = resolve(process.cwd(), ".tmp");
  context.after(() => rm(root, { force: true, recursive: true }));
  const { store, orchestrator, runner } = createHarness();

  const kb = store.createKnowledgeBase({ name: "Ebola" });
  await orchestrator.seedKb(kb.id, "ebola", 10);
  await drain(runner);

  // A completed seed does NOT suppress a re-seed (new seed job is fine —
  // that's how a KB picks up newer papers); downstream idempotency is what
  // matters: same single document, watermarks skip ingest/extract re-runs,
  // support counts stay at 1.
  const second = await orchestrator.seedKb(kb.id, "ebola", 10);
  assert.equal(second.enqueued, true);
  await drain(runner);
  assert.equal(store.listDocuments(kb.id).length, 1);
  const entities = store.listEntities(kb.id);
  assert.ok(entities.every((entity) => entity.supportCount === 1));
  assert.equal(store.listEdges(kb.id).length, 2);
});

test("ingest with no full text anywhere marks the document error without retry", async (context) => {
  const root = resolve(process.cwd(), ".tmp");
  context.after(() => rm(root, { force: true, recursive: true }));
  const transport = stubTransport([
    { match: "/search?query=", status: 200, body: EPMC_SEARCH },
    { match: "fullTextXML", status: 404, body: "" },
    { match: "api.openalex.org", status: 404, body: "{}" },
    { match: "api.semanticscholar.org", status: 404, body: "{}" },
  ]);
  const rootStore = KnowledgeEngineStore.open(tempRoot("ke-orchestrator-nf"));
  const chain = buildSourceChain({ transport });
  const orchestrator = new KeOrchestrator({
    store: rootStore,
    chain,
    transport,
    schema: BIOMEDICAL_SCHEMA,
    resolveEndpoint: () => ({ baseUrl: "http://stub", model: "m" }),
    llmInvoke: async () => EXTRACTION_RESPONSE,
    assertUrl: async () => {},
    paperText: async () => "unused",
  });
  const runner = new KeJobRunner(rootStore);
  orchestrator.registerJobs(runner);

  const kb = rootStore.createKnowledgeBase({ name: "Ebola" });
  await orchestrator.seedKb(kb.id, "ebola", 10);
  await drain(runner);

  const docs = rootStore.listDocuments(kb.id);
  assert.equal(docs[0]?.status, "error");
  assert.match(String(docs[0]?.sourceMeta["ingest_error"]), /No downloadable PDF/);
  // The ingest job COMPLETED (definitive miss is not retryable), and no
  // extraction was ever enqueued for the failed document.
  assert.equal(rootStore.listJobs({ type: KE_INGEST_JOB, status: "succeeded" }).length, 1);
  assert.equal(rootStore.listJobs({ type: KE_EXTRACT_JOB }).length, 0);
});
