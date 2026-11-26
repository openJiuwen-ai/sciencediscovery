// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/**
 * E2E-META
 * Purpose: Review and create MCP servers through one manual/JSON-prefilled drawer.
 * Steps:
 *   1. Open the Add menu and choose manual or JSON-prefilled configuration.
 *   2. Review and edit fields without writing before confirmation.
 *   3. Confirm creation and recover invalid or partial outcomes without duplication.
 * Environment: isolated desktop Vite entry with deterministic local API fixtures.
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: in-memory configuration and discovery responses
 * OtherExternal: none
 * Credentials: fixture token only
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

/**
 * E2E-META
 * Purpose: Edit JSON incrementally without moving the caret into a server name.
 * Steps:
 *   1. Type a valid JSON configuration one character at a time.
 *   2. Continue editing valid JSON and check focus and the filled name.
 *   3. Confirm once and inspect the saved configuration.
 * Environment: isolated desktop Vite and stateful local API fixture.
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: in-memory configuration only
 * OtherExternal: none
 * Credentials: fixture token only
 * CostSideEffects: isolated browser records only
 */
test("MCP 服务器 JSON typing preserves its caret after every valid parse", { tag: "@mocked" }, async ({ page, journey }) => {
  test.setTimeout(90_000);
  const mock = await installMockApi(page);
  await openMcp(page);
  const form = await openJson(page);
  const source = form.getByLabel("JSON", { exact: true });
  const json = JSON.stringify({ mcpServers: { A: { command: "node" } } });
  journey.scenario({ goal: "Edit JSON without corrupting the filled server name", preconditions: ["Empty MCP list"] });
  await journey.step("Type a complete configuration", "A successful parse fills the name while the JSON editor keeps focus.", async () => {
    await source.click();
    await source.pressSequentially(json);
    await expect(source).toBeFocused();
    await expect(form.getByLabel("名称", { exact: true })).toHaveValue("A");
  });
  await journey.step("Continue editing valid JSON", "Additional keystrokes stay in JSON and never become part of the server name or trigger a write.", async () => {
    await source.pressSequentially("  ");
    await expect(source).toBeFocused();
    await expect(source).toHaveValue(json + "  ");
    await expect(form.getByLabel("名称", { exact: true })).toHaveValue("A");
    expect(mock.calls.filter(call => call.method === "POST" && call.path === "/api/mcp/servers")).toHaveLength(0);
  });
  await journey.step("Confirm the unchanged configuration", "Only confirmation saves the original name, once.", async () => {
    await form.getByRole("button", { name: "确认添加", exact: true }).click();
    await expect(form).toBeHidden();
    expect(mock.state.mcpServers.map(server => server.name)).toEqual(["A"]);
    expect(mock.calls.filter(call => call.method === "POST" && call.path === "/api/mcp/servers")).toHaveLength(1);
  });
});
async function openMcp(page: Page) {
  await page.addInitScript(([key, token]) => {
    localStorage.setItem(key, token);
    localStorage.setItem("sciencediscovery-desktop:locale", "zh-CN");
  }, [TOKEN_STORAGE_KEY, TOKEN]);
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await settings.getByRole("button", { name: "MCP 服务器", exact: true }).click();
  return settings;
}
async function openJson(page: Page) {
  await page.getByRole("button", { name: "新增 MCP 服务器", exact: true }).click();
  await page.getByRole("menuitem", { name: "导入 JSON", exact: true }).click();
  return page.getByRole("dialog", { name: "新增 MCP 服务器", exact: true });
}
async function upload(page: Page, content: string) {
  const drawer = page.getByRole("dialog", { name: "新增 MCP 服务器", exact: true });
  const chooser = page.waitForEvent("filechooser");
  await drawer.getByRole("button", { name: "上传 JSON 文件", exact: true }).click();
  await (await chooser).setFiles({ name: "servers.json", mimeType: "application/json", buffer: Buffer.from(content) });
}

