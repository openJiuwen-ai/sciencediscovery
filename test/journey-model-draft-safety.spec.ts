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
 * Purpose: 服务商草稿安全——编辑器只在显式选择后出现；切换新服务商草稿、切换设置分组或关闭对话框时都只确认一次，
 *   取消保留草稿、确认才丢弃；底部保存准确提交草稿且不误报未保存。旧的“高级独立模型”双编辑器已删除，本场景按新主路径验证。
 * Steps:
 *   1. 打开模型注册表：没有自动选中的服务商；已建 Provider 行显示“已添加 1”，点“编辑”后才出现编辑器且值与保存一致。
 *   2. 修改服务商名称后点“自定义服务商”新建：只出现一次未保存确认；取消时草稿保留，确认后切到新草稿（“连接服务商”）。
 *   3. 修改名称后切换“全局默认值”分组：同样只确认一次；取消时留在注册表且草稿保留，确认后切换成功、重开值恢复已保存。
 *   4. 修改名称后点底部“保存”：PUT 命中 Provider、无确认弹窗、对话框保持打开；关闭时不再误报未保存，重开值与保存一致。
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
test("T1 服务商草稿不会静默丢失", { tag: "@mocked" }, async ({ journey, page }) => {
  test.setTimeout(180_000);
  journey.scenario({
    goal: "一位用户在同一模型注册表中编辑服务商草稿；任何新建/切换分组/关闭都不应静默丢失草稿，底部保存必须准确提交。",
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
  let model: ModelProfile | undefined;

  const openModelRegistry = async () => {
    const dialog = page.getByRole("dialog", { name: "系统设置" });
    if (!await dialog.isVisible()) await page.getByRole("button", { name: /^系统设置/ }).click();
    await dialog.getByRole("navigation", { name: "设置分组" })
      .getByRole("button", { name: /^模型注册表/ })
      .click();
    return dialog;
  };

  const openProviderEditor = async (dialog: ReturnType<typeof page.getByRole>) => {
    const row = dialog.locator(".provider-row").filter({ hasText: providerName });
    if (!await row.locator(".provider-row-detail").count()) {
      await row.locator(".provider-row-summary").click();
    }
    await row.getByRole("button", { name: "编辑", exact: true }).click();
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
    model = await apiJson<ModelProfile>(page, `/api/providers/${encodeURIComponent(provider.id)}/models`, {
      data: { model: `t1-model-${stamp}` },
      method: "POST",
    });
    await page.reload();

    await journey.step(
      "没有自动选中服务商；点“编辑”才出现编辑器且值与保存一致",
      "打开模型注册表时不自动选中任何服务商——“服务商编辑器”不出现；已建 Provider 行显示名称与“已添加 1”。"
      + "点“编辑”后才出现编辑器，名称与已保存值一致。",
      async () => {
        const dialog = await openModelRegistry();
        await expect(dialog.getByRole("region", { name: "服务商编辑器" })).toHaveCount(0);
        const row = dialog.locator(".provider-row").filter({ hasText: providerName });
        await expect(row).toBeVisible();
        await expect(row).toContainText("已添加 1");
        const editor = await openProviderEditor(dialog);
        await expect(editor.getByLabel("服务商名称")).toHaveValue(providerName);
        await dialog.getByRole("button", { name: "取消并关闭" }).filter({ hasText: "取消并关闭" }).click();
        await expect(dialog).toBeHidden();
      },
    );

    await journey.step(
      "切换新草稿前明确确认：取消保留、确认才切换",
      "修改服务商名称后点“自定义服务商”新建：只出现一次“放弃尚未保存的服务商修改？”确认。"
      + "取消时草稿保留且编辑器仍是原草稿；明确确认后切到新草稿“连接服务商”，名称回到空。",
      async () => {
        const dialog = await openModelRegistry();
        const editor = await openProviderEditor(dialog);
        const unsavedName = `${providerName} 未保存`;
        await editor.getByLabel("服务商名称").fill(unsavedName);

        let dismissMessage = "";
        page.once("dialog", (confirmation) => {
          dismissMessage = confirmation.message();
          void confirmation.dismiss();
        });
        await dialog.getByRole("button", { name: /添加 Provider/ }).first().click();
        await dialog.locator(".provider-add-panel").getByRole("button", { name: /^自定义服务商$/ }).click();
        expect(dismissMessage).toContain("放弃尚未保存的服务商修改");
        await expect(dialog.getByRole("region", { name: "服务商编辑器" }).getByLabel("服务商名称"))
          .toHaveValue(unsavedName);

        let acceptCount = 0;
        page.once("dialog", (confirmation) => {
          acceptCount += 1;
          void confirmation.accept();
        });
        await dialog.locator(".provider-add-panel").getByRole("button", { name: /^自定义服务商$/ }).click();
        expect(acceptCount).toBe(1);
        const newEditor = dialog.getByRole("region", { name: "服务商编辑器" });
        await expect(newEditor.getByText("连接服务商")).toBeVisible();
        await expect(newEditor.getByLabel("服务商名称")).toHaveValue("");
        await dialog.getByRole("button", { name: "取消并关闭" }).filter({ hasText: "取消并关闭" }).click();
        await expect(dialog).toBeHidden();
      },
    );

    await journey.step(
      "切换设置分组前同样只确认一次",
      "修改服务商名称后切到“全局默认值”分组：只出现一次未保存确认。取消时留在注册表、草稿保留；确认后切到全局默认值，重开注册表值恢复已保存。",
      async () => {
        const dialog = await openModelRegistry();
        const editor = await openProviderEditor(dialog);
        const unsavedName = `${providerName} 切换未保存`;
        await editor.getByLabel("服务商名称").fill(unsavedName);

        let dismissCount = 0;
        page.once("dialog", (confirmation) => {
          dismissCount += 1;
          void confirmation.dismiss();
        });
        await dialog.getByRole("navigation", { name: "设置分组" })
          .getByRole("button", { name: /^全局默认值/ })
          .click();
        expect(dismissCount).toBe(1);
        await expect(dialog.getByRole("heading", { name: "模型注册表" })).toBeVisible();
        await expect(dialog.getByRole("region", { name: "服务商编辑器" }).getByLabel("服务商名称"))
          .toHaveValue(unsavedName);

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

        const reopened = await openModelRegistry();
        await openProviderEditor(reopened);
        await expect(reopened.getByRole("region", { name: "服务商编辑器" }).getByLabel("服务商名称"))
          .toHaveValue(providerName);
        await reopened.getByRole("button", { name: "取消并关闭" }).filter({ hasText: "取消并关闭" }).click();
        await expect(reopened).toBeHidden();
      },
    );

    await journey.step(
      "底部保存准确提交草稿，不误报未保存",
      "再次修改服务商名称后点对话框底部“保存”：PUT 命中当前 Provider、无任何确认弹窗、对话框保持打开且新名称可见；"
      + "随后“取消并关闭”不再出现未保存确认，重开后仍是新名称。",
      async () => {
        const dialog = await openModelRegistry();
        const editor = await openProviderEditor(dialog);
        const savedName = `${providerName} 已保存`;
        await editor.getByLabel("服务商名称").fill(savedName);

        const providerPath = `/api/providers/${encodeURIComponent(provider!.id)}`;
        const saveResponse = page.waitForResponse((response) => response.request().method() === "PUT"
          && new URL(response.url()).pathname === providerPath);
        let unexpectedConfirmation = 0;
        const countDialog = (confirmation: import("@playwright/test").Dialog) => { unexpectedConfirmation += 1; };
        page.on("dialog", countDialog);
        await dialog.locator(".system-config-footer").getByRole("button", { name: "保存", exact: true }).click();
        expect((await saveResponse).ok()).toBe(true);
        page.off("dialog", countDialog);
        expect(unexpectedConfirmation).toBe(0);
        // 保存成功后服务商编辑器自动收起、行内名称更新为新值。
        await expect(dialog.getByRole("region", { name: "服务商编辑器" })).toHaveCount(0);
        await expect(dialog.locator(".provider-row").filter({ hasText: savedName })).toBeVisible();

        let closeConfirmation = 0;
        const countCloseDialog = (confirmation: import("@playwright/test").Dialog) => {
          closeConfirmation += 1;
          void confirmation.dismiss();
        };
        page.on("dialog", countCloseDialog);
        await dialog.getByRole("button", { name: "取消并关闭" }).filter({ hasText: "取消并关闭" }).click();
        await expect(dialog).toBeHidden();
        page.off("dialog", countCloseDialog);
        expect(closeConfirmation).toBe(0);

        const reopened = await openModelRegistry();
        await openProviderEditor(reopened);
        await expect(reopened.getByRole("region", { name: "服务商编辑器" }).getByLabel("服务商名称"))
          .toHaveValue(savedName);
        await reopened.getByRole("button", { name: "取消并关闭" }).filter({ hasText: "取消并关闭" }).click();
        await expect(reopened).toBeHidden();
      },
    );
  } finally {
    const modelIds = model ? [model.id] : [];
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