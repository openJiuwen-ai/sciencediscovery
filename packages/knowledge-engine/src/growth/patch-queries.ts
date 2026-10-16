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
 * Entity-driven patch queries — coverage-gap-driven discovery, ported from
 * the DeepAnalyze entity-queries module. Citation snowballing only walks
 * citation edges; the graph itself tells us what the corpus is missing:
 *   - anchors: highest-support entities — periodic re-search catches their
 *     newest literature;
 *   - sparse-but-important: cited by ≥2 documents yet relation-poor —
 *     under-covered corners of the graph.
 * Query text = entity name + strongest co-occurring neighbors.
 */

export const ANCHOR_QUERY_COUNT = 3;
export const SPARSE_QUERY_COUNT = 3;
const MIN_IMPORTANT_SUPPORT = 2;
const NEIGHBORS_PER_QUERY = 2;
const MAX_QUERY_CHARS = 200;

export interface PatchQuery {
  entityId: string;
  kind: "anchor" | "sparse";
  query: string;
}

export interface EntityWithDegree {
  id: string;
  name: string;
  supportCount: number;
  degree: number;
}

export interface PatchQueryDataAccess {
  listEntitiesWithDegree(kbId: string): Promise<EntityWithDegree[]>;
  topNeighborNames(kbId: string, entityIds: readonly string[], perEntity: number): Promise<Map<string, string[]>>;
}

/** Build this cycle's patch queries. Deterministic: same graph → same
 *  queries (ordering keys include entity ids as tiebreakers). */
export async function buildPatchQueries(kbId: string, data: PatchQueryDataAccess): Promise<PatchQuery[]> {
  const withDegree = await data.listEntitiesWithDegree(kbId);
  if (withDegree.length === 0) return [];

  const bySupport = [...withDegree].sort((a, b) => b.supportCount - a.supportCount || a.id.localeCompare(b.id));
  const anchors = bySupport.slice(0, ANCHOR_QUERY_COUNT);
  const anchorIds = new Set(anchors.map((entity) => entity.id));

  const sparse = [...withDegree]
    .filter((entity) => entity.supportCount >= MIN_IMPORTANT_SUPPORT && !anchorIds.has(entity.id))
    .sort(
      (a, b) =>
        b.supportCount / (1 + b.degree) - a.supportCount / (1 + a.degree) || a.id.localeCompare(b.id),
    )
    .slice(0, SPARSE_QUERY_COUNT);

  const picked = [
    ...anchors.map((entity) => ({ entity, kind: "anchor" as const })),
    ...sparse.map((entity) => ({ entity, kind: "sparse" as const })),
  ];
  if (picked.length === 0) return [];

  const neighborNames = await data.topNeighborNames(
    kbId,
    picked.map((pick) => pick.entity.id),
    NEIGHBORS_PER_QUERY,
  );

  const queries: PatchQuery[] = [];
  for (const { entity, kind } of picked) {
    const parts = [entity.name, ...(neighborNames.get(entity.id) ?? [])];
    const query = parts.join(" ").slice(0, MAX_QUERY_CHARS).trim();
    if (query) queries.push({ entityId: entity.id, kind, query });
  }
  return queries;
}

/** Drop low-quality seed docs before they wastefully resolve citations.
 *
 *  Signal 1 — status !== 'ready': extraction failed/not run; the doc is a
 *  weak seed source.
 *  Signal 2 — historical admissionRate === 0 with a meaningful sample
 *  (≥ minTotal candidates tried, none admitted): proven zero-yield. Seeds
 *  with no recorded history are kept. */
export function pruneSeeds<T extends { id: string; status?: string; seedQuality?: { admissionRate?: number; total?: number } | null }>(
  docs: readonly T[],
  minTotal = 5,
): { kept: T[]; prunedNotReady: number; prunedStale: number } {
  let prunedNotReady = 0;
  let prunedStale = 0;
  const kept = docs.filter((doc) => {
    if (doc.status && doc.status !== "ready") {
      prunedNotReady += 1;
      return false;
    }
    const quality = doc.seedQuality;
    if (
      quality &&
      typeof quality.admissionRate === "number" &&
      quality.admissionRate === 0 &&
      typeof quality.total === "number" &&
      quality.total >= minTotal
    ) {
      prunedStale += 1;
      return false;
    }
    return true;
  });
  return { kept, prunedNotReady, prunedStale };
}
