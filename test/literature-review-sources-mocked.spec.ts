// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { expect, type Page } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { cleanupJourney, createProjectAndSession, openProjectSession, sendUserMessage, waitForRunTerminal, type JourneyFixture } from "./helpers/journeys.ts";
import { researchModel, type ResearchScriptStep } from "./helpers/research-model.ts";

/** Unwrap actual MCP/tool envelopes, never invent runtime invocation/job IDs. */
function objects(value: unknown): Array<Record<string, any>> {
  if (typeof value === "string") {
    try { return objects(JSON.parse(value)); } catch {
      // Swarm puts platform JSON inside a Python-repr {'result': '...'}
      // envelope. Decode only this known string wrapper; never evaluate it.
      const wrapped = /^\{'result': (['"])([\s\S]*)\1\}$/.exec(value);
      if (!wrapped) return [];
      const decoded = wrapped[2]!.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[\\'"nrt])/g, (_all, escape: string) => {
        if (escape.startsWith("x") || escape.startsWith("u")) return String.fromCharCode(parseInt(escape.slice(1), 16));
        return ({ n: "\n", r: "\r", t: "\t" } as Record<string, string>)[escape] ?? escape;
      });
      return objects(decoded);
    }
  }
  if (!value || typeof value !== "object") return [];
  return [value as Record<string, any>, ...Object.values(value).flatMap(objects)];
}
const find = (results: string[], field: string) => {
  const result = [...results].reverse().flatMap(objects).find(o => typeof o[field] === "string");
  if (!result) throw new Error(`Actual tool output is missing ${field}`);
  return result;
};
async function api(page: Page, path: string, data?: unknown) {
  const response = await page.request.fetch(`${apiBaseUrl()}${path}`, { headers: authorizationHeader(), ...(data === undefined ? {} : { method: "PUT", data }) });
  expect(response.ok(), path).toBe(true);
  return response.json();
}

for (const scenario of ["LR-09", "LR-10", "LR-11-html", "LR-11-broken", "LR-11-forbidden", "LR-14"]) {
/**
 * E2E-META
 * Purpose: Verify source fallback, governed PDF acquisition/extraction and contradictory source identity with actual Swarm tools.
 * Steps:
 *   1. Verify the offline source fixture, register a local model and enable fixture-backed built-in connectors.
 *   2. Run search/download/extract tools; inspect actual subsequent LLM inputs, jobs and audit records.
 * Environment: Dedicated Swarm stack using test/fixtures/literature-api.mjs; E2E_LITERATURE_FIXTURE=1.
 * Type: mocked
 * LLM: Local scripted model; IDs taken from actual tool results, not fabricated.
 * WebSearch: none
 * PaperSources: Offline arXiv/PubMed-shaped records at the external transport seam; no live requests.
 * MCP: Real catalog, governance broker and Swarm/platform bridge; external source transport is stubbed.
 * OtherExternal: Offline PDF HTTP responses; actual download manager and PaperService/PDF parser.
 * Credentials: E2E_API_TOKEN; local model token only.
 * CostSideEffects: Temporary project/model/downloads removed in finally; no paid calls.
 */
test(`${scenario} offline literature source contract`, { tag: ["@mocked","@category:e2e","@os:linux","@arch:amd64","@model:mock","@sandbox:bubblewrap","@fixture:literature"] }, async ({ page, journey }, info) => {
  expect(process.env.E2E_SWARM_TASK !== "1" || process.env.E2E_LITERATURE_FIXTURE !== "1", "BLOCKED: requires dedicated offline literature API fixture and Swarm").toBe(false);
  test.setTimeout(180_000);
  journey.scenario({ goal: scenario, preconditions: ["offline source transport", "actual PDF parser", "actual Swarm"] });
  expect((await api(page, "/e2e/literature-fixture")).fixture).toBe("offline-literature-v1");
  const steps: ResearchScriptStep[] = [];
  const tool = (name: string, args: Record<string, unknown>) => ({ tools: [{ name, arguments: args }] });
  const pdf = scenario.startsWith("LR-10") || scenario.startsWith("LR-11");
  if (pdf) {
    const identifier = `2401.0000${scenario.endsWith("html") ? "2" : scenario.endsWith("broken") ? "3" : scenario.endsWith("forbidden") ? "4" : "1"}`;
    steps.push(tool("mcp__arxiv__prepare_paper_download", { identifier }), ({ results }) => {
      const response = find(results, "invocationId");
      expect(response.artifacts).toHaveLength(1);
      return tool("artifact_download", { mcpInvocationId: response.invocationId, candidateId: response.artifacts[0].id });
    });
    steps.push(({ results }) => {
      const response = find(results, "planId");
      if (scenario.endsWith("forbidden") || scenario.endsWith("html")) {
        expect(response.status).not.toBe("completed");
        expect(response.error).toBeTruthy();
        return { text: "Full text unavailable. No full-text evidence was extracted." };
      }
      expect(response.status).toBe("completed");
      return tool("paper_extract_pdf", { artifactJobId: response.jobId });
    });
    if (scenario === "LR-10") steps.push(({ results }) => {
      const extraction = find(results, "textPath");
      expect(extraction.pageCount).toBe(1);
      expect(extraction.textPath).not.toContain("'");
      return tool("run_shell", { command: `cat '${extraction.textPath}'` });
    }, ({ results }) => {
      expect(results.at(-1)).toContain("LR_PDF_EVIDENCE");
      expect(results.at(-1)).toContain("1.25");
      return { text: "Read actual extracted synthetic evidence: risk ratio 1.25. Source arXiv 2401.00001." };
    });
    if (scenario.endsWith("broken")) steps.push(({ results }) => {
      expect(results.at(-1)).toMatch(/error|fail|invalid|cannot|broken|empty/i);
      expect(results.at(-1)).not.toContain("LR_PDF_EVIDENCE");
      return { text: "PDF extraction failed. No full-text evidence was obtained." };
    });
  } else {
    steps.push(tool("mcp__arxiv__search", { query: scenario === "LR-09" ? "LR_FAIL" : "LR_CONFLICT" }),
      ({ results }) => {
        if (scenario === "LR-09") expect(results.at(-1)).toMatch(/LR_RATE_LIMIT|error|fail/i);
        else expect(results.at(-1)).toContain("LR_SOURCE_A");
        return tool("mcp__pubmed__search", { query: scenario === "LR-09" ? "LR_EMPTY" : "LR_CONFLICT" });
      });
    if (scenario === "LR-09") steps.push(({ results }) => {
      expect(find(results, "invocationId").records).toHaveLength(0);
      return tool("mcp__pubmed__search", { query: "LR_RECOVERED" });
    });
    steps.push(({ results }) => {
      expect(results.at(-1)).toContain("LR_SOURCE_B");
      if (scenario === "LR-14") {
        const records = results.flatMap(objects).filter(o => o.identifier && o.primaryCitation);
        expect(records.some(r => r.source === "arxiv" && r.structuredData?.effect === 1.25)).toBe(true);
        expect(records.some(r => r.source === "pubmed" && r.structuredData?.effect === 0.8)).toBe(true);
        for (const record of records) expect(record.primaryCitation.source).toBe(record.source);
      }
      return { text: scenario === "LR-09" ? "Alternative source returned synthetic evidence; failed source was not evidence." : "The same DOI has conflicting source estimates, 1.25 and 0.8. Preserve both citations; do not treat them as independent studies." };
    });
  }
  const stub = await researchModel({ main: steps });
  let fixture: JourneyFixture | undefined;
  try {
    fixture = await createProjectAndSession(page, { approvalMode: "always_allow", model: {
      apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: scenario },
      projectName: `${scenario} offline sources ${Date.now()}`, sessionTitle: scenario });
    const settingsPath = `/api/sessions/${fixture.session.id}/settings`;
    const settings = await api(page, settingsPath);
    // PUT replaces overrides: preserve the local model and approval mode.
    // Dropping modelId would inherit a previous case's already-closed stub.
    await api(page, settingsPath, { ...settings.overrides, modelId: fixture.model!.id, enabledConnectorIds: ["arxiv", "pubmed"] });
    await openProjectSession(page, fixture);
    const run = await sendUserMessage(page, fixture.session.id, `Execute offline source fixture ${scenario}. Do not use real external services.`);
    const terminal = await waitForRunTerminal(page, fixture.session.id, run.id, 120_000);
    expect(terminal.status, terminal.error).toBe("completed");
    expect(stub.errors).toEqual([]);
    const invocations = await api(page, `/api/sessions/${fixture.session.id}/mcp/invocations`);
    expect(invocations.length).toBeGreaterThan(0);
    await info.attach("source-audit", { body: JSON.stringify(invocations), contentType: "application/json" });
    if (pdf) {
      const jobs = await api(page, `/api/sessions/${fixture.session.id}/mcp/artifact-jobs`);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].state).toBe(scenario.endsWith("forbidden") || scenario.endsWith("html") ? "failed" : "completed");
      await info.attach("download-jobs", { body: JSON.stringify(jobs), contentType: "application/json" });
    }
    await expect(page.locator(".message.assistant").last()).not.toBeEmpty();
  } finally {
    await info.attach("model-contexts", { body: JSON.stringify(stub.calls), contentType: "application/json" });
    await info.attach("fixture-errors", { body: JSON.stringify(stub.errors), contentType: "application/json" });
    try { if (fixture) await cleanupJourney(page, fixture); } finally { await stub.stop(); }
  }
});
}
