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
 * Community detection — deterministic multilevel Louvain, ported verbatim
 * from the DeepAnalyze scholarly/community module.
 *
 * Determinism: nodes processed in id order, neighbors in id order, ties
 * broken by community id. No randomness — same input graph always yields
 * the same partition (cache-friendly, test-friendly).
 *
 * Multilevel: single-level local moving gets stuck in local optima (a ring
 * of pairs is stable), so each partition is aggregated into a super-node
 * graph and the process recurses until no level improves the partition.
 * Self-loops (intra-community weight in aggregated graphs) are tracked
 * separately and count double in node degree, per the standard formulation.
 */

export interface CommunityGraph {
  nodeIds: string[];
  /** Undirected weighted edges. Self-loops are allowed (they carry
   *  intra-community weight in aggregated graphs). */
  edges: Array<{ source: string; target: string; weight: number }>;
}

export const LOUVAIN_MAX_EDGES = 20_000;
const MAX_ITERATIONS = 20;
const MAX_LEVELS = 10;
const MIN_GAIN = 1e-7;

interface WeightedGraph {
  nodeIds: string[];
  /** degree(i) = incident edge weight + 2× self-loop weight */
  degree: Map<string, number>;
  /** neighbor weights excluding self-loops, id-sorted */
  neighbors: Map<string, Array<{ id: string; weight: number }>>;
  /** 2m = sum of all degrees */
  m2: number;
}

function buildWeighted(
  nodeIds: string[],
  edges: CommunityGraph["edges"],
  selfLoops: Map<string, number>,
): WeightedGraph {
  const degree = new Map<string, number>();
  const neighbors = new Map<string, Array<{ id: string; weight: number }>>();
  for (const id of nodeIds) degree.set(id, 2 * (selfLoops.get(id) ?? 0));
  for (const e of edges) {
    if (e.source === e.target) continue; // self-loops arrive via the map
    degree.set(e.source, (degree.get(e.source) ?? 0) + e.weight);
    degree.set(e.target, (degree.get(e.target) ?? 0) + e.weight);
    if (!neighbors.has(e.source)) neighbors.set(e.source, []);
    neighbors.get(e.source)!.push({ id: e.target, weight: e.weight });
    if (!neighbors.has(e.target)) neighbors.set(e.target, []);
    neighbors.get(e.target)!.push({ id: e.source, weight: e.weight });
  }
  for (const list of neighbors.values()) list.sort((a, b) => a.id.localeCompare(b.id));
  let m2 = 0;
  for (const d of degree.values()) m2 += d;
  return { nodeIds, degree, neighbors, m2 };
}

/** One local-moving phase. Community ids are node ids (initially singletons). */
function localMoving(g: WeightedGraph): { partition: Map<string, string>; moved: boolean } {
  const community = new Map<string, string>();
  for (const id of g.nodeIds) community.set(id, id);
  const commWeight = new Map<string, number>();
  for (const id of g.nodeIds) commWeight.set(id, g.degree.get(id) ?? 0);

  let movedAny = false;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let moved = 0;
    for (const node of g.nodeIds) {
      const nodeComm = community.get(node)!;
      const nodeDegree = g.degree.get(node) ?? 0;

      const toward = new Map<string, number>();
      for (const n of g.neighbors.get(node) ?? []) {
        const c = community.get(n.id)!;
        toward.set(c, (toward.get(c) ?? 0) + n.weight);
      }

      commWeight.set(nodeComm, (commWeight.get(nodeComm) ?? 0) - nodeDegree);

      // ΔQ relative to staying (re-joining the now node-less community):
      // without this baseline, nodes oscillate between equal communities
      // and clusters never merge.
      let bestComm = nodeComm;
      let bestGain = (toward.get(nodeComm) ?? 0) - ((commWeight.get(nodeComm) ?? 0) * nodeDegree) / g.m2;
      const candidates = [...toward.keys()].sort();
      for (const c of candidates) {
        if (c === nodeComm) continue;
        const gain = (toward.get(c) ?? 0) - ((commWeight.get(c) ?? 0) * nodeDegree) / g.m2;
        if (gain > bestGain + MIN_GAIN) {
          bestGain = gain;
          bestComm = c;
        }
      }

      community.set(node, bestComm);
      commWeight.set(bestComm, (commWeight.get(bestComm) ?? 0) + nodeDegree);
      if (bestComm !== nodeComm) moved++;
    }
    if (moved > 0) movedAny = true;
    if (moved === 0) break;
  }
  return { partition: community, moved: movedAny };
}

