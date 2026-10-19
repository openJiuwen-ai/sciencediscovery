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

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, type Page, type Route } from "@playwright/test";

import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { test } from "./helpers/e2e.ts";

// Static suite metadata is inherited by each framework-expanded journey.
test.describe("journey-custom-provider-degraded-settings.spec", { tag: ["@isolation:global", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"] }, () => {

test.use({ locale: "zh-CN" });

const PROVIDER_PREFIX = "E2E 降级设置服务商";

/** A local OpenAI-compatible endpoint that answers every chat with "OK". */
async function startStubModel(): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.method === "GET" && req.url?.endsWith("/models")) {
        res.end(JSON.stringify({ data: [{ id: "stub-degraded-model", object: "model" }], object: "list" }));
        return;
      }
      res.end(JSON.stringify({
        choices: [{ finish_reason: "stop", index: 0, message: { content: "OK", role: "assistant" } }],
        id: "chatcmpl-e2e-degraded-stub",
        model: "stub-degraded-model",
        object: "chat.completion",
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, server };
}

/** Fail one GET endpoint the way a broken backend service would. */
async function failGet(page: Page, pattern: string, message: string): Promise<void> {
  await page.route(pattern, async (route: Route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      body: JSON.stringify({ error: message }),
      contentType: "application/json",
      status: 500,
    });
  });
}

async function openConnectWizard(page: Page) {
  await page.goto("/");
  await expect(page).toHaveTitle("ScienceDiscovery");
  const dialog = page.getByRole("dialog", { name: "系统设置" });
  if (!await dialog.isVisible()) await page.getByRole("button", { name: /^系统设置/ }).click();
  await expect(dialog).toBeVisible();
  const navigation = dialog.getByRole("navigation", { name: "设置分组" });
  if (!await navigation.isVisible()) await dialog.getByRole("button", { name: /^设置目录/ }).click();
  await navigation.getByRole("button", { name: /^模型注册表/ }).click();
  await expect(dialog.getByRole("heading", { name: "模型注册表" })).toBeVisible();
  const wizard = dialog.locator(".model-connect-wizard");
  if (!await wizard.count()) await dialog.getByRole("button", { name: /连接模型/ }).click();
  await expect(wizard).toBeVisible();
  return { dialog, wizard };
}

/** Remove what this journey created, through the API the product exposes. */
async function cleanupJourneyProviders(page: Page): Promise<void> {
  const headers = authorizationHeader();
  const providersRes = await page.request.fetch(`${apiBaseUrl()}/api/providers`, { headers });
  if (!providersRes.ok()) return;
  const providers = (await providersRes.json() as { providers: Array<{ id: string; name: string }> }).providers
    .filter((provider) => provider.name.startsWith(PROVIDER_PREFIX));
  if (!providers.length) return;
  const providerIds = new Set(providers.map((provider) => provider.id));
  const models = (await (await page.request.fetch(`${apiBaseUrl()}/api/models`, { headers })).json() as Array<{ id: string; providerId: string }>)
    .filter((model) => providerIds.has(model.providerId));
  const modelIds = new Set(models.map((model) => model.id));

  // A model that is the global default cannot be deleted; drop only that pointer.
  const settings = await (await page.request.fetch(`${apiBaseUrl()}/api/settings`, { headers })).json() as { overrides?: Record<string, unknown> };
  const overrides = { ...(settings.overrides ?? {}) };
  if (typeof overrides.modelId === "string" && modelIds.has(overrides.modelId)) {
    delete overrides.modelId;
    await page.request.fetch(`${apiBaseUrl()}/api/settings`, { data: overrides, headers, method: "PUT" });
  }
  for (const model of models) {
    await page.request.fetch(`${apiBaseUrl()}/api/models/${encodeURIComponent(model.id)}`, { headers, method: "DELETE" });
  }
  for (const provider of providers) {
    await page.request.fetch(`${apiBaseUrl()}/api/providers/${encodeURIComponent(provider.id)}`, { headers, method: "DELETE" });
  }
}

async function journeyProviderNames(page: Page): Promise<string[]> {
  const res = await page.request.fetch(`${apiBaseUrl()}/api/providers`, { headers: authorizationHeader() });
  expect(res.ok()).toBe(true);
  return (await res.json() as { providers: Array<{ name: string }> }).providers
    .map((provider) => provider.name)
    .filter((name) => name.startsWith(PROVIDER_PREFIX));
}

/**
 * E2E-META
 * Purpose: GitCode #137 / GitHub #281 — 一个与模型无关的设置接口失败时，模型连接向导仍保留全部预置服务商，用户仍能配置并连接自定义服务商。
 * Steps:
 *   1. 让记忆图谱设置接口返回 500 后打开模型注册表：设置弹窗显示该接口的报错，连接卡片仍列出预置服务商并默认选中 DeepSeek。
 *   2. 选择「自定义服务商」：名称、基础 URL、模型标识输入框出现。
 *   3. 填入本地 stub 端点与 Key 后「保存并连接」：连接成功，服务商在后端可查到。
 * Environment: Isolated local stack at E2E_BASE_URL; the memory settings GET is failed at the browser boundary.
 * Type: mocked
 * LLM: none — 旅程自带的本地 HTTP stub，无外部调用。
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none
 * Credentials: E2E_API_TOKEN
 * CostSideEffects: none — 旅程创建的服务商与模型在 finally 中删除。
 */
test("无关设置接口失败时仍能配置自定义服务商", { tag: "@mocked" }, async ({ journey, page }) => {
  test.setTimeout(120_000);
  journey.scenario({
    goal: "部署环境里某个与模型无关的后端服务（这里是记忆图谱）不可用时，用户仍然能在系统设置里看到全部预置服务商，并配置一个自定义服务商把模型连上。",
    preconditions: [
      "隔离栈已启动，浏览器已持有访问令牌",
      "浏览器侧把 GET /api/memory/settings 改为返回 500，模拟该服务故障；其他接口照常",
      "模型端点由旅程自带的本地 HTTP stub 提供，不访问外网",
      "界面语言为 zh-CN",
    ],
  });
  await page.addInitScript(() => window.localStorage.setItem("science-agent-locale", "zh-CN"));
  const stub = await startStubModel();
  const providerName = `${PROVIDER_PREFIX} ${Date.now()}`;

  try {
    await journey.step(
      "记忆图谱设置接口故障时打开模型注册表",
      "系统设置顶部显示记忆图谱接口的报错；连接模型卡片的服务商下拉仍有 DeepSeek 等全部预置服务商，默认选中 DeepSeek 并给出它的 Key 申请链接。",
      async () => {
        await failGet(page, "**/api/memory/settings", "E2E injected memory settings failure");
        const { dialog, wizard } = await openConnectWizard(page);
        await expect(dialog.getByRole("alert").filter({ hasText: "E2E injected memory settings failure" }).first()).toBeVisible();

        const select = wizard.locator("#wizard-provider-select");
        await expect(select).toHaveValue("deepseek");
        await expect(select.locator("option[value=deepseek]")).toHaveCount(1);
        await expect(select.locator("option[value=zhipu]")).toHaveCount(1);
        await expect(wizard.locator(".wizard-key-link")).toHaveAttribute("href", "https://platform.deepseek.com/api_keys");
      },
    );

    await journey.step(
      "选择自定义服务商",
      "下拉框切到「自定义服务商」后，卡片出现服务商名称、基础 URL 与模型标识三个输入框。",
      async () => {
        const wizard = page.getByRole("dialog", { name: "系统设置" }).locator(".model-connect-wizard");
        await wizard.locator("#wizard-provider-select").selectOption("custom");
        await expect(wizard.locator("#wizard-provider-select")).toHaveValue("custom");
        await expect(wizard.locator("#wizard-custom-name")).toBeVisible();
        await expect(wizard.locator("#wizard-custom-url")).toBeVisible();
        await expect(wizard.locator("#wizard-custom-model")).toBeVisible();
        await wizard.locator(".wizard-custom-grid").scrollIntoViewIfNeeded();
      },
    );

    await journey.step(
      "填写自定义端点并保存连接",
      "填入名称、本地 stub 的基础 URL、模型标识与 Key 后点「保存并连接」，卡片提示模型已连接，后端服务商列表里出现这个自定义服务商。",
      async () => {
        const wizard = page.getByRole("dialog", { name: "系统设置" }).locator(".model-connect-wizard");
        await wizard.locator("#wizard-custom-name").fill(providerName);
        await wizard.locator("#wizard-custom-url").fill(stub.baseUrl);
        await wizard.locator("#wizard-custom-model").fill("stub-degraded-model");
        await wizard.locator("#wizard-api-key").fill("degraded-settings-key");
        await wizard.getByRole("checkbox", { name: /我同意发送一次/ }).check();
        await wizard.locator(".wizard-submit-button").click();
        const success = wizard.locator(".wizard-alert-success");
        await expect(success).toContainText("模型已连接");
        await success.scrollIntoViewIfNeeded();
        expect(await journeyProviderNames(page)).toContain(providerName);
      },
    );
  } finally {
    await cleanupJourneyProviders(page);
    stub.server.close();
  }
});

/**
 * E2E-META
 * Purpose: GitCode #137 / GitHub #281 — 服务商注册表接口本身失败、没有任何预置服务商时，连接卡片直接处于自定义模式，用户仍能连接自定义服务商。
 * Steps:
 *   1. 让 GET /api/providers 返回 500 后打开模型注册表：设置弹窗显示该报错，服务商下拉只有「自定义服务商」且自定义输入框已出现。
 *   2. 填入本地 stub 端点与 Key 后「保存并连接」：连接成功，服务商在后端可查到。
 * Environment: Isolated local stack at E2E_BASE_URL; the provider registry GET is failed at the browser boundary, POST is untouched.
 * Type: mocked
 * LLM: none — 旅程自带的本地 HTTP stub，无外部调用。
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none
 * Credentials: E2E_API_TOKEN
 * CostSideEffects: none — 旅程创建的服务商与模型在 finally 中删除。
 */
test("没有预置服务商时连接卡片直接进入自定义模式", { tag: "@mocked" }, async ({ journey, page }) => {
  test.setTimeout(120_000);
  journey.scenario({
    goal: "服务商注册表读不到时，连接卡片不能显示「自定义服务商」却不给输入框；用户应当直接看到自定义表单并完成连接。",
    preconditions: [
      "隔离栈已启动，浏览器已持有访问令牌",
      "浏览器侧把 GET /api/providers 改为返回 500；创建服务商的 POST 照常到达后端",
      "模型端点由旅程自带的本地 HTTP stub 提供，不访问外网",
      "界面语言为 zh-CN",
    ],
  });
  await page.addInitScript(() => window.localStorage.setItem("science-agent-locale", "zh-CN"));
  const stub = await startStubModel();
  const providerName = `${PROVIDER_PREFIX} 无预设 ${Date.now()}`;

  try {
    await journey.step(
      "服务商注册表接口故障时打开模型注册表",
      "系统设置顶部显示服务商注册表的报错；服务商下拉只剩「自定义服务商」且处于选中状态，名称、基础 URL 与模型标识输入框已经出现，无需再选一次。",
      async () => {
        await failGet(page, "**/api/providers", "E2E injected provider registry failure");
        const { dialog, wizard } = await openConnectWizard(page);
        await expect(dialog.getByRole("alert").filter({ hasText: "E2E injected provider registry failure" }).first()).toBeVisible();

        const select = wizard.locator("#wizard-provider-select");
        await expect(select.locator("option")).toHaveCount(1);
        await expect(select).toHaveValue("custom");
        await expect(wizard.locator("#wizard-custom-name")).toBeVisible();
        await expect(wizard.locator("#wizard-custom-url")).toBeVisible();
        await expect(wizard.locator("#wizard-custom-model")).toBeVisible();
        await wizard.locator(".wizard-custom-grid").scrollIntoViewIfNeeded();
      },
    );

    await journey.step(
      "填写自定义端点并保存连接",
      "填入名称、本地 stub 的基础 URL、模型标识与 Key 后点「保存并连接」，卡片提示模型已连接，后端服务商列表里出现这个自定义服务商。",
      async () => {
        const wizard = page.getByRole("dialog", { name: "系统设置" }).locator(".model-connect-wizard");
        await wizard.locator("#wizard-custom-name").fill(providerName);
        await wizard.locator("#wizard-custom-url").fill(stub.baseUrl);
        await wizard.locator("#wizard-custom-model").fill("stub-degraded-model");
        await wizard.locator("#wizard-api-key").fill("degraded-registry-key");
        await wizard.getByRole("checkbox", { name: /我同意发送一次/ }).check();
        await wizard.locator(".wizard-submit-button").click();
        const success = wizard.locator(".wizard-alert-success");
        await expect(success).toContainText("模型已连接");
        await success.scrollIntoViewIfNeeded();
        expect(await journeyProviderNames(page)).toContain(providerName);
      },
    );
  } finally {
    await cleanupJourneyProviders(page);
    stub.server.close();
  }
});

});
