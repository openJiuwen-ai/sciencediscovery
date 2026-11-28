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
 * W8 `kb_search` — document-level FTS recall + block-level locate.
 * Z8 hybrid upgrade — vector (semantic) arm fused with the keyword arm via
 * Reciprocal Rank Fusion.
 *
 * The agent-facing search tool: FTS5 (caller-provided) recalls documents;
 * this module re-derives the W7 anchored blocks on demand and ranks them
 * against the query terms, so every hit carries an `anchorId` into the
 * three-level reader. The keyword path stays deterministic and is never
 * removed — the vector arm is an optional layer (failure philosophy:
 * probabilistic layers must never be the only path to a result). With the
 * embedding client configured and chunk vectors stored (ke_doc_chunks),
 * {@link hybridSearchBlocks} fuses both arms: per-source over-fetch, RRF
 * merge, single-source failure degrades to the surviving arm.
 */

import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import { documentAnchor, parseDocumentBlocks, resolveDocumentAnchor, type DocumentBlock, type DocumentBlockType } from "./levels.js";

export interface KbSearchDocumentInput {
  readonly docId: string;
  readonly title: string | null;
  readonly fulltext: string;
}

export interface KbSearchHit {
  readonly docId: string;
  readonly docTitle: string | null;
  readonly anchorId: string;
  readonly blockType: DocumentBlockType;
  readonly section: string | null;
  readonly lineStart: number;
  readonly snippet: string;
  readonly matchedTerms: readonly string[];
  readonly score: number;
  /** V1-Z2: score relative to the batch's best hit (0-1) — mode-agnostic
   *  grading that survives FTS/RRF/vector scale differences. */
  readonly scoreRatio?: number;
  /** V1-Z2: scoreRatio tier — high (>=0.8) / medium (>=0.5) / low. */
  readonly relevance?: "high" | "medium" | "low";
}

export interface KbSearchResult {
  readonly kbId: string;
  readonly query: string;
  readonly hits: readonly KbSearchHit[];
  /** true when scored blocks were cut by topK or the per-document cap. */
  readonly truncated: boolean;
  /** Present when the query produced nothing searchable. */
  readonly note?: string;
  /** Z8: which retrieval arms contributed (["fts"], ["vector"], or both). */
  readonly sources?: readonly ("fts" | "vector")[];
}

/** Small English stoplist — CJK content passes through as whole runs. */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for",
  "if", "in", "into", "is", "it", "of", "on", "or", "the", "to", "was", "with",
]);

export function extractQueryTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const token of query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (STOPWORDS.has(token)) continue;
    if (token.length < 2 && !/\p{Script=Han}/u.test(token)) continue;
    terms.add(token);
  }
  return [...terms];
}

function scoreText(text: string, terms: readonly string[]): { score: number; matched: string[] } {
  const lower = text.toLowerCase();
  let score = 0;
  const matched: string[] = [];
  for (const term of terms) {
    let from = 0;
    let count = 0;
    for (;;) {
      const at = lower.indexOf(term, from);
      if (at === -1) break;
      count += 1;
      from = at + term.length;
      if (count >= 5) break;
    }
    if (count > 0) {
      matched.push(term);
      // Presence dominates; frequency adds a small capped bonus so long
      // blocks do not win purely by length.
      score += 1 + Math.min(count, 5) * 0.2;
    }
  }
  return { score, matched };
}

function snippetAround(blockText: string, terms: readonly string[], cap = 200): string {
  const normalized = blockText.replace(/\s+/g, " ").trim();
  if (normalized.length <= cap) return normalized;
  const lower = normalized.toLowerCase();
  let first = -1;
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at !== -1 && (first === -1 || at < first)) first = at;
  }
  if (first <= 40) return `${normalized.slice(0, cap - 1)}…`;
  const start = first - 40;
  return `…${normalized.slice(start, start + cap - 1)}…`;
}

/** Score recalled documents' blocks against the query; deterministic order
 *  (score desc, then document recall order, then block order). At most
 *  `maxPerDoc` hits per document spread the answer across sources. */