/** Collapse a partition into a super-node graph. */
function aggregate(
  nodeIds: string[],
  edges: CommunityGraph["edges"],
  selfLoops: Map<string, number>,
  partition: Map<string, string>,
): { nodeIds: string[]; edges: CommunityGraph["edges"]; selfLoops: Map<string, number> } {
  const superIds = [...new Set(partition.values())].sort();
  // Nested maps instead of string keys — node ids may contain any character.
  const inter = new Map<string, Map<string, number>>();
  const loops = new Map<string, number>();

  for (const e of edges) {
    if (e.source === e.target) continue;
    const ca = partition.get(e.source)!;
    const cb = partition.get(e.target)!;
    if (ca === cb) {
      loops.set(ca, (loops.get(ca) ?? 0) + e.weight);
    } else {
      const [lo, hi] = ca < cb ? [ca, cb] : [cb, ca];
      if (!inter.has(lo!)) inter.set(lo!, new Map());
      const row = inter.get(lo!)!;
      row.set(hi!, (row.get(hi!) ?? 0) + e.weight);
    }
  }
  // Self-loops carry onto the super-node of their community
  for (const [id, w] of selfLoops) {
    const c = partition.get(id)!;
    loops.set(c, (loops.get(c) ?? 0) + w);
  }

  const outEdges: CommunityGraph["edges"] = [];
  for (const [lo, row] of inter) {
    for (const [hi, w] of row) {
      outEdges.push({ source: lo, target: hi, weight: w });
    }
  }
  return { nodeIds: superIds, edges: outEdges, selfLoops: loops };
}

/**
 * Deterministic multilevel Louvain.
 * Returns Map nodeId → communityId (sequential integers in first-seen order).
 */
export function detectCommunities(graph: CommunityGraph): Map<string, number> {
  let nodeIds = graph.nodeIds;
  let edges: CommunityGraph["edges"] = [];
  let selfLoops = new Map<string, number>();
  for (const e of graph.edges) {
    if (e.source === e.target) {
      selfLoops.set(e.source, (selfLoops.get(e.source) ?? 0) + e.weight);
    } else {
      edges.push(e);
    }
  }

  const chain: Map<string, string>[] = [];
  let finalPartition: Map<string, string> | null = null;

  for (let level = 0; level < MAX_LEVELS; level++) {
    const weighted = buildWeighted(nodeIds, edges, selfLoops);
    if (weighted.m2 === 0) {
      finalPartition = new Map(nodeIds.map((id) => [id, id]));
      break;
    }
    const { partition, moved } = localMoving(weighted);
    const numComms = new Set(partition.values()).size;
    if (!moved || numComms === nodeIds.length || numComms === 1) {
      finalPartition = partition;
      break;
    }
    chain.push(partition);
    const next = aggregate(nodeIds, edges, selfLoops, partition);
    nodeIds = next.nodeIds;
    edges = next.edges;
    selfLoops = next.selfLoops;
  }
  if (!finalPartition) {
    finalPartition = localMoving(buildWeighted(nodeIds, edges, selfLoops)).partition;
  }

  // Compose levels back to original node ids
  const levels = [...chain, finalPartition];
  const remap = new Map<string, number>();
  const result = new Map<string, number>();
  for (const id of graph.nodeIds) {
    let c = id;
    for (const level of levels) {
      const next = level.get(c);
      if (next === undefined) {
        // Should be unreachable (each level's value domain is the next
        // level's key domain) — fail loudly rather than silently singleton.
        console.warn(`[Louvain] compose miss for ${id} at community ${c}`);
        break;
      }
      c = next;
    }
    if (!remap.has(c)) remap.set(c, remap.size);
    result.set(id, remap.get(c)!);
  }
  return result;
}
