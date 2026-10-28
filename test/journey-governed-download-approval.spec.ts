// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { expect, type Page } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { cleanupJourney, createProjectAndSession, openProjectSession, scriptedModel, sendUserMessage, waitForRunTerminal } from "./helpers/journeys.ts";

/** One permission request, as the Session's request list reports it. */
interface PermissionSnapshot {
  action: string;
  decision?: string;
  grantId?: string;
  id: string;
  resource: string;
  sessionId?: string;
  state: string;
  summary: string;
}

/** One standing permission, as the grant list reports it. */
interface GrantSnapshot {
  action: string;
  id: string;
  resource: string;
  scope: string;
  sessionId?: string;
  state: string;
}

/** One recorded authorization, naming what let an action through. */
interface AuthorizationSnapshot {
  action: string;
  outcome: string;
  resource: string;
  sessionId: string;
  source: string;
}

/** One governed download job. */
interface DownloadJobSnapshot {
  actualChecksum?: string;
  finalPath?: string;
  planId: string;
  state: string;
}

/** Read one JSON resource of the isolated stack the journey runs against. */
async function readJson<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`${apiBaseUrl()}${path}`, { headers: authorizationHeader() });
  expect(response.ok(), path).toBeTruthy();
  return response.json() as Promise<T>;
}

/** The download permission requests of one Session; a connector's own request is not a download. */
async function downloadApprovals(page: Page, sessionId: string): Promise<PermissionSnapshot[]> {
  const requests = await readJson<PermissionSnapshot[]>(page, `/api/permission-requests?sessionId=${sessionId}`);
  return requests.filter((request) => request.action === "artifact_download");
}

/** The candidate row of one file inside a governed-download card. */
function candidateRow(page: Page, logicalName: string) {
  return page.locator("article.governed-download-item.candidate").filter({ hasText: logicalName });
}

/** The row of a download that is waiting for the user's decision. */
function approvalRow(page: Page, logicalName: string) {
  return page.locator("article.governed-download-item.awaiting-approval").filter({ hasText: logicalName });
}

/** The row that reports how a decided download ended. */
function decidedRow(page: Page, logicalName: string) {
  return page.locator("article.governed-download-item.approval-granted, article.governed-download-item.approval-denied")
    .filter({ hasText: logicalName });
}

/**
 * A download that was decided stops counting as work in progress, so its card
 * folds itself and the file it names leaves the page; open the cards the way a
 * researcher checking the outcome would.
 */
async function openDownloadCards(page: Page): Promise<void> {
  const cards = page.locator("article.governed-downloads-card");
  const count = await cards.count();
  for (let index = 0; index < count; index += 1) {
    const heading = cards.nth(index).getByRole("button", { name: /Governed downloads/ });
    await expect(heading).toBeVisible();
    if (await heading.getAttribute("aria-expanded") === "false") await heading.click();
    await expect(heading).toHaveAttribute("aria-expanded", "true");
  }
}

/** Let the offline arXiv source resolve its candidate for one Session. */
async function enableArxivConnector(page: Page, sessionId: string, modelId: string): Promise<void> {
  const path = `/api/sessions/${sessionId}/settings`;
  const settings = await readJson<{ overrides?: Record<string, unknown> }>(page, path);
  const saved = await page.request.put(`${apiBaseUrl()}${path}`, {
    data: { ...settings.overrides, enabledConnectorIds: ["arxiv"], modelId },
    headers: authorizationHeader(),
  });
  expect(saved.ok()).toBeTruthy();
}

/** Switch a Session between consent-required and always-allowed. */
async function setApprovalMode(page: Page, sessionId: string, mode: "always_allow" | "ask_for_dangerous"): Promise<void> {
  const switched = await page.request.patch(`${apiBaseUrl()}/api/sessions/${sessionId}`, {
    data: { approvalMode: mode },
    headers: authorizationHeader(),
  });
  expect(switched.ok()).toBeTruthy();
}

/** Run one scripted turn and wait for the candidate it leaves behind. */
async function resolveCandidate(
  page: Page,
  sessionId: string,
  stub: { calls: Array<{ offeredTools?: string[] }> },
  prompt: string,
): Promise<void> {
  const before = stub.calls.length;
  const run = await sendUserMessage(page, sessionId, prompt);
  await expect.poll(() => stub.calls.length, { message: "the run should reach the scripted model", timeout: 60_000 })
    .toBeGreaterThan(before);
  expect(stub.calls.some((call) => (call.offeredTools ?? []).includes("mcp__arxiv__prepare_paper_download")),
    "the arXiv download tool must be offered to the run").toBeTruthy();
  const terminal = await waitForRunTerminal(page, sessionId, run.id, 120_000);
  expect(terminal.status, terminal.error).toBe("completed");
}

