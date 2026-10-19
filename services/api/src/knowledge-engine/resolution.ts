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
 * Entity-resolution service glue: the mode switch, the store → ResolverRepo
 * adapter, and the online-attach audit helper. The layered gates themselves
 * are pure and live in packages/knowledge-engine/src/resolution.
 */

import {
  normalizeEntityName as normalizeKeName,
  type EntityResolutionMode,
  type ResolverEntity,
  type ResolverRepo,
} from "@sciencediscovery/knowledge-engine";

import { normalizeEntityName, type KeEntityRow, type KnowledgeEngineStore } from "./store.js";

export type { EntityResolutionMode };

/**
 * Active resolution mode. Precedence: env SCIENCE_AGENT_KE_ENTITY_RESOLUTION
 * > ke_settings `entity_resolution_mode` > 'off'. Opt-in by design — an
 * undeclared setup behaves exactly as before (byte-identical writes).
 */
export function resolveEntityResolutionMode(store?: KnowledgeEngineStore): EntityResolutionMode {
  const env = process.env.SCIENCE_AGENT_KE_ENTITY_RESOLUTION?.trim().toLowerCase();
  if (env === "off" || env === "shadow" || env === "on") return env;
  if (store) {
    const stored = store.getSetting("entity_resolution_mode")?.trim().toLowerCase();
    if (stored === "off" || stored === "shadow" || stored === "on") return stored;
  }
  return "off";
}

/** KeEntityRow → the resolver's entity shape (normalized names throughout). */
export function toResolverEntity(entity: KeEntityRow): ResolverEntity {
  return {
    id: entity.id,
    canonicalName: entity.normalizedName,
    aliases: entity.aliases.map((alias) => normalizeEntityName(alias)),
    entityType: entity.type,
    definition: entity.description,
    supportCount: entity.supportCount,
    trustLevel: entity.trustLevel,
    createdAt: entity.createdAt,
  };
}

/** Store-backed resolver repo (L0 exact / L1 alias / L3 cosine / L3.5 trgm). */
export function buildResolverRepo(store: KnowledgeEngineStore): ResolverRepo {
  return {
    getByName: async (kbId, name) => {
      const hit = store.findEntityByName(kbId, normalizeEntityName(name));
      return hit ? toResolverEntity(hit) : undefined;
    },
    findByAlias: async (kbId, alias) => {
      const hit = store.findEntityByAlias(kbId, normalizeEntityName(alias));
      return hit ? toResolverEntity(hit) : undefined;
    },
    nearestByEmbedding: async (kbId, vec, limit) =>
      store.nearestEntitiesByEmbedding(kbId, vec, limit).map((hit) => ({ ...toResolverEntity(hit), cosine: hit.cosine })),
    similarByName: async (kbId, name, minSim, limit) =>
      store.similarEntitiesByName(kbId, name, minSim, limit).map((hit) => ({ ...toResolverEntity(hit), sim: hit.sim })),
  };
}

/**
 * Audit row for a write-time (online) resolution. Online resolution never
 * deletes a node: the extraction candidate was never persisted, so there is
 * no absorbed row to snapshot — the audit records the attach decision itself
 * with a synthetic absorbed id. Shadow-mode decisions prefix decidedBy with
 * 'shadow:' so evaluation can separate them from acting decisions. These
 * rows are NOT unmergeable (undo = remove the alias).
 */
export function recordOnlineAttach(
  store: KnowledgeEngineStore,
  audit: {
    kbId: string;
    targetId: string;
    candidate: { name: string; type: string; definition?: string; aliases?: string[] };
    decidedBy: string;
    score?: number;
    rationale?: string;
    jobId?: string;
  },
): string {
  return store.recordEntityMerge({
    kbId: audit.kbId,
    canonicalId: audit.targetId,
    absorbedId: `candidate:${normalizeKeName(audit.candidate.name)}`,
    snapshot: { onlineAttach: true, candidate: audit.candidate },
    decidedBy: audit.decidedBy,
    ...(audit.score !== undefined ? { score: audit.score } : {}),
    ...(audit.rationale !== undefined ? { rationale: audit.rationale } : {}),
    ...(audit.jobId !== undefined ? { jobId: audit.jobId } : {}),
  });
}
