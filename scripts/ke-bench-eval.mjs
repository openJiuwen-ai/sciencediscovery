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
 * ke-bench-eval: live-question-answering benchmark runner for the SD agent,
 * ported from the DeepAnalyze scripts/bench-eval.ts harness (阶段 V / V1-C4 —
 * 守门尺：bench 对比基线，机制项致退化则回滚).
 *
 * Runs multiple-choice benchmarks against the SD stack end-to-end (HTTP API,
 * real sessions) and scores extracted answers against gold labels.
 *
 * Datasets: the CSV subsets shipped with RyanWangZf/BioDSA (the exact files
 * used by the DeepEvidence paper), downloaded once and cached under
 * .tmp/bench-datasets/. Currently supported:
 *   litqa2      BioDSA LabBench/LitQA2_25.csv        (25 题)
 *   dbqa        BioDSA LabBench/DBQA_50.csv          (50 题)
 *   hle-med     BioDSA HLE-medicine/hle_medicine_30.csv    (30 题)
 *   hle-biomed  BioDSA HLE-biomedicine/hle_biomedicine_40.csv (40 题)
 *   supergpqa   BioDSA SuperGPQA/SuperGPQA-hard-medicine-172.csv (172 题)
 *   evidence-synthesis  BioDSA TrialPanoramaBench/evidence_synthesis_50.csv (50 题)
 *   trqa        BioDSA TRQA-lit/TRQA-lit-choice-172.csv (172 题，多选)
 *
 * Execution model (SD port): one project per invocation, one FRESH SESSION per
 * question (title "ke-bench:<subset>:<idx>") so contexts never bleed across
 * questions — same isolation intent as the SA original. Sessions are created
 * with DEFAULT settings (enabledSkillIds stays empty): this deliberately
 * measures the "bare agent + tools" shape, matching the SA scope
 * (webSearch=true, no KB, no skills). The message POST's SSE stream is drained
 * in the background; progress is tracked by POLLING GET /api/sessions/:id/runs
 * (5 s) until the run reaches a terminal status — the SSE body is never relied
 * upon (undici 5-minute body timeout). Pending HITL permission requests are
 * auto-approved (allow_matching) on every poll round. The final answer is
 * rebuilt from GET .../runs/:rid/events: assistant.message text, else the
 * concatenated assistant.delta stream with <think> blocks stripped, else the
 * last assistant message from the messages listing.
 *
 * Scoring: extract the last "Answer: <letter>" line from the final output
 * (three-layer fallback, ported verbatim), exact-match against gold.
 * Unextractable = error. 多选基准（answerFormat: "multi"）抽取字母集合并做
 * 集合精确匹配（顺序无关），另报逐题 F1 均值（meanF1）作为部分得分指标。
 * Metrics per subset: accuracy (correct/total), precision (correct/answered —
 * abstentions excluded), abstained, errors.
 *
 * Persistence: a single results JSON (default qa/baselines/bench-<date>.json)
 * is rewritten after EVERY question — crash-safe; re-running with the same
 * --out skips questions that already have a scored result (error entries are
 * retried). Circuit breaker: 5 consecutive connection-level failures abort the
 * run (exit 2) — a backend restart window must not burn the whole question set.
 *
 * Env: SD_BASE (default http://127.0.0.1:4310), SD_TOKEN (required).
 *
 * Usage:
 *   node scripts/ke-bench-eval.mjs --subsets litqa2,dbqa [--limit N] \
 *     [--concurrency 1] [--timeoutMin 15] [--out qa/baselines/bench-<date>.json] \
 *     [--refresh] [--rescore <file> | --recompute <file>]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// --- bench sources (URLs identical to DeepAnalyze scripts/bench-eval.ts) -----
// answerFormat：缺省 "single"（单字母精确匹配）；"multi" 为多选（gold 为字母
// 组合如 BCD），判分走集合精确匹配 + 逐题 F1。paperAccuracy 为 DeepEvidence
// 论文对照值（Fig.1e，部分为全集口径，仅作方向性参照）。
const BENCH_SOURCES = {
  litqa2: {
    url: "https://raw.githubusercontent.com/RyanWangZf/BioDSA/master/benchmarks/LabBench/LitQA2_25.csv",
    file: "LitQA2_25.csv",
    label: "LabBench-LitQA2",
    paperAccuracy: 64.7, // DeepEvidence, Fig.1e（论文为全集口径）
  },
  dbqa: {
    url: "https://raw.githubusercontent.com/RyanWangZf/BioDSA/master/benchmarks/LabBench/DBQA_50.csv",
    file: "DBQA_50.csv",
    label: "LabBench-DBQA",
    paperAccuracy: 0, // 论文未报 DBQA 单独数字（Fig.1e 未含）
  },
  "hle-med": {
    url: "https://raw.githubusercontent.com/RyanWangZf/BioDSA/master/benchmarks/HLE-medicine/hle_medicine_30.csv",
    file: "hle_medicine_30.csv",
    label: "HLE-Medicine",
    paperAccuracy: 40.0,
  },
  "hle-biomed": {
    url: "https://raw.githubusercontent.com/RyanWangZf/BioDSA/master/benchmarks/HLE-biomedicine/hle_biomedicine_40.csv",
    file: "hle_biomedicine_40.csv",
    label: "HLE-Biomedicine",
    paperAccuracy: 0,
  },
  supergpqa: {
    url: "https://raw.githubusercontent.com/RyanWangZf/BioDSA/master/benchmarks/SuperGPQA/SuperGPQA-hard-medicine-172.csv",
    file: "SuperGPQA-hard-medicine-172.csv",
    label: "SuperGPQA-Medicine-Hard",
    paperAccuracy: 47.1, // DeepEvidence, Fig.1e
  },
  "evidence-synthesis": {
    url: "https://raw.githubusercontent.com/RyanWangZf/BioDSA/master/benchmarks/TrialPanoramaBench/evidence_synthesis_50.csv",
    file: "evidence_synthesis_50.csv",
    label: "TrialPanoramaBench-EvidenceSynthesis",
    paperAccuracy: 0, // 论文未报该子集单独数字（列：question,answer,id,pmid，单选 A-D）
  },
  trqa: {
    url: "https://raw.githubusercontent.com/RyanWangZf/BioDSA/master/benchmarks/TRQA-lit/TRQA-lit-choice-172.csv",
    file: "TRQA-lit-choice-172.csv",
    label: "TRQA-lit-Choice",
    answerFormat: "multi", // 多选：answer 为字母组合（B / BCD / ABCD / BCDEF 等）
    paperAccuracy: 0, // 论文未报该基准数字
  },
};

const DATASET_CACHE_DIR = path.join(repoRoot, ".tmp", "bench-datasets");
const POLL_INTERVAL_MS = 5000;
const OUTPUT_TAIL_CHARS = 4000; // 抽取只需尾部；存尾段供 --rescore 离线重判

// --- RFC4180 CSV parsing (quoted multi-line fields, "" escapes) --------------
// Ported verbatim from DeepAnalyze bench-eval.ts.

function parseCsv(text) {
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      // skip entirely empty trailing row
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Find the "insufficient information to answer" option letter in the question text. */
function parseInsufficientOption(questionText) {
  for (const line of questionText.split("\n")) {
    // SA 原版只匹配英文 "insufficient information"；SD 版扩展到同义中英文
    // 措辞（拒答选项的措辞匹配——precision 口径靠它剔除弃权题）。
    const m = line.match(/^\s*\(?([A-Z])[.)、]\s*.*(insufficient information|信息不足|证据不足|资料不足|无法确定|不足以回答|无法作答)/i);
    if (m) return m[1].toUpperCase();
  }
  return undefined;
}

function loadQuestions(csvText) {
  const rows = parseCsv(csvText);
  const header = rows[0] ?? [];
  // id 列各基准命名不一：LabBench 用 id，SuperGPQA 用 data_id（另有 uuid 兜底）
  const idIdx = header.indexOf("id") >= 0 ? header.indexOf("id")
    : header.indexOf("data_id") >= 0 ? header.indexOf("data_id")
    : header.indexOf("uuid");
  const qIdx = header.indexOf("question");
  const aIdx = header.indexOf("answer");
  if (qIdx < 0 || aIdx < 0) throw new Error(`CSV 缺少 question/answer 列：${header.join(",")}`);
  return rows.slice(1)
    .filter((r) => r[qIdx]?.trim())
    .map((r, i) => {
      const question = r[qIdx].trim();
      const insufficientOption = parseInsufficientOption(question);
      if (idIdx < 0) console.warn(`[ke-bench-eval] 警告：CSV 无 id/data_id/uuid 列，回退行号 id（续跑键必须稳定）`);
      return {
        // Stable fallback id: a random one would silently defeat resume —
        // doneIds would never match across runs (review P2).
        id: idIdx >= 0 ? r[idIdx] : `row-${i + 1}`,
        question,
        answer: r[aIdx].trim().toUpperCase(),
        ...(insufficientOption ? { insufficientOption } : {}),
      };
    });
}

/** Extract the final "Answer: X" letter from agent output (three-layer fallback). */
function extractAnswer(output) {
  const matches = [...output.matchAll(/answer\s*[:：]\s*(?:option\s*)?(?:\(?([A-Z])\)?)/gi)];
  if (matches.length > 0) return matches[matches.length - 1][1].toUpperCase();
  // DBQA 题干要求用 [ANSWER]X[/ANSWER] 标签作答——agent 可能遵从题干而非
  // 我们追加的 "Answer: X" 指令；且实测存在未闭合写法 "[ANSWER]A[/ANSWER"。
  // (?![a-z]) 守卫防止题干回显 "[ANSWER] and [/ANSWER]" 里的 "and" 被误抓。
  const tagMatches = [...output.matchAll(/\[answer\]\s*\(?([A-Za-z])(?![a-z])\)?/gi)];
  if (tagMatches.length > 0) return tagMatches[tagMatches.length - 1][1].toUpperCase();
  // 另一实测变体："## Final Answer" 标题 + "**A. xxx**"（无 Answer: 字面量）
  const finalMatches = [...output.matchAll(/final answer[^\n]*\n+(?:[^\n]*\n){0,2}?[^\n]*\*\*\(?([A-Za-z])(?![a-z])[.\s、)*]/gi)];
  if (finalMatches.length > 0) return finalMatches[finalMatches.length - 1][1].toUpperCase();
  return undefined;
}

// --- 多选（answerFormat: "multi"）---------------------------------------------

/** 归一化多选答案为排序去重后的大写字母串（"D,B,C"→"BCD"、"cba"→"ABC"）。 */
function normalizeAnswerSet(raw) {
  const letters = raw.toUpperCase().match(/[A-Z]/g) ?? [];
  return [...new Set(letters)].sort().join("");
}

/** 预测集 vs gold 集的 F1（0-1，多选的部分得分指标；判对仍要求集合精确匹配）。 */
function answerSetF1(gold, predicted) {
  const g = new Set(normalizeAnswerSet(gold));
  const p = new Set(normalizeAnswerSet(predicted));
  if (g.size === 0 || p.size === 0) return 0;
  const tp = [...p].filter((x) => g.has(x)).length;
  if (tp === 0) return 0;
  const precision = tp / p.size;
  const recall = tp / g.size;
  return (2 * precision * recall) / (precision + recall);
}

/**
 * 多选版答案抽取：取最后一条 "Answer: …" 行，解析字母集合。
 * 支持连写（BCD）、逗号/顿号/空格分隔（B, C, D / B、C、D）、括号（(B)(D)）、
 * 全角冒号；归一化为排序去重后的大写字母串（"D,B,C"→"BCD"）。单字母答案
 * （多选卷里 gold 也可能只有一个字母）同样适用。与 extractAnswer 同样遵循
 * "自述修正取最后一条"语义。
 * 安全阀：Answer 行冒号后的整段必须只由选项字母与分隔符组成——
 * "Answer: B because …" 这类带解释的行不算答案行（防 prose 被逐字母误抓）。
 */
function extractAnswerSet(output) {
  const matches = [...output.matchAll(/answer\s*[:：]\s*([^\n]*)/gi)];
  for (let i = matches.length - 1; i >= 0; i--) {
    // 连续括号 "(B)(D)" 先拆开成独立 token；句末句号属标点不属于答案
    const tail = matches[i][1].trim().replace(/\)\s*\(/g, ") (").replace(/[.。]\s*$/, "");
    if (!tail) continue;
    const tokens = tail.split(/[,，、;；\s]+/).filter(Boolean);
    // 每个 token 必须是：单个字母（可带括号、可小写），或全大写连写字母串。
    // 连写限定 A-J（选项字母的现实范围）——"because" 等英文单词含范围外字母，
    // 天然被拒之门外；连写不收小写（"abcd" 不判），避免与单词撞车。
    const ok = tokens.every((t) => /^\(?[A-Za-z]\)?$/.test(t) || /^\(?[A-J]{2,10}\)?$/.test(t));
    if (!ok) continue;
    const normalized = normalizeAnswerSet(tokens.map((t) => t.replace(/[()]/g, "")).join(""));
    if (normalized) return normalized;
  }
  return undefined;
}

// --- metrics -----------------------------------------------------------------
// Result shape per question:
//   { id, gold, extracted?, correct, abstained?, f1?, durationMs,
//     sessionId?, runId?, outputTail?, error? }

function computeBenchMetrics(results, questions) {
  const total = results.length;
  let answered = 0;
  let abstained = 0;
  let correct = 0;
  /** 答对且未拒答——precision 的分子（正确拒答不进 precision，否则拒答会虚高精确率）。 */
  let correctAnswered = 0;
  let errors = 0;
  let f1Sum = 0;
  let f1Count = 0;
  for (const r of results) {
    if (r.error) { errors++; continue; }
    const q = questions.get(r.id);
    const isAbstain = q?.insufficientOption !== undefined && r.extracted === q.insufficientOption;
    if (isAbstain) abstained++;
    else if (r.extracted !== undefined) answered++;
    if (r.correct) {
      correct++;
      if (!isAbstain) correctAnswered++;
    }
    if (r.f1 !== undefined) { f1Sum += r.f1; f1Count++; }
  }
  return {
    total,
    answered,
    abstained,
    correct,
    errors,
    /** 全体正确率 = correct / total（含拒答与错误）。 */
    accuracy: total > 0 ? (correct / total) * 100 : 0,
    /** 作答精确率 = correct / answered（拒答不进分母）；answered=0 时 null。 */
    precision: answered > 0 ? (correctAnswered / answered) * 100 : null,
    ...(f1Count > 0 ? { meanF1: (f1Sum / f1Count) * 100 } : {}),
  };
}

function formatMetricsLine(label, m, paperAccuracy) {
  return (
    `${label} accuracy ${m.accuracy.toFixed(1)}%（${m.correct}/${m.total}）｜` +
    `precision ${m.precision === null ? "n/a" : `${m.precision.toFixed(1)}%（${m.correct}/${m.answered}）`}｜` +
    (m.meanF1 !== undefined ? `meanF1 ${m.meanF1.toFixed(1)}%｜` : "") +
    `拒答 ${m.abstained}，错误/超时 ${m.errors} 题` +
    (paperAccuracy > 0 ? `｜论文对照 ${paperAccuracy}%` : "｜论文未报该基准")
  );
}

/** 该 bench 的答案格式（缺省 single）。 */
function answerFormatOf(bench) {
  return BENCH_SOURCES[bench]?.answerFormat ?? "single";
}

// --- args --------------------------------------------------------------------

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const dateStamp = new Date().toISOString().slice(0, 10);
const rescorePath = opt("rescore");
const recomputePath = opt("recompute");
const subsetsArg = opt("subsets");
const outPath = path.resolve(opt("out") ?? path.join(repoRoot, "qa", "baselines", `bench-${dateStamp}.json`));
const limit = opt("limit") ? Number(opt("limit")) : undefined;
const timeoutMin = Number(opt("timeoutMin") ?? 15);
const refresh = argv.includes("--refresh");
// 上限 4：更高并发对模型/检索限流风险大，且单题时长失去可比性
const concurrency = Math.min(4, Math.max(1, Number(opt("concurrency") ?? 1)));

const BASE = (process.env.SD_BASE ?? "http://127.0.0.1:4310").replace(/\/+$/, "");
const TOKEN = process.env.SD_TOKEN;

const USAGE =
  "Usage: node scripts/ke-bench-eval.mjs --subsets litqa2,dbqa [--limit N] [--concurrency 1] " +
  "[--timeoutMin 15] [--out qa/baselines/bench-<date>.json] [--refresh] " +
  "[--rescore <file> | --recompute <file>]";

if (!rescorePath && !recomputePath) {
  if (!subsetsArg) {
    console.error(USAGE);
    process.exit(1);
  }
  if (!TOKEN) {
    console.error("[ke-bench-eval] SD_TOKEN env is required (Bearer token of the target stack)");
    process.exit(1);
  }
}
const subsets = (subsetsArg ?? "").split(",").map((s) => s.trim()).filter(Boolean);
for (const b of subsets) {
  if (!BENCH_SOURCES[b]) {
    console.error(`Unknown subset "${b}". Available: ${Object.keys(BENCH_SOURCES).join(", ")}`);
    process.exit(1);
  }
}

const H = { "content-type": "application/json", authorization: `Bearer ${TOKEN ?? ""}` };

// --- dataset download (cache: .tmp/bench-datasets/) ---------------------------

/** CSV 完整性粗检：表头+至少一行数据、末行完整（以换行结尾）——受限网络下
 *  GitHub raw 下载可能静默截断，截断的缓存会导致题目数变少甚至解析抛错。 */
function looksCompleteCsv(text) {
  const trimmed = text.replace(/\s+$/, "");
  return text.endsWith("\n") && trimmed.split("\n").length >= 2;
}

async function fetchCsv(bench, forceRefresh) {
  const src = BENCH_SOURCES[bench];
  const cachePath = path.join(DATASET_CACHE_DIR, src.file);
  if (!forceRefresh && existsSync(cachePath)) {
    const cached = readFileSync(cachePath, "utf-8");
    if (looksCompleteCsv(cached)) return cached;
    console.warn(`[ke-bench-eval] ${bench} 缓存疑似截断（末行不完整），重新下载`);
  }
  mkdirSync(DATASET_CACHE_DIR, { recursive: true });
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let resp;
    try {
      resp = await fetch(src.url, { signal: AbortSignal.timeout(60_000) });
    } catch (err) {
      throw new Error(
        `下载 ${bench} 数据集失败：${err instanceof Error ? err.message : String(err)}\n` +
        `可手动预置缓存：curl --ssl-no-revoke -o "${cachePath}" "${src.url}"`,
      );
    }
    if (!resp.ok) throw new Error(`下载 ${bench} 数据集失败：HTTP ${resp.status} ${src.url}`);
    const text = await resp.text();
    if (looksCompleteCsv(text)) {
      writeFileSync(cachePath, text, "utf-8");
      return text;
    }
    lastErr = new Error(`内容疑似截断（${text.length} 字节，末行不完整）`);
    console.warn(`[ke-bench-eval] ${bench} 下载疑似截断（第 ${attempt}/3 次），重试`);
  }
  throw new Error(`下载 ${bench} 数据集连续 3 次疑似截断：${lastErr instanceof Error ? lastErr.message : String(lastErr)}\n可手动预置缓存：curl --ssl-no-revoke -o "${cachePath}" "${src.url}"`);
}

// --- answer instruction (ported verbatim from SA) -----------------------------

const ANSWER_INSTRUCTION =
  "\n\n请利用你可用的检索与计算工具充分核实后作答。最终答案必须以单独一行给出，格式严格为：\nAnswer: X\n（X 为选项字母）";

// 多选变体：答案为一个或多个字母，直接连写（与 TRQA 题干 "can be one or more" 对齐）
const ANSWER_INSTRUCTION_MULTI =
  "\n\n请利用你可用的检索与计算工具充分核实后作答。最终答案必须以单独一行给出，格式严格为：\nAnswer: X\n（X 为一个或多个选项字母，直接连写，如 Answer: BCD）";

// --- SD API driver (polling mode — see .tmp/qa-driver.mjs for the pattern) ----

class ConnectionError extends Error {}

async function apiFetch(pathname, init = {}) {
  let resp;
  try {
    resp = await fetch(`${BASE}${pathname}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  } catch (err) {
    // 连接级失败（后端不可达/重启窗口）——与判分型失败区分，喂给熔断器
    throw new ConnectionError(err instanceof Error ? err.message : String(err));
  }
  return resp;
}

/** Auto-approve pending HITL permission requests (allow_matching) — SCOPED
 * to the question's session: the server only honors the sessionId filter
 * (there is no status filter), and on a shared stack an unscoped sweep would
 * approve every other session's requests too (review P1). */
async function approvePendingPermissions(log, sessionId) {
  try {
    const resp = await apiFetch(`/api/permission-requests?sessionId=${encodeURIComponent(sessionId)}`);
    if (!resp.ok) return;
    const body = await resp.json();
    for (const p of body.requests ?? body ?? []) {
      const d = await apiFetch(`/api/permission-requests/${p.id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "allow_matching" }),
      });
      if (d.ok) log?.(`approved permission: ${p.id}`);
    }
  } catch (err) {
    if (err instanceof ConnectionError) throw err;
    // endpoint shape tolerant — 审批失败不阻断轮询
  }
}

