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

import {
  buildDeterministicL0,
  DEFAULT_INTENT_LABELS,
  documentAnchor,
  monitorConvergence,
  parseDocumentBlocks,
  resolveDocumentAnchor,
  type DocumentBlock,
} from "@sciencediscovery/knowledge-engine";

import type { KeOrchestrator } from "./orchestrator.js";
import { DEFAULT_CRAWL_BUDGET, KE_GROW_JOB, type CrawlBudget } from "./grow.js";
import type { GraphRootsService } from "./graph-roots.js";
import type { KeDocumentRow, KeEdgeRow, KeEntityMergeRow, KeEntityRow, KnowledgeEngineStore } from "./store.js";

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
  const query = typeof body.query === "string" ? body.query.trim() : "";
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

// -------------------------------------------------------------------- grow

function budgetField(value: unknown, fallback: number, min: number, max: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new KeApiError(`budget.${field} must be a finite number`, 400, "KE_INVALID_INPUT");
  }
  return Math.min(Math.max(Math.floor(value), min), max);
}

export async function handleKeStartGrow(
  request: IncomingMessage,
  response: ServerResponse,
  orchestrator: KeOrchestrator,
  store: KnowledgeEngineStore,
  kbId: string,
): Promise<void> {
  requireKb(store, kbId);
  const body = await readJson<{
    query?: string;
    budget?: { maxPapers?: unknown; maxDepth?: unknown; maxPerPaper?: unknown };
  }>(request);
  let budget: CrawlBudget | undefined;
  if (body.budget !== undefined && body.budget !== null) {
    if (typeof body.budget !== "object") {
      throw new KeApiError("budget must be an object", 400, "KE_INVALID_INPUT");
    }
    budget = {
      maxPapers: budgetField(body.budget.maxPapers, DEFAULT_CRAWL_BUDGET.maxPapers, 1, 500, "maxPapers"),
      maxDepth: budgetField(body.budget.maxDepth, DEFAULT_CRAWL_BUDGET.maxDepth, 0, 5, "maxDepth"),
      maxPerPaper: budgetField(body.budget.maxPerPaper, DEFAULT_CRAWL_BUDGET.maxPerPaper, 1, 100, "maxPerPaper"),
    };
  }
  // An empty query falls back to the KB identity inside the cycle.
  const handle = orchestrator.startGrow(kbId, typeof body.query === "string" ? body.query.trim() : "", budget);
  sendJson(response, 202, handle);
}

