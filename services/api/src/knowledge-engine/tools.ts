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
 * Knowledge-engine consumption tools — the composition layer between the
 * pure graph algorithms (packages/knowledge-engine) and the agent runtime
 * (packages/workspace tool registration). Synchronous store reads are
 * adapted to the async ports here; the tools never do IO of their own.
 */

import {
  briefUncertaintyFrom,
  buildAntiHallucinationBrief,
  buildResidentSummary,
  conceptExplore,
  cosineScan,
  deepDive,
  docIdFromAnchor,
  driftSearch,
  embeddingFromBlob,
  entityUnifiedSearch,
  expandAnchor,
  findGaps,
  grepDocuments,
  hybridSearchBlocks,
  noveltyCheck,
  searchBlocks,
  validateEntities,
  verifyCitation,
  combineNovelty,
  runExternalNoveltyStage,
  type BriefKbUncertainty,
  type CitationVerifyResult,
  type DeepDiveResult,
  type DocGrepResult,
  type DriftSearchResult,
  type EntityUnifiedSearchResult,
  type ExploreDataAccess,
  type ExploreResult,
  type GapAnalysis,
  type KbExpandResult,
  type KbSearchDocumentInput,
  type KbSearchResult,
  type NoveltyCheckResult,
  type NoveltyCombined,
  type NoveltyExternalSection,
  type NoveltyExternalSource,
  type ResidentSummary,
  type ValidateEntitiesResult,
  type VectorChunkCandidate,
} from "@sciencediscovery/knowledge-engine";

import type { EmbeddingClient } from "./embedding.js";
import { graphFingerprintOf } from "./graph-roots.js";
import type { KnowledgeEngineStore } from "./store.js";

export interface KeToolKbInfo {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly stats: { documents: number; documentsReady: number; entities: number; edges: number };
}

/** The port shape consumed by packages/workspace tool registration. */
export interface KnowledgeEngineToolPort {
  listKnowledgeBases(): Promise<KeToolKbInfo[]>;
  conceptExplore(kbId: string, entity: string, opts: { hops?: 1 | 2; limit?: number }): Promise<ExploreResult>;
  deepDive(kbId: string, entity: string, opts: { maxEdges?: number }): Promise<DeepDiveResult>;
  entityUnifiedSearch(
    kbId: string,
    entity: string,
    opts: { graphLimit?: number; maxEdges?: number; docTopK?: number },
  ): Promise<EntityUnifiedSearchResult>;
  validateEntities(kbId: string, names: readonly string[]): Promise<ValidateEntitiesResult>;
  gapCandidates(
    kbId: string,
    opts: { topN?: number; signals?: Array<"holes" | "conflicts" | "transfers"> },
  ): Promise<GapAnalysis>;
  /** W8/Z8: document search with block-level anchor hits (kb_search) —
   *  keyword (FTS) fused with the semantic arm (stored chunk vectors, RRF)
   *  when an embedding client is configured; keyword-only otherwise. */
  kbSearch(kbId: string, query: string, opts: { topK?: number; docLimit?: number; minScoreRatio?: number }): Promise<KbSearchResult>;
  /** W8: read an anchor's block plus neighbours (kb_expand) — structured
   *  not-found reasons instead of exceptions for missing docs/anchors. */
  kbExpand(kbId: string, anchorId: string): Promise<KbExpandResult>;
  /** W8: regex over document fulltexts, line-grained (doc_grep). Invalid
   *  patterns come back as a structured error, not a throw. */
  docGrep(kbId: string, pattern: string, opts: { maxMatches?: number }): Promise<DocGrepResult>;
  /** V2-Z2: DRIFT two-stage retrieval (drift_search) — community reports
   *  (global) select the communities, query-matched members and evidence
   *  edges (local) come back per community. Requires ready reports for the
   *  CURRENT graph fingerprint; honest empty states otherwise. */
  driftSearch(
    kbId: string,
    query: string,
    opts: { maxCommunities?: number; seedsPerCommunity?: number; edgesPerCommunity?: number },
  ): Promise<DriftSearchResult>;
  /** W9/V1-Z1: novelty check for a candidate claim (novelty_check) —
   *  entity/relation/passage probes against THIS KB plus, when external
   *  sources are configured, the S2→OpenAlex counter-evidence stage and the
   *  combined PU-worded verdict under `novelty`. */
  noveltyCheck(kbId: string, claim: string): Promise<NoveltyCheckResult & {
    external: NoveltyExternalSection | null;
    novelty: NoveltyCombined;
  }>;
  /** W9: three-state quote verification across the KB's documents
   *  (verify_citation) — verbatim / fuzzy / not-found. */
  verifyCitation(kbId: string, quote: string): Promise<CitationVerifyResult>;
  /** W9: uncertain signals (conflicts, single-source entities) for the
   *  three-tier anti-hallucination context injection. */
  kbRiskSignals(kbId: string): Promise<BriefKbUncertainty>;
  /** Resident summary for context injection; null when the KB has no graph. */
  residentSummary(kbId: string): Promise<ResidentSummary | null>;
}