/** Rebuild the final assistant text from run events (think blocks stripped). */
async function rebuildFinalText(sessionId, runId) {
  const resp = await apiFetch(`/api/sessions/${sessionId}/runs/${runId}/events`);
  const events = resp.ok ? await resp.json().catch(() => []) : [];
  let finalText = "";
  let deltaText = "";
  for (const rec of events ?? []) {
    const evt = rec.event ?? rec;
    if (evt.type === "assistant.message" && typeof evt.text === "string") finalText = evt.text;
    if (evt.type === "assistant.delta" && typeof evt.delta === "string") deltaText += evt.delta;
  }
  if (!finalText && deltaText) {
    // assistant.delta carries the streamed answer INCLUDING <think> blocks — strip them.
    finalText = deltaText.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
  }
  if (!finalText) {
    // fall back to the session detail's message list (GET .../messages does
    // not exist — only POST; SessionDetail carries messages, review P2)
    const raw = await apiFetch(`/api/sessions/${sessionId}`);
    const body = raw.ok ? await raw.json().catch(() => null) : null;
    const detail = body?.session ?? body;
    const msgs = Array.isArray(detail?.messages) ? detail.messages : (body?.messages ?? []);
    const last = msgs.filter((m) => m.role === "assistant").at(-1);
    finalText = typeof last?.content === "string" ? last.content : "";
  }
  return finalText;
}

