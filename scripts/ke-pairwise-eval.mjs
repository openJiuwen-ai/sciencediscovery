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
 * ke-pairwise-eval: blinded pairwise human evaluation of two answer sets
 * (阶段 V / V3-C5). No DeepAnalyze equivalent — written from scratch. Use it
 * for the comparisons deterministic scorers can't make (report quality,
 * synthesis depth, readability): e.g. mechanism-on vs mechanism-off outputs
 * of the same prompts.
 *
 * Two subcommands:
 *
 *   prepare --cases <cases.json> --dir <outDir> [--seed 42] [--labels "baseline,candidate"]
 *     cases.json: [{ "id": "...", "prompt": "...", "responseA": "...", "responseB": "..." }]
 *     For each case a coin flip (seeded PRNG — recorded, reproducible) assigns
 *     A/B to left/right. Three files land in --dir:
 *       pairs.blind.jsonl  one line per pair {pairId, prompt, left, right} —
 *                          the ONLY file the judge opens while scoring
 *       pairs.key.json     {pairId → leftIs: "A"|"B"} — the unblinding key;
 *                          keep it away from the judge until scoring is done
 *       verdicts.jsonl     pre-seeded with {pairId, verdict: ""} lines — the
 *                          judge fills verdict with left | right | tie
 *
 *   report --dir <outDir>
 *     Reads the three files, validates every verdict line (known pairId, legal
 *     value, no duplicates, none left blank), unblinds via the key and reports
 *     per-label wins/ties, win rate, and the Wilson 95% confidence interval of
 *     the win proportion (ties excluded from the proportion — reported
 *     separately, the standard pairwise-eval convention). Exit code reflects
 *     data validity only (0 = all verdicts valid, 2 = validation failed) —
 *     who won is a human reading, not a gate.
 *
 * Blinding rules the judge must follow (printed by prepare):
 *   - score from pairs.blind.jsonl + the ORIGINAL prompt only; do not open
 *     pairs.key.json or the cases file (responseA/responseB order leaks labels)
 *   - fill every verdict line; "tie" is for genuinely indistinguishable pairs,
 *     not for "I didn't read this one"
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const command = argv[0];
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const USAGE =
  "Usage:\n" +
  "  node scripts/ke-pairwise-eval.mjs prepare --cases <cases.json> --dir <outDir> [--seed 42] [--labels \"A,B\"]\n" +
  "  node scripts/ke-pairwise-eval.mjs report --dir <outDir>";

// --- seeded PRNG (mulberry32) — the coin flips must be reproducible from the
// recorded seed, otherwise a lost key file means unrecoverable blinding. -------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Wilson score interval (95%, z = 1.96) ---------------------------------------