/** Click the card's Prepare button for one candidate. */
async function prepareCandidate(page: Page, logicalName: string): Promise<void> {
  const row = candidateRow(page, logicalName);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Prepare download", exact: true }).click();
}

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

/**
 * E2E-META
 * Purpose: A researcher who does not want a download refuses it on the card and sees the refusal end the waiting.
 * Steps:
 *   1. Resolve an arXiv artifact candidate and require consent in the Session.
 *   2. Prepare the download and choose Deny on the pending card.
 *   3. Inspect the Session's download state, the card's outcome and the untouched workspace.
 * Environment: Isolated local stack; offline governed download fixture (E2E_GOVERNED_DOWNLOAD_FIXTURE=1).
 * Type: mocked
 * LLM: Local scripted model, no live model.
 * WebSearch: none
 * PaperSources: none
 * MCP: Offline arXiv source transport from test/fixtures/governed-download-source.mjs.
 * OtherExternal: None; the refused download never reaches the connector's fetch.
 * Credentials: E2E_API_TOKEN for the isolated stack only.
 * CostSideEffects: Temporary project/model/workspace file removed in finally; no paid calls.
 */
test("researcher can deny a manual MCP download from its card", { tag: ["@mocked", "@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@fixture:governed"] }, async ({ page, journey }) => {
  test.setTimeout(240_000);
  await page.addInitScript(() => localStorage.setItem("sciencediscovery-locale", "en-US"));
  const stub = await scriptedModel([
    { arguments: { identifier: "2401.00001" }, tool: "mcp__arxiv__prepare_paper_download" },
    { text: "The candidate is ready; downloading it still needs your approval." },
  ]);
  const fixture = await createProjectAndSession(page, {
    approvalMode: "always_allow",
    model: { apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: `Governed deny ${Date.now()}` },
    projectName: `Governed deny ${Date.now()}`,
    sessionTitle: "Denied MCP download",
  });
  const sessionId = fixture.session.id;
  try {
    journey.scenario({
      goal: "Refuse a download the researcher started by hand and see the waiting end without a file.",
      preconditions: ["Isolated stack", "Offline arXiv candidate", "Consent-required approval mode"],
    });

    await journey.step("Resolve an artifact candidate", "The finished turn leaves an unprepared candidate on a governed download card and no permission.", async () => {
      await openProjectSession(page, fixture);
      await enableArxivConnector(page, sessionId, fixture.model!.id);
      await resolveCandidate(page, sessionId, stub, "Prepare the arXiv PDF 2401.00001 for download.");
      await expect(candidateRow(page, "2401.00001.pdf")).toBeVisible();
      expect(await downloadApprovals(page, sessionId)).toHaveLength(0);
    });

    await journey.step("Require consent and request the download", "The click creates the permission and offers the three existing decisions beside the file and destination.", async () => {
      await setApprovalMode(page, sessionId, "ask_for_dangerous");
      await page.reload();
      await expect(page.getByRole("heading", { exact: true, name: fixture.session.title })).toBeVisible();
      await prepareCandidate(page, "2401.00001.pdf");
      const pending = approvalRow(page, "2401.00001.pdf");
      await expect(pending).toBeVisible();
      await expect(pending).toContainText("You must approve this download");
      await expect(pending.getByRole("button", { name: "Deny", exact: true })).toBeVisible();
      const requests = await downloadApprovals(page, sessionId);
      expect(requests).toHaveLength(1);
      expect(requests[0].state).toBe("pending");
    });

    await journey.step("Deny the download", "The refusal ends the waiting: the request is denied, no download job starts and nothing reaches the workspace.", async () => {
      await approvalRow(page, "2401.00001.pdf").getByRole("button", { name: "Deny", exact: true }).click();
      await expect.poll(async () => (await downloadApprovals(page, sessionId))[0]?.state, { timeout: 30_000 }).toBe("denied");
      const requests = await downloadApprovals(page, sessionId);
      expect(requests).toHaveLength(1);
      expect(requests[0].decision).toBe("denied");
      // A refusal starts no download: no job, no plan in flight, no file.
      expect(await readJson<DownloadJobSnapshot[]>(page, `/api/sessions/${sessionId}/mcp/artifact-jobs`)).toHaveLength(0);
      const files = await readJson<Array<{ path: string }>>(page, `/api/sessions/${sessionId}/files`);
      expect(files.filter((file) => file.path.includes("2401.00001.pdf"))).toHaveLength(0);
      // The card reports the outcome instead of waiting for an approval that already happened.
      await openDownloadCards(page);
      await expect(approvalRow(page, "2401.00001.pdf")).toHaveCount(0);
      await expect(decidedRow(page, "2401.00001.pdf")).toContainText("Denied — nothing was downloaded");
      await expect(decidedRow(page, "2401.00001.pdf").getByRole("button", { name: "Deny", exact: true })).toHaveCount(0);
    });

    await journey.step("The refusal survives a reload", "A reload keeps the denied outcome and asks for nothing a second time.", async () => {
      await page.reload();
      await expect(page.getByRole("heading", { exact: true, name: fixture.session.title })).toBeVisible();
      const requests = await downloadApprovals(page, sessionId);
      expect(requests).toHaveLength(1);
      expect(requests[0].state).toBe("denied");
      expect(await readJson<DownloadJobSnapshot[]>(page, `/api/sessions/${sessionId}/mcp/artifact-jobs`)).toHaveLength(0);
      await openDownloadCards(page);
      await expect(decidedRow(page, "2401.00001.pdf")).toContainText("Denied — nothing was downloaded");
    });
  } finally { await cleanupJourney(page, fixture); await stub.stop(); }
});