export function searchBlocks(input: {
  kbId: string;
  query: string;
  documents: readonly KbSearchDocumentInput[];
  topK?: number;
  maxPerDoc?: number;
  /** V1-Z2 opt-in relative tail cut: drop hits below this fraction of the
   *  batch's best score (scale-free, unlike an absolute minScore). */
  minScoreRatio?: number;
}): KbSearchResult {
  const topK = Math.max(1, Math.min(input.topK ?? 8, 20));
  const maxPerDoc = Math.max(1, Math.min(input.maxPerDoc ?? 2, 10));
  const terms = extractQueryTerms(input.query);

  if (terms.length === 0) {
    return { kbId: input.kbId, query: input.query, hits: [], truncated: false, note: "query has no searchable terms" };
  }
  if (input.documents.length === 0) {
    return { kbId: input.kbId, query: input.query, hits: [], truncated: false, note: "no documents matched the keyword recall" };
  }

  const scored = scoreAllBlocks(input.documents, terms);
  scored.sort((left, right) =>
    right.hit.score - left.hit.score || left.docOrder - right.docOrder || left.blockOrder - right.blockOrder,
  );

  const hits: KbSearchHit[] = [];
  const perDoc = new Map<string, number>();
  let truncated = false;
  for (const entry of scored) {
    const used = perDoc.get(entry.hit.docId) ?? 0;
    if (used >= maxPerDoc) {
      truncated = true;
      continue;
    }
    if (hits.length >= topK) {
      truncated = true;
      break;
    }
    perDoc.set(entry.hit.docId, used + 1);
    hits.push(entry.hit);
  }

  return {
    kbId: input.kbId,
    query: input.query,
    hits: applyRelativeGrading(hits, input.minScoreRatio),
    truncated,
    ...(hits.length === 0 ? { note: "terms matched no passage blocks" } : {}),
  };
}

// --------------------------------------------------- V1-Z2 relative grading

export const RELEVANCE_HIGH_RATIO = 0.8;
export const RELEVANCE_MEDIUM_RATIO = 0.5;

/**
 * Annotate hits with mode-agnostic relative grading (scoreRatio + relevance)
 * against the best score of the same batch, and optionally drop the tail
 * below `minScoreRatio` of that best score. Pure: order and existing fields
 * are preserved, only the grading fields are appended. Port of SA
 * retriever.ts applyRelativeGrading.
 */
export function applyRelativeGrading(
  hits: readonly KbSearchHit[],
  minScoreRatio?: number,
): KbSearchHit[] {
  if (hits.length === 0) return [...hits];
  const maxScore = hits.reduce((best, hit) => (hit.score > best ? hit.score : best), 0);
  const graded = hits.map((hit) => {
    const ratio = maxScore > 0 ? hit.score / maxScore : 0;
    return {
      ...hit,
      scoreRatio: Number(ratio.toFixed(4)),
      relevance: ratio >= RELEVANCE_HIGH_RATIO ? "high" as const
        : ratio >= RELEVANCE_MEDIUM_RATIO ? "medium" as const
        : "low" as const,
    };
  });
  if (minScoreRatio === undefined) return graded;
  const floor = maxScore * minScoreRatio;
  return graded.filter((hit) => hit.score >= floor);
}

// ------------------------------------------------------------- Z8 hybrid RRF

/** One semantic-arm candidate: a cosine-ranked chunk (pre-scored by the
 *  caller — the pure layer never touches embedding math). */
export interface VectorChunkCandidate {
  readonly docId: string;
  readonly anchorId: string;
  readonly score: number;
}

/** Standard RRF smoothing constant — 60 keeps single-arm ranks dominant
 *  enough that rank 1 beats rank 2 of the other arm; an anchor found near
 *  the top of BOTH arms outranks any single-arm find of similar rank (not
 *  absolutely for very deep ranks — RRF is a rank heuristic, not a proof).
 *  OpenDDE skill_forge pattern: per-source over-fetch ×2, fuse, degrade on
 *  source failure. */
export const RRF_K = 60;
const HYBRID_OVERFETCH = 2;

