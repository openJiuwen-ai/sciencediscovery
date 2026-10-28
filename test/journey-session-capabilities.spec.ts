// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { cleanupJourney, createProjectAndSession, handlePermissionsUntilTerminal, openProjectSession, scriptedModel, sendUserMessage } from "./helpers/journeys.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";

// Static suite metadata is inherited by each framework-expanded journey.
test.describe("journey-session-capabilities.spec", { tag: ["@isolation:global", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"] }, () => {

test.use({ locale: "en-US", actionTimeout: 15_000 });

// ScienceDiscovery's web tools, and the executor-native ones that stand in for them.
const WEB_TOOLS = ["web_search", "web_fetch", "free_search", "paid_search", "fetch_webpage"];

/**
 * E2E-META
 * Purpose: Data sources, custom MCP servers and Web access are separate Session checkboxes, and each one decides what the Agent can call.
 * Steps:
 *   1. With Global settings cleared to their defaults, open the composer picker: Web access is checked, the custom server is listed
 *      by its name and unchecked, and toggling a data source leaves the others alone.
 *   2. With Web access inherited and the custom MCP checked, the Agent is offered both and one MCP tool call succeeds.
 *   3. Uncheck Web access and the custom MCP: neither is offered; a search attempt fails without a permission card.
 *   4. Check both again but turn the server off in System settings: Web access returns, the server's tools stay absent.
 *   5. Open Session settings: the override list shows the same three groups and checked state.
 * Environment: Isolated local stack and data directory, current local working tree; en-US browser locale.
 * Type: mocked
 * LLM: Local deterministic OpenAI-compatible stub that records the tools offered on each request; no provider API is called.
 * WebSearch: none; the only search attempt is made while Web access is off and never reaches a provider.
 * PaperSources: none
 * MCP: Real SDK stdio echo fixture on the API host.
 * OtherExternal: none; browser non-local requests are blocked.
 * Credentials: E2E_API_TOKEN; local stub token has no external access.
 * CostSideEffects: Temporary model, project and MCP server; removed in finally. Global settings are cleared for the journey and restored in finally.
 */
test("Session checkboxes turn custom MCP and Web access on and off for the Agent", { tag: "@mocked" }, async ({ page, journey }) => {
  const name = `Capability MCP ${Date.now()}`;
  const echoFixture = fileURLToPath(new URL("./fixtures/mcp-echo.mjs", import.meta.url));
  const saveServer = async (enabled: boolean, id?: string) => {
    const response = await page.request.fetch(`${apiBaseUrl()}/api/mcp/servers${id ? `/${id}` : ""}`, {
      method: id ? "PUT" : "POST", headers: authorizationHeader(),
      data: { name, command: process.execPath, args: [echoFixture], enabled },
    });
    expect(response.ok()).toBe(true);
    return await response.json() as { id: string };
  };
  const server = await saveServer(true);
  const toolsResponse = await page.request.get(`${apiBaseUrl()}/api/mcp/sources/${server.id}/tools`, { headers: authorizationHeader() });
  expect(toolsResponse.ok()).toBe(true);
  const echo = (await toolsResponse.json() as Array<{ id: string; mcpToolName: string }>).find((tool) => tool.mcpToolName === "echo")!;
  const mcpTool = `mcp__${server.id}__${echo.id}`;
  // Turn 2 tries whichever web search tool turn 1 was offered, so the attempt names a real tool of this executor.
  const searchAttempt = { tool: "web_search", arguments: { query: "latest perovskite stability results" } };
  const stub = await scriptedModel([
    [
      { tool: "tool_search", arguments: { query: `select:${mcpTool}` } },
      { tool: mcpTool, arguments: { text: "capability checked" } },
      { text: "MCP CALLED" },
    ],
    [searchAttempt, { text: "WEB OFF" }],
    [{ tool: "mcp_readiness", arguments: { action: "continue", reason: "This task needs no MCP evidence", sourceIds: [] } }, { text: "WEB BACK" }],
  ], undefined, { captureContext: true });
  const fixture = await createProjectAndSession(page, {
    projectName: name, sessionTitle: "Session capabilities", approvalMode: "ask_for_dangerous",
    model: { apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: `${name} model` },
  });
  journey.scenario({ goal: "Each Session capability checkbox decides whether the Agent can use it", preconditions: ["Isolated local stack", "Global settings cleared to defaults", "Local MCP echo fixture", "Local scripted model", "No external calls"] });
  const picker = page.locator(".connector-picker-popover");
  const box = (label: RegExp) => picker.getByRole("checkbox", { name: label });
  const webBox = box(/^Web/);
  const serverBox = box(new RegExp(name));
  const enabledIds = () => sessionConnectors(page, fixture.session.id);
  const run = async (prompt: string) => {
    const before = stub.calls.length;
    const created = await sendUserMessage(page, fixture.session.id, prompt);
    const result = await handlePermissionsUntilTerminal(page, fixture.session.id, created.id, { timeout: 120_000 });
    expect(result.run.status, result.run.error).toBe("completed");
    const calls = stub.calls.slice(before).filter((call) => call.route === "main");
    return { ...result, calls, offered: new Set(calls.flatMap((call) => call.offeredTools ?? [])) };
  };
  const invocations = async () => {
    const response = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture.session.id}/mcp/invocations`, { headers: authorizationHeader() });
    expect(response.ok()).toBe(true);
    return await response.json() as Array<{ sourceId: string; status: string; turnId: string }>;
  };
  // Clearing Global settings (PUT /api/settings {}) is what other journeys and API clients do; start from it on
  // purpose, so the Web access a new Session inherits below is the built-in default rather than a seeded list.
  const globalOverrides = await globalSettings(page);
  await globalSettings(page, {});
  try {
    await openProjectSession(page, fixture);
    await journey.step("Open the capability checkboxes", "Data sources, Web access and Custom MCP are separate groups; the server is listed by its name", async () => {
      await page.locator(".connector-picker-trigger").click();
      await expect(picker.locator(".connector-picker-group-label")).toHaveText(["Data sources", "Web access", "Custom MCP"]);
      await expect(picker.locator(".connector-picker-group").filter({ hasText: "Custom MCP" })).toContainText(name);
      // A new Session inherits Web access even with nothing set at any layer; a custom server stays off until it is checked here.
      await expect(webBox).toBeChecked();
      await expect(serverBox).not.toBeChecked();
      const before = await enabledIds();
      const pubmed = box(/^PubMed/);
      // The picker saves each click to the Session before the box shows it.
      await toggle(pubmed, true);
      await expect.poll(enabledIds).toEqual([...before, "pubmed"]);
      await toggle(pubmed, false);
      await expect.poll(enabledIds).toEqual(before);
      await toggle(serverBox, true);
      await expect.poll(enabledIds).toEqual([...before, server.id]);
      await expect(webBox).toBeChecked();
      await page.keyboard.press("Escape");
    });
    let offeredWebTools: string[] = [];
    await journey.step("Call the checked custom MCP", "The Agent is offered Web access and the server's tool, and the tool call succeeds", async () => {
      const { offered, run: completed } = await run("Use the local echo MCP tool to uppercase capability checked.");
      offeredWebTools = WEB_TOOLS.filter((tool) => offered.has(tool));
      journey.note(`Web tools offered with Web access checked: ${offeredWebTools.join(", ") || "none"}`);
      expect(offeredWebTools.length, `offered: ${[...offered].join(", ")}`).toBeGreaterThan(0);
      expect(offered.has(mcpTool)).toBe(true);
      expect((await invocations()).some((item) => item.sourceId === server.id && item.turnId === completed.id && item.status === "succeeded")).toBe(true);
      await expect(page.locator(".message").filter({ hasText: "MCP CALLED" }).last()).toBeVisible();
      searchAttempt.tool = offeredWebTools.find((tool) => tool.endsWith("search")) ?? offeredWebTools[0]!;
    });
    await journey.step("Uncheck Web access and the custom MCP", "Neither is offered, and a search attempt fails without asking for permission", async () => {
      await page.locator(".connector-picker-trigger").click();
      await toggle(webBox, false);
      await toggle(serverBox, false);
      await expect.poll(enabledIds).toEqual([]);
      await page.keyboard.press("Escape");
      const before = (await invocations()).length;
      const { calls, decisions, offered } = await run("Search the web for the latest perovskite stability results.");
      const attempted = calls.at(-1)?.toolResults?.at(-1) ?? "";
      journey.note(`Web tools offered with Web access unchecked: ${WEB_TOOLS.filter((tool) => offered.has(tool)).join(", ") || "none"}`);
      journey.note(`Result of the ${searchAttempt.tool} attempt: ${attempted.slice(0, 300)}`);
      expect(WEB_TOOLS.filter((tool) => offered.has(tool))).toEqual([]);
      expect(offered.has(mcpTool)).toBe(false);
      // The attempted call reached no tool: nothing asked the user for permission and no search ran.
      expect(decisions).toBe(0);
      await expect(page.locator(".permission-card.pending")).toHaveCount(0);
      expect(attempted).not.toMatch(/https?:\/\//);
      expect((await invocations()).length).toBe(before);
      await expect(page.locator(".message").filter({ hasText: "WEB OFF" }).last()).toBeVisible();
    });
    await journey.step("Check both again with the server off in System settings", "Web access returns; the server's tools stay absent until it is enabled globally", async () => {
      await saveServer(false, server.id);
      await page.locator(".connector-picker-trigger").click();
      await picker.getByRole("button", { name: "Reload MCP catalog", exact: true }).click();
      await toggle(webBox, true);
      await toggle(serverBox, true);
      await expect.poll(enabledIds).toEqual(["web", server.id]);
      await expect(picker.locator("li").filter({ hasText: name }).getByRole("status")).toContainText("MCP unavailable");
      await page.keyboard.press("Escape");
      const { offered } = await run("Do a task that needs no MCP evidence.");
      expect(WEB_TOOLS.filter((tool) => offered.has(tool))).toEqual(offeredWebTools);
      expect(offered.has(mcpTool)).toBe(false);
      await expect(page.locator(".message").filter({ hasText: "WEB BACK" }).last()).toBeVisible();
    });
    await journey.step("Review the same choice in Session settings", "The override list shows the same three groups, with Web access and the server checked", async () => {
      await page.goto(`/projects/${fixture.project.id}/sessions/${fixture.session.id}/settings`);
      const dialog = page.getByRole("dialog", { name: "Session settings" });
      await expect(dialog.getByLabel("Connector settings mode")).toHaveValue("override");
      for (const label of ["Data sources", "Web access", "Custom MCP"]) await expect(dialog.getByRole("group", { name: label })).toBeVisible();
      await expect(dialog.getByRole("group", { name: "Web access" }).getByRole("checkbox", { name: "Web" })).toBeChecked();
      await expect(dialog.getByRole("group", { name: "Custom MCP" }).getByRole("checkbox", { name })).toBeChecked();
      await expect(dialog.getByRole("group", { name: "Data sources" }).getByRole("checkbox", { name: "PubMed" })).not.toBeChecked();
      await dialog.getByRole("group", { name: "Custom MCP" }).scrollIntoViewIfNeeded();
    });
  } finally {
    await globalSettings(page, globalOverrides);
    await cleanupJourney(page, fixture);
    await stub.stop();
    await page.request.delete(`${apiBaseUrl()}/api/mcp/servers/${server.id}`, { headers: authorizationHeader() });
  }
});

});

/** Read the Global overrides, or replace them when `overrides` is given. */
async function globalSettings(page: Page, overrides?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await page.request.fetch(`${apiBaseUrl()}/api/settings`, {
    headers: authorizationHeader(), method: overrides ? "PUT" : "GET", ...(overrides ? { data: overrides } : {}),
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json() as { overrides: Record<string, unknown> }).overrides;
}

async function toggle(checkbox: Locator, checked: boolean): Promise<void> {
  await checkbox.click();
  if (checked) await expect(checkbox).toBeChecked();
  else await expect(checkbox).not.toBeChecked();
}

async function sessionConnectors(page: Page, sessionId: string): Promise<string[]> {
  const response = await page.request.get(`${apiBaseUrl()}/api/sessions/${sessionId}`, { headers: authorizationHeader() });
  expect(response.ok()).toBe(true);
  return (await response.json() as { enabledConnectorIds: string[] }).enabledConnectorIds;
}
