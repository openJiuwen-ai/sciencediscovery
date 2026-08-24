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

import { expect } from "@playwright/test";

import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { test } from "./helpers/e2e.ts";

test.use({ locale: "zh-CN" });

/**
 * E2E-META
 * Purpose: 模型设置分组紧凑表单——支持思考的配置同屏可配，高级模型草稿在关闭/保存失败时可恢复，模型卡片可扫读，桌面与窄屏布局可用。
 * Steps:
 *   1. 打开系统设置并进入模型注册表，确认这是配置模型的位置。
 *   2. 新建模型：身份/接口/思考/访问分组清楚；OpenAI 标准不展示会被 wire 忽略的思考控件并说明原因。
 *   3. 选择 DeepSeek 变种：出现行为提示，开启思考后强度可选、选最大。
 *   4. 换成 OpenAI 标准变种：思考模式与强度均隐藏并出现准确原因；换回 DeepSeek 后可重新配置合法值。
 *   5. 填写身份与凭证并保存，再打开模型注册表，卡片徽标可扫读变种/思考/密钥状态。
 *   6. 再次打开该模型的编辑，四个配置值与保存时一致。
 *   7. 修改名称与协议后按 Escape；取消丢弃会保留草稿，确认丢弃后重开恢复已保存值。
 *   8. 底部保存失败时保留模型草稿与错误；修正后“保存并关闭”提交同一草稿。
 *   9. 窄屏（600px）下设置对话框单列排布、控件不越界、四个配置仍可达。
 * Environment: Isolated local stack at E2E_BASE_URL with isolated data dir；空模型目录由本旅程自建并清理。
 * Type: mocked
 * LLM: none — 仅配置模型配置并回读，不发起点模型调用。
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — 非本地浏览器请求被拦截；令牌为本地演示值。
 * Credentials: E2E_API_TOKEN（隔离实例）与新建模型的本地演示令牌（无外部访问）。
 * CostSideEffects: none；创建的模型记录在 finally 中删除。
 */
