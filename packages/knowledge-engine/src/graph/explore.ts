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
 * Concept explore / deep dive / unified search — deterministic neighborhood
 * reads over the entity graph, ported from the DeepAnalyze concept-explore
 * and entity-unified-search modules. Pure read queries: no LLM, no ranking
 * heuristics beyond stored support counts. Entity resolution is exact-
 * normalized first, then alias, then substring — ambiguous queries return
 * candidates instead of guessing. Data access goes through the
 * ExploreDataAccess port so the logic is storage-agnostic and testable.
 */

/** Minimal normalized-name normalization shared with the store
 *  (NFKC + lowercase + collapse whitespace) — duplicated here so the package
 *  stays zero-dependency. */
function normalizeName(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export interface ExploreEntity {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly description: string | null;
  readonly aliases: readonly string[];
  readonly supportCount: number;
  readonly trustLevel: string;
}

export interface ExploreEdge {
  readonly id: string;
  readonly srcId: string;
  readonly dstId: string;
  readonly type: string;
  readonly supportCount: number;
  readonly evidenceQuote: string | null;
  readonly evidenceDocId: string | null;
}

/** Storage port the reads run against (implemented by the KE store). */
export interface ExploreDataAccess {
  listEntities(kbId: string): Promise<ExploreEntity[]>;
  listEdgesByEntity(kbId: string, entityId: string): Promise<ExploreEdge[]>;
  /** Document title for evidence attribution; null when unknown. */
  documentTitle(docId: string): Promise<string | null>;
}

export interface EntitySummary {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly description: string | null;
  readonly supportCount: number;
  readonly trustLevel: string;
}

export interface NeighborEntry {
  readonly entity: EntitySummary;
  readonly edgeType: string;
  /** 'out' = center → neighbor, 'in' = neighbor → center (for 2-hop entries,
   *  relative to the 1-hop neighbor they expand). */
  readonly direction: "out" | "in";
  /** 1 = directly adjacent to the center; 2 = adjacent to a 1-hop neighbor. */
  readonly hop: 1 | 2;
  readonly supportCount: number;
}

export interface ExploreResult {
  readonly found: boolean;
  /** Ambiguous name: pick from these instead of guessing. */
  readonly candidates?: EntitySummary[];
  readonly center?: EntitySummary;
  readonly neighbors?: NeighborEntry[];
  /** True when budget cut off remaining edges (not merely limit == count). */
  readonly truncated?: boolean;
  readonly hops: number;
}

export interface EvidenceEntry {
  readonly neighbor: EntitySummary;
  readonly edgeType: string;
  readonly direction: "out" | "in";
  /** Verbatim source quote backing this edge. */
  readonly evidenceQuote: string | null;
  readonly evidenceDocId: string | null;
  readonly evidenceDocName: string | null;
}

export interface DeepDiveResult {
  readonly found: boolean;
  readonly candidates?: EntitySummary[];
  readonly entity?: EntitySummary & { aliases: readonly string[] };
  readonly evidence?: EvidenceEntry[];
  readonly truncated?: boolean;
}

function toSummary(entity: ExploreEntity): EntitySummary {
  return {
    id: entity.id,
    name: entity.name,
    type: entity.type,
    description: entity.description,
    supportCount: entity.supportCount,
    trustLevel: entity.trustLevel,
  };
}

/**
 * Resolve a name against a preloaded entity list: exact (normalized) →
 * alias → substring. Empty names resolve to nothing; alias collisions and
 * multiple substring matches return candidates (never a silent guess).
 */
export function resolveFromEntities(
  name: string,
  all: readonly ExploreEntity[],
): { entity?: ExploreEntity; candidates?: ExploreEntity[] } {
  const normalized = normalizeName(name);
  if (!normalized) return {};

  const exact = all.find((entity) => normalizeName(entity.name) === normalized);
  if (exact) return { entity: exact };

  const aliasHits = all.filter((entity) =>
    entity.aliases.some((alias) => normalizeName(alias) === normalized),
  );
  if (aliasHits.length === 1) return { entity: aliasHits[0]! };
  if (aliasHits.length > 1) return { candidates: aliasHits.slice(0, 10) };

  const partial = all.filter((entity) => {
    const canonical = normalizeName(entity.name);
    return canonical.includes(normalized) || normalized.includes(canonical);
  });
  if (partial.length === 1) return { entity: partial[0]! };
  if (partial.length > 1) return { candidates: partial.slice(0, 10) };
  return {};
}

/**
 * Neighborhood of an entity. 1-hop neighbors come first (ordered by edge
 * support); with hops=2 the strongest 1-hop neighbors are expanded and those
 * entries (hop: 2) are appended, all within the same limit budget.
 */
export async function conceptExplore(
  kbId: string,
  name: string,
  data: ExploreDataAccess,
  opts: { hops?: 1 | 2; limit?: number } = {},
): Promise<ExploreResult> {
  const hops = opts.hops ?? 1;
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);

  const all = await data.listEntities(kbId);
  const byId = new Map(all.map((entity) => [entity.id, entity]));
  const resolved = resolveFromEntities(name, all);
  if (resolved.candidates) {
    return { found: false, candidates: resolved.candidates.map(toSummary), hops };
  }
  if (!resolved.entity) return { found: false, hops };
  const center = resolved.entity;

  const neighbors: NeighborEntry[] = [];
  const seen = new Set<string>([center.id]);
  let skippedRemaining = false;

  const collect = async (entityId: string, hop: 1 | 2) => {
    // Strongest edges first — do not rely on store ordering (deterministic
    // regardless of the backing query).
    const edges = [...await data.listEdgesByEntity(kbId, entityId)].sort(
      (a, b) => b.supportCount - a.supportCount || a.id.localeCompare(b.id),
    );
    for (const edge of edges) {
      if (neighbors.length >= limit) {
        skippedRemaining = true;
        break;
      }
      const otherId = edge.srcId === entityId ? edge.dstId : edge.srcId;
      if (seen.has(otherId)) continue;
      const other = byId.get(otherId);
      if (!other) continue;
      seen.add(otherId);
      neighbors.push({
        entity: toSummary(other),
        edgeType: edge.type,
        direction: edge.srcId === entityId ? "out" : "in",
        hop,
        supportCount: edge.supportCount,
      });
    }
  };

  await collect(center.id, 1);

  // 2-hop: expand the strongest first-hop neighbors within the same budget
  if (hops === 2 && neighbors.length < limit) {
    const firstHop = neighbors.filter((neighbor) => neighbor.hop === 1).slice(0, 5).map((neighbor) => neighbor.entity.id);
    for (const id of firstHop) {
      if (neighbors.length >= limit) break;
      await collect(id, 2);
    }
  }

  return { found: true, center: toSummary(center), neighbors, truncated: skippedRemaining, hops };
}