interface ScoredBlock {
  readonly hit: KbSearchHit;
  readonly docOrder: number;
  readonly blockOrder: number;
}

/** All term-scored blocks of the document set, uncapped and deterministically
 *  ordered — the shared FTS arm for both the keyword-only and hybrid paths. */
function scoreAllBlocks(documents: readonly KbSearchDocumentInput[], terms: readonly string[]): ScoredBlock[] {
  const scored: ScoredBlock[] = [];
  documents.forEach((document, docOrder) => {
    const blocks = parseDocumentBlocks(document.fulltext);
    blocks.forEach((block, blockOrder) => {
      if (block.type === "reference") return;
      const { score, matched } = scoreText(block.text, terms);
      if (score <= 0) return;
      scored.push({
        docOrder,
        blockOrder,
        hit: {
          docId: document.docId,
          docTitle: document.title,
          anchorId: documentAnchor(document.docId, block),
          blockType: block.type,
          section: block.section,
          lineStart: block.lineStart,
          snippet: snippetAround(block.text, matched),
          matchedTerms: matched,
          score: Number(score.toFixed(2)),
        },
      });
    });
  });
  return scored;
}

/**
 * Fuse the keyword arm (block term scoring over the caller-recalled
 * documents) with the semantic arm (caller-ranked chunk candidates) via
 * Reciprocal Rank Fusion. `documents` must include every document a vector
 * candidate points at — the caller loads those in addition to the FTS
 * recall. A missing/empty vector arm degrades to keyword-only with an
 * honest note; empty FTS still lets the vector arm answer (semantic search
 * needs no term tokens).
 */
