// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
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
 * Step-by-step evidence for user journeys.
 *
 * A journey spec describes what the user does; this reporter turns that
 * description into something a human can review without reading the spec or
 * re-running the stack. Every `journey.step()` records its title, the outcome
 * the user should observe, its result, a screenshot taken once the page has
 * settled, and the browser/network noise produced while it ran. When the test
 * ends — passed, failed, or blocked by an unmet precondition — the reporter
 * writes `report.md` and a self-contained `report.html` next to those
 * screenshots.
 *
 * The reporter is wired into the `journey` fixture in `./e2e.ts`, so a spec
 * cannot forget an `afterEach` and silently produce no evidence.
 */

import { execFileSync } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { test as playwrightTest, type Page, type TestInfo } from "@playwright/test";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Values that must never reach a published report, whatever produced them. */
const SECRET_VARIABLES = [
  "E2E_API_TOKEN",
  "E2E_LLM_TOKEN",
  "SCIENCE_AGENT_AUTH_TOKEN",
  "SCIENCE_AGENT_GATEWAY_TOKEN",
];

/** Keep one noisy step from burying the rest of the report. */
const MAX_LOGS_PER_STEP = 25;
const MAX_ERROR_CHARS = 2_000;

export type JourneyStepStatus = "blocked" | "failed" | "passed";
export type JourneyOutcome = "BLOCKED" | "FAIL" | "PASS";

export interface JourneyLog {
  at: number;
  detail: string;
  kind: "console" | "network" | "page";
}

export interface JourneyStepRecord {
  description: string;
  durationMs: number;
  error?: string;
  index: number;
  logs: JourneyLog[];
  screenshot?: string;
  status: JourneyStepStatus;
  title: string;
}

export interface JourneyScenario {
  goal: string;
  preconditions?: string[];
}

export interface JourneyReporter {
  /** Run one user-visible step: act, assert, then capture its evidence. */
  step(title: string, description: string, body: () => Promise<void>): Promise<void>;
  /** Describe the user goal and preconditions in the reader's language. */
  scenario(scenario: JourneyScenario): void;
  /** Add a free-form note that belongs to the report rather than to a step. */
  note(text: string): void;
  /** Write report.md + report.html. Called by the fixture; specs never call it. */
  finalize(): Promise<void>;
}

interface SpecMeta {
  costSideEffects?: string;
  credentials?: string;
  environment?: string;
  llm?: string;
  purpose?: string;
  type?: string;
}

let cachedCommit: { dirty: boolean; sha: string } | undefined;

