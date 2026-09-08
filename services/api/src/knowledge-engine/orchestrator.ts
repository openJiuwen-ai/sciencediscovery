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
 * Knowledge-engine ingestion/extraction orchestrator.
 *
 * Three job types (all crash-recoverable through the persistent queue):
 * - ke_seed:    query → chain search → documents upserted → per-doc ingest
 * - ke_ingest:  JATS full text when EuropePMC has it (structured, parse-free),
 *               else PDF through the source chain → paper worker → markdown
 * - ke_extract: single-pass entity/relation extraction with the deterministic
 *               provenance gate, then entity embeddings
 *
 * Idempotency follows the DeepAnalyze discipline: source_meta watermarks
 * (ingested_at / extracted_at) make re-enqueued work a no-op, and entity
 * upserts merge by normalized name so re-runs merge instead of duplicating.
 */

import {
  applyProvenanceGate,
  buildExtractionPrompt,
  embeddingToBlob,
  HAYSTACK_CAP,
  jatsToMarkdown,
  parseExtractionResponse,
  type ExtractionSchema,
} from "@sciencediscovery/knowledge-engine";
import type { ModelEndpoint } from "@sciencediscovery/model";

import type { EmbeddingClient } from "./embedding.js";
import { callPipelineLlm, type PipelineInvoke } from "./llm.js";
import type { KeJobRow, KnowledgeEngineStore } from "./store.js";
import { normalizeEntityName } from "./store.js";
import type { SourceChain } from "./connectors/source-chain.js";
import { downloadPaperPdf } from "./connectors/source-chain.js";
import type { ScholarlyTransport } from "./connectors/transport.js";
import { NotFoundError, paperDedupKey, RateLimitError, type PaperRef } from "./connectors/types.js";

export const KE_SEED_JOB = "ke_seed";
export const KE_INGEST_JOB = "ke_ingest";
export const KE_EXTRACT_JOB = "ke_extract";

const CORE_ENTITY_LIST_SIZE = 50;
const MIN_EXTRACTABLE_TEXT = 200;

export interface KeOrchestratorDeps {
  readonly store: KnowledgeEngineStore;
  readonly chain: SourceChain;
  readonly transport: ScholarlyTransport;
  readonly schema: ExtractionSchema;
  readonly embedding?: EmbeddingClient;
  /** Resolve the pipeline model endpoint (global default task model). When
   *  it returns undefined, extraction jobs fail fast with a clear error. */
  readonly resolveEndpoint?: () => ModelEndpoint | undefined;
  /** Test seam: replace the model transport (defaults to streamModelTurn). */
  readonly llmInvoke?: PipelineInvoke;
  /** PDF bytes → markdown text (paper worker). Required for non-JATS docs. */
  readonly paperText?: (pdfBytes: Uint8Array, docId: string) => Promise<string>;
  /** SSRF guard for downloads (fixture environments pass a no-op). */
  readonly assertUrl?: (url: string) => Promise<void>;
  readonly onWarn?: (message: string, detail?: unknown) => void;
}

export interface ExtractionOutcome {
  readonly docId: string;
  readonly entities: number;
  readonly edges: number;
  readonly droppedUnverifiable: number;
  readonly skipped?: string;
}

export class KeOrchestrator {
  constructor(private readonly deps: KeOrchestratorDeps) {}

  registerJobs(runner: { register(type: string, handler: (job: KeJobRow, signal: AbortSignal) => Promise<unknown>): void }): void {
    runner.register(KE_SEED_JOB, (job, signal) => this.handleSeed(job, signal));
    runner.register(KE_INGEST_JOB, (job, signal) => this.handleIngest(job, signal));
    runner.register(KE_EXTRACT_JOB, (job, signal) => this.handleExtract(job, signal));
  }

  /** Public API: enqueue a seed run (deduplicated per kb+query). */
  async seedKb(kbId: string, query: string, maxPapers: number): Promise<{ jobId: string; enqueued: boolean }> {
    const { job, enqueued } = this.deps.store.enqueueJob({
      type: KE_SEED_JOB,
      payload: { kbId, query, maxPapers },
      dedupKey: `${kbId}|${query.trim().toLowerCase()}`,
      maxAttempts: 2,
    });
    return { jobId: job.id, enqueued };
  }

  // ------------------------------------------------------------------ seed