export function hybridSearchBlocks(input: {
  kbId: string;
  query: string;
  documents: readonly KbSearchDocumentInput[];
  vectorCandidates?: readonly VectorChunkCandidate[];
  topK?: number;
  maxPerDoc?: number;
  /** V1-Z2 opt-in relative tail cut (same semantics as searchBlocks). */
  minScoreRatio?: number;
}): KbSearchResult {
  const topK = Math.max(1, Math.min(input.topK ?? 8, 20));
  const maxPerDoc = Math.max(1, Math.min(input.maxPerDoc ?? 2, 10));
  const terms = extractQueryTerms(input.query);
  const vector = (input.vectorCandidates ?? []).slice(0, topK * HYBRID_OVERFETCH);

  const ftsRanked = (terms.length === 0 ? [] : scoreAllBlocks(input.documents, terms))
    .sort((left, right) =>
      right.hit.score - left.hit.score || left.docOrder - right.docOrder || left.blockOrder - right.blockOrder,
    )
    .slice(0, topK * HYBRID_OVERFETCH);
  const sources: Array<"fts" | "vector"> = [];
  if (ftsRanked.length > 0) sources.push("fts");
  if (vector.length > 0) sources.push("vector");

  if (sources.length === 0) {
    return {
      kbId: input.kbId,
      query: input.query,
      hits: [],
      truncated: false,
      note: terms.length === 0
        ? "query has no searchable terms and no vector source is available"
        : "terms matched no passage blocks and no vector source is available",
    };
  }

  // Block metadata lookup for vector-only anchors (FTS hits already carry it).
  const blocksByDoc = new Map<string, DocumentBlock[]>();
  const docById = new Map(input.documents.map((document) => [document.docId, document]));
  const blockFor = (docId: string, anchorId: string): { block: DocumentBlock; docTitle: string | null } | null => {
    let blocks = blocksByDoc.get(docId);
    if (!blocks) {
      const document = docById.get(docId);
      if (!document) return null;
      blocks = parseDocumentBlocks(document.fulltext);
      blocksByDoc.set(docId, blocks);
    }
    const block = blocks.find((candidate) => documentAnchor(docId, candidate) === anchorId);
    return block ? { block, docTitle: docById.get(docId)?.title ?? null } : null;
  };

  interface Fused {
    rrf: number;
    fts?: ScoredBlock;
  }
  const fused = new Map<string, Fused>();
  const bump = (anchorId: string, contribution: number, attach: (current: Fused) => Partial<Fused>): void => {
    const current = fused.get(anchorId) ?? { rrf: 0 };
    fused.set(anchorId, { ...current, rrf: current.rrf + contribution, ...attach(current) });
  };
  ftsRanked.forEach((entry, rank) => {
    bump(entry.hit.anchorId, 1 / (RRF_K + rank + 1), () => ({ fts: entry }));
  });
  vector.forEach((candidate, rank) => {
    bump(candidate.anchorId, 1 / (RRF_K + rank + 1), () => ({}));
  });

  const hits: KbSearchHit[] = [];
  const perDoc = new Map<string, number>();
  let truncated = false;
  const ranked = [...fused.entries()].sort((left, right) => {
    const delta = right[1].rrf - left[1].rrf;
    if (delta !== 0) return delta;
    const leftOrder = left[1].fts ? left[1].fts.docOrder * 100_000 + left[1].fts.blockOrder : Number.MAX_SAFE_INTEGER;
    const rightOrder = right[1].fts ? right[1].fts.docOrder * 100_000 + right[1].fts.blockOrder : Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left[0].localeCompare(right[0]);
  });
  for (const [anchorId, entry] of ranked) {
    const docId = docIdFromAnchor(anchorId) ?? entry.fts?.hit.docId ?? "";
    if (!docId) continue;
    const used = perDoc.get(docId) ?? 0;
    if (used >= maxPerDoc) {
      truncated = true; // matches exist beyond the per-document cap
      continue;
    }
    if (hits.length >= topK) {
      // Only a real truncation when ranked entries remain unvisited.
      truncated = true;
      break;
    }
    if (entry.fts) {
      hits.push({ ...entry.fts.hit, score: Number(entry.rrf.toFixed(6)) });
    } else {
      const located = blockFor(docId, anchorId);
      if (!located) continue; // vector candidate whose document was not loaded
      hits.push({
        docId,
        docTitle: located.docTitle,
        anchorId,
        blockType: located.block.type,
        section: located.block.section,
        lineStart: located.block.lineStart,
        snippet: snippetAround(located.block.text, terms),
        matchedTerms: [],
        score: Number(entry.rrf.toFixed(6)),
      });
    }
    perDoc.set(docId, used + 1);
  }

  const note = input.vectorCandidates === undefined && sources.length === 1 && sources[0] === "fts"
    ? "vector source unavailable (no embedding client, no embedded chunks, or embed failure) — keyword-only"
    : undefined;
  const graded = applyRelativeGrading(hits, input.minScoreRatio);
  return {
    kbId: input.kbId,
    query: input.query,
    hits: graded,
    truncated,
    sources,
    ...(note ? { note } : {}),
    ...(graded.length === 0 ? { note: note ?? "no passage blocks matched either retrieval arm" } : {}),
  };
}

// ------------------------------------------------------------------ kb_expand

/** `{docId}:{elementType}:{index}` → docId, parsed from the right so docIds
 *  containing colons cannot shift the split (mirrors resolveDocumentAnchor). */
export function docIdFromAnchor(anchorId: string): string | null {
  const parts = anchorId.split(":");
  if (parts.length < 3) return null;
  parts.pop();
  parts.pop();
  const docId = parts.join(":");
  return docId.length > 0 ? docId : null;
}

export type KbExpandResult =
  | {
      readonly found: true;
      readonly kbId: string;
      readonly anchorId: string;
      readonly docId: string;
      readonly docTitle: string | null;
      readonly block: { anchorId: string; type: DocumentBlockType; section: string | null; lineStart: number; text: string };
      readonly before: { anchorId: string; type: DocumentBlockType; text: string } | null;
      readonly after: { anchorId: string; type: DocumentBlockType; text: string } | null;
    }
  | { readonly found: false; readonly reason: "anchor-not-found" | "document-not-found" | "document-not-parsed" };

/** W8 `kb_expand` — read an anchor's block plus its neighbours. The pure
 *  companion to kb_search: an agent that found a hit reads the surrounding
 *  passage instead of trusting the snippet alone. */