/**
 * Full detail for one entity: aliases plus evidence-backed edges with
 * verbatim quotes and source document titles.
 */
export async function deepDive(
  kbId: string,
  name: string,
  data: ExploreDataAccess,
  opts: { maxEdges?: number } = {},
): Promise<DeepDiveResult> {
  const maxEdges = Math.min(Math.max(opts.maxEdges ?? 25, 1), 100);

  const all = await data.listEntities(kbId);
  const byId = new Map(all.map((entity) => [entity.id, entity]));
  const resolved = resolveFromEntities(name, all);
  if (resolved.candidates) {
    return { found: false, candidates: resolved.candidates.map(toSummary) };
  }
  if (!resolved.entity) return { found: false };
  const entity = resolved.entity;

  // Strongest edges first — the store orders this way too, but the port
  // contract must not depend on it (deterministic regardless of the backing
  // query).
  const edges = [...await data.listEdgesByEntity(kbId, entity.id)].sort(
    (a, b) => b.supportCount - a.supportCount || a.id.localeCompare(b.id),
  );
  const docNames = new Map<string, string | null>();
  const evidence: EvidenceEntry[] = [];
  for (const edge of edges.slice(0, maxEdges)) {
    const other = byId.get(edge.srcId === entity.id ? edge.dstId : edge.srcId);
    if (!other) continue;
    let docName: string | null | undefined = edge.evidenceDocId ? docNames.get(edge.evidenceDocId) : null;
    if (docName === undefined && edge.evidenceDocId) {
      docName = await data.documentTitle(edge.evidenceDocId);
      docNames.set(edge.evidenceDocId, docName);
    }
    evidence.push({
      neighbor: toSummary(other),
      edgeType: edge.type,
      direction: edge.srcId === entity.id ? "out" : "in",
      evidenceQuote: edge.evidenceQuote,
      evidenceDocId: edge.evidenceDocId,
      evidenceDocName: docName ?? null,
    });
  }

  return {
    found: true,
    entity: { ...toSummary(entity), aliases: entity.aliases },
    evidence,
    truncated: edges.length > maxEdges,
  };
}

