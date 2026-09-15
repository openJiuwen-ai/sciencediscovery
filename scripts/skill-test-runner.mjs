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
 * skill-test-runner: deterministic scenario tests for a single skill against
 * the live SD stack (阶段 V / V3-C5). Ported from the DeepAnalyze
 * skill-test-runner's schema + assertion ideas (its 148-line orphan runner was
 * never wired there); execution is rewritten against SD's run API, borrowing
 * ke-bench-eval's proven driver patterns.
 *
 * Scenario file schema (JSON array):
 *   [{
 *     "name": "unique scenario id (resume key — keep stable)",
 *     "description": "what this exercises",
 *     "input": "the user message sent to the agent",
 *     "expectedToolCalls": ["kb_search"],        // each must appear in the run
 *     "expectedKeywords": ["half-life"],          // case-insensitive substring
 *     "forbiddenPatterns": ["As an AI"]           // regex, must NOT match
 *   }]
 * All assertion fields are optional; a scenario with none only asserts the run
 * completes. Keep assertions DETERMINISTIC (tool presence, keywords) — don't
 * assert prose quality, that's what ke-pairwise-eval is for.
 *
 * Execution model (one FRESH SESSION per scenario, same isolation intent as
 * ke-bench-eval): create session in the run project → PUT session settings
 * enabledSkillIds=[<skill>] (new sessions default to NO skills — without this
 * the skill machinery never activates) → POST the input → drain SSE in the
 * background, poll GET /runs (5s) until terminal → rebuild the final text from
 * run events (assistant.message, else assistant.delta with <think> stripped)
 * and collect tool names from tool.started/tool.completed traces. Pending HITL
 * permission requests are auto-approved (allow_matching, session-scoped).
 *
 * Persistence: the report JSON (default .tmp/skill-test/<skill>.report.json) is
 * rewritten after EVERY scenario — crash-safe; re-running skips scenarios with
 * a recorded PASS and retries failures (use --refresh to rerun everything).
 * Circuit breaker: 5 consecutive connection-level failures abort (exit 2) — a
 * backend restart window must not burn the whole scenario set into failures.
 *
 * Env: SD_BASE (default http://127.0.0.1:4310), SD_TOKEN (required).
 *
 * Usage:
 *   node scripts/skill-test-runner.mjs --skill hypothesis-tournament \
 *     --scenarios skills/hypothesis-tournament/scenarios.json \
 *     [--out .tmp/skill-test/<skill>.report.json] [--limit N] \
 *     [--timeoutMin 15] [--refresh]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const skillId = opt("skill");
const scenariosPath = opt("scenarios") ? path.resolve(opt("scenarios")) : undefined;
const timeoutMin = Number(opt("timeoutMin") ?? 15);
const limit = opt("limit") ? Number(opt("limit")) : undefined;
const refresh = argv.includes("--refresh");
const outPath = path.resolve(
  opt("out") ?? path.join(repoRoot, ".tmp", "skill-test", `${skillId ?? "skill"}.report.json`),
);
const BASE = (process.env.SD_BASE ?? "http://127.0.0.1:4310").replace(/\/+$/, "");
const TOKEN = process.env.SD_TOKEN;

if (!skillId || !scenariosPath || !TOKEN) {
  console.error(
    "Usage: node scripts/skill-test-runner.mjs --skill <skillId> --scenarios <file.json> " +
      "[--out <report.json>] [--limit N] [--timeoutMin 15] [--refresh]\nSD_TOKEN env is required.",
  );
  process.exit(1);
}
if (!existsSync(scenariosPath)) {
  console.error(`[skill-test] scenarios file not found: ${scenariosPath}`);
  process.exit(1);
}

const H = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
const POLL_INTERVAL_MS = 5000;

// --- scenario loading + validation ---------------------------------------------

function loadScenarios(filePath) {
  const raw = JSON.parse(readFileSync(filePath, "utf-8"));
  if (!Array.isArray(raw)) throw new Error("scenarios file must be a JSON array");
  const seen = new Set();
  for (const [i, s] of raw.entries()) {
    if (!s || typeof s.name !== "string" || !s.name.trim()) {
      throw new Error(`scenario #${i + 1}: missing "name" (it is the resume key)`);
    }
    if (seen.has(s.name)) throw new Error(`duplicate scenario name "${s.name}"`);
    seen.add(s.name);
    if (typeof s.input !== "string" || !s.input.trim()) {
      throw new Error(`scenario "${s.name}": missing "input"`);
    }
    for (const key of ["expectedToolCalls", "expectedKeywords", "forbiddenPatterns"]) {
      if (s[key] !== undefined && !Array.isArray(s[key])) {
        throw new Error(`scenario "${s.name}": ${key} must be an array`);
      }
    }
    // Compile regexes up front — a bad pattern must fail at load time, not mid-run.
    for (const p of s.forbiddenPatterns ?? []) new RegExp(p, "i");
  }
  return raw;
}

// --- SD API driver (polling mode — same rationale as ke-bench-eval) -------------

class ConnectionError extends Error {}

/** 确定性配置错误（如 skill id typo）——所有场景必然同样失败，应立即整体终止。 */
class ConfigError extends Error {}

async function apiFetch(pathname, init = {}) {
  let resp;
  try {
    resp = await fetch(`${BASE}${pathname}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  } catch (err) {
    throw new ConnectionError(err instanceof Error ? err.message : String(err));
  }
  return resp;
}

/** Auto-approve pending HITL permission requests, SCOPED to the scenario's session. */
async function approvePendingPermissions(sessionId) {
  try {
    const resp = await apiFetch(`/api/permission-requests?sessionId=${encodeURIComponent(sessionId)}`);
    if (!resp.ok) return;
    const body = await resp.json();
    for (const p of body.requests ?? body ?? []) {
      await apiFetch(`/api/permission-requests/${p.id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "allow_matching" }),
      });
    }
  } catch (err) {
    if (err instanceof ConnectionError) throw err;
    // endpoint shape tolerant — 审批失败不阻断轮询
  }
}

