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
 * Grow cycle — deterministic citation-driven BFS over the literature, ported
 * from the DeepAnalyze grow-runner onto the KE store.
 *
 * One ke_grow job walks a persistent frontier (ke_frontier table):
 *   1. Seed: three discovery phases (backward citations → forward citations
 *      → entity patch queries), each watermarked in ke_settings so a
 *      rate-limit/crash mid-seeding resumes the remaining phases.
 *   2. Loop: pick the next pending candidate (shallowest depth, fewest prior
 *      attempts, highest relevance), download + ingest it, resolve its
 *      citations, score them against the engine query by embedding cosine,
 *      and admit those passing a depth-dependent floor (MMR + AA blend under
 *      selection pressure).
 *   3. Stop: frontier exhausted, paper budget reached, or a doom loop of
 *      consecutive download failures.
 *
 * Everything here is deterministic: the LLM is never involved in crawl
 * decisions. Extraction grows the graph asynchronously via the standard
 * pipeline (ingest enqueues extraction).
 *
 * Crash recovery: the frontier is persistent; a re-claimed job resumes from
 * the next pending item. Re-download is idempotent (dedup_key dedup).
 */

import { randomUUID } from "node:crypto";

import {
  AA_TOP_K,
  HUB_BOOST,
  HUB_MIN_CITERS,
  MMR_LAMBDA,
  RELEVANCE_FLOORS,
  aaCouplingScore,
  assessConvergence,
  blendAaScores,
  buildGrowDirectives,
  buildPatchQueries,
  buildRefInvertedIndex,
  mmrSelect,
  pruneSeeds,
  rankCandidatePool,
  type ConvergenceDataAccess,
  type ConvergenceResult,
  type GrowDirective,
  type RankedCandidate,
} from "@sciencediscovery/knowledge-engine";

import { NotFoundError, RateLimitError, paperDedupKey, type PaperRef } from "./connectors/types.js";
import type { KeJobRow, KnowledgeEngineStore } from "./store.js";

export const KE_GROW_JOB = "ke_grow";

export interface CrawlBudget {
  /** Max papers ingested per cycle (hard stop). */
  readonly maxPapers: number;
  /** Max citation-hops from the papers already in the KB. */
  readonly maxDepth: number;
  /** Max new candidates admitted per processed paper. */
  readonly maxPerPaper: number;
}

export const DEFAULT_CRAWL_BUDGET: CrawlBudget = {
  maxPapers: 50,
  maxDepth: 2,
  maxPerPaper: 25,
};

/** Abort the cycle after this many consecutive download failures. */
const DOOM_LOOP_LIMIT = 10;
/** Per-paper transient-failure retries before the item is marked failed. */
const MAX_ITEM_ATTEMPTS = 3;
/** Seeding resolves citations for at most this many most-recent KB papers. */
const MAX_SEED_DOCS = 25;
/** Forward snowball runs only for the newest few seed docs (cost bound). */
const FORWARD_SEED_DOCS = 10;
/** Forward candidates admitted per seed doc (cost bound). */
const FORWARD_PER_DOC = 20;
/** Patch-query search results admitted per query. */
const PATCH_QUERY_LIMIT = 10;

/** Discovery-path tags recorded in the frontier hit matrix. */
export const SOURCE_BACKWARD = "backward_citation";
export const SOURCE_FORWARD = "forward_citation";
export const SOURCE_ENTITY_QUERY = "entity_query";

/** Seed phases, in execution order; the watermark tracks completed ones. */
const SEED_PHASES = ["backward", "forward", "entity_query"] as const;

// ---------------------------------------------------------------------------
// Cycle creation
// ---------------------------------------------------------------------------

export interface GrowCycleHandle {
  readonly jobId: string;
  readonly cycleId: string;
  /** True when an active cycle was reused instead of creating a new one. */
  readonly reused: boolean;
}

/** Start a growth cycle for a KB. At most one active cycle per KB: retryable
 *  failures stay 'pending' (the runner re-claims them), and the dedup key +
 *  partial unique index on ke_jobs closes the check-then-create race. */