export function handleKeGetGrow(response: ServerResponse, store: KnowledgeEngineStore, kbId: string): void {
  requireKb(store, kbId);
  const kb = store.getKnowledgeBase(kbId)!;
  const engineState = (kb.engineState ?? {}) as Record<string, unknown>;
  // Query the two active statuses explicitly: an unfiltered listJobs window
  // returns the OLDEST N jobs, so after enough historical cycles the running
  // one would fall outside it and the panel would report "no active cycle".
  const activeJob = [
    ...store.listJobs({ type: KE_GROW_JOB, kbId, status: "running", limit: 5 }),
    ...store.listJobs({ type: KE_GROW_JOB, kbId, status: "pending", limit: 5 }),
  ][0];
  const stateCycleId = typeof engineState["cycleId"] === "string" ? (engineState["cycleId"] as string) : null;
  const cycleId = activeJob ? String(activeJob.payload["cycleId"]) : stateCycleId;
  // Z7 living review: has a converged KB drifted back into growth? Pure
  // computation over the sticky convergedAt latch + entity-creation rate —
  // surfaced for the UI/agent; reopening remains an explicit user action.
  const convergedAt = typeof engineState["convergedAt"] === "string" ? (engineState["convergedAt"] as string) : null;
  const livingReview = monitorConvergence({
    convergedAt,
    newEntities: convergedAt ? store.countEntitiesCreatedSince(kbId, convergedAt) : 0,
  });
  sendJson(response, 200, {
    engineState,
    activeCycle: activeJob
      ? { jobId: activeJob.id, cycleId: String(activeJob.payload["cycleId"]), status: activeJob.status }
      : null,
    frontier: cycleId ? store.frontierCounts(cycleId) : null,
    livingReview,
  });
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

// ------------------------------------------------------- document levels

export type KeDocumentLevel = "L0" | "L1" | "L2";

/** `?level=` — absent means L0 (cheapest projection, the reading default). */
export function parseKeDocumentLevel(raw: string | null): KeDocumentLevel {
  if (raw === null || raw === "") return "L0";
  if (raw === "L0" || raw === "L1" || raw === "L2") return raw;
  throw new KeApiError(`level must be one of L0|L1|L2, got "${raw}"`, 400, "KE_INVALID_INPUT");
}

/** Cross-KB document ids 404 rather than leak — the id alone is not proof
 *  of membership, so kbId scoping is enforced on every document read. */
function requireKbDocument(store: KnowledgeEngineStore, kbId: string, docId: string): KeDocumentRow {
  requireKb(store, kbId);
  const document = store.getDocument(docId);
  if (!document || document.kbId !== kbId) {
    throw new KeApiError(`document ${docId} not found in knowledge base ${kbId}`, 404, "KE_DOCUMENT_NOT_FOUND");
  }
  return document;
}

function anchoredBlock(docId: string, block: DocumentBlock): Record<string, unknown> {
  return {
    anchorId: documentAnchor(docId, block),
    type: block.type,
    text: block.text,
    section: block.section,
    lineStart: block.lineStart,
    preview: block.preview,
  };
}

/**
 * W7 three-level read: L0 = deterministic extractive abstract (summary,
 * tags from section headings, honest `source` label); L1 = anchored blocks
 * compiled on demand from the stored fulltext markdown; L2 = fulltext as
 * stored. Pending documents (no fulltext yet) answer L0/L1 with empty
 * bodies instead of erroring — the UI shows the status pill anyway.
 */
export function handleKeGetDocument(
  response: ServerResponse,
  store: KnowledgeEngineStore,
  kbId: string,
  docId: string,
  level: KeDocumentLevel,
): void {
  const document = requireKbDocument(store, kbId, docId);
  if (level === "L2") {
    sendJson(response, 200, {
      docId: document.id,
      kbId,
      title: document.title,
      level,
      status: document.status,
      abstract: document.abstract ?? null,
      fulltext: document.fulltext ?? "",
    });
    return;
  }
  const blocks = document.fulltext ? parseDocumentBlocks(document.fulltext) : [];
  if (level === "L1") {
    sendJson(response, 200, {
      docId: document.id,
      kbId,
      title: document.title,
      level,
      status: document.status,
      blockCount: blocks.length,
      blocks: blocks.map((block) => anchoredBlock(document.id, block)),
    });
    return;
  }
  const l0 = buildDeterministicL0({ title: document.title, abstract: document.abstract, blocks });
  sendJson(response, 200, {
    docId: document.id,
    kbId,
    title: document.title,
    level: "L0",
    status: document.status,
    year: document.year,
    venue: document.venue,
    abstract: document.abstract ?? null,
    l0: { summary: l0.summary, tags: l0.tags, source: l0.source },
  });
}

/** Evidence click-through: an anchor id resolves to its block plus capped
 *  neighbors — enough for a hover preview and for the reading view to
 *  scroll/highlight. Unknown anchors 404 (KE_ANCHOR_NOT_FOUND). */
export function handleKeGetDocumentAnchor(
  response: ServerResponse,
  store: KnowledgeEngineStore,
  kbId: string,
  docId: string,
  anchorId: string,
): void {
  const document = requireKbDocument(store, kbId, docId);
  if (!document.fulltext) {
    throw new KeApiError(`document ${docId} has no parsed fulltext`, 409, "KE_DOCUMENT_NOT_PARSED");
  }
  const blocks = parseDocumentBlocks(document.fulltext);
  const hit = resolveDocumentAnchor(blocks, anchorId);
  if (!hit) {
    throw new KeApiError(`anchor ${anchorId} not found in document ${docId}`, 404, "KE_ANCHOR_NOT_FOUND");
  }
  sendJson(response, 200, {
    docId: document.id,
    kbId,
    title: document.title,
    anchor: anchoredBlock(document.id, hit.block),
    context: {
      before: hit.before ? anchoredBlock(document.id, hit.before) : null,
      after: hit.after ? anchoredBlock(document.id, hit.after) : null,
    },
  });
}

/** GET /kbs/:kbId/documents/:docId/similar — shared-entity similar docs. */
export function handleKeSimilarDocuments(
  response: ServerResponse,
  store: KnowledgeEngineStore,
  kbId: string,
  docId: string,
): void {
  const document = requireKbDocument(store, kbId, docId);
  sendJson(response, 200, {
    kbId,
    docId: document.id,
    similar: store.similarDocuments(kbId, document.id),
  });
}

// ------------------------------------------------- citations & formulae (W10)

const INTENT_WHITELIST = new Set(DEFAULT_INTENT_LABELS.map((label) => label.name));

/** GET /kbs/:kbId/citations — filter by ?intent= (whitelist-validated),
 *  ?srcDocId= / ?dstDocId= (cross-KB ids 404 like every document read),
 *  ?limit= (1-500, default 200). */
export function handleKeListCitations(
  response: ServerResponse,
  store: KnowledgeEngineStore,
  kbId: string,
  query: URLSearchParams,
): void {
  requireKb(store, kbId);
  const intent = query.get("intent");
  if (intent !== null && intent !== "" && !INTENT_WHITELIST.has(intent)) {
    throw new KeApiError(
      `intent must be one of ${[...INTENT_WHITELIST].join("|")}, got "${intent}"`,
      400,
      "KE_INVALID_INPUT",
    );
  }
  for (const [param, value] of [["srcDocId", query.get("srcDocId")], ["dstDocId", query.get("dstDocId")]] as const) {
    if (value) requireKbDocument(store, kbId, value);
  }
  const limitRaw = query.get("limit");
  const limit = limitRaw === null || limitRaw === "" ? 200 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new KeApiError(`limit must be an integer 1-500, got "${limitRaw}"`, 400, "KE_INVALID_INPUT");
  }
  const citations = store.listCitations(kbId, {
    ...(intent ? { intent } : {}),
    ...(query.get("srcDocId") ? { srcDocId: query.get("srcDocId")! } : {}),
    ...(query.get("dstDocId") ? { dstDocId: query.get("dstDocId")! } : {}),
    limit,
  });
  sendJson(response, 200, {
    kbId,
    citations: citations.map((row) => ({
      id: row.id,
      srcDocId: row.srcDocId,
      srcTitle: row.srcTitle,
      dstDocId: row.dstDocId,
      dstTitle: row.dstTitle,
      dstKey: row.dstKey,
      sentence: row.sentence,
      section: row.section,
      intent: row.intent,
      confidence: row.confidence,
    })),
  });
}

