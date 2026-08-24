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

import { test as base, type BrowserContext, type TestInfo } from "@playwright/test";

import { createJourneyReporter, type JourneyReporter } from "./journey-report.ts";

export type { JourneyReporter } from "./journey-report.ts";

const CONFIG_CONTRACT = "mocked-egress-v2";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

if (process.env.SCIENCE_AGENT_E2E_CONFIG_CONTRACT !== CONFIG_CONTRACT) {
  throw new Error("BLOCKED: E2E config safety contract is missing; synchronize .e2e before running tests");
}

function isLocal(url: string): boolean {
  return LOCAL_HOSTS.has(new URL(url).hostname);
}

/**
 * Abort every browser request that does not target the local stack. The
 * automatic mocked fixture installs this before hooks and pages, preventing
 * accidental CDN, telemetry, model, or WebSocket traffic. Backend egress
 * (API → model) is not visible here; mocked specs keep it local by registering
 * their own 127.0.0.1 stub model.
 */
export async function blockNonLocalRequests(context: BrowserContext): Promise<void> {
  await context.route("**/*", (route) => {
    if (isLocal(route.request().url())) {
      return route.continue();
    }
    return route.abort("blockedbyclient");
  });
  await context.routeWebSocket(() => true, async (webSocket) => {
    if (isLocal(webSocket.url())) {
      webSocket.connectToServer();
      return;
    }
    await webSocket.close({ code: 1008, reason: "Non-local WebSocket blocked by mocked E2E policy" });
  });
}

export const test = base.extend<{ journey: JourneyReporter; mockedNetworkGuard: void }>({
  /**
   * Step-by-step evidence for user journeys. The reporter is torn down by the
   * fixture rather than by a per-spec `afterEach`, so `report.md` and
   * `report.html` are written for every outcome — passed, failed, or blocked —
   * and a spec cannot forget to produce them.
   */
  journey: async ({ page }, use, testInfo) => {
    const reporter = createJourneyReporter(page, testInfo);
    try {
      await use(reporter);
    } finally {
      await reporter.finalize();
    }
  },
  mockedNetworkGuard: [
    async ({ context }, use, testInfo) => {
      if (testInfo.tags.includes("@mocked")) await blockNonLocalRequests(context);
      await use();
    },
    { auto: true },
  ],
});

/**
 * Gate each @real test body before its first external action. Missing values
 * skip that test with a BLOCKED reason so a run without credentials reports
 * the unmet precondition instead of a false pass or connection failure.
 * Returns the resolved values for convenience.
 */
export function requireRealEnv(testInfo: TestInfo, ...names: string[]): Record<string, string> {
  const missing = names.filter((name) => !process.env[name]?.trim());
  if (missing.length) {
    const reason = `BLOCKED: missing required env ${missing.join(", ")}`;
    console.warn(reason);
    testInfo.skip(true, reason);
  }
  return Object.fromEntries(names.map((name) => [name, process.env[name] ?? ""]));
}

/** Record a reviewed exception for a real test that genuinely needs no LLM credentials. */
export function allowRealEnvException(testInfo: TestInfo, reason: string): void {
  if (!reason.trim()) throw new Error("A real environment gate exception requires a reason");
  testInfo.annotations.push({ type: "real-env-gate-exception", description: reason });
}

/**
 * Skip only when the configured local stack is absent or recognizably incomplete.
 *
 * The resident stack is API + Runner, so one probe covers it: the API reports
 * `status: "ok"` only when the Runner answered its own health check, and echoes
 * that Runner status back. There is no third service to probe — the agent loop,
 * the MCP client, and the web providers all run inside the API process.
 */
export async function requireRealStack(
  testInfo: TestInfo,
  apiOrigin = process.env.E2E_API_URL ?? process.env.E2E_BASE_URL ?? "http://127.0.0.1:4310",
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(new URL("/health", apiOrigin), { signal: AbortSignal.timeout(3_000) });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const reason = `BLOCKED: ScienceDiscovery stack is unavailable at configured E2E API origin (${detail})`;
    console.warn(reason);
    testInfo.skip(true, reason);
    return;
  }
  if (!response.ok) throw new Error(`Real stack health check failed with HTTP ${response.status}`);

  const health = await response.json() as { runner?: { status?: string }; service?: string; status?: string };
  if (health.service !== "sciencediscovery-api" || health.status !== "ok" || health.runner?.status === "unavailable") {
    const reason = `BLOCKED: ScienceDiscovery stack health is incomplete (service=${health.service ?? "unknown"}, status=${health.status ?? "unknown"}, runner=${health.runner?.status ?? "unknown"})`;
    console.warn(reason);
    testInfo.skip(true, reason);
  }
}