  private async handleSeed(job: KeJobRow, _signal: AbortSignal): Promise<void> {
    const { kbId, query, maxPapers } = job.payload as { kbId: string; query: string; maxPapers?: number };
    const limit = Math.min(Math.max(maxPapers ?? 10, 1), 25);
    const refs = await this.deps.chain.search(query, limit);
    let ingested = 0;
    for (const ref of refs) {
      const dedupKey = paperDedupKey(ref);
      const existing = this.deps.store.findDocumentByDedupKey(kbId, dedupKey);
      // Metadata refresh must never touch status/sourceMeta of an existing
      // document — resetting those would wipe the ingested_at/extracted_at
      // watermarks and re-run the whole pipeline, inflating support counts.
      const doc = this.deps.store.upsertDocument(
        existing
          ? {
              kbId,
              dedupKey,
              title: ref.title,
              authors: ref.authors,
              year: ref.year,
              venue: ref.venue ?? null,
              abstract: ref.abstract,
            }
          : {
              kbId,
              dedupKey,
              sourceUri: ref.doi ? `doi:${ref.doi}` : ref.arxivId ? `arxiv:${ref.arxivId}` : `${ref.source}:${ref.sourceId}`,
              title: ref.title,
              authors: ref.authors,
              year: ref.year,
              venue: ref.venue ?? null,
              abstract: ref.abstract,
              status: "pending",
              sourceMeta: { paperRef: ref as unknown as Record<string, unknown> },
            },
      );
      if (doc.status === "ready" || doc.status === "error") {
        // Ready-but-never-extracted (extraction died, or crashed between the
        // ingest upsert and the enqueue): the seed path is the recovery path
        // too — top up an extraction job (deduped, so idempotent).
        if (doc.status === "ready" && !doc.sourceMeta["extracted_at"]) {
          this.enqueueExtraction(kbId, doc.id);
        }
        continue;
      }
      this.deps.store.enqueueJob({
        type: KE_INGEST_JOB,
        payload: { kbId, docId: doc.id },
        dedupKey: `ingest|${doc.id}`,
        maxAttempts: 3,
      });
      ingested += 1;
    }
    if (refs.length === 0) {
      throw new Error(`seed query "${query}" returned no papers from any source`);
    }
    this.warn("ke_seed_done", { kbId, query, papers: refs.length, ingestEnqueued: ingested });
  }

  // ---------------------------------------------------------------- ingest

  private async handleIngest(job: KeJobRow, signal: AbortSignal): Promise<void> {
    const { docId } = job.payload as { docId: string };
    const doc = this.deps.store.getDocument(docId);
    if (!doc) throw new Error(`document ${docId} not found`);
    if (doc.sourceMeta["ingested_at"] || (doc.status === "ready" && doc.fulltext)) {
      // Watermark early-return must still guarantee the extraction handoff:
      // a crash between the ingest upsert and the enqueue (or a dead-lettered
      // extraction) would otherwise strand this document forever.
      if (!doc.sourceMeta["extracted_at"]) {
        this.enqueueExtraction(doc.kbId, doc.id);
      }
      return;
    }
    const ref = doc.sourceMeta["paperRef"] as PaperRef | undefined;

    // Path 1 (preferred): EuropePMC structured JATS full text — parse-free.
    if (ref) {
      try {
        const xml = await this.deps.chain.europepmc.resolveFullTextXml(ref);
        if (xml) {
          const converted = jatsToMarkdown(xml);
          if (converted.markdown.length >= MIN_EXTRACTABLE_TEXT) {
            this.deps.store.upsertDocument({
              kbId: doc.kbId,
              dedupKey: doc.dedupKey,
              title: converted.title ?? doc.title,
              fulltext: converted.markdown,
              status: "ready",
              sourceMeta: {
                ...doc.sourceMeta,
                ingested_at: new Date().toISOString(),
                ingest_channel: "europepmc-jats",
                reference_count: converted.referenceCount,
              },
            });
            this.enqueueExtraction(doc.kbId, doc.id);
            return;
          }
        }
      } catch (error) {
        if (error instanceof RateLimitError) throw error; // 429 carries Retry-After — never degrade it to a warn
        this.warn("ke_ingest_jats_failed", { docId, error: errorMessage(error) });
      }
    }

    // Path 2: PDF through the source chain → paper worker.
    if (!ref) throw new Error(`document ${docId} has no paperRef to ingest from`);
    if (!this.deps.paperText) throw new Error("PDF ingestion is not configured (paperText hook missing)");
    let outcome;
    try {
      outcome = await downloadPaperPdf(this.deps.chain.connectors, ref, {
        transport: this.deps.transport,
        assertUrl: this.deps.assertUrl,
      }, (message) => this.warn(message));
    } catch (error) {
      if (error instanceof NotFoundError) {
        // Definitive: no full text anywhere — mark the doc and STOP retrying.
        this.deps.store.upsertDocument({
          kbId: doc.kbId,
          dedupKey: doc.dedupKey,
          status: "error",
          sourceMeta: { ...doc.sourceMeta, ingest_error: error.message },
        });
        return;
      }
      throw error; // transient — job backoff applies
    }
    const text = await this.deps.paperText(outcome.bytes, doc.id);    if (text.trim().length < MIN_EXTRACTABLE_TEXT) {
      throw new Error(`paper worker produced too little text (${text.trim().length} chars) for ${docId}`);
    }
    this.deps.store.upsertDocument({
      kbId: doc.kbId,
      dedupKey: doc.dedupKey,
      fulltext: text,
      status: "ready",
      sourceMeta: { ...doc.sourceMeta, ingested_at: new Date().toISOString(), ingest_channel: `pdf:${outcome.source}` },
    });
    this.enqueueExtraction(doc.kbId, doc.id);
  }

