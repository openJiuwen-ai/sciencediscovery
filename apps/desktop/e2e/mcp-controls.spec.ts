// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { expect, test as base, type Page } from "@playwright/test";
import { createJourneyReporter, type JourneyReporter } from "../../../test/helpers/journey-report.ts";
import { installMockApi, TOKEN, TOKEN_STORAGE_KEY } from "./fixtures.js";
const test = base.extend<{ journey: JourneyReporter }>({ journey: async ({ page }, use, info) => {
  const reporter = createJourneyReporter(page, info); try { await use(reporter); } finally { await reporter.finalize(); }
} });
async function settings(page: Page, english = false) {
  await page.getByRole("button", { name: english ? "Settings" : "设置", exact: true }).click();
  const panel = page.getByRole("dialog", { name: english ? "Settings" : "设置", exact: true });
  await panel.getByRole("button", { name: english ? "MCP servers" : "MCP 服务器", exact: true }).click();
  return panel;
}
/**
 * E2E-META
 * Purpose: Keep keyboard commands, OAuth recovery and busy boundaries usable in the updated MCP catalog.
 * Steps:
 *   1. Open the card action menu and check keyboard boundaries and focus return.
 *   2. Read real configuration and tools in centered details.
 *   3. Recover a blocked authorization popup, cancel and clear authorization.
 *   4. Reject a pending connection test and recover its controls.
 * Environment: isolated desktop Vite with a stateful local API fixture.
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: in-memory configuration and discovery only
 * OtherExternal: none
 * Credentials: fixture token only
 * CostSideEffects: isolated browser records only
 */
