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
 * ALCE-style citation quality eval, ported from the DeepAnalyze
 * scripts/citation-eval harness. Complements the discoverer eval: that one
 * scores "is the answer right", this one scores "does every factual statement
 * in a report carry a good citation". Generic by design — the input is
 * structured claims + sources JSON, not bound to any domain or skill output
 * format; any report-like artifact can be evaluated once shaped as input.
 *
 * Three metrics:
 *   1. quote verbatim precheck (no model): does the claimed quote appear in
 *      the source document verbatim — exact substring first, then a
 *      normalized match over typographic differences (hyphens/whitespace/
 *      case).
 *   2. citation_recall (model-judged, ALCE): for each cited statement, do
 *      all its cited passages TOGETHER entail the statement. Aggregate =
 *      entailed statements / evaluated statements.
 *   3. citation_precision (model-judged, ALCE leave-one-out): for statements
 *      that passed recall with ≥2 citations, drop one citation at a time and
 *      re-judge — still entailed means that citation was redundant.
 *      Aggregate = 1 - redundant / evaluated.
 *
 * Honest caveats (mirrored into every report):
 *   - the model-judged "entailment" is prompt-judged approximate NLI, not
 *     strict logical entailment; judge capability directly bounds the
 *     metrics' credibility — treat them as directional;
 *   - the quote precheck verifies only that the verbatim anchor survives
 *     (anti fabrication), not that the quote supports the statement;
 *   - precision runs leave-one-out only on recall-passing multi-citation
 *     statements; a single-citation statement's citation is necessary by
 *     definition and stays out of the denominator.
 *
 * Pure and IO-free — the CLI runner (scripts/ke-citation-eval.mjs) owns
 * file/process/network IO, including the judge endpoint wiring.
 */

// --- Input types ---------------------------------------------------------------

export interface CitationInput {
  sourceId: string;
  /** The verbatim anchor sentence the statement claims (optional). */
  quote?: string;
}

export interface CitationClaimInput {
  id: string;
  statement: string;
  citations: CitationInput[];
}

export interface CitationEvalInput {
  sources: Record<string, string>;
  claims: CitationClaimInput[];
}

// --- Quote verbatim precheck (no model) -----------------------------------------

// The quote-verbatim primitives are shared with the discoverer eval (same DA
// source); re-exported here under citation-scoped names so this module reads
// as a self-contained port and the index.ts export surface stays
// collision-free.
import { checkQuoteVerbatim, normalizeForMatch, type QuoteCheckStatus } from "./discoverer.js";

export { checkQuoteVerbatim as checkCitationQuoteVerbatim, normalizeForMatch as normalizeForQuoteMatch };

export type CitationQuoteCheckStatus = QuoteCheckStatus;

// --- Entailment judge (model, injectable) ---------------------------------------

/** Judge: given a statement and evidence passages, returns entailed-or-not; null = judge failure (excluded from aggregates). */
export type CitationJudgeFn = (statement: string, passages: string[]) => Promise<boolean | null>;

export interface CitationJudgeMessage {
  role: "system" | "user";
  content: string;
}

export function buildEntailmentMessages(statement: string, passages: string[]): CitationJudgeMessage[] {
  const passageBlock = passages
    .map((passage, index) => `【证据段落 ${index + 1}】\n${passage}`)
    .join("\n\n");
  return [
    {
      role: "system",
      content:
        "你是严格的文本蕴含判定器。给定一条陈述和若干证据段落，判断这些段落合起来是否蕴含该陈述：" +
        "陈述的每个事实要点（实体、数值、条件、关系）都必须能从段落中直接得出，不允许使用外部知识，" +
        "不允许把部分支持当作蕴含。只输出一行判定，格式严格为：ENTAILED 或 NOT_ENTAILED。",
    },
    {
      role: "user",
      content: `【陈述】\n${statement}\n\n${passageBlock}\n\n判定（只输出 ENTAILED 或 NOT_ENTAILED）：`,
    },
  ];
}

/** Parse the judge output. NOT_ENTAILED contains the ENTAILED substring — check the negated form first. */
export function parseCitationJudgeVerdict(text: string): boolean | null {
  const tail = text.trim().slice(-200).toUpperCase();
  if (/NOT[_\s-]?ENTAILED/.test(tail)) return false;
  if (/ENTAILED/.test(tail)) return true;
  return null;
}

// --- Eval core -------------------------------------------------------------------

export interface QuoteCheckRecord {
  sourceId: string;
  status: CitationQuoteCheckStatus;
}

export interface CitationClaimResult {
  id: string;
  statement: string;
  citationsCount: number;
  quoteChecks: QuoteCheckRecord[];
  /** recall verdict: do all cited passages together entail the statement; null = judge failure; undefined = no judge. */
  recall?: boolean | null;
  /** Citations judged redundant by leave-one-out; undefined when no judge or not applicable (recall failed / single citation). */
  redundantCitations?: number;
  /** Citations that participated in leave-one-out (= citationsCount when recall passed and ≥2). */
  precisionEvaluatedCitations?: number;
}

