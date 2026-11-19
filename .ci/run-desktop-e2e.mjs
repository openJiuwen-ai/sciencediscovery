#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { desktopReportTests, summarizePlaywrightReport } from "./desktop-result.mjs";

const [mode] = process.argv.slice(2);
const startedAt = new Date().toISOString();

async function run() {
  if (!["mocked", "ui-st", "real"].includes(mode)) {
    console.error("Usage: node .ci/run-desktop-e2e.mjs mocked|ui-st|real");
    return 2;
  }
  const root = resolve(process.env.CI_RESULTS_DIR || ".ci-results");
  const resultDir = resolve(root, "desktop-runs", mode);
  const planPath = resolve(resultDir, "plan.json");
  const reportPath = resolve(resultDir, "playwright-results.json");
  await mkdir(resultDir, { recursive: true });
  // A process that dies before writing its JSON must never reuse another run's report.
  await Promise.all([planPath, reportPath, resolve(root, `desktop-${mode}.json`)].map(path => rm(path, { force: true })));
  const finish = async (summary, exitCode) => {
    const status = exitCode === 0 ? "passed" : exitCode === 2 ? "blocked" : "failed";
    await writeFile(resolve(root, `desktop-${mode}.json`), `${JSON.stringify({
      mode, startedAt, finishedAt: new Date().toISOString(), status, exitCode, ...summary,
    }, null, 2)}\n`);
    return exitCode;
  };
  const block = (reason) => {
    console.error(`BLOCKED: desktop ${mode}: ${reason}`);
    return finish({ result: "BLOCKED", reason, planned: 0, collected: 0, executed: 0, passed: 0, failed: 0, skipped: 0, blocked: 0, capability_not_present: 0, not_run: 0 }, 2);
  };
  if (mode === "real") {
    const required = ["E2E_API_TOKEN", "E2E_BASE_URL", "E2E_LLM_BASE_URL", "E2E_LLM_MODEL", "E2E_LLM_TOKEN"];
    const missing = required.filter(name => !process.env[name]?.trim());
    if (process.env.CI_ALLOW_REAL !== "1") missing.unshift("CI_ALLOW_REAL=1");
    if (missing.length) return block(`requires ${missing.join(", ")}`);
  }
  const cli = resolve(".e2e/node_modules/playwright/cli.js");
  if (!existsSync(cli)) return block("Playwright is not installed in .e2e");
  const config = resolve(`apps/desktop/e2e${mode === "real" ? "-real" : ""}/playwright.config.ts`);
  const args = [cli, "test", "--config", config, "--output", resolve(resultDir, "test-results")];
  if (mode === "ui-st") args.push("--grep", "@ui-st");
  const playwright = (output, extra = []) => spawnSync(process.execPath, [...args, ...extra], {
    stdio: "inherit",
    env: { ...process.env, CI: "1", CI_RESULT_FILE: output, PLAYWRIGHT_GREP: "" },
  });
  const read = (path) => JSON.parse(readFileSync(path, "utf8"));
  let plan = { suites: [] };
  try {
    const selection = process.env.CI_DESKTOP_SPECS || "all";
    if (mode === "mocked" && selection !== "all") {
      const specs = JSON.parse(selection);
      if (!Array.isArray(specs) || !specs.length || specs.some(file => !/^apps\/desktop\/e2e\/[\w-]+\.spec\.ts$/u.test(file))) {
        throw new Error("Invalid Desktop changed-path selection");
      }
      if (specs.every(file => existsSync(resolve(file)))) {
        args.push(...specs.map(file => `${file.replaceAll(".", "\\.")}$`));
      }
    }
    const collection = playwright(planPath, ["--list"]);
    if (collection.status !== 0) throw new Error("Playwright collection failed");
    plan = read(planPath);
    if (!desktopReportTests(plan).size || plan.errors?.length) throw new Error("Playwright collection produced no valid Desktop plan");
    const execution = playwright(reportPath);
    const report = existsSync(reportPath) ? read(reportPath) : undefined;
    const accounting = summarizePlaywrightReport(plan, report);
    const success = execution.status === 0 && accounting.result === "PASS";
    return finish({ ...accounting, result: !success && accounting.result === "PASS" ? "FAIL" : accounting.result, playwrightExitCode: execution.status }, success ? 0 : accounting.result === "BLOCKED" ? 2 : 1);
  } catch (error) {
    console.error(`Desktop ${mode}: ${error.message}`);
    let accounting;
    try { accounting = summarizePlaywrightReport(plan); }
    catch { accounting = summarizePlaywrightReport({ suites: [] }); }
    return finish({ ...accounting, problems: [...accounting.problems, error.message], result: "FAIL" }, 1);
  }
}

process.exitCode = await run();