/** Identify the code under test, so a report cannot be mistaken for another run. */
function commitUnderTest(): { dirty: boolean; sha: string } {
  if (cachedCommit) return cachedCommit;
  const fromEnv = process.env.E2E_COMMIT_SHA?.trim();
  try {
    const sha = fromEnv
      || execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8", timeout: 5_000 }).trim();
    const porcelain = execFileSync("git", ["status", "--porcelain"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
    cachedCommit = { dirty: porcelain.length > 0, sha };
  } catch {
    cachedCommit = { dirty: false, sha: fromEnv || "unknown" };
  }
  return cachedCommit;
}

/**
 * Strip credentials and machine-specific paths. Reports are published to
 * humans and to the document library, so this runs over every recorded string
 * rather than only over the ones a spec remembered to sanitize.
 */
export function redact(text: string): string {
  let out = text;
  for (const name of SECRET_VARIABLES) {
    const value = process.env[name]?.trim();
    if (value && value.length >= 8) out = out.split(value).join(`<${name}>`);
  }
  out = out.replace(/(bearer\s+)[\w.~+/-]{8,}=*/gi, "$1<redacted>");
  out = out.replace(/([?&](?:token|api[-_]?key|access[-_]?token|key|secret)=)[^&\s"']+/gi, "$1<redacted>");
  out = out.split(REPO_ROOT).join("<repo>");
  const home = homedir();
  if (home && home !== "/") out = out.split(home).join("~");
  return out;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (truncated)`;
}

/** Readable, filesystem-safe, and still recognizable for CJK step titles. */
function slug(title: string): string {
  const cleaned = title
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w\u4e00-\u9fff-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  return (cleaned || "step").slice(0, 40);
}

function formatDuration(ms: number): string {
  return ms < 1_000 ? `${ms}ms` : `${(ms / 1_000).toFixed(1)}s`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n+/g, " ");
}

/**
 * Reuse the E2E-META block the spec already carries so the report's scenario
 * header cannot drift from the contract `check-e2e-meta.mjs` enforces.
 */
function readSpecMeta(testInfo: TestInfo): SpecMeta {
  try {
    const source = readFileSync(testInfo.file, "utf8");
    const quoted = JSON.stringify(testInfo.title);
    const at = source.indexOf(quoted) >= 0 ? source.indexOf(quoted) : source.indexOf(testInfo.title);
    if (at < 0) return {};
    const before = source.slice(0, at);
    const start = before.lastIndexOf("/**");
    if (start < 0) return {};
    const block = before.slice(start);
    if (!block.includes("E2E-META")) return {};
    const field = (name: string): string | undefined => {
      const match = block.match(new RegExp(`^\\s*\\*\\s*${name}:\\s*(.+)$`, "m"));
      return match?.[1]?.trim();
    };
    return {
      costSideEffects: field("CostSideEffects"),
      credentials: field("Credentials"),
      environment: field("Environment"),
      llm: field("LLM"),
      purpose: field("Purpose"),
      type: field("Type"),
    };
  } catch {
    return {};
  }
}

/** Let one frame render before shooting, so screenshots are not mid-transition. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
  await page
    .evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
    .catch(() => undefined);
}

class Reporter implements JourneyReporter {
  private readonly directory: string;

  private readonly logs: JourneyLog[] = [];

  private readonly meta: SpecMeta;

  private readonly notes: string[] = [];

  private readonly startedAt = Date.now();

  private readonly steps: JourneyStepRecord[] = [];

  private prepared: Promise<void> | undefined;

  private scenarioInfo: JourneyScenario | undefined;

  constructor(private readonly page: Page, private readonly testInfo: TestInfo) {
    this.meta = readSpecMeta(testInfo);
    const root = process.env.E2E_JOURNEY_REPORTS?.trim()
      || resolve(testInfo.project.outputDir, "..", "journey-reports");
    const specName = (testInfo.file.split(/[\\/]/).at(-1) ?? "spec").replace(/\.spec\.ts$/, "");
    this.directory = join(root, slug(specName), slug(testInfo.title));
    this.attachPageListeners();
  }

  scenario(scenario: JourneyScenario): void {
    this.scenarioInfo = scenario;
  }

  note(text: string): void {
    this.notes.push(redact(text));
  }

  async step(title: string, description: string, body: () => Promise<void>): Promise<void> {
    const index = this.steps.length + 1;
    const logStart = this.logs.length;
    const started = Date.now();
    let status: JourneyStepStatus = "passed";
    let error: string | undefined;
    try {
      await playwrightTest.step(`${index}. ${title}`, body);
    } catch (caught) {
      status = "failed";
      const raw = caught instanceof Error ? (caught.stack ?? caught.message) : String(caught);
      error = truncate(redact(raw), MAX_ERROR_CHARS);
      throw caught;
    } finally {
      const screenshot = await this.capture(index, title, status);
      this.steps.push({
        description,
        durationMs: Date.now() - started,
        ...(error ? { error } : {}),
        index,
        logs: this.logs.slice(logStart),
        ...(screenshot ? { screenshot } : {}),
        status,
        title,
      });
    }
  }

  async finalize(): Promise<void> {
    const outcome = this.outcome();
    // A gate that stops the test is a blocked precondition, not a broken
    // product: relabel the step that raised it so the report says so.
    if (outcome === "BLOCKED") {
      const last = this.steps.at(-1);
      if (last?.status === "failed") {
        last.status = "blocked";
        // Keep the folder honest too: the shot was named before the gate could
        // be told apart from a real failure.
        if (last.screenshot?.endsWith("-failed.png")) {
          const renamed = last.screenshot.replace(/-failed\.png$/, "-blocked.png");
          const moved = await rename(join(this.directory, last.screenshot), join(this.directory, renamed))
            .then(() => true)
            .catch(() => false);
          if (moved) last.screenshot = renamed;
        }
      }
    }
    const finishedAt = Date.now();
    const markdown = this.renderMarkdown(outcome, finishedAt);
    const html = this.renderHtml(outcome, finishedAt);
    try {
      await this.prepare();
      await writeFile(join(this.directory, "report.md"), markdown, "utf8");
      await writeFile(join(this.directory, "report.html"), html, "utf8");
      await this.testInfo
        .attach("journey-report.md", { contentType: "text/markdown", path: join(this.directory, "report.md") })
        .catch(() => undefined);
      await this.testInfo
        .attach("journey-report.html", { contentType: "text/html", path: join(this.directory, "report.html") })
        .catch(() => undefined);
      process.stdout.write(`journey report (${outcome}): ${redact(join(this.directory, "report.html"))}\n`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`journey report could not be written: ${redact(detail)}\n`);
    }
  }

  private attachPageListeners(): void {
    const push = (kind: JourneyLog["kind"], detail: string): void => {
      this.logs.push({ at: Date.now(), detail: redact(detail), kind });
    };
    this.page.on("console", (message) => {
      const type = message.type();
      if (type !== "error" && type !== "warning") return;
      const where = message.location().url;
      push("console", `[${type}] ${message.text()}${where ? ` @ ${where}` : ""}`);
    });
    this.page.on("pageerror", (error) => push("page", `[pageerror] ${error.message}`));
    this.page.on("requestfailed", (request) => {
      push("network", `${request.method()} ${request.url()} failed: ${request.failure()?.errorText ?? "unknown"}`);
    });
    this.page.on("response", (response) => {
      if (response.status() < 400) return;
      push("network", `${response.request().method()} ${response.url()} -> ${response.status()}`);
    });
  }

  private prepare(): Promise<void> {
    // Clear once per test so a rerun cannot mix its screenshots with old ones.
    this.prepared ??= rm(this.directory, { force: true, recursive: true })
      .catch(() => undefined)
      .then(() => mkdir(this.directory, { recursive: true }))
      .then(() => undefined);
    return this.prepared;
  }

  private async capture(index: number, title: string, status: JourneyStepStatus): Promise<string | undefined> {
    if (this.page.isClosed()) return undefined;
    const name = `${String(index).padStart(2, "0")}-${slug(title)}${status === "passed" ? "" : "-failed"}.png`;
    try {
      await settle(this.page);
      await this.prepare();
      await this.page.screenshot({
        animations: "disabled",
        caret: "hide",
        path: join(this.directory, name),
        scale: "css",
        timeout: 15_000,
      });
      return name;
    } catch {
      // Evidence is best-effort: a missing screenshot must never turn a
      // passing journey red, and a failing one must still report its error.
      return undefined;
    }
  }

  private outcome(): JourneyOutcome {
    const status = this.testInfo.status ?? "passed";
    if (status === "skipped") return "BLOCKED";
    return status === this.testInfo.expectedStatus ? "PASS" : "FAIL";
  }

  private blockedReason(): string | undefined {
    const annotation = this.testInfo.annotations.find((item) => item.type === "skip" || item.type === "fixme");
    if (annotation?.description) return redact(annotation.description);
    const failing = this.steps.find((step) => step.status !== "passed");
    const line = failing?.error?.split("\n").find((entry) => entry.includes("BLOCKED"));
    return line?.trim();
  }

  private goal(): string {
    return this.scenarioInfo?.goal ?? this.meta.purpose ?? "(未声明场景目标)";
  }

  private preconditions(): string[] {
    if (this.scenarioInfo?.preconditions?.length) return this.scenarioInfo.preconditions;
    return this.meta.environment ? [this.meta.environment] : [];
  }

  private specPath(): string {
    return relative(REPO_ROOT, this.testInfo.file).split("\\").join("/");
  }

  private statusLabel(status: JourneyStepStatus): string {
    if (status === "passed") return "✅ 通过";
    return status === "blocked" ? "⛔ 前置未满足" : "❌ 失败";
  }

  private summaryRows(outcome: JourneyOutcome, finishedAt: number): Array<[string, string]> {
    const commit = commitUnderTest();
    return [
      ["结果", `**${outcome}**`],
      ["被测 SHA", `\`${commit.sha}\`${commit.dirty ? "（工作树有未提交改动）" : ""}`],
      ["规格文件", `\`${this.specPath()}\``],
      ["用例", this.testInfo.title],
      ["分组", `${this.testInfo.project.name}${this.testInfo.tags.length ? ` (${this.testInfo.tags.join(" ")})` : ""}`],
      ["开始", new Date(this.startedAt).toISOString()],
      ["结束", new Date(finishedAt).toISOString()],
      ["耗时", formatDuration(finishedAt - this.startedAt)],
      ["步骤", `${this.steps.filter((step) => step.status === "passed").length} / ${this.steps.length} 通过`],
    ];
  }

  private metaRows(): Array<[string, string]> {
    return [
      ["类型", this.meta.type ?? "-"],
      ["模型", this.meta.llm ?? "-"],
      ["凭据", this.meta.credentials ?? "-"],
      ["成本与副作用", this.meta.costSideEffects ?? "-"],
    ];
  }

  private renderMarkdown(outcome: JourneyOutcome, finishedAt: number): string {
    const lines: string[] = [];
    lines.push(`# 旅程报告 · ${this.testInfo.title}`, "");
    lines.push("| 项 | 值 |", "|---|---|");
    for (const [key, value] of this.summaryRows(outcome, finishedAt)) {
      lines.push(`| ${escapeCell(key)} | ${escapeCell(value)} |`);
    }
    lines.push("", "## 场景目标", "", this.goal(), "");

    const preconditions = this.preconditions();
    if (preconditions.length) {
      lines.push("## 前置条件", "");
      for (const item of preconditions) lines.push(`- ${item}`);
      lines.push("");
    }

    const reason = outcome === "BLOCKED" ? this.blockedReason() : undefined;
    if (reason) lines.push("## 门禁原因", "", `> ${reason}`, "");

    lines.push("## 步骤总览", "");
    if (this.steps.length) {
      lines.push("| # | 用户步骤 | 用户应看到 | 结果 | 耗时 | 截图 |", "|---|---|---|---|---|---|");
      for (const step of this.steps) {
        const shot = step.screenshot ? `[${step.screenshot}](${encodeURI(step.screenshot)})` : "—";
        lines.push(`| ${step.index} | ${escapeCell(step.title)} | ${escapeCell(step.description)} | `
          + `${this.statusLabel(step.status)} | ${formatDuration(step.durationMs)} | ${shot} |`);
      }
    } else {
      lines.push("_本次运行在进入第一个用户步骤前就结束了。_");
    }
    lines.push("");

    if (this.steps.length) {
      lines.push("## 步骤详情", "");
      for (const step of this.steps) {
        lines.push(`### ${step.index}. ${step.title}`, "");
        lines.push(`- **用户应看到**：${step.description}`);
        lines.push(`- **结果**：${this.statusLabel(step.status)}（${formatDuration(step.durationMs)}）`, "");
        if (step.screenshot) {
          lines.push(`![步骤 ${step.index} 截图](${encodeURI(step.screenshot)})`, "");
        }
        if (step.error) {
          lines.push("**错误摘要**", "", "```text", step.error, "```", "");
        }
        lines.push("**关键日志**", "");
        const logs = step.logs.slice(0, MAX_LOGS_PER_STEP);
        if (!logs.length) {
          lines.push("_无 console 错误/警告，无失败请求。_", "");
        } else {
          lines.push("```text");
          for (const log of logs) lines.push(`${log.kind}: ${log.detail}`);
          if (step.logs.length > logs.length) lines.push(`… 另有 ${step.logs.length - logs.length} 条已省略`);
          lines.push("```", "");
        }
      }
    }

    if (this.notes.length) {
      lines.push("## 备注", "");
      for (const note of this.notes) lines.push(`- ${note}`);
      lines.push("");
    }

    lines.push("## 运行元数据（来自 E2E-META）", "", "| 项 | 值 |", "|---|---|");
    for (const [key, value] of this.metaRows()) lines.push(`| ${escapeCell(key)} | ${escapeCell(value)} |`);
    lines.push("");
    return `${lines.join("\n")}\n`;
  }

  private renderHtml(outcome: JourneyOutcome, finishedAt: number): string {
    const badge = (status: JourneyStepStatus): string =>
      `<span class="badge ${status}">${escapeHtml(this.statusLabel(status))}</span>`;
    const rows = this.summaryRows(outcome, finishedAt)
      // The summary rows carry Markdown emphasis for report.md; HTML styles
      // the same values itself, so drop the markers rather than show them.
      .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value.replace(/[*`]/g, ""))}</td></tr>`)
      .join("\n");
    const preconditions = this.preconditions()
      .map((item) => `<li>${escapeHtml(item)}</li>`)
      .join("\n");
    const reason = outcome === "BLOCKED" ? this.blockedReason() : undefined;

    const overview = this.steps.length
      ? `<table class="steps">
<thead><tr><th>#</th><th>用户步骤</th><th>用户应看到</th><th>结果</th><th>耗时</th></tr></thead>
<tbody>
${this.steps.map((step) => `<tr><td>${step.index}</td><td><a href="#step-${step.index}">${escapeHtml(step.title)}</a></td>`
        + `<td>${escapeHtml(step.description)}</td><td>${badge(step.status)}</td>`
        + `<td>${formatDuration(step.durationMs)}</td></tr>`).join("\n")}
</tbody></table>`
      : "<p class=\"empty\">本次运行在进入第一个用户步骤前就结束了。</p>";

    const details = this.steps.map((step) => {
      const logs = step.logs.slice(0, MAX_LOGS_PER_STEP);
      const logBlock = logs.length
        ? `<pre class="logs">${escapeHtml(logs.map((log) => `${log.kind}: ${log.detail}`).join("\n"))}${
          step.logs.length > logs.length ? escapeHtml(`\n… 另有 ${step.logs.length - logs.length} 条已省略`) : ""
        }</pre>`
        : "<p class=\"muted\">无 console 错误/警告，无失败请求。</p>";
      const shot = step.screenshot
        ? `<a href="${encodeURI(step.screenshot)}"><img src="${encodeURI(step.screenshot)}" alt="步骤 ${step.index} 截图" /></a>`
        : "<p class=\"muted\">未能采集截图。</p>";
      const error = step.error ? `<h4>错误摘要</h4><pre class="error">${escapeHtml(step.error)}</pre>` : "";
      return `<section class="step" id="step-${step.index}">
<h3>${step.index}. ${escapeHtml(step.title)} ${badge(step.status)}</h3>
<p class="desc"><strong>用户应看到：</strong>${escapeHtml(step.description)}</p>
<p class="muted">耗时 ${formatDuration(step.durationMs)}</p>
${shot}
${error}
<h4>关键日志</h4>
${logBlock}
</section>`;
    }).join("\n");

    const metaRows = this.metaRows()
      .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`)
      .join("\n");
    const notes = this.notes.length
      ? `<h2>备注</h2><ul>${this.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>`
      : "";

    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>旅程报告 · ${escapeHtml(this.testInfo.title)}</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0 auto; max-width: 1080px; padding: 24px 20px 64px;
  font-family: system-ui, -apple-system, "Segoe UI", "Noto Sans CJK SC", sans-serif;
  line-height: 1.6; color: #1c1f23; background: #fff; }
h1 { font-size: 1.6rem; margin: 0 0 4px; }
h2 { font-size: 1.2rem; margin-top: 36px; border-bottom: 1px solid #e3e6ea; padding-bottom: 6px; }
h3 { font-size: 1.05rem; margin: 28px 0 6px; }
h4 { font-size: 0.92rem; margin: 18px 0 6px; color: #4a5058; }
table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 0.92rem; }
th, td { border: 1px solid #e3e6ea; padding: 7px 10px; text-align: left; vertical-align: top; }
th { background: #f6f8fa; font-weight: 600; white-space: nowrap; }
table.steps td:nth-child(1) { width: 40px; text-align: center; }
.outcome { display: inline-block; padding: 3px 12px; border-radius: 999px; font-weight: 700; font-size: 0.9rem; }
.outcome.PASS { background: #e3f6e6; color: #1a7f33; }
.outcome.FAIL { background: #fdeaea; color: #b3261e; }
.outcome.BLOCKED { background: #fff4e0; color: #9a6400; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 0.82rem; white-space: nowrap; }
.badge.passed { background: #e3f6e6; color: #1a7f33; }
.badge.failed { background: #fdeaea; color: #b3261e; }
.badge.blocked { background: #fff4e0; color: #9a6400; }
.step { border-top: 1px solid #eef0f3; padding-top: 4px; }
.step img { max-width: 100%; border: 1px solid #dfe3e8; border-radius: 6px; display: block; margin: 10px 0; }
pre { background: #f6f8fa; border: 1px solid #e3e6ea; border-radius: 6px; padding: 10px 12px;
  overflow-x: auto; font-size: 0.82rem; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
pre.error { background: #fdf3f2; border-color: #f3cfcb; }
.muted { color: #6b7280; font-size: 0.88rem; }
.desc { margin: 2px 0; }
blockquote { margin: 8px 0; padding: 8px 14px; background: #fff4e0; border-left: 4px solid #d79a25; }
@media (prefers-color-scheme: dark) {
  body { background: #16181c; color: #e6e8ea; }
  th { background: #21242a; }
  th, td { border-color: #31363d; }
  pre { background: #1d2026; border-color: #31363d; }
  pre.error { background: #2a1d1d; border-color: #5a2f2c; }
  h2 { border-color: #31363d; }
  .step, .step img { border-color: #31363d; }
}
</style>
</head>
<body>
<h1>旅程报告 · ${escapeHtml(this.testInfo.title)}</h1>
<p><span class="outcome ${outcome}">${outcome}</span></p>
<table>${rows}</table>
<h2>场景目标</h2>
<p>${escapeHtml(this.goal())}</p>
${preconditions ? `<h2>前置条件</h2><ul>${preconditions}</ul>` : ""}
${reason ? `<h2>门禁原因</h2><blockquote>${escapeHtml(reason)}</blockquote>` : ""}
<h2>步骤总览</h2>
${overview}
${this.steps.length ? `<h2>步骤详情</h2>${details}` : ""}
${notes}
<h2>运行元数据（来自 E2E-META）</h2>
<table>${metaRows}</table>
</body>
</html>
`;
  }
}

/** Build the per-test reporter. The `journey` fixture owns its lifecycle. */
export function createJourneyReporter(page: Page, testInfo: TestInfo): JourneyReporter {
  return new Reporter(page, testInfo);
}
