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
 * Graph roots — top-level communities for progressive graph exploration,
 * ported from the DeepAnalyze scholarly/graph-roots module. This is the
 * pure compute core; the caching layer (fingerprint + stale-while-revalidate
 * + persistence) lives in services/api where the store is.
 *
 * Above LOUVAIN_MAX_EDGES edges the partition falls back to grouping by
 * entity type — cheap and deterministic. Community names come from ONE
 * batched namer call per compute (the services layer wires the LLM);
 * failure/absence falls back to the representative entity's name.
 */

import { detectCommunities, LOUVAIN_MAX_EDGES } from "./louvain.js";

export interface RootsEntity {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly supportCount: number;
}

export interface RootsEdge {
  readonly srcId: string;
  readonly dstId: string;
  readonly supportCount: number;
}

export interface CommunityEntity {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly supportCount: number;
}

export interface Community {
  readonly id: number;
  /** Display name (namer-provided once, or representative entity fallback). */
  name: string;
  readonly size: number;
  /** Representative (highest-support) member — the drill-down entry node. */
  readonly repEntity: CommunityEntity;
  readonly topEntities: readonly CommunityEntity[];
}

export interface CommunityEdge {
  readonly source: number;
  readonly target: number;
  readonly weight: number;
  readonly count: number;
}

export interface GraphRoots {
  readonly communities: Community[];
  /** Aggregated inter-community edges (weight = summed support, count = edge rows). */
  readonly communityEdges: CommunityEdge[];
  readonly method: "louvain" | "entity-type";
  readonly fingerprint: string;
  readonly entityCount: number;
  readonly edgeCount: number;
}

/** Batched community namer (LLM in production, absent/mocked in tests). */
export type CommunityNamer = (communities: readonly Community[]) => Promise<Map<number, string>>;

export interface BuiltGraphRoots {
  readonly roots: GraphRoots;
  /** nodeId → communityId — the services layer persists this onto rows. */
  readonly assignments: Map<string, number>;
}

const TOP_ENTITIES_PER_COMMUNITY = 5;

/**
 * Partition the graph and build community descriptors. Dangling edges whose
 * endpoints are not in `entities` are dropped defensively — detectCommunities
 * assumes every endpoint is a known node.
 */
export async function buildGraphRoots(
  entities: readonly RootsEntity[],
  allEdges: readonly RootsEdge[],
  fingerprint: string,
  namer?: CommunityNamer,
): Promise<BuiltGraphRoots> {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const edges = allEdges.filter((e) => byId.has(e.srcId) && byId.has(e.dstId));

  // Partition: Louvain, or entity-type grouping beyond the edge budget
  let method: GraphRoots["method"] = "louvain";
  const assignments = new Map<string, number>();
  if (edges.length > LOUVAIN_MAX_EDGES) {
    method = "entity-type";
    const typeToComm = new Map<string, number>();
    for (const e of entities) {
      if (!typeToComm.has(e.type)) typeToComm.set(e.type, typeToComm.size);
      assignments.set(e.id, typeToComm.get(e.type)!);
    }
  } else {
    const partition = detectCommunities({
      nodeIds: entities.map((e) => e.id),
      edges: edges.map((e) => ({ source: e.srcId, target: e.dstId, weight: e.supportCount })),
    });
    for (const [id, c] of partition) assignments.set(id, c);
  }

  // Build community descriptors
  const groups = new Map<number, RootsEntity[]>();
  for (const e of entities) {
    const c = assignments.get(e.id) ?? 0;
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c)!.push(e);
  }
  const communities: Community[] = [...groups.entries()]
    .map(([id, members]) => {
      const sorted = [...members].sort(
        (a, b) => b.supportCount - a.supportCount || a.id.localeCompare(b.id),
      );
      const toCE = (e: RootsEntity): CommunityEntity => ({
        id: e.id,
        name: e.name,
        type: e.type,
        supportCount: e.supportCount,
      });
      return {
        id,
        name: sorted[0]!.name, // fallback; the namer may overwrite
        size: members.length,
        repEntity: toCE(sorted[0]!),
        topEntities: sorted.slice(0, TOP_ENTITIES_PER_COMMUNITY).map(toCE),
      };
    })
    .sort((a, b) => b.size - a.size || a.id - b.id);

  // Community naming (one batched call), fallback keeps representative names
  if (namer) {
    try {
      const names = await namer(communities);
      for (const c of communities) {
        const n = names.get(c.id);
        if (n) c.name = n;
      }
    } catch {
      // Namer failure must never sink the roots view — representative names stand.
    }
  }

  // Aggregate inter-community edges (deterministic ordering) so the roots
  // view can show how communities relate, not just isolated bubbles.
  interface MutableCommunityEdge {
    source: number;
    target: number;
    weight: number;
    count: number;
  }
  const ceMap = new Map<string, MutableCommunityEdge>();
  for (const e of edges) {
    const a = assignments.get(e.srcId);
    const b = assignments.get(e.dstId);
    if (a === undefined || b === undefined || a === b) continue;
    const [s, t] = a < b ? [a, b] : [b, a];
    const key = `${s}|${t}`;
    const prev = ceMap.get(key);
    if (prev) {
      prev.weight += e.supportCount;
      prev.count += 1;
    } else {
      ceMap.set(key, { source: s, target: t, weight: e.supportCount, count: 1 });
    }
  }
  const communityEdges = [...ceMap.values()].sort(
    (x, y) => y.weight - x.weight || x.source - y.source || x.target - y.target,
  );

  return {
    roots: {
      communities,
      communityEdges,
      method,
      fingerprint,
      entityCount: entities.length,
      edgeCount: edges.length,
    },
    assignments,
  };
}
