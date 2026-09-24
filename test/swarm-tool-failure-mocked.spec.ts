// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { blockNonLocalRequests, test } from "./helpers/e2e.ts";
import { apiBaseUrl, authorizationHeader, browserStorageState } from "./e2e-auth.js";
import { cleanupJourney, createProjectAndSession, openProjectSession, scriptedModel,
  sendUserMessage, waitForRunTerminal } from "./helpers/journeys.ts";

for (const fault of ["validation", "http503", "disconnect"]) {
const transportFault = fault !== "validation";
const expectedError = fault === "disconnect" ? /read|connection|transport|unknown outcome/i : fault === "http503" ? /HTTP 503/ : /Input should be a valid string/;
/**
 * E2E-META
 * Purpose: Pre-bridge validation/HTTP failures stay local and visible while real children recover and return.
 * Steps:
 *   1. Delegate and reject malformed args, inject HTTP 503 or disconnect a request.
 *   2. Recover and inspect parent/child/UI; verify an active sibling survives.
 * Environment: Isolated Swarm stack with E2E_SWARM_TASK=1; HTTP case additionally requires the local fault proxy and E2E_MCP_FAULT_PROXY=1.
 * Type: mocked
 * LLM: Local scripted OpenAI-compatible model; actual Swarm main/child loops.
 * WebSearch: none
 * PaperSources: none
 * MCP: Actual shared Swarm-to-platform bridge; no external MCP sources.
 * OtherExternal: none; local sandbox and browser only.
 * Credentials: E2E_API_TOKEN only; model uses a local fixture token.
 * CostSideEffects: No paid calls; temporary project/model removed in finally.
 */
test(`${fault === "disconnect" ? "LR-07 " : ""}Swarm ${fault} child failure is visible after recovery`, { tag: ["@mocked","@category:e2e","@os:linux","@arch:amd64","@model:mock","@sandbox:bubblewrap","@fixture:research"] }, async ({ browser, page, journey }, info) => {
  expect(process.env.E2E_SWARM_TASK !== "1", "Requires isolated Swarm stack with platform task delegation").toBe(false);
  expect(transportFault && process.env.E2E_MCP_FAULT_PROXY !== "1", "Requires isolated loopback MCP fault proxy").toBe(false);
  test.setTimeout(420_000);
  journey.scenario({ goal: "Show pre-bridge tool errors without losing the recovered child result",
    preconditions: ["Swarm stack", "platform task delegation", "local sandbox"] });
  let releaseFaultTool!: () => void;
  const faultToolGate = new Promise<void>((resolve) => { releaseFaultTool = resolve; });
  const stub = await scriptedModel([[
    { tool: "task", arguments: { description: "Probe shell validation", subagent_type: "general-purpose",
      prompt: "Run the local fixture probe and return.", max_turns: 6, timeout_seconds: 180 } },
    { text: "Parent received recovered child." },
  ]], [
    { tool: "run_shell", arguments: { command: transportFault
      ? `printf 'E2E_MCP_${fault === "disconnect" ? "DISCONNECT" : "HTTP_503"}_${Date.now()}'` : { invalid: "must be a string" } },
      ...(transportFault ? { waitFor: faultToolGate } : {}) },
    { tool: "run_shell", arguments: { command: "printf 'FIXTURE-CHILD-RECOVERED\\n'" } },
    { text: "Recovered child completed." },
  ], { captureContext: true });
  let fixture: Awaited<ReturnType<typeof createProjectAndSession>> | undefined;
  let sibling: Awaited<ReturnType<typeof createProjectAndSession>> | undefined;
  let siblingModel: Awaited<ReturnType<typeof scriptedModel>> | undefined;
  let siblingContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  let siblingPage: typeof page | undefined;
  let siblingRun: { id: string } | undefined;
  let siblingWorkspace: string | undefined;
  try {
    fixture = await createProjectAndSession(page, { approvalMode: "always_allow",
      model: { apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: `Swarm error fixture ${Date.now()}` },
      projectName: `Swarm error fixture ${Date.now()}`, sessionTitle: "Pre-bridge failure visibility" });
    await openProjectSession(page, fixture);
    if (transportFault) {
      const faultRun = await sendUserMessage(page, fixture.session.id, "Delegate the local validation/recovery probe.");
      await expect.poll(() => stub.calls.some(call => call.route === "subagent" && call.step === 0),
        { message: "Fault child must reach its gated tool call", timeout: 120_000 }).toBe(true);
      // Keep another real child in a long-running platform request while the
      // first child's HTTP request fails on their shared MCP connection.
      const dataRoot = process.env.SCIENCE_DISCOVERY_DATA_DIR;
      expect(dataRoot, "Transport injection requires this isolated stack's data directory").toBeTruthy();
      siblingModel = await scriptedModel([
        { tool: "task", arguments: { description: "Unrelated long-running child", subagent_type: "general-purpose",
          prompt: "Complete the healthy local probe.", max_turns: 4, timeout_seconds: 180 } },
        { text: "Healthy parent received child." },
      ], [
        { tool: "run_shell", arguments: { command: "printf 'started' > healthy-sibling-started.txt; for i in $(seq 1 1200); do if test -f healthy-sibling-release.txt; then printf 'finished' > healthy-sibling-finished.txt; printf 'HEALTHY-SIBLING-COMPLETED\\n'; exit 0; fi; sleep 0.1; done; exit 1", wait_ms: 30_000 } },
        { text: "Healthy sibling completed.", delayMs: 45_000 },
      ], { captureContext: true });
      sibling = await createProjectAndSession(page, { approvalMode: "always_allow",
        model: { apiToken: siblingModel.apiToken, baseUrl: siblingModel.baseUrl,
          model: siblingModel.model, name: `Healthy sibling ${Date.now()}` },
        projectName: `Healthy sibling ${Date.now()}`, sessionTitle: "Unaffected concurrent child" });
      siblingContext = await browser.newContext({ baseURL: apiBaseUrl(), storageState: browserStorageState() });
      await blockNonLocalRequests(siblingContext);
      siblingPage = await siblingContext.newPage();
      await openProjectSession(siblingPage, sibling);
      siblingRun = await sendUserMessage(siblingPage, sibling.session.id, "Delegate the healthy local probe.");
      await expect.poll(async () => {
        const response = await page.request.get(`${apiBaseUrl()}/api/sessions/${sibling!.session.id}/subagents`, { headers: authorizationHeader() });
        const children = await response.json();
        return children.some((child: { steps: Array<{ toolName?: string; status?: string }> }) =>
          child.steps.some(step => step.toolName === "run_shell" && step.status === "running"));
      }, { timeout: 90_000 }).toBe(true);
      // A running tool step precedes shell startup. Use a marker written by
      // the actual sandbox process, before its sleep, as the fixture barrier.
      // Hold the actual shell until the fault is persisted. Runner timestamps
      // are clock-adjusted using second-resolution HTTP Date headers, so they
      // cannot prove millisecond ordering against API tool-step timestamps.
      await expect.poll(async () => {
        const response = await page.request.get(`${apiBaseUrl()}/api/sessions/${sibling!.session.id}/subagents`, { headers: authorizationHeader() });
        expect(response.ok()).toBe(true);
        const children = await response.json();
        const workspaceId = children[0]?.handoff?.workspaceId;
        if (!workspaceId) return false;
        siblingWorkspace = resolve(dataRoot!, "projects", sibling!.project.id, "sessions", sibling!.session.id,
          "agent-workspaces", workspaceId);
        const marker = resolve(siblingWorkspace, "healthy-sibling-started.txt");
        try { return await readFile(marker, "utf8") === "started"; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      }, { message: "Healthy sibling shell must start before injecting the transport fault", timeout: 90_000 }).toBe(true);
      releaseFaultTool();
      await expect.poll(async () => {
        const response = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture!.session.id}/subagents`, { headers: authorizationHeader() });
        expect(response.ok()).toBe(true);
        const children = await response.json();
        return children[0]?.steps.some((step: { toolName?: string; status?: string; content?: string }) =>
          step.toolName === "run_shell" && step.status === "failed" && expectedError.test(step.content ?? ""));
      }, { message: "Fault must be persisted while the healthy shell is held", timeout: 60_000 }).toBe(true);
      await expect(readFile(resolve(siblingWorkspace!, "healthy-sibling-finished.txt"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(resolve(siblingWorkspace!, "healthy-sibling-release.txt"), "release");
      return await verifyRun(faultRun);
    }
    const run = await sendUserMessage(page, fixture.session.id, "Delegate the local validation/recovery probe.");
    return await verifyRun(run);
  } finally {
    releaseFaultTool();
    try {
      if (fixture) await cleanupJourney(page, fixture);
    } finally {
      try { if (sibling) await cleanupJourney(page, sibling); }
      finally {
        await siblingContext?.close();
        await siblingModel?.stop();
        await stub.stop();
      }
    }
  }

  async function verifyRun(run: { id: string }): Promise<void> {
    if (!fixture) throw new Error("Fault fixture was not created");
    const activeFixture = fixture;
    const terminal = await waitForRunTerminal(page, activeFixture.session.id, run.id, 120_000);
    expect(terminal.status, terminal.error).toBe("completed");
    const response = await page.request.get(`${apiBaseUrl()}/api/sessions/${activeFixture.session.id}/subagents`, { headers: authorizationHeader() });
    expect(response.ok()).toBe(true);
    const children = await response.json();
    expect(children).toHaveLength(1);
    await info.attach("pre-bridge-child-trace", { body: JSON.stringify(children), contentType: "application/json" });
    await info.attach("scripted-model-tool-results", { body: JSON.stringify(stub.calls), contentType: "application/json" });
    const errorText = expectedError;
    expect(stub.calls.some(c => c.route === "subagent" && c.toolResults?.some(r => expectedError.test(r)))).toBe(true);
    expect(children[0].status).toBe("completed");
    expect(children[0].steps.some((s: { toolName?: string; status?: string; content?: string }) =>
      s.toolName === "run_shell" && s.status === "completed" && s.content?.includes("FIXTURE-CHILD-RECOVERED"))).toBe(true);
    expect(stub.calls.some(c => c.route === "main" && c.toolResults?.some(r => r.includes("Recovered child completed")))).toBe(true);
    expect.soft(children[0].steps.some((s: { toolName?: string; status?: string }) =>
      s.toolName === "run_shell" && s.status === "failed"), "Pre-bridge failure must be in the persisted child trace").toBe(true);
    const card = page.locator("section[aria-label='Subagent activity'] details.process-agent-record");
    await expect(card).toHaveCount(1);
    if (await card.getAttribute("open") === null) await card.locator(":scope > summary").click();
    await card.getByRole("button", { name: /^Open SubAgent: / }).click();
    const conversation = page.locator("section.subagent-conversation");
    const disclosures = conversation.locator("details");
    for (let index = 0; index < await disclosures.count(); index += 1) {
      const disclosure = disclosures.nth(index);
      if (await disclosure.getAttribute("open") === null) await disclosure.locator(":scope > summary").click();
    }
    // Match the actual tool error, not "validation" in the task heading/prompt.
    await expect.soft(conversation).toContainText(errorText);
    if (sibling && siblingPage && siblingRun && siblingModel) {
      expect((await waitForRunTerminal(siblingPage, sibling.session.id, siblingRun.id, 150_000)).status).toBe("completed");
      const activeSibling = sibling;
      await expect.poll(async () => {
        const response = await page.request.get(`${apiBaseUrl()}/api/sessions/${activeSibling.session.id}/subagents`, { headers: authorizationHeader() });
        expect(response.ok()).toBe(true);
        const children = await response.json();
        return children[0]?.status;
      }, { message: "Healthy child status should be persisted after its parent completes", timeout: 20_000 }).toBe("completed");
      const siblingChildrenResponse = await page.request.get(`${apiBaseUrl()}/api/sessions/${sibling.session.id}/subagents`, { headers: authorizationHeader() });
      expect(siblingChildrenResponse.ok()).toBe(true);
      const siblingChildren = await siblingChildrenResponse.json();
      expect(siblingChildren).toHaveLength(1);
      expect(siblingChildren[0].status).toBe("completed");
      const executionsResponse = await page.request.get(`${apiBaseUrl()}/api/sessions/${sibling.session.id}/execution-runs`, { headers: authorizationHeader() });
      expect(executionsResponse.ok()).toBe(true);
      const executions = await executionsResponse.json() as Array<{ tool: string; status: string; startedAt: string; finishedAt: string }>;
      const healthyExecution = executions.find(execution => execution.tool === "run_shell" && execution.status === "succeeded");
      expect(healthyExecution, "Healthy sibling shell must finish successfully").toBeDefined();
      const faultStep = children[0].steps.find((step: { toolName?: string; status?: string }) =>
        step.toolName === "run_shell" && step.status === "failed");
      expect(faultStep, "The injected fault must be persisted in the child trace").toBeDefined();
      // The release file was written only after the persisted fault above.
      // Success and the completion marker prove the same held shell survived.
      expect(await readFile(resolve(siblingWorkspace!, "healthy-sibling-finished.txt"), "utf8")).toBe("finished");
      expect(siblingModel.calls.some(c => c.route === "main"
        && c.toolResults?.some(r => r.includes("Healthy sibling completed")))).toBe(true);
      // A background execution completion can append another run's identity
      // header after this parent's response. Assert the actual visible reply,
      // rather than treating the last assistant-styled element as message text.
      await expect(siblingPage.locator("article.message.assistant")
        .filter({ hasText: "Healthy parent received child" })).toBeVisible();
    }
  }
});
}
