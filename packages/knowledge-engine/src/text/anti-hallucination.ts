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
 * W9 runtime anti-hallucination — the pure-text port of the DA runtime
 * layer, adapted to SD's deterministic-tool philosophy:
 *
 * - `verifyCitation`: three-state quote verification (verbatim / fuzzy /
 *   not-found) with the per-document evidence list — the runtime arm of the
 *   extraction provenance gate, for the agent's OWN draft answers.
 * - `noveltyCheck`: three offline KB probes (entity / relation / passage)
 *   for a candidate claim. Internal-only by design: "no collision in this
 *   KB" is reported as exactly that, never as "novel in the literature"
 *   (the Robin/ABCA1 lesson).
 * - `buildAntiHallucinationBrief`: the three-tier context injection —
 *   verified / uncertain / forbidden — as compact deterministic text.
 */

import { normalizeGateText } from "../extraction/provenance-gate.js";
import { extractQueryTerms, searchBlocks, type KbSearchDocumentInput } from "./search.js";

// --------------------------------------------------------------- citations

export type CitationVerifyState = "verbatim" | "fuzzy" | "none";

export interface CitationVerifyDoc {
  readonly docId: string;
  readonly docTitle: string | null;
  readonly state: Exclude<CitationVerifyState, "none">;
}

export interface CitationVerifyResult {
  readonly kbId: string;
  /** The strongest state found across documents. */
  readonly state: CitationVerifyState;
  readonly verifiedIn: readonly CitationVerifyDoc[];
  readonly scannedDocs: number;
  readonly note?: string;
}

/** Word-set overlap ratio between quote and haystack (gate's fuzzy arm). */
function wordOverlap(quote: string, haystack: string): number {
  const quoteWords = new Set(normalizeGateText(quote).split(" ").filter((word) => word.length > 1));
  if (quoteWords.size === 0) return 0;
  const haystackWords = new Set(normalizeGateText(haystack).split(" "));
  let hit = 0;
  for (const word of quoteWords) {
    if (haystackWords.has(word)) hit += 1;
  }
  return hit / quoteWords.size;
}

function verifyQuoteIn(quote: string, haystack: string): Exclude<CitationVerifyState, "none"> | "none" {
  if (normalizeGateText(quote).length < 10) return "none";
  if (normalizeGateText(haystack).includes(normalizeGateText(quote))) return "verbatim";
  if (wordOverlap(quote, haystack) >= 0.85) return "fuzzy";
  return "none";
}

/** Three-state citation check across the KB's documents. */
export function verifyCitation(input: {
  kbId: string;
  quote: string;
  documents: readonly KbSearchDocumentInput[];
}): CitationVerifyResult {
  const verifiedIn: CitationVerifyDoc[] = [];
  for (const document of input.documents) {
    const state = verifyQuoteIn(input.quote, document.fulltext);
    if (state !== "none") {
      verifiedIn.push({ docId: document.docId, docTitle: document.title, state });
    }
  }
  const state: CitationVerifyState = verifiedIn.some((doc) => doc.state === "verbatim")
    ? "verbatim"
    : verifiedIn.length > 0
      ? "fuzzy"
      : "none";
  return {
    kbId: input.kbId,
    state,
    verifiedIn,
    scannedDocs: input.documents.length,
    ...(state === "none"
      ? { note: "quote not found in any scanned document — do not present it as a paper's wording" }
      : state === "fuzzy"
        ? { note: "only a fuzzy (≥85% word overlap) match — quote is a paraphrase, not verbatim; attribute accordingly or find the exact sentence" }
        : {}),
  };
}

// ---------------------------------------------------------------- novelty

export interface NoveltyEntityHit {
  readonly name: string;
  readonly type: string;
  readonly supportCount: number;
}

export interface NoveltyRelationHit {
  readonly sourceName: string;
  readonly targetName: string;
  readonly type: string;
  readonly supportCount: number;
  readonly quote: string | null;
}

