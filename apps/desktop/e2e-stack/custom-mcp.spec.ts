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

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { expect, test as base } from "@playwright/test";
import {
  API_ORIGIN, api, cleanupFixture, openSession, seedToken,
  sendMessage, waitForRun, type RealFixture,
} from "../e2e-real/support.js";
import { createJourneyReporter, type JourneyReporter } from "../../../test/helpers/journey-report.ts";
import { createProjectAndSession, scriptedModel } from "../../../test/helpers/journeys.ts";

const test = base.extend<{ journey: JourneyReporter }>({
  journey: async ({ page }, use, info) => {
    const reporter = createJourneyReporter(page, info);
    try {
      await use(reporter);
    } finally {
      await reporter.finalize();
    }
  },
});

interface ServerDetails {
  enabled: boolean;
  id: string;
  name: string;
  timeoutSeconds: number;
  tools: Array<{ id: string }>;
  transport: string;
}

/**
 * E2E-META
 * Purpose: Create, edit, call and delete a custom MCP server from the desktop UI.
 * Steps:
 *   1. Open the add dialog and check the defaults.
 *   2. Save a disabled local STDIO server in the UI and read back its config.
 *   3. Test the connection and verify discovery of two tools.
 *   4. Enable the server and select it as a default source.
 *   5. Edit the saved description, reload and verify persistence.
 *   6. Send a prompt in the desktop conversation, verify the actual Echo result
 *      and successful invocation, then reload the conversation.
 *   7. Cancel deletion once, then confirm deletion and reload.
 * Environment: isolated loopback product stack and Desktop Vite proxy.
 * Type: mocked
 * LLM: Local deterministic OpenAI-compatible model; genuine MCP protocol call.
 * WebSearch: none
 * PaperSources: none
 * MCP: Local SDK STDIO Echo.
 * OtherExternal: none; browser egress restricted to loopback.
 * Credentials: E2E_API_TOKEN for the isolated stack; local model stub only.
 * CostSideEffects: temporary isolated project, session, model, and MCP server.
 */
