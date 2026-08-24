#!/usr/bin/env node
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

import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";

const layer = process.argv[2];
const layers = {
  st: [
    ["pnpm", ["install", "--frozen-lockfile"]],
    ["pnpm", ["build"]],
    ["bash", ["test/api/run_m1_smoke.sh"]],
  ],
  "st-real": [
    ["pnpm", ["install", "--frozen-lockfile"]],
    ["pnpm", ["build"]],
    ["bash", ["test/api/run_real_smoke.sh"]],
  ],
  "st-npu": [
    [process.env.SCIENCE_AGENT_NPU_PYTHON?.trim() || "python3", ["services/runner/workloads/npu-smoke-test.py"]],
  ],
  ut: [
    ["pnpm", ["install", "--frozen-lockfile"]],
    ["uv", ["sync", "--project", "services/gateway"]],
    ["pnpm", ["check"]],
    ["pnpm", ["memory-graph:test"]],
  ],
  // `ut` minus the sandbox: everything `pnpm check` runs, except the
  // @sciencediscovery/runner package, whose tests assert isolation and the
  // sandbox's path remapping and so need a real bubblewrap.
  "ut-core": [
    ["pnpm", ["install", "--frozen-lockfile"]],
    ["uv", ["sync", "--project", "services/gateway"]],
    ["pnpm", ["architecture:check"]],
    ["pnpm", ["typecheck"]],
    ["pnpm", ["paper:test"]],
    ["pnpm", ["gateway:test"]],
    ["pnpm", ["build"]],
    ["pnpm", ["binary:test"]],
    ["pnpm", ["--recursive", "--filter", "!@sciencediscovery/runner", "test"]],
    ["pnpm", ["memory-graph:test"]],
  ],
  "ut-runner": [
    ["pnpm", ["install", "--frozen-lockfile"]],
    ["pnpm", ["build"]],
    ["pnpm", ["--filter", "@sciencediscovery/runner", "test"]],
  ],
};

if (!(layer in layers)) {
  console.error("Usage: node .ci/run-layer.mjs ut|ut-core|ut-runner|st|st-real|st-npu");
  process.exit(2);
}

const repositoryRoot = process.cwd();
const configuredRoot = process.env.CI_RESULTS_DIR?.trim() || "/ci-results";
const resultsRoot = isAbsolute(configuredRoot) ? configuredRoot : resolve(repositoryRoot, configuredRoot);
const layerRoot = join(resultsRoot, layer);
const logPath = join(layerRoot, "run.log");
const summaryPath = join(layerRoot, "summary.json");
const startedAt = new Date();
const outcomes = [];
let runtimeRoot;

await mkdir(layerRoot, { recursive: true });
const log = createWriteStream(logPath, { flags: "w" });

function emit(chunk, target) {
  target.write(chunk);
  log.write(chunk);
}

async function run(command, args) {
  const commandStarted = new Date();
  const display = [command, ...args].join(" ");
  let capturedStdout = "";
  emit(`\n$ ${display}\n`, process.stdout);
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    env: { ...process.env, CI: "1", SCIENCE_AGENT_DATA_DIR: runtimeRoot },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    if (capturedStdout.length < 1_000_000) capturedStdout += chunk.toString();
    emit(chunk, process.stdout);
  });
  child.stderr.on("data", (chunk) => emit(chunk, process.stderr));
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveExit(code ?? (signal ? 128 : 1)));
  });
  outcomes.push({
    command: display,
    durationMs: Date.now() - commandStarted.getTime(),
    exitCode,
  });
  return { exitCode, stdout: capturedStdout };
}

function validNpuSmoke(stdout) {
  const lines = stdout.trim().split("\n").reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      return value.ok === true
        && value.device_target === "Ascend"
        && JSON.stringify(value.result) === "[4,4,4]";
    } catch {
      // MindSpore may emit informational lines before the smoke JSON.
    }
  }
  return false;
}

let exitCode = 0;
try {
  if (layer === "st-real") {
    if (process.env.CI_ALLOW_REAL !== "1") {
      throw new Error("set CI_ALLOW_REAL=1 for explicit live-model opt-in");
    }
    const required = ["SCIENCE_AGENT_LLM_BASE_URL", "SCIENCE_AGENT_LLM_MODEL", "SCIENCE_AGENT_LLM_API_TOKEN"];
    const missing = required.filter((name) => !process.env[name]?.trim());
    if (missing.length > 0) throw new Error(`missing ${missing.join(", ")}`);
  } else if (layer === "st-npu") {
    if (process.env.CI_ALLOW_NPU !== "1") {
      throw new Error("set CI_ALLOW_NPU=1 for explicit NPU opt-in");
    }
    if (!process.env.SCIENCE_AGENT_NPU_PYTHON?.trim()) {
      throw new Error("missing SCIENCE_AGENT_NPU_PYTHON");
    }
  }
  const configuredRuntimeRoot = process.env.CI_RUNTIME_DIR?.trim() || "/ci-cache/sciencediscovery-tests";
  await mkdir(configuredRuntimeRoot, { recursive: true });
  runtimeRoot = await mkdtemp(join(configuredRuntimeRoot, `${layer}-`));
  await stat(join(repositoryRoot, "package.json"));
  for (const [command, args] of layers[layer]) {
    const result = await run(command, args);
    exitCode = result.exitCode;
    if (layer === "st-npu" && exitCode === 0 && !validNpuSmoke(result.stdout)) {
      exitCode = 1;
      outcomes.at(-1).exitCode = 1;
      emit("NPU smoke assertion failed: expected Ascend result [4,4,4].\n", process.stderr);
    }
    if (exitCode !== 0) break;
  }
} catch (error) {
  exitCode = 2;
  const message = error instanceof Error ? error.message : String(error);
  emit(`BLOCKED: CI source precondition failed: ${message}\n`, process.stderr);
}

if (runtimeRoot) {
  try {
    await rm(runtimeRoot, { force: true, recursive: true });
  } catch (error) {
    exitCode ||= 1;
    const message = error instanceof Error ? error.message : String(error);
    emit(`CI runtime cleanup failed: ${message}\n`, process.stderr);
  }
}

const finishedAt = new Date();
const summary = {
  durationMs: finishedAt.getTime() - startedAt.getTime(),
  exitCode,
  finishedAt: finishedAt.toISOString(),
  layer,
  outcomes,
  startedAt: startedAt.toISOString(),
  status: exitCode === 0 ? "passed" : exitCode === 2 && outcomes.length === 0 ? "blocked" : "failed",
};
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
await new Promise((resolveClose) => log.end(resolveClose));
console.log(`${layer.toUpperCase()} result: ${summary.status}; summary=${summaryPath}; log=${logPath}`);
process.exitCode = exitCode;