export interface NoveltyPassageHit {
  readonly docId: string;
  readonly anchorId: string;
  readonly snippet: string;
}

export interface NoveltyCheckResult {
  readonly kbId: string;
  readonly claim: string;
  /** collision = the KB already covers this; partial = weak overlap;
   *  no-collision = nothing in this KB overlaps (NOT a literature-novelty
   *  claim — external check is out of scope for this build). */
  readonly verdict: "collision" | "partial" | "no-collision";
  readonly entityHits: readonly NoveltyEntityHit[];
  readonly relationHits: readonly NoveltyRelationHit[];
  readonly passageHits: readonly NoveltyPassageHit[];
  readonly note: string;
}

export interface NoveltyEntityInput {
  readonly name: string;
  readonly type: string;
  readonly supportCount: number;
  readonly aliases?: readonly string[];
}

export interface NoveltyRelationInput {
  readonly sourceName: string;
  readonly targetName: string;
  readonly type: string;
  readonly supportCount: number;
  readonly quote: string | null;
}

/** Probe 1: KB entities whose name or alias appears in the claim (or a
 *  claim term equals the name after normalization). */
function entityProbe(claimTerms: readonly string[], claim: string, entities: readonly NoveltyEntityInput[]): NoveltyEntityHit[] {
  const normalizedClaim = ` ${normalizeGateText(claim)} `;
  const hits: NoveltyEntityHit[] = [];
  for (const entity of entities) {
    const names = [entity.name, ...(entity.aliases ?? [])].map(normalizeGateText).filter((name) => name.length > 1);
    const nameHit = names.some((name) => normalizedClaim.includes(` ${name} `) || normalizedClaim.includes(` ${name}s `));
    const termHit = names.some((name) => claimTerms.includes(name));
    if (nameHit || termHit) {
      hits.push({ name: entity.name, type: entity.type, supportCount: entity.supportCount });
    }
  }
  return hits.slice(0, 10);
}

/** Probe 2: relations whose endpoints are both named in the claim, or whose
 *  evidence quote shares ≥60% of the claim's terms. */
function relationProbe(claimTerms: readonly string[], claim: string, relations: readonly NoveltyRelationInput[]): NoveltyRelationHit[] {
  if (claimTerms.length === 0) return [];
  const claimTermSet = new Set(claimTerms);
  const hits: NoveltyRelationHit[] = [];
  for (const relation of relations) {
    const endsNamed =
      normalizeGateText(claim).includes(normalizeGateText(relation.sourceName))
      && normalizeGateText(claim).includes(normalizeGateText(relation.targetName));
    if (endsNamed) {
      hits.push(relation);
      continue;
    }
    if (!relation.quote) continue;
    const quoteTerms = new Set(extractQueryTerms(relation.quote));
    if (quoteTerms.size === 0) continue;
    let shared = 0;
    for (const term of claimTermSet) {
      if (quoteTerms.has(term)) shared += 1;
    }
    if (shared / claimTermSet.size >= 0.6) hits.push(relation);
  }
  return hits.slice(0, 10);
}

/** Probe 3: passage search with the claim as the query. */
function passageProbe(input: { kbId: string; claim: string; documents: readonly KbSearchDocumentInput[] }): NoveltyPassageHit[] {
  return searchBlocks({ kbId: input.kbId, query: input.claim, documents: input.documents, topK: 5 })
    .hits.slice(0, 5)
    .map((hit) => ({ docId: hit.docId, anchorId: hit.anchorId, snippet: hit.snippet }));
}

