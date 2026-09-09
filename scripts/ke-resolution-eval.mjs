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
 * Entity-resolution eval CLI (in-process, zero services), ported from the
 * DeepAnalyze scripts/entity-resolution-eval harness.
 *
 * Runs the packaged resolver against a dataset of (graph fixture, candidate)
 * items and reports pairwise P/R/F1, B-cubed, per-class accuracy and the
 * ship gate (same precision ≥ 0.95, recall ≥ 0.60, similar accuracy ≥ 0.90).
 *
 * Modes:
 *   (default)  deterministic L0–L2 (exact / alias / Schwartz–Hearst abbrev)
 *   --trgm     + L3.5 trigram recall for low-entropy names (pure JS, no creds)
 *
 * L3 embedding / L4 LLM judge need a credentialed pipeline model and are
 * intentionally NOT wired here — run those through the live stack instead.
 *
 * Usage:
 *   node scripts/ke-resolution-eval.mjs [--set pairs.sample] [--limit N] \
 *     [--trgm] [--out .tmp/er-eval]
 *
 * Datasets live in packages/knowledge-engine/test-datasets/entity-resolution/.
 * Requires a prior `pnpm build` (imports the compiled package).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keDist = path.join(repoRoot, "packages", "knowledge-engine", "dist", "index.js");
if (!existsSync(keDist)) {
  console.error("[er-eval] packages/knowledge-engine/dist missing — run `pnpm build` first");
  process.exit(1);
}
const {
  parseErDataset,
  buildMemoryRepo,
  runErItem,
  computeMetrics,
  goldClusterOf,
  ER_GATE,
} = await import(keDist);

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const setName = opt("set") ?? "pairs.sample";
const limit = opt("limit") ? Number(opt("limit")) : undefined;
const enableTrgm = argv.includes("--trgm");
const outDir = opt("out") ?? path.join(repoRoot, ".tmp", "er-eval");

const datasetPath = path.join(
  repoRoot,
  "packages",
  "knowledge-engine",
  "test-datasets",
  "entity-resolution",
  `${setName}.json`,
);
if (!existsSync(datasetPath)) {
  console.error(`[er-eval] dataset not found: ${datasetPath}`);
  process.exit(1);
}

const dataset = parseErDataset(readFileSync(datasetPath, "utf-8"));
const items = limit ? dataset.items.slice(0, limit) : dataset.items;
const repo = buildMemoryRepo(dataset.graph, enableTrgm ? { enableTrgm: true } : {});
const mode = enableTrgm ? "deterministic+trgm" : "deterministic";
console.log(
  `[er-eval] dataset ${dataset.id}: ${items.length} items (graph fixture ${dataset.graph.length} entities), mode=${mode}`,
);

const scored = [];
for (const item of items) {
  const s = await runErItem(item, repo, enableTrgm ? { thresholds: undefined } : {});
  scored.push(s);
  console.log(
    `  ${s.correct ? "✓" : "✗"} ${item.id} gold=${s.gold} → ${s.predicted} (via ${s.decision.via}${s.decision.targetId ? ` → ${s.decision.targetId}` : ""})`,
  );
}

const metrics = computeMetrics(scored, goldClusterOf(dataset));
const m = metrics;
console.log(
  `\n[er-eval] pairwise P=${m.pairwise.precision.toFixed(3)} R=${m.pairwise.recall.toFixed(3)} F1=${m.pairwise.f1.toFixed(3)}` +
    ` | B-cubed P=${m.bcubed.precision.toFixed(3)} R=${m.bcubed.recall.toFixed(3)} F1=${m.bcubed.f1.toFixed(3)}` +
    ` | mergeRate=${m.mergeRate.toFixed(3)}`,
);
for (const cls of Object.keys(m.perClass)) {
  const c = m.perClass[cls];
  console.log(`  ${cls}: ${c.correct}/${c.total} (${(c.accuracy * 100).toFixed(1)}%)`);
}
console.log(
  `[er-eval] ship gate: precision≥${ER_GATE.minPrecision} ${m.gate.precisionOk ? "✓" : "✗"}` +
    ` | recall≥${ER_GATE.minRecall} ${m.gate.recallOk ? "✓" : "✗"}` +
    ` | similar≥${ER_GATE.minSimilarAccuracy} ${m.gate.similarOk ? "✓" : "✗"} → ${m.gate.pass ? "PASS" : "NOT-YET"}`,
);
console.log("[er-eval] note: deterministic/trgm modes are the no-credential baseline; L3/L4 gains measure on the live stack.");

mkdirSync(outDir, { recursive: true });
const reportPath = path.join(outDir, `${setName}${enableTrgm ? ".trgm" : ""}.report.json`);
writeFileSync(
  reportPath,
  JSON.stringify(
    {
      set: setName,
      dataset: dataset.id,
      at: new Date().toISOString(),
      mode,
      counts: { items: scored.length, graphEntities: dataset.graph.length },
      metrics,
      gateThresholds: ER_GATE,
      items: scored,
    },
    null,
    2,
  ),
  "utf-8",
);
console.log(`[er-eval] report: ${reportPath}`);
process.exit(m.gate.pass ? 0 : 2);