test("MCP card menus and details keep keyboard, authorization recovery and busy actions usable", { tag: "@mocked" }, async ({ page, journey }) => {
  test.setTimeout(120_000);
  const id = "custom-menu-echo";
  const mock = await installMockApi(page, { mcpServers: [{ id, sourceId: id, name: "Menu Echo", description: "Menu fixture", transport: "http",
    command: "", args: [], cwd: "", url: "http://127.0.0.1:4625/mcp", env: {}, headers: {}, enabled: true, authMode: "oauth",
    authorization: { state: "required" }, status: "error", timeoutSeconds: 60, tools: [{ id: "echo", name: "echo" }] }] });
  await page.addInitScript(([key, token]) => { localStorage.setItem(key, token); window.open = () => null; }, [TOKEN_STORAGE_KEY, TOKEN]);
  await page.goto("/"); const panel = await settings(page);
  const card = panel.locator(".mcp-server-card").filter({ hasText: "Menu Echo" });
  const trigger = card.getByRole("button", { name: "Menu Echo的更多操作", exact: true });
  const menu = card.getByRole("menu", { name: "Menu Echo的更多操作", exact: true });
  const details = page.getByRole("dialog", { name: "服务器详情", exact: true });
  journey.scenario({ goal: "Use the new catalog without losing authorization recovery", preconditions: ["OAuth source and blocked popup"] });
  await journey.step("Use the action menu by keyboard", "Icons, first/last entry, wraparound and Escape preserve focus and the settings page.", async () => {
    await trigger.click();
    for (const name of ["去试试", "编辑", "删除"]) await expect(menu.getByRole("menuitem", { name, exact: true }).locator("svg")).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "删除", exact: true })).toHaveClass(/is-danger/);
    await trigger.focus(); await page.keyboard.press("ArrowUp");
    await expect(menu.getByRole("menuitem", { name: "删除", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowDown"); await expect(menu.getByRole("menuitem", { name: "去试试", exact: true })).toBeFocused();
    await trigger.focus(); await page.keyboard.press("ArrowDown"); await expect(menu.getByRole("menuitem", { name: "去试试", exact: true })).toBeFocused();
    await page.keyboard.press("End"); await expect(menu.getByRole("menuitem", { name: "删除", exact: true })).toBeFocused();
    await page.keyboard.press("Home"); await expect(menu.getByRole("menuitem", { name: "去试试", exact: true })).toBeFocused();
    await page.keyboard.press("Escape"); await expect(menu).toBeHidden(); await expect(trigger).toBeFocused(); await expect(panel).toBeVisible();
  });
  await journey.step("Read configuration and tools", "Centered details keep service enablement and defaults independent and expose the actual tool preview.", async () => {
    await card.getByRole("button", { name: "查看Menu Echo详情", exact: true }).click();
    await expect(details.getByText("echo", { exact: true })).toBeVisible();
    await expect(details.getByRole("switch", { name: "Menu Echo · 启用服务", exact: true })).toBeChecked();
    await expect(details.getByRole("switch", { name: "默认使用", exact: true })).not.toBeChecked();
    await expect(details).toContainText("http://127.0.0.1:4625/mcp");
  });
  await journey.step("Recover authorization", "A blocked popup retains a plain open-page action; pending authorization blocks restart while cancel and clear remain available.", async () => {
    let clearRequests = 0;
    await page.route(`**/api/mcp/servers/${id}/oauth/start`, async route => {
      mock.state.mcpServers[0].authorization = { state: "authorizing" };
      await route.fulfill({ json: { authorizationUrl: "https://provider.test/authorize", expiresAt: "2099-01-01T00:00:00Z" } });
    });
    for (const action of ["cancel", "clear"]) await page.route(`**/api/mcp/servers/${id}/oauth/${action}`, async route => {
      if (action === "clear") clearRequests += 1;
      mock.state.mcpServers[0].authorization = { state: "required" }; await route.fulfill({ json: { ok: true } });
    });
    await page.route(`**/api/mcp/servers/${id}/oauth/start`, route => route.fulfill({ status: 503, json: { error: "Authorization temporarily refused" } }), { times: 1 });
    await details.getByRole("button", { name: "授权", exact: true }).click();
    await expect(details.getByRole("alert")).toHaveText("Authorization temporarily refused");
    await expect(details.getByRole("alert")).toBeInViewport();
    await expect(details.getByRole("button", { name: "授权", exact: true })).toBeEnabled();
    await details.getByRole("button", { name: "授权", exact: true }).click();
    await expect(details.getByRole("button", { name: "授权", exact: true })).toBeDisabled();
    const fallback = details.getByRole("link", { name: "打开授权页面", exact: true });
    await expect(fallback).toHaveAttribute("href", "https://provider.test/authorize");
    await expect(fallback).toHaveAttribute("target", "_blank"); await expect(fallback).toHaveAttribute("rel", "noopener noreferrer");
    await expect(fallback).toHaveCSS("text-decoration-line", "none");
    await details.getByRole("button", { name: "取消授权", exact: true }).click();
    await expect(details.getByRole("button", { name: "授权", exact: true })).toBeEnabled();
    await page.route(`**/api/mcp/servers/${id}/oauth/clear`, route => route.fulfill({ status: 503, json: { error: "Clear temporarily refused" } }), { times: 1 });
    const clearAuthorization = details.getByRole("button", { name: "清除授权", exact: true });
    await clearAuthorization.click();
    await expect(details.getByRole("alert")).toHaveText("Clear temporarily refused");
    await expect(details.getByRole("alert")).toBeInViewport();
    await clearAuthorization.click();
    await expect.poll(() => clearRequests).toBe(1);
    await expect(clearAuthorization).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(details).toBeHidden();
  });
  await journey.step("Recover a refused connection test", "Both service and action controls are locked while the request is pending, then recover with the refusal visible.", async () => {
    let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route(`**/api/mcp/servers/${id}/test`, async route => { await pending; await route.fulfill({ status: 503, json: { error: "Test temporarily refused" } }); });
    await card.getByRole("button", { name: "测试", exact: true }).click();
    try { await expect(trigger).toBeDisabled(); await expect(card.getByRole("switch")).toBeDisabled(); } finally { release(); }
    await expect(panel.getByRole("alert")).toContainText("Test temporarily refused"); await expect(trigger).toBeEnabled(); await expect(card.getByRole("switch")).toBeEnabled();
  });
});
/**
 * E2E-META
 * Purpose: Persist matching service switches independently from defaults and preserve exact configuration.
 * Steps:
 *   1. Enable a server and read its edit state after reload.
 *   2. Save both enable states and verify the list follows.
 *   3. Choose a session default, refuse and retry enablement, cancel an edit.
 *   4. Open both add sources in the compact English layout.
 * Environment: isolated desktop Vite and a stateful local API fixture.
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: in-memory configuration only
 * OtherExternal: none
 * Credentials: fixture token only
 * CostSideEffects: isolated browser records only
 */
