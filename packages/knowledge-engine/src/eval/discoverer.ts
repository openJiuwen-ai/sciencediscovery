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
 * Discoverer-eval scoring core (L4 "discoverer" tasks), ported from the
 * DeepAnalyze scripts/discoverer-eval harness. Pure and IO-free — the CLI
 * (scripts/ke-discoverer-eval.mjs) owns file/process IO.
 *
 * Task kinds (dataset.kind):
 *   novelty-triage — three-way novelty triage: novel / similar-found /
 *                    inconclusive for a claim. Scored from PRE-COLLECTED
 *                    outputs (the live collector needs a credentialed stack;
 *                    the scorer itself is deterministic).
 *   gap-hit        — structural gap hits: the dataset carries inline graphs
 *                    (entities+edges) + gold gap lists; the executor is the
 *                    production findGaps (in-process), scored by entity-pair
 *                    intersection (predicate-agnostic).
 *
 * Integrity dimensions, reported alongside triage accuracy:
 *   1. overclaim — strong-assertion lexicon hits ("首次发现"/"unprecedented"…)
 *      on items whose gold does not support strong claims;
 *   2. citation precheck — quoted spans checked verbatim against the
 *      dataset's reference sources;
 *   3. abstention calibration — overCautious (similar-found gold answered
 *      inconclusive) vs justified inconclusive (novel-gold, PU principle).
 */

import { findGaps, type GapAnalysis } from "../graph/gaps.js";
import { normalizeEntityName } from "../resolution/normalize.js";

// --- Dataset format ---------------------------------------------------------------

export type NoveltyVerdict = "novel" | "similar-found" | "inconclusive";

export type DiscovererKind = "novelty-triage" | "gap-hit";

export interface DiscovererItem {
  id: string;
  /** The claim to triage. */
  claim: string;
  /** Gold three-way label. */
  gold: NoveltyVerdict;
  /** Acceptable verdicts (default [gold]; novel items accept inconclusive too — PU). */
  goldAccept?: NoveltyVerdict[];
  note?: string;
  /** Reference source ids (dataset.sources) for the citation precheck. */
  evidenceSources?: string[];
  /** true → strong-assertion lexicon hits are NOT overclaims for this item. */
  supportsStrongClaims?: boolean;
}

export interface DiscovererDataset {
  id: string;
  kind: DiscovererKind;
  description?: string;
  construction?: unknown;
  /** Reference corpus for the citation precheck. */
  sources?: Record<string, string>;
  items?: Array<DiscovererItem | GapHitItem>;
}

export interface GapHitEntity {
  id: string;
  name: string;
  type: string;
  supportCount?: number;
  communityId?: number | null;
}

export interface GapHitEdge {
  subject: string;
  predicate: string;
  object: string;
}

export interface GapHitGraph {
  entities: GapHitEntity[];
  edges: GapHitEdge[];
}

export interface GapHitGold {
  type: "missing-edge" | "missing-entity";
  subject?: string;
  object?: string;
  /** missing-entity golds can never be produced by findGaps — counted as
   *  unmatchableGold, excluded from hit-rate denominators. */
  entity?: string;
  note?: string;
}

export interface GapHitItem {
  id: string;
  note?: string;
  graph: GapHitGraph;
  goldGaps: GapHitGold[];
}

export interface GapHitThresholds {
  minCommon?: number;
}

export interface GapHitDataset extends Omit<DiscovererDataset, "kind" | "items"> {
  kind: "gap-hit";
  thresholds?: GapHitThresholds;
  items: GapHitItem[];
}

/** gap-hit topN per item (holes/transfers each) — the k of the hit@k metric. */
export const GAP_HIT_TOP_N = 25;

const VALID_GOLD_GAP_TYPES: ReadonlySet<string> = new Set(["missing-edge", "missing-entity"]);
const VALID_VERDICTS: ReadonlySet<string> = new Set(["novel", "similar-found", "inconclusive"]);

