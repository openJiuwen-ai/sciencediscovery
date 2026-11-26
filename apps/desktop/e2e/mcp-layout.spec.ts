// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/**
 * E2E-META
 * Purpose: Read and edit MCP configuration through the new cards and dialogs.
 * Steps:
 *   1. Open a card menu with the keyboard and inspect built-in read-only details.
 *   2. Read full custom configuration and tools, then edit and cancel without writes.
 *   3. Resize the real settings page and verify reachable actions and focus containment.
 *   4. Read the same configuration in English.
 * Environment: isolated desktop Vite entry and deterministic local API fixture.
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: in-memory configuration and discovery results only
 * OtherExternal: none
 * Credentials: fixture access token only
 * CostSideEffects: isolated browser state only
 */
import { expect, test as base } from "@playwright/test";
import { createJourneyReporter, type JourneyReporter } from "../../../test/helpers/journey-report.ts";
import { installMockApi, TOKEN, TOKEN_STORAGE_KEY } from "./fixtures.js";

const test = base.extend<{ journey: JourneyReporter }>({
  journey: async ({ page }, use, info) => {
    const reporter = createJourneyReporter(page, info);
    try { await use(reporter); } finally { await reporter.finalize(); }
  },
});

test("MCP 服务器 cards, read-only details and responsive bilingual dialogs", { tag: "@mocked" }, async ({ page, journey }) => {
  test.setTimeout(90_000);
  journey.scenario({ goal: "Inspect MCP configuration without changing it", preconditions: ["Built-in and custom sources are available"] });
  const longDescription = "完整说明：" + "可在详情中读取的研究工具配置。".repeat(24);
  const mock = await installMockApi(page, {
    mcpServers: [{
      id: "custom-layout", sourceId: "custom-layout", name: "Research tools", description: longDescription,
      enabled: false, transport: "stdio", command: "node", args: ["/srv/my MCP/echo.mjs", "", "--quiet"],
      cwd: "/srv/my MCP", url: "", env: { TOKEN: null }, headers: {}, timeoutSeconds: 60,
      status: "disabled", checkedAt: "2026-11-24T01:00:00Z", tools: [{ name: "echo", description: "Echo a message" }],
    }],
    mcpSources: [{ manifest: { id: "builtin-search", displayName: "内置检索", description: "随产品提供的检索工具", tools: { search: { id: "search", description: "检索" } } }, status: { status: "ready" } }],
  });
  await page.addInitScript(([key, token]) => {
    localStorage.setItem(key, token);
    localStorage.setItem("sciencediscovery-desktop:locale", "zh-CN");
  }, [TOKEN_STORAGE_KEY, TOKEN]);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    await settings.getByRole("button", { name: "MCP 服务器", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "服务器详情", exact: true });
    await journey.step("Inspect a built-in source", "Only Try it is offered, and Escape returns focus without closing settings.", async () => {
      const trigger = settings.getByRole("button", { name: "内置检索的更多操作", exact: true });
      await trigger.focus();
      await page.keyboard.press("ArrowDown");
      const menu = settings.getByRole("menu", { name: "内置检索的更多操作", exact: true });
      await expect(menu.getByRole("menuitem", { name: "编辑", exact: true })).toHaveCount(0);
      await expect(menu.getByRole("menuitem", { name: "删除", exact: true })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      await expect(settings).toBeVisible();
      await settings.getByRole("button", { name: "查看内置检索详情", exact: true }).click();
      await expect(drawer).toContainText("search");
      await expect(drawer).toContainText("内置来源由应用管理");
      await expect(drawer.getByRole("button", { name: "编辑", exact: true })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(settings.getByRole("button", { name: "查看内置检索详情", exact: true })).toBeFocused();
    });
    await journey.step("Read full configuration and cancel an edit", "The drawer exposes long text, stored key names, exact arguments and check semantics without writing.", async () => {
      await settings.getByRole("button", { name: "查看Research tools详情", exact: true }).click();
      await expect(drawer).toContainText(longDescription);
      await expect(drawer).toContainText("/srv/my MCP/echo.mjs");
      await expect(drawer).toContainText("TOKEN");
      await expect(drawer).toContainText("并非持续心跳");
      await expect(drawer).toContainText("Echo a message");
      await drawer.getByRole("button", { name: "编辑", exact: true }).click();
      const editor = page.getByRole("dialog", { name: "编辑服务器", exact: true });
      await expect(editor.getByLabel("参数", { exact: true })).toHaveValue("/srv/my MCP/echo.mjs\n\n--quiet");
      await editor.getByLabel("名称", { exact: true }).fill("Discarded edit");
      await editor.getByRole("button", { name: "取消", exact: true }).click();
      expect(mock.calls.filter((call) => (call.path.startsWith("/api/mcp/") || call.path === "/api/settings")
        && ["POST", "PUT", "DELETE"].includes(call.method))).toHaveLength(0);
    });
    await journey.step("Keep a pending edit safe and recover from refusal", "Busy controls and Escape cannot dismiss the pending write; an error keeps the draft editable.", async () => {
      await settings.getByRole("button", { name: "查看Research tools详情", exact: true }).click();
      await drawer.getByRole("button", { name: "编辑", exact: true }).click();
      const editor = page.getByRole("dialog", { name: "编辑服务器", exact: true });
      await editor.getByLabel("名称", { exact: true }).fill("Pending edit");
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => { release = resolve; });
      await page.route("**/api/mcp/servers/custom-layout", async (route) => {
        await waiting;
        await route.fulfill({ status: 503, json: { error: "Save temporarily unavailable" } });
      }, { times: 1 });
      await editor.getByRole("button", { name: "保存", exact: true }).click();
      try {
        await expect(editor.getByRole("button", { name: "取消", exact: true })).toBeDisabled();
        await expect(editor.getByRole("button", { name: "关闭设置", exact: true })).toBeDisabled();
        await expect(editor.getByLabel("名称", { exact: true })).toBeDisabled();
        await page.keyboard.press("Escape");
        await expect(editor).toBeVisible();
      } finally { release(); }
      await expect(editor.getByRole("alert")).toContainText("Save temporarily unavailable");
      await expect(editor.getByLabel("名称", { exact: true })).toHaveValue("Pending edit");
      await expect(editor.getByRole("button", { name: "保存", exact: true })).toBeEnabled();
      await editor.getByRole("button", { name: "取消", exact: true }).click();
      expect(mock.state.mcpServers[0]?.name).toBe("Research tools");
    });
    await journey.step("Use dialogs at smaller desktop sizes", "Panels stay inside the viewport, footer actions remain reachable and Tab stays in the panel.", async () => {
      for (const width of [960, 768]) {
        await page.setViewportSize({ width, height: 720 });
        await settings.getByRole("button", { name: "查看Research tools详情", exact: true }).click();
        const box = await drawer.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
        await expect(drawer.getByRole("button", { name: "编辑", exact: true })).toBeInViewport();
        const close = drawer.getByRole("button", { name: "关闭设置", exact: true });
        await drawer.getByRole("button", { name: "Research tools的更多操作", exact: true }).focus();
        await page.keyboard.press("Shift+Tab");
        await expect(drawer.getByRole("button", { name: "编辑", exact: true })).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(drawer.getByRole("button", { name: "Research tools的更多操作", exact: true })).toBeFocused();
        await page.keyboard.press("Escape");
      }
    });
    await journey.step("Read the English UI", "The same source and check semantics are available in English.", async () => {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await settings.getByRole("button", { name: "通用", exact: true }).click();
      await settings.getByRole("button", { name: "界面语言", exact: true }).click();
      await page.getByRole("option", { name: "English", exact: true }).click();
      const englishSettings = page.getByRole("dialog", { name: "Settings", exact: true });
      await englishSettings.getByRole("button", { name: "MCP servers", exact: true }).click();
      await englishSettings.getByRole("button", { name: "View Research tools details", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Server details", exact: true })).toContainText("not a continuous heartbeat");
    });
});
