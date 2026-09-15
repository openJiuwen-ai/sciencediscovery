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
 * Batch entity resolution job (offline track), ported from the DeepAnalyze
 * scholarly/resolution-runner. The online resolver prevents NEW splits at
 * write time; this job heals the splits already in the graph:
 *
 *   1. embedding backfill (an outage just skips the embedding channel this
 *      round; persisted rows make resume incremental)
 *   2. entity-type blocking (DEG-RAG: type blocking was the best strategy)
 *   3. dual-channel recall per block: trgm name similarity ∪ embedding
 *      cosine (LHCb recipe); pairwise in memory for blocks ≤ MAX_PAIRWISE_BLOCK,
 *      per-entity ANN recall beyond that
 *   4. connected components over pairs ≥ embedLow; oversized components
 *      trimmed weakest-edge-first
 *   5. one LLM CLUSTER judge call per component (LLM-CER); judged pairs are
 *      cached in ke_entity_merges (incl. rejections) → kill/resume never
 *      re-judges
 *   6. physical merge per equivalence class via store.mergeEntities
 *      (audited, rollback-able); per-cluster failure isolation
 *   7. iterate while the round merge rate ≥ CONVERGE_MERGE_RATE
 *
 * Mode gate (same switch as online): off → no-op; shadow → full pipeline but
 * only 'shadow:batch-llm' preview audit rows, never merges; on → merges
 * execute.
 */

import {
  buildClusterJudgePrompt,
  buildComponents,
  chooseCanonical,
  cosineSimilarity,
  embeddingFromBlob,
  embeddingToBlob,
  everyPairCached,
  pairKey,
  parseClusterJudgeResponse,
  trimOversized,
  trigrams,
  ANN_RECALL_K,
  CONVERGE_MERGE_RATE,
  DEFAULT_RESOLVER_THRESHOLDS,
  MAX_PAIRWISE_BLOCK,
  TRGM_BLOCKING_MIN,
  type CandidatePair,
  type EntityResolutionMode,
} from "@sciencediscovery/knowledge-engine";
import type { ModelEndpoint } from "@sciencediscovery/model";

import type { EmbeddingClient } from "./embedding.js";
import { callPipelineLlm, type PipelineInvoke } from "./llm.js";
import { resolveEntityResolutionMode } from "./resolution.js";
import type { KeEntityRow, KeJobRow, KnowledgeEngineStore } from "./store.js";

export const KE_ENTITY_RESOLUTION_JOB = "ke_entity_resolution";

const RESOLUTION_SYSTEM_PROMPT =
  "你是实体消解裁决器。只输出用户要求的 JSON，不要输出解释、前言或后记。";

export interface ResolutionRunDeps {
  readonly store: KnowledgeEngineStore;
  /** Pipeline model endpoint for the cluster judge. */
  readonly resolveEndpoint?: () => ModelEndpoint | undefined;
  /** Test seam: replace the model transport. */
  readonly llmInvoke?: PipelineInvoke;
  readonly embedding?: EmbeddingClient;
  /** Test seam: override the mode switch (default: env → settings → off). */
  readonly mode?: () => EntityResolutionMode;
  readonly onWarn?: (message: string, detail?: unknown) => void;
}

/** Enqueue a batch resolution job for a KB (dedup on active jobs). */
export function enqueueEntityResolution(
  store: KnowledgeEngineStore,
  kbId: string,
): { jobId: string; enqueued: boolean } {
  const { job, enqueued } = store.enqueueJob({
    type: KE_ENTITY_RESOLUTION_JOB,
    payload: { kbId },
    dedupKey: `resolve|${kbId}`,
    maxAttempts: 2,
  });
  return { jobId: job.id, enqueued };
}

/** Trigram Jaccard over precomputed shingle sets (pg_trgm semantics). */
function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const gram of smaller) {
    if (larger.has(gram)) shared++;
  }
  return shared / (a.size + b.size - shared);
}