function validateGapHitDataset(raw: DiscovererDataset): void {
  const items = raw.items as GapHitItem[] | undefined;
  if (!Array.isArray(items) || items.length === 0) throw new Error("gap-hit dataset has no items");
  const itemIds = new Set<string>();
  for (const it of items) {
    if (!it.id || typeof it.id !== "string") throw new Error(`gap-hit item missing id: ${JSON.stringify(it).slice(0, 80)}`);
    if (itemIds.has(it.id)) throw new Error(`gap-hit duplicate item id: ${it.id}`);
    itemIds.add(it.id);
    const g = it.graph;
    if (!g || !Array.isArray(g.entities) || g.entities.length === 0) {
      throw new Error(`gap-hit item ${it.id} missing graph.entities`);
    }
    if (!Array.isArray(g.edges)) throw new Error(`gap-hit item ${it.id} missing graph.edges`);
    const entIds = new Set<string>();
    for (const e of g.entities) {
      if (!e.id || !e.name || !e.type) throw new Error(`gap-hit item ${it.id} entity missing id/name/type`);
      if (entIds.has(e.id)) throw new Error(`gap-hit item ${it.id} duplicate entity id: ${e.id}`);
      entIds.add(e.id);
    }
    for (const e of g.edges) {
      if (!entIds.has(e.subject)) throw new Error(`gap-hit item ${it.id} edge references unknown entity: ${e.subject}`);
      if (!entIds.has(e.object)) throw new Error(`gap-hit item ${it.id} edge references unknown entity: ${e.object}`);
      if (!e.predicate) throw new Error(`gap-hit item ${it.id} edge missing predicate`);
    }
    if (!Array.isArray(it.goldGaps)) throw new Error(`gap-hit item ${it.id} missing goldGaps`);
    for (const gold of it.goldGaps) {
      if (!VALID_GOLD_GAP_TYPES.has(gold.type)) throw new Error(`gap-hit item ${it.id} illegal gold type: ${String(gold.type)}`);
      if (gold.type === "missing-edge") {
        if (!gold.subject || !entIds.has(gold.subject)) throw new Error(`gap-hit item ${it.id} gold references unknown entity`);
        if (!gold.object || !entIds.has(gold.object)) throw new Error(`gap-hit item ${it.id} gold references unknown entity`);
        // findGaps' pairwise i<j loop never produces self-pairs — a self-pair
        // gold would sit in the denominator unhittable: reject the dataset.
        if (gold.subject === gold.object) throw new Error(`gap-hit item ${it.id} gold is a self-pair: ${String(gold.subject)}`);
      } else if (!gold.entity || typeof gold.entity !== "string") {
        throw new Error(`gap-hit item ${it.id} missing-entity gold lacks entity name`);
      }
    }
  }
}

/** Parse + validate a discoverer dataset from raw JSON text. */
export function loadDiscovererDataset(jsonText: string): DiscovererDataset {
  const raw = JSON.parse(jsonText) as DiscovererDataset;
  if (!raw.id || typeof raw.id !== "string") throw new Error("dataset missing id");
  if (raw.kind !== "novelty-triage" && raw.kind !== "gap-hit") {
    throw new Error(`unknown dataset kind: ${String(raw.kind)} (expected novelty-triage / gap-hit)`);
  }
  if (raw.kind === "novelty-triage") {
    const items = raw.items as DiscovererItem[] | undefined;
    if (!Array.isArray(items) || items.length === 0) throw new Error("novelty-triage dataset has no items");
    for (const it of items) {
      if (!it.id || !it.claim) throw new Error(`item missing id/claim: ${JSON.stringify(it).slice(0, 80)}`);
      if (!VALID_VERDICTS.has(it.gold)) throw new Error(`item ${it.id} illegal gold: ${String(it.gold)}`);
      for (const v of it.goldAccept ?? []) {
        if (!VALID_VERDICTS.has(v)) throw new Error(`item ${it.id} illegal goldAccept: ${String(v)}`);
      }
      for (const sid of it.evidenceSources ?? []) {
        if (!raw.sources?.[sid]) throw new Error(`item ${it.id} references unknown evidenceSource: ${sid}`);
      }
    }
  }
  if (raw.kind === "gap-hit") validateGapHitDataset(raw);
  return raw;
}

export function loadGapHitDataset(jsonText: string): GapHitDataset {
  const ds = loadDiscovererDataset(jsonText);
  if (ds.kind !== "gap-hit") throw new Error(`not a gap-hit dataset: ${ds.kind}`);
  return ds as unknown as GapHitDataset;
}

// --- Verdict extraction -----------------------------------------------------------

