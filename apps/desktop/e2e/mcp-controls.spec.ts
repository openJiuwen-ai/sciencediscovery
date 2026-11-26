// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/**
 * E2E-META
 * Purpose: Keep MCP service enablement consistent across the list and edit form, with independent defaults.
 * Steps:
 *   1. Enable a disabled server from the list and verify its saved edit state after reload.
 *   2. Disable and enable from the edit form and verify the list follows each save.
 *   3. Select the session default independently, reject a service write, retry and cancel an edit.
 *   4. Check the two add sources in a smaller English window.
 *   5. Use the shared row menu with hover and keyboard, then recover a blocked OAuth popup and a refused test.
 * Environment: isolated desktop Vite with deterministic API state and one refused write.
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: in-memory configuration only
 * OtherExternal: none
 * Credentials: local fixture token only
 * CostSideEffects: isolated browser records only
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

test("MCP row menus keep keyboard, authorization recovery and busy actions usable", { tag: "@mocked" }, async ({ page, journey }) => {
  test.setTimeout(120_000);
  const id = "custom-menu-echo";
  const mock = await installMockApi(page, { mcpServers: [{
    id, sourceId: id, name: "Menu Echo", description: "Menu fixture", transport: "http",
    command: "", args: [], cwd: "", url: "http://127.0.0.1:4625/mcp", env: {}, headers: {},
    enabled: true, authMode: "oauth", authorization: { state: "required" },
    status: "error", timeoutSeconds: 60, tools: [{ id: "echo", name: "echo" }],
  }] });
  await page.addInitScript(([key, token]) => { localStorage.setItem(key, token); window.open = () => null; }, [TOKEN_STORAGE_KEY, TOKEN]);
  await page.goto("/");
  const panel = await settings(page);
  const card = panel.locator(".settings-card").filter({ hasText: "Menu Echo" });
  const trigger = card.getByRole("button", { name: "Menu Echo的操作", exact: true });
  const menu = card.getByRole("menu", { name: "Menu Echo的操作", exact: true });
  journey.scenario({ goal: "Use the compact Skills-style MCP action menu without losing recovery actions", preconditions: ["An OAuth server and a blocked popup"] });
  await journey.step("Open the shared menu and dismiss it", "Hover reveals icon actions; Escape returns focus while keeping settings open.", async () => {
    await trigger.hover();
    await expect(menu).toBeVisible();
    for (const name of ["工具", "测试", "编辑", "删除"]) {
      await expect(menu.getByRole("menuitem", { name, exact: true }).locator("svg")).toBeVisible();
    }
    await expect(menu.getByRole("menuitem", { name: "删除", exact: true })).toHaveClass(/is-danger/);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden(); await expect(trigger).toBeFocused(); await expect(panel).toBeVisible();
  });
  await journey.step("Navigate the menu by keyboard", "Arrow keys and Home/End reach each command; choosing Tools keeps the enabled service and default choice unchanged.", async () => {
    await trigger.click();
    await expect(trigger).toBeFocused();
    await trigger.press("ArrowUp");
    await expect(menu.getByRole("menuitem", { name: "删除", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await trigger.click();
    await expect(trigger).toBeFocused();
    await trigger.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: "工具", exact: true })).toBeFocused();
    await page.keyboard.press("End"); await expect(menu.getByRole("menuitem", { name: "删除", exact: true })).toBeFocused();
    await page.keyboard.press("Home"); await page.keyboard.press("Enter");
    await expect(menu).toBeHidden(); await expect(card.getByText("echo", { exact: true })).toBeVisible();
    await expect(card.getByRole("switch")).toBeChecked(); await expect(card.getByRole("checkbox")).not.toBeChecked();
  });
  await journey.step("Recover authorization through the menu", "A blocked popup retains its open-page fallback; pending authorization disables restart, and cancel and clear remain available.", async () => {
    let clearRequests = 0;
    await page.route(`**/api/mcp/servers/${id}/oauth/start`, async route => {
      mock.state.mcpServers[0].authorization = { state: "authorizing" };
      await route.fulfill({ json: { authorizationUrl: "https://provider.test/authorize", expiresAt: "2099-01-01T00:00:00Z" } });
    });
    for (const action of ["cancel", "clear"]) await page.route(`**/api/mcp/servers/${id}/oauth/${action}`, async route => {
      if (action === "clear") clearRequests += 1;
      mock.state.mcpServers[0].authorization = { state: "required" };
      await route.fulfill({ json: { ok: true } });
    });
    await trigger.click(); await menu.getByRole("menuitem", { name: "授权", exact: true }).click();
    await expect.poll(() => (mock.state.mcpServers[0].authorization as { state: string }).state).toBe("authorizing");
    await expect(trigger).toBeEnabled(); await trigger.click();
    await expect(menu.getByRole("menuitem", { name: "授权", exact: true })).toBeDisabled();
    await expect(menu.getByRole("menuitem", { name: "打开授权页面", exact: true })).toHaveAttribute("href", "https://provider.test/authorize");
    await expect(menu.getByRole("menuitem", { name: "打开授权页面", exact: true })).toHaveCSS("text-decoration-line", "none");
    await expect(menu.getByRole("menuitem", { name: "打开授权页面", exact: true })).toHaveAttribute("target", "_blank");
    await expect(menu.getByRole("menuitem", { name: "打开授权页面", exact: true })).toHaveAttribute("rel", "noopener noreferrer");
    await menu.getByRole("menuitem", { name: "取消授权", exact: true }).click();
    await expect.poll(() => (mock.state.mcpServers[0].authorization as { state: string }).state).toBe("required");
    await expect(trigger).toBeEnabled(); await trigger.click();
    await menu.getByRole("menuitem", { name: "清除授权", exact: true }).click();
    await expect.poll(() => clearRequests).toBe(1);
  });
  await journey.step("Recover a refused connection test", "The menu and enable switch are disabled while testing, then available again with the failure visible.", async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route(`**/api/mcp/servers/${id}/test`, async route => {
      await pending; await route.fulfill({ status: 503, json: { error: "Test temporarily refused" } });
    });
    await expect(trigger).toBeEnabled(); await trigger.click();
    await menu.getByRole("menuitem", { name: "测试", exact: true }).click();
    await expect(trigger).toBeDisabled(); await expect(card.getByRole("switch")).toBeDisabled();
    release();
    await expect(panel.getByRole("alert")).toContainText("Test temporarily refused");
    await expect(trigger).toBeEnabled(); await expect(card.getByRole("switch")).toBeEnabled();
  });
});

