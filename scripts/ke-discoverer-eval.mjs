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
 * ke-discoverer-eval: L4 "discoverer" task eval, ported from the DeepAnalyze
 * scripts/discoverer-eval harness. The scoring重心 is honesty alongside
 * accuracy (overclaim lexicon / citation precheck / abstention calibration).
 *
 *   gap-hit        — in-process: runs the production findGaps against the
 *                    dataset's inline graphs, scores hit-rate/precision.
 *                    Zero services, zero credentials.
 *   novelty-triage — scored from PRE-COLLECTED agent outputs (the live
 *                    collector needs a credentialed stack; pending that, feed
 *                    --answers a JSON file: { "<itemId>": { "output": "..." } }).
 *
 * Datasets: packages/knowledge-engine/test-datasets/discoverer/<set>.json.
 * Requires a prior `pnpm build`.
 *
 * Usage:
 *   node scripts/ke-discoverer-eval.mjs --set gap-hit [--out .tmp/discoverer-eval]
 *   node scripts/ke-discoverer-eval.mjs --set novelty-triage --answers <file> [--citation]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keDist = path.join(repoRoot, "packages", "knowledge-engine", "dist", "index.js");
if (!existsSync(keDist)) {
  console.error("[discoverer-eval] packages/knowledge-engine/dist missing — run `pnpm build` first");
  process.exit(1);
}
const {
  loadDiscovererDataset,
  loadGapHitDataset,
  runGapHitItem,
  aggregateGapHit,
  extractVerdict,
  acceptedSet,
  scoreDiscoverer,
  computeIntegrity,
} = await import(pathToFileURL(keDist).href);

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const setName = opt("set");
const answersPath = opt("answers");
const outDir = path.resolve(opt("out") ?? path.join(repoRoot, ".tmp", "discoverer-eval"));
const withCitation = argv.includes("--citation");
const limit = opt("limit") ? Number(opt("limit")) : undefined;

if (!setName) {
  console.error("Usage: node scripts/ke-discoverer-eval.mjs --set <gap-hit|novelty-triage> [--answers file] [--citation] [--limit N] [--out dir]");
  process.exit(1);
}
const datasetPath = path.join(repoRoot, "packages", "knowledge-engine", "test-datasets", "discoverer", `${setName}.json`);
if (!existsSync(datasetPath)) {
  console.error(`[discoverer-eval] dataset not found: ${datasetPath}`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

if (setName === "gap-hit") {
  const dataset = loadGapHitDataset(readFileSync(datasetPath, "utf-8"));
  const items = limit ? dataset.items.slice(0, limit) : dataset.items;
  console.log(`[discoverer-eval] gap-hit ${dataset.id}: ${items.length} items (in-process findGaps)`);
  const scores = items.map((item) => {
    const s = runGapHitItem(item, dataset.thresholds);
    // ✓ requires at least one matchable gold — 0/0 (only unmatchable gold)
    // is not a pass.
    const ok = s.goldTotal > 0 && s.goldHit === s.goldTotal;
    console.log(
      `  ${s.error ? "✗" : ok ? "✓" : "◐"} ${item.id} hit ${s.goldHit}/${s.goldTotal}` +
        ` (produced ${s.producedPairs}, precision ${s.precision === null ? "n/a" : s.precision.toFixed(2)})` +
        `${s.unmatchableGold > 0 ? ` [${s.unmatchableGold} unmatchable gold]` : ""}`,
    );
    return s;
  });
  const metrics = aggregateGapHit(scores);
  const report = {
    set: setName,
    dataset: dataset.id,
    at: new Date().toISOString(),
    executor: "findGaps (production, in-process)",
    metrics,
    items: scores,
  };
  const reportPath = path.join(outDir, `${setName}.report.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
  console.log(
    `\n[discoverer-eval] gold hitRate micro=${fmtPct(metrics.microHitRate)} macro=${fmtPct(metrics.macroHitRate)}` +
      ` | precision micro=${fmtPct(metrics.microPrecision)} macro=${fmtPct(metrics.macroPrecision)}` +
      ` | unmatchableGold=${metrics.unmatchableGold} | errors=${metrics.errors}`,
  );
  console.log(`[discoverer-eval] report: ${reportPath}`);
  process.exit(0);
}

// novelty-triage: score pre-collected outputs.
const dataset = loadDiscovererDataset(readFileSync(datasetPath, "utf-8"));
const items = /** @type {any[]} */ (limit ? (dataset.items ?? []).slice(0, limit) : (dataset.items ?? []));
if (!answersPath || !existsSync(answersPath)) {
  console.error(
    "[discoverer-eval] novelty-triage needs --answers <file> ({ itemId: { output } }) — " +
      "the live collector runs against a credentialed stack (pending model credentials).",
  );
  process.exit(1);
}
const answers = JSON.parse(readFileSync(answersPath, "utf-8"));
const results = [];
const outputsById = new Map();
for (const item of items) {
  const answer = answers[item.id];
  if (!answer || typeof answer.output !== "string") {
    results.push({ id: item.id, gold: item.gold, correct: false, durationMs: 0, error: "no answer collected" });
    continue;
  }
  const extracted = extractVerdict(answer.output);
  outputsById.set(item.id, answer.output);
  results.push({
    id: item.id,
    gold: item.gold,
    ...(extracted !== undefined ? { extracted } : {}),
    correct: extracted !== undefined && acceptedSet(item).has(extracted),
    durationMs: 0,
    ...(extracted === undefined ? { error: "no verdict extracted" } : {}),
  });
}
const metrics = scoreDiscoverer(results, items);
const integrity = computeIntegrity(results, items, outputsById, dataset.sources, withCitation);
const report = {
  set: setName,
  dataset: dataset.id,
  at: new Date().toISOString(),
  executor: "answers-file (offline scoring of pre-collected outputs)",
  metrics,
  integrity,
  items: results,
};
const reportPath = path.join(outDir, `${setName}${withCitation ? ".citation" : ""}.report.json`);
writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
console.log(`\n[discoverer-eval] accuracy=${metrics.accuracy.toFixed(1)}% (${metrics.correct}/${metrics.total}, errors ${metrics.errors})`);
for (const cls of Object.keys(metrics.perClass)) {
  const c = metrics.perClass[cls];
  console.log(`  ${cls}: recall ${c.recall.toFixed(1)}% (${c.correct}/${c.total})`);
}
console.log(
  `[discoverer-eval] falseNovel=${metrics.falseNovel} falseSimilar=${metrics.falseSimilar} overCautious=${metrics.overCautious}`,
);
console.log(
  `[discoverer-eval] integrity: overclaim ${integrity.overclaim.flagged}/${integrity.overclaim.evaluated}` +
    ` | abstention inconclusive=${integrity.abstention.inconclusive} (justified ${integrity.abstention.justified}, over-cautious ${integrity.abstention.overCautious})` +
    (integrity.citation
      // verbatimRate is already a percent (computeIntegrity ×100) — print as-is.
      ? ` | citation verbatim rate=${integrity.citation.verbatimRate === null ? "n/a" : integrity.citation.verbatimRate.toFixed(1) + "%"} (${integrity.citation.quotesFound} quotes)`
      : ""),
);
console.log(`[discoverer-eval] report: ${reportPath}`);

function fmtPct(v) {
  return v === null ? "n/a" : `${(v * 100).toFixed(1)}%`;
}