/** Evidence passage for one citation: the quote (anchor sentence) when given, else the truncated source fulltext. */
function citationPassage(citation: CitationInput, sources: Record<string, string>, maxPassageChars: number): string {
  const raw = citation.quote?.trim() ? citation.quote : (sources[citation.sourceId] ?? "");
  return raw.length > maxPassageChars ? `${raw.slice(0, maxPassageChars)}…[truncated]` : raw;
}

/**
 * Evaluate claims one by one. Without a judge only the quote precheck runs.
 * Per claim: recall = judge(statement, all passages); when recall passes and
 * citations ≥2, leave one out at a time (still entailed → redundant).
 */
export async function evaluateCitationClaims(
  input: CitationEvalInput,
  judge?: CitationJudgeFn,
  maxPassageChars = 6000,
): Promise<CitationClaimResult[]> {
  const results: CitationClaimResult[] = [];
  for (const claim of input.claims) {
    const quoteChecks = claim.citations.map((citation) => ({
      sourceId: citation.sourceId,
      status: checkQuoteVerbatim(citation.quote, input.sources[citation.sourceId]),
    }));
    const result: CitationClaimResult = {
      id: claim.id,
      statement: claim.statement,
      citationsCount: claim.citations.length,
      quoteChecks,
    };
    if (judge && claim.citations.length > 0) {
      const passages = claim.citations.map((citation) => citationPassage(citation, input.sources, maxPassageChars));
      const recall = await judge(claim.statement, passages);
      result.recall = recall;
      if (recall === true && claim.citations.length >= 2) {
        let redundant = 0;
        for (let i = 0; i < claim.citations.length; i++) {
          const rest = passages.filter((_, j) => j !== i);
          const stillEntailed = await judge(claim.statement, rest);
          // Judge failure (null) counts as NOT redundant — better to
          // under-report redundancy than to blame citations for judge errors.
          if (stillEntailed === true) redundant += 1;
        }
        result.redundantCitations = redundant;
        result.precisionEvaluatedCitations = claim.citations.length;
      }
    }
    results.push(result);
  }
  return results;
}

// --- Metric aggregation -------------------------------------------------------------

export interface CitationMetrics {
  claims: number;
  citations: number;
  /** Citations that provided a quote (precheck denominator). */
  quotesProvided: number;
  quoteExact: number;
  quoteNormalized: number;
  quoteMissing: number;
  /** Verbatim hit rate = (exact + normalized) / quotesProvided; null without quotes. */
  quoteVerbatimRate: number | null;
  /** Statements whose recall was judged (judge failures excluded). */
  recallEvaluated: number;
  /** Entailed statements / recallEvaluated; null when no judge ran. */
  citationRecall: number | null;
  /** Citations that participated in leave-one-out. */
  precisionEvaluated: number;
  redundantCitations: number;
  /** 1 - redundant / precisionEvaluated; null without a judge or multi-citation statements. */
  citationPrecision: number | null;
}

export function computeCitationMetrics(results: CitationClaimResult[]): CitationMetrics {
  let citations = 0;
  let quotesProvided = 0;
  let quoteExact = 0;
  let quoteNormalized = 0;
  let quoteMissing = 0;
  let recallEvaluated = 0;
  let recallEntailed = 0;
  let precisionEvaluated = 0;
  let redundantCitations = 0;
  for (const result of results) {
    citations += result.citationsCount;
    for (const check of result.quoteChecks) {
      if (check.status === "no-quote") continue;
      quotesProvided += 1;
      if (check.status === "exact") quoteExact += 1;
      else if (check.status === "normalized") quoteNormalized += 1;
      else quoteMissing += 1; // missing | no-source
    }
    if (result.recall !== undefined && result.recall !== null) {
      recallEvaluated += 1;
      if (result.recall) recallEntailed += 1;
    }
    if (result.precisionEvaluatedCitations !== undefined) {
      precisionEvaluated += result.precisionEvaluatedCitations;
      redundantCitations += result.redundantCitations ?? 0;
    }
  }
  return {
    claims: results.length,
    citations,
    quotesProvided,
    quoteExact,
    quoteNormalized,
    quoteMissing,
    quoteVerbatimRate: quotesProvided > 0 ? ((quoteExact + quoteNormalized) / quotesProvided) * 100 : null,
    recallEvaluated,
    citationRecall: recallEvaluated > 0 ? (recallEntailed / recallEvaluated) * 100 : null,
    precisionEvaluated,
    redundantCitations,
    citationPrecision: precisionEvaluated > 0 ? (1 - redundantCitations / precisionEvaluated) * 100 : null,
  };
}
