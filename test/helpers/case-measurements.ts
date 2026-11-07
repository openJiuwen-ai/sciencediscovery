// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { APIRequestContext, TestInfo } from "@playwright/test";
import { apiBaseUrl, authorizationHeader } from "../e2e-auth.js";
import { caseIdentity, collectCaseMeasurements } from "./case-measurements.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
// Upper bound of one collection. Its time is given back to the test afterwards.
const budgetMs = 60_000;
const requestTimeoutMs = 15_000;

export type CaseMeasurements = Partial<Record<"generation_output_tokens" | "total_tokens" | "tool_calls", number>>;

/**
 * Collect the shared numeric measurements of a Session before its records are
 * cleaned up. Collection never throws and runs outside the test's own time
 * budget, so it cannot change whether the case passes or fails.
 */
export async function measureSession(request: APIRequestContext, info: TestInfo, sessionId: string,
  options: { evolveRunIds?: string[] } = {}): Promise<CaseMeasurements> {
  const timeout = info.timeout, started = Date.now(), deadline = started + budgetMs;
  const extend = (ms: number) => { try { if (timeout > 0) info.setTimeout(timeout + ms); } catch { /* Timing only. */ } };
  extend(budgetMs);
  try {
    return await collectCaseMeasurements(async (path: string) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Measurement budget spent");
      const response = await request.get(`${apiBaseUrl()}${path}`,
        { headers: authorizationHeader(), timeout: Math.min(remaining, requestTimeoutMs) });
      if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
      return response.json();
    }, sessionId, options);
  } catch {
    return {};
  } finally {
    extend(Date.now() - started);
  }
}

function planEntries(): unknown[] {
  try {
    const plan = JSON.parse(readFileSync(process.env.SCIENCE_TAG_PLAN ?? "", "utf8"));
    return Array.isArray(plan?.entries) ? plan.entries : [];
  } catch {
    return [];
  }
}

/**
 * Write `case-metrics.json`, the only metrics document of a case that has no
 * benchmark, team or evolve metrics of its own: the plan identity and numbers.
 */
export async function writeCaseMetrics(request: APIRequestContext, info: TestInfo, sessionId: string): Promise<void> {
  const measurements = await measureSession(request, info, sessionId);
  try {
    const identity = caseIdentity({ source: relative(root, info.file).replaceAll("\\", "/"),
      project: info.project.name, titlePath: info.titlePath }, planEntries());
    await writeFile(info.outputPath("case-metrics.json"), JSON.stringify({ schema_version: 1, ...identity, measurements }, null, 2));
  } catch { /* Optional evidence: without this file the case keeps n/a cells. */ }
}