/** Offline novelty check against ONE knowledge base. */
export function noveltyCheck(input: {
  kbId: string;
  claim: string;
  entities: readonly NoveltyEntityInput[];
  relations: readonly NoveltyRelationInput[];
  documents: readonly KbSearchDocumentInput[];
}): NoveltyCheckResult {
  const claimTerms = extractQueryTerms(input.claim);
  const entityHits = entityProbe(claimTerms, input.claim, input.entities);
  const relationHits = relationProbe(claimTerms, input.claim, input.relations);
  const passageHits = passageProbe(input);

  const collision = relationHits.length > 0 || entityHits.length >= 2;
  const partial = !collision && (entityHits.length === 1 || passageHits.length > 0);
  const verdict: NoveltyCheckResult["verdict"] = collision ? "collision" : partial ? "partial" : "no-collision";
  const note = collision
    ? "this knowledge base already covers the claim's subject matter — reframe as building on it, or verify the delta explicitly"
    : partial
      ? "weak overlap inside this knowledge base — the claim is not fully covered either"
      : "no overlap inside this knowledge base — this alone says nothing about the wider literature (external counter-evidence, when configured, lands in the result's `novelty` section; absence of evidence is not evidence of absence)";
  return {
    kbId: input.kbId,
    claim: input.claim,
    verdict,
    entityHits,
    relationHits,
    passageHits,
    note,
  };
}

// ------------------------------------------------------- three-tier brief

export interface BriefKbUncertainty {
  readonly kbId: string;
  readonly kbName: string;
  /** contradicts/contrasts_with edges — open conflicts, hedge required. */
  readonly conflicts: readonly { aName: string; bName: string; type: string; quote: string | null }[];
  /** entities backed by a single document — single-source, hedge required. */
  readonly singleSource: readonly string[];
  readonly entityCount: number;
  readonly edgeCount: number;
}

const CONFLICT_TYPES = new Set(["contradicts", "contrasts_with"]);
const BRIEF_MAX_CHARS = 2_000;
const BRIEF_CLOSING = "\n</anti_hallucination>";

/** Entity/conflict names are extraction-derived text — escape them before
 *  they land inside the XML-ish markup (same hygiene as the digest's
 *  escapeAttr in the contributor). */
