import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { apiBaseUrl, authorizationHeader } from "../e2e-auth.js";

export const drbQuestion = "In ecology, how do birds achieve precise location and direction navigation during migration? What cues and disturbances influence this process?";
export const drbOutput = "deepresearchbench-59.md";
export const drbPrompt = researchPrompt(drbQuestion, drbOutput);
export function researchPrompt(question: string, output: string, maxSubagents = process.env.E2E_DRB_MAX_SUBAGENTS): string {
  const limit = maxSubagents === undefined ? undefined : Number(maxSubagents);
  if (limit !== undefined && (!maxSubagents?.trim() || !Number.isInteger(limit) || limit < 0)) throw new Error("E2E_DRB_MAX_SUBAGENTS must be a non-negative integer");
  return [
  "Complete the following DeepResearchBench task as a scientific literature review.",
  "The original question defines the research scope. Choose your own research strategy, delegation and search depth.",
  ...(limit === undefined ? [] : [
    `Cost-control constraint: create at most ${limit} subagents TOTAL during this task, not ${limit} concurrently or per batch. Failed or cancelled children also count. Do not create replacement or nested agents to bypass this limit. Complete remaining work yourself using the available tools.`,
    "Reuse acquired evidence and avoid duplicate searches. Once evidence is sufficient, synthesize and deliver the report rather than expanding the investigation indefinitely.",
  ]),
  "Use credible sources, synthesize the evidence, and distinguish established findings, contested claims and limitations.",
  "Support substantive claims with inline citations linked to source URLs in the references.",
  `Deliver the full report as a declared Markdown Artifact named ${output}; mention it in your final answer.`,
  "<task>", question, "</task>",
  ].join("\n");
}

export function positiveNumber(name: string, fallback: number): number {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

export async function drbApi<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`${apiBaseUrl()}${path}`, { headers: authorizationHeader() });
  if (!response.ok()) throw new Error(`GET ${path}: HTTP ${response.status()}`);
  return response.json();
}

export async function drbArticle(page: Page, sessionId: string, output = drbOutput): Promise<{ article: string; versionId: string }> {
  const prefix = `/api/sessions/${encodeURIComponent(sessionId)}`;
  const artifacts = await drbApi<Array<{ id: string; logicalName: string }>>(page, `${prefix}/artifacts`);
  const artifact = artifacts.find((a) => a.logicalName === output);
  if (!artifact) throw new Error("Expected declared report not found");
  const versions = await drbApi<Array<{ id: string; version: number }>>(page, `${prefix}/artifacts/${encodeURIComponent(artifact.id)}/versions`);
  const latest = versions.sort((a, b) => b.version - a.version)[0];
  if (!latest) throw new Error("Report has no persisted version");
  const response = await page.request.get(`${apiBaseUrl()}${prefix}/artifact-versions/${encodeURIComponent(latest.id)}/content`, { headers: authorizationHeader() });
  if (!response.ok()) throw new Error(`Report content HTTP ${response.status()}`);
  return { article: await response.text(), versionId: latest.id };
}

export function evaluationConfig() {
  const mode = process.env.E2E_DRB_EVALUATION ?? "full";
  if (!["off", "race", "full"].includes(mode)) throw new Error("E2E_DRB_EVALUATION must be off, race or full");
  const python = process.env.DRB_PYTHON ?? "python3";
  const upstream = process.env.DRB_UPSTREAM_DIR;
  if (mode !== "off" && !upstream) throw new Error("DRB_UPSTREAM_DIR is required for quality evaluation");
  const script = fileURLToPath(new URL("../benchmarks/deepresearchbench/evaluate.py", import.meta.url));
  const args = [script, "--upstream", upstream ?? "", "--mode", mode];
  for (const [env, flag] of [["E2E_DRB_MIN_RACE", "--min-race"], ["E2E_DRB_MIN_FACT", "--min-fact"], ["E2E_DRB_MIN_COVERAGE", "--min-coverage"]] as const) {
    if (process.env[env] !== undefined) args.push(flag, process.env[env]!);
  }
  return { mode, python, args };
}

export async function evaluationPreflight(config: ReturnType<typeof evaluationConfig>) {
  if (config.mode !== "off") await promisify(execFile)(config.python, [...config.args, "--preflight"], { timeout: 30_000 });
}

export async function evaluateReport(config: ReturnType<typeof evaluationConfig>, input: string, output: string, timeout: number): Promise<Record<string, any>> {
  if (config.mode === "off") return { status: "disabled" };
  let executionError = false;
  try {
    await promisify(execFile)(config.python, [...config.args, "--input", input, "--output", output], { timeout, killSignal: "SIGKILL" });
  } catch { executionError = true; }
  const result = await readFile(`${output}/scorecard.json`, "utf8").then(JSON.parse).catch(() => ({ status: "error" }));
  if (executionError && !["failed", "error"].includes(result.status)) result.status = "error";
  return result;
}
