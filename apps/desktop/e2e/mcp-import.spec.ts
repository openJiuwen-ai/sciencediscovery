// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/**
 * E2E-META
 * Purpose: Exercise MCP server JSON paste and file import through the Desktop settings UI.
 * Steps:
 *   1. Open MCP settings and exercise the import menu and keyboard dismissal.
 *   2. Preview valid and invalid JSON through both paste and file upload paths.
 * Environment: Isolated Desktop Vite app with deterministic local API mocks.
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: in-memory MCP configuration only
 * OtherExternal: none
 * Credentials: fixture access token only
 * CostSideEffects: isolated browser state only
 */
import { expect, test as base, type Page } from "@playwright/test";
import { createJourneyReporter, type JourneyReporter } from "../../../test/helpers/journey-report.ts";
import { installMockApi, TOKEN, TOKEN_STORAGE_KEY } from "./fixtures.js";

const test = base.extend<{ journey: JourneyReporter }>({
  journey: async ({ page }, use, info) => {
    const reporter = createJourneyReporter(page, info);
    try { await use(reporter); } finally { await reporter.finalize(); }
  },
});

async function openMcp(page: Page) {
  await page.addInitScript(([key, token]) => localStorage.setItem(key, token), [TOKEN_STORAGE_KEY, TOKEN]);
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await settings.getByRole("button", { name: "MCP 服务器", exact: true }).click();
  return settings;
}

async function upload(page: Page, content: string) {
  await page.getByRole("button", { name: "添加服务器", exact: true }).click();
  await page.getByRole("menuitem", { name: "导入 JSON", exact: true }).click();
  const form = page.getByRole("dialog", { name: "导入 MCP 服务器", exact: true });
  const chooser = page.waitForEvent("filechooser");
  await form.getByRole("button", { name: "上传 JSON 文件", exact: true }).click();
  await (await chooser).setFiles({ name: "mcp-servers.json", mimeType: "application/json", buffer: Buffer.from(content) });
  return page.getByRole("dialog", { name: "导入 MCP 服务器", exact: true });
}

