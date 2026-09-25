// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function evaluateTeam(input: string, output: string, timeout: number): Promise<Record<string, any>> {
  if (process.env.E2E_TEAM_EVALUATION === "off") return { status: "disabled", gating: false };
  if (await lstat(output).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) {
    return { status: "error", total_score: null, gating: false, error: "Evaluation output already exists; choose a fresh directory" };
  }
  try {
    if (![undefined, "rubric"].includes(process.env.E2E_TEAM_EVALUATION)) throw new Error("E2E_TEAM_EVALUATION must be rubric or off");
    const script = fileURLToPath(new URL("../benchmarks/research-team/judge.py", import.meta.url));
    await promisify(execFile)(process.env.TEAM_JUDGE_PYTHON ?? "python3", [script, "--input", input, "--output", output], { timeout, killSignal: "SIGKILL" });
    return JSON.parse(await readFile(`${output}/scorecard.json`, "utf8"));
  } catch (error) {
    await mkdir(output, { recursive: true });
    const result = { status: "error", total_score: null, gating: false, error: error instanceof Error ? error.message : String(error) };
    await writeFile(`${output}/scorecard.json`, JSON.stringify(result, null, 2));
    return result;
  }
}
