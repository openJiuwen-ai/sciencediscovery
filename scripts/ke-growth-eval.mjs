#!/usr/bin/env node
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
 * ke-growth-eval: retrospective delta-recall benchmark for the grow loop,
 * ported from the DeepAnalyze scripts/growth-eval harness.
 *
 * Modelled on DeepEvidence's "evidence gap discovery" protocol (Wang et al.,
 * Nat. Mach. Intell. 2026): given a candidate pool ranked by the PRODUCTION
 * scorer (rankCandidatePool), would the papers the engine eventually admitted
 * (the post-cutoff delta) land in the top-K?
 *
 * Per query: search the live source chain (cached to survive rate limits) →
 * label each result by dedupKey against ke_documents (delta = positive,
 * pre-cutoff = excluded, unknown = negative) → rank with the production
 * scorer → gap detection rate / recall@K / negative share.
 *
 * Caveat (recorded in the report): negatives were never actually scored in
 * production — negativeShare is counterfactual context, not a quality verdict.
 *
 * Needs: a stack data dir (--dataDir) and embedding env
 * (SCIENCE_AGENT_KE_EMBEDDING_BASE_URL/API_KEY/MODEL). Requires a prior
 * `pnpm build`.
 *
 * Usage:
 *   node scripts/ke-growth-eval.mjs --dataDir <stack data dir> \
 *     --kb <id> --cutoff 2026-09-01T00:00:00Z \
 *     --query "ebola glycoprotein antibody" [--query ...] \
 *     [--topK 30] [--searchLimit 100] [--out .tmp/growth-eval] [--refresh]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keDist = path.join(repoRoot, "packages", "knowledge-engine", "dist", "index.js");
const storeDist = path.join(repoRoot, "services", "api", "dist", "knowledge-engine", "store.js");
const chainDist = path.join(repoRoot, "services", "api", "dist", "knowledge-engine", "connectors", "source-chain.js");
const transportDist = path.join(repoRoot, "services", "api", "dist", "knowledge-engine", "connectors", "transport.js");
const limiterDist = path.join(repoRoot, "services", "api", "dist", "knowledge-engine", "connectors", "rate-limiter.js");
const typesDist = path.join(repoRoot, "services", "api", "dist", "knowledge-engine", "connectors", "types.js");
const embeddingDist = path.join(repoRoot, "services", "api", "dist", "knowledge-engine", "embedding.js");
for (const mod of [keDist, storeDist, chainDist, transportDist, limiterDist, typesDist, embeddingDist]) {
  if (!existsSync(mod)) {
    console.error(`[growth-eval] missing build output: ${mod} — run \`pnpm build\` first`);
    process.exit(1);
  }
}
const { rankCandidatePool, computeGrowthEvalMetrics } = await import(pathToFileURL(keDist).href);
const { KnowledgeEngineStore } = await import(pathToFileURL(storeDist).href);
const { buildSourceChain } = await import(pathToFileURL(chainDist).href);
const { HttpScholarlyTransport } = await import(pathToFileURL(transportDist).href);
const { createScholarlyRateLimiter } = await import(pathToFileURL(limiterDist).href);
const { paperDedupKey } = await import(pathToFileURL(typesDist).href);
const { EmbeddingClient } = await import(pathToFileURL(embeddingDist).href);

// --- args --------------------------------------------------------------------

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const dataDir = opt("dataDir");
const kb = opt("kb");
const cutoffRaw = opt("cutoff");
const queries = argv.map((a, i) => (a === "--query" ? argv[i + 1] : undefined)).filter(Boolean);
const topK = Number(opt("topK") ?? 30);
const searchLimit = Number(opt("searchLimit") ?? 100);
const outDir = path.resolve(opt("out") ?? path.join(repoRoot, ".tmp", "growth-eval"));
const refresh = argv.includes("--refresh");

if (!dataDir || !kb || !cutoffRaw || queries.length === 0) {
  console.error(
    "Usage: node scripts/ke-growth-eval.mjs --dataDir <dir> --kb <id> --cutoff <ISO> --query <q> [--query <q2>...] [--topK 30] [--searchLimit 100] [--out dir] [--refresh]",
  );
  process.exit(1);
}
const cutoff = new Date(cutoffRaw);
if (Number.isNaN(cutoff.getTime())) {
  console.error(`Invalid --cutoff: ${cutoffRaw}`);
  process.exit(1);
}

const embBaseUrl = process.env.SCIENCE_AGENT_KE_EMBEDDING_BASE_URL?.trim();
const embApiKey = process.env.SCIENCE_AGENT_KE_EMBEDDING_API_KEY?.trim();
const embModel = process.env.SCIENCE_AGENT_KE_EMBEDDING_MODEL?.trim();
if (!embBaseUrl || !embApiKey || !embModel) {
  console.error("[growth-eval] embedding env missing (SCIENCE_AGENT_KE_EMBEDDING_BASE_URL/API_KEY/MODEL)");
  process.exit(1);
}
const embedding = new EmbeddingClient({ baseUrl: embBaseUrl, apiKey: embApiKey, model: embModel });
const embed = async (text) => {
  try {
    const [vec] = await embedding.embed([text]);
    return vec && vec.length > 0 ? vec : null;
  } catch {
    return null;
  }
};

// --- cached search ---------------------------------------------------------------

function searchCachePath(query, limit) {
  const h = createHash("sha1").update(`${query}|${limit}`).digest("hex").slice(0, 12);
  return path.join(outDir, `search-${h}.json`);
}