function escapeBriefText(value: string): string {
  return value.replace(/[<>"&]/g, (char) => `&#${char.codePointAt(0)};`);
}

/**
 * The three-tier anti-hallucination context section. Tier 1 points at the
 * resident summary (no duplication); tier 2 lists what is uncertain; tier 3
 * states the non-negotiable rules. Pure text, deterministic, capped.
 */
export function buildAntiHallucinationBrief(kbs: readonly BriefKbUncertainty[]): string | null {
  if (kbs.length === 0) return null;
  const lines: string[] = [
    "<anti_hallucination>",
    "VERIFIED (cite freely): only the entities and relations in the resident summary above, with their support counts. Anything else must pass validate_entities before being presented as a knowledge-base fact.",
    "UNCERTAIN (hedge with 'reported/single-source/unresolved'):",
  ];
  for (const kb of kbs) {
    if (kb.conflicts.length === 0 && kb.singleSource.length === 0) continue;
    lines.push(`- KB ${escapeBriefText(kb.kbName)}:`);
    for (const conflict of kb.conflicts.slice(0, 5)) {
      lines.push(`  conflict: ${escapeBriefText(conflict.aName)} ${escapeBriefText(conflict.type)} ${escapeBriefText(conflict.bName)}${conflict.quote ? ` — “${escapeBriefText(conflict.quote.slice(0, 120))}”` : ""}`);
    }
    if (kb.conflicts.length > 5) lines.push(`  … +${kb.conflicts.length - 5} more conflicts`);
    if (kb.singleSource.length > 0) {
      lines.push(`  single-source entities (${kb.singleSource.length}): ${kb.singleSource.slice(0, 8).map(escapeBriefText).join(", ")}${kb.singleSource.length > 8 ? " …" : ""}`);
    }
  }
  if (lines.length === 3) lines.push("- none: no open conflicts or single-source entities in the tracked KBs");
  lines.push(
    "FORBIDDEN (never): fabricate entities, relations, or quotes; present an unverified number as coming from a paper; treat 'not in the KB' as 'not in the literature'.",
    "Before asserting: validate_entities (names), verify_citation (quotes), novelty_check (novelty claims), evidence_ledger (record what you will assert). If a check fails or is unavailable — say so instead.",
    "</anti_hallucination>",
  );
  const text = lines.join("\n");
  // The cap must hold for the WHOLE section including the closing tag.
  return text.length <= BRIEF_MAX_CHARS
    ? text
    : `${text.slice(0, BRIEF_MAX_CHARS - BRIEF_CLOSING.length)}${BRIEF_CLOSING}`;
}

/** Extract the uncertain signals from raw entity/edge rows (composition
 * helper for the port layer: bounded, deterministic). */
export function briefUncertaintyFrom(kb: { id: string; name: string }, rows: {
  entities: readonly { name: string; supportCount: number }[];
  edges: readonly { type: string; sourceName: string; targetName: string; quote: string | null }[];
}): BriefKbUncertainty {
  return {
    kbId: kb.id,
    kbName: kb.name,
    conflicts: rows.edges
      .filter((edge) => CONFLICT_TYPES.has(edge.type))
      .map((edge) => ({ aName: edge.sourceName, bName: edge.targetName, type: edge.type, quote: edge.quote }))
      .slice(0, 10),
    singleSource: rows.entities.filter((entity) => entity.supportCount <= 1).map((entity) => entity.name).slice(0, 20),
    entityCount: rows.entities.length,
    edgeCount: rows.edges.length,
  };
}

// --------------------------------------------- external counter-evidence (V1-Z1)
// Port of SA's novelty-check external stage: Semantic Scholar first (one
// backoff retry on retryable failures), OpenAlex as fallback, per-source
// structured ProbeStatus — a failed source can never read as "no prior art".

/** PU principle wording, always attached to the combined verdict. */
export const PU_CAVEAT_NOVEL =
  "PU principle: unseen ≠ nonexistent. 'novel' only means no item reached the similarity threshold within " +
  "the searches actually completed this run; coverage is limited (internal scope: ingested and extracted KB " +
  "content; external scope: Semantic Scholar / OpenAlex indexes) — identical or substantially similar work " +
  "may exist in sources not covered.";
export const PU_CAVEAT_SIMILAR =
  "Similarity is decided by deterministic lexical/structural signals (claim-word coverage, entity-name " +
  "overlap, direct graph edges), not semantic equivalence; each listed item's actual relation to the claim " +
  "needs human review.";
export const PU_CAVEAT_INCONCLUSIVE =
  "'inconclusive' means this run produced insufficient novelty evidence (search scope unavailable or the " +
  "claim too weak); it must be read as neither 'novel' nor 'prior work exists'.";

export const NOVELTY_MIN_CLAIM_WORDS = 3;
export const NOVELTY_SIMILAR_COVERAGE = 0.5;
export const NOVELTY_EXTERNAL_RESULT_LIMIT = 5;
/** Deterministic score assigned to a direct KB graph edge between claim entities. */
const NOVELTY_EDGE_SIGNAL_SCORE = 1.0;
/** Combined similar-items list cap. */
const NOVELTY_MAX_SIMILAR_ITEMS = 10;
/** S2/OpenAlex query text cap (API query length guard). */
const NOVELTY_QUERY_CHARS = 300;
/** Backoff before the single S2 retry on a retryable failure. */
const NOVELTY_DEFAULT_BACKOFF_MS = 2_000;

export interface NoveltyExternalPaper {
  readonly title: string;
  readonly year?: number | null;
  readonly url?: string | null;
  readonly venue?: string | null;
  readonly abstract?: string | null;
}

export type NoveltyExternalSourceName = "semantic-scholar" | "openalex";

/** A search source injected by the port layer (connector-backed in production). */
export interface NoveltyExternalSource {
  readonly name: NoveltyExternalSourceName;
  search(claim: string, limit: number): Promise<readonly NoveltyExternalPaper[]>;
}

export interface NoveltyExternalItem {
  readonly title: string;
  readonly source: NoveltyExternalSourceName;
  /** Claim-word coverage in [0,1]. */
  readonly coverage: number;
  readonly aboveThreshold: boolean;
  readonly reason: string;
  readonly snippet?: string;
  readonly link?: string | null;
  readonly year?: number | null;
}

export interface NoveltyExternalSection {
  readonly status: "ok" | "empty" | "error" | "disabled";
  readonly checkedSources: readonly string[];
  readonly error?: string;
  readonly candidates: number;
  readonly items: readonly NoveltyExternalItem[];
}

export interface NoveltyCombined {
  readonly verdict: "novel" | "similar-found" | "inconclusive";
  readonly caveat: string;
  readonly reasons: readonly string[];
  readonly similarItems: readonly (NoveltyExternalItem | {
    readonly title: string;
    readonly source: "kb-graph";
    readonly coverage: number;
    readonly aboveThreshold: boolean;
    readonly reason: string;
    readonly link: null;
  })[];
}

/** Unicode-aware content-word set; CJK single characters stay searchable. */
function normalizeClaimWords(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/)
      .filter((word) => word.length > 2 || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(word)),
  );
}