/**
 * One question: fresh session in the shared run project → POST the question →
 * poll runs until terminal → rebuild the answer → extract & score.
 */
async function runQuestion(projectId, bench, idx, q) {
  const started = Date.now();
  const timeoutMs = timeoutMin * 60_000;
  const fmt = answerFormatOf(bench);
  let sessionId;
  let runId;
  try {
    // 每题独立会话（默认设置：enabledSkillIds 为空、无 KB——刻意测"裸 agent
    // + 工具"形态，与 SA 口径一致），防上下文串味。
    const sessRes = await apiFetch(`/api/projects/${projectId}/sessions`, {
      method: "POST",
      body: JSON.stringify({ title: `ke-bench:${bench}:${idx}` }),
    });
    if (!sessRes.ok) {
      // A reachable-but-degraded backend (5xx while the process is alive)
      // must feed the circuit breaker too — otherwise 539 questions burn
      // into error entries within minutes (review P2).
      if (sessRes.status >= 500) throw new ConnectionError(`session create HTTP ${sessRes.status}`);
      throw new Error(`session create HTTP ${sessRes.status}`);
    }
    const sess = await sessRes.json();
    sessionId = sess.id;
    if (!sessionId) throw new Error("session create returned no id");

    const msgRes = await apiFetch(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: q.question + (fmt === "multi" ? ANSWER_INSTRUCTION_MULTI : ANSWER_INSTRUCTION) }),
    });
    if (!msgRes.ok) {
      if (msgRes.status >= 500) throw new ConnectionError(`message POST HTTP ${msgRes.status}`);
      throw new Error(`message POST HTTP ${msgRes.status}: ${(await msgRes.text()).slice(0, 200)}`);
    }
    // Drain the SSE stream in the background so the server isn't blocked, but
    // never rely on it for progress (undici 5min body timeout) — poll instead.
    msgRes.text().catch(() => {});

    const deadline = Date.now() + timeoutMs;
    let terminal;
    while (Date.now() < deadline) {
      await approvePendingPermissions(undefined, sessionId);
      const runsRes = await apiFetch(`/api/sessions/${sessionId}/runs`);
      if (!runsRes.ok) throw new Error(`runs poll HTTP ${runsRes.status}`);
      const runs = await runsRes.json();
      const run = Array.isArray(runs) ? runs[runs.length - 1] : undefined;
      // interrupted is the fourth terminal status: recoverSessionRuns marks
      // in-flight runs interrupted when the API process restarts — waiting
      // for the other three would burn the whole timeout as a misclassified
      // error (review P2).
      if (run && (run.status === "completed" || run.status === "failed" || run.status === "cancelled" || run.status === "interrupted")) {
        terminal = run;
        break;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    if (!terminal) throw new Error(`timeout after ${timeoutMin}min`);
    runId = terminal.id;
    if (terminal.status !== "completed") throw new Error(`run ${terminal.status}`);

    const output = await rebuildFinalText(sessionId, runId);
    const extracted = fmt === "multi" ? extractAnswerSet(output) : extractAnswer(output);
    // 多选判分 = 集合精确匹配（顺序无关）；同时记录逐题 F1 作部分得分
    const correct = extracted !== undefined &&
      (fmt === "multi" ? extracted === normalizeAnswerSet(q.answer) : extracted === q.answer);
    const f1 = fmt === "multi" && extracted !== undefined ? answerSetF1(q.answer, extracted) : undefined;
    const abstained = q.insufficientOption !== undefined && extracted === q.insufficientOption;
    return {
      id: q.id,
      gold: q.answer,
      extracted,
      correct,
      ...(f1 !== undefined ? { f1 } : {}),
      durationMs: Date.now() - started,
      sessionId,
      runId,
      outputTail: output.slice(-OUTPUT_TAIL_CHARS),
      ...(abstained ? { abstained: true } : {}),
      ...(extracted === undefined ? { error: "no Answer line extracted" } : {}),
    };
  } catch (err) {
    const conn = err instanceof ConnectionError;
    return {
      id: q.id,
      gold: q.answer,
      correct: false,
      durationMs: Date.now() - started,
      ...(sessionId ? { sessionId } : {}),
      ...(runId ? { runId } : {}),
      // 连接级失败打 conn: 前缀——熔断器只数这种；判分型失败（no Answer/超时）不计入
      error: `${conn ? "conn: " : ""}${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// --- results file -------------------------------------------------------------

function loadResultsFile(filePath) {
  if (!existsSync(filePath)) {
    return {
      tool: "ke-bench-eval",
      version: 1,
      generatedAt: new Date().toISOString(),
      base: BASE,
      caveats: [],
      subsets: {},
    };
  }
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function saveResultsFile(filePath, data) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// --- rescore ------------------------------------------------------------------
// --rescore <file>：对结果文件里"判分抽取失败"（error=no Answer 且有产出可重
// 判）的条目，用落盘的 outputTail 重跑抽取（离线）；outputTail 缺失但留有
// sessionId/runId 时从 API 重拉事件重建。不重跑 agent。用于判分规则改进后的
// 无损修正（agent 答对了但格式未被识别的情形）。

async function rescoreFile(filePath) {
  const data = loadResultsFile(filePath);
  for (const [bench, entry] of Object.entries(data.subsets ?? {})) {
    const fmt = answerFormatOf(bench);
    const targets = (entry.results ?? []).filter((r) => r.error && !r.error.startsWith("conn: ") && (r.outputTail || (r.sessionId && r.runId)));
    if (targets.length === 0) {
      console.log(`${bench}: 无可重判条目`);
      continue;
    }
    let fixed = 0;
    for (const r of targets) {
      let output = r.outputTail ?? "";
      if (!output && r.sessionId && r.runId) {
        try {
          output = await rebuildFinalText(r.sessionId, r.runId);
          r.outputTail = output.slice(-OUTPUT_TAIL_CHARS);
        } catch (err) {
          console.warn(`  ${r.id.slice(0, 8)}… 重拉事件失败：${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
      }
      const extracted = fmt === "multi" ? extractAnswerSet(output) : extractAnswer(output);
      if (extracted !== undefined) {
        r.extracted = extracted;
        r.correct = fmt === "multi" ? extracted === normalizeAnswerSet(r.gold) : extracted === r.gold;
        if (fmt === "multi") r.f1 = answerSetF1(r.gold, extracted);
        delete r.error;
        fixed++;
        console.log(`  ${r.id.slice(0, 8)}… 重判 extracted=${extracted} gold=${r.gold} ${r.correct ? "✓" : "✗"}`);
      }
    }
    const correct = entry.results.filter((r) => r.correct).length;
    const errors = entry.results.filter((r) => r.error).length;
    console.log(`${bench}: 重判修复 ${fixed}/${targets.length}；现 ${correct}/${entry.results.length}（${((correct / entry.results.length) * 100).toFixed(1)}%），剩余错误 ${errors}`);
  }
  data.generatedAt = new Date().toISOString();
  saveResultsFile(filePath, data);
  console.log(`已写回：${filePath}`);
}