/** Rebuild the final assistant text AND the called-tool name set from run events. */
async function rebuildRunArtifacts(sessionId, runId) {
  const resp = await apiFetch(`/api/sessions/${sessionId}/runs/${runId}/events`);
  const events = resp.ok ? await resp.json().catch(() => []) : [];
  let finalText = "";
  let deltaText = "";
  const toolsCalled = new Set();
  for (const rec of events ?? []) {
    const evt = rec.event ?? rec;
    if (evt.type === "assistant.message" && typeof evt.text === "string") finalText = evt.text;
    if (evt.type === "assistant.delta" && typeof evt.delta === "string") deltaText += evt.delta;
    // tool.started covers calls whose completion event was lost (crash mid-tool);
    // both share trace.name.
    if ((evt.type === "tool.started" || evt.type === "tool.completed") && evt.trace?.name) {
      toolsCalled.add(evt.trace.name);
    }
  }
  if (!finalText && deltaText) {
    finalText = deltaText.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
  }
  if (!finalText) {
    // 第三级回退（bench 的 review P2 教训）：SessionDetail 的消息列表——
    // 事件流异常为空时，没有这层会让关键词断言对空串误判。
    const raw = await apiFetch(`/api/sessions/${sessionId}`);
    const body = raw.ok ? await raw.json().catch(() => null) : null;
    const detail = body?.session ?? body;
    const msgs = Array.isArray(detail?.messages) ? detail.messages : (body?.messages ?? []);
    const last = msgs.filter((m) => m.role === "assistant").at(-1);
    finalText = typeof last?.content === "string" ? last.content : "";
  }
  return { finalText, toolsCalled: [...toolsCalled].sort() };
}

/**
 * One scenario: fresh session → enable ONLY the target skill → POST input →
 * poll to terminal → assertions. Returns the per-scenario result record.
 */