  private enqueueExtraction(kbId: string, docId: string): void {
    this.deps.store.enqueueJob({
      type: KE_EXTRACT_JOB,
      payload: { kbId, docId },
      dedupKey: `extract|${docId}`,
      maxAttempts: 2,
    });
  }

  // --------------------------------------------------------------- extract

  private async handleExtract(job: KeJobRow, signal: AbortSignal): Promise<ExtractionOutcome> {
    const { docId } = job.payload as { docId: string };
    const doc = this.deps.store.getDocument(docId);
    if (!doc) throw new Error(`document ${docId} not found`);
    if (doc.sourceMeta["extracted_at"]) {
      return { docId, entities: 0, edges: 0, droppedUnverifiable: 0, skipped: "already-extracted" };
    }
    const fulltext = doc.fulltext ?? "";
    if (fulltext.trim().length < MIN_EXTRACTABLE_TEXT) {
      throw new Error(`document ${docId} has no compiled content to extract from`);
    }
    const endpoint = this.deps.resolveEndpoint?.();
    if (!endpoint) {
      throw new Error("no pipeline model configured (set a global default task model)");
    }

    const haystack = fulltext.slice(0, HAYSTACK_CAP);
    const coreLines = this.deps.store
      .listEntities(doc.kbId, { limit: CORE_ENTITY_LIST_SIZE })
      .map((entity) => `${entity.name} (${entity.type})`);
    const prompt = buildExtractionPrompt(fulltext, { schema: this.deps.schema, coreEntityLines: coreLines });

    const response = await callPipelineLlm(
      { endpoint, ...(this.deps.llmInvoke ? { invoke: this.deps.llmInvoke } : {}) },
      EXTRACTION_SYSTEM_PROMPT,
      prompt,
      signal,
    );
    const { entities, relations } = parseExtractionResponse(response, this.deps.schema);
    if (entities.length === 0) {
      throw new Error("extraction model response contained no valid entities");
    }

    // Deterministic provenance gate: unverifiable relations never reach the graph.
    const gate = applyProvenanceGate(relations, haystack);

    // Entities first (edges reference ids). Dedup within the response:
    // support counts distinct documents, not repeated mentions.
    const seenNames = new Set<string>();
    const nameToId = new Map<string, string>();
    const writtenIds: string[] = [];
    for (const entity of entities) {
      const normalized = normalizeEntityName(entity.name);
      if (seenNames.has(normalized)) continue;
      seenNames.add(normalized);
      const stored = this.deps.store.upsertEntity({
        kbId: doc.kbId,
        name: entity.name,
        type: entity.type,
        description: entity.definition ?? null,
        firstSeenDoc: doc.id,
      });
      nameToId.set(normalized, stored.id);
      for (const alias of entity.aliases ?? []) {
        nameToId.set(normalizeEntityName(alias), stored.id);
      }
      writtenIds.push(stored.id);
    }

    let dropped = gate.dropped;
    let edgesWritten = 0;
    for (const relation of gate.verified) {
      const srcId = nameToId.get(normalizeEntityName(relation.source));
      const dstId = nameToId.get(normalizeEntityName(relation.target));
      if (!srcId || !dstId || srcId === dstId) {
        dropped += 1;
        continue;
      }
      this.deps.store.upsertEdge({
        kbId: doc.kbId,
        srcId,
        dstId,
        type: relation.type,
        evidenceQuote: relation.evidence_quote,
        evidenceDocId: doc.id,
      });
      edgesWritten += 1;
    }

    // Entity embeddings (best-effort batch: an embedding outage never blocks
    // extraction — vectors backfill on a later run).
    if (this.deps.embedding) {
      try {
        const targets = this.deps.store
          .listEntities(doc.kbId, { limit: 500 })
          .filter((entity) => entity.embedding === null);
        if (targets.length > 0) {
          const vectors = await this.deps.embedding.embed(targets.map((entity) => entity.name));
          targets.forEach((entity, index) => {
            const vector = vectors[index];
            if (vector && vector.length > 0) {
              this.deps.store.updateEntityEmbedding(entity.id, embeddingToBlob(vector));
            }
          });
        }
      } catch (error) {
        this.warn("ke_extract_embedding_failed", { docId, error: errorMessage(error) });
      }
    }

    // Idempotency watermark.
    const current = this.deps.store.getDocument(docId);
    this.deps.store.upsertDocument({
      kbId: doc.kbId,
      dedupKey: doc.dedupKey,
      sourceMeta: { ...(current?.sourceMeta ?? doc.sourceMeta), extracted_at: new Date().toISOString() },
    });

    this.warn("ke_extract_done", { docId, entities: writtenIds.length, edges: edgesWritten, dropped });
    return { docId, entities: writtenIds.length, edges: edgesWritten, droppedUnverifiable: dropped };
  }

  private warn(message: string, detail?: unknown): void {
    this.deps.onWarn?.(message, detail);
  }
}

const EXTRACTION_SYSTEM_PROMPT =
  "你是学科知识抽取引擎。只输出用户要求的 JSON，不要输出解释、前言或后记。证据必须逐字来自文档。";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
