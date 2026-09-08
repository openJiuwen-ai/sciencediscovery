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
  buildResidentSummary,
  conceptExplore,
  deepDive,
  entityUnifiedSearch,
  findGaps,
  validateEntities,
  type DeepDiveResult,
  type EntityUnifiedSearchResult,
  type ExploreDataAccess,
  type ExploreResult,
  type GapAnalysis,
  type ResidentSummary,
  type ValidateEntitiesResult,
} from "@sciencediscovery/knowledge-engine";

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

export function createKnowledgeEngineTools(store: KnowledgeEngineStore): KnowledgeEngineToolPort {
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
      });
    },
  };
}
