// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { createProjectAndSession, openProjectSession } from "./helpers/journeys.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";

test.use({ locale: "zh-CN", actionTimeout: 15_000 });

for (const field of ["env", "headers"] as const) {
  /**
   * E2E-META
   * Purpose: Edit saved MCP secret names without losing credentials.
   * Steps:
   *   1. Configure a credential-checked local MCP through the UI and verify discovery.
   *   2. Rename a saved key without a value, observe validation and cancel safely.
   *   3. Rename back, save, and verify the original credential still works.
   *   4. Rename and re-enter the value, refresh, and verify connection and Inspector.
   * Environment: Isolated API/Runner with its own ports and data directory.
   * Type: mocked
   * LLM: none.
   * WebSearch: none
   * PaperSources: none
   * MCP: Real SDK stdio or HTTP fixture; rejects missing synthetic credentials.
   * OtherExternal: none; endpoints are local.
   * Credentials: E2E_API_TOKEN and a fixed non-sensitive fixture credential.
   * CostSideEffects: Creates temporary Project/Session and MCP configuration; deletes in finally.
   */
  test(`Preserve MCP ${field} secrets while editing keys`, { tag: "@mocked" }, async ({ page, journey }) => {
    journey.scenario({ goal: "Correct a saved MCP key name without silently erasing its secret", preconditions: ["Isolated API and Runner available", "Local credential-checked MCP fixture"] });
    await page.addInitScript(() => localStorage.setItem("science-agent-locale", "zh-CN"));
    const fixture = await createProjectAndSession(page, { projectName: `Secret edit ${field} ${Date.now()}`, sessionTitle: "MCP secret editing" });
    const name = `Secret ${field} ${Date.now()}`;
    const label = field === "env" ? "环境变量" : "请求头";
    const oldKey = field === "env" ? "MCP_TEST_SECRET" : "Authorization";
    const newKey = field === "env" ? "MCP_TEST_RENAMED" : "authorization";
    const settings = page.getByRole("dialog", { name: "系统设置" }).locator(".mcp-settings");
    const row = settings.locator(".mcp-server").filter({ has: page.locator("strong", { hasText: name }) });
    const key = settings.getByLabel(`${label} 键 1`, { exact: true });
    const value = settings.getByLabel(`${label} 值 1`, { exact: true });
    const save = settings.getByRole("button", { name: "保存", exact: true });
    let child: ChildProcess | undefined;
    let port: number | undefined;
    let id: string | undefined;
    const edit = async () => row.getByRole("button", { name: `编辑服务器 ${name}`, exact: true }).click();
    const connectionWorks = async () => {
      await row.getByRole("button", { name: `测试连接 ${name}`, exact: true }).click();
      await expect(settings.getByRole("status")).toContainText("连接成功");
      await expect(row).toContainText("2 个工具");
    };
    try {
      if (field === "headers") {
        child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/mcp-echo.mjs", import.meta.url)), "--http", "0"], { env: { ...process.env, MCP_FIXTURE_AUTH: "Bearer fixture-only" }, stdio: ["ignore", "ignore", "pipe"] });
        port = await new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Local MCP startup timeout")), 10_000);
          child!.once("error", (error) => { clearTimeout(timer); reject(error); });
          child!.stderr!.once("data", (data) => { clearTimeout(timer); try { resolve(JSON.parse(String(data)).port); } catch (error) { reject(error); } });
        });
      }
      await openProjectSession(page, fixture);
      await journey.step("保存带凭据的 MCP", "本地服务校验模拟凭据并成功发现两个工具", async () => {
        await page.getByRole("button", { name: /^系统设置/ }).click();
        await page.getByRole("navigation", { name: "设置分组" }).getByRole("button", { name: /^MCP 服务器/ }).click();
        await settings.getByRole("button", { name: "添加服务器", exact: true }).click();
        await settings.getByLabel("名称", { exact: true }).fill(name);
        await settings.getByLabel("连接方式").selectOption(field === "env" ? "stdio" : "http");
        if (field === "env") {
          await settings.getByLabel("命令", { exact: true }).fill(process.execPath);
          await settings.getByLabel("参数", { exact: true }).fill(fileURLToPath(new URL("./fixtures/mcp-secret-echo.mjs", import.meta.url)));
        } else await settings.getByLabel("URL", { exact: true }).fill(`http://127.0.0.1:${port}/mcp`);
        await settings.getByRole("button", { name: "添加一项", exact: true }).click();
        await key.fill(oldKey);
        await value.fill("Bearer fixture-only");
        await settings.getByLabel("启用此 MCP 服务器", { exact: true }).check();
        await save.click();
        await row.getByRole("button", { name: `展开服务器 ${name}`, exact: true }).click();
        await connectionWorks();
        const servers = await (await page.request.get(`${apiBaseUrl()}/api/mcp/servers`, { headers: authorizationHeader() })).json();
        id = servers.find((item: { name: string }) => item.name === name).id;
      });
      await journey.step("改名未重填时阻止保存", "显示逐行提示，保存不清除旧配置，可取消编辑", async () => {
        await edit();
        await expect(value).toHaveAttribute("placeholder", "已保存的值");
        await key.fill(newKey);
        await save.click();
        await expect(settings.locator(".mcp-secret-error")).toContainText("请重新填写秘密值");
        expect(await value.evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(true);
        const saved = (await (await page.request.get(`${apiBaseUrl()}/api/mcp/servers`, { headers: authorizationHeader() })).json()).find((item: { id: string }) => item.id === id);
        expect(saved[field]).toEqual({ [oldKey]: null });
        for (const width of [390, 1440]) {
          await page.setViewportSize({ width, height: 900 });
          await settings.locator(".mcp-secret-error").scrollIntoViewIfNeeded();
          expect(await settings.locator(".mcp-secret-row").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        }
      });
      await journey.step("取消并恢复原键名", "取消后凭据仍可用，改回原名保存也不会覆盖秘密值", async () => {
        await settings.locator(".mcp-form-actions").getByRole("button", { name: "取消", exact: true }).click();
        await connectionWorks();
        await edit();
        await key.fill(newKey);
        await key.fill(oldKey);
        await expect(value).toHaveAttribute("placeholder", "已保存的值");
        await expect(settings.locator(".mcp-secret-error")).toHaveCount(0);
        await save.click();
        await connectionWorks();
      });
      await journey.step("重填后保存新键名", "清空重填值仍被阻止，填写后可保存，刷新后新配置可以调用工具", async () => {
        await edit();
        await key.fill(newKey);
        await value.fill("Bearer fixture-only");
        await value.fill("");
        await save.click();
        await expect(settings.locator(".mcp-secret-error")).toBeVisible();
        await value.fill("Bearer fixture-only");
        await save.click();
        await expect(row).toBeVisible();
        await page.reload();
        await row.getByRole("button", { name: `展开服务器 ${name}`, exact: true }).click();
        await connectionWorks();
        await edit();
        await expect(key).toHaveValue(newKey);
        await expect(value).toHaveAttribute("placeholder", "已保存的值");
        await settings.locator(".mcp-form-actions").getByRole("button", { name: "取消", exact: true }).click();
        await row.getByRole("button", { name: "MCP Inspector", exact: true }).click();
        await settings.getByLabel("工具", { exact: true }).selectOption("echo");
        await settings.getByLabel("调用参数（JSON）").fill('{"text":"secret retained"}');
        await settings.getByRole("button", { name: "执行工具", exact: true }).click();
        await expect(settings.getByRole("status")).toContainText("工具调用成功");
        await expect(settings.locator(".mcp-inspector-output")).toContainText("SECRET RETAINED");
      });
    } finally {
      const servers = await (await page.request.get(`${apiBaseUrl()}/api/mcp/servers`, { headers: authorizationHeader() })).json();
      for (const server of servers.filter((item: { name: string }) => item.name === name)) await page.request.delete(`${apiBaseUrl()}/api/mcp/servers/${server.id}`, { headers: authorizationHeader() });
      if (child && child.exitCode === null) {
        const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
        child.kill();
        await exited;
      }
      await page.request.delete(`${apiBaseUrl()}/api/projects/${fixture.project.id}`, { headers: authorizationHeader(), data: { confirmationId: fixture.project.id } });
    }
  });
}
