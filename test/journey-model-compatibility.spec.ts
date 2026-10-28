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
import { expect } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { protocolProvider } from "./helpers/protocol-provider.js";

for (const locale of ["zh-CN", "en"] as const) {
  /**
   * E2E-META
   * Purpose: Explicitly consent to protocol checks and inspect independent capabilities without changing selection.
   * Steps:
   *   1. Register a local provider with an explicit Responses selection; open model settings with no automatic completion requests.
   *   2. Read costs and consent separately to one selected basic request and the full matrix; inspect independent results and unknown usage.
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
  test(`(${locale}) Explicit compatibility consent preserves a manually chosen protocol`, { tag: ["@mocked", "@isolation:global", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:none"] }, async ({ page, journey }) => {
    journey.scenario({ goal: "Check model protocol capabilities with explicit cost consent", preconditions: ["Isolated API/Web and a synthetic loopback-only provider; no paid credentials"] });
    await page.addInitScript(value => window.localStorage.setItem("science-agent-locale", value), locale);
    const fixture = await protocolProvider("all", { usage: "missing" });
    const providerName = `Protocol consent fixture ${locale} ${randomUUID()}`;
    let providerId: string | undefined, modelId: string | undefined;
    const call = async (path: string, data?: unknown, method = data ? "POST" : "GET") => {
      const response = await page.request.fetch(`${apiBaseUrl()}${path}`, { headers: authorizationHeader(), method, ...(data ? { data } : {}) });
      expect(response.ok()).toBeTruthy(); return response.json();
    };
    try {
      await journey.step("Register a local provider with an explicit Responses selection", "Settings shows the saved model, without automatic completion requests", async () => {
        const provider = await call("/api/providers", { name: providerName, baseUrl: fixture.baseUrl, apiProtocol: "openai-responses", apiToken: "local-synthetic-388", proxyPolicy: "none" });
        providerId = provider.id;
        modelId = (await call(`/api/providers/${provider.id}/models`, { model: "synthetic", name: "Synthetic protocol model" })).id;
        await page.goto("/");
        await page.getByRole("button", { name: locale === "zh-CN" ? /^系统设置/ : /^System configuration/ }).click();
        const dialog = page.getByRole("dialog", { name: locale === "zh-CN" ? "系统设置" : "System configuration" });
        const navigation = dialog.getByRole("navigation", { name: locale === "zh-CN" ? "设置分组" : "Setting groups" });
        if (!await navigation.isVisible()) await dialog.getByRole("button", { name: locale === "zh-CN" ? /^设置目录/ : /^Settings directory/ }).click();
        await navigation.getByRole("button", { name: locale === "zh-CN" ? /^模型注册表/ : /^Model registry/ }).click();
        await dialog.locator(".provider-row").filter({ hasText: providerName }).locator(".provider-row-summary").click();
        expect(fixture.requests).toHaveLength(0);
      });
      const section = page.locator(".provider-row").filter({ hasText: providerName });
      await journey.step("Read costs and explicitly agree to synthetic requests", "Probe disabled until consent; results show all protocols and unknown usage", async () => {
        const check = section.locator(".model-compatibility-check");
        const action = check.getByRole("button");
        await expect(action).toBeDisabled();
        await check.getByRole("checkbox").check(); await action.click();
        await expect(action).toBeEnabled(); expect(fixture.requests).toHaveLength(1);
        expect(fixture.requests[0]!.body.max_output_tokens).toBe(16);
        await check.getByRole("combobox").selectOption("matrix");
        expect(fixture.requests).toHaveLength(1);
        const beforeMatrix = fixture.requests.length;
        await expect(action).toBeDisabled();
        await check.getByRole("checkbox").check(); await action.click();
        const results = check.getByRole("status");
        await expect(results).toContainText("openai-chat-completions");
        await expect(results).toContainText("openai-responses");
        await expect(results).toContainText("anthropic-messages");
        await expect(results).toContainText(locale === "zh-CN" ? "用量: 未知" : "Usage: Unknown");
        await expect(results).toContainText(locale === "zh-CN" ? "支持" : "Supported");
        expect(fixture.requests.length - beforeMatrix).toBe(12);
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
      try {
        if (providerId) {
          // The first added model can become the global default. Remove only this
          // journey-owned reference, retaining every other current setting.
          const current = (await call("/api/settings")).overrides;
          if (modelId && current.modelId === modelId) {
            delete current.modelId;
            await call("/api/settings", current, "PUT");
          }
          await call(`/api/providers/${providerId}`, undefined, "DELETE");
          expect((await call("/api/providers")).providers.some((p: { id: string }) => p.id === providerId)).toBe(false);
        }
      } finally { await fixture.close(); }
    }
  });
}
