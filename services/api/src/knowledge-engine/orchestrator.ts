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
  applyIntentResults,
  buildExtractionPrompt,
  buildIntentPrompt,
  buildJudgePrompt,
  documentAnchor,
  embeddingToBlob,
  extractAbbrevPairs,
  extractCitationContexts,
  extractFormulas,
  buildExtractionCorrectionPrompt,
  MAX_INTENT_PER_DOC,
  parseIntentResponse,
  parseJudgeVerdict,
  parseDocumentBlocks,
  parseReferenceEntries,
  resolveCitedDocuments,
  validateExtractionProposal,
  type ValidatedProposal,
  resolveEntityCandidate,
  DEFAULT_RESOLVER_THRESHOLDS,
  HAYSTACK_CAP,
  jatsToMarkdown,
  texToMarkdown,
  type EntityResolutionMode,
  type ExtractionSchema,
  type JudgeSide,
  type JudgeVerdict,
} from "@sciencediscovery/knowledge-engine";
import type { ModelEndpoint } from "@sciencediscovery/model";

import type { PdfClassification } from "./pdf-classify.js";
import type { EmbeddingClient } from "./embedding.js";
import { callPipelineLlm, type PipelineInvoke } from "./llm.js";
import { buildResolverRepo, recordOnlineAttach, resolveEntityResolutionMode } from "./resolution.js";
import {
  enqueueEntityResolution,
  runEntityResolution,
  KE_ENTITY_RESOLUTION_JOB,
} from "./resolution-runner.js";
import type { KeDocumentRow, KeJobRow, KnowledgeEngineStore } from "./store.js";
import { normalizeEntityName } from "./store.js";
import type { SourceChain } from "./connectors/source-chain.js";
import { downloadPaperPdf } from "./connectors/source-chain.js";
import { downloadArxivEprint } from "./connectors/eprint.js";
import type { ScholarlyTransport } from "./connectors/transport.js";
import {
  NotFoundError,
  paperDedupKey,
  RateLimitError,
  type PaperConnector,
  type PaperRef,
} from "./connectors/types.js";
import {
  runGrowCycle,
  startGrowCycle,
  type CrawlBudget,
  type GrowCycleHandle,
  type GrowDeps,
  KE_GROW_JOB,
} from "./grow.js";

export const KE_SEED_JOB = "ke_seed";
export const KE_INGEST_JOB = "ke_ingest";
export const KE_EXTRACT_JOB = "ke_extract";
export { KE_GROW_JOB, KE_ENTITY_RESOLUTION_JOB };
export type { CrawlBudget, GrowCycleHandle, GrowDeps };

const CORE_ENTITY_LIST_SIZE = 50;
const MIN_EXTRACTABLE_TEXT = 200;
/** C3①: total LLM rounds per extraction — one initial + bounded corrective
 *  retries feeding validator rejection reasons back to the model. */
const MAX_EXTRACT_ATTEMPTS = 3;
/** Correction feedback stand-in when attempt 1 produced an EMPTY (but
 *  structurally valid) proposal — zero entities is retryable, not final. */
const EMPTY_PROPOSAL_VALIDATION: ValidatedProposal = {
  entities: [],
  relations: [],
  rejects: [{
    section: "response",
    index: 0,
    reason: "the proposal contained no entities and no relations",
    excerpt: "",
  }],
  parseError: null,
};

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
  /** PDF → text port. V1-Z3: may return the extract's classification
   *  alongside the text — it is persisted into the document's sourceMeta. */
  readonly paperText?: (pdfBytes: Uint8Array, docId: string) =>
    Promise<string | { fulltext: string; pdfClassification?: PdfClassification }>;
  /** SSRF guard for downloads (fixture environments pass a no-op). */
  readonly assertUrl?: (url: string) => Promise<void>;
  /** Test seam: override individual grow-cycle dependencies. */
  readonly grow?: Partial<GrowDeps>;
  /** Test seam: override the entity-resolution mode switch (default:
   *  env SCIENCE_AGENT_KE_ENTITY_RESOLUTION → ke_settings → 'off'). */
  readonly resolutionMode?: () => EntityResolutionMode;
  readonly onWarn?: (message: string, detail?: unknown) => void;
}

