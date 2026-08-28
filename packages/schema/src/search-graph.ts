// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
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
 * The search graph a `/evolve` run writes: one `SubTask` in the memory graph
 * binds one `SearchRun`, under which the candidates live.
 *
 * The same three types cover both algorithms. the PUCT tree and OpenEvolve's island
 * archive differ in *where* a candidate sits, not in what a candidate is, so the
 * shape is: candidates are nodes, lineage is an edge, and the algorithm-specific
 * placement is either a property (`island`) or — for MAP-Elites, where occupancy
 * is a relation rather than an attribute — a bounded third node type.
 *
 * Views are assembled from two interchangeable sources (the run's own event log,
 * and the graph) and must render identically; see docs/evolve-search-graph.md §4.
 */

import type { EvolveAlgorithm, EvolveRunStatus } from "./evolution.js";

/** Run-level identity and aggregates. Separate from the `SubTask` because a
 * resumed run is a second SubTask continuing the *same* search. */
export interface SearchRunSummary {
  algorithm: EvolveAlgorithm;
  baselineScore?: number;
  bestGateScore?: number;
  bestNodeIndex?: number;
  bestTestScore?: number;
  candidates: number;
  costCents: number;
  /** openevolve only. */
  featureBins?: number;
  finishedAt?: string;
  /** openevolve only. */
  islands?: number;
  /** Idempotency watermark; see `EvolveRun.lastSeq`. */
  lastSeq: number;
  /** puct only. */
  maxDepth?: number;
  /** openevolve only. */
  migrations?: number;
  /** puct only. */
  rootVisits?: number;
  /** The frozen scorecard this run's scores are comparable under. */
  scorecardHash: string;
  searchId: string;
  startedAt: string;
  status: EvolveRunStatus;
  tokens: number;
  validCount: number;
}

/**
 * One candidate, including a failed one.
 *
 * `nodeIndex` is the insertion ordinal and is the unified key for both
 * algorithms: the PUCT tree's node index already is one, and OpenEvolve's archive
 * history append order is one too. `programId` carries OpenEvolve's own string
 * identity alongside it rather than replacing it.
 */
export interface SearchNodeSummary {
  accepted?: boolean;
  /** openevolve. */
  birthComplexityBin?: number;
  /** openevolve. */
  birthDiversityBin?: number;
  changeSummary?: string;
  /** CAS address of the candidate's source. The graph stores the hash; the body
   * stays in CAS. */
  codeHash?: string;
  codeChars?: number;
  /** openevolve. */
  combinedScore?: number;
  createdAt: string;
  /** Per-criterion normalised scores, keyed by criterion id. */
  criteria?: Record<string, number>;
  depth: number;
  error?: string;
  evaluatedAt?: string;
  gateScore?: number;
  /** openevolve. */
  inArchive?: boolean;
  /** openevolve. */
  island?: number;
  iteration?: number;
  mergeReason?: string;
  nodeIndex: number;
  parentIndex: number | null;
  /** openevolve. */
  programId?: string;
  /** Constraint id that refused this candidate, when one did. */
  rejectedBy?: string;
  reward?: number;
  rolloutScore?: number;
  /** `null` for a failed candidate — see `EvolveEvent`'s `expanded`. */
  score: number | null;
  searchId: string;
  /** puct: the PUCT value at the moment this node was chosen for expansion. */
  selectedPuct?: number;
  selectedRankScore?: number;
  selectionCount?: number;
  valid: boolean;
  /** puct: absolute visit count. */
  visits?: number;
  worker?: number;
}

/**
 * One MAP-Elites cell (openevolve only). Bounded by `islands × featureBins²`.
 *
 * Occupancy is modelled as a relation rather than a property on the candidate
 * because migration *copies* an elite into a neighbouring island — one program
 * can hold cells on several islands at once — and because the diversity axis is
 * computed against the population at insertion time, so the coordinates are
 * themselves time-dependent.
 */
export interface SearchCellSummary {
  complexityBin: number;
  diversityBin: number;
  island: number;
  occupantNodeIndex: number;
  occupantScore: number | null;
  searchId: string;
  updatedAt: string;
  via: "insert" | "migration";
}

export type SearchGraphEdgeType = "elected" | "expands" | "inspires" | "occupies" | "root";

export interface SearchGraphEdge {
  source: string;
  target: string;
  type: SearchGraphEdgeType;
}

/** What both the live view and the retrospective view render. */
export interface SearchGraphView {
  cells: SearchCellSummary[];
  edges: SearchGraphEdge[];
  nodes: SearchNodeSummary[];
  /** Absent when the run itself is unknown to the source. */
  run?: SearchRunSummary;
  /** Set when the source degraded (`memory_graph_disabled` /
   * `memory_graph_unreachable`) or the search is unknown. */
  reason?: string;
  /** The read layer caps node count; a partial view says so rather than
   * silently looking complete. */
  truncated: boolean;
}
