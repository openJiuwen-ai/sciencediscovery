// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { expect } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { protocolProvider } from "./helpers/protocol-provider.js";

/**
 * E2E-META
 * Purpose: Explicitly consent to protocol checks and inspect independent capabilities without changing selection.
 * Steps:
 *   1. Register a local provider with an explicit Responses selection; open model settings with no automatic completion requests.
 *   2. Read costs and explicitly consent; inspect independent protocol/capability results and unknown usage.
 *   3. Inspect localized result details at 390px without horizontal overflow.
 *   4. Inspect localized result details at 960px without horizontal overflow.
 *   5. Inspect localized result details at 1440px without horizontal overflow.
 *   6. Verify the saved Responses selection remains unchanged after the check.
 * Environment: Isolated API/Web, no Runner or sidecars required.
 * Type: mocked
 * LLM: deterministic loopback fixture for all three protocol families.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none
 * Credentials: synthetic loopback-only credential.
 * CostSideEffects: journey-owned provider/model records and local requests, no charges.
 */
for (const locale of ["zh-CN", "en"] as const) test(`Explicit compatibility consent preserves a manually chosen protocol (${locale})`, { tag: ["@mocked", "@isolation:global", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:none"] }, async ({ page, journey }) => {
  journey.scenario({ goal: "Check model protocol capabilities with explicit cost consent", preconditions: ["Isolated API/Web and a synthetic loopback-only provider; no paid credentials"] });
  await page.addInitScript(value => window.localStorage.setItem("science-agent-locale", value), locale);
  const fixture = await protocolProvider("all", { usage: "missing" });
  let providerId: string | undefined;
  const call = async (path: string, data?: unknown, method = data ? "POST" : "GET") => {
    const response = await page.request.fetch(`${apiBaseUrl()}${path}`, { headers: authorizationHeader(), method, ...(data ? { data } : {}) });
    expect(response.ok()).toBeTruthy(); return response.json();
  };
  try {
    await journey.step("Register a local provider with an explicit Responses selection", "Settings shows the saved model, without automatic completion requests", async () => {
      const provider = await call("/api/providers", { name: "Protocol consent fixture", baseUrl: fixture.baseUrl, apiProtocol: "openai-responses", apiToken: "local-synthetic-388", proxyPolicy: "none" });
      providerId = provider.id;
      await call(`/api/providers/${provider.id}/models`, { model: "synthetic", name: "Synthetic protocol model" });
      await page.goto("/");
      await page.getByRole("button", { name: locale === "zh-CN" ? /^系统设置/ : /^System configuration/ }).click();
      const dialog = page.getByRole("dialog", { name: locale === "zh-CN" ? "系统设置" : "System configuration" });
      const navigation = dialog.getByRole("navigation", { name: locale === "zh-CN" ? "设置分组" : "Setting groups" });
      if (!await navigation.isVisible()) await dialog.getByRole("button", { name: locale === "zh-CN" ? /^设置目录/ : /^Settings directory/ }).click();
      await navigation.getByRole("button", { name: locale === "zh-CN" ? /^模型注册表/ : /^Model registry/ }).click();
      await dialog.locator(".provider-row").filter({ hasText: "Protocol consent fixture" }).locator(".provider-row-summary").click();
      expect(fixture.requests).toHaveLength(0);
    });
    const section = page.locator(".provider-row").filter({ hasText: "Protocol consent fixture" });
    await journey.step("Read costs and explicitly agree to synthetic requests", "Probe disabled until consent; results show all protocols and unknown usage", async () => {
      const check = section.locator(".model-compatibility-check");
      const action = check.getByRole("button");
      await expect(action).toBeDisabled();
      await check.getByRole("checkbox").check();
      await action.click();
      const results = check.getByRole("status");
      await expect(results).toContainText("openai-chat-completions");
      await expect(results).toContainText("openai-responses");
      await expect(results).toContainText("anthropic-messages");
      await expect(results).toContainText(locale === "zh-CN" ? "用量: 未知" : "Usage: Unknown");
      await expect(results).toContainText(locale === "zh-CN" ? "支持" : "Supported");
      expect(fixture.requests).toHaveLength(12);
    });
    for (const width of [390, 960, 1440]) await journey.step(`Inspect result details at ${width}px`, "Cost disclosure and all capability evidence remain readable and scrollable", async () => {
      await page.setViewportSize({ width, height: 800 });
      const results = section.locator(".model-compatibility-results");
      await results.scrollIntoViewIfNeeded(); await expect(results).toBeVisible();
      expect(await results.evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBeTruthy();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBeTruthy();
    });
    await journey.step("Verify selection after the compatibility check", "The saved protocol remains Responses, with no automatic switch", async () => {
      const saved = (await call("/api/providers")).providers.find((p: { id: string }) => p.id === providerId);
      expect(saved.apiProtocol).toBe("openai-responses");
    });
  } finally {
    if (providerId) await page.request.fetch(`${apiBaseUrl()}/api/providers/${providerId}`, { method: "DELETE", headers: authorizationHeader() });
    await fixture.close();
  }
});
