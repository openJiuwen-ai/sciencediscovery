// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { expect, type Page } from "@playwright/test";

import type { ModelProfile, ModelProvider } from "@sciencediscovery/schema";

import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { test } from "./helpers/e2e.ts";

test.use({ locale: "zh-CN" });

async function apiJson<T>(page: Page, path: string, options: { data?: unknown; method?: string } = {}): Promise<T> {
  const response = await page.request.fetch(`${apiBaseUrl()}${path}`, {
    ...(options.data === undefined ? {} : { data: options.data }),
    headers: authorizationHeader(),
    method: options.method ?? "GET",
  });
  if (!response.ok()) throw new Error(`${options.method ?? "GET"} ${path} -> ${response.status()}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

/**
 * E2E-META
 * Purpose: 高级独立模型与 Provider 草稿安全——模型卡片切换、设置分组切换和底部保存均保留明确作用域，双草稿只确认一次且不会错存。
 * Steps:
 *   1. 用本地 manual Provider 建立两个高级模型，打开模型注册表并选中模型 A。
 *   2. 修改模型 A 后切换模型 B；取消丢弃时草稿保留，确认丢弃后模型 B 恢复其已保存值。
 *   3. 同时修改 Provider 与模型 B 后切换设置分组；只出现一次双草稿确认，取消时两份草稿均保留，确认后两份均恢复已保存值。
 *   4. 再次同时修改两份草稿并点击底部保存；Provider 与模型各自写入正确 API，设置保持打开且关闭时不再误报未保存。
 * Environment: Isolated local stack at E2E_BASE_URL with isolated data dir；Provider 使用 loopback base URL 和 manual 发现策略。
 * Type: mocked
 * LLM: none — 仅修改本地设置记录，不发起模型调用。
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — 非本地浏览器请求被拦截；manual 发现不会连接 Provider endpoint。
 * Credentials: E2E_API_TOKEN（隔离实例）；Provider 标记 token optional，不使用厂商令牌。
 * CostSideEffects: none；本旅程创建的 Provider 与模型记录在 finally 中删除。
 */
test("T1 高级模型与 Provider 双草稿不会静默丢失", { tag: "@mocked" }, async ({ journey, page }) => {
  test.setTimeout(180_000);
  journey.scenario({
    goal: "一位用户在同一模型注册表中编辑 Provider 和高级独立模型；任何卡片或分组切换都不能静默丢失草稿，底部保存必须准确提交两种草稿。",
    preconditions: [
      "隔离栈已启动，浏览器已持有本实例访问 token",
      "Provider 为 loopback/manual，不访问厂商网络，也不发起模型推理",
      "浏览器与界面语言均为 zh-CN",
    ],
  });
  await page.addInitScript(() => window.localStorage.setItem("science-agent-locale", "zh-CN"));

  const stamp = Date.now();
  const providerName = `T1 本地服务商 ${stamp}`;
  let provider: ModelProvider | undefined;
  let modelA: ModelProfile | undefined;
  let modelB: ModelProfile | undefined;

  const openModelRegistry = async () => {
    const dialog = page.getByRole("dialog", { name: "系统设置" });
    if (!await dialog.isVisible()) await page.getByRole("button", { name: /^系统设置/ }).click();
    await dialog.getByRole("navigation", { name: "设置分组" })
      .getByRole("button", { name: /^模型注册表/ })
      .click();
    return dialog;
  };

  const openAdvancedProfiles = async () => {
    const dialog = page.getByRole("dialog", { name: "系统设置" });
    const details = dialog.locator("details.provider-advanced-profiles");
    if (await details.getAttribute("open") === null) await details.locator(":scope > summary").click();
    return details;
  };

  const selectProvider = async () => {
    const dialog = page.getByRole("dialog", { name: "系统设置" });
    await dialog.getByRole("region", { name: "已配置服务商" })
      .getByRole("button", { name: new RegExp(providerName) })
      .click();
    return dialog.getByRole("region", { name: "服务商编辑器" });
  };

  try {
    await page.goto("/");
    provider = await apiJson<ModelProvider>(page, "/api/providers", {
      data: {
        apiProtocol: "openai-chat-completions",
        apiVariant: "openai",
        baseUrl: "http://127.0.0.1:1/v1",
        modelDiscovery: "manual",
        name: providerName,
        tokenOptional: true,
      },
      method: "POST",
    });
    modelA = await apiJson<ModelProfile>(page, `/api/providers/${encodeURIComponent(provider.id)}/models`, {
      data: { model: `t1-model-a-${stamp}` },
      method: "POST",
    });
    modelB = await apiJson<ModelProfile>(page, `/api/providers/${encodeURIComponent(provider.id)}/models`, {
      data: { model: `t1-model-b-${stamp}` },
      method: "POST",
    });
    await page.reload();

    await journey.step(
      "打开两个本地模型并选中模型 A",
      "模型注册表显示 loopback/manual Provider 和两个高级模型；展开高级配置后选中模型 A，表单与已保存值一致。",
      async () => {
        const dialog = await openModelRegistry();
        await selectProvider();
        await openAdvancedProfiles();
        const cardA = dialog.locator(".model-card").filter({ hasText: modelA!.name });
        await cardA.click();
        await expect(cardA).toHaveClass(/active/);
        await expect(dialog.locator("form.model-editor").getByLabel("显示名称")).toHaveValue(modelA!.name);
      },
    );

    await journey.step(
      "切换模型卡片前必须明确处理当前模型草稿",
      "修改模型 A 名称后点模型 B，只出现一次高级模型确认；取消后模型 A 和草稿都保持，明确丢弃后才切到模型 B，并显示 B 的已保存名称与协议。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const editor = dialog.locator("form.model-editor");
        const cardA = dialog.locator(".model-card").filter({ hasText: modelA!.name });
        const cardB = dialog.locator(".model-card").filter({ hasText: modelB!.name });
        const unsavedA = `${modelA!.name} 未保存`;
        await editor.getByLabel("显示名称").fill(unsavedA);

        let dismissMessage = "";
        page.once("dialog", (confirmation) => {
          dismissMessage = confirmation.message();
          void confirmation.dismiss();
        });
        await cardB.click();
        expect(dismissMessage).toContain("放弃尚未保存的高级模型修改");
        await expect(cardA).toHaveClass(/active/);
        await expect(editor.getByLabel("显示名称")).toHaveValue(unsavedA);

        let acceptCount = 0;
        page.once("dialog", (confirmation) => {
          acceptCount += 1;
          void confirmation.accept();
        });
        await cardB.click();
        expect(acceptCount).toBe(1);
        await expect(cardB).toHaveClass(/active/);
        await expect(editor.getByLabel("显示名称")).toHaveValue(modelB!.name);
        await expect(editor.getByLabel("基础接口")).toHaveValue("openai-chat-completions");
      },
    );

    await journey.step(
      "双草稿切换分组只确认一次且共同保留或丢弃",
      "同时改 Provider 名称和模型 B 名称后切到全局默认值，只出现一次作用域明确的双草稿确认。取消时两份修改都在；明确丢弃后切换成功，回到模型注册表后两份表单均恢复已保存值。",
      async () => {
        let dialog = page.getByRole("dialog", { name: "系统设置" });
        const providerEditor = dialog.getByRole("region", { name: "服务商编辑器" });
        const modelEditor = dialog.locator("form.model-editor");
        const unsavedProvider = `${providerName} 未保存`;
        const unsavedModel = `${modelB!.name} 未保存`;
        await providerEditor.getByLabel("服务商名称").fill(unsavedProvider);
        await modelEditor.getByLabel("显示名称").fill(unsavedModel);

        let dismissCount = 0;
        let dismissMessage = "";
        page.once("dialog", (confirmation) => {
          dismissCount += 1;
          dismissMessage = confirmation.message();
          void confirmation.dismiss();
        });
        await dialog.getByRole("navigation", { name: "设置分组" })
          .getByRole("button", { name: /^全局默认值/ })
          .click();
        expect(dismissCount).toBe(1);
        expect(dismissMessage).toContain("服务商和高级模型修改");
        await expect(dialog.getByRole("heading", { name: "模型注册表" })).toBeVisible();
        await expect(providerEditor.getByLabel("服务商名称")).toHaveValue(unsavedProvider);
        await expect(modelEditor.getByLabel("显示名称")).toHaveValue(unsavedModel);

        let acceptCount = 0;
        page.once("dialog", (confirmation) => {
          acceptCount += 1;
          void confirmation.accept();
        });
        await dialog.getByRole("navigation", { name: "设置分组" })
          .getByRole("button", { name: /^全局默认值/ })
          .click();
        expect(acceptCount).toBe(1);
        await expect(dialog.getByText("全局默认值", { exact: true })).toBeVisible();

        dialog = await openModelRegistry();
        const restoredProvider = await selectProvider();
        await expect(restoredProvider.getByLabel("服务商名称")).toHaveValue(providerName);
        await openAdvancedProfiles();
        await dialog.locator(".model-card").filter({ hasText: modelB!.name }).click();
        await expect(dialog.locator("form.model-editor").getByLabel("显示名称")).toHaveValue(modelB!.name);
      },
    );

    await journey.step(
      "底部保存分别提交 Provider 与高级模型草稿",
      "再次同时修改两份名称后点击对话框底部保存，PUT 分别命中当前 Provider 和模型 B；设置保持打开、两个新名称可见，随后取消并关闭不再出现未保存确认，重开后仍是新值。",
      async () => {
        let dialog = page.getByRole("dialog", { name: "系统设置" });
        const providerEditor = dialog.getByRole("region", { name: "服务商编辑器" });
        const modelEditor = dialog.locator("form.model-editor");
        const savedProviderName = `${providerName} 已保存`;
        const savedModelName = `${modelB!.name} 已保存`;
        await providerEditor.getByLabel("服务商名称").fill(savedProviderName);
        await modelEditor.getByLabel("显示名称").fill(savedModelName);

        const providerPath = `/api/providers/${encodeURIComponent(provider!.id)}`;
        const modelPath = `/api/models/${encodeURIComponent(modelB!.id)}`;
        const providerSave = page.waitForResponse((response) => response.request().method() === "PUT"
          && new URL(response.url()).pathname === providerPath);
        const modelSave = page.waitForResponse((response) => response.request().method() === "PUT"
          && new URL(response.url()).pathname === modelPath);
        let unexpectedConfirmation = 0;
        const countDialog = () => { unexpectedConfirmation += 1; };
        page.on("dialog", countDialog);
        await dialog.locator(".system-config-footer").getByRole("button", { name: "保存", exact: true }).click();
        expect((await providerSave).ok()).toBe(true);
        expect((await modelSave).ok()).toBe(true);
        page.off("dialog", countDialog);
        expect(unexpectedConfirmation).toBe(0);
        await expect(providerEditor.getByLabel("服务商名称")).toHaveValue(savedProviderName);
        await expect(modelEditor.getByLabel("显示名称")).toHaveValue(savedModelName);

        let closeConfirmation = 0;
        const countCloseDialog = (confirmation: import("@playwright/test").Dialog) => {
          closeConfirmation += 1;
          void confirmation.dismiss();
        };
        page.on("dialog", countCloseDialog);
        await dialog.locator(".system-config-footer").getByRole("button", { name: "取消并关闭" }).click();
        await expect(dialog).toBeHidden();
        page.off("dialog", countCloseDialog);
        expect(closeConfirmation).toBe(0);

        dialog = await openModelRegistry();
        await dialog.getByRole("region", { name: "已配置服务商" })
          .getByRole("button", { name: new RegExp(savedProviderName) })
          .click();
        await expect(dialog.getByRole("region", { name: "服务商编辑器" }).getByLabel("服务商名称"))
          .toHaveValue(savedProviderName);
        await openAdvancedProfiles();
        await dialog.locator(".model-card").filter({ hasText: savedModelName }).click();
        await expect(dialog.locator("form.model-editor").getByLabel("显示名称")).toHaveValue(savedModelName);
      },
    );
  } finally {
    const modelIds = [modelA?.id, modelB?.id].filter((id): id is string => Boolean(id));
    if (modelIds.length) {
      try {
        const settings = await apiJson<{ overrides?: Record<string, unknown> }>(page, "/api/settings");
        const overrides = { ...(settings.overrides ?? {}) };
        let changed = false;
        for (const key of ["modelId", "reviewModelId"]) {
          if (typeof overrides[key] === "string" && modelIds.includes(overrides[key] as string)) {
            delete overrides[key];
            changed = true;
          }
        }
        if (changed) await apiJson(page, "/api/settings", { data: overrides, method: "PUT" });
      } catch { /* best-effort */ }
    }
    for (const modelId of modelIds) {
      await apiJson(page, `/api/models/${encodeURIComponent(modelId)}`, { method: "DELETE" }).catch(() => undefined);
    }
    if (provider?.id) {
      await apiJson(page, `/api/providers/${encodeURIComponent(provider.id)}`, { method: "DELETE" }).catch(() => undefined);
    }
  }
});