function claimCoverage(claimWords: ReadonlySet<string>, text: string): number {
  if (claimWords.size === 0) return 0;
  const textWords = normalizeClaimWords(text);
  let hit = 0;
  for (const word of claimWords) {
    if (textWords.has(word)) hit += 1;
  }
  return hit / claimWords.size;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function assessExternalPapers(
  claimWords: ReadonlySet<string>,
  papers: readonly NoveltyExternalPaper[],
  source: NoveltyExternalSourceName,
  threshold: number,
): NoveltyExternalItem[] {
  return papers.map((paper) => {
    const coverage = claimCoverage(claimWords, `${paper.title}\n${paper.abstract ?? ""}`);
    return {
      title: paper.title,
      source,
      coverage,
      aboveThreshold: coverage >= threshold,
      reason:
        `external index hit; claim-word coverage ${percent(coverage)} (threshold ${percent(threshold)})` +
        (paper.year != null ? `; year ${paper.year}` : "") +
        (paper.venue ? `; ${paper.venue}` : ""),
      ...(paper.abstract ? { snippet: paper.abstract.slice(0, 300) } : {}),
      link: paper.url ?? null,
      year: paper.year ?? null,
    };
  });
}

function isRetryableExternalError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP 429|HTTP 5\d\d|timed? ?out|abort/i.test(message);
}

/** S2-first with one backoff retry, OpenAlex fallback (SA semantics). */
export async function runExternalNoveltyStage(
  claim: string,
  sources: readonly NoveltyExternalSource[],
  options: { backoffMs?: number } = {},
): Promise<NoveltyExternalSection> {
  const claimWords = normalizeClaimWords(claim);
  const threshold = NOVELTY_SIMILAR_COVERAGE;
  const primary = sources.find((source) => source.name === "semantic-scholar");
  const fallback = sources.find((source) => source.name === "openalex");
  if (!primary && !fallback) {
    return { status: "disabled", checkedSources: [], error: "no external search sources configured", candidates: 0, items: [] };
  }
  const query = claim.slice(0, NOVELTY_QUERY_CHARS);
  const checked: string[] = [];
  const sleep = (ms: number) => (ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms)));

  let primaryError: string | null = null;
  if (primary) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        checked.push(attempt === 0 ? primary.name : `${primary.name}(retry)`);
        const papers = await primary.search(query, NOVELTY_EXTERNAL_RESULT_LIMIT);
        return {
          status: papers.length > 0 ? "ok" : "empty",
          checkedSources: checked,
          candidates: papers.length,
          items: assessExternalPapers(claimWords, papers, primary.name, threshold),
        };
      } catch (error) {
        primaryError = error instanceof Error ? error.message : String(error);
        if (!isRetryableExternalError(error) || attempt === 1) break;
        await sleep(options.backoffMs ?? NOVELTY_DEFAULT_BACKOFF_MS);
      }
    }
  }

  if (fallback) {
    try {
      checked.push(fallback.name);
      const papers = await fallback.search(query, NOVELTY_EXTERNAL_RESULT_LIMIT);
      return {
        status: papers.length > 0 ? "ok" : "empty",
        checkedSources: checked,
        ...(primaryError ? { error: `semantic-scholar unavailable (${primaryError}); degraded to openalex` } : {}),
        candidates: papers.length,
        items: assessExternalPapers(claimWords, papers, fallback.name, threshold),
      };
    } catch (error) {
      const fallbackError = error instanceof Error ? error.message : String(error);
      return {
        status: "error",
        checkedSources: checked,
        error: `semantic-scholar: ${primaryError ?? "not configured"}; openalex: ${fallbackError}`,
        candidates: 0,
        items: [],
      };
    }
  }

  return {
    status: "error",
    checkedSources: checked,
    error: `semantic-scholar: ${primaryError ?? "not configured"}`,
    candidates: 0,
    items: [],
  };
}