export interface ExtractionOutcome {
  readonly docId: string;
  readonly entities: number;
  readonly edges: number;
  readonly droppedUnverifiable: number;
  readonly skipped?: string;
  /** C3①: proposal items the validator rejected after corrective retries. */
  readonly rejectedProposals?: number;
  /** C3①: LLM rounds actually used (1..MAX_EXTRACT_ATTEMPTS). */
  readonly attempts?: number;
}

export class KeOrchestrator {
  constructor(private readonly deps: KeOrchestratorDeps) {}

  registerJobs(runner: { register(type: string, handler: (job: KeJobRow, signal: AbortSignal) => Promise<unknown>): void }): void {
    runner.register(KE_SEED_JOB, (job, signal) => this.handleSeed(job, signal));
    runner.register(KE_INGEST_JOB, (job, signal) => this.handleIngest(job, signal));
    runner.register(KE_EXTRACT_JOB, (job, signal) => this.handleExtract(job, signal));
    runner.register(KE_GROW_JOB, (job) => this.handleGrow(job));
    runner.register(KE_ENTITY_RESOLUTION_JOB, (job, signal) =>
      runEntityResolution(
        {
          store: this.deps.store,
          ...(this.deps.resolveEndpoint ? { resolveEndpoint: this.deps.resolveEndpoint } : {}),
          ...(this.deps.llmInvoke ? { llmInvoke: this.deps.llmInvoke } : {}),
          ...(this.deps.embedding ? { embedding: this.deps.embedding } : {}),
          ...(this.deps.resolutionMode ? { mode: this.deps.resolutionMode } : {}),
          ...(this.deps.onWarn ? { onWarn: this.deps.onWarn } : {}),
        },
        job,
        signal,
      ),
    );
  }

  /** Public API: enqueue a batch entity-resolution run (dedup per KB). */
  startResolution(kbId: string): { jobId: string; enqueued: boolean } {
    return enqueueEntityResolution(this.deps.store, kbId);
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

  /** Public API: start a growth cycle (at most one active cycle per KB). */
  startGrow(kbId: string, query: string, budget?: CrawlBudget): GrowCycleHandle {
    return startGrowCycle(this.deps.store, kbId, query, budget);
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
    try {
      await this.performIngest(doc, signal);
    } catch (error) {
      // NotFound is definitive (no full text anywhere): performIngest already
      // marked the doc — the job completes without burning retries.
      if (error instanceof NotFoundError) return;
      throw error;
    }
  }

  /**
   * Download + ingest one document: JATS full text when EuropePMC has it
   * (structured, parse-free), else PDF through the source chain → paper
   * worker. Shared by the ingest job handler and the grow cycle's download
   * dependency. On a definitive NotFound the document is marked 'error' and
   * the error RETHROWN — callers decide whether that ends the work item
   * (ingest job: yes; grow frontier item: marked failed, crawl continues).
   */
  private async performIngest(doc: KeDocumentRow, _signal?: AbortSignal): Promise<void> {
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
        this.warn("ke_ingest_jats_failed", { docId: doc.id, error: errorMessage(error) });
      }
    }

    // Path 1.5 (LaTeX-first, Z5): arXiv e-print source when the ref carries
    // an arXiv id — formulas and \cite anchors survive verbatim (the W10
    // chain's best input), no python worker round-trip. Fail-soft per mirror;
    // unusable/absent sources fall through to the PDF path.
    if (ref?.arxivId && this.deps.transport) {
      try {
        const tex = await downloadArxivEprint(ref.arxivId, this.deps.transport);
        if (tex) {
          const markdown = texToMarkdown(tex);
          if (markdown.length >= MIN_EXTRACTABLE_TEXT) {
            this.deps.store.upsertDocument({
              kbId: doc.kbId,
              dedupKey: doc.dedupKey,
              fulltext: markdown,
              status: "ready",
              sourceMeta: {
                ...doc.sourceMeta,
                ingested_at: new Date().toISOString(),
                ingest_channel: "arxiv-latex",
              },
            });
            this.enqueueExtraction(doc.kbId, doc.id);
            return;
          }
          this.warn("ke_ingest_latex_too_short", { docId: doc.id, chars: markdown.length });
        }
      } catch (error) {
        if (error instanceof RateLimitError) throw error; // 429 carries Retry-After
        this.warn("ke_ingest_latex_failed", { docId: doc.id, error: errorMessage(error) });
      }
    }