const VERDICT_ALIASES: Record<string, NoveltyVerdict> = {
  "novel": "novel",
  "similar-found": "similar-found",
  "similarfound": "similar-found",
  "similar found": "similar-found",
  "inconclusive": "inconclusive",
  // Chinese fallbacks (an agent answering in Chinese is still scoreable)
  "新颖": "novel",
  "已有相似": "similar-found",
  "已存在": "similar-found",
  "无法判定": "inconclusive",
  "不确定": "inconclusive",
};

/** Extract the LAST "Answer: <verdict>" line from an agent's final output. */
export function extractVerdict(output: string): NoveltyVerdict | undefined {
  const matches = [...output.matchAll(/answer\s*[:：]\s*\*?\*?([A-Za-z][A-Za-z -]{2,20}|新颖|已有相似|已存在|无法判定|不确定)/gi)];
  for (let i = matches.length - 1; i >= 0; i--) {
    const norm = matches[i]![1]!.trim().toLowerCase().replace(/\s+/g, " ");
    const verdict = VERDICT_ALIASES[norm];
    if (verdict) return verdict;
  }
  return undefined;
}

// --- Three-way scoring ------------------------------------------------------------

export interface DiscovererItemResult {
  id: string;
  gold: NoveltyVerdict;
  extracted?: NoveltyVerdict;
  correct: boolean;
  durationMs: number;
  sessionId?: string;
  error?: string;
  /** Overclaim lexicon hits (filled during integrity scoring). */
  overclaims?: string[];
}

export interface DiscovererMetrics {
  total: number;
  answered: number;
  errors: number;
  correct: number;
  /** accuracy = correct / total (errors included). */
  accuracy: number;
  perClass: Record<string, { total: number; correct: number; recall: number }>;
  /** similar-found gold answered novel — the most dangerous novelty miss. */
  falseNovel: number;
  /** constructed-novel gold answered similar-found (false prior-art alarm). */
  falseSimilar: number;
  /** similar-found gold answered inconclusive (over-cautious abstention). */
  overCautious: number;
}

export function acceptedSet(item: DiscovererItem): ReadonlySet<NoveltyVerdict> {
  return new Set(item.goldAccept ?? [item.gold]);
}

export function scoreDiscoverer(results: DiscovererItemResult[], items: DiscovererItem[]): DiscovererMetrics {
  const itemMap = new Map(items.map((it) => [it.id, it]));
  let total = 0;
  let answered = 0;
  let errors = 0;
  let correct = 0;
  let falseNovel = 0;
  let falseSimilar = 0;
  let overCautious = 0;
  const perClass = new Map<string, { total: number; correct: number }>();
  for (const r of results) {
    const item = itemMap.get(r.id);
    if (!item) continue;
    total++;
    const cls = perClass.get(item.gold) ?? { total: 0, correct: 0 };
    cls.total++;
    perClass.set(item.gold, cls);
    if (r.error || r.extracted === undefined) {
      errors++;
      continue;
    }
    answered++;
    const ok = acceptedSet(item).has(r.extracted);
    if (ok) {
      correct++;
      cls.correct++;
    }
    if (r.extracted === "novel" && item.gold === "similar-found") falseNovel++;
    if (r.extracted === "similar-found" && item.gold !== "similar-found") falseSimilar++;
    if (r.extracted === "inconclusive" && item.gold === "similar-found") overCautious++;
  }
  const perClassOut: Record<string, { total: number; correct: number; recall: number }> = {};
  for (const [k, v] of perClass) {
    perClassOut[k] = { total: v.total, correct: v.correct, recall: v.total > 0 ? (v.correct / v.total) * 100 : 0 };
  }
  return {
    total,
    answered,
    errors,
    correct,
    accuracy: total > 0 ? (correct / total) * 100 : 0,
    perClass: perClassOut,
    falseNovel,
    falseSimilar,
    overCautious,
  };
}

// --- Overclaim detection (deterministic heuristic) --------------------------------

/**
 * Strong-assertion lexicon: claims of firsts/breakthroughs/gap-filling. Gold
 * never supports such assertions (supportsStrongClaims defaults false), so a
 * hit flags the item. The heuristic only guarantees neutral phrasing is not
 * falsely flagged — rhetorical variants can slip through (noted in reports).
 */
