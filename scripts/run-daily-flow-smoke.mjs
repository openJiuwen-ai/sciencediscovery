#!/usr/bin/env node
// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

/**
 * Run the twelve deterministic daily PR-gate journeys in one isolated stack.
 * The original @real journeys remain available for research-quality coverage;
 * this profile only guards product flow contracts and never calls a provider.
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsRoot = resolve(process.env.DAILY_SMOKE_RESULTS_DIR || "/home/zjc/master/sciencediscovery/work/model-replay/daily-smoke-results");
const runtimeRoot = resolve(process.env.DAILY_SMOKE_RUNTIME_DIR || "/home/zjc/master/sciencediscovery/work/model-replay/daily-smoke-runtime");
await mkdir(resultsRoot, { recursive: true });
await mkdir(runtimeRoot, { recursive: true });

const env = {
  ...process.env,
  CI_E2E_FIXTURE: "standard",
  CI_E2E_SWARM_CHECKS: "off",
  CI_E2E_BACKEND: "jiuwenswarm",
  CI_E2E_SPEC: "test/daily-flow-smoke.spec.ts",
  CI_E2E_GREP: "@daily-smoke",
  CI_RESULTS_DIR: resultsRoot,
  CI_RUNTIME_DIR: runtimeRoot,
  SCIENCE_AGENT_PORT: process.env.SCIENCE_AGENT_PORT || "4820",
  SCIENCE_AGENT_RUNNER_PORT: process.env.SCIENCE_AGENT_RUNNER_PORT || "4821",
  SCIENCE_AGENT_MEMORY_GRAPH_PORT: process.env.SCIENCE_AGENT_MEMORY_GRAPH_PORT || "17794",
};

const child = spawn("bash", [".ci/run-e2e.sh", "mocked"], { cwd: repoRoot, env, stdio: "inherit" });
child.once("error", (error) => { console.error(error); process.exitCode = 1; });
child.once("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