// ---------------------------------------------------------------------------
// validate_entities — anti-hallucination check: which claimed names exist?
// ---------------------------------------------------------------------------

export interface EntityValidation {
  readonly name: string;
  readonly status: "found" | "ambiguous" | "unknown";
  readonly entity?: EntitySummary;
  readonly candidates?: EntitySummary[];
}

export interface ValidateEntitiesResult {
  readonly results: EntityValidation[];
  readonly found: number;
  readonly ambiguous: number;
  readonly unknown: number;
}

/** Check claimed entity names against the graph. Cap: 50 names per call. */
export async function validateEntities(
  kbId: string,
  names: readonly string[],
  data: ExploreDataAccess,
): Promise<ValidateEntitiesResult> {
  const capped = names.slice(0, 50);
  const all = await data.listEntities(kbId);
  const results: EntityValidation[] = [];
  for (const name of capped) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const resolved = resolveFromEntities(trimmed, all);
    if (resolved.entity) {
      results.push({ name: trimmed, status: "found", entity: toSummary(resolved.entity) });
    } else if (resolved.candidates) {
      results.push({ name: trimmed, status: "ambiguous", candidates: resolved.candidates.map(toSummary) });
    } else {
      results.push({ name: trimmed, status: "unknown" });
    }
  }
  return {
    results,
    found: results.filter((result) => result.status === "found").length,
    ambiguous: results.filter((result) => result.status === "ambiguous").length,
    unknown: results.filter((result) => result.status === "unknown").length,
  };
}

// ---------------------------------------------------------------------------
// entity_unified_search — concurrent multi-source lookup over one entity
// ---------------------------------------------------------------------------

export type SourceStatus = "ok" | "ambiguous" | "empty" | "error";

export interface GraphSection {
  readonly status: SourceStatus;
  readonly error?: string;
  readonly candidates?: EntitySummary[];
  readonly center?: EntitySummary;
  readonly neighbors?: NeighborEntry[];
  readonly truncated?: boolean;
}

export interface EvidenceSection {
  readonly status: SourceStatus;
  readonly error?: string;
  readonly candidates?: EntitySummary[];
  readonly entity?: EntitySummary & { aliases: readonly string[] };
  readonly evidence?: EvidenceEntry[];
  readonly truncated?: boolean;
}

export interface DocumentsSection {
  readonly status: SourceStatus;
  readonly error?: string;
  readonly hits?: Array<{ docId: string; title: string; snippet: string }>;
}

/** W10 citation-context hit: a [@rid] anchor row matched to the entity. */
export interface CitationHit {
  readonly srcDocId: string;
  readonly srcTitle: string | null;
  readonly dstDocId: string | null;
  readonly dstTitle: string | null;
  readonly dstKey: string;
  readonly intent: string | null;
  readonly sentence: string;
  readonly section: string | null;
}

/** Citation contexts (the W10 chain): rows whose sentence or resolved
 *  destination mentions the entity. Absent dep → explicit error section. */
export interface CitationsSection {
  readonly status: SourceStatus;
  readonly error?: string;
  readonly hits?: readonly CitationHit[];
  /** true when more matched rows exist beyond the section cap. */
  readonly truncated?: boolean;
}

export interface EntityUnifiedSearchResult {
  readonly entity: string;
  /** Merged dedup candidates when graph/evidence resolution is ambiguous. */
  readonly candidates?: EntitySummary[];
  readonly sources: {
    readonly graph: GraphSection;
    readonly evidence: EvidenceSection;
    readonly citations: CitationsSection;
    readonly documents: DocumentsSection;
  };
  readonly elapsedMs: number;
}

export interface UnifiedSearchDeps {
  /** Keyword document search (FTS). Absent → documents section errors. */
  readonly searchDocuments?: (
    kbId: string,
    query: string,
    topK: number,
  ) => Promise<Array<{ docId: string; title: string; snippet: string }>>;
  /** W10 citation contexts matching an entity (sentence or resolved
   *  destination mentions it). Absent → citations section errors. */
  readonly searchCitations?: (
    kbId: string,
    entity: string,
    limit: number,
  ) => Promise<readonly CitationHit[]>;
}

/**
 * Concurrent multi-source entity lookup. Independent sections, no cross-
 * source fusion ranking (the shapes are heterogeneous and a fused score
 * would imply false comparability); a single source failing does not affect
 * the others. Ambiguity surfaces as candidates, never guessed.
 */