test("J6 模型设置分组紧凑、可扫读且窄屏可用", { tag: "@mocked" }, async ({ journey, page }) => {
  test.setTimeout(180_000);
  journey.scenario({
    goal: "一位用户要为模型服务商配置策略，先确认模型设置的入口与分组清楚可读，"
      + "再验证不同变种的思考能力、模型卡片、未保存草稿保护和失败恢复，并确认桌面和窄屏下都整齐可用。",
    preconditions: [
      "隔离栈已启动，浏览器已持有本实例的访问 token",
      "实例内没有可用模型；新建的模型由本旅程创建并在结束时清理",
      "浏览器与界面语言均为 zh-CN",
      "mocked：仅配置模型配置并回读，不发起任何模型调用",
    ],
  });
  await page.addInitScript(() => window.localStorage.setItem("science-agent-locale", "zh-CN"));

  const modelName = `J6 紧凑配置 ${Date.now()}`;
  const demoToken = "sk-e2e-demo-local";
  let createdModelId: string | undefined;

  const openModelRegistry = async () => {
    await page.getByRole("button", { name: /^系统设置/ }).click();
    const dialog = page.getByRole("dialog", { name: "系统设置" });
    await dialog.getByRole("navigation", { name: "设置分组" })
      .getByRole("button", { name: /^模型注册表/ })
      .click();
    const advancedProfiles = dialog.locator("details.provider-advanced-profiles");
    if (await advancedProfiles.getAttribute("open") === null) {
      await advancedProfiles.locator(":scope > summary").click();
    }
    return dialog;
  };

  try {
    await journey.step(
      "打开系统设置里的模型注册表",
      "在系统设置左侧能看到「模型注册表」分组并高亮，右侧出现标题、说明、已配置模型列表与「+ 添加模型」按钮，说明这里就是配置模型的地方。",
      async () => {
        await page.goto("/");
        await expect(page).toHaveTitle("ScienceDiscovery");
        const dialog = await openModelRegistry();
        await expect(dialog.getByRole("heading", { name: "模型注册表" })).toBeVisible();
        await expect(dialog.getByText("管理运行时设置可用的模型配置和凭证。")).toBeVisible();
        await expect(dialog.getByText("已配置模型")).toBeVisible();
        await expect(dialog.getByRole("button", { name: "+ 添加模型" })).toBeVisible();
        const nav = dialog.getByRole("navigation", { name: "设置分组" })
          .getByRole("button", { name: /^模型注册表/ });
        await expect(nav).toHaveAttribute("aria-current", "page");
      },
    );

    await journey.step(
      "新建标准 OpenAI 模型时不提供无效思考开关",
      "「+ 添加模型」后出现身份信息/接口/思考/访问与能力分组；基础接口与接口变种同行。"
      + "OpenAI 标准没有可发送的思考控制字段，因此思考模式和强度都不显示，并给出不会保存无效配置的准确原因。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await dialog.getByRole("button", { name: "+ 添加模型" }).click();
        for (const heading of ["身份信息", "接口", "思考", "访问与能力"]) {
          await expect(dialog.getByRole("heading", { name: heading, exact: true })).toBeVisible();
        }
        await expect(dialog.getByLabel("显示名称")).toBeInViewport();
        await dialog.getByLabel("接口变种").scrollIntoViewIfNeeded();
        for (const label of ["基础接口", "接口变种"]) {
          await expect(dialog.getByLabel(label)).toBeInViewport();
        }
        await expect(dialog.getByLabel("思考开关")).toHaveCount(0);
        await expect(dialog.getByLabel("思考强度")).toHaveCount(0);
        await expect(dialog.getByText("此接口变种没有思考控制字段。服务商会忽略思考开关与强度，因此不会保存这些设置。")).toBeVisible();
        const pairings = await dialog.evaluate(() => {
          const rowOf = (label: string) => {
            const s = Array.from(document.querySelectorAll(".config-panel label > span"))
              .find((x) => x.textContent.trim() === label);
            return s ? s.parentElement.getBoundingClientRect() : null;
          };
          const api = rowOf("基础接口");
          const variant = rowOf("接口变种");
          return {
            apiVariantSameRow: api && variant && Math.abs(api.top - variant.top) < 2,
          };
        });
        expect(pairings.apiVariantSameRow).toBe(true);
      },
    );

    await journey.step(
      "选 DeepSeek 变种：开启思考并选最大",
      "变种选 DeepSeek 后出现行为提示「发送思考开关与强度；回复以 reasoning_content 流式返回」。"
      + "思考开启前提示「仅在思考开关为『开启』时发送」；开启思考并选「最大」后强度生效。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await dialog.getByLabel("接口变种").selectOption("deepseek");
        await expect(dialog.getByText("发送思考开关与强度；回复以 reasoning_content 流式返回。")).toBeVisible();
        await expect(dialog.getByText("仅在思考开关为“开启”时发送。")).toBeVisible();
        const effort = dialog.getByLabel("思考强度");
        await dialog.getByLabel("思考开关").selectOption("enabled");
        await effort.selectOption("max");
        await expect(effort).toBeEnabled();
        await expect(effort).toHaveValue("max");
        await expect(dialog.getByText("仅在思考开关为“开启”时发送。")).toBeHidden();
        const pairings = await dialog.evaluate(() => {
          const rowOf = (label: string) => Array.from(document.querySelectorAll(".config-panel label > span"))
            .find((node) => node.textContent?.trim() === label)?.parentElement?.getBoundingClientRect();
          const mode = rowOf("思考开关");
          const effortRect = rowOf("思考强度");
          return Boolean(mode && effortRect && Math.abs(mode.top - effortRect.top) < 2);
        });
        expect(pairings).toBe(true);
      },
    );

    await journey.step(
      "换 OpenAI 标准变种：无效思考配置不可保存",
      "换到 OpenAI 标准后，思考开关与强度都隐藏，并说明服务商会忽略这些字段；"
      + "换回 DeepSeek 后可重新开启思考并选择最大强度。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await dialog.getByLabel("接口变种").selectOption("openai");
        await expect(dialog.getByLabel("思考开关")).toHaveCount(0);
        await expect(dialog.getByLabel("思考强度")).toHaveCount(0);
        await expect(dialog.getByText("此接口变种没有思考控制字段。服务商会忽略思考开关与强度，因此不会保存这些设置。")).toBeVisible();
        await expect(dialog.getByText("标准 Chat Completions 请求，不发送思考控制字段。")).toBeVisible();
        await dialog.getByLabel("接口变种").selectOption("deepseek");
        await dialog.getByLabel("思考开关").selectOption("enabled");
        await dialog.getByLabel("思考强度").selectOption("max");
        await expect(dialog.getByLabel("思考强度")).toHaveValue("max");
      },
    );

    await journey.step(
      "填写并保存模型，卡片徽标可扫读",
      "填好显示名称、基础 URL/模型 ID 与演示令牌并保存关闭；重新打开模型注册表，列表卡片一行内可扫读 DeepSeek 变种徽标、"
      + "「开启 · 最大」思考徽标，且不出现「缺少密钥」警示徽标、密钥状态点为已保存。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await dialog.getByLabel("显示名称").fill(modelName);
        await dialog.getByLabel("Chat Completions 基础 URL").fill("http://127.0.0.1:4321/v1");
        await dialog.getByLabel("模型 ID").fill("deepseek-chat");
        await dialog.getByLabel("LLM API 令牌").fill(demoToken);
        const modelResponsePromise = page.waitForResponse((response) =>
          response.request().method() === "POST" && new URL(response.url()).pathname === "/api/models");
        await dialog.getByRole("button", { name: "保存并关闭" }).click();
        const created = await (await modelResponsePromise).json() as { id: string };
        createdModelId = created.id;
        await expect(dialog).toBeHidden();

        const reopened = await openModelRegistry();
        const card = reopened.locator(".model-card").filter({ hasText: modelName });
        await expect(card).toBeVisible();
        await expect(card).toContainText("DeepSeek");
        await expect(card).toContainText("开启 · 最大");
        await expect(card.locator(".model-badge.warning")).toHaveCount(0);
        await expect(card.locator(".model-status")).not.toHaveClass(/missing/);
      },
    );

    await journey.step(
      "再次打开编辑，四个值与保存时一致",
      "点开列表中的模型卡片，基础接口=OpenAI Chat Completions、接口变种=DeepSeek、思考开关=开启、思考强度=最大，与保存时一致。",
      async () => {
        // 上一步保存后对话框仍开着、已展示模型列表，直接点卡片进入编辑。
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await dialog.locator(".model-card").filter({ hasText: modelName }).click();
        await expect(dialog.getByLabel("基础接口")).toHaveValue("openai-chat-completions");
        await expect(dialog.getByLabel("接口变种")).toHaveValue("deepseek");
        await expect(dialog.getByLabel("思考开关")).toHaveValue("enabled");
        await expect(dialog.getByLabel("思考强度")).toHaveValue("max");
      },
    );

    await journey.step(
      "Escape 取消关闭保留草稿，确认丢弃后恢复已保存值",
      "修改高级模型的名称与基础接口后按 Escape，只出现一次作用域明确的“高级模型修改”确认。选择继续编辑时对话框和两个修改都保留；再次 Escape 并明确丢弃后关闭，重开显示此前已保存的名称和 Chat Completions 协议。",
      async () => {
        let dialog = page.getByRole("dialog", { name: "系统设置" });
        const unsavedName = modelName + " 未保存";
        await dialog.getByLabel("显示名称").fill(unsavedName);
        await dialog.getByLabel("基础接口").selectOption("openai-responses");

        let confirmationMessage = "";
        page.once("dialog", (confirmation) => {
          confirmationMessage = confirmation.message();
          void confirmation.dismiss();
        });
        await page.keyboard.press("Escape");
        expect(confirmationMessage).toContain("放弃尚未保存的高级模型修改");
        await expect(dialog).toBeVisible();
        await expect(dialog.getByLabel("显示名称")).toHaveValue(unsavedName);
        await expect(dialog.getByLabel("基础接口")).toHaveValue("openai-responses");

        page.once("dialog", (confirmation) => void confirmation.accept());
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();

        dialog = await openModelRegistry();
        await dialog.locator(".model-card").filter({ hasText: modelName }).click();
        await expect(dialog.getByLabel("显示名称")).toHaveValue(modelName);
        await expect(dialog.getByLabel("基础接口")).toHaveValue("openai-chat-completions");
        await expect(dialog.getByLabel("接口变种")).toHaveValue("deepseek");
      },
    );

    await journey.step(
      "底部保存失败保留草稿，重试保存并关闭提交同一修改",
      "修改名称与协议后点击底部“保存”，本地故障注入返回失败；设置保持打开、错误清楚可见且两个修改仍在。恢复本地 API 后把协议改回 DeepSeek，点击“保存并关闭”成功；重开后新名称和合法协议都已保存。",
      async () => {
        let dialog = page.getByRole("dialog", { name: "系统设置" });
        const updatedName = modelName + " 已更新";
        await dialog.getByLabel("显示名称").fill(updatedName);
        await dialog.getByLabel("基础接口").selectOption("openai-responses");
        const modelPath = "/api/models/" + encodeURIComponent(createdModelId!);
        const modelUrl = (url: URL) => url.pathname === modelPath;
        const failSave = async (route: import("@playwright/test").Route) => {
          await route.fulfill({
            body: JSON.stringify({ error: "fixture model save denied" }),
            contentType: "application/json",
            status: 500,
          });
        };
        await page.route(modelUrl, failSave);
        await dialog.getByRole("button", { name: "保存", exact: true }).click();
        await expect(dialog.getByText(/fixture model save denied/)).toBeVisible();
        await expect(dialog.getByLabel("显示名称")).toHaveValue(updatedName);
        await expect(dialog.getByLabel("基础接口")).toHaveValue("openai-responses");
        await page.unroute(modelUrl, failSave);

        await dialog.getByLabel("基础接口").selectOption("openai-chat-completions");
        await dialog.getByLabel("接口变种").selectOption("deepseek");
        const saveResponse = page.waitForResponse((response) =>
          response.request().method() === "PUT" && new URL(response.url()).pathname === modelPath);
        await dialog.getByRole("button", { name: "保存并关闭" }).click();
        expect((await saveResponse).ok()).toBe(true);
        await expect(dialog).toBeHidden();

        dialog = await openModelRegistry();
        await dialog.locator(".model-card").filter({ hasText: updatedName }).click();
        await expect(dialog.getByLabel("显示名称")).toHaveValue(updatedName);
        await expect(dialog.getByLabel("基础接口")).toHaveValue("openai-chat-completions");
        await expect(dialog.getByLabel("接口变种")).toHaveValue("deepseek");
        await dialog.locator(".system-config-footer").getByRole("button", { name: "取消并关闭" }).click();
        await expect(dialog).toBeHidden();
      },
    );

    await journey.step(
      "窄屏下设置对话框仍整齐可用",
      "视口收到约 600px 宽后重新打开设置：对话框不超出屏幕、页面无横向滚动；表单行变为单列排布，"
      + "四个配置下拉框两端都不超出对话框右缘，且滚动后仍可在同一画面看到四个配置项。",
      async () => {
        await page.setViewportSize({ width: 600, height: 900 });
        const dialog = await openModelRegistry();
        await dialog.locator(".model-card").filter({ hasText: modelName + " 已更新" }).click();
        const geometry = await dialog.evaluate(() => {
          const d = document.querySelector(".system-config-dialog").getBoundingClientRect();
          const labelRowTop = (label: string) => {
            const s = Array.from(document.querySelectorAll(".config-panel label > span"))
              .find((x) => x.textContent.trim() === label);
            return s ? s.parentElement.getBoundingClientRect().top : null;
          };
          const selectsInDialog = Array.from(document.querySelectorAll(".model-editor select"))
            .every((el) => {
              const b = el.getBoundingClientRect();
              return b.right <= d.right + 1 && b.left >= d.left - 1;
            });
          const apiTop = labelRowTop("基础接口");
          const variantTop = labelRowTop("接口变种");
          return {
            vw: window.innerWidth,
            dialogRight: Math.round(d.right),
            dialogWidth: Math.round(d.width),
            docScrollW: document.documentElement.scrollWidth,
            singleColumn: apiTop != null && variantTop != null && Math.abs(apiTop - variantTop) > 2,
            selectsInDialog,
          };
        });
        expect(geometry.dialogRight).toBeLessThanOrEqual(geometry.vw + 1);
        expect(geometry.docScrollW).toBeLessThanOrEqual(geometry.vw + 1);
        expect(geometry.singleColumn).toBe(true);
        expect(geometry.selectsInDialog).toBe(true);
        await dialog.getByLabel("思考强度").scrollIntoViewIfNeeded();
        for (const label of ["基础接口", "接口变种", "思考开关", "思考强度"]) {
          await expect(dialog.getByLabel(label)).toBeInViewport();
        }
        await expect(dialog.getByLabel("思考强度")).toHaveValue("max");
      },
    );
  } finally {
    if (createdModelId) {
      // 新建的第一个模型会被设为全局默认（写入 runtime settings 引用），
      // 删除前先清除 settings 中的 modelId/reviewModelId 引用，与 journeys.ts
      // deleteJourneyModel 保持一致。
      try {
        const settings = await page.request
          .fetch(`${apiBaseUrl()}/api/settings`, { headers: authorizationHeader() })
          .then(async (response) => response.ok() ? response.json() as Promise<{ overrides?: Record<string, unknown> }> : undefined);
        if (settings?.overrides) {
          const overrides = { ...settings.overrides };
          let changed = false;
          for (const key of ["modelId", "reviewModelId"]) {
            if (overrides[key] === createdModelId) {
              delete overrides[key];
              changed = true;
            }
          }
          if (changed) await page.request.fetch(`${apiBaseUrl()}/api/settings`, {
            data: overrides,
            headers: authorizationHeader(),
            method: "PUT",
          });
        }
      } catch { /* best-effort */ }
      await page.request
        .fetch(`${apiBaseUrl()}/api/models/${encodeURIComponent(createdModelId)}`, {
          headers: authorizationHeader(),
          method: "DELETE",
        })
        .then((response) => expect(response.ok()).toBe(true))
        .catch(() => undefined);
    }
    if (process.env.E2E_SCREENSHOTS) {
      await page.setViewportSize({ width: 1280, height: 720 }).catch(() => undefined);
    }
  }
});
