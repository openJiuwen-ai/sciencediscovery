// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { expect, test as base } from "@playwright/test";
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
 * Purpose: Find, enable and try an MCP source without changing hidden services or sending a message.
 * Steps:
 *   1. Filter the catalog by ownership and search.
 *   2. Retry a partially failed filtered bulk enable operation.
 *   3. Check persisted enablement in the centered edit form and card.
 *   4. Try the enabled source in a fresh conversation without sending.
 * Environment: isolated desktop Vite entry and stateful local API fixture.
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: in-memory configuration only
 * OtherExternal: none
 * Credentials: fixture token only
 * CostSideEffects: isolated browser records only
 */
test("MCP 服务器 catalog filters, partial bulk retry, linked enablement and Try it", { tag: "@mocked" }, async ({ page, journey }) => {
  test.setTimeout(90_000);
  const record = (id: string, name: string, enabled = false) => ({ id, sourceId: id, name, enabled, description: "Local research helper",
    transport: "stdio", command: "node", args: ["/srv/my MCP/echo.mjs", "", "--quiet"], cwd: "", env: { TOKEN: null },
    headers: {}, authMode: "headers", timeoutSeconds: 60, url: "", status: "disabled", tools: [] });
  const mock = await installMockApi(page, { mcpServers: [record("custom-a", "Echo Alpha"), record("custom-b", "Echo Beta"), record("custom-hidden", "Hidden service")],
    mcpSources: [{ manifest: { id: "builtin-search", displayName: "Official Search", description: "Built in research", tools: {} }, status: { status: "ready" } }],
    overrides: { enabledConnectorIds: ["unlisted"], plugins: { preserved: { enabled: false } } } });
  await page.addInitScript(([key, token]) => { localStorage.setItem(key, token); localStorage.setItem("sciencediscovery-desktop:locale", "zh-CN"); }, [TOKEN_STORAGE_KEY, TOKEN]);
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await settings.getByRole("button", { name: "MCP 服务器", exact: true }).click();
  const cards = settings.locator(".mcp-server-card");
  const alpha = cards.filter({ hasText: "Echo Alpha" });
  journey.scenario({ goal: "Enable matching custom sources and try one safely", preconditions: ["Three disabled custom servers and one ready built-in source"] });
  await journey.step("Find sources by category and search", "Counts reflect the catalog; built-in actions are read-only and disabled custom sources cannot be tried.", async () => {
    await expect(cards).toHaveCount(4);
    await settings.getByRole("tab", { name: "官方MCP" }).click();
    await expect(cards).toHaveCount(1);
    await cards.getByRole("button", { name: "Official Search的更多操作" }).click();
    await expect(cards.getByRole("menuitem")).toHaveCount(1);
    await expect(cards.getByRole("menuitem", { name: "去试试" })).toBeEnabled();
    await page.keyboard.press("Escape");
    await settings.getByRole("tab", { name: "我的MCP" }).click();
    await expect(cards).toHaveCount(3);
    await settings.getByRole("searchbox", { name: "搜索MCP" }).fill("ECHO");
    await expect(cards).toHaveCount(2);
    await alpha.getByRole("button", { name: "Echo Alpha的更多操作" }).click();
    await expect(alpha.getByRole("menuitem", { name: "去试试" })).toBeDisabled();
    await page.keyboard.press("Escape");
  });
  await journey.step("Retry a partial filtered bulk operation", "The successful server is not written twice, hidden servers and global defaults remain untouched, and secrets/arguments survive.", async () => {
    await page.route("**/api/mcp/servers/custom-b", (route) => route.fulfill({ status: 503, json: { error: "temporary refusal" } }), { times: 1 });
    await settings.getByRole("button", { name: "一键启用" }).click();
    await expect(settings.getByRole("alert")).toContainText("Echo Beta");
    await expect(alpha.getByRole("switch")).toBeChecked();
    await expect(cards.filter({ hasText: "Echo Beta" }).getByRole("switch")).not.toBeChecked();
    await settings.getByRole("button", { name: "一键启用" }).click();
    await expect(cards.filter({ hasText: "Echo Beta" }).getByRole("switch")).toBeChecked();
    expect(mock.calls.filter((call) => call.method === "PUT" && call.path === "/api/mcp/servers/custom-a")).toHaveLength(1);
    expect(mock.state.mcpServers.find((server) => server.id === "custom-hidden")?.enabled).toBe(false);
    expect(mock.state.mcpServers.find((server) => server.id === "custom-a")).toMatchObject({ args: ["/srv/my MCP/echo.mjs", "", "--quiet"], env: { TOKEN: null } });
    expect(mock.calls.filter((call) => call.method === "PUT" && call.path === "/api/settings")).toHaveLength(0);
    expect(mock.state.overrides.enabledConnectorIds).toEqual(["unlisted"]);
  });
  await journey.step("Edit the same persisted service switch", "Both the centered form and card show the saved enablement and a cancelled edit leaves it unchanged.", async () => {
    await alpha.getByRole("button", { name: "Echo Alpha的更多操作" }).click();
    await alpha.getByRole("menuitem", { name: "编辑", exact: true }).click();
    const form = page.getByRole("dialog", { name: "编辑服务器", exact: true });
    await expect(form.getByRole("switch", { name: "启用服务", exact: true })).toBeChecked();
    const box = await form.boundingBox();
    const viewport = page.viewportSize()!;
    expect(Math.abs(box!.x + box!.width / 2 - viewport.width / 2)).toBeLessThan(2);
    await form.getByRole("switch", { name: "启用服务", exact: true }).uncheck();
    await form.getByRole("button", { name: "取消", exact: true }).click();
    await expect(alpha.getByRole("switch")).toBeChecked();
    await alpha.getByRole("switch").click();
    await expect(alpha.getByRole("switch")).not.toBeChecked();
    await alpha.getByRole("switch").click();
    await expect(alpha.getByRole("switch")).toBeChecked();
  });
  await journey.step("Try the selected source", "A new conversation explicitly selects this source, opens without sending, and leaves global defaults unchanged.", async () => {
    const before = mock.state.sessions.length;
    await alpha.getByRole("button", { name: "Echo Alpha的更多操作" }).click();
    await alpha.getByRole("menuitem", { name: "去试试" }).click();
    await expect(settings).toBeHidden();
    expect(mock.state.sessions).toHaveLength(before + 1);
    const creation = mock.calls.findLast((call) => call.method === "POST" && /\/projects\/[^/]+\/sessions$/.test(call.path));
    expect(JSON.parse(creation!.body!)).toMatchObject({ settingsOverrides: { enabledConnectorIds: ["custom-a"] } });
    expect(mock.calls.filter((call) => call.method === "POST" && /\/(runs|messages)$/.test(call.path))).toHaveLength(0);
    expect(mock.state.overrides.enabledConnectorIds).toEqual(["unlisted"]);
  });
});
