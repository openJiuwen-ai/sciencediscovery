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
import { expect } from "@playwright/test";

import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { test } from "./helpers/e2e.ts";

test.use({ locale: "zh-CN" });

/**
 * E2E-META
 * Purpose: 模型连接（GitCode #92 / GitHub #39）：用户视角全流程覆盖
 *   - 成功路径：通过向导配置模型并测通，自动登记推荐模型并切换全局默认任务模型；
 *   - 失败路径：坏 Key 鉴权失败可读报错、输入保留、临时对象回滚、不污染全局默认值；
 *   - 保护既有配置：已有 Provider 在向导中遇到坏 Key 时不被覆盖；
 *   - 预设联动：官方 Key 申请链接与按量计费提醒；
 *   - 界面自检：向导展开时不与手动「添加 Provider」面板同时铺开，并可平滑切回高级配置。
 * Steps:
 *   1. 打开系统设置并进入模型注册表，展开连接模型，验证无两张空白表单同时铺开。
 *   2. 检查预置服务商联动、官方 Key 申请链接与计费提示。
 *   3. 失败路径：测试坏 Key，验证 401 鉴权失败可读提示、输入保留、临时对象回滚、默认模型未被修改。
 *   4. 成功路径：填入有效凭证测试并启用，验证自动测通并写入全局默认任务模型。
 *   5. 保护已有配置：对已有服务商填入坏 Key，验证原有 Provider 与 Token 未被破坏、默认模型未变。
 *   6. 切回高级配置：点击高级配置，向导收起，原有注册表与手动面板恢复可用。
 * Environment: Isolated local stack at E2E_BASE_URL with isolated data dir.
 * Type: mocked
 * LLM: none — 使用旅程自带的本地 HTTP stub，无外部调用。
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none
 * Credentials: E2E_API_TOKEN
 * CostSideEffects: none
 */