async function searchCached(chain, query, limit) {
  const cache = searchCachePath(query, limit);
  if (!refresh && existsSync(cache)) {
    const refs = JSON.parse(readFileSync(cache, "utf-8"));
    console.log(`  [cache] "${query}" → ${refs.length} results`);
    return refs;
  }
  const refs = await chain.search(query, limit);
  writeFileSync(cache, JSON.stringify(refs, null, 2), "utf-8");
  console.log(`  [chain] "${query}" → ${refs.length} results`);
  return refs;
}

// --- main --------------------------------------------------------------------------

mkdirSync(outDir, { recursive: true });
const store = KnowledgeEngineStore.open(dataDir);
try {
  // 1. Snapshot the KB: dedupKey → admission era (delta vs pre-cutoff).
  // READY documents only — pending/error rows were never admitted, and a
  // post-cutoff failure must not become a false positive (DA filtered the
  // same way). Explicit high limit: the default 10k window ordered by
  // created_at would silently drop the NEWEST docs — exactly the delta.
  const docs = store.listDocuments(kb, { status: "ready", limit: 1_000_000 });
  if (docs.length === 0) {
    console.error(`[growth-eval] KB ${kb} has no ready documents under ${dataDir} — check --dataDir/--kb (an empty snapshot would report vacuous 0% metrics)`);
    process.exit(1);
  }
  const deltaKeys = new Set();
  const oldKeys = new Set();
  for (const d of docs) {
    if (!d.dedupKey) continue;
    if (new Date(d.createdAt) > cutoff) deltaKeys.add(d.dedupKey);
    else oldKeys.add(d.dedupKey);
  }
  console.log(`KB ${kb}: ${docs.length} docs — delta(>${cutoff.toISOString()})=${deltaKeys.size}, pre-cutoff=${oldKeys.size}`);

  const chain = buildSourceChain({ transport: new HttpScholarlyTransport(createScholarlyRateLimiter()) }, (msg) => console.warn(msg));
  const groups = [];
  const groupDetails = [];

  for (const q of queries) {
    const refs = await searchCached(chain, q, searchLimit);
    const seen = new Set();
    const candidates = [];
    let inLibrary = 0;
    let positivesInPool = 0;
    let negatives = 0;
    let titlelessExcluded = 0;
    for (const ref of refs) {
      // rankCandidatePool drops title-less refs (no embedding input) — a
      // title-less delta paper would count as positive here but never reach
      // the ranked pool, skewing recall. Exclude them up front.
      if (!ref.title) {
        titlelessExcluded++;
        continue;
      }
      const key = paperDedupKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      if (deltaKeys.has(key)) {
        candidates.push(ref);
        positivesInPool++;
      } else if (oldKeys.has(key)) {
        inLibrary++; // production dedups pre-ranking — excluded from the pool
      } else {
        candidates.push(ref);
        negatives++;
      }
    }

    const queryEmb = await embed(q);
    const ranked = await rankCandidatePool(candidates, queryEmb, embed, candidates.length);
    const items = ranked.map((r) => ({ key: paperDedupKey(r.ref), isPositive: deltaKeys.has(paperDedupKey(r.ref)) }));
    groups.push(items);
    groupDetails.push({
      query: q,
      results: refs.length,
      inLibraryExcluded: inLibrary,
      titlelessExcluded,
      positivesInPool,
      negatives,
      // Pool ≤ K saturates the metrics (everything is "in top-K") — flagged so
      // the reader knows the numbers carry no discrimination power here.
      saturated: candidates.length <= topK,
      topKPreview: ranked.slice(0, topK).map((r, i) => ({
        rank: i + 1,
        delta: deltaKeys.has(paperDedupKey(r.ref)),
        score: r.score === null ? null : Number(r.score.toFixed(4)),
        title: r.ref.title.slice(0, 90),
      })),
    });
    console.log(`  pool: ${candidates.length} (delta ${positivesInPool} / negative ${negatives}), in-library excluded ${inLibrary}`);
  }

  const metrics = computeGrowthEvalMetrics(groups, topK);
  const report = {
    kb,
    cutoff: cutoff.toISOString(),
    generatedAt: new Date().toISOString(),
    queries,
    topK,
    kbSnapshot: { documents: docs.length, delta: deltaKeys.size, preCutoff: oldKeys.size },
    metrics,
    perQuery: groupDetails,
    caveats: [
      "Negatives were never scored in production — negativeShareAtK is counterfactual context, not a quality verdict.",
      "Search reflects today's index; papers admitted long ago may be underrepresented in the pools.",
    ],
  };
  const outPath = path.join(outDir, `${kb}-${cutoff.toISOString().slice(0, 10)}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf-8");

  console.log("\n=== growth-eval summary ===");
  console.log(`KB:                 ${kb}`);
  console.log(`Cutoff:             ${cutoff.toISOString()}  (delta papers: ${deltaKeys.size})`);
  console.log(`Queries:            ${metrics.queries}`);
  console.log(`Gap detection@${topK}:   ${(metrics.gapDetectionRate * 100).toFixed(1)}%`);
  console.log(`Recall@${topK}:          ${(metrics.recallAtK * 100).toFixed(1)}%  (${metrics.positivesFound}/${metrics.positivesTotal})`);
  console.log(`Negative share@${topK}:  ${(metrics.negativeShareAtK * 100).toFixed(1)}%  (${metrics.negativesInTopK}/${metrics.topKTotal})`);
  console.log(`Report:             ${outPath}`);
} finally {
  store.close();
}
