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
 * Knowledge-engine REST handlers, following the evolution/routes.ts pattern:
 * handlers send their own responses; errors are thrown as KeApiError with a
 * `code` and let the top-level classifier in http/index.ts map them.
 *
 * Graph/document payloads are LEAN by design (spec C10): no fulltext, no
 * embedding blobs — the graph page gets id/name/type/support/community, and
 * details come from the entity endpoint.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { readJson } from "../http/body.js";
import { sendJson } from "../http/response.js";
import { ApiStatusError } from "../runs/index.js";

import type { KeOrchestrator } from "./orchestrator.js";
import type { KeDocumentRow, KeEdgeRow, KeEntityRow, KnowledgeEngineStore } from "./store.js";

/** KE request errors ride the top-level classifier via ApiStatusError
 *  (status + machine-readable code), never fall through to a bare 500. */
export class KeApiError extends ApiStatusError {
  constructor(message: string, statusCode: number, code: string) {
    super(statusCode, message, code);
    this.name = "KeApiError";
  }
}

function requireKb(store: KnowledgeEngineStore, kbId: string): void {
  if (!store.getKnowledgeBase(kbId)) {
    throw new KeApiError(`knowledge base ${kbId} not found`, 404, "KE_KB_NOT_FOUND");
  }
}

// --------------------------------------------------------------------- KBs

export async function handleKeCreateKb(
  request: IncomingMessage,
  response: ServerResponse,
  store: KnowledgeEngineStore,
): Promise<void> {
  const body = await readJson<{ name?: string; description?: string }>(request);
  const name = body.name?.trim();
  if (!name) {
    throw new KeApiError("name is required", 400, "KE_INVALID_INPUT");
  }
  const kb = store.createKnowledgeBase({ name, description: body.description });
  sendJson(response, 201, kb);
}

export function handleKeListKbs(response: ServerResponse, store: KnowledgeEngineStore): void {
  const kbs = store.listKnowledgeBases().map((kb) => ({
    ...kb,
    stats: statsFor(store, kb.id),
  }));
  sendJson(response, 200, { kbs });
}

export function handleKeGetKb(response: ServerResponse, store: KnowledgeEngineStore, kbId: string): void {
  requireKb(store, kbId);
  const kb = store.getKnowledgeBase(kbId)!;
  sendJson(response, 200, { ...kb, stats: statsFor(store, kbId) });
}

function statsFor(store: KnowledgeEngineStore, kbId: string): Record<string, number> {
  return store.countKbStats(kbId);
}

// -------------------------------------------------------------------- seed

export async function handleKeSeed(
  request: IncomingMessage,
  response: ServerResponse,
  orchestrator: KeOrchestrator,
  store: KnowledgeEngineStore,
  kbId: string,
): Promise<void> {
  requireKb(store, kbId);
  const body = await readJson<{ query?: string; maxPapers?: number }>(request);
  const query = body.query?.trim();
  if (!query) {
    throw new KeApiError("query is required", 400, "KE_INVALID_INPUT");
  }
  const maxPapersRaw = body.maxPapers ?? 10;
  if (typeof maxPapersRaw !== "number" || !Number.isFinite(maxPapersRaw)) {
    throw new KeApiError("maxPapers must be a finite number", 400, "KE_INVALID_INPUT");
  }
  const maxPapers = Math.min(Math.max(Math.floor(maxPapersRaw), 1), 25);
  const result = await orchestrator.seedKb(kbId, query, maxPapers);
  sendJson(response, 202, result);
}

// -------------------------------------------------------------- documents

function leanDocument(doc: KeDocumentRow): Record<string, unknown> {
  return {
    id: doc.id,
    kbId: doc.kbId,
    title: doc.title,
    authors: doc.authors,
    year: doc.year,
    venue: doc.venue,
    abstract: doc.abstract,
    status: doc.status,
    sourceUri: doc.sourceUri,
    ingestChannel: doc.sourceMeta["ingest_channel"] ?? null,
    extractedAt: doc.sourceMeta["extracted_at"] ?? null,
    createdAt: doc.createdAt,
  };
}

export function handleKeListDocuments(
  response: ServerResponse,
  store: KnowledgeEngineStore,
  kbId: string,
): void {
  requireKb(store, kbId);
  sendJson(response, 200, {
    documents: store.listDocumentsLean(kbId).map(leanDocument),
  });
}

export function handleKeListJobs(response: ServerResponse, store: KnowledgeEngineStore, kbId: string): void {
  requireKb(store, kbId);
  // Scoped in SQL (payload carries kbId for every KE job type) — never a
  // global LIMIT-then-filter that could truncate a busy KB's active jobs.
  const jobs = store.listJobs({ kbId, limit: 200 });
  sendJson(response, 200, {
    jobs: jobs.map((job) => ({
      id: job.id,
      type: job.type,
      status: job.status,
      attempts: job.attempts,
      error: job.error,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    })),
  });
}

// ------------------------------------------------------------------ graph

function leanEntity(entity: KeEntityRow): Record<string, unknown> {
  return {
    id: entity.id,
    name: entity.name,
    type: entity.type,
    supportCount: entity.supportCount,
    trustLevel: entity.trustLevel,
    communityId: entity.communityId,
  };
}

function leanEdge(edge: KeEdgeRow): Record<string, unknown> {
  return {
    id: edge.id,
    srcId: edge.srcId,
    dstId: edge.dstId,
    type: edge.type,
    supportCount: edge.supportCount,
  };
}

export function handleKeGetGraph(response: ServerResponse, store: KnowledgeEngineStore, kbId: string): void {
  requireKb(store, kbId);
  sendJson(response, 200, {
    entities: store.listEntitiesForGraph(kbId).map(leanEntity),
    edges: store.listEdges(kbId).map(leanEdge),
  });
}

export function handleKeGetEntity(response: ServerResponse, store: KnowledgeEngineStore, entityId: string): void {
  const entity = store.getEntity(entityId);
  if (!entity) {
    throw new KeApiError(`entity ${entityId} not found`, 404, "KE_ENTITY_NOT_FOUND");
  }
  const edges = store.listEdges(entity.kbId, { entityId });
  const neighborIds = new Set<string>();
  for (const edge of edges) {
    neighborIds.add(edge.srcId === entityId ? edge.dstId : edge.srcId);
  }
  const neighbors = [...neighborIds]
    .map((id) => store.getEntity(id))
    .filter((item): item is KeEntityRow => item !== undefined)
    .map(leanEntity);
  const evidence = edges
    .filter((edge) => edge.evidenceDocId)
    .map((edge) => {
      const doc = edge.evidenceDocId ? store.getDocument(edge.evidenceDocId) : undefined;
      return {
        edgeId: edge.id,
        type: edge.type,
        otherId: edge.srcId === entityId ? edge.dstId : edge.srcId,
        quote: edge.evidenceQuote,
        docId: edge.evidenceDocId,
        docTitle: doc?.title ?? null,
      };
    });
  sendJson(response, 200, {
    entity: {
      ...leanEntity(entity),
      description: entity.description,
      aliases: entity.aliases,
      hasEmbedding: entity.embedding !== null,
      firstSeenDoc: entity.firstSeenDoc,
      createdAt: entity.createdAt,
    },
    edges: edges.map((edge) => ({ ...leanEdge(edge), evidenceQuote: edge.evidenceQuote })),
    neighbors,
    evidence,
  });
}