async function settings(page: Page, english = false) {
  await page.getByRole("button", { name: english ? "Settings" : "设置", exact: true }).click();
  const panel = page.getByRole("dialog", { name: english ? "Settings" : "设置", exact: true });
  await panel.getByRole("button", { name: english ? "MCP servers" : "MCP 服务器", exact: true }).click();
  return panel;
}

test("service switches and edits stay synchronized while defaults remain independent", { tag: "@mocked" }, async ({ page, journey }) => {
  test.setTimeout(120_000);
  const id = "custom-control-echo";
  const originalArgs = ["", "argument with spaces", "embedded\nnewline"];
  const mock = await installMockApi(page, { mcpServers: [{
    id, sourceId: id, name: "Control Echo", description: "Local protocol fixture", transport: "stdio",
    command: "node", args: originalArgs, cwd: "", url: "", env: { STORED_TOKEN: null }, headers: {},
    authMode: "headers", enabled: false, status: "disabled", timeoutSeconds: 60,
    checkedAt: "2026-11-25T00:00:00.000Z", tools: [{ name: "echo", id: "echo" }],
  }] });
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [TOKEN_STORAGE_KEY, TOKEN]);
  await page.goto("/");
  let panel = await settings(page);
  const card = () => panel.locator(".settings-card").filter({ hasText: "Control Echo" });
  const service = () => card().getByRole("switch", { name: "Control Echo · 启用服务", exact: true });
  const defaults = () => card().getByRole("checkbox", { name: "Control Echo · 默认使用", exact: true });
  const editor = page.getByRole("dialog", { name: "编辑服务器", exact: true });
  journey.scenario({ goal: "Use one consistent service enable control without changing session defaults", preconditions: ["A disabled custom STDIO server with stored secrets and exact arguments"] });

  await journey.step("Enable from the list and reload", "The edit checkbox reads the same saved value, without selecting a default or losing credentials.", async () => {
    await expect(service()).not.toBeChecked(); await expect(defaults()).not.toBeChecked();
    await service().click(); await expect(service()).toBeChecked();
    expect(mock.state.mcpServers[0]).toMatchObject({ enabled: true, args: originalArgs, env: { STORED_TOKEN: null } });
    await card().locator(".skill-row-menu-trigger").click();
    await card().getByRole("menuitem", { name: "编辑", exact: true }).click();
    await expect(editor.getByRole("checkbox", { name: "启用服务", exact: true })).toBeChecked();
    await editor.getByRole("button", { name: "取消", exact: true }).click();
    await page.reload(); panel = await settings(page);
    await expect(service()).toBeChecked(); await expect(defaults()).not.toBeChecked();
    expect(mock.calls.filter(c => c.method === "PUT" && c.path === "/api/settings")).toHaveLength(0);
  });
  await journey.step("Save both edit states", "Each successful save is reflected in the outer switch and disabled badge.", async () => {
    for (const enabled of [false, true]) {
      await card().locator(".skill-row-menu-trigger").click();
      await card().getByRole("menuitem", { name: "编辑", exact: true }).click();
      await editor.getByRole("checkbox", { name: "启用服务", exact: true }).setChecked(enabled);
      await editor.getByRole("button", { name: "保存", exact: true }).click();
      await expect(editor).toBeHidden();
      if (enabled) await expect(service()).toBeChecked();
      else { await expect(service()).not.toBeChecked(); await expect(card().getByText("已停用", { exact: true })).toBeVisible(); }
      await expect(defaults()).not.toBeChecked();
    }
  });
  await journey.step("Keep defaults separate and recover a refused enable", "A refused write leaves both views unchanged; retry succeeds and a cancelled draft never changes the list.", async () => {
    await defaults().click(); await expect(defaults()).toBeChecked();
    await service().click(); await expect(service()).not.toBeChecked();
    await expect(defaults()).toBeChecked();
    await page.route(`**/api/mcp/servers/${id}`, route => route.fulfill({ status: 503, json: { error: "Enable temporarily refused" } }), { times: 1 });
    await service().click();
    await expect(panel.getByRole("alert")).toContainText("Enable temporarily refused");
    await expect(service()).not.toBeChecked(); await expect(defaults()).toBeChecked();
    await card().locator(".skill-row-menu-trigger").click();
    await card().getByRole("menuitem", { name: "编辑", exact: true }).click();
    await expect(editor.getByRole("checkbox", { name: "启用服务", exact: true })).not.toBeChecked();
    await editor.getByRole("button", { name: "取消", exact: true }).click();
    await service().click(); await expect(service()).toBeChecked();
    await card().locator(".skill-row-menu-trigger").click();
    await card().getByRole("menuitem", { name: "编辑", exact: true }).click();
    await editor.getByRole("checkbox", { name: "启用服务", exact: true }).uncheck();
    await editor.getByRole("button", { name: "取消", exact: true }).click();
    await expect(service()).toBeChecked();
    expect(mock.state.mcpServers[0]).toMatchObject({ enabled: true, args: originalArgs, env: { STORED_TOKEN: null } });
  });
  await journey.step("Use the compact English add menu", "A dark header action opens the two distinct existing dialogs without creating records.", async () => {
    await page.setViewportSize({ width: 960, height: 720 });
    await page.evaluate(() => localStorage.setItem("sciencediscovery-desktop:locale", "en"));
    await page.reload(); panel = await settings(page, true);
    const information = card().locator(".settings-card-main");
    await expect.poll(() => information.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    const header = panel.locator(".settings-detail-header");
    const trigger = header.getByRole("button", { name: "Add server", exact: true });
    await expect(trigger).toHaveClass(/is-dark/);
    await trigger.click(); await panel.getByRole("menuitem", { name: "Manual entry", exact: true }).click();
    const manual = page.getByRole("dialog", { name: "New server", exact: true });
    await expect(manual).toBeVisible(); await manual.getByRole("button", { name: "Cancel", exact: true }).click();
    await trigger.click(); await panel.getByRole("menuitem", { name: "Import JSON", exact: true }).click();
    const importer = page.getByRole("dialog", { name: "Import MCP servers", exact: true });
    await expect(importer.getByRole("button", { name: "Upload JSON file", exact: true })).toBeVisible();
    await importer.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(mock.calls.some(c => c.method === "POST" && ["/api/mcp/servers", "/api/mcp/servers/import"].includes(c.path))).toBe(false);
  });
});