/** Compose the internal KB probes and the external stage into one verdict.
 *  Pure: any inputs in, verdict out (SA's better-to-miss-than-to-overclaim
 *  ordering — found evidence wins, probe errors degrade novel to
 *  inconclusive, a skipped external stage is disclosed, never hidden). */
export function combineNovelty(input: {
  claim: string;
  internal: NoveltyCheckResult;
  external: NoveltyExternalSection | null;
}): NoveltyCombined {
  const claimWords = normalizeClaimWords(input.claim);
  const reasons: string[] = [];
  if (claimWords.size < NOVELTY_MIN_CLAIM_WORDS) {
    reasons.push(
      `claim normalizes to only ${claimWords.size} content word(s) (need >= ${NOVELTY_MIN_CLAIM_WORDS}) — not a reliable search term set`,
    );
    return { verdict: "inconclusive", caveat: PU_CAVEAT_INCONCLUSIVE, reasons, similarItems: [] };
  }

  const internalCollision = input.internal.verdict === "collision";
  const graphItems = input.internal.relationHits.map((hit) => ({
    title: `${hit.sourceName} —[${hit.type}]→ ${hit.targetName}`,
    source: "kb-graph" as const,
    coverage: NOVELTY_EDGE_SIGNAL_SCORE,
    aboveThreshold: true,
    reason: "direct graph edge between claim entities inside the knowledge base",
    link: null,
  }));
  const items = [...graphItems, ...(input.external?.items ?? [])]
    .sort((a, b) => b.coverage - a.coverage || a.source.localeCompare(b.source) || a.title.localeCompare(b.title))
    .slice(0, NOVELTY_MAX_SIMILAR_ITEMS);

  if (internalCollision || items.some((item) => item.aboveThreshold)) {
    return { verdict: "similar-found", caveat: PU_CAVEAT_SIMILAR, reasons, similarItems: items };
  }

  if (input.external?.status === "error") {
    // A failed external probe means absence cannot be claimed.
    reasons.push(`external counter-evidence failed: ${input.external.error ?? "unknown error"}`);
    return { verdict: "inconclusive", caveat: PU_CAVEAT_INCONCLUSIVE, reasons, similarItems: items };
  }

  if (input.external === null || input.external.status === "disabled") {
    const scopeNote = input.external === null
      ? "external stage not executed (no sources configured)"
      : `external stage skipped (${input.external.error ?? "disabled"})`;
    return {
      verdict: "novel",
      caveat: `${PU_CAVEAT_NOVEL} (Note: ${scopeNote} — this verdict covers the internal knowledge-base scope only.)`,
      reasons,
      similarItems: items,
    };
  }

  return { verdict: "novel", caveat: PU_CAVEAT_NOVEL, reasons, similarItems: items };
}