/**
 * E2E-META
 * Purpose: A researcher who allows one download for its type is not asked again for the next download of that type.
 * Steps:
 *   1. Resolve two candidates of the same source and require consent in the Session.
 *   2. Prepare the first download and allow the same type on its pending card.
 *   3. Prepare the second, matching download and inspect that it advances under the standing grant.
 * Environment: Isolated local stack; offline governed download fixture (E2E_GOVERNED_DOWNLOAD_FIXTURE=1).
 * Type: mocked
 * LLM: Local scripted model, no live model.
 * WebSearch: none
 * PaperSources: none
 * MCP: Offline arXiv source transport from test/fixtures/governed-download-source.mjs.
 * OtherExternal: The governed downloads' own bytes are served by the fixture's connectorFetch; no live request.
 * Credentials: E2E_API_TOKEN for the isolated stack only.
 * CostSideEffects: Temporary project/model/workspace file removed in finally; no paid calls.
 */
test("a matching download grant spares the researcher a second approval", { tag: ["@mocked", "@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@fixture:governed"] }, async ({ page, journey }) => {
  test.setTimeout(300_000);
  await page.addInitScript(() => localStorage.setItem("sciencediscovery-locale", "en-US"));
  // One turn resolves a candidate of each paper, so both downloads belong to
  // the same Session and therefore to the same grant.
  const stub = await scriptedModel([
    { arguments: { identifier: "2401.00001" }, tool: "mcp__arxiv__prepare_paper_download" },
    { arguments: { identifier: "2401.00002" }, tool: "mcp__arxiv__prepare_paper_download" },
    { text: "Both candidates are ready; downloading them still needs your approval." },
  ]);
  const fixture = await createProjectAndSession(page, {
    approvalMode: "always_allow",
    model: { apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: `Governed grant ${Date.now()}` },
    projectName: `Governed grant ${Date.now()}`,
    sessionTitle: "Matching MCP download grant",
  });
  const sessionId = fixture.session.id;
  try {
    journey.scenario({
      goal: "Allow one download for its type and see the next download of that type start without another question.",
      preconditions: ["Isolated stack", "Two offline arXiv candidates", "Consent-required approval mode"],
    });

    await journey.step("Resolve two candidates of the same source", "The finished turn leaves two unprepared candidates of one source on the governed download card.", async () => {
      await openProjectSession(page, fixture);
      await enableArxivConnector(page, sessionId, fixture.model!.id);
      await resolveCandidate(page, sessionId, stub, "Prepare the arXiv PDFs 2401.00001 and 2401.00002 for download.");
      await expect(candidateRow(page, "2401.00001.pdf")).toBeVisible();
      await expect(candidateRow(page, "2401.00002.pdf")).toBeVisible();
      expect(await readJson<unknown[]>(page, `/api/sessions/${sessionId}/mcp/artifact-candidates`)).toHaveLength(2);
      expect(await downloadApprovals(page, sessionId)).toHaveLength(0);
    });

    await journey.step("Allow the first download for its type", "Allowing the same type records a standing grant for this Session and starts the download.", async () => {
      await setApprovalMode(page, sessionId, "ask_for_dangerous");
      await page.reload();
      await expect(page.getByRole("heading", { exact: true, name: fixture.session.title })).toBeVisible();
      await prepareCandidate(page, "2401.00001.pdf");
      const pending = approvalRow(page, "2401.00001.pdf");
      await expect(pending).toBeVisible();
      await pending.getByRole("button", { name: "Allow same type", exact: true }).click();
      await expect.poll(async () => (await downloadApprovals(page, sessionId))[0]?.state, { timeout: 30_000 }).toBe("allowed");
      const grants = await readJson<GrantSnapshot[]>(page, "/api/permission-grants");
      const grant = grants.find((item) => item.action === "artifact_download" && item.sessionId === sessionId);
      expect(grant?.resource, "the grant must cover the source, not one file").toBe("artifact:arxiv");
      expect(grant?.scope).toBe("session");
      expect(grant?.state).toBe("active");
      await expect.poll(async () => (await readJson<DownloadJobSnapshot[]>(page, `/api/sessions/${sessionId}/mcp/artifact-jobs`))
        .filter((job) => job.state === "completed").length, { timeout: 60_000 }).toBe(1);
    });

    await journey.step("A matching download needs no second approval", "Preparing the other paper of the same source starts its download under the standing grant, without asking again.", async () => {
      await prepareCandidate(page, "2401.00002.pdf");
      // No second question: the download permission list still holds one request.
      await expect.poll(async () => (await readJson<DownloadJobSnapshot[]>(page, `/api/sessions/${sessionId}/mcp/artifact-jobs`))
        .filter((job) => job.state === "completed").length, { timeout: 60_000 }).toBe(2);
      const requests = await downloadApprovals(page, sessionId);
      expect(requests).toHaveLength(1);
      expect(requests[0].state).toBe("allowed");
      await expect(approvalRow(page, "2401.00002.pdf")).toHaveCount(0);
      await expect(page.locator("article.governed-downloads-card").getByRole("button", { name: "Allow once", exact: true })).toHaveCount(0);
      await expect(page.locator("article.permission-card").filter({ hasText: "Download 2401.00002.pdf" })).toHaveCount(0);
      const jobs = await readJson<DownloadJobSnapshot[]>(page, `/api/sessions/${sessionId}/mcp/artifact-jobs`);
      expect(jobs.filter((job) => job.state === "completed").map((job) => job.finalPath).sort())
        .toEqual(["downloads/2401.00001.pdf", "downloads/2401.00002.pdf"]);
      // The grant, not the Session policy, is what let the second download through.
      const authorizations = await readJson<AuthorizationSnapshot[]>(page, `/api/sessions/${sessionId}/permission-authorizations`);
      expect(authorizations.find((entry) => entry.resource.includes("pdf-2401.00001"))?.source).toBe("user_grant");
      expect(authorizations.find((entry) => entry.resource.includes("pdf-2401.00002"))?.source).toBe("existing_grant");
    });
  } finally { await cleanupJourney(page, fixture); await stub.stop(); }
});

