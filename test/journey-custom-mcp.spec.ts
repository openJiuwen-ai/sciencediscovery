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
import { expect } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { cleanupJourney, createProjectAndSession, openProjectSession, scriptedModel, sendUserMessage, waitForRunTerminal } from "./helpers/journeys.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";

test.use({ locale: "zh-CN", actionTimeout: 15_000 });

/**
 * E2E-META
 * Purpose: Custom MCP configuration and embedded Inspector work through the real UI/API.
 * Steps:
 *   1. Add a stdio server and discover tools.
 *   2. Invoke valid/invalid/error inputs and inspect the audit ID.
 *   3. Inspect mobile layout, disable, retest, import JSON and delete servers.
 * Environment: Isolated local stack and data directory, built from the current local working tree.
 * Type: mocked
 * LLM: none; no model endpoint is called.
 * WebSearch: none
 * PaperSources: none
 * MCP: real SDK stdio transport to test/fixtures/mcp-echo.mjs; deterministic local tools only.
 * OtherExternal: none; non-local browser requests blocked by the standard fixture.
 * Credentials: E2E_API_TOKEN for the isolated instance; no vendor credentials.
 * CostSideEffects: Creates temporary project and custom configurations; removes them in finally.
 */
test("Custom MCP and Inspector user journey", { tag: "@mocked" }, async ({ page, journey }) => {
  journey.scenario({ goal: "Configure a local MCP service and verify its tools without calling a model", preconditions: ["Isolated local stack running", "Local Node MCP fixture available", "Current Session selected"] });
  await page.addInitScript(() => localStorage.setItem("science-agent-locale", "zh-CN"));
  const fixture = await createProjectAndSession(page, { projectName: `MCP journey ${Date.now()}`, sessionTitle: "MCP Inspector test" });
  const name = `Local MCP ${Date.now()}`;
  const importedName = `${name} imported`;
  const mcpFixture = fileURLToPath(new URL("./fixtures/mcp-echo.mjs", import.meta.url));
  const dialog = page.getByRole("dialog", { name: "系统设置" });
  const settings = dialog.locator(".mcp-settings");
  const row = settings.locator(".mcp-server").filter({ has: page.locator("strong", { hasText: name }) });
  try {
    await openProjectSession(page, fixture);
    await journey.step("添加本地 MCP", "保存后发现两个工具，显示已连接", async () => {
      await page.getByRole("button", { name: /^系统设置/ }).click();
      await dialog.getByRole("navigation", { name: "设置分组" }).getByRole("button", { name: /^MCP 服务器/ }).click();
      await settings.getByRole("button", { name: "添加服务器", exact: true }).click();
      await settings.getByLabel("名称", { exact: true }).fill(name);
      await settings.getByLabel("连接方式").selectOption("stdio");
      await settings.getByLabel("命令", { exact: true }).fill(process.execPath);
      await settings.getByLabel("参数（每行一个）").fill(mcpFixture);
      await settings.getByLabel("启用", { exact: true }).check();
      await settings.getByRole("button", { name: "保存", exact: true }).click();
      await expect(row).toContainText("已连接");
      await expect(row).toContainText("2 个工具");
      await row.getByRole("button", { name: `测试连接 ${name}`, exact: true }).click();
      await expect(settings.getByRole("status")).toContainText("连接成功");
    });
    await journey.step("折叠服务器与摘要排版", "状态、工具数量和 Inspector 同行，折叠后隐藏详情", async () => {
      const summary = row.locator(".mcp-server-summary");
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        const centers = await summary.locator(":scope > *").evaluateAll((items) => items.map((item) => {
          const rect = item.getBoundingClientRect();
          return rect.y + rect.height / 2;
        }));
        expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(2);
        expect(await row.evaluate((item) => item.scrollWidth <= item.clientWidth + 1)).toBe(true);
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await row.getByRole("button", { name: `收起服务器 ${name}`, exact: true }).click();
      await expect(row.locator(".mcp-server-details")).toBeHidden();
      await row.getByRole("button", { name: `展开服务器 ${name}`, exact: true }).click();
      await expect(summary).toBeVisible();
    });
    await journey.step("手动调用及审计", "echo 返回大写正文，展示耗时和可展开的审计 ID", async () => {
      await row.getByRole("button", { name: "MCP Inspector", exact: true }).click();
      await settings.getByLabel("工具", { exact: true }).selectOption("echo");
      await settings.getByLabel("调用参数（JSON）").fill('{"text":"hello inspector"}');
      await settings.getByRole("button", { name: "执行工具", exact: true }).click();
      await expect(settings.getByRole("status")).toContainText("工具调用成功");
      await expect(settings.locator(".mcp-inspector-output")).toContainText("HELLO INSPECTOR");
      await settings.getByText("审计记录 ID", { exact: true }).click();
      await expect(settings.locator(".mcp-invocation-id code")).not.toBeEmpty();
      await settings.getByRole("tab", { name: "标准化结果", exact: true }).click();
      await expect(settings.locator(".mcp-inspector-output")).toContainText('"untrusted": true');
    });
    await journey.step("参数错误和工具失败", "无效 JSON 不发请求，服务器错误可见并可再次执行", async () => {
      await settings.getByLabel("调用参数（JSON）").fill("{");
      await settings.getByRole("button", { name: "执行工具", exact: true }).click();
      await expect(settings.getByRole("alert")).toContainText("有效的 JSON");
      await settings.getByLabel("调用参数（JSON）").fill('{"text":"error"}');
      await settings.getByRole("button", { name: "执行工具", exact: true }).click();
      await expect(settings.getByRole("status")).toContainText("工具调用失败");
      await expect(settings.getByRole("status")).toContainText("Requested fixture error");
      await settings.getByLabel("工具", { exact: true }).selectOption("add_numbers");
      await settings.getByLabel("调用参数（JSON）").fill('{"a":7,"b":8}');
      await settings.getByRole("button", { name: "执行工具", exact: true }).click();
      await expect(settings.getByRole("status")).toContainText("工具调用成功");
      await expect(settings.locator(".mcp-inspector-output")).toContainText("15");
    });
    await journey.step("小屏幕查看", "Inspector 控件保持可见，无横向溢出", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(settings.getByRole("button", { name: "执行工具", exact: true })).toBeVisible();
      expect(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    });
    await journey.step("取消工具调用", "执行时显示转圈，取消后可重新执行", async () => {
      await settings.getByLabel("工具", { exact: true }).selectOption("echo");
      await settings.getByLabel("调用参数（JSON）").fill('{"text":"slow"}');
      await settings.getByRole("button", { name: "执行工具", exact: true }).click();
      await expect(settings.getByRole("button", { name: "执行中", exact: true })).toBeDisabled();
      await settings.getByRole("button", { name: "取消", exact: true }).click();
      await expect(settings.getByRole("alert")).toContainText("已取消调用");
      await expect(settings.getByRole("button", { name: "执行工具", exact: true })).toBeEnabled();
    });
    await journey.step("停用与独立探测", "停用后仍可测试连接，但 Inspector 不允许执行", async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await settings.getByRole("button", { name: "返回服务器列表", exact: true }).click();
      await row.getByRole("switch").click();
      await expect(row.getByRole("switch")).not.toBeChecked();
      await expect(row).toContainText("已停用");
      await row.getByRole("button", { name: `测试连接 ${name}`, exact: true }).click();
      await expect(settings.getByRole("status")).toContainText("连接成功");
      await row.getByRole("button", { name: "MCP Inspector", exact: true }).click();
      await expect(settings.getByRole("button", { name: "执行工具", exact: true })).toBeDisabled();
      await settings.getByRole("button", { name: "返回服务器列表", exact: true }).click();
    });
    await journey.step("导入与删除", "JSON 导入默认停用，删除需再次确认", async () => {
      await settings.getByRole("button", { name: "导入 JSON", exact: true }).click();
      await settings.getByLabel("JSON (mcpServers)").fill(JSON.stringify({ mcpServers: { [importedName]: { command: process.execPath, args: [mcpFixture] } } }));
      await settings.getByRole("button", { name: "导入 JSON", exact: true }).click();
      const imported = settings.locator(".mcp-server").filter({ hasText: importedName });
      await expect(imported).toContainText("已停用");
      await imported.getByRole("button", { name: `删除服务器 ${importedName}`, exact: true }).click();
      await expect(imported).toBeVisible();
      await imported.getByRole("button", { name: `确认删除 ${importedName}`, exact: true }).click();
      await expect(imported).toHaveCount(0);
    });
  } finally {
    const response = await page.request.get(`${apiBaseUrl()}/api/mcp/servers`, { headers: authorizationHeader() });
    const servers = await response.json() as Array<{ id: string; name: string }>;
    for (const server of servers.filter((item) => [name, importedName].includes(item.name))) await page.request.delete(`${apiBaseUrl()}/api/mcp/servers/${server.id}`, { headers: authorizationHeader() });
    await page.request.delete(`${apiBaseUrl()}/api/projects/${fixture.project.id}`, { headers: authorizationHeader(), data: { confirmationId: fixture.project.id } });
  }
});