export function expandAnchor(input: {
  kbId: string;
  anchorId: string;
  document: KbSearchDocumentInput;
}): KbExpandResult {
  const blocks = parseDocumentBlocks(input.document.fulltext);
  const hit = resolveDocumentAnchor(blocks, input.anchorId);
  if (!hit) return { found: false, reason: "anchor-not-found" };
  const toAnchor = (block: DocumentBlock) => ({
    anchorId: documentAnchor(input.document.docId, block),
    type: block.type,
    text: block.text,
  });
  return {
    found: true,
    kbId: input.kbId,
    anchorId: input.anchorId,
    docId: input.document.docId,
    docTitle: input.document.title,
    block: {
      anchorId: input.anchorId,
      type: hit.block.type,
      section: hit.block.section,
      lineStart: hit.block.lineStart,
      text: hit.block.text,
    },
    before: hit.before ? toAnchor(hit.before) : null,
    after: hit.after ? toAnchor(hit.after) : null,
  };
}

// ------------------------------------------------------------------ doc_grep

export interface DocGrepMatch {
  readonly docId: string;
  readonly docTitle: string | null;
  /** 1-based fulltext line. */
  readonly line: number;
  readonly text: string;
}

export interface DocGrepResult {
  readonly kbId: string;
  readonly pattern: string;
  readonly matches: readonly DocGrepMatch[];
  readonly scannedDocs: number;
  /** true when matches were cut by maxMatches or input by the scan budget. */
  readonly truncated: boolean;
  /** Present for invalid patterns, worker startup failure, or regex timeout. */
  readonly error?: string;
}

const GREP_LINE_CAP = 200;
const GREP_TEST_LINE_CAP = 2_000;
/** Total character budget across the scan. Input is sliced to this prefix
 *  before worker construction, so cloning never includes the whole corpus. */
const GREP_SCAN_CHAR_BUDGET = 2_000_000;
/** Regex compilation and scanning have a hard deadline of their own. */
const GREP_REGEX_TIMEOUT_MS = 100;
/** Startup is operationally separate from regex cost, but still bounded. */
const GREP_WORKER_STARTUP_TIMEOUT_MS = 10_000;

interface WorkerGrepResult {
  readonly matches: DocGrepMatch[];
  readonly truncated: boolean;
}

type GrepWorkerOutcome =
  | { readonly kind: "result"; readonly result: WorkerGrepResult }
  | { readonly kind: "regex-timeout" | "startup-timeout" | "worker-error" };

/** JavaScript's RegExp engine can backtrack catastrophically. Run the complete
 *  scan once off the main thread, then synchronously collect its queued message.
 *  Atomics.wait plus receiveMessageOnPort preserves the API without depending on
 *  the main event loop. State 1 means the worker is about to start regex work;
 *  state 2 means a result/error message has been queued. */
const GREP_WORKER_SOURCE = `
const { workerData } = require("node:worker_threads");
const { pattern, documents, maxMatches, lineCap, testLineCap, signal, port } = workerData;
const result = { matches: [], truncated: false };
try {
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
  const regex = new RegExp(pattern, "i");
  let collect = true;
  outer: for (const document of documents) {
    const lines = document.fulltext.split("\\n");
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i].slice(0, testLineCap);
      if (!regex.test(raw)) continue;
      if (!collect) {
        result.truncated = true;
        break outer;
      }
      const text = lines[i].trim().slice(0, lineCap);
      if (text.length === 0) continue;
      result.matches.push({ docId: document.docId, docTitle: document.title, line: i + 1, text });
      if (result.matches.length >= maxMatches) collect = false;
    }
  }
  port.postMessage({ type: "result", result });
} catch {
  // Pattern syntax was already checked by the caller; any worker-side failure
  // still wakes the caller, which returns a structured worker error.
  port.postMessage({ type: "error" });
}
Atomics.store(signal, 0, 2);
Atomics.notify(signal, 0);
`;