export async function runEntityResolution(
  deps: ResolutionRunDeps,
  job: KeJobRow,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const { store } = deps;
  const kbId = String(job.payload["kbId"] ?? "");
  const mode = (deps.mode ?? (() => resolveEntityResolutionMode(store)))();
  if (mode === "off") {
    return {
      kbId,
      skipped: "entity resolution mode off (env SCIENCE_AGENT_KE_ENTITY_RESOLUTION or ke_settings entity_resolution_mode)",
    };
  }
  const endpoint = deps.resolveEndpoint?.();
  if (!endpoint) {
    // The cluster judge is the decision-maker; recall alone must never merge.
    throw new Error("no pipeline model configured (entity resolution requires the cluster judge)");
  }
  const thresholds = DEFAULT_RESOLVER_THRESHOLDS;
  const warn = (message: string, detail?: unknown) => deps.onWarn?.(message, detail);

  const judge = async (members: KeEntityRow[]) => {
    const text = await callPipelineLlm(
      { endpoint, ...(deps.llmInvoke ? { invoke: deps.llmInvoke } : {}) },
      RESOLUTION_SYSTEM_PROMPT,
      buildClusterJudgePrompt(
        members.map((m) => ({ name: m.name, type: m.type, definition: m.description })),
      ),
      signal ?? new AbortController().signal,
    );
    return parseClusterJudgeResponse(text, members.length);
  };

  // 1. Embedding backfill (strict — a provider outage skips the embedding
  //    channel this round; persisted rows make resume incremental).
  let embedded = 0;
  if (deps.embedding) {
    try {
      const pending = store.listEntities(kbId).filter((entity) => entity.embedding === null);
      if (pending.length > 0) {
        const vectors = await deps.embedding.embed(pending.map((entity) => entity.name));
        pending.forEach((entity, index) => {
          const vector = vectors[index];
          if (vector && vector.length > 0) {
            store.updateEntityEmbedding(entity.id, embeddingToBlob(vector));
            embedded++;
          }
        });
      }
    } catch (error) {
      warn("ke_resolution_embedding_backfill_failed", { kbId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // Judged-pair cache: every pair ever decided (merge rows + reject rows) is
  // never re-judged — this is the resume mechanism.
  const judgedPairs = new Set(store.judgedPairKeys(kbId));

  let totalMerged = 0;
  let rounds = 0;

  // 7. Iterate until the merge rate falls below the convergence floor or a
  //    round makes no progress (elastic — progress extends, stall stops).
  for (;;) {
    rounds++;
    if (signal?.aborted) break;
    const entities = store.listEntities(kbId);
    if (entities.length < 2) break;

    // 2. entity-type blocking
    const byType = new Map<string, KeEntityRow[]>();
    for (const entity of entities) {
      if (!byType.has(entity.type)) byType.set(entity.type, []);
      byType.get(entity.type)!.push(entity);
    }

    // 3. dual-channel recall → candidate pairs
    // String channel: trigram shingle sets precomputed ONCE per round, then
    // pairwise Jaccard inside each block (per-entity store scans would be
    // O(n²) trigram constructions — DA had the pg_trgm index instead).
    // Divergence note: DA capped the string channel at 20 hits per entity;
    // this port's in-block pairwise is uncapped, a strict recall superset.
    const gramSets = new Map<string, Set<string>>();
    for (const entity of entities) {
      gramSets.set(entity.id, trigrams(entity.normalizedName));
    }
    const pairScores = new Map<string, CandidatePair>();
    const addPair = (aId: string, bId: string, score: number) => {
      if (aId === bId) return;
      const key = pairKey(aId, bId);
      const existing = pairScores.get(key);
      if (!existing || score > existing.score) pairScores.set(key, { aId, bId, score });
    };

    for (const block of byType.values()) {
      if (block.length < 2) continue;
      for (let i = 0; i < block.length; i++) {
        for (let j = i + 1; j < block.length; j++) {
          const sim = jaccard(gramSets.get(block[i]!.id)!, gramSets.get(block[j]!.id)!);
          if (sim >= TRGM_BLOCKING_MIN) {
            addPair(block[i]!.id, block[j]!.id, sim);
          }
        }
      }
      // Embedding channel
      try {
        const embeddedBlock = block.filter((entity) => entity.embedding !== null);
        if (embeddedBlock.length <= MAX_PAIRWISE_BLOCK) {
          const vecs = new Map(embeddedBlock.map((entity) => [entity.id, embeddingFromBlob(entity.embedding!)]));
          for (let i = 0; i < embeddedBlock.length; i++) {
            for (let j = i + 1; j < embeddedBlock.length; j++) {
              addPair(
                embeddedBlock[i]!.id,
                embeddedBlock[j]!.id,
                cosineSimilarity(vecs.get(embeddedBlock[i]!.id)!, vecs.get(embeddedBlock[j]!.id)!),
              );
            }
          }
        } else {
          // Large block: ANN-style recall per entity instead of O(n²)
          for (const entity of embeddedBlock) {
            const near = store.nearestEntitiesByEmbedding(kbId, embeddingFromBlob(entity.embedding!), ANN_RECALL_K);
            for (const n of near) {
              if (n.type !== entity.type) continue;
              addPair(entity.id, n.id, n.cosine);
            }
          }
        }
      } catch (error) {
        warn("ke_resolution_embedding_channel_failed", { kbId, error: error instanceof Error ? error.message : String(error) });
      }
    }

    // 4. components over the gray-zone-or-above pairs, trimmed
    const candidatePairs = [...pairScores.values()].filter((p) => p.score >= thresholds.embedLow);
    const components = buildComponents(trimOversized(candidatePairs));

    // 5–6. cluster judge + merges (cached pairs skipped → resume-safe).
    // Clusters touch disjoint entity sets by construction; SQLite is
    // single-writer sync so clusters process sequentially.
    let mergedThisRound = 0;
    for (const component of components) {
      if (signal?.aborted) break;
      try {
        const members = store.listEntitiesByIds(kbId, component);
        if (members.length < 2) continue;
        let groups: Awaited<ReturnType<typeof judge>> = [];
        if (!everyPairCached(component, judgedPairs)) {
          groups = await judge(members);
          // Cache rejections: pairs the judge did NOT group together.
          const grouped = new Set<string>();
          for (const g of groups) {
            for (let i = 0; i < g.members.length; i++) {
              for (let j = i + 1; j < g.members.length; j++) {
                grouped.add(pairKey(members[g.members[i]! - 1]!.id, members[g.members[j]! - 1]!.id));
              }
            }
          }
          for (let i = 0; i < members.length; i++) {
            for (let j = i + 1; j < members.length; j++) {
              const key = pairKey(members[i]!.id, members[j]!.id);
              if (grouped.has(key) || judgedPairs.has(key)) continue;
              judgedPairs.add(key);
              store.recordEntityMerge({
                kbId,
                canonicalId: members[i]!.id,
                absorbedId: members[j]!.id,
                snapshot: { pairCheck: true, clusterSize: members.length },
                decidedBy: "llm-reject",
              });
            }
          }
        }

        if (mode === "shadow") {
          // Preview rows only — never merge in shadow mode.
          for (const g of groups) {
            const chosen = members[g.members[0]! - 1]!;
            for (const idx of g.members.slice(1)) {
              const other = members[idx - 1]!;
              store.recordEntityMerge({
                kbId,
                canonicalId: chosen.id,
                absorbedId: other.id,
                snapshot: { batchPreview: true, absorbedName: other.name, canonicalSuggestion: g.canonical },
                decidedBy: "shadow:batch-llm",
                ...(g.reason !== undefined ? { rationale: g.reason } : {}),
              });
            }
          }
          continue;
        }

        // on: execute merges per equivalence class
        for (const g of groups) {
          const groupEntities = g.members.map((idx) => members[idx - 1]!);
          let survivor = groupEntities[0]!;
          for (const other of groupEntities.slice(1)) {
            const chosen = chooseCanonical(
              {
                id: survivor.id,
                canonicalName: survivor.normalizedName,
                supportCount: survivor.supportCount,
                trustLevel: survivor.trustLevel,
                createdAt: survivor.createdAt,
              },
              {
                id: other.id,
                canonicalName: other.normalizedName,
                supportCount: other.supportCount,
                trustLevel: other.trustLevel,
                createdAt: other.createdAt,
              },
              g.canonical,
            );
            const absorbed = chosen.id === survivor.id ? other : survivor;
            const canonEntity = chosen.id === survivor.id ? survivor : other;
            store.mergeEntities(kbId, canonEntity.id, absorbed.id, {
              decidedBy: "batch-llm",
              ...(g.reason !== undefined ? { rationale: g.reason } : {}),
              jobId: job.id,
            });
            judgedPairs.add(pairKey(canonEntity.id, absorbed.id));
            survivor = { ...canonEntity, supportCount: canonEntity.supportCount + absorbed.supportCount };
            mergedThisRound++;
          }
        }
      } catch (error) {
        // Per-cluster failure isolation: one bad cluster must not sink the round.
        warn("ke_resolution_cluster_failed", { kbId, error: error instanceof Error ? error.message : String(error) });
      }
    }

    totalMerged += mergedThisRound;
    const mergeRate = entities.length > 0 ? mergedThisRound / entities.length : 0;
    warn("ke_resolution_round", { kbId, round: rounds, merged: mergedThisRound, clusters: components.length });
    if (mergedThisRound === 0 || mergeRate < CONVERGE_MERGE_RATE) break;
  }

  return {
    kbId,
    mode,
    rounds,
    embedded,
    merged: totalMerged,
    entitiesAfter: store.entitySupportStats(kbId).count,
  };
}