// --- recompute ----------------------------------------------------------------
// --recompute <file>：从结果文件 + 缓存 CSV 纯本地重算口径（回填 abstained、
// 重算 precision/accuracy/meanF1），不连 API、不重跑 agent。与 --rescore
// 正交：rescore 修复"答案抽取失败"，recompute 只重算指标。

async function recomputeFile(filePath) {
  const data = loadResultsFile(filePath);
  const lines = [];
  for (const [bench, entry] of Object.entries(data.subsets ?? {})) {
    const csv = await fetchCsv(bench, false);
    const questions = loadQuestions(csv);
    const qMap = new Map(questions.map((q) => [q.id, q]));
    const fmt = answerFormatOf(bench);
    const parsedInsufficient = questions.filter((q) => q.insufficientOption).length;
    console.log(`${bench}: ${questions.length} 题中解析到 insufficient 选项 ${parsedInsufficient} 题` +
      // 多选基准（如 TRQA）本无 insufficient-information 选项，0 是预期，不提示检查
      (fmt !== "multi" && parsedInsufficient < questions.length ? "（部分题目无拒答选项，属预期外时检查 parseInsufficientOption）" : ""));

    for (const r of entry.results ?? []) {
      const q = qMap.get(r.id);
      const abstained = q?.insufficientOption !== undefined && r.extracted === q.insufficientOption;
      if (abstained) r.abstained = true;
      else delete r.abstained;
      // 多选：用现有 extracted 纯本地重算集合判分与 F1（判分规则改进后的无损修正）
      if (fmt === "multi" && !r.error && r.extracted !== undefined) {
        r.correct = r.extracted === normalizeAnswerSet(r.gold);
        r.f1 = answerSetF1(r.gold, r.extracted);
      }
    }
    const m = computeBenchMetrics(entry.results ?? [], qMap);
    lines.push(formatMetricsLine(entry.label ?? bench, m, entry.paperAccuracy ?? 0));
  }
  saveResultsFile(filePath, data);
  console.log("\n=== recompute 汇总 ===");
  for (const l of lines) console.log(l);
  console.log(`已写回：${filePath}`);
}