/**
 * E2E-META
 * Purpose: Agent discovers and calls a custom MCP tool after Session-level selection.
 * Steps:
 *   1. Select the custom connector in the composer.
 *   2. Send a request; the scripted local model discovers and invokes the MCP tool.
 *   3. Assert persisted successful MCP invocation and final response; clean up.
 * Environment: Isolated local stack and data directory, current local working tree.
 * Type: mocked
 * LLM: Local deterministic OpenAI-compatible stub; no provider API is called.
 * WebSearch: none
 * PaperSources: none
 * MCP: Real SDK stdio echo fixture on the API host.
 * OtherExternal: none; browser non-local requests are blocked.
 * Credentials: E2E_API_TOKEN; local stub token has no external access.
 * CostSideEffects: Temporary model, project and MCP server; removed in finally.
 */
test("Agent uses a selected custom MCP server", { tag: "@mocked" }, async ({ page, journey }) => {
  await page.addInitScript(() => localStorage.setItem("science-agent-locale", "zh-CN"));
  const name = `Agent MCP ${Date.now()}`;
  const savedResponse = await page.request.post(`${apiBaseUrl()}/api/mcp/servers`, { headers: authorizationHeader(), data: {
    name, command: process.execPath, args: [fileURLToPath(new URL("./fixtures/mcp-echo.mjs", import.meta.url))], enabled: true,
  } });
  expect(savedResponse.ok()).toBe(true);
  const saved = await savedResponse.json() as { id: string };
  const toolsResponse = await page.request.get(`${apiBaseUrl()}/api/mcp/sources/${saved.id}/tools`, { headers: authorizationHeader() });
  expect(toolsResponse.ok()).toBe(true);
  const tools = await toolsResponse.json() as Array<{ id: string; mcpToolName: string }>;
  const tool = tools.find((item) => item.mcpToolName === "echo")!;
  const toolName = `mcp__${saved.id}__${tool.id}`;
  const stub = await scriptedModel([
    { tool: "tool_search", arguments: { query: `select:${toolName}` } },
    { tool: toolName, arguments: { text: "agent mcp verified" } },
    { text: "AGENT MCP VERIFIED" },
  ]);
  const fixture = await createProjectAndSession(page, {
    projectName: name, sessionTitle: "Agent MCP selection", approvalMode: "always_allow",
    model: { apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: `${name} model` },
  });
  journey.scenario({ goal: "An Agent can discover and execute the selected custom MCP tool", preconditions: ["Local MCP fixture connected", "Local scripted model", "No external calls"] });
  try {
    await journey.step("选择自定义 MCP", "输入区列出服务器名称，勾选后保存到当前 Session", async () => {
      await openProjectSession(page, fixture);
      await page.locator(".connector-picker-trigger").click();
      await page.locator(".connector-picker-popover").getByRole("checkbox", { name: new RegExp(name) }).click();
      await expect(page.locator(".connector-picker-popover").getByRole("checkbox", { name: new RegExp(name) })).toBeChecked();
      await page.keyboard.press("Escape");
    });
    await journey.step("Agent 发现并调用", "运行完成，保存成功的 MCP 调用记录，正文展示最终结果", async () => {
      const run = await sendUserMessage(page, fixture.session.id, "请用刚刚启用的本地 MCP echo 工具把 agent mcp verified 转成大写。");
      const terminal = await waitForRunTerminal(page, fixture.session.id, run.id, 60_000);
      expect(terminal.status, terminal.error).toBe("completed");
      const response = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture.session.id}/mcp/invocations`, { headers: authorizationHeader() });
      const invocations = await response.json() as Array<{ sourceId: string; status: string }>;
      expect(invocations.some((item) => item.sourceId === saved.id && item.status === "succeeded")).toBe(true);
      await expect(page.locator(".message").filter({ hasText: "AGENT MCP VERIFIED" }).last()).toBeVisible();
    });
  } finally {
    await cleanupJourney(page, fixture);
    await stub.stop();
    await page.request.delete(`${apiBaseUrl()}/api/mcp/servers/${saved.id}`, { headers: authorizationHeader() });
  }
});
