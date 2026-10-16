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
 * Gap finder — deterministic extraction of research-idea candidates from the
 * entity graph, ported pure from the DeepAnalyze gap-finder. The LLM never
 * decides what the candidates ARE; it only evaluates and elaborates
 * candidates produced here.
 *
 * Three deterministic signals:
 *   1. Structural holes — entity pairs with ≥ MIN_COMMON shared neighbors
 *      but no direct edge (a relation the literature implies but no
 *      processed paper states).
 *   2. Open conflicts — contradicts/contrasts_with edges, strongest first.
 *   3. Transfer candidates — method M used by A, where B shares a context
 *      with A (≥ TRANSFER_MIN_COMMON shared neighbors) but has no edge to M.
 *
 * Scale guard: pair analysis runs over the top MAX_ANALYZED entities by
 * support count (deterministic truncation, reported in the result).
 */

const MIN_COMMON = 3;
const TRANSFER_MIN_COMMON = 2;
const MAX_ANALYZED = 500;
const TOP_N = 10;
const CONFLICT_TYPES = new Set(["contradicts", "contrasts_with"]);
const TRANSFER_EDGE_TYPES = new Set(["uses", "improves", "extends"]);

export interface GapEntity {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly supportCount: number;
  readonly communityId: number | null;
}

export interface GapEdge {
  readonly id: string;
  readonly srcId: string;
  readonly dstId: string;
  readonly type: string;
  readonly supportCount: number;
  readonly evidenceQuote: string | null;
}

export interface EntityRef {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly supportCount: number;
}

export interface HoleCandidate {
  readonly a: EntityRef;
  readonly b: EntityRef;
  readonly commonNeighbors: string[];
  readonly score: number;
  readonly aCommunityId: number | null;
  readonly bCommunityId: number | null;
  /** True when a and b belong to different cached communities — the most
   *  valuable kind of hole (the partition separated them despite ≥ MIN_COMMON
   *  shared neighbors). */
  readonly crossCommunity: boolean;
}

export interface ConflictCandidate {
  readonly a: EntityRef;
  readonly b: EntityRef;
  readonly edgeType: string;
  readonly supportCount: number;
  readonly sampleQuote: string;
}

export interface TransferCandidate {
  readonly method: EntityRef;
  readonly from: EntityRef;
  readonly to: EntityRef;
  readonly sharedNeighbors: string[];
  readonly score: number;
}

export interface GapAnalysis {
  readonly holes: HoleCandidate[];
  readonly conflicts: ConflictCandidate[];
  readonly transfers: TransferCandidate[];
  readonly stats: {
    readonly entities: number;
    readonly edges: number;
    readonly analyzed: number;
    readonly truncated: boolean;
  };
}

export interface FindGapsOptions {
  /** Per-signal result cap (default TOP_N=10, max 25). */
  readonly topN?: number;
  /** Restrict which signals to compute (default: all three). */
  readonly signals?: ReadonlyArray<"holes" | "conflicts" | "transfers">;
  /** Shared-neighbor threshold for the holes signal (default MIN_COMMON=3). */
  readonly minCommon?: number;
}

function toRef(entity: GapEntity): EntityRef {
  return { id: entity.id, name: entity.name, type: entity.type, supportCount: entity.supportCount };
}