// --- main ---------------------------------------------------------------------

async function main() {
  const data = loadResultsFile(outPath);
  data.base = BASE;
  data.generatedAt = new Date().toISOString();

  // 先载题、算待跑量：全部已完成的纯汇总重跑不新建项目（避免在项目列表留垃圾）。
  const plans = [];
  for (const bench of subsets) {
    const src = BENCH_SOURCES[bench];
    const csv = await fetchCsv(bench, refresh);
    let questions = loadQuestions(csv);
    if (limit) questions = questions.slice(0, limit);
    data.subsets[bench] ??= { label: src.label, paperAccuracy: src.paperAccuracy, answerFormat: answerFormatOf(bench), results: [] };
    const entry = data.subsets[bench];
    // 断点续跑只跳过有明确判分结果的题目；错误/超时（error 字段）在下次运行时重试
    const doneIds = new Set(entry.results.filter((r) => !r.error).map((r) => r.id));
    entry.results = entry.results.filter((r) => !r.error);
    const pending = questions
      .map((q, i) => ({ q, i }))
      .filter(({ q }) => !doneIds.has(q.id));
    plans.push({ bench, src, questions, entry, doneIds, pending });
  }
  const totalPending = plans.reduce((n, p) => n + p.pending.length, 0);

  // 有待跑题才建项目：每次运行建一个项目承载全部题目的独立会话（题目间只
  // 靠会话隔离，与 SA "每题独立会话"的防串味意图一致；项目仅作分组容器，
  // 便于事后清理）。
  let projectId;
  if (totalPending > 0) {
    const projRes = await apiFetch("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: `ke-bench:${subsets.join("+")}:${dateStamp}` }),
    });
    if (!projRes.ok) throw new Error(`project create HTTP ${projRes.status}: ${(await projRes.text()).slice(0, 200)}`);
    const project = await projRes.json();
    projectId = project.id ?? project.project?.id;
    if (!projectId) throw new Error("project create returned no id");
    data.projectId = projectId;
    console.log(`project: ${projectId} (${BASE})`);
  }

  const summaryLines = [];
  for (const { bench, src, questions, entry, doneIds, pending } of plans) {
    console.log(`\n=== ${src.label}：${questions.length} 题（已完成 ${doneIds.size}，跳过）===`);
    // 并发工作池：默认 1（串行），上限 4。>1 时每题仍独立会话、独立判分、
    // 逐题落盘；代价是模型/搜索限流风险上升、单题时长受争抢影响（报告中标注）。
    let cursor = 0;
    // 熔断：连续 5 题连接级失败（后端不可达/重启窗口）即中止——否则一次后端
    // 重启会被瞬时失败烧穿整个剩余题集（SA 2026-09-02 实测：137 题在重启窗口
    // 内全部 0.0min fetch failed 落错误条目）。每题结果已逐题落盘，熔断后重跑
    // 命令即可断点续跑。判分型失败（no Answer/超时）不计入。
    let consecutiveConnErrors = 0;
    let circuitBroken = false;
    const workers = Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
      while (cursor < pending.length && !circuitBroken) {
        const { q, i } = pending[cursor++];
        const r = await runQuestion(projectId, bench, i, q);
        if (r.error?.startsWith("conn: ")) {
          consecutiveConnErrors++;
          if (consecutiveConnErrors >= 5) circuitBroken = true;
        } else {
          consecutiveConnErrors = 0;
        }
        entry.results.push(r);
        console.log(
          `[${i + 1}/${questions.length}] ${q.id.slice(0, 8)}… ` +
          `${r.correct ? "✓" : "✗"} gold=${r.gold} extracted=${r.extracted ?? "-"} ` +
          `${(r.durationMs / 60000).toFixed(1)}min${r.error ? ` err=${r.error.slice(0, 80)}` : ""}`,
        );
        // 每题落盘——崩溃/中断可续跑
        saveResultsFile(outPath, data);
      }
    });
    await Promise.all(workers);
    if (circuitBroken) {
      saveResultsFile(outPath, data);
      console.error(
        `\n[circuit-breaker] 连续 ${consecutiveConnErrors} 题连接级失败——` +
        `后端不可达，熔断退出。已判分条目已落盘；后端恢复后重跑同一命令即可断点续跑。`,
      );
      process.exit(2);
    }

    const scoped = entry.results.filter((r) => questions.some((q) => q.id === r.id));
    const qMap = new Map(questions.map((q) => [q.id, q]));
    const m = computeBenchMetrics(scoped, qMap);
    const line = formatMetricsLine(src.label, m, src.paperAccuracy);
    console.log(`\n${line}`);
    summaryLines.push(line);
  }

  data.caveats = [
    "使用 BioDSA 仓库携带的子集；论文部分基准为更大/全集口径，对照是方向性的",
    "基座模型与论文（GPT-5）不同——系统能力对照，非受控实验",
    "判分=最终输出 Answer 行精确匹配（三层回退抽取）；未抽出/超时计错",
    "precision=答对/已作答（拒答=选 insufficient-information 选项，不进分母）；accuracy 分母为全部题目——两指标必须同读",
    "会话为默认设置的裸会话：enabledSkillIds 为空、无 KB——刻意测\"裸 agent + 工具\"形态，与 SA（webSearch=true, no KB）口径一致；启用技能/KB 后的对照需另跑",
    "HITL 权限请求全部自动放行（allow_matching）——否则需审批的工具调用会停滞到超时",
    "进度靠轮询 GET /runs（5s），不依赖 SSE body（undici 5 分钟超时）",
    ...(subsets.some((b) => answerFormatOf(b) === "multi")
      ? ["多选基准判对=集合精确匹配（全对才计 correct），另报 meanF1 作部分得分；其 accuracy 为全对口径，与单选基准不可直接比较"]
      : []),
    ...(concurrency > 1 ? [`并发 ${concurrency} 路执行：单题时长受资源争抢影响，时长分布不可与串行轮次直接比较`] : []),
  ];
  saveResultsFile(outPath, data);

  console.log("\n=== ke-bench-eval 汇总 ===");
  for (const l of summaryLines) console.log(l);
  console.log(`报告：${outPath}`);
}

if (rescorePath) {
  await rescoreFile(path.resolve(rescorePath));
} else if (recomputePath) {
  await recomputeFile(path.resolve(recomputePath));
} else {
  await main();
}