async function runScenario(projectId, scenario) {
  const started = Date.now();
  const timeoutMs = timeoutMin * 60_000;
  let sessionId;
  let runId;
  const failures = [];
  try {
    const sessRes = await apiFetch(`/api/projects/${projectId}/sessions`, {
      method: "POST",
      body: JSON.stringify({ title: `skill-test:${skillId}:${scenario.name}` }),
    });
    if (!sessRes.ok) {
      if (sessRes.status >= 500) throw new ConnectionError(`session create HTTP ${sessRes.status}`);
      throw new Error(`session create HTTP ${sessRes.status}`);
    }
    const sess = await sessRes.json();
    sessionId = sess.id;
    if (!sessionId) throw new Error("session create returned no id");

    // 新会话默认 enabledSkillIds 为空——不设技能机制就不激活，整个测试白跑。
    const setRes = await apiFetch(`/api/sessions/${sessionId}/settings`, {
      method: "PUT",
      body: JSON.stringify({ enabledSkillIds: [skillId] }),
    });
    if (!setRes.ok) {
      // 5xx = 后端退化，喂熔断器；4xx = 确定性配置错误（normalizeRuntimeSettings
      // 拒绝未知 skill id）——逐场景重试只会烧 N 条相同 failure，整体终止。
      if (setRes.status >= 500) throw new ConnectionError(`settings PUT HTTP ${setRes.status}`);
      throw new ConfigError(
        `settings PUT HTTP ${setRes.status}（skill id "${skillId}" 有效吗？）: ` +
          (await setRes.text()).slice(0, 200),
      );
    }

    const msgRes = await apiFetch(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: scenario.input }),
    });
    if (!msgRes.ok) {
      if (msgRes.status >= 500) throw new ConnectionError(`message POST HTTP ${msgRes.status}`);
      throw new Error(`message POST HTTP ${msgRes.status}: ${(await msgRes.text()).slice(0, 200)}`);
    }
    // SSE 只在后台排空，进度靠轮询（undici 5 分钟 body timeout）。
    msgRes.text().catch(() => {});

    const deadline = Date.now() + timeoutMs;
    let terminal;
    while (Date.now() < deadline) {
      await approvePendingPermissions(sessionId);
      const runsRes = await apiFetch(`/api/sessions/${sessionId}/runs`);
      if (!runsRes.ok) throw new Error(`runs poll HTTP ${runsRes.status}`);
      const runs = await runsRes.json();
      const run = Array.isArray(runs) ? runs[runs.length - 1] : undefined;
      if (run && ["completed", "failed", "cancelled", "interrupted"].includes(run.status)) {
        terminal = run;
        break;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    if (!terminal) throw new Error(`timeout after ${timeoutMin}min`);
    runId = terminal.id;
    if (terminal.status !== "completed") throw new Error(`run ${terminal.status}`);

    const { finalText, toolsCalled } = await rebuildRunArtifacts(sessionId, runId);

    // --- deterministic assertions ---
    for (const tool of scenario.expectedToolCalls ?? []) {
      if (!toolsCalled.includes(tool)) {
        failures.push(`expected tool not called: ${tool} (called: ${toolsCalled.join(", ") || "none"})`);
      }
    }
    const lower = finalText.toLowerCase();
    for (const kw of scenario.expectedKeywords ?? []) {
      if (!lower.includes(kw.toLowerCase())) {
        failures.push(`expected keyword absent: "${kw}"`);
      }
    }
    for (const pattern of scenario.forbiddenPatterns ?? []) {
      if (new RegExp(pattern, "i").test(finalText)) {
        failures.push(`forbidden pattern matched: /${pattern}/i`);
      }
    }

    return {
      name: scenario.name,
      pass: failures.length === 0,
      failures,
      durationMs: Date.now() - started,
      sessionId,
      runId,
      toolsCalled,
      outputTail: finalText.slice(-2000),
    };
  } catch (err) {
    if (err instanceof ConfigError) throw err; // 冒泡给主循环整体终止
    const conn = err instanceof ConnectionError;
    return {
      name: scenario.name,
      pass: false,
      failures: [...failures, `${conn ? "conn: " : ""}${err instanceof Error ? err.message : String(err)}`],
      durationMs: Date.now() - started,
      ...(sessionId ? { sessionId } : {}),
      ...(runId ? { runId } : {}),
      connError: conn || undefined,
    };
  }
}

// --- report file ----------------------------------------------------------------