test.describe("MCP 服务器 JSON 导入", () => {
  /**
   * E2E-META
   * Purpose: Keep manual JSON paste available behind the import menu.
   * Steps: Open and dismiss the menu with the keyboard; paste and preview; cancel and reopen.
   * Environment: desktop Vite with Mock API.
   * Type: mocked
   * LLM: none
   * WebSearch: none
   * PaperSources: none
   * MCP: in-memory configuration only
   * OtherExternal: none
   * Credentials: fixture access token only
   * CostSideEffects: isolated browser state only
   */
  test("paste remains editable and keyboard dismissal keeps settings open", { tag: "@mocked" }, async ({ page, journey }) => {
    const mock = await installMockApi(page);
    const settings = await openMcp(page);
    const trigger = settings.getByRole("button", { name: "添加服务器", exact: true });
    const menu = settings.getByRole("menu", { name: "添加服务器", exact: true });
    journey.scenario({ goal: "Paste JSON without importing on navigation", preconditions: ["Empty custom MCP list"] });
    await journey.step("Open and dismiss the import menu", "Arrow keys reach both sources and Escape closes only the menu.", async () => {
      await trigger.focus();
      await page.keyboard.press("ArrowDown");
      await expect(menu.getByRole("menuitem", { name: "手动填写" })).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(menu.getByRole("menuitem", { name: "导入 JSON" })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect(settings).toBeVisible();
      await expect(trigger).toBeFocused();
    });
    await journey.step("Paste, preview and discard JSON", "The old card remains available and cancellation writes nothing.", async () => {
      await trigger.click();
      await menu.getByRole("menuitem", { name: "导入 JSON" }).click();
      const form = page.getByRole("dialog", { name: "导入 MCP 服务器", exact: true });
      await form.getByRole("textbox", { name: "JSON", exact: true }).fill(JSON.stringify({ mcpServers: { Pasted: { command: "node" } } }));
      await form.getByRole("button", { name: "预览", exact: true }).click();
      await expect(form.getByRole("list", { name: "预览", exact: true })).toContainText("Pasted");
      await form.getByRole("button", { name: "取消", exact: true }).click();
      await trigger.click();
      await menu.getByRole("menuitem", { name: "导入 JSON" }).click();
      await expect(form.getByRole("textbox", { name: "JSON", exact: true })).toHaveValue("");
      await form.getByRole("button", { name: "取消", exact: true }).click();
      expect(mock.calls.filter((call) => call.path === "/api/mcp/servers/import")).toHaveLength(0);
    });
    await journey.step("Cancel file selection", "An empty selection keeps the import dialog unchanged and writes nothing.", async () => {
      await trigger.click();
      await menu.getByRole("menuitem", { name: "导入 JSON" }).click();
      const form = page.getByRole("dialog", { name: "导入 MCP 服务器", exact: true });
      const chooser = page.waitForEvent("filechooser");
      await form.getByRole("button", { name: "上传 JSON 文件", exact: true }).click();
      await (await chooser).setFiles([]);
      await expect(form).toBeVisible();
      await expect(form.getByRole("textbox", { name: "JSON", exact: true })).toHaveValue("");
      await form.getByRole("button", { name: "取消", exact: true }).click();
      await expect(settings).toBeVisible();
      expect(mock.calls.filter((call) => call.path === "/api/mcp/servers/import")).toHaveLength(0);
    });
  });

  /**
   * E2E-META
   * Purpose: Fill the import card from a file and preserve individual outcomes.
   * Steps: Upload a BOM-prefixed configuration; inspect automatic preview; import and inspect successful and refused entries.
   * Environment: desktop Vite with Mock API.
   * Type: mocked
   * LLM: none
   * WebSearch: none
   * PaperSources: none
   * MCP: fixture configuration only
   * OtherExternal: none
   * Credentials: fixture access token only
   * CostSideEffects: isolated in-memory custom servers
   */
  test("a file fills and previews automatically, then reports per-server results", { tag: "@mocked" }, async ({ page, journey }) => {
    const mock = await installMockApi(page);
    const settings = await openMcp(page);
    const echo = { command: "node", args: ["/srv/my MCP/echo.mjs", "--quiet"], env: { LABEL: "a b" } };
    const json = JSON.stringify({ mcpServers: { "File Echo": echo, Refused: { url: "https://mcp.example.test/mcp" } } });
    let form = page.getByRole("dialog", { name: "导入 MCP 服务器", exact: true });
    journey.scenario({ goal: "Import configurations without typing JSON", preconditions: ["Empty MCP list", "A local JSON file"] });
    await journey.step("Choose a JSON file", "Its content and both server previews are filled automatically; no server is saved yet.", async () => {
      form = await upload(page, `\uFEFF${json}`);
      await expect(form.getByRole("textbox", { name: "JSON", exact: true })).toHaveValue(json);
      const editorBounds = await form.getByRole("textbox", { name: "JSON", exact: true }).boundingBox();
      const formBounds = await form.boundingBox();
      expect(editorBounds?.width).toBeGreaterThan((formBounds?.width ?? Infinity) * 0.8);
      await expect(form.getByRole("list", { name: "预览", exact: true })).toContainText("File Echo");
      await expect(form.getByRole("list", { name: "预览", exact: true })).toContainText("Refused");
      await expect(form).toContainText("mcp-servers.json");
      expect(mock.state.mcpServers).toHaveLength(0);
    });
    await journey.step("Confirm the import", "A successful server is disabled and preserves its arguments; a refused entry reports its own error.", async () => {
      await page.route("**/api/mcp/servers/import", async (route) => {
        const data = route.request().postDataJSON();
        if (data.mcpServers.Refused) await route.fulfill({ status: 409, json: { error: "Server already exists" } });
        else await route.fallback();
      });
      await form.getByRole("button", { name: "开始导入", exact: true }).click();
      const results = form.getByRole("list", { name: "导入结果", exact: true });
      await expect(results).toContainText("File Echo");
      await expect(results).toContainText("Server already exists");
      expect(mock.state.mcpServers).toHaveLength(1);
      expect(mock.state.mcpServers[0]).toMatchObject({ name: "File Echo", enabled: false, ...echo });
      await form.getByRole("button", { name: "取消", exact: true }).click();
      await expect(settings.locator(".settings-card").filter({ hasText: "File Echo" })).toBeVisible();
    });
  });

  /**
   * E2E-META
   * Purpose: Recover from an invalid JSON file without writing configuration.
   * Steps: Upload malformed JSON; inspect the error; select the same filename with valid JSON and confirm its preview.
   * Environment: desktop Vite with Mock API.
   * Type: mocked
   * LLM: none
   * WebSearch: none
   * PaperSources: none
   * MCP: in-memory configuration only
   * OtherExternal: none
   * Credentials: fixture access token only
   * CostSideEffects: isolated browser state only
   */
  test("an invalid file shows an error and the same filename can be selected again", { tag: "@mocked" }, async ({ page, journey }) => {
    const mock = await installMockApi(page);
    await openMcp(page);
    journey.scenario({ goal: "Correct an invalid import file", preconditions: ["Malformed JSON"] });
    await journey.step("Read an invalid file", "The import card explains the error and cannot submit it.", async () => {
      const form = await upload(page, "{");
      await expect(form.getByRole("alert")).toContainText("有效的 JSON");
      await expect(form.getByRole("button", { name: "开始导入", exact: true })).toBeDisabled();
      await expect(page.getByRole("dialog", { name: "设置", exact: true }).locator('input[type="file"]')).toHaveValue("");
      await form.getByRole("button", { name: "取消", exact: true }).click();
    });
    await journey.step("Select the corrected file", "The same filename can load a valid preview and still requires confirmation.", async () => {
      const form = await upload(page, JSON.stringify({ mcpServers: { Corrected: { command: "node" } } }));
      await expect(form.getByRole("list", { name: "预览", exact: true })).toContainText("Corrected");
      await expect(form.getByRole("alert")).toHaveCount(0);
      expect(mock.calls.filter((call) => call.path === "/api/mcp/servers/import")).toHaveLength(0);
    });
  });
});
