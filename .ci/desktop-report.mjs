import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { summarizePlaywrightReport } from "./desktop-result.mjs";

const DEFAULT_REQUIRED_MODES = ["ui-st", "mocked"];

async function jsonFiles(root) {
  const files = [];
  async function walk(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/^desktop-(?:ui-st|mocked|real)\.json$/u.test(entry.name)) files.push(path);
    }
  }
  await walk(root);
  return files.sort();
}

export async function reconcileDesktopResults(root, requiredModes = DEFAULT_REQUIRED_MODES) {
  const files = await jsonFiles(resolve(root));
  const byMode = new Map();
  const problems = [];
  for (const file of files) {
    let summary;
    try { summary = JSON.parse(await readFile(file, "utf8")); }
    catch (error) {
      problems.push(`${file}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const mode = summary?.mode;
    if (!requiredModes.includes(mode)) continue;
    if (byMode.has(mode)) problems.push(`${mode}: duplicate desktop summary`);
    byMode.set(mode, { ...summary, file });
  }
  for (const mode of requiredModes) {
    const summary = byMode.get(mode);
    if (!summary) {
      problems.push(`${mode}: desktop result summary is missing`);
      continue;
    }
    if (summary.result !== "PASS" || summary.status !== "passed" || summary.exitCode !== 0 || summary.playwrightExitCode !== 0) {
      problems.push(`${mode}: reported result is ${summary.result ?? "UNKNOWN"}`);
    }
    try {
      const runDir = join(dirname(summary.file), "desktop-runs", mode);
      const read = async (name) => JSON.parse(await readFile(join(runDir, name), "utf8"));
      const accounting = summarizePlaywrightReport(await read("plan.json"), await read("playwright-results.json"));
      if (accounting.result !== "PASS") problems.push(`${mode}: reconciled result is ${accounting.result}`);
      const fields = ["planned", "collected", "executed", "passed", "failed", "skipped", "blocked", "capability_not_present", "not_run", "result", "cases", "problems"];
      for (const field of fields) {
        if (JSON.stringify(summary[field]) !== JSON.stringify(accounting[field])) problems.push(`${mode}: summary ${field} does not match raw evidence`);
      }
    } catch (error) {
      problems.push(`${mode}: missing or invalid Desktop execution evidence (${error.message})`);
    }
  }
  return { requiredModes: [...requiredModes], summaries: [...byMode.values()], problems };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const root = process.argv[2] ?? ".ci-results/desktop-evidence";
  const required = process.argv.slice(3).length ? process.argv.slice(3) : DEFAULT_REQUIRED_MODES;
  const report = await reconcileDesktopResults(root, required);
  for (const summary of report.summaries) console.log(`${summary.mode}: ${summary.passed}/${summary.planned} passed`);
  if (report.problems.length) {
    console.error(`Desktop result reconciliation failed:\n- ${report.problems.join("\n- ")}`);
    process.exitCode = 1;
  } else console.log(`Desktop result reconciliation OK: ${required.join(", ")}`);
}