test("MCP service switches and edits stay synchronized while defaults remain independent", { tag: "@mocked" }, async ({ page, journey }) => {
  test.setTimeout(120_000);
  const id = "custom-control-echo"; const originalArgs = ["", "argument with spaces", "embedded\nnewline"];
  const mock = await installMockApi(page, { mcpServers: [{ id, sourceId: id, name: "Control Echo", description: "Local protocol fixture", transport: "stdio",
    command: "node", args: originalArgs, cwd: "", url: "", env: { STORED_TOKEN: null }, headers: {}, authMode: "headers", enabled: false,
    status: "disabled", timeoutSeconds: 60, checkedAt: "2026-11-25T00:00:00.000Z", tools: [{ name: "echo", id: "echo" }] }] });
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [TOKEN_STORAGE_KEY, TOKEN]);
  await page.goto("/"); let panel = await settings(page);
  const card = () => panel.locator(".mcp-server-card").filter({ hasText: "Control Echo" });
  const service = () => card().getByRole("switch", { name: "Control Echo · 启用服务", exact: true });
  const editor = page.getByRole("dialog", { name: "编辑服务器", exact: true });
  const details = page.getByRole("dialog", { name: "服务器详情", exact: true });
  const edit = async () => { await card().getByRole("button", { name: "Control Echo的更多操作" }).click(); await card().getByRole("menuitem", { name: "编辑", exact: true }).click(); };
  const defaultSwitch = details.getByRole("switch", { name: "默认使用", exact: true });
  const inspectDefaults = async (value: boolean) => {
    await card().getByRole("button", { name: "查看Control Echo详情" }).click();
    await expect(defaultSwitch).toHaveAttribute("aria-checked", String(value));
    await expect(defaultSwitch).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(details).toBeHidden();
  };
  journey.scenario({ goal: "Persist one consistent enable state while keeping defaults independent", preconditions: ["Disabled STDIO server with stored credentials and exact legacy arguments"] });
  await journey.step("Enable and reload", "Editing reflects saved enablement while arguments, secrets and defaults stay intact.", async () => {
    await expect(service()).not.toBeChecked(); await inspectDefaults(false);
    await service().click(); await expect(service()).toBeChecked();
    expect(mock.state.mcpServers[0]).toMatchObject({ enabled: true, args: originalArgs, env: { STORED_TOKEN: null } });
    await edit(); await expect(editor.getByRole("switch", { name: "启用服务", exact: true })).toBeChecked();
    await editor.getByRole("button", { name: "取消", exact: true }).click(); await page.reload(); panel = await settings(page);
    await expect(service()).toBeChecked(); await inspectDefaults(false);
    expect(mock.calls.filter(c => c.method === "PUT" && c.path === "/api/settings")).toHaveLength(0);
  });
  await journey.step("Save both edit states", "The outer switch follows each persisted form value while defaults remain unselected.", async () => {
    for (const enabled of [false, true]) {
      await edit(); await editor.getByRole("switch", { name: "启用服务", exact: true }).setChecked(enabled);
      await editor.getByRole("button", { name: "保存", exact: true }).click(); await expect(editor).toBeHidden();
      await expect(service()).toHaveAttribute("aria-checked", String(enabled));
      if (!enabled) await expect(card().getByText("已停用", { exact: true })).toBeVisible();
      await inspectDefaults(false);
    }
  });
  await journey.step("Recover a refusal and cancel a draft", "Default selection neither enables the service nor changes on refused service writes; retry persists and cancellation discards the edit.", async () => {
    await card().getByRole("button", { name: "查看Control Echo详情" }).click();
    await defaultSwitch.click();
    await expect(defaultSwitch).toBeChecked();
    await expect(defaultSwitch).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(details).toBeHidden();
    await service().click(); await expect(service()).not.toBeChecked(); await inspectDefaults(true);
    await page.route(`**/api/mcp/servers/${id}`, route => route.fulfill({ status: 503, json: { error: "Enable temporarily refused" } }), { times: 1 });
    await service().click(); await expect(panel.getByRole("alert")).toContainText("Enable temporarily refused"); await expect(service()).not.toBeChecked(); await inspectDefaults(true);
    await edit(); await expect(editor.getByRole("switch", { name: "启用服务", exact: true })).not.toBeChecked(); await editor.getByRole("button", { name: "取消", exact: true }).click();
    await service().click(); await expect(service()).toBeChecked(); await edit();
    await editor.getByRole("switch", { name: "启用服务", exact: true }).uncheck(); await editor.getByRole("button", { name: "取消", exact: true }).click();
    await expect(service()).toBeChecked(); expect(mock.state.mcpServers[0]).toMatchObject({ enabled: true, args: originalArgs, env: { STORED_TOKEN: null } });
  });
  await journey.step("Open both add sources in English", "The black Add dropdown opens the same centered editable form for manual or JSON entry without writing a server.", async () => {
    await page.setViewportSize({ width: 960, height: 720 }); await page.evaluate(() => localStorage.setItem("sciencediscovery-desktop:locale", "en")); await page.reload(); panel = await settings(page, true);
    const add = panel.getByRole("button", { name: "Add MCP server", exact: true }); await expect(add).toHaveCSS("background-color", "rgb(25, 25, 25)");
    await add.click(); await panel.getByRole("menuitem", { name: "Manual entry", exact: true }).click();
    const form = page.getByRole("dialog", { name: "New MCP server", exact: true }); await expect(form).toBeVisible(); await form.getByRole("button", { name: "Cancel", exact: true }).click();
    await add.click(); await panel.getByRole("menuitem", { name: "Import JSON", exact: true }).click();
    await expect(form.getByRole("button", { name: "Upload JSON file", exact: true })).toBeVisible(); await form.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(mock.calls.some(c => c.method === "POST" && ["/api/mcp/servers", "/api/mcp/servers/import"].includes(c.path))).toBe(false);
  });
});