/** Thrown by tool methods for a missing KB — the workspace layer surfaces
 *  the message to the agent as a structured error. */
export class KeKbNotFoundError extends Error {
  constructor(kbId: string) {
    super(`knowledge base ${kbId} not found`);
    this.name = "KeKbNotFoundError";
  }
}

/** Finding summaries off a serialized findings JSON — defensive parse: the
 *  column is written by the report runner, but a corrupt row must degrade to
 *  an empty list, never crash the search. */
function parseFindingSummaries(findingsJson: string): string[] {
  try {
    const parsed: unknown = JSON.parse(findingsJson);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) =>
        typeof item === "object" && item !== null && typeof (item as Record<string, unknown>)["summary"] === "string"
          ? ((item as Record<string, unknown>)["summary"] as string)
          : "")
      .filter((summary) => summary.length > 0);
  } catch {
    return [];
  }
}

export function createKnowledgeEngineTools(
  store: KnowledgeEngineStore,
  options: {
    embedding?: EmbeddingClient;
    /** Degradation telemetry for the hybrid search arm (logged, never fatal). */
    onWarn?: (message: string) => void;
    /** V1-Z1: external counter-evidence sources for novelty_check —
     *  connector-backed (S2 first, OpenAlex fallback) in production. Absent
     *  → the external stage reports "no sources configured" and the combined
     *  verdict discloses its internal-only scope. */
    noveltyExternal?: readonly NoveltyExternalSource[];
  } = {},
): KnowledgeEngineToolPort {
  // Read bounds: 10k entities / 500 edges-per-entity / 50k edges total are
  // far above any realistic KB today; they are guardrails against accidental
  // unbounded reads, not pagination contracts (no truncation is surfaced).
  const exploreData: ExploreDataAccess = {
    listEntities: async (kbId) => store.listEntities(kbId, { limit: 10_000 }),
    listEdgesByEntity: async (kbId, entityId) => store.listEdges(kbId, { entityId, limit: 500 }),
    documentTitle: async (docId) => store.getDocument(docId)?.title ?? null,
  };

  const requireKb = (kbId: string): void => {
    if (!store.getKnowledgeBase(kbId)) {
      throw new KeKbNotFoundError(kbId);
    }
  };

  return {
    async listKnowledgeBases() {
      return store.listKnowledgeBases().map((kb) => ({
        id: kb.id,
        name: kb.name,
        description: kb.description,
        stats: (({ documents, documentsReady, entities, edges }) => ({ documents, documentsReady, entities, edges }))(
          store.countKbStats(kb.id),
        ),
      }));
    },

    async conceptExplore(kbId, entity, opts) {
      requireKb(kbId);
      return conceptExplore(kbId, entity, exploreData, opts);
    },

    async deepDive(kbId, entity, opts) {
      requireKb(kbId);
      return deepDive(kbId, entity, exploreData, opts);
    },

    async entityUnifiedSearch(kbId, entity, opts) {
      requireKb(kbId);
      return entityUnifiedSearch(kbId, entity, exploreData, opts, {
        searchDocuments: async (id, query, topK) => store.searchDocuments(id, query, topK),
        searchCitations: async (id, name, limit) => {
          // Entity-mention match over citation sentences and resolved
          // destination titles — the W10 chain's agent surface. The scan
          // reads at most the 500 most recent citation rows of the KB;
          // beyond that the section misses older sentences (bounded read,
          // surfaced here because the 10-hit section cap is not the limit).
          const needle = name.toLowerCase();
          return store
            .listCitations(id, { limit: 500 })
            .filter((row) =>
              row.sentence.toLowerCase().includes(needle)
              || (row.dstTitle ?? "").toLowerCase().includes(needle))
            .slice(0, limit)
            .map((row) => ({
              srcDocId: row.srcDocId,
              srcTitle: row.srcTitle,
              dstDocId: row.dstDocId,
              dstTitle: row.dstTitle,
              dstKey: row.dstKey,
              intent: row.intent,
              sentence: row.sentence,
              section: row.section,
            }));
        },
      });
    },

    async validateEntities(kbId, names) {
      requireKb(kbId);
      return validateEntities(kbId, names, exploreData);
    },

    async gapCandidates(kbId, opts) {
      requireKb(kbId);
      return findGaps(
        store.listEntities(kbId, { limit: 10_000 }),
        store.listEdges(kbId, { limit: 50_000 }),
        opts,
      );
    },

    async kbSearch(kbId, query, opts) {
      requireKb(kbId);
      // FTS5 recalls documents (title/abstract/fulltext); the pure layer
      // re-derives W7 blocks on demand so every hit is an anchor into the
      // three-level reader. docLimit stays small — block parsing is
      // milliseconds per document at this scale.
      const docLimit = Math.max(1, Math.min(opts.docLimit ?? 6, 10));
      const topK = Math.max(1, Math.min(opts.topK ?? 8, 20));
      const minScoreRatio = opts.minScoreRatio === undefined ? undefined : Math.max(0, Math.min(opts.minScoreRatio, 1));
      const toInput = (document: NonNullable<ReturnType<KnowledgeEngineStore["getDocument"]>>): KbSearchDocumentInput => ({
        docId: document.id,
        title: document.title,
        fulltext: document.fulltext!,
      });
      const documents = store
        .searchDocumentIds(kbId, query, docLimit)
        .map((docId) => store.getDocument(docId))
        .filter((document): document is NonNullable<typeof document> => Boolean(document?.fulltext))
        .map(toInput);

      // Z8 semantic arm: cosine over stored chunk vectors, over-fetched and
      // fused with the keyword arm via RRF in the pure layer. Any failure
      // (no client, no embedded chunks, embed outage) degrades to
      // keyword-only — the deterministic path is never removed.
      let vectorCandidates: readonly VectorChunkCandidate[] | undefined;
      if (options.embedding) {
        try {
          const queryVector = await options.embedding.embedOne(query);
          const chunks = store.listDocChunksWithEmbedding(kbId);
          if (chunks.length > 0) {
            const ranked = cosineScan(
              queryVector,
              chunks.map((chunk) => ({ item: chunk, embedding: embeddingFromBlob(chunk.embedding) })),
              // Per-source over-fetch: only the top topK*2 candidates are
              // fused — and only their documents get loaded below, or every
              // embedded document in the KB would be read per search.
              { topK: topK * 2 },
            );
            vectorCandidates = ranked
              .map((match) => ({ docId: match.item.docId, anchorId: match.item.anchorId, score: match.score }));
            // Load the vector arm's documents too — the fuser needs their
            // blocks for anchor metadata.
            const known = new Set(documents.map((document) => document.docId));
            for (const candidate of vectorCandidates) {
              if (known.has(candidate.docId)) continue;
              const document = store.getDocument(candidate.docId);
              if (document?.fulltext && document.kbId === kbId) {
                documents.push(toInput(document));
                known.add(candidate.docId);
              }
            }
          }
        } catch (error) {
          options.onWarn?.(
            `kb_search vector arm degraded to keyword-only: ${error instanceof Error ? error.message : String(error)}`,
          );
          vectorCandidates = undefined;
        }
      }
      if (vectorCandidates === undefined) {
        return searchBlocks({ kbId, query, documents, topK, minScoreRatio });
      }
      return hybridSearchBlocks({ kbId, query, documents, vectorCandidates, topK, minScoreRatio });
    },

    async kbExpand(kbId, anchorId) {
      requireKb(kbId);
      const docId = docIdFromAnchor(anchorId);
      const document = docId ? store.getDocument(docId) : undefined;
      // Structured reasons for every miss: the agent retries with a corrected
      // anchor instead of decoding an exception message.
      if (!document || document.kbId !== kbId) {
        return { found: false as const, reason: "document-not-found" as const };
      }
      if (!document.fulltext) {
        return { found: false as const, reason: "document-not-parsed" as const };
      }
      return expandAnchor({
        kbId,
        anchorId,
        document: { docId: document.id, title: document.title, fulltext: document.fulltext },
      });
    },

    async docGrep(kbId, pattern, opts) {
      requireKb(kbId);
      // Regex is the point (kb_search is keyword-only), so this scans ready
      // documents directly instead of going through FTS recall. The 200-doc
      // bound is a guardrail against unbounded reads, not a pagination rule.
      const documents = store
        .listDocuments(kbId, { status: "ready", limit: 200 })
        .filter((document) => Boolean(document.fulltext))
        .map((document) => ({ docId: document.id, title: document.title, fulltext: document.fulltext! }));
      return grepDocuments({ kbId, pattern, documents, maxMatches: opts.maxMatches });
    },

    async driftSearch(kbId, query, opts) {
      requireKb(kbId);
      return driftSearch(kbId, query, {
        // Fingerprint straight from store stats (no partition compute). An
        // entity- and edge-less KB reads as "no graph yet" per the port
        // contract — DRIFT has nothing to traverse there.
        graphFingerprint: async (id) => {
          if (store.entitySupportStats(id).count === 0 && store.edgeFingerprint(id).count === 0) return null;
          return graphFingerprintOf(store, id);
        },
        listCommunityReports: async (id, fingerprint) =>
          store.listCommunityReports(id, fingerprint).map((row) => ({
            communityId: row.communityId,
            // The report row carries no partition-time community name — the
            // LLM-written title IS the display name.
            communityName: null,
            title: row.title,
            summary: row.summary,
            rating: row.rating,
            findingSummaries: parseFindingSummaries(row.findings),
          })),
        listEntitiesByCommunity: async (id, communityId) =>
          store.listEntitiesByCommunity(id, communityId, 200).map((entity) => ({
            id: entity.id,
            name: entity.name,
            type: entity.type,
            description: entity.description,
            supportCount: entity.supportCount,
          })),
        listEdgesWithinCommunity: async (id, communityId) =>
          store.listEdgesWithinCommunity(id, communityId, 300).map((edge) => ({
            id: edge.id,
            srcId: edge.srcId,
            dstId: edge.dstId,
            type: edge.type,
            supportCount: edge.supportCount,
            evidenceQuote: edge.evidenceQuote,
            evidenceDocId: edge.evidenceDocId,
          })),
        latestReadyFingerprint: async (id) => store.latestReadyFingerprint(id),
      }, opts);
    },

    async noveltyCheck(kbId, claim) {
      requireKb(kbId);
      const entities = store.listEntities(kbId, { limit: 10_000 });
      const nameById = new Map(entities.map((entity) => [entity.id, entity.name]));
      const relations = store.listEdges(kbId, { limit: 50_000 }).map((edge) => ({
        sourceName: nameById.get(edge.srcId) ?? edge.srcId.slice(0, 8),
        targetName: nameById.get(edge.dstId) ?? edge.dstId.slice(0, 8),
        type: edge.type,
        supportCount: edge.supportCount,
        quote: edge.evidenceQuote,
      }));
      // Passage probe bound: 201 fetched so a hit on the 201st row surfaces
      // the cap honestly (a capped scan's miss is not final).
      const documents = store
        .listDocuments(kbId, { status: "ready", limit: 201 })
        .filter((document) => Boolean(document.fulltext))
        .map((document) => ({ docId: document.id, title: document.title, fulltext: document.fulltext! }));
      const capped = documents.length > 200;
      const internal = noveltyCheck({
        kbId,
        claim,
        entities: entities.map((entity) => ({
          name: entity.name,
          type: entity.type,
          supportCount: entity.supportCount,
          aliases: entity.aliases,
        })),
        relations,
        documents: capped ? documents.slice(0, 200) : documents,
      });
      // V1-Z1: external counter-evidence (S2 → OpenAlex), then the combined
      // PU-worded verdict. Field order matters for consumers that read the
      // first `verdict` key (the stub in the J-KE6 journey): the internal
      // verdict stays first, the combined verdict lands under `novelty`.
      const external = options.noveltyExternal
        ? await runExternalNoveltyStage(claim, options.noveltyExternal).catch((error: unknown) => ({
          status: "error" as const,
          checkedSources: [],
          error: `external stage crashed: ${error instanceof Error ? error.message : String(error)}`,
          candidates: 0,
          items: [],
        }))
        : null;
      const combined = combineNovelty({ claim, internal, external });
      const cappedNote = capped
        ? " (passage probe scanned the first 200 ready documents — a miss there is not final)"
        : "";
      const result = {
        ...internal,
        note: `${internal.note}${cappedNote}`,
        external,
        novelty: combined,
      };
      return result;
    },

    async verifyCitation(kbId, quote) {
      requireKb(kbId);
      // 201 fetched so a hit on the 201st row surfaces the cap honestly —
      // a capped scan's not-found must not read as "quote absent".
      const rows = store.listDocuments(kbId, { status: "ready", limit: 201 })
        .filter((document) => Boolean(document.fulltext));
      const capped = rows.length > 200;
      const documents: KbSearchDocumentInput[] = (capped ? rows.slice(0, 200) : rows)
        .map((document) => ({ docId: document.id, title: document.title, fulltext: document.fulltext! }));
      const result = verifyCitation({ kbId, quote, documents });
      return capped && result.state === "none"
        ? { ...result, note: "quote not found in any scanned document — do not present it as a paper's wording (scan capped at the first 200 ready documents; a miss is not final)" }
        : result;
    },

    async kbRiskSignals(kbId) {
      requireKb(kbId);
      const kb = store.getKnowledgeBase(kbId)!;
      const entities = store.listEntities(kbId, { limit: 10_000 });
      const nameById = new Map(entities.map((entity) => [entity.id, entity.name]));
      return briefUncertaintyFrom({ id: kbId, name: kb.name }, {
        entities: entities.map((entity) => ({ name: entity.name, supportCount: entity.supportCount })),
        edges: store.listEdges(kbId, { limit: 50_000 }).map((edge) => ({
          type: edge.type,
          sourceName: nameById.get(edge.srcId) ?? edge.srcId.slice(0, 8),
          targetName: nameById.get(edge.dstId) ?? edge.dstId.slice(0, 8),
          quote: edge.evidenceQuote,
        })),
      });
    },

    async residentSummary(kbId) {
      requireKb(kbId);
      const stats = store.countKbStats(kbId);
      return buildResidentSummary(kbId, {
        countEntities: async () => stats.entities,
        countEdges: async () => stats.edges,
        // An empty object means "no cycle has ever completed" → null, so the
        // stage falls to early/mid instead of reading {} as a live engine.
        engineState: async () => {
          const state = store.getKnowledgeBase(kbId)?.engineState as Record<string, unknown> | undefined;
          return state && Object.keys(state).length > 0 ? (state as { converged?: boolean }) : null;
        },
        topEntitiesBySupport: async (id, limit) => store.topEntitiesBySupport(id, limit),
        topEdgesBySupport: async (id, limit) => store.topEdgesBySupport(id, limit),
        entityName: async (id) => store.getEntity(id)?.name ?? null,
        topCommunityReports: async (id, limit) =>
          store.latestCommunityReports(id, limit).map((row) => ({ title: row.title, rating: row.rating })),
      });
    },
  };
}
