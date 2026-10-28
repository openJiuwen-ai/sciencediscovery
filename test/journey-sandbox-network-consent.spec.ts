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

import { expect } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { cleanupJourney, createProjectAndSession, openProjectSession, scriptedModel, sendUserMessage, waitForRunTerminal } from "./helpers/journeys.ts";

for (const decision of ["Deny", "Allow once"] as const) {
/**
 * E2E-META
 * Purpose: A researcher grants or refuses exact sandbox hosts through a conversation card before retrieval.
 * Steps:
 *   1. Start a declared-host request and inspect hosts/purpose before execution.
 *   2. Deny or approve, then inspect the visible decision and unchanged global settings.
 * Environment: Isolated local API/Runner/JiuwenSwarm stack; Ask approval mode.
 * Type: mocked
 * LLM: Local scripted model, no live model.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none; consent does not execute or connect to the named domain.
 * Credentials: E2E_API_TOKEN for the isolated stack only.
 * CostSideEffects: Temporary local project/model removed in finally; no paid calls.
 */
  test(`researcher can ${decision.toLowerCase()} sandbox hosts in the conversation`, { tag: ["@mocked", "@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock"] }, async ({ page, journey }) => {
    test.setTimeout(120_000);
    await page.addInitScript(() => localStorage.setItem("sciencediscovery-locale", "en-US"));
    const stub = await scriptedModel([
      { tool: "request_sandbox_network", arguments: { hosts: ["eutils.ncbi.nlm.nih.gov:443"], purpose: "Retrieve requested PubMed records" } },
      { text: decision === "Deny" ? "PubMed retrieval remains blocked and incomplete because network access was denied." : "Host access approved. No retrieval has been executed; a new safe execution is required." },
    ]);
    const fixture = await createProjectAndSession(page, { approvalMode: "ask_for_dangerous", model: { ...stub, name: `Network consent ${Date.now()}` }, projectName: `Network consent ${Date.now()}`, sessionTitle: "PubMed consent" });
    journey.scenario({ goal: "Decide whether this research run may contact the requested host without changing global network policy.", preconditions: ["Isolated stack", "Local model declares exact hosts before execution", "No external requests"] });
    const get = async (path: string) => {
      const response = await page.request.get(`${apiBaseUrl()}${path}`, { headers: authorizationHeader() });
      expect(response.ok()).toBeTruthy(); return response.json();
    };
    let runId = "";
    const before = await get("/api/sandbox-network-settings");
    try {
      await journey.step("Request PubMed retrieval", "The conversation pauses on a card naming the host and purpose before any command runs.", async () => {
        await openProjectSession(page, fixture);
        const prompt = "Ask me for permission to retrieve PubMed records before executing anything.";
        // The composer warning is an earlier, offline preflight. Acknowledge
        // it so this journey can exercise the distinct run-level consent card.
        await page.locator("form.composer").getByRole("textbox").fill(prompt);
        const preflight = page.locator("form.composer .composer-network-preflight");
        await expect(preflight).toContainText("Research network access is disabled");
        await preflight.getByRole("button", { name: "Continue without network" }).click();
        runId = (await sendUserMessage(page, fixture.session.id, prompt)).id;
        const card = page.locator("article.permission-card").filter({ hasText: "eutils.ncbi.nlm.nih.gov:443" }).first();
        await expect(card).toBeVisible(); await expect(card).toContainText("Retrieve requested PubMed records");
        await expect(card.getByRole("button", { name: "Allow these hosts for this run", exact: true })).toBeVisible();
        expect(await card.getByRole("button", { name: "Allow same type", exact: true }).count()).toBe(0);
        expect((await get(`/api/sessions/${fixture.session.id}/agent-activity`)).executions).toHaveLength(0);
      });
      await journey.step(`Choose ${decision}`, "The decision returns without executing or silently substituting another source.", async () => {
        const card = page.locator("article.permission-card").filter({ hasText: "eutils.ncbi.nlm.nih.gov:443" }).first();
        await card.getByRole("button", { name: decision, exact: true }).click();
        expect((await waitForRunTerminal(page, fixture.session.id, runId)).status).toBe("completed");
        await expect(page.getByText(decision === "Deny" ? "PubMed retrieval remains blocked and incomplete because network access was denied." : "Host access approved. No retrieval has been executed; a new safe execution is required.", { exact: true })).toBeVisible();
        expect((await get(`/api/sessions/${fixture.session.id}/agent-activity`)).executions).toHaveLength(0);
        expect(await get("/api/sandbox-network-settings")).toEqual(before);
        const requests = await get(`/api/permission-requests?sessionId=${fixture.session.id}`);
        expect(requests.filter((x: { action: string }) => x.action === "sandbox_network")).toHaveLength(1);
        expect(requests.find((x: { action: string }) => x.action === "sandbox_network").state).toBe(decision === "Deny" ? "denied" : "allowed");
      });
    } finally { await cleanupJourney(page, fixture); await stub.stop(); }
  });
}