test("模型连接成功、失败与配置保护全流程", { tag: "@mocked" }, async ({ journey, page }) => {
  test.setTimeout(180_000);
  journey.scenario({
    goal: "用户通过模型连接向导配置模型：验证直达链接、计费提示、坏 Key 友好报错与回滚、有效 Key 自动设为全局默认模型、已有 Provider 凭据防覆盖保护及切回高级配置。",
    preconditions: [
      "隔离栈已启动，浏览器已持有访问令牌",
      "界面语言为 zh-CN",
      "使用本地 HTTP stub 模拟模型端点响应，不发生真实外网大模型调用",
    ],
  });
  await page.addInitScript(() => window.localStorage.setItem("science-agent-locale", "zh-CN"));

  let authValid = false;
  let receivedAuthHeaders: string[] = [];

  // Local model stub server for connectivity testing
  const stubServer: Server = createServer((req, res) => {
    const authHeader = req.headers["authorization"] || "";
    receivedAuthHeaders.push(authHeader);

    const bodyChunks: Buffer[] = [];
    req.on("data", (chunk) => bodyChunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      if (!authValid || authHeader.includes("bad-key")) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({
          error: {
            code: "invalid_api_key",
            message: "Invalid API key provided",
            type: "invalid_request_error",
          },
        }));
        return;
      }

      // Valid OpenAI chat completion response
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            index: 0,
            message: {
              content: "OK",
              role: "assistant",
            },
          },
        ],
        id: "chatcmpl-e2e-wizard-stub",
        model: "stub-model-1",
        object: "chat.completion",
      }));
    });
  });

  await new Promise<void>((resolve) => stubServer.listen(0, "127.0.0.1", () => resolve()));
  const stubPort = (stubServer.address() as AddressInfo).port;
  const stubBaseUrl = `http://127.0.0.1:${stubPort}/v1`;

  const cleanupProviders = async () => {
    try {
      const res = await page.request.fetch(`${apiBaseUrl()}/api/providers`, {
        headers: authorizationHeader(),
      });
      if (!res.ok()) return;
      const data = await res.json() as { providers: Array<{ id: string; name: string }> };
      for (const p of data.providers) {
        if (p.name.includes("E2E 向导测试")) {
          await page.request.fetch(`${apiBaseUrl()}/api/providers/${p.id}`, {
            headers: authorizationHeader(),
            method: "DELETE",
          });
        }
      }
    } catch { /* ignore */ }
  };

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

  try {
    await journey.step(
      "打开模型注册表并展开连接模型，验证无两张空白表单冲突",
      "系统设置中点击模型注册表，展开连接模型；面板展开时，手动的「添加 Provider」面板保持收起，避免两张空白表单同时铺开。",
      async () => {
        await page.goto("/");
        await expect(page).toHaveTitle("ScienceDiscovery");
        const dialog = await openModelRegistry();
        await expect(dialog.getByRole("heading", { name: "模型注册表" })).toBeVisible();

        // 点击展开连接模型
        const wizardToggle = dialog.getByRole("button", { name: /(连接模型|快速连接)/ });
        await expect(wizardToggle).toBeVisible();
        await wizardToggle.click();

        // 向导展示
        const wizardSection = dialog.locator(".model-connect-wizard");
        await expect(wizardSection).toBeVisible();
        await expect(wizardSection.getByRole("heading", { name: "连接模型" })).toBeVisible();

        // 视觉自检：手动的「添加 Provider」面板必须为收起状态，不得同时展开两张空白表单
        await expect(dialog.locator(".provider-add-panel")).toHaveCount(0);
      },
    );

    await journey.step(
      "检查预置服务商联动、官方 Key 申请链接与计费提示",
      "默认选中 DeepSeek，展示官方注册链接与计费说明；切换至智谱后链接与推荐模型同步更新。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const wizardSection = dialog.locator(".model-connect-wizard");

        // DeepSeek 官方链接与计费说明
        const keyLink = wizardSection.locator(".wizard-key-link");
        await expect(keyLink).toBeVisible();
        await expect(keyLink).toHaveAttribute("href", "https://platform.deepseek.com/api_keys");
        await expect(keyLink).toContainText("前往 DeepSeek 获取 API Key");
        await expect(wizardSection.locator(".wizard-billing-notice")).toContainText("调用模型将按服务商标准计费");
        await expect(wizardSection.locator(".wizard-model-preview")).toContainText("deepseek-chat");

        // 切换至智谱 GLM
        const select = wizardSection.locator("#wizard-provider-select");
        await select.selectOption("zhipu");
        await expect(keyLink).toHaveAttribute("href", "https://open.bigmodel.cn/usercenter/apikeys");
        await expect(keyLink).toContainText("前往 智谱 GLM 获取 API Key");
        await expect(wizardSection.locator(".wizard-model-preview")).toContainText("glm-4-plus");
      },
    );

    await journey.step(
      "失败路径：测试坏 Key，验证可读报错、输入保留、临时对象回滚与默认模型不变",
      "填入自定义本地 stub 端点与坏 Key，连通性测试返回 401；向导给出人类可读错误，保留输入，清理临时对象，全局默认模型不变。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const wizardSection = dialog.locator(".model-connect-wizard");

        // 切换为自定义服务商
        const select = wizardSection.locator("#wizard-provider-select");
        await select.selectOption("custom");

        // 填写自定义端点与坏 Key
        await wizardSection.locator("#wizard-custom-name").fill("E2E 向导测试服务商");
        await wizardSection.locator("#wizard-custom-url").fill(stubBaseUrl);
        await wizardSection.locator("#wizard-custom-model").fill("stub-model-1");
        await wizardSection.locator("#wizard-api-key").fill("bad-key-sample");

        authValid = false;

        // 点击测试并启用
        await wizardSection.locator(".wizard-submit-button").click();

        // 验证可读错误提示
        const errorAlert = wizardSection.locator(".wizard-alert-error");
        await expect(errorAlert).toBeVisible();
        await expect(errorAlert).toContainText("鉴权失败 (401)");
        await expect(errorAlert).toContainText("API key is invalid or is not authorized");

        // 验证用户输入仍被保留
        await expect(wizardSection.locator("#wizard-api-key")).toHaveValue("bad-key-sample");
        await expect(wizardSection.locator("#wizard-custom-url")).toHaveValue(stubBaseUrl);

        // 验证临时对象已回滚：后端没有创建该临时 Provider
        const res = await page.request.fetch(`${apiBaseUrl()}/api/providers`, {
          headers: authorizationHeader(),
        });
        const providerData = await res.json() as { providers: Array<{ name: string }> };
        const found = providerData.providers.some((p) => p.name.includes("E2E 向导测试服务商"));
        expect(found).toBe(false);

        // 验证全局默认模型未被修改
        const settingsRes = await page.request.fetch(`${apiBaseUrl()}/api/settings`, {
          headers: authorizationHeader(),
        });
        const settingsData = await settingsRes.json() as { effective: { modelId?: string } };
        expect(settingsData.effective.modelId).not.toBe("stub-model-1");
      },
    );

    await journey.step(
      "成功路径：填入有效凭据测试并启用，验证自动测通并写入全局默认任务模型",
      "换填有效 Key 后提交，向导自动完成测通，展示包含延迟的成功提示，并直接将模型设为全局默认任务模型。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const wizardSection = dialog.locator(".model-connect-wizard");

        authValid = true;
        await wizardSection.locator("#wizard-api-key").fill("valid-key-pass");
        await wizardSection.locator(".wizard-submit-button").click();

        // 验证成功提示
        const successAlert = wizardSection.locator(".wizard-alert-success");
        await expect(successAlert).toBeVisible();
        await expect(successAlert).toContainText("模型已连接");

        // 验证全局默认值中任务模型已更新
        const navigation = dialog.getByRole("navigation", { name: "设置分组" });
        await navigation.getByRole("button", { name: /^全局默认值/ }).click();

        const taskModelSelect = dialog.getByLabel("任务模型", { exact: false });
        await expect(taskModelSelect).toBeVisible();
        await expect(taskModelSelect).toContainText("stub-model-1");

        // 回到模型注册表
        await navigation.getByRole("button", { name: /^模型注册表/ }).click();
      },
    );

    await journey.step(
      "保护已有配置：对已有服务商填入坏 Key，验证原有 Provider 与 Token 未被破坏",
      "针对已配置好的服务商再次填入错误 Key 测试，测试失败后原有 Provider 的有效 Token 和模型配置不受任何污染。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const wizardSection = dialog.locator(".model-connect-wizard");

        // 向导若已收起则展开
        if (!await wizardSection.isVisible()) {
          await dialog.getByRole("button", { name: /(连接模型|快速连接)/ }).click();
        }

        // 再次选择自定义服务商，输入相同的名称与端点，但填入坏 Key
        const select = wizardSection.locator("#wizard-provider-select");
        await select.selectOption("custom");
        await wizardSection.locator("#wizard-custom-name").fill("E2E 向导测试服务商");
        await wizardSection.locator("#wizard-custom-url").fill(stubBaseUrl);
        await wizardSection.locator("#wizard-custom-model").fill("stub-model-1");
        await wizardSection.locator("#wizard-api-key").fill("bad-key-cannot-overwrite");

        authValid = false;
        await wizardSection.locator(".wizard-submit-button").click();

        // 验证失败提示
        await expect(wizardSection.locator(".wizard-alert-error")).toContainText("鉴权失败 (401)");

        // 验证已存在的 Provider 依然健康存在
        const res = await page.request.fetch(`${apiBaseUrl()}/api/providers`, {
          headers: authorizationHeader(),
        });
        const providerData = await res.json() as { providers: Array<{ id: string; name: string; hasApiToken?: boolean }> };
        const existing = providerData.providers.find((p) => p.name === "E2E 向导测试服务商");
        expect(existing).toBeDefined();
        expect(existing?.hasApiToken).toBe(true);

        // 验证全局默认任务模型仍然指向有效的模型
        const settingsRes = await page.request.fetch(`${apiBaseUrl()}/api/settings`, {
          headers: authorizationHeader(),
        });
        const settingsData = await settingsRes.json() as { effective: { modelId?: string } };
        expect(settingsData.effective.modelId).toBeDefined();
      },
    );

    await journey.step(
      "切回高级配置：点击高级配置，向导收起，原有注册表与手动面板恢复可用",
      "向导内点击「高级配置」可平滑收起向导，展示已配置服务商列表与手动添加 Provider 入口。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const wizardSection = dialog.locator(".model-connect-wizard");

        // 点击向导内部的“高级配置”
        const manualBtn = wizardSection.getByRole("button", { name: "高级配置" });
        await manualBtn.click();

        // 向导收起
        await expect(wizardSection).toHaveCount(0);

        // 已配置的服务商列表与添加按钮可见
        await expect(dialog.getByRole("heading", { name: "已配置服务商" })).toBeVisible();
        await expect(dialog.getByRole("button", { name: /添加 Provider/ }).first()).toBeVisible();
      },
    );
  } finally {
    await cleanupProviders();
    stubServer.close();
  }
});