/**
 * E2E-META
 * Purpose: A researcher who reloads the page while a download waits for approval still finds the decision waiting for them.
 * Steps:
 *   1. Resolve an arXiv artifact candidate, require consent and prepare the download.
 *   2. Reload the Session and inspect the restored pending state and its decisions.
 *   3. Allow the restored request and follow the download to a completed artifact.
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
test("a pending download approval survives a reload of the Session", { tag: ["@mocked", "@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@fixture:governed"] }, async ({ page, journey }) => {
  test.setTimeout(240_000);
  await page.addInitScript(() => localStorage.setItem("sciencediscovery-locale", "en-US"));
  const stub = await scriptedModel([
    { arguments: { identifier: "2401.00001" }, tool: "mcp__arxiv__prepare_paper_download" },
    { text: "The candidate is ready; downloading it still needs your approval." },
  ]);
  const fixture = await createProjectAndSession(page, {
    approvalMode: "always_allow",
    model: { apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: `Governed reload ${Date.now()}` },
    projectName: `Governed reload ${Date.now()}`,
    sessionTitle: "Reloaded MCP download",
  });
  const sessionId = fixture.session.id;
  try {
    journey.scenario({
      goal: "Reload the page while a download waits and still find the one waiting approval, with its decisions.",
      preconditions: ["Isolated stack", "Offline arXiv candidate", "Consent-required approval mode"],
    });

    await journey.step("Request a download that waits", "The click leaves one download permission waiting for the researcher.", async () => {
      await openProjectSession(page, fixture);
      await enableArxivConnector(page, sessionId, fixture.model!.id);
      await resolveCandidate(page, sessionId, stub, "Prepare the arXiv PDF 2401.00001 for download.");
      await setApprovalMode(page, sessionId, "ask_for_dangerous");
      await page.reload();
      await expect(page.getByRole("heading", { exact: true, name: fixture.session.title })).toBeVisible();
      await prepareCandidate(page, "2401.00001.pdf");
      await expect(approvalRow(page, "2401.00001.pdf")).toBeVisible();
      expect(await downloadApprovals(page, sessionId)).toHaveLength(1);
    });

    await journey.step("Reload while the decision is pending", "The reload restores the one waiting request without a duplicate, and its decisions stay discoverable.", async () => {
      await page.reload();
      await expect(page.getByRole("heading", { exact: true, name: fixture.session.title })).toBeVisible();
      const requests = await downloadApprovals(page, sessionId);
      expect(requests, "a reload must not raise a second request").toHaveLength(1);
      expect(requests[0].state).toBe("pending");
      // An actionable card opens itself, so the decision waits where the
      // researcher comes back to it.
      const heading = page.locator("article.governed-downloads-card").first().getByRole("button", { name: /Governed downloads/ });
      await expect(heading).toHaveAttribute("aria-expanded", "true");
      await openDownloadCards(page);
      const pending = approvalRow(page, "2401.00001.pdf");
      await expect(pending).toBeVisible();
      await expect(pending.getByRole("button", { name: "Allow once", exact: true })).toBeVisible();
      await expect(pending.getByRole("button", { name: "Allow same type", exact: true })).toBeVisible();
      await expect(pending.getByRole("button", { name: "Deny", exact: true })).toBeVisible();
      // The generic approvals panel still does not duplicate the download's decision.
      await expect(page.locator("article.permission-card").filter({ hasText: "Download 2401.00001.pdf" })).toHaveCount(0);
    });

    await journey.step("Decide the restored request", "The restored request still works: allowing it completes the download.", async () => {
      await approvalRow(page, "2401.00001.pdf").getByRole("button", { name: "Allow once", exact: true }).click();
      await expect.poll(async () => (await downloadApprovals(page, sessionId))[0]?.state, { timeout: 30_000 }).toBe("allowed");
      await expect.poll(async () => (await readJson<DownloadJobSnapshot[]>(page, `/api/sessions/${sessionId}/mcp/artifact-jobs`))[0]?.state, { timeout: 60_000 })
        .toBe("completed");
      expect((await readJson<DownloadJobSnapshot[]>(page, `/api/sessions/${sessionId}/mcp/artifact-jobs`))[0].finalPath)
        .toBe("downloads/2401.00001.pdf");
      expect(await downloadApprovals(page, sessionId)).toHaveLength(1);
    });
  } finally { await cleanupJourney(page, fixture); await stub.stop(); }
});

/**
 * E2E-META
 * Purpose: A researcher who allows one download for its type does not hand that permission to the next Session.
 * Steps:
 *   1. Resolve an arXiv artifact candidate in a Session and allow the same type on its pending card.
 *   2. Open a second Session of the same Project and resolve a candidate there.
 *   3. Prepare that Session's download and inspect that it asks again instead of inheriting the grant.
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
test("a second Session inherits neither the pending approval nor the matching grant", { tag: ["@mocked", "@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@fixture:governed"] }, async ({ page, journey }) => {
  test.setTimeout(300_000);
  await page.addInitScript(() => localStorage.setItem("sciencediscovery-locale", "en-US"));
  const stub = await scriptedModel([
    [
      { arguments: { identifier: "2401.00001" }, tool: "mcp__arxiv__prepare_paper_download" },
      { text: "The candidate is ready; downloading it still needs your approval." },
    ],
    [
      { arguments: { identifier: "2401.00001" }, tool: "mcp__arxiv__prepare_paper_download" },
      { text: "The second Session has its own candidate." },
    ],
  ]);
  const fixture = await createProjectAndSession(page, {
    approvalMode: "always_allow",
    model: { apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: `Governed sessions ${Date.now()}` },
    projectName: `Governed sessions ${Date.now()}`,
    sessionTitle: "First MCP download Session",
  });
  const sessionId = fixture.session.id;
  let secondSessionId = "";
  try {
    journey.scenario({
      goal: "Keep a Session's download permission inside that Session.",
      preconditions: ["Isolated stack", "Two Sessions of one Project", "Offline arXiv candidate"],
    });

    await journey.step("Allow the same type in the first Session", "The first Session records a standing grant of its own and downloads the paper.", async () => {
      await openProjectSession(page, fixture);
      await enableArxivConnector(page, sessionId, fixture.model!.id);
      await resolveCandidate(page, sessionId, stub, "Prepare the arXiv PDF 2401.00001 for download.");
      await setApprovalMode(page, sessionId, "ask_for_dangerous");
      await page.reload();
      await expect(page.getByRole("heading", { exact: true, name: fixture.session.title })).toBeVisible();
      await prepareCandidate(page, "2401.00001.pdf");
      await expect(approvalRow(page, "2401.00001.pdf")).toBeVisible();
      await approvalRow(page, "2401.00001.pdf").getByRole("button", { name: "Allow same type", exact: true }).click();
      await expect.poll(async () => (await downloadApprovals(page, sessionId))[0]?.state, { timeout: 30_000 }).toBe("allowed");
      await expect.poll(async () => (await readJson<DownloadJobSnapshot[]>(page, `/api/sessions/${sessionId}/mcp/artifact-jobs`))[0]?.state, { timeout: 60_000 })
        .toBe("completed");
      const grants = await readJson<GrantSnapshot[]>(page, "/api/permission-grants");
      const grant = grants.find((item) => item.action === "artifact_download");
      expect(grant?.sessionId, "a grant belongs to the Session that made it").toBe(sessionId);
    });

    await journey.step("Open a second Session of the same Project", "The second Session starts without the first Session's grant and resolves its own candidate.", async () => {
      const created = await page.request.post(`${apiBaseUrl()}/api/projects/${fixture.project.id}/sessions`, {
        data: { approvalMode: "always_allow", modelId: fixture.model!.id, title: "Second MCP download Session" },
        headers: authorizationHeader(),
      });
      expect(created.ok()).toBeTruthy();
      const second = await created.json() as { id: string; title: string };
      secondSessionId = second.id;
      await openProjectSession(page, { project: fixture.project, session: second });
      await enableArxivConnector(page, second.id, fixture.model!.id);
      expect(await downloadApprovals(page, second.id)).toHaveLength(0);
      await resolveCandidate(page, second.id, stub, "Prepare the arXiv PDF 2401.00001 for download in this Session.");
      await expect(candidateRow(page, "2401.00001.pdf")).toBeVisible();
      // The first Session keeps its own history; the second one starts empty.
      expect(await downloadApprovals(page, sessionId)).toHaveLength(1);
      expect(await downloadApprovals(page, second.id)).toHaveLength(0);
    });

    await journey.step("Prepare in the second Session", "The matching download asks again: the first Session's grant did not travel with it.", async () => {
      await setApprovalMode(page, secondSessionId, "ask_for_dangerous");
      await page.reload();
      await expect(page.getByRole("heading", { exact: true, name: "Second MCP download Session" })).toBeVisible();
      await prepareCandidate(page, "2401.00001.pdf");
      const pending = approvalRow(page, "2401.00001.pdf");
      await expect(pending, "the second Session must ask for its own download").toBeVisible();
      await expect(pending.getByRole("button", { name: "Deny", exact: true })).toBeVisible();
      const requests = await downloadApprovals(page, secondSessionId);
      expect(requests).toHaveLength(1);
      expect(requests[0].state).toBe("pending");
      // The first Session's decision is untouched by the second Session's.
      const first = await downloadApprovals(page, sessionId);
      expect(first).toHaveLength(1);
      expect(first[0].state).toBe("allowed");
    });
  } finally { await cleanupJourney(page, fixture); await stub.stop(); }
});
