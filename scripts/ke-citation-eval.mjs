#!/usr/bin/env node
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
 * ke-citation-eval: ALCE-style citation quality eval for report-like outputs,
 * ported from the DeepAnalyze citation-eval harness. Scores how well every
 * factual statement in a report is cited — complementing ke-discoverer-eval
 * (answer correctness) with citation quality:
 *
 *   1. quote verbatim precheck (offline, no model) — does the claimed quote
 *      survive in the source document (exact / normalized / missing);
 *   2. citation_recall (judged) — do the cited passages together entail the
 *      statement;
 *   3. citation_precision (judged, leave-one-out) — which citations are
 *      redundant.
 *
 * Input JSON (--input):
 *   { "sources": { "<sourceId>": "fulltext, or @/path/to/file" },
 *     "claims": [ { "id": "c1", "statement": "...",
 *                   "citations": [ { "sourceId": "doc-a", "quote": "…" } ] } ] }
 *
 * The judge is an OpenAI-compatible chat endpoint configured by env (never
 * hardcode credentials):
 *   SCIENCE_AGENT_EVAL_JUDGE_BASE_URL / SCIENCE_AGENT_EVAL_JUDGE_API_KEY /
 *   SCIENCE_AGENT_EVAL_JUDGE_MODEL
 * Default is judge-ENABLED when all three are set; --no-judge forces the
 * offline precheck-only run (recall/precision report null).
 *
 * Requires a prior `pnpm build`.
 *
 * Usage:
 *   node scripts/ke-citation-eval.mjs --input claims.json [--out .tmp/citation-eval]
 *     [--no-judge] [--judge-model <model>] [--max-passage-chars 6000]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keDist = path.join(repoRoot, "packages", "knowledge-engine", "dist", "index.js");
if (!existsSync(keDist)) {
  console.error("[citation-eval] packages/knowledge-engine/dist missing — run `pnpm build` first");
  process.exit(1);
}
const {
  buildEntailmentMessages,
  computeCitationMetrics,
  evaluateCitationClaims,
  parseCitationJudgeVerdict,
} = await import(pathToFileURL(keDist).href);

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const inputPath = opt("input");
if (!inputPath) {
  console.error(
    "Usage: node scripts/ke-citation-eval.mjs --input claims.json " +
      "[--out dir] [--no-judge] [--judge-model model] [--max-passage-chars N]",
  );
  process.exit(1);
}
const outDir = path.resolve(opt("out") ?? path.join(repoRoot, ".tmp", "citation-eval"));
const maxPassageChars = Number(opt("max-passage-chars") ?? 6000);
const judgeModel = opt("judge-model") ?? process.env.SCIENCE_AGENT_EVAL_JUDGE_MODEL;
const judgeBaseUrl = process.env.SCIENCE_AGENT_EVAL_JUDGE_BASE_URL;
const judgeApiKey = process.env.SCIENCE_AGENT_EVAL_JUDGE_API_KEY;
const judgeEnabled = !argv.includes("--no-judge") && Boolean(judgeBaseUrl && judgeApiKey && judgeModel);

mkdirSync(outDir, { recursive: true });
const raw = JSON.parse(readFileSync(inputPath, "utf-8"));
if (!raw.sources || !Array.isArray(raw.claims)) {
  console.error("[citation-eval] input JSON must contain sources (object) and claims (array)");
  process.exit(1);
}

// Resolve @path source references (values starting with @ read the file).
const baseDir = path.dirname(path.resolve(inputPath));
const sources = {};
for (const [id, text] of Object.entries(raw.sources)) {
  if (typeof text === "string" && text.startsWith("@")) {
    const filePath = path.resolve(baseDir, text.slice(1));
    if (!existsSync(filePath)) {
      console.error(`[citation-eval] source ${id} references a missing file: ${filePath}`);
      process.exit(1);
    }
    sources[id] = readFileSync(filePath, "utf-8");
  } else {
    sources[id] = text;
  }
}
const input = { ...raw, sources };

let judge;
if (judgeEnabled) {
  judge = async (statement, passages) => {
    try {
      const response = await fetch(`${judgeBaseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${judgeApiKey}` },
        body: JSON.stringify({
          model: judgeModel,
          messages: buildEntailmentMessages(statement, passages),
          max_tokens: 2048,
          temperature: 0,
        }),
      });
      if (!response.ok) throw new Error(`judge endpoint HTTP ${response.status}`);
      const payload = await response.json();
      // Reasoning-model judges (e.g. MiniMax-M3) embed <think>…</think> in
      // content; strip it so the tail scan sees the verdict, and give the
      // verdict room beyond the thinking budget (max_tokens above).
      const raw = payload?.choices?.[0]?.message?.content ?? "";
      // A terminated think block AND an unterminated one (judge truncated
      // mid-thought) both have to go, or the tail scan misses the verdict.
      const visible = String(raw)
        .replace(/<think>[\s\S]*?<\/think>/g, "")
        .replace(/<think>[\s\S]*$/g, "");
      return parseCitationJudgeVerdict(visible);
    } catch (err) {
      console.warn(`  [judge] verdict failed (excluded from aggregates): ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };
} else if (!argv.includes("--no-judge")) {
  console.warn("[citation-eval] judge env incomplete (SCIENCE_AGENT_EVAL_JUDGE_BASE_URL/_API_KEY/_MODEL) — running precheck-only");
}

const results = await evaluateCitationClaims(input, judge, maxPassageChars);
for (const result of results) {
  const quoteStr = result.quoteChecks.map((check) => `${check.sourceId}:${check.status}`).join(", ") || "-";
  const recallStr = result.recall === undefined ? "n/a" : result.recall === null ? "judge-fail" : result.recall ? "entailed" : "NOT-entailed";
  const redundantStr = result.redundantCitations !== undefined ? ` redundant=${result.redundantCitations}/${result.precisionEvaluatedCitations}` : "";
  console.log(`[${result.id}] recall=${recallStr}${redundantStr} quote=[${quoteStr}]`);
}

const metrics = computeCitationMetrics(results);
const pct = (value) => (value === null ? "n/a" : `${value.toFixed(1)}%`);
console.log(
  `\nquote verbatim ${pct(metrics.quoteVerbatimRate)} (exact ${metrics.quoteExact} / normalized ${metrics.quoteNormalized} / missing ${metrics.quoteMissing}, of ${metrics.quotesProvided} quotes)\n` +
    `citation_recall ${pct(metrics.citationRecall)} (${metrics.recallEvaluated} statements judged)\n` +
    `citation_precision ${pct(metrics.citationPrecision)} (${metrics.precisionEvaluated} citations leave-one-out, ${metrics.redundantCitations} redundant)`,
);

const report = {
  generatedAt: new Date().toISOString(),
  input: path.resolve(inputPath),
  judgeEnabled,
  judgeModel: judgeEnabled ? judgeModel : "(none)",
  metrics,
  caveats: [
    "model-judged entailment is prompt-judged approximate NLI, not strict logical entailment; judge capability bounds metric credibility — treat as directional",
    "the quote precheck verifies only that the verbatim anchor survives (anti-fabrication), not that the quote supports the statement — support is the recall verdict's job",
    "citation_precision runs leave-one-out only on recall-passing statements with ≥2 citations; single-citation statements are necessary by definition and stay out of the denominator; failed leave-one-out verdicts count as not redundant",
    "a normalized hit means the quote differs from the source only typographically (whitespace/hyphens/case) — audit-warning equivalent; missing is audit-critical quote-mismatch",
  ],
  results,
};
const reportPath = path.join(outDir, "citation-report.json");
writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
console.log(`\nreport: ${reportPath}`);