export function startGrowCycle(
  store: KnowledgeEngineStore,
  kbId: string,
  query: string,
  budget: CrawlBudget = DEFAULT_CRAWL_BUDGET,
): GrowCycleHandle {
  const cycleId = randomUUID();
  const { job, enqueued } = store.enqueueJob({
    type: KE_GROW_JOB,
    payload: { kbId, cycleId, query, budget },
    dedupKey: `grow|${kbId}`,
    // Throttle storms are routine (keyless S2 windows), not fatal: with
    // runner-level Retry-After deferral each attempt resumes the same cycle,
    // so the attempt budget must cover a few storm windows.
    maxAttempts: 6,
  });
  return {
    jobId: job.id,
    cycleId: enqueued ? cycleId : String(job.payload["cycleId"] ?? cycleId),
    reused: !enqueued,
  };
}

// ---------------------------------------------------------------------------
// Injectable dependencies (tests substitute fakes)
// ---------------------------------------------------------------------------

export interface GrowDeps {
  /** Download + ingest one candidate (JATS-first, PDF fallback). Throws
   *  NotFoundError when no source definitively has full text (paywalled),
   *  RateLimitError when a source host throttles, anything else transient. */
  readonly download: (kbId: string, ref: PaperRef) => Promise<{ documentId: string }>;
  readonly resolveCitations: (ref: PaperRef) => Promise<PaperRef[]>;
  /** Forward snowball: papers citing the given one. Optional — when absent
   *  the cycle simply skips forward seeding. */
  readonly resolveForward?: (ref: PaperRef) => Promise<PaperRef[]>;
  /** Free-text paper search (entity patch queries). Optional. */
  readonly searchPapers?: (query: string, limit: number) => Promise<PaperRef[]>;
  /** Embed a text; null means "embedding unavailable, score as unknown". */
  readonly embed: (text: string) => Promise<Float32Array | null>;
}

export interface GrowCycleResult {
  readonly cycleId: string;
  readonly counts: { total: number; pending: number; done: number; failed: number; skipped: number };
  readonly converged: boolean;
  readonly signals: ConvergenceResult["signals"];
}

// ---------------------------------------------------------------------------
// Job handler
// ---------------------------------------------------------------------------

/**
 * Per-execution wall-clock a cycle will spend SLEEPING on source throttles
 * before it hands the wait to the job runner. One Retry-After window plus
 * margin: short hiccups are absorbed in-cycle; a real storm is deferred by
 * the runner (the pending requeue frees the serial job-runner's slot and the
 * same cycle resumes via its watermarks). Sleeping longer inside the handler
 * would starve every other KE job — the runner is deliberately serial.
 */
const THROTTLE_WAIT_BUDGET_MS = 90_000;
const DEFAULT_THROTTLE_WAIT_MS = 30_000;
/** Never sleep longer than this in one go, whatever Retry-After claims. */
const MAX_THROTTLE_WAIT_MS = 60_000;

/**
 * Thrown inside a cycle when the shared throttle-wait budget is spent.
 * Carries the offending RateLimitError so the top of the cycle can rethrow
 * THAT — the job runner then requeues with run_after = Retry-After instead
 * of the cycle finalizing on partial work (false convergence) or dying.
 */
class ThrottleBudgetExhaustedError extends Error {
  constructor(readonly cause: RateLimitError) {
    super("throttle wait budget exhausted");
    this.name = "ThrottleBudgetExhaustedError";
  }
}

interface ThrottleState {
  remainingMs: number;
}

/**
 * Hard wall-clock cap for one frontier item's download+parse. The connector
 * layer bounds every individual fetch, but a pathological item (stalling
 * host across mirrors, wedged worker) must never park the serial cycle
 * forever — observed live as a zero-CPU, zero-socket, zero-timer stall that
 * only a process restart cleared. The timeout converts any such invisible
 * hang into an ordinary transient item failure (attempts bump, the crawl
 * moves on). The abandoned inner promise is catch-guarded so a late
 * rejection can never surface as an unhandled rejection.
 */
const ITEM_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

/** The per-item hard cap fired. Distinct type so the loop defers re-picking
 *  the item for the rest of the run (same treatment as a rate-limited one):
 *  a download that hung for five minutes will not succeed on an immediate
 *  in-cycle retry, it would just burn another cap. */
class HardCapTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} exceeded ${ms}ms hard cap`);
    this.name = "HardCapTimeoutError";
  }
}

async function withItemTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  work.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new HardCapTimeoutError(label, ms)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type SleepFn = (ms: number) => Promise<void>;
const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry a resolver call through source throttling: honor Retry-After (clamped)
 * and draw every sleep from the cycle-shared budget. Non-throttle errors pass
 * through untouched; an exhausted budget raises ThrottleBudgetExhaustedError
 * so the cycle can defer to the runner instead of dying.
 *
 * The call itself is raced against a hard cap: every transport fetch is
 * individually bounded, yet a stalled body stream once parked a resolver
 * await forever (zero CPU/sockets/timers — invisible to every watchdog).
 * A serial pipeline must contain NO unbounded await, whoever leaks it.
 */
async function withThrottleBackoff<T>(
  state: ThrottleState,
  call: () => Promise<T>,
  sleep: SleepFn = defaultSleep,
  callTimeoutMs: number = RESOLVER_CALL_TIMEOUT_MS,
): Promise<T> {
  for (;;) {
    try {
      return await withItemTimeout(call(), callTimeoutMs, "resolver call");
    } catch (error) {
      if (!(error instanceof RateLimitError)) throw error;
      const wait = Math.min(Math.max(error.retryAfterMs ?? DEFAULT_THROTTLE_WAIT_MS, 1_000), MAX_THROTTLE_WAIT_MS);
      if (wait > state.remainingMs) throw new ThrottleBudgetExhaustedError(error);
      state.remainingMs -= wait;
      await sleep(wait);
    }
  }
}

/** Hard cap for one resolver call (chain walk included): a handful of
 *  20s-bounded connector calls plus slack. */
const RESOLVER_CALL_TIMEOUT_MS = 180_000;

export interface GrowCycleOptions {
  readonly sleep?: SleepFn;
  readonly throttleWaitBudgetMs?: number;
  /** Test seam: shrink the per-item download hard cap. */
  readonly itemDownloadTimeoutMs?: number;
  /** Test seam: shrink the per-resolver-call hard cap. */
  readonly resolverCallTimeoutMs?: number;
}

export async function runGrowCycle(
  store: KnowledgeEngineStore,
  job: KeJobRow,
  deps: GrowDeps,
  onLog?: (message: string) => void,
  options: GrowCycleOptions = {},
): Promise<GrowCycleResult> {
  const sleep = options.sleep ?? defaultSleep;
  const itemDownloadTimeoutMs = options.itemDownloadTimeoutMs ?? ITEM_DOWNLOAD_TIMEOUT_MS;
  const resolverCallTimeoutMs = options.resolverCallTimeoutMs ?? RESOLVER_CALL_TIMEOUT_MS;
  const throttle: ThrottleState = { remainingMs: options.throttleWaitBudgetMs ?? THROTTLE_WAIT_BUDGET_MS };
  const input = job.payload as { kbId: string; cycleId: string; query?: string; budget?: Partial<CrawlBudget> };
  const kbId = input.kbId;
  const cycleId = input.cycleId;
  const budget: CrawlBudget = { ...DEFAULT_CRAWL_BUDGET, ...(input.budget ?? {}) };
  const log = (msg: string) => onLog?.(`[Grow] ${job.id.slice(0, 8)}: ${msg}`);

  // Engine query: explicit input, else fall back to the KB identity.
  let query = (input.query ?? "").trim();
  if (!query) {
    const kb = store.getKnowledgeBase(kbId);
    query = [kb?.name, kb?.description].filter(Boolean).join(" — ");
  }

  // --- Step 0: seed the frontier. The watermark is created EAGERLY ('[]')
  // before the first phase: a cycle that dies during the backward phase would
  // otherwise look exactly like a pre-watermark legacy cycle (frontier
  // non-empty, no watermark) and silently strand its remaining phases.
  const phaseKey = `grow_seed_phase:${cycleId}`;
  let phaseRaw = store.getSetting(phaseKey);
  const frontierSeeded = store.frontierCounts(cycleId).total > 0;
  if (phaseRaw === null && !frontierSeeded) {
    store.setSetting(phaseKey, JSON.stringify([]));
    phaseRaw = "[]";
  }
  let phaseList: string[] = [];
  try {
    const parsed: unknown = phaseRaw ? JSON.parse(phaseRaw) : [];
    if (Array.isArray(parsed)) phaseList = parsed.filter((p): p is string => typeof p === "string");
  } catch {
    phaseList = [];
  }
  const phasesDone = new Set(phaseList);
  const needsSeed = phaseRaw !== null && SEED_PHASES.some((phase) => !phasesDone.has(phase));
  if (needsSeed) {
    const seeded = await seedFrontier(store, kbId, cycleId, query, budget, deps, phasesDone, phaseKey, log, throttle, sleep, resolverCallTimeoutMs);
    if (seeded > 0) log(`seeded frontier with ${seeded} candidate(s)`);
  }

  // Query embedding is computed lazily on first scoring need. Stays
  // `undefined` while the provider is down so later parents retry (no latch).
  let queryEmb: Float32Array | null | undefined;

  let consecutiveFailures = 0;
  // Items whose download was rate-limited THIS run: they are not re-picked
  // now, so a single stubborn source host can't burn all its attempts in one
  // cycle (attempts ASC ordering would otherwise hand the same item back
  // once fresh items are done). NOTE (faithful port of the reference
  // behavior): deferred items stay 'pending' at cycle end and are NOT
  // carried into the next cycle (frontier rows are cycle-scoped) — a known
  // limitation to revisit in a later wave.
  const deferredRateLimited = new Set<string>();

  for (;;) {
    // Budget hard stop, read from persistent state: done items accumulate
    // across retries and crash recovery, so the cap is per-cycle, not
    // per-execution.
    const countsNow = store.frontierCounts(cycleId);
    if (countsNow.done >= budget.maxPapers) {
      log(`budget exhausted (${budget.maxPapers} papers)`);
      store.frontierSkipRemaining(cycleId);
      break;
    }

    const item = store.frontierNextPending(cycleId, [...deferredRateLimited]);
    if (!item) {
      log("frontier exhausted");
      break;
    }

    const ref = item.paperRef as unknown as PaperRef;

    // --- Download + ingest (idempotent)
    let downloadOk = false;
    let documentId: string | null = null;
    try {
      const outcome = await withItemTimeout(deps.download(kbId, ref), itemDownloadTimeoutMs, "frontier download");
      documentId = outcome.documentId;
      downloadOk = true;
    } catch (error) {
      if (error instanceof NotFoundError) {
        // Definitive "no full text anywhere" — a normal crawl outcome
        // (paywalled papers), not a systemic failure: mark failed but keep
        // it neutral for the doom counter.
        store.frontierMarkStatus(item.id, "failed");
        log(`no full text: ${String(ref.title ?? item.dedupKey).slice(0, 60)}`);
      } else {
        // Transient — INCLUDING download-scoped rate limits: one paper's
        // source host being throttled must not abort the whole cycle (a
        // single stubborn host would starve the frontier forever, since
        // nextPending would hand out the same item every attempt). Treat
        // like a transient failure and defer re-pick to a future cycle;
        // metadata/search rate limits still escalate to whole-cycle
        // backoff via the connector chain.
        const attempts = store.frontierBumpAttempts(item.id);
        // Defer re-pick for the rest of this run on rate limits AND on the
        // download hard cap: a wedged download retried in-cycle would just
        // burn another full cap and starve the remaining frontier.
        if (error instanceof RateLimitError || error instanceof HardCapTimeoutError) deferredRateLimited.add(item.id);
        if (attempts >= MAX_ITEM_ATTEMPTS) store.frontierMarkStatus(item.id, "failed");
        consecutiveFailures += 1;
        const kind = error instanceof RateLimitError
          ? "download rate limited"
          : error instanceof HardCapTimeoutError
            ? "download timed out"
            : "download failed";
        log(`${kind} (${consecutiveFailures} consecutive): ${error instanceof Error ? error.message : error}`);
        if (consecutiveFailures >= DOOM_LOOP_LIMIT) {
          // Systemic failure (network/sources down): persist what we know
          // about the engine state before dying, and close out the frontier.
          store.frontierSkipRemaining(cycleId);
          await finalizeCycle(store, kbId, cycleId, budget, log, query, deps);
          const doomError = new Error(`aborted: ${DOOM_LOOP_LIMIT} consecutive download failures`);
          (doomError as { nonRetryable?: boolean }).nonRetryable = true;
          throw doomError;
        }
      }
    }
    if (downloadOk) consecutiveFailures = 0;

    // --- Citation expansion (metadata-driven; runs even when the download
    // failed — a paywalled paper's references are still valuable).
    // Idempotent via the expanded_at watermark: retries and crash recovery
    // never re-admit the same parent's citations.
    if (!item.expandedAt && item.depth < budget.maxDepth) {
      try {
        const citations = await withThrottleBackoff(throttle, () => deps.resolveCitations(ref), sleep, resolverCallTimeoutMs);
        // Persist this paper's reference dedup keys (ref_ids) so the AA
        // inverted index can score future candidates' bibliographic
        // coupling. Best-effort: a failure here must not block expansion.
        if (downloadOk && documentId) {
          try {
            const doc = store.getDocument(documentId);
            if (doc) {
              store.upsertDocument({ kbId, dedupKey: doc.dedupKey, refIds: [...new Set(citations.map(paperDedupKey))] });
            }
          } catch {
            // refIds are an AA scoring aid only — never block the crawl on them.
          }
        }
        if (queryEmb === undefined && citations.some((citation) => citation.abstract)) {
          const embedding = await deps.embed(query);
          if (embedding) queryEmb = embedding;
        }
        const admitted = await admitCandidates(
          store,
          kbId,
          cycleId,
          item.id,
          item.depth + 1,
          citations,
          queryEmb ?? null,
          budget,
          deps,
          SOURCE_BACKWARD,
        );
        store.frontierMarkExpanded(item.id);
        if (admitted > 0) log(`admitted ${admitted}/${citations.length} candidate(s) at depth ${item.depth + 1}`);
      } catch (error) {
        if (error instanceof ThrottleBudgetExhaustedError) {
          // Hand the wait to the job runner: it requeues with run_after =
          // Retry-After (slot freed for other KE work), and the SAME cycle
          // resumes here on the next attempt — this item stays pending and
          // the phase watermarks/frontier rows are cycle-scoped state.
          throw error.cause;
        }
        log(`citation expansion failed: ${error instanceof Error ? error.message : error}`);
      }
    }

    if (downloadOk) store.frontierMarkStatus(item.id, "done");
  }

  return finalizeCycle(store, kbId, cycleId, budget, log, query, deps);
}

/** Convergence assessment + engine-state persistence at end of cycle. */
async function finalizeCycle(
  store: KnowledgeEngineStore,
  kbId: string,
  cycleId: string,
  budget: CrawlBudget,
  log: (msg: string) => void,
  query: string,
  deps: GrowDeps,
): Promise<GrowCycleResult> {
  const counts = store.frontierCounts(cycleId);
  const data = convergenceDataAccess(store);
  const convergence = await assessConvergence(data, kbId, cycleId, {
    maxPapers: budget.maxPapers,
    query,
    // The L-P recall fallback needs dedup keys, not full refs. Best-effort:
    // a failing search (e.g. during a doom loop, when finalize runs precisely
    // BECAUSE the network is down) degrades the recall dimension to n/a —
    // it must never throw and convert a dead-letter abort into a retry.
    ...(deps.searchPapers
      ? {
          searchPapers: async (searchQuery: string, limit: number) => {
            try {
              return (await deps.searchPapers!(searchQuery, limit)).map((ref) => ({ dedupKey: paperDedupKey(ref) }));
            } catch (error) {
              log(`recall sampling failed (dimension n/a): ${error instanceof Error ? error.message : error}`);
              return [];
            }
          },
        }
      : {}),
  });
  const engineState: Record<string, unknown> = {
    ...convergence,
    cycleId,
    query,
    budget,
    counts,
    updatedAt: new Date().toISOString(),
  };
  // C3③ structured reflection: compress this cycle's deterministic facts
  // into directives the NEXT cycle's seeding reads (zero LLM — template
  // rules only, see growth/directives.ts). Persisted per KB so a crash
  // between cycles cannot lose the reflection.
  const directives = collectCycleDirectives(store, kbId, cycleId, counts, convergence.converged);
  if (directives.length > 0) {
    engineState["directives"] = directives.map((directive) => directive.text);
    log(`reflection: ${directives.length} directive(s) recorded for the next cycle`);
  }
  store.updateEngineState(kbId, engineState);
  log(`cycle done: ${counts.done} done / ${counts.failed} failed / ${counts.pending} pending; converged=${convergence.converged}`);
  return { cycleId, counts, converged: convergence.converged, signals: convergence.signals };
}

const GROW_DIRECTIVES_KEY = "grow_directives:";

function directivesKey(kbId: string): string {
  return `${GROW_DIRECTIVES_KEY}${kbId}`;
}

/** Gather per-cycle facts and derive the directives; persist for next cycle. */
function collectCycleDirectives(
  store: KnowledgeEngineStore,
  kbId: string,
  cycleId: string,
  counts: { total: number; pending: number; done: number; failed: number; skipped: number },
  converged: boolean,
): GrowDirective[] {
  const breakdown = store.frontierCycleBreakdown(cycleId);
  const duplicates = Math.max(0, breakdown.reduce((sum, row) => sum + (row.encounters - row.items), 0));
  const directives = buildGrowDirectives({ counts, sources: breakdown, duplicates, converged });
  store.setSetting(
    directivesKey(kbId),
    JSON.stringify({ cycleId, createdAt: new Date().toISOString(), directives }),
  );
  return directives;
}

/** Read the previous cycle's persisted directives (empty on first cycle). */
function readPriorDirectives(store: KnowledgeEngineStore, kbId: string): GrowDirective[] {
  const raw = store.getSetting(directivesKey(kbId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { directives?: unknown };
    if (!Array.isArray(parsed.directives)) return [];
    return parsed.directives.filter(
      (item): item is GrowDirective =>
        typeof item === "object" && item !== null && typeof (item as GrowDirective).kind === "string"
          && typeof (item as GrowDirective).text === "string",
    );
  } catch {
    return [];
  }
}

/** Adapt the synchronous store to the async ConvergenceDataAccess port. */
function convergenceDataAccess(store: KnowledgeEngineStore): ConvergenceDataAccess {
  return {
    extractionCompletions: async (kbId) => store.extractionCompletions(kbId),
    countEntitiesCreatedSince: async (kbId, sinceIso) => store.countEntitiesCreatedSince(kbId, sinceIso),
    countEdgesCreatedSince: async (kbId, sinceIso) => store.countEdgesCreatedSince(kbId, sinceIso),
    frontierCounts: async (cycleId) => store.frontierCounts(cycleId),
    frontierSourceStats: async (kbId) => store.frontierSourceStats(kbId),
    documentDedupKeys: async (kbId) => store.documentDedupKeys(kbId),
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function seedFrontier(
  store: KnowledgeEngineStore,
  kbId: string,
  cycleId: string,
  query: string,
  budget: CrawlBudget,
  deps: GrowDeps,
  phasesDone: Set<string>,
  phaseKey: string,
  log: (msg: string) => void,
  throttle: ThrottleState,
  sleep: SleepFn,
  callTimeoutMs: number,
): Promise<number> {
  const allDocs = store.listDocumentsForSeeding(kbId, MAX_SEED_DOCS);
  // Drop low-quality seeds (not-ready / proven zero-yield) before resolving
  // citations — saves API calls on dead seeds.
  const seeds = pruneSeeds(
    allDocs.map((doc) => ({
      id: doc.id,
      status: doc.status,
      seedQuality: (doc.sourceMeta["seedQuality"] as { admissionRate?: number; total?: number } | null) ?? null,
    })),
  );
  if (seeds.prunedNotReady + seeds.prunedStale > 0) {
    log(`pruned ${seeds.prunedNotReady + seeds.prunedStale}/${allDocs.length} low-quality seeds (${seeds.prunedNotReady} not-ready, ${seeds.prunedStale} stale)`);
  }
  const keptIds = new Set(seeds.kept.map((doc) => doc.id));
  const docs = allDocs.filter((doc) => keptIds.has(doc.id));

  let queryEmb: Float32Array | null | undefined;
  const ensureQueryEmb = async (refs: PaperRef[]) => {
    if (queryEmb === undefined && refs.some((ref) => ref.abstract)) {
      const embedding = await deps.embed(query);
      if (embedding) queryEmb = embedding;
    }
  };

  const docRef = (doc: (typeof docs)[number]): PaperRef => {
    const stored = doc.sourceMeta["paperRef"] as PaperRef | undefined;
    if (stored) return stored;
    return {
      title: doc.title,
      authors: [...doc.authors],
      year: doc.year,
      doi: doc.sourceUri?.startsWith("doi:") ? doc.sourceUri.slice(4) : null,
      arxivId: doc.sourceUri?.startsWith("arxiv:") ? doc.sourceUri.slice(6) : null,
      abstract: null,
      pdfUrl: null,
      source: "seed",
      sourceId: doc.sourceUri ?? doc.dedupKey,
    };
  };

  const markPhase = (phase: string) => {
    phasesDone.add(phase);
    store.setSetting(phaseKey, JSON.stringify([...phasesDone].sort()));
  };

  let seeded = 0;
  if (!phasesDone.has("backward")) {
    // Track per-seed admission rates so future cycles can prune zero-yield
    // seeds (admissionRate=0 with a meaningful sample).
    const docAdmissions = new Map<string, { admitted: number; total: number }>();
    for (const doc of docs) {
      const ref = docRef(doc);
      try {
        const citations = await withThrottleBackoff(throttle, () => deps.resolveCitations(ref), sleep, callTimeoutMs);
        await ensureQueryEmb(citations);
        const admitted = await admitCandidates(
          store, kbId, cycleId, null, 0, citations, queryEmb ?? null, budget, deps, SOURCE_BACKWARD,
        );
        docAdmissions.set(doc.id, { admitted, total: citations.length });
        seeded += admitted;
      } catch (error) {
        if (error instanceof ThrottleBudgetExhaustedError) {
          // Defer to the runner WITHOUT watermarking the phase: the next
          // attempt resumes it (see the frontier-loop note).
          throw error.cause;
        }
        log(`seed expansion failed for ${doc.title.slice(0, 60)}: ${error instanceof Error ? error.message : error}`);
      }
    }
    writeSeedQuality(store, kbId, docAdmissions);
    markPhase("backward");
  }

  // --- Forward snowball (newest seed docs only; bounded fan-out)
  if (!phasesDone.has("forward")) {
    if (deps.resolveForward) {
      for (const doc of docs.slice(0, FORWARD_SEED_DOCS)) {
        const ref = docRef(doc);
        try {
          const citing = (await withThrottleBackoff(throttle, () => deps.resolveForward!(ref), sleep, callTimeoutMs)).slice(0, FORWARD_PER_DOC);
          await ensureQueryEmb(citing);
          seeded += await admitCandidates(
            store, kbId, cycleId, null, 0, citing, queryEmb ?? null, budget, deps, SOURCE_FORWARD,
          );
        } catch (error) {
          if (error instanceof ThrottleBudgetExhaustedError) throw error.cause;
          log(`forward expansion failed for ${doc.title.slice(0, 60)}: ${error instanceof Error ? error.message : error}`);
        }
      }
    }
    // Done even when the dep is absent — never re-check on resume.
    markPhase("forward");
  }

  // --- Entity-driven patch queries (citation islands / newest uncited work)
  if (!phasesDone.has("entity_query")) {
    if (deps.searchPapers) {
      // C3③ injection: the PREVIOUS cycle's reflection shapes this cycle's
      // seeding (seedFrontier runs before finalizeCycle overwrites the
      // setting, so the read is always one cycle behind — by design).
      const priorDirectives = readPriorDirectives(store, kbId);
      if (priorDirectives.length > 0) {
        log(`applying ${priorDirectives.length} growth directive(s) from the previous cycle`);
      }
      const patchQueryCap = priorDirectives.reduce<number | null>(
        (cap, directive) => directive.patchQueryCap !== undefined
          ? Math.min(cap ?? Number.POSITIVE_INFINITY, directive.patchQueryCap)
          : cap,
        null,
      );
      const allPatchQueries = await buildPatchQueries(kbId, {
        listEntitiesWithDegree: async (id) => store.listEntitiesWithDegree(id),
        topNeighborNames: async (id, entityIds, perEntity) => store.topNeighborNames(id, entityIds, perEntity),
      });
      const patchQueries = patchQueryCap === null ? allPatchQueries : allPatchQueries.slice(0, patchQueryCap);
      if (patchQueryCap !== null && allPatchQueries.length > patchQueries.length) {
        log(`dedup-pressure directive: patch queries narrowed ${allPatchQueries.length} -> ${patchQueries.length}`);
      }
      for (const patchQuery of patchQueries) {
        try {
          const results = await withThrottleBackoff(throttle, () => deps.searchPapers!(patchQuery.query, PATCH_QUERY_LIMIT), sleep, callTimeoutMs);
          await ensureQueryEmb(results);
          seeded += await admitCandidates(
            store, kbId, cycleId, null, 0, results, queryEmb ?? null, budget, deps, SOURCE_ENTITY_QUERY,
          );
        } catch (error) {
          if (error instanceof ThrottleBudgetExhaustedError) throw error.cause;
          log(`patch query "${patchQuery.query.slice(0, 60)}" failed: ${error instanceof Error ? error.message : error}`);
        }
      }
      if (patchQueries.length > 0) log(`issued ${patchQueries.length} entity patch quer(ies)`);
    }
    markPhase("entity_query");
  }

  return seeded;
}

/** Persist per-seed admission rates so future cycles can prune zero-yield
 *  seeds. admissionRate = admitted / total (0 when no refs were resolved).
 *  Best-effort per doc: one bad write must not fail the phase. */
function writeSeedQuality(
  store: KnowledgeEngineStore,
  kbId: string,
  admissions: Map<string, { admitted: number; total: number }>,
): void {
  const lastChecked = new Date().toISOString();
  for (const [docId, { admitted, total }] of admissions) {
    try {
      const doc = store.getDocument(docId);
      if (!doc) continue;
      store.upsertDocument({
        kbId,
        dedupKey: doc.dedupKey,
        sourceMeta: {
          ...doc.sourceMeta,
          seedQuality: { admissionRate: total > 0 ? admitted / total : 0, total, lastChecked },
        },
      });
    } catch {
      // Seed quality is a pruning hint only.
    }
  }
}

/**
 * Score and admit citation candidates into the frontier. Deterministic:
 * embedding-cosine against the engine query with a depth-dependent floor;
 * candidates without an abstract are only admitted at depth 0; duplicates
 * bump cite_hits (each citing parent, and each additional discovery path,
 * counts once) and earn a hub boost at ≥3 rediscoveries.
 * Returns the number of newly admitted candidates.
 */
async function admitCandidates(
  store: KnowledgeEngineStore,
  kbId: string,
  cycleId: string,
  parentId: string | null,
  depth: number,
  citations: PaperRef[],
  queryEmb: Float32Array | null,
  budget: CrawlBudget,
  deps: GrowDeps,
  source: string,
): Promise<number> {
  const floor = RELEVANCE_FLOORS[Math.min(depth, RELEVANCE_FLOORS.length - 1)]!;

  // Score candidates and cache embeddings for MMR. Unknown score sorts last.
  const scored = await rankCandidatePool(citations, queryEmb, deps.embed, budget.maxPerPaper * 2);

  // Pre-filter: passes floor AND not already ingested in the KB.
  const pool: Array<RankedCandidate<PaperRef>> = [];
  for (const candidate of scored) {
    if (pool.length >= budget.maxPerPaper * 2) break;
    const passesFloor = candidate.score === null ? depth === 0 : candidate.score >= floor;
    if (!passesFloor) continue;
    const key = paperDedupKey(candidate.ref);
    if (store.findDocumentByDedupKey(kbId, key)) continue;
    pool.push({ ...candidate, dedupKey: key });
  }

  // Selection pressure: more embedding-scored candidates than the per-paper cap.
  const withEmbCount = pool.filter((candidate) => candidate.emb && candidate.score != null).length;
  const selectionPressure = Boolean(queryEmb) && withEmbCount > budget.maxPerPaper;

  let ordered = pool;
  if (selectionPressure) {
    // Adamic/Adar bibliographic-coupling boost: probe the top-K candidates'
    // references and blend an AA score into relevance. Skipped on cold start
    // (no ingested refIds). Unprobed candidates default to 0 — a high-cosine
    // uncoupled candidate is never penalized relative to an unprobed one.
    const inverted = buildRefInvertedIndex(
      store.listDocuments(kbId).map((doc) => ({ id: doc.id, refIds: doc.refIds })),
    );
    if (inverted.size > 0) {
      const aaByCandidate = new Map<RankedCandidate<PaperRef>, number>();
      await Promise.all(
        pool.slice(0, AA_TOP_K).map(async (candidate) => {
          if (!candidate.emb || candidate.score == null) return;
          try {
            const refs = await deps.resolveCitations(candidate.ref);
            aaByCandidate.set(candidate, aaCouplingScore(refs.map(paperDedupKey), inverted));
          } catch {
            aaByCandidate.set(candidate, 0); // rate limit / not found → no coupling signal
          }
        }),
      );
      ordered = blendAaScores(pool, aaByCandidate);
    }
    // MMR diversifies under selection pressure (AA-blended score as Sim₁).
    ordered = mmrSelect(ordered, MMR_LAMBDA, budget.maxPerPaper);
  }

  let admitted = 0;
  for (const candidate of ordered) {
    if (admitted >= budget.maxPerPaper) break;
    const { item, inserted } = store.frontierAdd({
      kbId,
      cycleId,
      paperRef: candidate.ref as unknown as Record<string, unknown>,
      dedupKey: candidate.dedupKey!,
      depth,
      relevanceScore: candidate.score,
      parentId,
      source,
    });
    if (inserted) {
      admitted += 1;
    } else if (item.citeHits === HUB_MIN_CITERS && item.status === "pending") {
      // Exactly-once boost at the moment the hub threshold is reached.
      store.frontierBoostScore(item.id, HUB_BOOST);
    }
  }
  return admitted;
}
