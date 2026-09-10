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
 *
 * The agent-facing search tool: FTS5 (caller-provided) recalls documents;
 * this module re-derives the W7 anchored blocks on demand and ranks them
 * against the query terms, so every hit carries an `anchorId` into the
 * three-level reader. Deliberately keyword-only and deterministic — the
 * hybrid vector rerank is a later, optional layer (failure philosophy:
 * probabilistic layers must never be the only path to a result).
 *
 * A persisted chunk table (DA's retrieval_chunks) is deferred: re-parsing
 * ≤10 recalled documents' blocks is milliseconds at today's KB sizes. When
 * KBs grow past that, the same block ranking moves to a chunk index without
 * changing this tool's contract.
 */

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
}

export interface KbSearchResult {
  readonly kbId: string;
  readonly query: string;
  readonly hits: readonly KbSearchHit[];
  /** true when scored blocks were cut by topK or the per-document cap. */
  readonly truncated: boolean;
  /** Present when the query produced nothing searchable. */
  readonly note?: string;
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
}): KbSearchResult {
  const topK = Math.max(1, Math.min(input.topK ?? 8, 20));
  const maxPerDoc = Math.max(1, input.maxPerDoc ?? 2);
  const terms = extractQueryTerms(input.query);

  if (terms.length === 0) {
    return { kbId: input.kbId, query: input.query, hits: [], truncated: false, note: "query has no searchable terms" };
  }
  if (input.documents.length === 0) {
    return { kbId: input.kbId, query: input.query, hits: [], truncated: false, note: "no documents matched the keyword recall" };
  }

  const scored: Array<{ hit: KbSearchHit; docOrder: number; blockOrder: number }> = [];
  input.documents.forEach((document, docOrder) => {
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

  return { kbId: input.kbId, query: input.query, hits, truncated, ...(hits.length === 0 ? { note: "terms matched no passage blocks" } : {}) };
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
  /** true when matches were cut by maxMatches — more exist. */
  readonly truncated: boolean;
  /** Present when the pattern is not a valid regex (agent retry hint). */
  readonly error?: string;
}

const GREP_LINE_CAP = 200;
/** Lines are capped HERE (before regex.test) — a bounded input bounds any
 *  backtracking the agent-supplied pattern can induce. */
const GREP_TEST_LINE_CAP = 2_000;
/** Total character budget across the scan: the 50-match cap bounds matches,
 *  not work; this bounds the work itself on the synchronous API event loop. */
const GREP_SCAN_CHAR_BUDGET = 2_000_000;

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
  let regex: RegExp;
  try {
    regex = new RegExp(input.pattern, "i");
  } catch (cause) {
    return empty(`invalid regex: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  const matches: DocGrepMatch[] = [];
  let budget = GREP_SCAN_CHAR_BUDGET;
  let truncated = false;
  let collect = true;
  outer: for (const document of input.documents) {
    const lines = document.fulltext.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i]!.slice(0, GREP_TEST_LINE_CAP);
      budget -= raw.length;
      if (budget <= 0) {
        // Scan incomplete regardless of matches — more may exist.
        truncated = true;
        break outer;
      }
      if (!regex.test(raw)) continue;
      if (!collect) {
        // Confirmation match past the cap: more matches exist — stop here.
        truncated = true;
        break outer;
      }
      const text = lines[i]!.trim().slice(0, GREP_LINE_CAP);
      if (text.length === 0) continue;
      matches.push({ docId: document.docId, docTitle: document.title, line: i + 1, text });
      if (matches.length >= maxMatches) collect = false;
    }
  }
  return { kbId: input.kbId, pattern: input.pattern, matches, scannedDocs: input.documents.length, truncated };
}