function budgetGrepDocuments(documents: readonly KbSearchDocumentInput[]): {
  documents: KbSearchDocumentInput[];
  truncated: boolean;
} {
  const budgeted: KbSearchDocumentInput[] = [];
  let remaining = GREP_SCAN_CHAR_BUDGET;
  for (const document of documents) {
    if (remaining <= 0) return { documents: budgeted, truncated: true };
    const fulltext = document.fulltext.slice(0, remaining);
    budgeted.push({ ...document, fulltext });
    remaining -= fulltext.length;
    if (fulltext.length !== document.fulltext.length) {
      return { documents: budgeted, truncated: true };
    }
  }
  return { documents: budgeted, truncated: false };
}

function runGrepWithDeadline(
  pattern: string,
  documents: readonly KbSearchDocumentInput[],
  maxMatches: number,
): GrepWorkerOutcome {
  const budgeted = budgetGrepDocuments(documents);
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(GREP_WORKER_SOURCE, {
    eval: true,
    workerData: {
      pattern,
      documents: budgeted.documents,
      maxMatches,
      lineCap: GREP_LINE_CAP,
      testLineCap: GREP_TEST_LINE_CAP,
      signal,
      port: port2,
    },
    transferList: [port2],
  });
  worker.unref();
  port1.unref();

  const startupWait = Atomics.wait(signal, 0, 0, GREP_WORKER_STARTUP_TIMEOUT_MS);
  let state = Atomics.load(signal, 0);
  let outcome: GrepWorkerOutcome;
  if (startupWait === "timed-out" && state === 0) {
    outcome = { kind: "startup-timeout" };
  } else {
    if (state === 1) {
      // Reset only if the worker has not already finished; otherwise the reset
      // could erase its done notification and manufacture a false timeout.
      state = Atomics.compareExchange(signal, 0, 1, 0) === 1 ? 0 : Atomics.load(signal, 0);
    }
    if (state === 0) {
      Atomics.wait(signal, 0, 0, GREP_REGEX_TIMEOUT_MS);
      state = Atomics.load(signal, 0);
    }
    if (state !== 2) {
      outcome = { kind: "regex-timeout" };
    } else {
      const message = receiveMessageOnPort(port1)?.message as {
        type?: string;
        result?: WorkerGrepResult;
      } | undefined;
      outcome = message?.type === "result" && message.result
        ? {
          kind: "result",
          result: {
            matches: message.result.matches,
            truncated: message.result.truncated || budgeted.truncated,
          },
        }
        : { kind: "worker-error" };
    }
  }
  port1.close();
  void worker.terminate();
  return outcome;
}

/** W8 `doc_grep` — regex over document fulltexts, line-grained like grep.
 *  Case-insensitive by default; deterministic doc-then-line order. An invalid
 *  pattern returns a structured error (never throws) so the agent can retry. */
export function grepDocuments(input: {
  kbId: string;
  pattern: string;
  documents: readonly KbSearchDocumentInput[];
  maxMatches?: number;
}): DocGrepResult {
  const maxMatches = Math.max(1, Math.min(input.maxMatches ?? 20, 50));
  const empty = (error?: string): DocGrepResult => ({
    kbId: input.kbId,
    pattern: input.pattern,
    matches: [],
    scannedDocs: input.documents.length,
    truncated: false,
    ...(error ? { error } : {}),
  });
  if (input.pattern.length === 0 || input.pattern.length > 200) {
    return empty("pattern must be 1-200 characters");
  }
  try {
    new RegExp(input.pattern, "i");
  } catch (cause) {
    return empty(`invalid regex: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  const outcome = runGrepWithDeadline(input.pattern, input.documents, maxMatches);
  if (outcome.kind !== "result") {
    const error = outcome.kind === "regex-timeout"
      ? `regex execution exceeded ${GREP_REGEX_TIMEOUT_MS} ms deadline; choose a simpler pattern`
      : outcome.kind === "startup-timeout"
        ? `grep worker startup exceeded ${GREP_WORKER_STARTUP_TIMEOUT_MS} ms; retry the query`
        : "grep worker failed before returning a result; retry the query";
    return empty(error);
  }
  return {
    kbId: input.kbId,
    pattern: input.pattern,
    matches: outcome.result.matches,
    scannedDocs: input.documents.length,
    truncated: outcome.result.truncated,
  };
}