function loadReport(filePath) {
  if (!existsSync(filePath)) {
    return {
      tool: "skill-test-runner",
      version: 1,
      skill: skillId,
      scenarios: scenariosPath,
      base: BASE,
      generatedAt: new Date().toISOString(),
      results: [],
    };
  }
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function saveReport(filePath, data) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// --- main ------------------------------------------------------------------------

async function main() {
  let scenarios;
  try {
    scenarios = loadScenarios(scenariosPath);
  } catch (err) {
    console.error(`[skill-test] invalid scenarios file: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  if (limit) scenarios = scenarios.slice(0, limit);
  if (scenarios.length === 0) {
    console.error("[skill-test] 场景文件为空——没有任何东西被测试");
    process.exit(1);
  }

  const report = loadReport(outPath);
  // report 复用守卫：换了 --skill 或 --scenarios 还用同一 --out，旧 pass 记录
  // 会污染续跑跳过与汇总——告警并重置（--refresh 语义相同，只是显式）。
  if (
    Array.isArray(report.results) &&
    report.results.length > 0 &&
    (report.skill !== skillId || report.scenarios !== scenariosPath)
  ) {
    console.warn(
      `[skill-test] 警告：${outPath} 属于 ${report.skill}/${report.scenarios}，与本次参数不符——已忽略旧结果`,
    );
    report.results = [];
  }
  report.skill = skillId;
  report.scenarios = scenariosPath;
  report.base = BASE;
  report.generatedAt = new Date().toISOString();
  if (refresh) report.results = [];
  // 断点续跑：pass 的跳过，fail 的重试（错误可能是瞬时的模型/网络问题）
  const passedNames = new Set(report.results.filter((r) => r.pass).map((r) => r.name));
  report.results = report.results.filter((r) => r.pass);
  const pending = scenarios.filter((s) => !passedNames.has(s.name));

  console.log(
    `[skill-test] skill=${skillId} scenarios=${scenarios.length} ` +
      `(已 pass ${passedNames.size} 跳过，待跑 ${pending.length}) @ ${BASE}`,
  );
  if (pending.length === 0) {
    printSummary(report);
    process.exit(report.results.every((r) => r.pass) ? 0 : 2);
  }

  const projRes = await apiFetch("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: `skill-test:${skillId}:${new Date().toISOString().slice(0, 10)}` }),
  });
  if (!projRes.ok) throw new Error(`project create HTTP ${projRes.status}`);
  const project = await projRes.json();
  const projectId = project.id ?? project.project?.id;
  if (!projectId) throw new Error("project create returned no id");
  report.projectId = projectId;
  console.log(`[skill-test] project: ${projectId}`);

  // 串行执行（技能 run 重，且并发会污染单场景时长与限流行为）+ 连接熔断。
  let consecutiveConnErrors = 0;
  for (const scenario of pending) {
    let r;
    try {
      r = await runScenario(projectId, scenario);
    } catch (err) {
      if (err instanceof ConfigError) {
        // 确定性配置错误——继续跑只会把同一错误烧进每个场景
        saveReport(outPath, report);
        console.error(`\n[skill-test] 配置错误，全部场景终止：${err.message}`);
        process.exit(1);
      }
      throw err;
    }
    report.results.push(r);
    saveReport(outPath, report);
    console.log(
      `[${report.results.length}/${scenarios.length}] ${scenario.name} ` +
        `${r.pass ? "PASS" : "FAIL"} ${(r.durationMs / 60000).toFixed(1)}min` +
        (r.failures.length ? `\n    ${r.failures.join("\n    ")}` : ""),
    );
    if (r.connError) {
      consecutiveConnErrors++;
      if (consecutiveConnErrors >= 5) {
        saveReport(outPath, report);
        console.error(
          `\n[circuit-breaker] 连续 ${consecutiveConnErrors} 个场景连接级失败——后端不可达，熔断退出。` +
            `已落盘；后端恢复后重跑同一命令即可断点续跑。`,
        );
        process.exit(2);
      }
    } else {
      consecutiveConnErrors = 0;
    }
  }

  report.generatedAt = new Date().toISOString();
  saveReport(outPath, report);
  printSummary(report);
  console.log(`[skill-test] report: ${outPath}`);
  process.exit(report.results.every((r) => r.pass) ? 0 : 2);
}

function printSummary(report) {
  const pass = report.results.filter((r) => r.pass).length;
  console.log(`\n[skill-test] ${report.skill}: ${pass}/${report.results.length} PASS`);
  for (const r of report.results.filter((r) => !r.pass)) {
    console.log(`  FAIL ${r.name}: ${r.failures.join("; ")}`);
  }
}

await main();
