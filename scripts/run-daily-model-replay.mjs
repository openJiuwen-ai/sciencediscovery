#!/usr/bin/env node
// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

/**
 * Run the twelve daily journeys against recorded model responses.
 *
 * The original @real specs are deliberately left unchanged. This runner starts
 * a local response server for one capture, points the normal isolated E2E stack
 * at it, and fails if the journey does not consume the complete capture.
 * Captures are supplied outside the repository with E2E_REPLAY_CAPTURE_ROOT.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverScript = join(repoRoot, "scripts", "model-replay-server.mjs");
const captureRoot = resolve(process.env.E2E_REPLAY_CAPTURE_ROOT || join(repoRoot, "work", "model-replay", "captures"));
const resultsRoot = resolve(process.env.E2E_REPLAY_RESULTS_DIR || join(tmpdir(), "sciencediscovery-daily-replay"));

const cases = [
  { id: "DRB-58", prefix: "drb-58-serial120-", grep: "DRB-58", variant: "openai" },
  { id: "DRB-59", prefix: "drb-59-serial-", grep: "DRB-59", variant: "openai" },
  { id: "DRB-62", prefix: "drb-62-serial120-", grep: "DRB-62", variant: "openai" },
  { id: "DRB-64", prefix: "drb-64-serial-", grep: "DRB-64", variant: "openai" },
  { id: "DRB-75", prefix: "drb-75-newtoken-", grep: "DRB-75", variant: "openai" },
  { id: "TC-E2E-01", prefix: "tc-e2e-01-newtoken120-", grep: "TC-E2E-01", variant: "openai" },
  { id: "PUCT-COMPRESS", prefix: "puct-compress-newtoken-deepseek-", grep: "PUCT-COMPRESS", variant: "deepseek" },
  { id: "J5", prefix: "j5-legacy-capture3-", grep: "J5 真实请求生成统计结果并交付 Markdown", variant: "openai" },
  { id: "Inline Plan", prefix: "inline-plan-", grep: "workspace plan and run-anchored", variant: "openai" },
  { id: "Inline Markdown", prefix: "inline-markdown-", grep: "markdown outputs anchor", variant: "openai" },
  { id: "Biomni DA-13-3", prefix: "biomni-da-13-3-newtoken-", grep: "BiomniBench-da-13-3", variant: "deepseek", biomni: true },
  { id: "Biomni DA-14-1", prefix: "biomni-da-14-1-newtoken-", grep: "BiomniBench-da-14-1", variant: "deepseek", biomni: true },
];

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function usage() {
  console.log(`Usage: node scripts/run-daily-model-replay.mjs --case <id|all|list>

Required for a checkout without captures in work/: E2E_REPLAY_CAPTURE_ROOT=/path/to/captures
Optional: E2E_REPLAY_RESULTS_DIR=/tmp/sciencediscovery-daily-replay
          E2E_REPLAY_BIOMNI_DATA_ROOT=/path/to/biomnibench-da
          E2E_REPLAY_BIOMNI_PLAN=/path/to/biomni-capture-plan-deepseek.json
          E2E_REPLAY_CONTINUE=1 (run later cases after a failure)

The stack is isolated for every case. Set CI_E2E_PREPARED=1 after preparing the
workspace to avoid repeating dependency and browser setup.`);
}

const selected = option("--case");
if (hasFlag("--help") || !selected) {
  usage();
  process.exit(selected ? 0 : 2);
}
if (selected === "list") {
  console.log(cases.map((item) => item.id).join("\n"));
  process.exit(0);
}

const chosen = selected === "all" ? cases : cases.filter((item) => item.id === selected);
if (chosen.length !== 1 && selected !== "all") {
  throw new Error(`Unknown daily replay case: ${selected}`);
}

async function resolveCapture(item) {
  const names = (await readdir(captureRoot)).filter((name) => name.startsWith(item.prefix));
  if (names.length !== 1) throw new Error(`${item.id}: expected one capture beginning ${item.prefix}, found ${names.length}`);
  const directory = join(captureRoot, names[0]);
  const metadata = Object.fromEntries((await readFile(join(directory, "metadata.env"), "utf8"))
    .split(/\r?\n/).filter(Boolean).map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
  return { directory, metadata };
}

function startServer(args) {
  const child = spawn(process.execPath, [serverScript, ...args], { stdio: ["ignore", "pipe", "inherit"] });
  const ready = new Promise((resolveReady, reject) => {
    let buffered = "";
    const onData = (chunk) => {
      buffered += chunk;
      const line = buffered.split("\n").find((value) => value.trim());
      if (!line) return;
      child.stdout.off("data", onData);
      try { resolveReady(JSON.parse(line)); } catch (error) { reject(error); }
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => code && reject(new Error(`replay server exited with ${code}`)));
  });
  return { child, ready };
}

async function stop(child) {
  if (!child) return;
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolveExit) => child.once("exit", resolveExit));
}

async function status(url, token) {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Replay status failed: HTTP ${response.status}`);
  return response.json();
}

async function scorecardResponse(item, captureDirectory, workDirectory) {
  if (!item.biomni) return undefined;
  const candidates = [];
  async function visit(directory) {
    for (const name of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, name.name);
      if (name.isDirectory()) await visit(path);
      else if (name.name === "quality-scorecard.json") candidates.push(path);
    }
  }
  await visit(captureDirectory);
  if (candidates.length !== 1) throw new Error(`${item.id}: expected one saved quality-scorecard.json, found ${candidates.length}`);
  const scorecard = JSON.parse(await readFile(candidates[0], "utf8"));
  const body = {
    id: `replay-judge-${item.id}`,
    object: "chat.completion",
    model: "daily-replay-judge",
    choices: [{ index: 0, finish_reason: "stop", message: {
      role: "assistant",
      content: JSON.stringify({ criteria: scorecard.criteria }),
    } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  const path = join(workDirectory, `${item.id.replaceAll(/[^a-zA-Z0-9]+/g, "-")}-judge-response.json`);
  await writeFile(path, JSON.stringify(body));
  return path;
}

async function runCase(item, caseIndex) {
  const { directory, metadata } = await resolveCapture(item);
  const caseRoot = join(resultsRoot, item.id.replaceAll(/[^a-zA-Z0-9]+/g, "-"));
  await mkdir(caseRoot, { recursive: true });
  const token = `daily-replay-${randomBytes(12).toString("hex")}`;
  const model = metadata.model || process.env.E2E_REPLAY_MODEL || "replay-model";
  const useSwarm = item.id.startsWith("DRB-") || item.id === "TC-E2E-01" || item.biomni === true;
  const replay = startServer(["--capture-dir", join(directory, "model-calls"), "--token", token]);
  let judge;
  try {
    const replayReady = await replay.ready;
    const judgeWork = join(caseRoot, "judge");
    await mkdir(judgeWork, { recursive: true });
    const judgeResponse = await scorecardResponse(item, directory, judgeWork);
    judge = judgeResponse ? startServer(["--static-response", judgeResponse, "--token", token]) : undefined;
    const judgeReady = judge ? await judge.ready : undefined;
    const stackPort = Number(process.env.E2E_REPLAY_STACK_PORT || 4700) + caseIndex * 10;
    const env = {
      ...process.env,
      CI_ALLOW_REAL: "1",
      E2E_REAL: "1",
      E2E_REPLAY: "1",
      CI_E2E_BACKEND: useSwarm ? "jiuwenswarm" : (process.env.CI_E2E_BACKEND || "legacy"),
      E2E_SWARM_TASK: useSwarm ? "1" : (process.env.E2E_SWARM_TASK || "0"),
      E2E_LLM_BASE_URL: replayReady.baseUrl,
      E2E_LLM_TOKEN: token,
      E2E_LLM_MODEL: model,
      E2E_LLM_API_VARIANT: item.variant,
      E2E_DRB_EVALUATION: "off",
      E2E_TEAM_EVALUATION: "off",
      E2E_PUCT_LLM_EVALUATION: "0",
      E2E_KEEP_RESEARCH_RECORDS: "1",
      E2E_SCIENTIFIC_ENVS: process.env.E2E_SCIENTIFIC_ENVS || "1",
      CI_E2E_GREP: item.grep,
      CI_RESULTS_DIR: join(caseRoot, "ci-results"),
      CI_RUNTIME_DIR: join(caseRoot, "runtime"),
      SCIENCE_AGENT_PORT: String(stackPort),
      SCIENCE_AGENT_RUNNER_PORT: String(stackPort + 1),
      SCIENCE_AGENT_MEMORY_GRAPH_PORT: String(stackPort + 2),
    };
    if (item.biomni) {
      const plan = process.env.E2E_REPLAY_BIOMNI_PLAN || join(captureRoot, "biomni-capture-plan-deepseek.json");
      const dataRoot = process.env.E2E_REPLAY_BIOMNI_DATA_ROOT || process.env.BIOMNI_DATA_ROOT;
      if (!dataRoot) throw new Error(`${item.id}: set E2E_REPLAY_BIOMNI_DATA_ROOT`);
      env.BIOMNI_DATA_ROOT = dataRoot;
      env.SCIENCE_TAG_PLAN = plan;
      env.E2E_BIOMNI_EVALUATION = "rubric";
      env.BIOMNI_JUDGE_BASE_URL = judgeReady.baseUrl;
      env.BIOMNI_JUDGE_MODEL = "daily-replay-judge";
      env.BIOMNI_JUDGE_API_KEY = token;
    }
    const command = spawn("bash", [".ci/run-e2e.sh", "real"], { cwd: repoRoot, env, stdio: "inherit" });
    const exitCode = await new Promise((resolveExit, reject) => {
      command.once("error", reject);
      command.once("exit", (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
    });
    const replayStatus = await status(replayReady.statusUrl, token);
    const complete = replayStatus.failures.length === 0 && replayStatus.consumed === replayStatus.total;
    const result = { case: item.id, capture: directory, exit_code: exitCode, replay: replayStatus, complete };
    await writeFile(join(caseRoot, "replay-summary.json"), JSON.stringify(result, null, 2) + "\n");
    if (exitCode !== 0) throw new Error(`${item.id}: E2E process exited ${exitCode}`);
    if (!complete) throw new Error(`${item.id}: replay consumed ${replayStatus.consumed}/${replayStatus.total} responses`);
    return result;
  } finally {
    await stop(judge?.child);
    await stop(replay.child);
  }
}

await mkdir(resultsRoot, { recursive: true });
const failures = [];
for (const [index, item] of chosen.entries()) {
  try {
    const result = await runCase(item, cases.indexOf(item));
    console.log(`PASS ${result.case}: consumed ${result.replay.consumed}/${result.replay.total}`);
  } catch (error) {
    failures.push({ case: item.id, error: error instanceof Error ? error.message : String(error) });
    console.error(`FAIL ${item.id}: ${failures.at(-1).error}`);
    if (!process.env.E2E_REPLAY_CONTINUE && selected === "all") break;
  }
}
if (failures.length) {
  console.error(JSON.stringify({ failures }, null, 2));
  process.exit(1);
}