export const OVERCLAIM_LEXICON: readonly string[] = [
  "首次发现", "首次提出", "首次报道", "全球首创", "国际首创", "世界首创",
  "前所未有", "史无前例", "填补空白", "填补了空白", "填补国内空白", "填补国际空白",
  "突破性进展", "革命性", "原创性突破",
  "first ever", "first-ever", "world-first", "world's first",
  "unprecedented", "groundbreaking", "revolutionary", "first of its kind",
];

/** Strong-assertion lexicon hits in an output (case-insensitive, deduped). */
export function detectOverclaims(output: string): string[] {
  const lower = output.toLowerCase();
  const hits = new Set<string>();
  for (const phrase of OVERCLAIM_LEXICON) {
    if (lower.includes(phrase.toLowerCase())) hits.add(phrase);
  }
  return [...hits];
}

// --- Citation precheck ------------------------------------------------------------

/** Quote/source normalization for verbatim matching: unicode dashes fold to
 *  '-', whitespace collapses, case folds (DA citation-eval parity). */
export function normalizeForMatch(text: string): string {
  return text
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export type QuoteCheckStatus = "exact" | "normalized" | "missing" | "no-quote" | "no-source";

/** Whether the quote appears verbatim in the source text. */
export function checkQuoteVerbatim(quote: string | undefined, sourceText: string | undefined): QuoteCheckStatus {
  if (!quote || !quote.trim()) return "no-quote";
  if (sourceText === undefined) return "no-source";
  if (sourceText.includes(quote)) return "exact";
  if (normalizeForMatch(sourceText).includes(normalizeForMatch(quote))) return "normalized";
  return "missing";
}

/** Extract quoted spans (≥12 chars; shorter ones are rhetorical, skipped). */
export function extractQuotedSpans(output: string): string[] {
  const spans: string[] = [];
  for (const m of output.matchAll(/"([^"\n]{12,})"|"([^"\n]{12,})"|「([^」\n]{12,})」/g)) {
    const s = (m[1] ?? m[2] ?? m[3])!.trim();
    if (s) spans.push(s);
  }
  return spans;
}

export interface CitationPrecheckMetrics {
  quotesFound: number;
  verbatim: number;
  normalized: number;
  missing: number;
  /** (verbatim+normalized)/quotesFound; null when no quotes. */
  verbatimRate: number | null;
}

/** Precheck quotes of one output: a quote passes when it hits ANY of the
 *  item's declared evidence sources verbatim. */
export function precheckQuotes(
  quotes: string[],
  sourceTexts: string[],
): { verbatim: number; normalized: number; missing: number } {
  let verbatim = 0;
  let normalized = 0;
  let missing = 0;
  for (const q of quotes) {
    let best: "verbatim" | "normalized" | "missing" = "missing";
    for (const src of sourceTexts) {
      const st = checkQuoteVerbatim(q, src);
      if (st === "exact") {
        best = "verbatim";
        break;
      }
      if (st === "normalized") best = "normalized";
    }
    if (best === "verbatim") verbatim++;
    else if (best === "normalized") normalized++;
    else missing++;
  }
  return { verbatim, normalized, missing };
}

// --- Integrity aggregation ---------------------------------------------------------

export interface IntegrityMetrics {
  overclaim: {
    evaluated: number;
    flagged: number;
    rate: number | null;
    flaggedIds: string[];
  };
  abstention: {
    inconclusive: number;
    /** gold accepts inconclusive (novel items) — justified abstention. */
    justified: number;
    overCautious: number;
  };
  /** Present only when the citation precheck is enabled. */
  citation: CitationPrecheckMetrics | null;
}

/**
 * Aggregate integrity metrics. outputsById: the final output text of each
 * scored item (input to overclaim + quote precheck); withCitation prechecks
 * quotes for items that declare evidenceSources.
 */
export function computeIntegrity(
  results: DiscovererItemResult[],
  items: DiscovererItem[],
  outputsById: ReadonlyMap<string, string>,
  sources: Record<string, string> | undefined,
  withCitation: boolean,
): IntegrityMetrics {
  const itemMap = new Map(items.map((it) => [it.id, it]));
  let evaluated = 0;
  let flagged = 0;
  const flaggedIds: string[] = [];
  let inconclusive = 0;
  let justified = 0;
  let overCautious = 0;
  let quotesFound = 0;
  let verbatim = 0;
  let normalizedHits = 0;
  let missing = 0;

  for (const r of results) {
    const item = itemMap.get(r.id);
    if (!item || r.error) continue;
    if (r.extracted === "inconclusive") {
      inconclusive++;
      if (acceptedSet(item).has("inconclusive")) justified++;
      else if (item.gold === "similar-found") overCautious++;
    }
    const output = outputsById.get(r.id);
    if (output === undefined) continue;
    evaluated++;
    const hits = detectOverclaims(output);
    if (hits.length > 0 && item.supportsStrongClaims !== true) {
      flagged++;
      flaggedIds.push(r.id);
      r.overclaims = hits;
    }
    if (withCitation && (item.evidenceSources?.length ?? 0) > 0) {
      const srcTexts = item.evidenceSources!.map((sid) => sources?.[sid]).filter((t): t is string => !!t);
      const quotes = extractQuotedSpans(output);
      const agg = precheckQuotes(quotes, srcTexts);
      quotesFound += quotes.length;
      verbatim += agg.verbatim;
      normalizedHits += agg.normalized;
      missing += agg.missing;
    }
  }

  return {
    overclaim: {
      evaluated,
      flagged,
      rate: evaluated > 0 ? (flagged / evaluated) * 100 : null,
      flaggedIds,
    },
    abstention: { inconclusive, justified, overCautious },
    citation: withCitation
      ? {
          quotesFound,
          verbatim,
          normalized: normalizedHits,
          missing,
          verbatimRate: quotesFound > 0 ? ((verbatim + normalizedHits) / quotesFound) * 100 : null,
        }
      : null,
  };
}

// --- gap-hit executor (production findGaps, in-process) ---------------------------

/** Entity pair ignoring predicate: unordered normalized name pair.
 *  NOTE: uses SD normalization (NFKC/case/whitespace), not DA's
 *  hyphen/underscore-folding variant — safe in-harness because gold and
 *  produced names derive from the same graph entities; cross-source
 *  matching must not assume DA semantics. */
export function pairKeyOf(nameA: string, nameB: string): string {
  const x = normalizeEntityName(nameA);
  const y = normalizeEntityName(nameB);
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

export interface GapHitProducedPair {
  pair: string;
  signal: "holes" | "transfers";
}

/**
 * findGaps output → deduped entity-pair set. holes contribute (a,b);
 * transfers contribute (method,to) — a transfer hypothesis IS a missing edge
 * between method and to. A pair produced by both signals counts as holes
 * (scanned first).
 */
export function producedPairs(analysis: GapAnalysis): GapHitProducedPair[] {
  const seen = new Map<string, "holes" | "transfers">();
  for (const h of analysis.holes) seen.set(pairKeyOf(h.a.name, h.b.name), "holes");
  for (const t of analysis.transfers) {
    const k = pairKeyOf(t.method.name, t.to.name);
    if (!seen.has(k)) seen.set(k, "transfers");
  }
  return [...seen.entries()].map(([pair, signal]) => ({ pair, signal }));
}

export interface GapHitGoldMatch {
  gold: GapHitGold;
  /** Normalized entity pair (empty string when unmatchable). */
  pair: string;
  matchable: boolean;
  hit: boolean;
  matchedSignal?: "holes" | "transfers";
}

/** Per-gold matching: missing-edge normalizes to an unordered pair,
 *  intersected with the produced pairs. */
export function matchGapHits(analysis: GapAnalysis, item: GapHitItem): GapHitGoldMatch[] {
  const byId = new Map(item.graph.entities.map((e) => [e.id, e]));
  const produced = new Map(producedPairs(analysis).map((p) => [p.pair, p.signal]));
  return item.goldGaps.map((gold) => {
    if (gold.type !== "missing-edge") return { gold, pair: "", matchable: false, hit: false };
    const a = byId.get(gold.subject!)!;
    const b = byId.get(gold.object!)!;
    const pair = pairKeyOf(a.name, b.name);
    const signal = produced.get(pair);
    return { gold, pair, matchable: true, hit: signal !== undefined, ...(signal ? { matchedSignal: signal } : {}) };
  });
}

export interface GapHitItemScore {
  id: string;
  durationMs: number;
  holesProduced: number;
  transfersProduced: number;
  /** Deduped produced pairs (holes+transfers). */
  producedPairs: number;
  /** Produced pairs that hit gold. */
  producedHit: number;
  goldTotal: number;
  goldHit: number;
  /** missing-entity golds (unmatchable, honestly counted aside). */
  unmatchableGold: number;
  /** goldHit/goldTotal; null when no matchable gold. */
  hitRate: number | null;
  /** producedHit/producedPairs; null when nothing produced. */
  precision: number | null;
  error?: string;
}

export function scoreGapHit(analysis: GapAnalysis, item: GapHitItem, durationMs = 0): GapHitItemScore {
  const matches = matchGapHits(analysis, item);
  const pairs = producedPairs(analysis);
  const producedSet = new Set(pairs.map((p) => p.pair));
  const goldPairSet = new Set(matches.filter((m) => m.matchable).map((m) => m.pair));
  const goldTotal = goldPairSet.size;
  const goldHit = [...goldPairSet].filter((p) => producedSet.has(p)).length;
  const producedHit = pairs.filter((p) => goldPairSet.has(p.pair)).length;
  return {
    id: item.id,
    durationMs,
    holesProduced: analysis.holes.length,
    transfersProduced: analysis.transfers.length,
    producedPairs: pairs.length,
    producedHit,
    goldTotal,
    goldHit,
    unmatchableGold: matches.filter((m) => !m.matchable).length,
    hitRate: goldTotal > 0 ? goldHit / goldTotal : null,
    precision: pairs.length > 0 ? producedHit / pairs.length : null,
  };
}

export interface GapHitMetrics {
  items: number;
  errors: number;
  goldTotal: number;
  goldHit: number;
  unmatchableGold: number;
  producedPairs: number;
  producedHit: number;
  microHitRate: number | null;
  macroHitRate: number | null;
  microPrecision: number | null;
  macroPrecision: number | null;
}

export function aggregateGapHit(scores: GapHitItemScore[]): GapHitMetrics {
  const ok = scores.filter((s) => !s.error);
  const sum = (f: (s: GapHitItemScore) => number) => ok.reduce((acc, s) => acc + f(s), 0);
  const meanOf = (vals: Array<number | null>): number | null => {
    const nums = vals.filter((v): v is number => v !== null);
    return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  };
  const goldTotal = sum((s) => s.goldTotal);
  const goldHit = sum((s) => s.goldHit);
  const producedPairsN = sum((s) => s.producedPairs);
  const producedHit = sum((s) => s.producedHit);
  return {
    items: scores.length,
    errors: scores.length - ok.length,
    goldTotal,
    goldHit,
    unmatchableGold: sum((s) => s.unmatchableGold),
    producedPairs: producedPairsN,
    producedHit,
    microHitRate: goldTotal > 0 ? goldHit / goldTotal : null,
    macroHitRate: meanOf(ok.map((s) => s.hitRate)),
    microPrecision: producedPairsN > 0 ? producedHit / producedPairsN : null,
    macroPrecision: meanOf(ok.map((s) => s.precision)),
  };
}

/** Run the production findGaps on one item's inline graph and score it
 *  (in-process, zero services — the SD findGaps is already pure/sync). */
export function runGapHitItem(item: GapHitItem, thresholds?: GapHitThresholds): GapHitItemScore {
  const started = Date.now();
  try {
    const analysis = findGaps(
      item.graph.entities.map((e) => ({
        id: e.id,
        name: e.name,
        type: e.type,
        supportCount: e.supportCount ?? 1,
        communityId: e.communityId ?? null,
      })),
      item.graph.edges.map((e, i) => ({
        id: `ge${i}`,
        srcId: e.subject,
        dstId: e.object,
        type: e.predicate,
        supportCount: 1,
        evidenceQuote: null,
      })),
      {
        topN: GAP_HIT_TOP_N,
        ...(thresholds?.minCommon !== undefined ? { minCommon: thresholds.minCommon } : {}),
      },
    );
    return scoreGapHit(analysis, item, Date.now() - started);
  } catch (err) {
    return {
      id: item.id,
      durationMs: Date.now() - started,
      holesProduced: 0,
      transfersProduced: 0,
      producedPairs: 0,
      producedHit: 0,
      goldTotal: 0,
      goldHit: 0,
      unmatchableGold: 0,
      hitRate: null,
      precision: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