test("creates, edits, calls and deletes a custom MCP server in desktop settings", { tag: "@mocked" }, async ({ page, journey }) => {
  page.setDefaultTimeout(12_000);
  page.setDefaultNavigationTimeout(25_000);
  if (!process.env.E2E_API_TOKEN?.trim()) throw new Error("BLOCKED: E2E_API_TOKEN is required");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(API_ORIGIN).hostname)) {
    throw new Error("BLOCKED: the MCP stack journey requires a loopback API");
  }
  const health = await api<{ status: string; runner?: { status: string } }>(page, "/health");
  expect(health.status).toBe("ok");
  expect(health.runner?.status).toBe("ok");
  await seedToken(page);
  await page.addInitScript(() => {
    localStorage.setItem("sciencediscovery-desktop:locale", "zh-CN");
    localStorage.setItem("sciencediscovery-desktop:guide", "1");
  });
  await page.context().route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1"
    ? route.continue()
    : route.abort("blockedbyclient"));
  const suffix = randomUUID().slice(0, 8);
  const name = `MCP Echo ${suffix}`;
  const marker = `mcp desktop ${suffix}`;
  const expected = marker.toUpperCase();
  const selectTool = { tool: "tool_search", arguments: { query: "" } };
  const useEcho = { tool: "", arguments: { text: marker } };
  const stub = await scriptedModel([[selectTool, useEcho, { text: expected }]], undefined, { captureContext: true });
  const getServers = () => api<ServerDetails[]>(page, "/api/mcp/servers");
  let fixture: RealFixture | undefined;
  let serverId: string | undefined;
  journey.scenario({
    goal: "Use a custom MCP server added from desktop settings in a conversation",
    preconditions: ["Isolated real API and Runner", "Local SDK Echo server", "Deterministic local model"],
  });
  try {
    const created = await createProjectAndSession(page, {
      approvalMode: "always_allow", projectName: name, sessionTitle: name,
      model: { apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name },
    });
    const active: RealFixture = { ...created, modelOwned: true };
    fixture = active;
    journey.note(`Project: ${active.project.id}; session: ${active.session.id}.`);
    await openSession(page, active);
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    const form = page.getByRole("dialog", { name: "新建服务器", exact: true });
    const card = settings.locator(".settings-card").filter({ hasText: name });
    await journey.step("Open the Add MCP server dialog", "The form defaults to Streamable HTTP, a disabled server, and a 60-second tool timeout.", async () => {
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await settings.getByRole("button", { name: "MCP 服务器", exact: true }).click();
      await settings.getByRole("button", { name: "添加服务器", exact: true }).click();
      await expect(form.getByRole("checkbox", { name: "启用服务" })).not.toBeChecked();
      await expect(form.getByLabel("传输方式")).toHaveValue("http");
      await expect(form.getByRole("spinbutton", { name: "超时（秒）" })).toHaveValue("60");
    });
    await journey.step("Create a local STDIO server", "A disabled STDIO server appears in the settings list.", async () => {
      await form.getByLabel("名称", { exact: true }).fill(name);
      await form.getByLabel("传输方式").selectOption("stdio");
      await form.getByLabel("命令", { exact: true }).fill(process.execPath);
      await form.getByLabel("参数", { exact: true }).fill(fileURLToPath(new URL("../../../test/fixtures/mcp-echo.mjs", import.meta.url)));
      await form.getByRole("button", { name: "保存", exact: true }).click();
      await form.getByRole("button", { name: "完成", exact: true }).click();
      await expect(form).toBeHidden();
      await expect(card).toBeVisible();
      const server = (await getServers()).find((item) => item.name === name);
      expect(server).toMatchObject({ enabled: false, timeoutSeconds: 60, transport: "stdio" });
      serverId = server!.id;
    });
    await journey.step("Test the saved connection", "The connection test finds two tools while the server remains disabled.", async () => {
      await card.getByRole("button", { name: "测试", exact: true }).click();
      await expect(card.getByText("2 个工具", { exact: true })).toBeVisible();
      expect((await getServers()).find((server) => server.id === serverId)).toMatchObject({ enabled: false });
    });
    await journey.step("Enable and select the validated server", "The Echo source can be selected by default independently of enabling the service.", async () => {
      const defaults = card.getByRole("switch", { name: `${name} · 默认使用` });
      await expect(defaults).not.toBeChecked();
      await card.getByRole("button", { name: "编辑", exact: true }).click();
      const editor = page.getByRole("dialog", { name: "编辑服务器", exact: true });
      await editor.getByRole("checkbox", { name: "启用服务" }).check();
      await editor.getByRole("button", { name: "保存", exact: true }).click();
      await expect(editor).toBeHidden();
      await expect(defaults).not.toBeChecked();
      await defaults.click();
      await expect(defaults).toBeChecked();
      const tools = await api<Array<{ id: string; mcpToolName: string }>>(page, `/api/mcp/sources/${serverId}/tools`);
      const echo = tools.find((tool) => tool.mcpToolName === "echo");
      expect(echo).toBeDefined();
      useEcho.tool = `mcp__${serverId}__${echo!.id}`;
      selectTool.arguments.query = `select:${useEcho.tool}`;
    });
    await journey.step("Edit the server and reload its saved configuration", "The edited description persists after reloading, and the service remains enabled.", async () => {
      await card.getByRole("button", { name: "编辑", exact: true }).click();
      const editor = page.getByRole("dialog", { name: "编辑服务器", exact: true });
      await editor.locator(".settings-row").filter({ hasText: "说明" }).locator("input").fill("Edited local Echo server");
      await editor.getByRole("button", { name: "保存", exact: true }).click();
      await expect(editor).toBeHidden();
      await expect(card).toContainText("Edited local Echo server");
      await page.reload();
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await settings.getByRole("button", { name: "MCP 服务器", exact: true }).click();
      await expect(card).toContainText("Edited local Echo server");
      const saved = (await getServers()).find((server) => server.id === serverId);
      expect(saved).toMatchObject({ description: "Edited local Echo server", enabled: true });
    });
    await journey.step("Call Echo from the conversation", "The MCP service returns the uppercase marker, the invocation is recorded, and the saved answer is visible after reload.", async () => {
      await page.keyboard.press("Escape");
      await expect(settings).toBeHidden();
      const run = await sendMessage(page, active.session.id, `请使用 ${name} 的 echo 工具，把 ${marker} 转为大写并返回结果。`);
      const terminal = await waitForRun(page, active.session.id, run.id, 60_000);
      expect(terminal.status).toBe("completed");
      let invocation: { id: string; sourceId: string; status: string; mcpToolName: string; rawResponse?: object } | undefined;
      await expect.poll(async () => {
        const records = await api<Array<NonNullable<typeof invocation>>>(page, `/api/sessions/${active.session.id}/mcp/invocations`);
        invocation = records.find((item) => item.sourceId === serverId && item.mcpToolName === "echo");
        return invocation?.status;
      }).toBe("succeeded");
      expect(invocation?.rawResponse).toBeDefined();
      expect(stub.calls.flatMap((call) => call.toolResults ?? []).join("\n")).toContain(expected);
      const answer = page.locator(".message.assistant").filter({ hasText: expected });
      await expect(answer).toBeVisible();
      await openSession(page, active);
      await expect(answer).toBeVisible();
      journey.note(`Server: ${serverId}; run: ${run.id}; invocation: ${invocation?.id}; Echo result: ${expected}.`);
    });
    await journey.step("Cancel deletion, then delete and reload", "Cancelling keeps the server; confirming removes it from the saved list and its default-source references.", async () => {
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await settings.getByRole("button", { name: "MCP 服务器", exact: true }).click();
      await card.getByRole("button", { name: "删除", exact: true }).click();
      const confirmation = page.getByRole("dialog", { name: `删除服务器「${name}」？`, exact: true });
      await confirmation.locator(".modal-footer").getByRole("button", { name: "取消", exact: true }).press("Enter");
      await expect(card).toBeVisible();
      expect((await getServers()).some((server) => server.id === serverId)).toBe(true);
      await card.getByRole("button", { name: "删除", exact: true }).click();
      await confirmation.getByRole("button", { name: "删除", exact: true }).press("Enter");
      await expect(card).toHaveCount(0);
      expect((await getServers()).some((server) => server.id === serverId)).toBe(false);
      const defaults = await api<{ effective: { enabledConnectorIds: string[] } }>(page, "/api/settings");
      expect(defaults.effective.enabledConnectorIds).not.toContain(serverId);
      await page.reload();
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await settings.getByRole("button", { name: "MCP 服务器", exact: true }).click();
      await expect(card).toHaveCount(0);
    });
  } finally {
    try {
      await cleanupFixture(fixture);
      const owned = (await getServers()).find((server) => server.name === name);
      if (owned) await api(page, `/api/mcp/servers/${owned.id}`, { method: "DELETE" });
      expect((await getServers()).some((server) => server.name === name)).toBe(false);
      if (fixture) {
        const projects = await api<Array<{ id: string }>>(page, "/api/projects");
        const models = await api<Array<{ id: string }>>(page, "/api/models");
        expect(projects.some((item) => item.id === fixture!.project.id)).toBe(false);
        expect(models.some((item) => item.id === fixture!.model?.id)).toBe(false);
      }
      journey.note("Temporary MCP server, project/session and model profile removed and verified.");
    } finally {
      await stub.stop();
    }
  }
});