    // Path 2: PDF through the source chain → paper worker.
    if (!ref) throw new Error(`document ${doc.id} has no paperRef to ingest from`);
    if (!this.deps.paperText) throw new Error("PDF ingestion is not configured (paperText hook missing)");
    let outcome;
    try {
      outcome = await downloadPaperPdf(this.deps.chain.connectors, ref, {
        transport: this.deps.transport,
        assertUrl: this.deps.assertUrl,
      }, (message) => this.warn(message));
    } catch (error) {
      if (error instanceof NotFoundError) {
        // Definitive: no full text anywhere — mark the doc and rethrow so the
        // caller's work item closes without retrying.
        this.deps.store.upsertDocument({
          kbId: doc.kbId,
          dedupKey: doc.dedupKey,
          status: "error",
          sourceMeta: { ...doc.sourceMeta, ingest_error: error.message },
        });
      }
      throw error;
    }
    const paperResult = await this.deps.paperText(outcome.bytes, doc.id);
    const text = typeof paperResult === "string" ? paperResult : paperResult.fulltext;
    const pdfClassification = typeof paperResult === "string" ? undefined : paperResult.pdfClassification;
    if (text.trim().length < MIN_EXTRACTABLE_TEXT) {
      throw new Error(`paper worker produced too little text (${text.trim().length} chars) for ${doc.id}`);
    }
    this.deps.store.upsertDocument({
      kbId: doc.kbId,
      dedupKey: doc.dedupKey,
      fulltext: text,
      status: "ready",
      sourceMeta: {
        ...doc.sourceMeta,
        ingested_at: new Date().toISOString(),
        ingest_channel: `pdf:${outcome.source}`,
        // V1-Z3: scanned / table-heavy / formula-heavy routing hints.
        ...(pdfClassification
          ? { pdf_class: pdfClassification.type, pdf_class_confidence: pdfClassification.confidence }
          : {}),
      },
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

  // ------------------------------------------------------------------ grow

  private async handleGrow(job: KeJobRow): Promise<unknown> {
    return runGrowCycle(this.deps.store, job, this.buildGrowDeps(), (message) => this.warn("ke_grow", { message }));
  }

  /**
   * Assemble the grow cycle's dependencies. Metadata resolution goes through
   * a connector sub-chain (the citation-capable sources — Semantic Scholar
   * and OpenAlex, matching the DeepAnalyze resolver set): a rate limit is
   * PER SOURCE, so throttling at one upstream falls through to the next and
   * only backs off the whole cycle when every capable source is throttled.
   */
  private buildGrowDeps(): GrowDeps {
    const resolvers = this.deps.chain.connectors.filter(
      (connector) => connector.resolveCitations || connector.resolveCitingPapers,
    );
    const callChain = async (
      capability: "resolveCitations" | "resolveCitingPapers" | "search",
      invoke: (connector: PaperConnector) => Promise<PaperRef[] | undefined>,
    ): Promise<PaperRef[]> => {
      let lastRateLimit: RateLimitError | null = null;
      for (const connector of resolvers) {
        if (!connector[capability]) continue;
        try {
          const refs = await invoke(connector);
          if (refs && refs.length > 0) return refs;
        } catch (error) {
          if (error instanceof RateLimitError) {
            lastRateLimit = error;
            continue;
          }
          this.warn("ke_grow_resolver_failed", { capability, source: connector.name, error: errorMessage(error) });
        }
      }
      if (lastRateLimit) throw lastRateLimit;
      return [];
    };
    const defaults: GrowDeps = {
      download: (kbId, ref) => this.downloadForGrow(kbId, ref),
      resolveCitations: (ref) => callChain("resolveCitations", (connector) => connector.resolveCitations!(ref)),
      resolveForward: (ref) => callChain("resolveCitingPapers", (connector) => connector.resolveCitingPapers!(ref)),
      searchPapers: (query, limit) => callChain("search", (connector) => connector.search(query, limit)),
      embed: async (text) => {
        if (!this.deps.embedding) return null;
        try {
          return await this.deps.embedding.embedOne(text);
        } catch (error) {
          this.warn("ke_grow_embedding_failed", { error: errorMessage(error) });
          return null;
        }
      },
    };
    return { ...defaults, ...this.deps.grow };
  }

  /**
   * Grow-cycle download: find-or-create the document (metadata-only refresh
   * for existing ones — never touch status/sourceMeta watermarks), then run
   * the shared ingest pipeline. Idempotent: an already-ingested document
   * returns immediately (topping up extraction if that watermark is missing).
   * NotFoundError propagates so the grow loop marks the frontier item failed.
   */
  private async downloadForGrow(kbId: string, ref: PaperRef): Promise<{ documentId: string }> {
    const dedupKey = paperDedupKey(ref);
    const existing = this.deps.store.findDocumentByDedupKey(kbId, dedupKey);
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
            // Backfill the paperRef when the doc predates it — performIngest
            // reads the ref exclusively from sourceMeta, and the caller holds
            // a valid one right here.
            sourceMeta: existing.sourceMeta["paperRef"]
              ? existing.sourceMeta
              : { ...existing.sourceMeta, paperRef: ref as unknown as Record<string, unknown> },
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
    if (doc.sourceMeta["ingested_at"] || (doc.status === "ready" && doc.fulltext)) {
      if (!doc.sourceMeta["extracted_at"]) {
        this.enqueueExtraction(kbId, doc.id);
      }
      return { documentId: doc.id };
    }
    await this.performIngest(doc);
    return { documentId: doc.id };
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

    // C3① proposal-validation gate: the model output is always a PROPOSAL —
    // deterministic validation judges it, bounded corrective retries feed
    // the rejection reasons back, and only then is anything written.
    // The BEST attempt survives (most valid entities+relations), so a good
    // partial extraction cannot be discarded by a worse retry. Final-state
    // rejects are preserved as evidence below.
    let best: ReturnType<typeof validateExtractionProposal> | null = null;
    let bestScore = -1;
    let attemptsUsed = 0;
    for (let attempt = 1; attempt <= MAX_EXTRACT_ATTEMPTS; attempt += 1) {
      attemptsUsed = attempt;
      const feedback = attempt === 1
        ? ""
        : `\n\n---\nCORRECTION FEEDBACK (attempt ${attempt} of ${MAX_EXTRACT_ATTEMPTS}):\n` +
          `${buildExtractionCorrectionPrompt(best ?? EMPTY_PROPOSAL_VALIDATION, this.deps.schema)}\n\nRe-emit the complete corrected JSON.`;
      const response = await callPipelineLlm(
        { endpoint, ...(this.deps.llmInvoke ? { invoke: this.deps.llmInvoke } : {}) },
        EXTRACTION_SYSTEM_PROMPT,
        `${prompt}${feedback}`,
        signal,
      );
      const validation = validateExtractionProposal(response, this.deps.schema);
      const score = validation.entities.length + validation.relations.length;
      if (score > bestScore) {
        best = validation;
        bestScore = score;
      }
      const usable = validation.parseError === null && validation.rejects.length === 0 && score > 0;
      if (usable) break;
      this.warn("ke_extract_proposal_rejected", {
        docId,
        attempt,
        rejects: validation.rejects.length,
        parseError: validation.parseError,
        empty: score === 0,
      });
    }
    const validation = best!;
    const { entities, relations } = validation;
    if (entities.length === 0) {
      throw new Error(`extraction model response contained no valid entities after ${attemptsUsed} attempts`);
    }
    // Failures stay evidence (OpenDDE lineage): record final-state rejects —
    // fail-soft, a recording outage never fails the extraction job.
    let rejectedProposals = 0;
    if (validation.parseError !== null || validation.rejects.length > 0) {
      try {
        rejectedProposals = this.deps.store.recordProposalRejects(
          doc.kbId,
          doc.id,
          validation.rejects,
          { jobId: job.id, attempts: attemptsUsed },
        );
      } catch (error) {
        this.warn("ke_extract_rejects_record_failed", { docId, error: errorMessage(error) });
      }
    }

    // Deterministic provenance gate: unverifiable relations never reach the graph.
    const gate = applyProvenanceGate(relations, haystack);

    // Online entity resolution (opt-in): decide merge vs new BEFORE writing.
    // off → the upsert path below is byte-identical to pre-resolution
    // behavior; shadow → decide + audit but write unchanged; on → merge
    // decisions attach onto the existing entity (aliases + support).
    const resolutionMode = (this.deps.resolutionMode ?? (() => resolveEntityResolutionMode(this.deps.store)))();
    const resolverRepo = resolutionMode === "off" ? null : buildResolverRepo(this.deps.store);
    const thresholds = DEFAULT_RESOLVER_THRESHOLDS;
    const abbrevMap = resolverRepo ? extractAbbrevPairs(fulltext) : undefined;
    const judgeBudget = { judgeLeft: thresholds.maxJudgePerDoc };
    // Per-document embedding cache: the resolver may embed several candidates.
    const embedCache = new Map<string, Float32Array | number[] | null>();
    const embedFn =
      resolverRepo && this.deps.embedding
        ? async (text: string): Promise<Float32Array | number[] | null> => {
            if (!embedCache.has(text)) {
              try {
                const vectors = await this.deps.embedding!.embed([text]);
                embedCache.set(text, vectors[0] ?? null);
              } catch {
                embedCache.set(text, null); // embedding outage → L3 skips
              }
            }
            return embedCache.get(text) ?? null;
          }
        : undefined;
    const judgeFn = resolverRepo
      ? async (a: JudgeSide, b: JudgeSide): Promise<JudgeVerdict> => {
          const text = await callPipelineLlm(
            { endpoint, ...(this.deps.llmInvoke ? { invoke: this.deps.llmInvoke } : {}) },
            JUDGE_SYSTEM_PROMPT,
            buildJudgePrompt(a, b),
            signal,
          );
          return parseJudgeVerdict(text) ?? { verdict: "unrelated", reason: "unparseable judge response" };
        }
      : undefined;

    // Pre-batch ALL candidate embeddings in one call (DA parity: a single
    // up-front batch instead of N lazy per-candidate HTTP calls inside the
    // resolver loop). Fail-open: an outage leaves the cache empty and L3
    // skips per candidate.
    if (resolverRepo && this.deps.embedding) {
      try {
        const names = [...new Set(entities.map((entity) => entity.name))];
        const vectors = await this.deps.embedding.embed(names);
        names.forEach((name, index) => embedCache.set(name, vectors[index] ?? null));
      } catch {
        // embedding outage → L3 skipped for the whole document
      }
    }

    // Entities first (edges reference ids). Dedup within the response:
    // support counts distinct documents, not repeated mentions.
    const seenNames = new Set<string>();
    const nameToId = new Map<string, string>();
    const writtenIds: string[] = [];
    // Two candidates from the SAME document resolving to the same target
    // attach once for support (distinct-doc invariant), always for aliases.
    const attachedThisDoc = new Set<string>();
    for (const entity of entities) {
      const normalized = normalizeEntityName(entity.name);
      if (seenNames.has(normalized)) continue;
      seenNames.add(normalized);

      let stored;
      let resolvedMerge: { targetId: string; via: string; score?: number; rationale?: string } | null = null;
      // The whole decide+attach block is fail-open (DA parity): any resolver
      // or attach failure falls back to the plain upsert — a resolver outage
      // can only miss merges, never fail the extraction job.
      try {
        if (resolverRepo) {
          const decision = await resolveEntityCandidate(
            resolverRepo,
            doc.kbId,
            {
              name: entity.name,
              type: entity.type,
              ...(entity.definition !== undefined && entity.definition !== null ? { definition: entity.definition } : {}),
              ...(entity.aliases ? { aliases: entity.aliases } : {}),
            },
            {
              ...(abbrevMap ? { abbrevMap } : {}),
              thresholds,
              ...(embedFn ? { embed: embedFn } : {}),
              ...(judgeFn ? { judge: judgeFn } : {}),
              budget: judgeBudget,
            },
          );
          if (decision.action === "merge" && decision.targetId) {
            resolvedMerge = {
              targetId: decision.targetId,
              via: decision.via,
              ...(decision.score !== undefined ? { score: decision.score } : {}),
              ...(decision.rationale !== undefined ? { rationale: decision.rationale } : {}),
            };
          }
        }

        if (resolvedMerge && resolutionMode === "on") {
          stored = this.deps.store.attachToEntity(resolvedMerge.targetId, {
            name: entity.name,
            aliases: entity.aliases ?? [],
            description: entity.definition ?? null,
            docId: doc.id,
            incrementSupport: !attachedThisDoc.has(resolvedMerge.targetId),
          });
          recordOnlineAttach(this.deps.store, {
            kbId: doc.kbId,
            targetId: resolvedMerge.targetId,
            candidate: {
              name: entity.name,
              type: entity.type,
              ...(entity.definition !== undefined && entity.definition !== null ? { definition: entity.definition } : {}),
              ...(entity.aliases ? { aliases: entity.aliases } : {}),
            },
            decidedBy: resolvedMerge.via,
            ...(resolvedMerge.score !== undefined ? { score: resolvedMerge.score } : {}),
            ...(resolvedMerge.rationale !== undefined ? { rationale: resolvedMerge.rationale } : {}),
            jobId: job.id,
          });
        } else {
          if (resolvedMerge && resolutionMode === "shadow") {
            // Audit-only: the decision is recorded, the write path is unchanged.
            recordOnlineAttach(this.deps.store, {
              kbId: doc.kbId,
              targetId: resolvedMerge.targetId,
              candidate: {
                name: entity.name,
                type: entity.type,
                ...(entity.definition !== undefined && entity.definition !== null ? { definition: entity.definition } : {}),
                ...(entity.aliases ? { aliases: entity.aliases } : {}),
              },
              decidedBy: `shadow:${resolvedMerge.via}`,
              ...(resolvedMerge.score !== undefined ? { score: resolvedMerge.score } : {}),
              ...(resolvedMerge.rationale !== undefined ? { rationale: resolvedMerge.rationale } : {}),
              jobId: job.id,
            });
          }
          stored = this.deps.store.upsertEntity({
            kbId: doc.kbId,
            name: entity.name,
            type: entity.type,
            description: entity.definition ?? null,
            aliases: entity.aliases ?? [],
            firstSeenDoc: doc.id,
          });
        }
      } catch (error) {
        this.warn("ke_resolution_attach_failed", {
          docId: doc.id,
          entity: entity.name,
          error: error instanceof Error ? error.message : String(error),
        });
        stored = this.deps.store.upsertEntity({
          kbId: doc.kbId,
          name: entity.name,
          type: entity.type,
          description: entity.definition ?? null,
          aliases: entity.aliases ?? [],
          firstSeenDoc: doc.id,
        });
      }
      attachedThisDoc.add(stored.id);
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

    // W10 citation chain + formula store (fail-soft: a citation failure never
    // fails the extraction job — the graph is the primary product).
    try {
      await this.deriveCitationsAndFormulae(doc, fulltext, endpoint, signal);
    } catch (error) {
      this.warn("ke_citation_derive_failed", { docId, error: errorMessage(error) });
    }

    // Z8 doc chunks for hybrid retrieval (fail-soft: without chunk vectors
    // kb_search simply stays keyword-only — never a job failure).
    try {
      await this.deriveDocChunks(doc, fulltext);
    } catch (error) {
      this.warn("ke_doc_chunks_failed", { docId, error: errorMessage(error) });
    }

    this.warn("ke_extract_done", { docId, entities: writtenIds.length, edges: edgesWritten, dropped });
    return {
      docId,
      entities: writtenIds.length,
      edges: edgesWritten,
      droppedUnverifiable: dropped,
      rejectedProposals,
      attempts: attemptsUsed,
    };
  }

  /**
   * Z8: persist one chunk row per anchored block (reference blocks excluded)
   * and embed them in a single batch when the embedding client is present.
   * Idempotent per document (delete + insert). An embedding outage leaves
   * the vectors null — kb_search degrades to keyword-only until a later
   * extraction backfills them.
   */
  private async deriveDocChunks(doc: KeDocumentRow, fulltext: string): Promise<void> {
    const blocks = parseDocumentBlocks(fulltext).filter((block) => block.type !== "reference");
    if (blocks.length === 0) return;
    const written = this.deps.store.replaceDocChunks(
      doc.kbId,
      doc.id,
      blocks.map((block) => ({
        anchorId: documentAnchor(doc.id, block),
        blockType: block.type,
        section: block.section,
        text: block.text,
      })),
    );
    if (!this.deps.embedding || written === 0) return;
    try {
      // Embedding models truncate long contexts themselves; slicing keeps
      // the request payload bounded regardless of model limits.
      const texts = blocks.map((block) => block.text.slice(0, 2_000));
      const vectors = await this.deps.embedding.embed(texts);
      const byAnchor = new Map<string, Uint8Array>();
      blocks.forEach((block, index) => {
        const vector = vectors[index];
        if (vector && vector.length > 0) {
          byAnchor.set(documentAnchor(doc.id, block), embeddingToBlob(vector));
        }
      });
      this.deps.store.updateDocChunkEmbeddings(doc.id, byAnchor);
    } catch (error) {
      this.warn("ke_doc_chunk_embed_failed", { docId: doc.id, error: errorMessage(error) });
    }
  }

  /**
   * Derive the W10 citation chain and formula rows from the stored fulltext:
   * extract [@rid] contexts → resolve rids against KB documents via the
   * reference list (surname+year, unambiguous only) → classify intents with
   * the pipeline LLM (batched, fail-soft per batch) → replace the per-doc
   * rows. Formulas are pure extraction (display math). Deterministic except
   * for the intent labels.
   */
  private async deriveCitationsAndFormulae(
    doc: KeDocumentRow,
    fulltext: string,
    endpoint: ModelEndpoint,
    signal: AbortSignal,
  ): Promise<void> {
    const contexts = extractCitationContexts(fulltext);
    if (contexts.length > 0) {
      const references = parseReferenceEntries(fulltext);
      const resolvable = this.deps.store
        .listDocumentsLean(doc.kbId, { status: "ready" })
        .map((row) => ({ docId: row.id, authors: row.authors, year: row.year }));
      const resolved = resolveCitedDocuments(contexts, references, resolvable);

      // Intent classification: one sentence per unique (dstKey, sentence).
      const unique = new Map<string, string>();
      for (const context of contexts) {
        if (!unique.has(context.sentence)) unique.set(context.sentence, context.sentence);
      }
      const sentences = [...unique.keys()].slice(0, MAX_INTENT_PER_DOC);
      const intents = new Map<string, { intent: string | null; confidence: number | null }>();
      if (sentences.length > 0) {
        const results: Array<{ intent: string | null; confidence: number | null }> =
          sentences.map(() => ({ intent: null, confidence: null }));
        const BATCH = 20;
        for (let start = 0; start < sentences.length; start += BATCH) {
          const batch = sentences.slice(start, start + BATCH);
          try {
            const response = await callPipelineLlm(
              { endpoint, ...(this.deps.llmInvoke ? { invoke: this.deps.llmInvoke } : {}) },
              "You are a precise citation-intent classifier.",
              buildIntentPrompt(batch),
              signal,
            );
            applyIntentResults(results, start, batch.length, parseIntentResponse(response));
          } catch {
            // Fail-soft per batch — rows persist with intent=null.
          }
        }
        sentences.forEach((sentence, index) => intents.set(sentence, results[index]!));
      }

      this.deps.store.replaceCitations(
        doc.kbId,
        doc.id,
        contexts.map((context) => {
          const intent = intents.get(context.sentence) ?? { intent: null, confidence: null };
          return {
            kbId: doc.kbId,
            srcDocId: doc.id,
            dstDocId: resolved.get(context.dstKey) ?? null,
            dstKey: context.dstKey,
            sentence: context.sentence,
            section: context.section,
            intent: intent.intent,
            confidence: intent.confidence,
          };
        }),
      );
      this.warn("ke_citations_derived", { docId: doc.id, contexts: contexts.length, resolved: resolved.size });
    }

    const formulas = extractFormulas(fulltext);
    if (formulas.length > 0) {
      this.deps.store.replaceFormulae(
        doc.kbId,
        doc.id,
        formulas.map((formula) => ({
          kbId: doc.kbId,
          docId: doc.id,
          latex: formula.latex,
          displayLatex: formula.displayLatex,
          context: formula.context,
          label: formula.label,
          section: null,
        })),
      );
      this.warn("ke_formulae_derived", { docId: doc.id, formulae: formulas.length });
    }
  }

  private warn(message: string, detail?: unknown): void {
    this.deps.onWarn?.(message, detail);
  }
}

const EXTRACTION_SYSTEM_PROMPT =
  "你是学科知识抽取引擎。只输出用户要求的 JSON，不要输出解释、前言或后记。证据必须逐字来自文档。";

/** The entity-resolution judge gets its OWN system prompt — the extraction
 *  one carries an evidence-quote instruction that does not apply to judging. */
const JUDGE_SYSTEM_PROMPT =
  "你是实体消解裁决器。只输出用户要求的 JSON，不要输出解释、前言或后记。";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