/** Pure: all inputs are plain arrays. Deterministic ordering throughout. */
export function findGaps(
  allEntities: readonly GapEntity[],
  allEdges: readonly GapEdge[],
  opts: FindGapsOptions = {},
): GapAnalysis {
  const topN = Math.min(Math.max(1, opts.topN ?? TOP_N), 25);
  const minCommon = Math.max(1, opts.minCommon ?? MIN_COMMON);
  const wantHoles = !opts.signals || opts.signals.includes("holes");
  const wantConflicts = !opts.signals || opts.signals.includes("conflicts");
  const wantTransfers = !opts.signals || opts.signals.includes("transfers");

  // Deterministic scale guard: top-N by support, id tiebreak
  const entities = [...allEntities]
    .sort((a, b) => b.supportCount - a.supportCount || a.id.localeCompare(b.id))
    .slice(0, MAX_ANALYZED);
  const inScope = new Set(entities.map((entity) => entity.id));
  const byId = new Map(entities.map((entity) => [entity.id, entity]));

  // Adjacency over in-scope entities
  const adjacency = new Map<string, Set<string>>();
  const edgeBetween = new Map<string, GapEdge[]>();
  const pairKey = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);
  for (const edge of allEdges) {
    if (!inScope.has(edge.srcId) || !inScope.has(edge.dstId)) continue;
    if (!adjacency.has(edge.srcId)) adjacency.set(edge.srcId, new Set());
    if (!adjacency.has(edge.dstId)) adjacency.set(edge.dstId, new Set());
    adjacency.get(edge.srcId)!.add(edge.dstId);
    adjacency.get(edge.dstId)!.add(edge.srcId);
    const key = pairKey(edge.srcId, edge.dstId);
    if (!edgeBetween.has(key)) edgeBetween.set(key, []);
    edgeBetween.get(key)!.push(edge);
  }

  // --- Signal 2: open conflicts (cheap, edge-driven)
  const conflicts: ConflictCandidate[] = !wantConflicts
    ? []
    : allEdges
        .filter((edge) => CONFLICT_TYPES.has(edge.type) && byId.has(edge.srcId) && byId.has(edge.dstId))
        .sort((a, b) => b.supportCount - a.supportCount || a.id.localeCompare(b.id))
        .slice(0, topN)
        .map((edge) => ({
          a: toRef(byId.get(edge.srcId)!),
          b: toRef(byId.get(edge.dstId)!),
          edgeType: edge.type,
          supportCount: edge.supportCount,
          sampleQuote: (edge.evidenceQuote ?? "").slice(0, 300),
        }));

  // --- Pair analysis: shared-neighbor counts for unconnected pairs
  const holes: HoleCandidate[] = [];
  const transferPairs: Array<{ a: GapEntity; b: GapEntity; common: string[] }> = [];

  if (wantHoles || wantTransfers) {
    const ids = entities.map((entity) => entity.id);
    for (let i = 0; i < ids.length; i += 1) {
      const neighborsA = adjacency.get(ids[i]!);
      if (!neighborsA || neighborsA.size < TRANSFER_MIN_COMMON) continue;
      for (let j = i + 1; j < ids.length; j += 1) {
        if (edgeBetween.has(pairKey(ids[i]!, ids[j]!))) continue; // already connected
        const neighborsB = adjacency.get(ids[j]!);
        if (!neighborsB || neighborsB.size < TRANSFER_MIN_COMMON) continue;
        const common: string[] = [];
        for (const neighbor of neighborsA) {
          if (neighborsB.has(neighbor)) common.push(neighbor);
        }
        if (wantHoles && common.length >= minCommon) {
          const entityA = byId.get(ids[i]!)!;
          const entityB = byId.get(ids[j]!)!;
          holes.push({
            a: toRef(entityA),
            b: toRef(entityB),
            commonNeighbors: common
              .map((id) => byId.get(id)!)
              .sort((x, y) => y.supportCount - x.supportCount || x.id.localeCompare(y.id))
              .map((entity) => entity.name),
            score: common.length,
            aCommunityId: entityA.communityId ?? null,
            bCommunityId: entityB.communityId ?? null,
            crossCommunity:
              entityA.communityId != null &&
              entityB.communityId != null &&
              entityA.communityId !== entityB.communityId,
          });
        }
        if (wantTransfers && common.length >= TRANSFER_MIN_COMMON) {
          transferPairs.push({ a: byId.get(ids[i]!)!, b: byId.get(ids[j]!)!, common });
        }
      }
    }
  }
  holes.sort((x, y) => y.score - x.score || x.a.id.localeCompare(y.a.id));

  // --- Signal 3: transfer candidates (method of A → context-sharing B)
  // Pre-index transfer-type edges by source once — the pair loop can reach
  // O(V²/2) iterations and must not scan allEdges per pair.
  const transferEdgesBySrc = new Map<string, GapEdge[]>();
  for (const edge of allEdges) {
    if (!inScope.has(edge.srcId) || !TRANSFER_EDGE_TYPES.has(edge.type)) continue;
    if (!transferEdgesBySrc.has(edge.srcId)) transferEdgesBySrc.set(edge.srcId, []);
    transferEdgesBySrc.get(edge.srcId)!.push(edge);
  }

  const transfers: TransferCandidate[] = [];
  const seenTransfer = new Set<string>();
  for (const { a, b, common } of transferPairs) {
    // Both directions: A's methods → B and B's methods → A
    for (const [src, dst] of [
      [a, b],
      [b, a],
    ] as const) {
      for (const edge of transferEdgesBySrc.get(src.id) ?? []) {
        const method = byId.get(edge.dstId);
        if (!method) continue;
        // Any known relation between dst and method counts as "already
        // connected" (even a contradicts edge means the pair is studied).
        if (edgeBetween.has(pairKey(dst.id, method.id))) continue;
        const key = `${method.id}|${dst.id}`;
        if (seenTransfer.has(key)) continue;
        seenTransfer.add(key);
        transfers.push({
          method: toRef(method),
          from: toRef(src),
          to: toRef(dst),
          sharedNeighbors: common.map((id) => byId.get(id)!.name),
          score: common.length,
        });
      }
    }
  }
  transfers.sort(
    (x, y) => y.score - x.score || y.method.supportCount - x.method.supportCount || x.method.id.localeCompare(y.method.id),
  );

  return {
    holes: holes.slice(0, topN),
    conflicts,
    transfers: transfers.slice(0, topN),
    stats: {
      entities: allEntities.length,
      edges: allEdges.length,
      analyzed: entities.length,
      truncated: allEntities.length > MAX_ANALYZED,
    },
  };
}