export async function entityUnifiedSearch(
  kbId: string,
  entity: string,
  data: ExploreDataAccess,
  opts: { graphLimit?: number; maxEdges?: number; docTopK?: number } = {},
  deps: UnifiedSearchDeps = {},
): Promise<EntityUnifiedSearchResult> {
  const started = Date.now();
  const name = entity.trim();

  const [graphR, evidenceR, documentsR, citationsR] = await Promise.allSettled([
    queryGraphSection(kbId, name, data, opts),
    queryEvidenceSection(kbId, name, data, opts),
    queryDocumentsSection(kbId, name, opts, deps),
    queryCitationsSection(kbId, name, deps),
  ]);

  const graph: GraphSection =
    graphR.status === "fulfilled" ? graphR.value : { status: "error", error: errMessage(graphR.reason) };
  const evidence: EvidenceSection =
    evidenceR.status === "fulfilled" ? evidenceR.value : { status: "error", error: errMessage(evidenceR.reason) };
  const documents: DocumentsSection =
    documentsR.status === "fulfilled"
      ? documentsR.value
      : { status: "error", error: errMessage(documentsR.reason) };
  const citations: CitationsSection =
    citationsR.status === "fulfilled"
      ? citationsR.value
      : { status: "error", error: errMessage(citationsR.reason) };

  // Merge candidates from ambiguous graph/evidence resolutions (dedup by id),
  // following the never-guess principle.
  const candidateMap = new Map<string, EntitySummary>();
  const merged: EntitySummary[] = [];
  for (const list of [graph.candidates, evidence.candidates]) {
    for (const candidate of list ?? []) {
      if (!candidateMap.has(candidate.id)) {
        candidateMap.set(candidate.id, candidate);
        merged.push(candidate);
      }
    }
  }

  return {
    entity: name,
    ...(merged.length > 0 ? { candidates: merged } : {}),
    sources: {
      graph,
      evidence,
      documents,
      citations,
    },
    elapsedMs: Date.now() - started,
  };
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function queryGraphSection(
  kbId: string,
  name: string,
  data: ExploreDataAccess,
  opts: { graphLimit?: number },
): Promise<GraphSection> {
  const result = await conceptExplore(kbId, name, data, { hops: 1, limit: opts.graphLimit ?? 15 });
  if (result.candidates) return { status: "ambiguous", candidates: result.candidates };
  if (!result.found) return { status: "empty" };
  return { status: "ok", center: result.center, neighbors: result.neighbors, truncated: result.truncated };
}

async function queryEvidenceSection(
  kbId: string,
  name: string,
  data: ExploreDataAccess,
  opts: { maxEdges?: number },
): Promise<EvidenceSection> {
  const result = await deepDive(kbId, name, data, { maxEdges: opts.maxEdges ?? 15 });
  if (result.candidates) return { status: "ambiguous", candidates: result.candidates };
  if (!result.found) return { status: "empty" };
  return { status: "ok", entity: result.entity, evidence: result.evidence, truncated: result.truncated };
}

async function queryDocumentsSection(
  kbId: string,
  name: string,
  opts: { docTopK?: number },
  deps: UnifiedSearchDeps,
): Promise<DocumentsSection> {
  if (!name) return { status: "empty" };
  if (!deps.searchDocuments) return { status: "error", error: "document search not available" };
  const hits = await deps.searchDocuments(kbId, name, Math.min(Math.max(opts.docTopK ?? 5, 1), 20));
  if (hits.length === 0) return { status: "empty" };
  return { status: "ok", hits: hits.map((hit) => ({ ...hit, snippet: hit.snippet.slice(0, 300) })) };
}

/** Section cap: enough to answer "where is this entity cited" without
 *  flooding the tool payload. */
const CITATIONS_SECTION_CAP = 10;

async function queryCitationsSection(
  kbId: string,
  name: string,
  deps: UnifiedSearchDeps,
): Promise<CitationsSection> {
  if (!name) return { status: "empty" };
  if (!deps.searchCitations) return { status: "error", error: "citation contexts not available in this build" };
  const hits = await deps.searchCitations(kbId, name, CITATIONS_SECTION_CAP + 1);
  if (hits.length === 0) return { status: "empty" };
  const truncated = hits.length > CITATIONS_SECTION_CAP;
  return {
    status: "ok",
    hits: (truncated ? hits.slice(0, CITATIONS_SECTION_CAP) : hits).map((hit) => ({
      ...hit,
      sentence: hit.sentence.slice(0, 300),
    })),
    ...(truncated ? { truncated } : {}),
  };
}