/** GET /kbs/:kbId/formulae — filter by ?docId= (404 on cross-KB) and
 *  ?q= (LaTeX/label substring); ?limit= (1-300, default 100). */
export function handleKeListFormulae(
  response: ServerResponse,
  store: KnowledgeEngineStore,
  kbId: string,
  query: URLSearchParams,
): void {
  requireKb(store, kbId);
  const docId = query.get("docId");
  if (docId) requireKbDocument(store, kbId, docId);
  const limitRaw = query.get("limit");
  const limit = limitRaw === null || limitRaw === "" ? 100 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 300) {
    throw new KeApiError(`limit must be an integer 1-300, got "${limitRaw}"`, 400, "KE_INVALID_INPUT");
  }
  const formulae = store.listFormulae(kbId, {
    ...(docId ? { docId } : {}),
    ...(query.get("q") ? { q: query.get("q")! } : {}),
    limit,
  });
  sendJson(response, 200, {
    kbId,
    formulae: formulae.map((row) => ({
      id: row.id,
      docId: row.docId,
      docTitle: row.docTitle,
      latex: row.latex,
      displayLatex: row.displayLatex,
      context: row.context,
      label: row.label,
    })),
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

// ---------------------------------------------------------------- resolution

/** Enqueue a batch entity-resolution run (dedup per KB; the job itself
 *  no-ops with a 'skipped' note when the resolution mode switch is off). */
export function handleKeStartResolution(
  response: ServerResponse,
  orchestrator: KeOrchestrator,
  store: KnowledgeEngineStore,
  kbId: string,
): void {
  requireKb(store, kbId);
  sendJson(response, 202, orchestrator.startResolution(kbId));
}

function leanMerge(merge: KeEntityMergeRow): Record<string, unknown> {
  const snapshot = merge.absorbedSnapshot;
  // absorbed name for display: physical merges snapshot the absorbed row,
  // online attaches/shadow previews carry the candidate/absorbedName.
  const absorbedName =
    (snapshot["absorbed"] as { name?: string } | undefined)?.name ??
    (snapshot["candidate"] as { name?: string } | undefined)?.name ??
    (snapshot["absorbedName"] as string | undefined) ??
    null;
  return {
    id: merge.id,
    canonicalId: merge.canonicalId,
    absorbedId: merge.absorbedId,
    absorbedName,
    decidedBy: merge.decidedBy,
    score: merge.score,
    judgeRationale: merge.judgeRationale,
    jobId: merge.jobId,
    undoneAt: merge.undoneAt,
    createdAt: merge.createdAt,
  };
}

export function handleKeListMerges(response: ServerResponse, store: KnowledgeEngineStore, kbId: string): void {
  requireKb(store, kbId);
  sendJson(response, 200, { merges: store.listEntityMerges(kbId).map(leanMerge) });
}

/** Roll back a physical merge from its snapshot (best-effort; online-attach
 *  audit rows are not unmergeable). */
export function handleKeUnmerge(response: ServerResponse, store: KnowledgeEngineStore, mergeId: string): void {
  try {
    store.unmergeEntity(mergeId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not found")) throw new KeApiError(message, 404, "KE_MERGE_NOT_FOUND");
    if (message.includes("already undone")) throw new KeApiError(message, 409, "KE_MERGE_ALREADY_UNDONE");
    if (message.includes("online attach")) throw new KeApiError(message, 400, "KE_MERGE_NOT_UNMERGEABLE");
    throw error;
  }
  sendJson(response, 200, { unmerged: mergeId });
}

// --------------------------------------------------------------- graph roots

export async function handleKeGetGraphRoots(
  response: ServerResponse,
  rootsService: GraphRootsService,
  store: KnowledgeEngineStore,
  kbId: string,
): Promise<void> {
  requireKb(store, kbId);
  sendJson(response, 200, await rootsService.getGraphRoots(kbId));
}