function wilson95(wins, n) {
  if (n === 0) return { center: 0, low: 0, high: 0 };
  const z = 1.96;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { center, low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

// --- prepare ----------------------------------------------------------------------

function prepare() {
  const casesPath = opt("cases") ? path.resolve(opt("cases")) : undefined;
  const dir = opt("dir") ? path.resolve(opt("dir")) : undefined;
  const seed = Number(opt("seed") ?? 42);
  if (!Number.isFinite(seed)) {
    console.error(`[pairwise] --seed 必须是数字（收到 "${opt("seed")}"）——NaN 会让复现性记录失真`);
    process.exit(1);
  }
  const [labelA, labelB] = (opt("labels") ?? "A,B").split(",").map((s) => s.trim());
  if (!casesPath || !dir || !labelA || !labelB) {
    console.error(USAGE);
    process.exit(1);
  }
  if (!existsSync(casesPath)) {
    console.error(`[pairwise] cases file not found: ${casesPath}`);
    process.exit(1);
  }
  const cases = JSON.parse(readFileSync(casesPath, "utf-8"));
  if (!Array.isArray(cases) || cases.length === 0) {
    console.error("[pairwise] cases must be a non-empty JSON array");
    process.exit(1);
  }
  const seen = new Set();
  for (const [i, c] of cases.entries()) {
    for (const field of ["id", "prompt", "responseA", "responseB"]) {
      if (typeof c?.[field] !== "string" || !c[field].trim()) {
        console.error(`[pairwise] case #${i + 1}: missing/empty "${field}"`);
        process.exit(1);
      }
    }
    if (seen.has(c.id)) {
      console.error(`[pairwise] duplicate case id "${c.id}"`);
      process.exit(1);
    }
    seen.add(c.id);
  }
  if (existsSync(path.join(dir, "verdicts.jsonl"))) {
    console.error(
      `[pairwise] ${dir} already has verdicts.jsonl — refusing to overwrite in-progress judging. ` +
        `Pick a fresh --dir (a new coin flip would orphan the filled verdicts).`,
    );
    process.exit(1);
  }

  const rand = mulberry32(seed);
  const blindLines = [];
  const key = { seed, labels: { A: labelA, B: labelB }, pairs: {} };
  const verdictLines = [];
  for (const c of cases) {
    const leftIsA = rand() < 0.5;
    blindLines.push(
      JSON.stringify({
        pairId: c.id,
        prompt: c.prompt,
        left: leftIsA ? c.responseA : c.responseB,
        right: leftIsA ? c.responseB : c.responseA,
      }),
    );
    key.pairs[c.id] = { leftIs: leftIsA ? "A" : "B" };
    verdictLines.push(JSON.stringify({ pairId: c.id, verdict: "" }));
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "pairs.blind.jsonl"), blindLines.join("\n") + "\n", "utf-8");
  writeFileSync(path.join(dir, "pairs.key.json"), JSON.stringify(key, null, 2) + "\n", "utf-8");
  writeFileSync(path.join(dir, "verdicts.jsonl"), verdictLines.join("\n") + "\n", "utf-8");

  console.log(`[pairwise] prepared ${cases.length} pairs (seed ${seed}, A="${labelA}" B="${labelB}") in ${dir}`);
  console.log("\n=== 评审纪律（评前必读）===");
  console.log("1. 只看 pairs.blind.jsonl 与各对 prompt 逐对评判，填写 verdicts.jsonl 的 verdict 为 left|right|tie");
  console.log("2. 评分完成前不要打开 pairs.key.json 或 cases 源文件（responseA/B 顺序会泄露标签）");
  console.log("3. 每对都必须填；tie 只用于确实无法区分，不是跳过键");
  console.log(`4. 评完运行：node scripts/ke-pairwise-eval.mjs report --dir "${dir}"`);
}

// --- report ------------------------------------------------------------------------

function report() {
  const dir = opt("dir") ? path.resolve(opt("dir")) : undefined;
  if (!dir) {
    console.error(USAGE);
    process.exit(1);
  }
  const blindPath = path.join(dir, "pairs.blind.jsonl");
  const keyPath = path.join(dir, "pairs.key.json");
  const verdictsPath = path.join(dir, "verdicts.jsonl");
  for (const p of [blindPath, keyPath, verdictsPath]) {
    if (!existsSync(p)) {
      console.error(`[pairwise] missing ${p} — run prepare first`);
      process.exit(1);
    }
  }
  const key = JSON.parse(readFileSync(keyPath, "utf-8"));
  const blindIds = new Set(
    readFileSync(blindPath, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l).pairId),
  );

  // Validate verdicts strictly — a half-filled or sloppy verdict file must
  // fail loudly, not silently bias the win rate.
  const verdicts = new Map();
  const errors = [];
  const lines = readFileSync(verdictsPath, "utf-8").split("\n").filter(Boolean);
  for (const [i, line] of lines.entries()) {
    let v;
    try {
      v = JSON.parse(line);
    } catch {
      errors.push(`line ${i + 1}: invalid JSON`);
      continue;
    }
    if (!blindIds.has(v.pairId)) {
      errors.push(`line ${i + 1}: unknown pairId "${v.pairId}"`);
      continue;
    }
    if (verdicts.has(v.pairId)) {
      errors.push(`line ${i + 1}: duplicate verdict for "${v.pairId}"`);
      continue;
    }
    if (!["left", "right", "tie"].includes(v.verdict)) {
      errors.push(`line ${i + 1}: "${v.pairId}" verdict must be left|right|tie (got "${v.verdict}")`);
      continue;
    }
    verdicts.set(v.pairId, v.verdict);
  }
  for (const id of blindIds) {
    if (!verdicts.has(id)) errors.push(`missing verdict for "${id}"`);
  }
  if (errors.length > 0) {
    console.error(`[pairwise] verdict validation failed (${errors.length}):`);
    for (const e of errors.slice(0, 20)) console.error(`  ${e}`);
    if (errors.length > 20) console.error(`  … and ${errors.length - 20} more`);
    process.exit(2);
  }

  // Unblind and tally.
  const labelA = key.labels?.A ?? "A";
  const labelB = key.labels?.B ?? "B";
  let winsA = 0;
  let winsB = 0;
  let ties = 0;
  for (const [pairId, verdict] of verdicts) {
    const leftIs = key.pairs[pairId]?.leftIs;
    if (!leftIs) {
      console.error(`[pairwise] key file has no entry for "${pairId}" — key/blind mismatch`);
      process.exit(2);
    }
    if (verdict === "tie") ties++;
    else if ((verdict === "left") === (leftIs === "A")) winsA++;
    else winsB++;
  }
  const n = verdicts.size;
  const decided = winsA + winsB;
  const ci = wilson95(winsA, decided);

  const pct = (x, d) => (d > 0 ? `${((x / d) * 100).toFixed(1)}%` : "n/a");
  console.log(`\n=== ke-pairwise-eval: ${n} pairs (seed ${key.seed}) ===`);
  console.log(`${labelA} wins ${winsA}  |  ${labelB} wins ${winsB}  |  ties ${ties}`);
  console.log(
    `${labelA} win rate（剔除平局）: ${pct(winsA, decided)} of ${decided} decided pairs`,
  );
  if (decided > 0) {
    console.log(
      `Wilson 95% CI: [${(ci.low * 100).toFixed(1)}%, ${(ci.high * 100).toFixed(1)}%]` +
        (ci.low > 0.5 ? ` → ${labelA} 显著优于 ${labelB}` : "") +
        (ci.high < 0.5 ? ` → ${labelB} 显著优于 ${labelA}` : "") +
        (ci.low <= 0.5 && ci.high >= 0.5 ? " → 区间内包含 50%，无显著差异" : ""),
    );
  } else {
    // 全 tie——打印 [0%, 0%] 是伪精确
    console.log("Wilson 95% CI: n/a（全部平局，无胜负对可计）");
  }
  console.log(`平局占比: ${pct(ties, n)} of all pairs`);

  const reportPath = path.join(dir, "report.json");
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        tool: "ke-pairwise-eval",
        version: 1,
        at: new Date().toISOString(),
        seed: key.seed,
        labels: { A: labelA, B: labelB },
        pairs: n,
        wins: { [labelA]: winsA, [labelB]: winsB },
        ties,
        decided,
        winRateA: decided > 0 ? winsA / decided : null,
        wilson95: { low: ci.low, center: ci.center, high: ci.high },
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
  console.log(`report: ${reportPath}`);
}

if (command === "prepare") prepare();
else if (command === "report") report();
else {
  console.error(USAGE);
  process.exit(1);
}