test.describe("MCP 服务器 JSON 导入", () => {
  /**
   * E2E-META
   * Purpose: Manual and JSON sources use one editable create drawer and confirmation.
   * Steps:
   *   1. Use the Add menu by keyboard and cancel a manual draft.
   *   2. Paste JSON and edit its prefilled fields without saving.
   *   3. Confirm once and inspect the saved configuration.
   * Environment: isolated desktop Vite and deterministic API fixture.
   * Type: mocked
   * LLM: none
   * WebSearch: none
   * PaperSources: none
   * MCP: in-memory configuration and check results
   * OtherExternal: none
   * Credentials: fixture token only
   * CostSideEffects: isolated browser records only
   */
  test("one Add menu opens the same drawer for manual and JSON configuration", { tag: "@mocked" }, async ({ page, journey }) => {
    test.setTimeout(90_000);
    const mock = await installMockApi(page);
    const settings = await openMcp(page);
    const add = settings.getByRole("button", { name: "新增 MCP 服务器", exact: true });
    const drawer = page.getByRole("dialog", { name: "新增 MCP 服务器", exact: true });
    journey.scenario({ goal: "Add an edited JSON configuration through the normal form", preconditions: ["Empty MCP list"] });
    await journey.step("Use the single Add entry point", "The menu offers manual and JSON entry; Escape preserves settings and returns focus.", async () => {
      await expect(settings.getByRole("button", { name: "导入", exact: true })).toHaveCount(0);
      await add.focus(); await page.keyboard.press("ArrowDown");
      await expect(settings.getByRole("menuitem", { name: "手动填写", exact: true })).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(settings.getByRole("menuitem", { name: "导入 JSON", exact: true })).toBeFocused();
      await page.keyboard.press("Escape"); await expect(add).toBeFocused();
      await add.click(); await settings.getByRole("menuitem", { name: "手动填写", exact: true }).click();
      await expect(drawer).not.toHaveClass(/is-drawer/);
      await expect(drawer.getByLabel("名称", { exact: true })).toHaveValue("");
      await expect(drawer.getByLabel("传输方式", { exact: true })).toHaveValue("http");
      await expect(drawer.getByRole("spinbutton")).toHaveValue("60");
      await expect(drawer.getByRole("switch", { name: "启用服务", exact: true })).not.toBeChecked();
      await drawer.getByRole("button", { name: "取消", exact: true }).click();
    });
    await journey.step("Prefill and edit without saving", "JSON populates actual form fields, which can be changed before the only confirmation.", async () => {
      await openJson(page); await expect(drawer).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(drawer.getByRole("button", { name: "取消", exact: true })).toBeFocused();
      await drawer.getByLabel("JSON", { exact: true }).fill(JSON.stringify({ mcpServers: { Pasted: { type: "sse", url: "https://example.test/sse", headers: { "X-Test": "fixture" } } } }));
      await expect(drawer.getByLabel("名称", { exact: true })).toHaveValue("Pasted");
      await expect(drawer.getByLabel("传输方式", { exact: true })).toHaveValue("sse");
      await drawer.getByLabel("名称", { exact: true }).fill("Edited MCP");
      await drawer.getByLabel("地址", { exact: true }).fill("https://example.test/edited");
      await drawer.getByRole("spinbutton").fill("75");
      await expect(drawer.getByRole("button", { name: "预览", exact: true })).toHaveCount(0);
      expect(mock.calls.filter((call) => call.method === "POST" && call.path.startsWith("/api/mcp/"))).toHaveLength(0);
    });
    await journey.step("Confirm through ordinary creation", "One save creates the edited record, closes the drawer, and performs no separate import request or Done step.", async () => {
      await drawer.getByRole("button", { name: "确认添加", exact: true }).click();
      await expect(drawer).toBeHidden();
      await expect(settings.locator(".mcp-server-card").filter({ hasText: "Edited MCP" })).toBeVisible();
      const writes = mock.calls.filter((call) => call.method === "POST" && call.path === "/api/mcp/servers");
      expect(writes).toHaveLength(1);
      expect(JSON.parse(writes[0]!.body!)).toMatchObject({ name: "Edited MCP", transport: "sse", url: "https://example.test/edited", timeoutSeconds: 75, headers: { "X-Test": "fixture" }, enabled: false });
      expect(mock.calls.some((call) => call.path === "/api/mcp/servers/import")).toBe(false);
    });
  });

  /**
   * E2E-META
   * Purpose: Review multiple file-derived configurations in the same form without losing edits.
   * Steps:
   *   1. Upload a BOM JSON file and edit both independent configurations.
   *   2. Confirm once and inspect the saved arguments, secrets and defaults.
   * Environment: isolated desktop Vite and deterministic API fixture.
   * Type: mocked
   * LLM: none
   * WebSearch: none
   * PaperSources: none
   * MCP: in-memory configuration only
   * OtherExternal: none
   * Credentials: fixture token only
   * CostSideEffects: isolated browser records only
   */
  test("file prefilling keeps each edited entry and exact STDIO arguments", { tag: "@mocked" }, async ({ page, journey }) => {
    test.setTimeout(90_000);
    const mock = await installMockApi(page); const settings = await openMcp(page);
    const drawer = await openJson(page);
    const args = ["/srv/my MCP/echo.mjs", "", "--quiet"];
    journey.scenario({ goal: "Review and add two file-derived MCP configurations", preconditions: ["Empty MCP list"] });
    await journey.step("Upload a file and edit each configuration", "A BOM is accepted, fields are editable, and switching entries preserves their independent drafts.", async () => {
      await upload(page, "\uFEFF" + JSON.stringify({ mcpServers: { Echo: { command: "node", args, env: { TOKEN: "fixture secret" }, enabled: true }, Events: { type: "sse", url: "https://example.test/events", headers: { "X-Key": "fixture" }, tool_call_timeout: 80 } } }));
      await expect(drawer.getByLabel("名称", { exact: true })).toHaveValue("Echo");
      await expect(drawer.getByLabel("参数", { exact: true })).toHaveValue(args.join("\n"));
      await expect(drawer.getByRole("switch", { name: "启用服务", exact: true })).not.toBeChecked();
      await drawer.getByLabel("说明", { exact: true }).fill("Edited Echo configuration");
      await drawer.getByLabel("服务器配置", { exact: true }).selectOption("1");
      await expect(drawer.getByRole("spinbutton")).toHaveValue("80");
      await drawer.getByLabel("地址", { exact: true }).fill("https://example.test/updated-events");
      await drawer.getByLabel("服务器配置", { exact: true }).selectOption("0");
      await expect(drawer.getByLabel("说明", { exact: true })).toHaveValue("Edited Echo configuration");
      expect(mock.state.mcpServers).toHaveLength(0);
    });
    await journey.step("Add the reviewed configurations once", "Both drafts use the ordinary creation API with preserved arguments/secrets and explicit disabled defaults.", async () => {
      await drawer.getByRole("button", { name: "确认添加 2 台服务器", exact: true }).click();
      await expect(drawer).toBeHidden(); await expect(settings.locator(".mcp-server-card")).toHaveCount(2);
      const writes = mock.calls.filter((call) => call.method === "POST" && call.path === "/api/mcp/servers").map((call) => JSON.parse(call.body!));
      expect(writes).toHaveLength(2);
      expect(writes[0]).toMatchObject({ name: "Echo", description: "Edited Echo configuration", args, env: { TOKEN: "fixture secret" }, enabled: false });
      expect(writes[1]).toMatchObject({ name: "Events", transport: "sse", url: "https://example.test/updated-events", timeoutSeconds: 80, headers: { "X-Key": "fixture" }, enabled: false });
      expect(mock.calls.filter((call) => call.path.endsWith("/test"))).toHaveLength(0, "batch confirmation does not block on sequential probes");
    });
  });

  /**
   * E2E-META
   * Purpose: Invalid files cannot save stale drafts; selecting the same filename can recover safely.
   * Steps:
   *   1. Upload invalid and oversized files without creating records.
   *   2. Reselect the same filename with valid JSON, review and cancel.
   * Environment: isolated desktop Vite and deterministic API fixture.
   * Type: mocked
   * LLM: none
   * WebSearch: none
   * PaperSources: none
   * MCP: in-memory configuration only
   * OtherExternal: none
   * Credentials: fixture token only
   * CostSideEffects: isolated browser state only
   */
  test("invalid and oversized files recover without premature writes", { tag: "@mocked" }, async ({ page, journey }) => {
    test.setTimeout(90_000);
    const mock = await installMockApi(page); await openMcp(page); const drawer = await openJson(page);
    journey.scenario({ goal: "Correct an invalid JSON source and cancel safely", preconditions: ["Empty MCP list"] });
    await journey.step("Read invalid sources", "Errors are visible, confirmation is disabled and nothing is persisted.", async () => {
      await upload(page, "{"); await expect(drawer.getByRole("alert")).toContainText("JSON");
      await expect(drawer.getByRole("button", { name: "确认添加", exact: true })).toBeDisabled();
      await upload(page, " ".repeat(1_500_001)); await expect(drawer.getByRole("alert")).toContainText("1.5 MB");
      await expect(drawer.getByRole("button", { name: "确认添加", exact: true })).toBeDisabled();
    });
    await journey.step("Reselect the same filename and cancel", "The corrected file fills the form and cancellation writes nothing.", async () => {
      await upload(page, JSON.stringify({ mcpServers: { Recovered: { command: "node" } } }));
      await expect(drawer.getByLabel("名称", { exact: true })).toHaveValue("Recovered");
      await expect(drawer.getByRole("button", { name: "确认添加", exact: true })).toBeEnabled();
      await drawer.getByRole("button", { name: "取消", exact: true }).click();
      expect(mock.state.mcpServers).toHaveLength(0);
      expect(mock.calls.some((call) => call.method === "POST" && call.path.startsWith("/api/mcp/"))).toBe(false);
    });
  });

  /**
   * E2E-META
   * Purpose: Hidden draft validation and partial retry prevent invalid or duplicate batch creation.
   * Steps:
   *   1. Correct a required field in a configuration that was not visible.
   *   2. Protect a pending write and retain its partial outcome.
   *   3. Correct and retry only the entry that was not created.
   * Environment: isolated desktop Vite and deterministic API fixture with one refused create.
   * Type: mocked
   * LLM: none
   * WebSearch: none
   * PaperSources: none
   * MCP: in-memory configuration only
   * OtherExternal: none
   * Credentials: fixture token only
   * CostSideEffects: isolated browser records only
   */
  test("hidden validation, busy guards and partial retry preserve successful entries", { tag: "@mocked" }, async ({ page, journey }) => {
    test.setTimeout(90_000);
    const mock = await installMockApi(page); await openMcp(page); const drawer = await openJson(page);
    const posted: string[] = []; let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/mcp/servers", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const body = route.request().postDataJSON() as { name: string }; posted.push(body.name);
      if (body.name === "Fresh") await waiting;
      if (body.name === "Taken") return route.fulfill({ status: 409, json: { error: "Name already exists" } });
      return route.fallback();
    });
    journey.scenario({ goal: "Recover a partially added JSON batch without duplication", preconditions: ["One create will be refused"] });
    await journey.step("Validate the hidden entry", "No write begins until required fields in every pending configuration are valid.", async () => {
      await drawer.getByLabel("JSON", { exact: true }).fill(JSON.stringify({ mcpServers: { Fresh: { command: "node" }, Taken: { type: "stdio" } } }));
      await drawer.getByRole("button", { name: "确认添加 2 台服务器", exact: true }).click();
      await expect(drawer.getByLabel("名称", { exact: true })).toHaveValue("Taken");
      await expect(drawer.getByRole("alert")).toContainText("命令"); expect(posted).toEqual([]);
      await expect(drawer.getByLabel("命令", { exact: true })).toBeFocused();
      await drawer.getByLabel("命令", { exact: true }).fill("node");
    });
    await journey.step("Preserve a pending write and its partial outcome", "Busy state prevents dismissal; a successful entry is tracked and source reset is locked.", async () => {
      await drawer.getByRole("button", { name: "确认添加 2 台服务器", exact: true }).click();
      try {
        await expect(drawer.getByRole("button", { name: "取消", exact: true })).toBeDisabled();
        await expect(drawer.getByRole("button", { name: "关闭设置", exact: true })).toBeDisabled();
        await page.keyboard.press("Escape"); await expect(drawer).toBeVisible();
        await page.keyboard.press("Tab"); await expect(drawer).toBeFocused();
      } finally { release(); }
      await expect(drawer.getByRole("alert")).toContainText("Name already exists");
      await expect(drawer.getByLabel("JSON", { exact: true })).toBeDisabled();
      expect(mock.state.mcpServers.map((server) => server.name)).toEqual(["Fresh"]);
    });
    await journey.step("Correct and retry only the remaining entry", "The edited failed entry is added, and the previously successful entry is never created twice.", async () => {
      await drawer.getByLabel("名称", { exact: true }).fill("Recovered");
      await drawer.getByRole("button", { name: "确认添加", exact: true }).click();
      await expect(drawer).toBeHidden(); expect(posted).toEqual(["Fresh", "Taken", "Recovered"]);
      expect(mock.state.mcpServers.map((server) => server.name)).toEqual(["Fresh", "Recovered"]);
    });
  });
});
