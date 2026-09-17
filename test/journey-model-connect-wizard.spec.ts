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

import { test } from "./helpers/e2e.ts";

test.use({ locale: "zh-CN" });

/**
 * E2E-META
 * Purpose: 一步式模型连接向导（GitCode #92 / GitHub #39）：支持快捷选择预置服务商（如 DeepSeek、智谱等）
 *   或自定义服务商；提供直达官方 API Key 获取链接与按量计费提醒；一键“测试并启用”自动测通、注册推荐模型并设为
 *   全局默认任务模型；测通失败时保留输入并提示友好错误；并可无缝切换回高级手动配置。
 * Steps:
 *   1. 打开系统设置并进入模型注册表，验证“一步连接向导”开关存在。
 *   2. 点击展开一步式模型连接向导，验证向导标题、说明、服务商下拉、官方 Key 获取链接与计费说明。
 *   3. 切换不同预置服务商（如 DeepSeek、智谱 GLM、OpenAI），验证官方 Key 链接与推荐主模型标签联动更新。
 *   4. 选择自定义服务商，验证自定义名称、基础 URL 和模型 ID 输入框出现。
 *   5. 未填写必填项时点击“测试并启用”，验证前端校验阻止提交并给出明确提示。
 *   6. 点击“使用高级手动配置”，向导收起并平滑切回完整的服务商列表与手动添加面板。
 * Environment: Isolated local stack at E2E_BASE_URL with isolated data dir.
 * Type: mocked
 * LLM: none — 纯 UI 交互与向导状态流转验证。
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none
 * Credentials: E2E_API_TOKEN
 * CostSideEffects: none
 */
test("一步式模型连接向导快捷配置与失败恢复", { tag: "@mocked" }, async ({ journey, page }) => {
  test.setTimeout(120_000);
  journey.scenario({
    goal: "用户通过一步式模型连接向导快速配置首选大模型：验证直达链接、计费提示、字段联动、校验拦截与手动模式切换。",
    preconditions: [
      "隔离栈已启动，浏览器已持有访问令牌",
      "界面语言为 zh-CN",
      "mocked 纯前端交互验证，不发起真实外部大模型计费调用",
    ],
  });
  await page.addInitScript(() => window.localStorage.setItem("science-agent-locale", "zh-CN"));

  const openModelRegistry = async () => {
    const dialog = page.getByRole("dialog", { name: "系统设置" });
    if (!await dialog.isVisible()) {
      await page.getByRole("button", { name: /^系统设置/ }).click();
    }
    await expect(dialog).toBeVisible();
    const navigation = dialog.getByRole("navigation", { name: "设置分组" });
    if (!await navigation.isVisible()) await dialog.getByRole("button", { name: /^设置目录/ }).click();
    await navigation.getByRole("button", { name: /^模型注册表/ }).click();
    return dialog;
  };

  await journey.step(
    "打开模型注册表并展开一步式向导",
    "系统设置对话框中可见模型注册表与一步向导触发按钮，点击后向导卡片展开。",
    async () => {
      await page.goto("/");
      await expect(page).toHaveTitle("ScienceDiscovery");
      const dialog = await openModelRegistry();
      await expect(dialog.getByRole("heading", { name: "模型注册表" })).toBeVisible();

      // 向导开关按钮存在于标题栏
      const wizardToggle = dialog.getByRole("button", { name: /一步连接向导/ });
      await expect(wizardToggle).toBeVisible();
      await wizardToggle.click();

      // 向导容器渲染
      const wizardSection = dialog.locator(".model-connect-wizard");
      await expect(wizardSection).toBeVisible();
      await expect(wizardSection.getByRole("heading", { name: "一步式模型连接向导" })).toBeVisible();
      await expect(wizardSection.getByText("选择服务商并填入 API Key，自动完成连通性测试并启用为默认模型。")).toBeVisible();
    },
  );

  await journey.step(
    "检查预置服务商联动、官方 Key 链接与计费提示",
    "默认选中 DeepSeek，展示官方注册链接与计费说明；切换至智谱后链接与推荐模型同步更新。",
    async () => {
      const dialog = page.getByRole("dialog", { name: "系统设置" });
      const wizardSection = dialog.locator(".model-connect-wizard");

      // 预置默认 DeepSeek
      const keyLink = wizardSection.locator(".wizard-key-link");
      await expect(keyLink).toBeVisible();
      await expect(keyLink).toHaveAttribute("href", "https://platform.deepseek.com/api_keys");
      await expect(keyLink).toContainText("前往 DeepSeek 获取 API Key");

      // 计费提示
      await expect(wizardSection.locator(".wizard-billing-notice")).toContainText("调用模型将按服务商标准计费");

      // 推荐模型徽章
      await expect(wizardSection.locator(".wizard-model-preview")).toContainText("deepseek-chat");

      // 切换服务商为智谱 GLM
      const select = wizardSection.locator("#wizard-provider-select");
      await select.selectOption("zhipu");

      // 智谱专属链接与推荐模型
      await expect(keyLink).toHaveAttribute("href", "https://open.bigmodel.cn/usercenter/apikeys");
      await expect(keyLink).toContainText("前往 智谱 GLM 获取 API Key");
      await expect(wizardSection.locator(".wizard-model-preview")).toContainText("glm-4-plus");
    },
  );

  await journey.step(
    "验证未填 Key 前端校验与自定义服务商选项",
    "未输入 API Key 时点击提交会被前端拦截；切换至自定义服务商时展现完整连接字段。",
    async () => {
      const dialog = page.getByRole("dialog", { name: "系统设置" });
      const wizardSection = dialog.locator(".model-connect-wizard");

      // 点击测试并启用，触发未填 Key 拦截
      const submitBtn = wizardSection.locator(".wizard-submit-button");
      await submitBtn.click();
      await expect(wizardSection.locator(".wizard-alert-error")).toContainText("请填写 API Key。");

      // 切换为自定义服务商
      const select = wizardSection.locator("#wizard-provider-select");
      await select.selectOption("custom");

      // 自定义配置网格出现
      await expect(wizardSection.locator("#wizard-custom-name")).toBeVisible();
      await expect(wizardSection.locator("#wizard-custom-url")).toBeVisible();
      await expect(wizardSection.locator("#wizard-custom-model")).toBeVisible();
    },
  );

  await journey.step(
    "收起向导并切换至高级手动配置",
    "点击向导内的收起按钮或顶部开关，向导平滑收起，保留高级手动配置界面。",
    async () => {
      const dialog = page.getByRole("dialog", { name: "系统设置" });
      const wizardSection = dialog.locator(".model-connect-wizard");

      // 点击向导中的“使用高级手动配置”
      const manualModeBtn = wizardSection.getByRole("button", { name: "使用高级手动配置" });
      await manualModeBtn.click();

      // 向导收起
      await expect(wizardSection).toHaveCount(0);

      // 高级服务商列表依然可用
      await expect(dialog.getByRole("heading", { name: "已配置的服务商" })).toBeVisible();
      await expect(dialog.getByRole("button", { name: /添加 Provider/ }).first()).toBeVisible();
    },
  );
});
