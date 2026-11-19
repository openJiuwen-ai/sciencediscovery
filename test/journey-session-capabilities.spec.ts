// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionRun, McpInvocation, PromptManifest, SessionDetail } from "../packages/schema/src/index.js";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { cancelActiveSessionRuns, cleanupJourney, createProjectAndSession, handlePermissionsUntilTerminal, openProjectSession, registerModel, scriptedModel, sendUserMessage, waitForRunTerminal } from "./helpers/journeys.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";

// Static suite metadata is inherited by each framework-expanded journey.
test.describe("journey-session-capabilities.spec", { tag: ["@isolation:global", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"] }, () => {

test.use({ locale: "en-US", actionTimeout: 15_000 });

// ScienceDiscovery's web tools, and the executor-native ones that stand in for them.
const WEB_TOOLS = ["web_search", "web_fetch", "free_search", "paid_search", "fetch_webpage"];

let stopEcho: (() => void) | undefined;
test.afterEach(() => { stopEcho?.(); stopEcho = undefined; });

/**
 * E2E-META
 * Purpose: Data sources, custom MCP servers and Web access are separate Session checkboxes, and each one decides what the Agent can call.
 * Steps:
 *   1. With Global settings cleared to their defaults, open the composer picker: Web access is checked, the custom server is listed
 *      by its name and unchecked, and toggling a data source leaves the others alone.
 *   2. With Web access inherited and the custom MCP checked, the Agent is offered both and one MCP tool call succeeds.
 *   3. Uncheck Web access and the custom MCP: neither is offered; a search attempt fails without a permission card.
 *   4. Check both again but turn the server off in System settings: Web access returns, the server's tools stay absent.
 *   5. Confirm the override list in Settings and run two Sessions using different models, Skills, connectors and Runners.
 * Environment: Isolated local stack and data directory, current local working tree; en-US browser locale.
 * Type: mocked
 * LLM: Local deterministic OpenAI-compatible stub that records the tools offered on each request; no provider API is called.
 * WebSearch: none; the only search attempt is made while Web access is off and never reaches a provider.
 * PaperSources: none
 * MCP: Real SDK HTTP echo fixture on loopback.
 * OtherExternal: none; browser non-local requests are blocked.
 * Credentials: E2E_API_TOKEN; local stub token has no external access.
 * CostSideEffects: Temporary model, project and MCP server; removed in finally. Global settings are cleared for the journey and restored in finally.
 */
test("Session checkboxes turn custom MCP and Web access on and off for the Agent", { tag: "@mocked" }, async ({ page, journey }) => {
  const name = `Capability MCP ${Date.now()}`;
  const echoFixture = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/mcp-echo.mjs", import.meta.url)), "--http", "0"]);
  stopEcho = () => { echoFixture.kill(); };
  let stderr = "";
  const echoPort = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Local MCP echo server did not start")), 30_000);
    echoFixture.once("error", error => { clearTimeout(timer); reject(error); });
    echoFixture.once("exit", () => { clearTimeout(timer); reject(new Error("Local MCP echo server exited")); });
    echoFixture.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      const match = /^\{"port":(\d+)\}$/m.exec(stderr);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
  });
  const echoUrl = `http://127.0.0.1:${echoPort}/mcp`;
  const saveServer = async (enabled: boolean, id?: string) => {
    const response = await page.request.fetch(`${apiBaseUrl()}/api/mcp/servers${id ? `/${id}` : ""}`, {
      method: id ? "PUT" : "POST", headers: authorizationHeader(),
      data: { name, transport: "http", url: echoUrl, enabled },
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
    await journey.step("Run two Sessions with separate capabilities", "Model credentials, Skills, MCP calls, Runner outputs and Memory data stay with their Session", async () => {
      await expect.poll(enabledIds).toEqual(["web", server.id]);
      await checkConcurrentSessions(page, fixture.project.id, echoUrl);
    });
  } finally {
    await globalSettings(page, globalOverrides);
    await cleanupJourney(page, fixture);
    await stub.stop();
    await page.request.delete(`${apiBaseUrl()}/api/mcp/servers/${server.id}`, { headers: authorizationHeader() });
  }
});

});

async function checkConcurrentSessions(page: Page, projectId: string, echoUrl: string) {
  const headers = authorizationHeader();
  const api = apiBaseUrl();
  const json = async <T>(path: string, method = "GET", data?: unknown): Promise<T> => {
    const response = await page.request.fetch(`${api}${path}`, { headers, method, data });
    expect(response.ok(), `${method} ${path} returned ${response.status()}`).toBe(true);
    return response.json() as Promise<T>;
  };
  const { createRunnerServer } = await import("../services/runner/dist/server.js");
  const dataDir = await mkdtemp(join(tmpdir(), "sd-gj06-"));
  const token = randomUUID();
  const remote = createRunnerServer({ authToken: token, bwrapPath: "bwrap", dataDir, execTimeoutMs: 60_000,
    host: "127.0.0.1", maxOutputBytes: 1_000_000, maxWorkspaceBytes: 1_073_741_824, npuBrokerEnabled: false, port: 0 });
  const cleanup: Array<() => Promise<unknown>> = [];
  const remove = async (path: string, data?: unknown) => {
    const response = await page.request.delete(`${api}${path}`, { headers, data });
    expect(response.ok(), `DELETE ${path} returned ${response.status()}`).toBe(true);
  };
  try {
    await new Promise<void>((resolve, reject) => {
      remote.once("error", reject);
      remote.listen(0, "127.0.0.1", resolve);
    });
    const suffix = randomUUID().slice(0, 8);
    const host = await json<{ id: string }>("/api/runners", "POST", { alias: `isolation-runner-${suffix}`,
      connectionKind: "direct", endpoint: { host: "127.0.0.1", port: (remote.address() as AddressInfo).port, protocol: "http" }, token });
    cleanup.unshift(() => remove(`/api/remote-hosts/${host.id}`));
    const readiness = await json<{ state: string }>(`/api/runners/${host.id}/connect`, "POST", {});
    expect(readiness.state).toBe("ready");
    const filename = "evidence.csv";
    const laneIds = ["alpha", "beta"] as const;
    const lanes = [];
    for (const [index, lane] of laneIds.entries()) {
      const content = `value\n${17 + index}\n`;
      const runnerId = index === 0 ? "local" : host.id;
      const label = `${lane}-${suffix}`;
      const connector = await json<{ id: string }>("/api/mcp/servers", "POST", { name: `Isolation MCP ${label}`,
        transport: "http", url: echoUrl, enabled: true });
      cleanup.unshift(() => remove(`/api/mcp/servers/${connector.id}`));
      const tools = await json<Array<{ id: string; mcpToolName: string }>>(`/api/mcp/sources/${connector.id}/tools`);
      const echo = tools.find(tool => tool.mcpToolName === "echo");
      expect(echo).toBeDefined();
      const mcpTool = `mcp__${connector.id}__${echo!.id}`;
      const skill = await json<{ id: string }>("/api/skills", "POST", { name: `isolation-skill-${label}`,
        description: `Fixture for ${label}`, instructions: `# Isolation skill\n\nUse only evidence for ${label}.` });
      cleanup.unshift(() => remove(`/api/skills/${skill.id}`));
      const identity = { model: `isolation-model-${label}`, apiToken: randomUUID() };
      const answer = `Completed isolation task ${label}.`;
      const stub = await scriptedModel([[
        { tool: "tool_search", arguments: { query: `select:${mcpTool}` } },
        { tool: mcpTool, arguments: { text: label } },
        { tool: "run_shell", arguments: { runner_id: runnerId, command: `printf '%s\\n' '${label}' > result.txt; cat result.txt`, wait_ms: 20_000 } },
        { text: answer },
      ]], undefined, { captureContext: true, identity, waitForShellCompletion: true });
      cleanup.unshift(stub.stop);
      const model = await registerModel(page, { ...identity, baseUrl: stub.baseUrl, name: identity.model });
      cleanup.unshift(() => remove(`/api/models/${model.id}`));
      const session = await json<{ id: string }>(`/api/projects/${projectId}/sessions`, "POST", { title: `Isolation ${lane}`,
        modelId: model.id, runnerIds: [runnerId], approvalMode: "always_allow", settingsOverrides: {
          skillSelectionMode: "selected", enabledSkillIds: [skill.id], enabledConnectorIds: [connector.id],
        } });
      const scope = `/api/sessions/${session.id}`;
      cleanup.unshift(async () => {
        await cancelActiveSessionRuns(page, session.id);
        if (runnerId === host.id) await remove(`/api/runners/${host.id}/workspaces/${session.id}`);
        await remove(scope, { confirmationId: session.id });
      });
      const uploaded = await page.request.post(`${api}${scope}/workspace/upload`, { headers, multipart: {
        files: { name: filename, mimeType: "text/csv", buffer: Buffer.from(content) },
      } });
      expect(uploaded.status()).toBe(201);
      lanes.push({ session, scope, label, runnerId, connector, mcpTool, skill, model, stub, answer, content });
    }
    const runs = await Promise.all(lanes.map(lane => json<{ id: string }>(`${lane.scope}/runs`, "POST", { content: `Execute isolation task ${lane.label}` })));
    await Promise.all(lanes.map(async (lane, index) => {
      const other = lanes[1 - index]!;
      const run = runs[index]!;
      const terminal = await waitForRunTerminal(page, lane.session.id, run.id, 120_000);
      expect(terminal.status, terminal.error).toBe("completed");
      const detail = await json<SessionDetail>(lane.scope);
      expect(detail.messages.filter(message => message.role === "assistant").map(message => message.content)).toContain(lane.answer);
      expect(JSON.stringify(detail.messages)).not.toContain(other.answer);
      expect(lane.stub.calls.some(call => call.offeredTools?.includes(lane.mcpTool))).toBe(true);
      expect(lane.stub.calls.every(call => !call.offeredTools?.includes(other.mcpTool))).toBe(true);
      const calls = await json<McpInvocation[]>(`${lane.scope}/mcp/invocations`);
      expect(calls.map(({ sourceId, turnId, status }) => ({ sourceId, turnId, status }))).toEqual([
        { sourceId: lane.connector.id, turnId: run.id, status: "succeeded" },
      ]);
      const manifests = (await json<PromptManifest[]>(`${lane.scope}/prompt-manifests`)).filter(item => item.turnId === run.id);
      expect(manifests.length).toBeGreaterThan(0);
      for (const manifest of manifests) {
        expect(manifest.modelProfileId).toBe(lane.model.id);
        expect(manifest.runtimeSettings.enabledConnectorIds).toEqual([lane.connector.id]);
        expect(manifest.runtimeSettings.enabledSkillIds).toEqual([lane.skill.id]);
        expect(manifest.skillRefs.map(ref => ref.id)).toContain(lane.skill.id);
      }
      const executions = await json<ExecutionRun[]>(`${lane.scope}/execution-runs`);
      expect(executions).toHaveLength(1);
      expect(executions[0]).toMatchObject({ runnerId: lane.runnerId, exitCode: 0, sandbox: "bubblewrap", createdFiles: ["result.txt"],
        stdout: { hash: createHash("sha256").update(`${lane.label}\n`).digest("hex") } });
      const results = lane.stub.calls.flatMap(call => call.toolResults ?? []).join("\n");
      expect(results).toContain(lane.label.toUpperCase());
      expect(results).not.toContain(other.label.toUpperCase());
      const read = await page.request.get(`${api}${lane.scope}/file?path=${filename}`, { headers });
      expect(await read.text()).toBe(lane.content);
      await expect.poll(async () => {
        const graph = await json<{ hits: Array<{ id: string; sessionId: string; extra: { content_hash: string } }> }>(
          "/api/memory/query/by-node-type", "POST", { node_types: ["SourceFile"], session_id: lane.session.id });
        return graph.hits.filter(hit => hit.id.endsWith(`:${filename}`)).map(hit => [hit.id, hit.sessionId, hit.extra.content_hash]);
      }, { timeout: 15_000 }).toEqual([[`source_file:session:${lane.session.id}:${filename}`, lane.session.id,
        createHash("sha256").update(lane.content).digest("hex")]]);
    }));
  } finally {
    const errors: unknown[] = [];
    for (const dispose of cleanup) {
      try { await dispose(); } catch (error) { errors.push(error); }
    }
    await new Promise<void>(resolve => { remote.close(() => resolve()); remote.closeAllConnections(); });
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3 });
    if (errors.length) throw new AggregateError(errors, "Could not clean up Session isolation fixtures");
  }
}

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
