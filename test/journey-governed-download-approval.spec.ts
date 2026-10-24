// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { expect } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { cleanupJourney, createProjectAndSession, openProjectSession, scriptedModel, sendUserMessage, waitForRunTerminal } from "./helpers/journeys.ts";

/**
 * E2E-META
 * Purpose: A researcher authorizes a manually requested MCP artifact download from the download card itself.
 * Steps:
 *   1. Resolve an arXiv artifact candidate through the real connector and leave it unprepared.
 *   2. Require consent, click Prepare download after the Agent turn finished, and inspect the approval.
 *   3. Allow it from the card; inspect the completed artifact and the Session permission state.
 * Environment: Isolated local stack; offline governed download fixture (E2E_GOVERNED_DOWNLOAD_FIXTURE=1).
 * Type: mocked
 * LLM: Local scripted model, no live model.
 * WebSearch: none
 * PaperSources: none
 * MCP: Offline arXiv source transport from test/fixtures/governed-download-source.mjs.
 * OtherExternal: The governed download's own bytes are served by the fixture's connectorFetch; no live request.
 * Credentials: E2E_API_TOKEN for the isolated stack only.
 * CostSideEffects: Temporary project/model/workspace file removed in finally; no paid calls.
 */
test("researcher can allow a manual MCP download from its card", { tag: ["@mocked", "@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@fixture:governed"] }, async ({ page, journey }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => localStorage.setItem("sciencediscovery-locale", "en-US"));
  const stub = await scriptedModel([
    { arguments: { identifier: "2401.00001" }, tool: "mcp__arxiv__prepare_paper_download" },
    { text: "The candidate is ready; downloading it still needs your approval." },
  ]);
  // The connector call itself runs under "always allow" so the journey reaches
  // an unprepared candidate; consent is switched on afterwards, so the click
  // under test is the one that has to ask.
  const fixture = await createProjectAndSession(page, {
    approvalMode: "always_allow",
    model: { apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: `Governed download ${Date.now()}` },
    projectName: `Governed download ${Date.now()}`,
    sessionTitle: "Manual MCP download",
  });
  const get = async (path: string) => {
    const response = await page.request.get(`${apiBaseUrl()}${path}`, { headers: authorizationHeader() });
    expect(response.ok(), path).toBeTruthy();
    return response.json();
  };
  try {
    journey.scenario({
      goal: "Authorize a download the researcher started by hand, from the card that shows it waiting.",
      preconditions: ["Isolated stack", "Offline arXiv candidate", "Consent-required approval mode"],
    });

    const card = page.locator("article.governed-downloads-card").first();
    const pendingItem = card.locator("article.governed-download-item.awaiting-approval").first();
    const prepare = card.getByRole("button", { name: "Prepare download", exact: true });
    // A resolved download stops counting as work in progress, so the card folds
    // itself; open it the way a researcher checking the result would.
    const openCard = async () => {
      const heading = card.getByRole("button", { name: /Governed downloads/ });
      if (await heading.getAttribute("aria-expanded") === "false") await heading.click();
      await expect(heading).toHaveAttribute("aria-expanded", "true");
    };
    const settingsPath = `/api/sessions/${fixture.session.id}/settings`;
    const approvals = async () => (await get(`/api/permission-requests?sessionId=${fixture.session.id}`))
      .filter((request: { action: string }) => request.action === "artifact_download");

    await journey.step("Resolve an artifact candidate", "The finished turn leaves an unprepared candidate on a governed download card and no permission.", async () => {
      await openProjectSession(page, fixture);
      const settings = await get(settingsPath);
      const saved = await page.request.put(`${apiBaseUrl()}${settingsPath}`, { data: { ...settings.overrides, enabledConnectorIds: ["arxiv"], modelId: fixture.model!.id }, headers: authorizationHeader() });
      expect(saved.ok()).toBeTruthy();
      const run = await sendUserMessage(page, fixture.session.id, "Prepare the arXiv PDF 2401.00001 for download.");
      await expect.poll(() => stub.calls.length, { message: "the run should reach the scripted model", timeout: 60_000 }).toBeGreaterThan(0);
      expect(stub.calls[0]?.offeredTools ?? [], "the arXiv download tool must be offered to the run").toContain("mcp__arxiv__prepare_paper_download");
      const terminal = await waitForRunTerminal(page, fixture.session.id, run.id, 120_000);
      expect(terminal.status, terminal.error).toBe("completed");
      // An actionable card opens itself; the candidate's Prepare button is the
      // entry point the user is here for.
      await expect(prepare).toBeVisible();
      expect(await get(`/api/sessions/${fixture.session.id}/mcp/artifact-candidates`)).toHaveLength(1);
      expect(await approvals()).toHaveLength(0);
    });

    await journey.step("Require consent and request the download", "The click creates the permission and shows the current user's approval action beside the file and destination, without a page refresh.", async () => {
      const switched = await page.request.patch(`${apiBaseUrl()}/api/sessions/${fixture.session.id}`, { data: { approvalMode: "ask_for_dangerous" }, headers: authorizationHeader() });
      expect(switched.ok()).toBeTruthy();
      await page.reload();
      await expect(page.getByRole("heading", { exact: true, name: fixture.session.title })).toBeVisible();
      await prepare.click();
      await expect(pendingItem).toBeVisible();
      await expect(pendingItem).toContainText("2401.00001.pdf");
      await expect(pendingItem).toContainText("downloads/2401.00001.pdf");
      await expect(pendingItem).toContainText("You must approve this download");
      await expect(pendingItem.getByRole("button", { name: "Allow once", exact: true })).toBeVisible();
      await expect(pendingItem).not.toContainText("Waiting for approval");
      // The permission exists for this Session only, and is offered once.
      const requests = await approvals();
      expect(requests).toHaveLength(1);
      expect(requests[0].state).toBe("pending");
      // The same request is not also offered as a separate approval card.
      await expect(page.locator("article.permission-card").filter({ hasText: "Download 2401.00001.pdf" })).toHaveCount(0);
    });

    await journey.step("Allow once", "The decision advances the plan to a real download whose completed artifact is verifiable, with no further manual refresh.", async () => {
      await pendingItem.getByRole("button", { name: "Allow once", exact: true }).click();
      await expect.poll(async () => (await approvals())[0]?.state, { timeout: 30_000 }).toBe("allowed");
      await expect.poll(async () => (await get(`/api/sessions/${fixture.session.id}/mcp/artifact-jobs`))[0]?.state, { timeout: 60_000 }).toBe("completed");
      const job = (await get(`/api/sessions/${fixture.session.id}/mcp/artifact-jobs`))[0];
      expect(job.finalPath).toBe("downloads/2401.00001.pdf");
      expect(job.actualChecksum).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect((await get(`/api/sessions/${fixture.session.id}/mcp/artifact-plans`))[0].state).toBe("approved");
      await openCard();
      await expect(card.locator("article.governed-download-item.completed")).toContainText("downloads/2401.00001.pdf");
      await expect(card.locator("article.governed-download-item.awaiting-approval")).toHaveCount(0);
    });

    await journey.step("Reload the Session", "The resolved state survives a reload without a second approval request.", async () => {
      await page.reload();
      await expect(page.getByRole("heading", { exact: true, name: fixture.session.title })).toBeVisible();
      await expect(card.getByRole("button", { name: /Governed downloads/ })).toBeVisible();
      const requests = await approvals();
      expect(requests).toHaveLength(1);
      expect(requests[0].state).not.toBe("pending");
      await expect(page.locator("article.permission-card").filter({ hasText: "Download 2401.00001.pdf" })).toHaveCount(0);
    });
  } finally { await cleanupJourney(page, fixture); await stub.stop(); }
});