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
import { expect, type Route } from "@playwright/test";

import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { test } from "./helpers/e2e.ts";
import { requireFirstRunState } from "./helpers/journeys.ts";

// Static suite metadata is inherited by each framework-expanded journey.
test.describe("journey-model-connect-wizard.spec", { tag: ["@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"] }, () => {

test.use({ locale: "zh-CN" });

/**
 * E2E-META
 * Purpose: 模型连接（GitCode #92 / GitHub #39）：用户视角全流程覆盖
 *   - 连接模型是唯一新建入口：注册表不再有独立的「添加 Provider」面板，空态下连接卡片默认展开；
 *   - 成功路径：通过向导配置模型并测通，自动登记该服务商模型列表的全部模型；系统里还没有模型时第一个设为全局默认任务模型；
 *   - 失败路径：坏 Key 鉴权失败可读报错、输入保留、临时对象回滚、不污染全局默认值；
 *   - 保护既有配置：已有 Provider 在向导中遇到坏 Key 时不被覆盖；
 *   - 主区手选：不开高级配置即可获取模型列表（预览接口，不落库），默认全勾即一键全加，去勾后只登记所选；
 *   - 高级配置手填：卡片内用与注册表行相同的手动表单添加模型（含上下文等事实）再连接；
 *   - 注册表内有全局默认任务模型选择器，与「全局默认值 → 任务模型」读写同一设置项、显示同步；
 *   - 高级配置：在连接卡片内展开精细字段，不收起向导、不关系统设置，与「收起」/底栏关闭互不串；
 *   - 界面自检：「高级配置」单行完整显示，label 紧贴对应输入框。
 * Steps:
 *   1. 打开模型注册表：空态下连接模型默认展开，是唯一新建入口，无独立添加面板与常驻编辑器。
 *   2. 检查预置服务商联动、官方 Key 申请链接、计费提示，以及无推荐模型展示、按钮单行、label 贴近控件。
 *   3. 失败路径：测试坏 Key，验证 401 鉴权失败可读提示、输入保留、临时对象回滚、默认模型未被修改。
 *   4. 成功路径与重复添加：模型标识留空测通后全量登记该服务商模型；系统首个模型才设全局默认；同一服务商改名换 Key 再连一次得到第二行且默认不变。
 *   5. 保护已有配置：对已有服务商填入坏 Key，本次新建整体回滚，两行已有 Provider 与 Token 未被破坏、默认模型未变。
 *   6. 主区手选：不开高级配置即可获取模型列表（预览不创建服务商）、两项默认全勾、去掉一个后「保存并连接」只登记所选，行显示已添加 1/2。
 *   7. 高级配置手填：「添加模型」展开手动表单，填 ID/名称/上下文后加入列表，「保存并连接」只登记该手填模型，事实随之保存。
 *   8. 注册表内改全局默认任务模型，与全局默认值页读写同一项、显示同步。
 *   9. 高级配置在卡片内展开精细字段：向导与系统设置都保持打开，服务商列表仍在；「收起」与底栏取消对照验证。
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
test("模型连接成功、失败与配置保护全流程", { tag: "@mocked" }, async ({ journey, page }, testInfo) => {
  test.setTimeout(180_000);
  journey.scenario({
    goal: "用户通过模型连接向导配置模型：验证直达链接、计费提示、坏 Key 友好报错与回滚、有效 Key 一键登记全部模型并在系统首个模型时设为全局默认、已有 Provider 凭据防覆盖保护，以及高级配置里获取列表手选模型、手填模型与卡内展开不串关闭路径。",
    preconditions: [
      "隔离栈已启动，浏览器已持有访问令牌",
      "实例内没有任何模型：这条旅程断言「系统首个模型设为全局默认」，"
        + "而产品只在 listModels() 为空时走那条路径。本旅程只在运行自己拥有该栈时清掉上一次运行的残留"
        + "（见 E2E_ALLOW_STACK_RESET），否则记为前置未满足",
      "界面语言为 zh-CN",
      "使用本地 HTTP stub 模拟模型端点响应，不发生真实外网大模型调用",
    ],
  });
  await page.addInitScript(() => window.localStorage.setItem("science-agent-locale", "zh-CN"));

  let authValid = false;
  let receivedAuthHeaders: string[] = [];

  // Local model stub server for connectivity testing and model listing
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

      // Model discovery listing: the wizard enables the first listed entry.
      // Note the API sorts listing entries by id, so "stub-model-alpha" is the
      // effective first item; the explicit-id steps use "stub-model-1", which
      // deliberately does not appear here.
      if (req.method === "GET" && req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          data: [
            { id: "stub-model-omega", object: "model" },
            { id: "stub-model-alpha", object: "model" },
          ],
          object: "list",
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
        model: "stub-model-alpha",
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
      const victims = data.providers.filter((p) => p.name.includes("E2E 向导测试"));
      if (!victims.length) return;
      // A provider whose model is the global default cannot be deleted, so
      // clear the overrides first, then remove the models before the provider.
      await page.request.fetch(`${apiBaseUrl()}/api/settings`, {
        data: {},
        headers: authorizationHeader(),
        method: "PUT",
      });
      const modelsRes = await page.request.fetch(`${apiBaseUrl()}/api/models`, {
        headers: authorizationHeader(),
      });
      if (modelsRes.ok()) {
        const models = await modelsRes.json() as Array<{ id: string; providerId: string }>;
        for (const model of models) {
          if (victims.some((victim) => victim.id === model.providerId)) {
            await page.request.fetch(`${apiBaseUrl()}/api/models/${model.id}`, {
              headers: authorizationHeader(),
              method: "DELETE",
            });
          }
        }
      }
      for (const p of victims) {
        await page.request.fetch(`${apiBaseUrl()}/api/providers/${p.id}`, {
          headers: authorizationHeader(),
          method: "DELETE",
        });
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
      "打开模型注册表：空态下连接模型是唯一新建入口，无独立添加面板",
      "系统设置中点击模型注册表；没有已配置服务商时连接模型卡片默认展开，作为唯一新建入口；注册表不再有独立的「添加 Provider」按钮、预置下拉或自定义表单，编辑器默认隐藏。",
      async () => {
        // 这条旅程从"空态"读起：连接卡片默认展开是首启路径，而后面那步断言
        // 「已设为全局默认任务模型」——产品只在 listModels() 为空时才这么做
        // （ModelConnectWizard 的 hadModels）。共享栈上前面的旅程已经登记过模型，
        // 于是产品正确地回「全局默认任务模型保持不变」，用例却当成失败。
        // 这道闸只清理本次运行自己拥有的栈，否则把用例记为 BLOCKED。
        await requireFirstRunState(page, testInfo);
        await page.goto("/");
        await expect(page).toHaveTitle("ScienceDiscovery");
        const dialog = await openModelRegistry();
        await expect(dialog.getByRole("heading", { name: "模型注册表" })).toBeVisible();

        // 空态下向导默认展开（首启路径）；若已收起则点标题行开关展开
        let wizardSection = dialog.locator(".model-connect-wizard");
        if (!await wizardSection.count()) {
          await dialog.getByRole("button", { name: /连接模型/ }).click();
        }
        wizardSection = dialog.locator(".model-connect-wizard");
        await expect(wizardSection).toBeVisible();
        await expect(wizardSection.getByRole("heading", { name: "连接模型" })).toBeVisible();

        // 新建入口已并入连接模型：不再有独立的添加 Provider 按钮、面板或常驻编辑器
        await expect(dialog.getByRole("button", { name: /添加 Provider/ })).toHaveCount(0);
        await expect(dialog.getByRole("region", { name: "服务商编辑器" })).toHaveCount(0);

        // 密度与非遮挡自检：默认打开无需滚动，服务商、Key、申请链接及主按钮完全在对话框可见区域内，不被底栏遮挡
        const keyInput = wizardSection.locator("#wizard-api-key");
        const submitBtn = wizardSection.locator(".wizard-submit-button");
        const manualBtn = wizardSection.getByRole("button", { name: "高级配置" });
        await expect(keyInput).toBeVisible();
        await expect(submitBtn).toBeVisible();
        await expect(manualBtn).toBeVisible();

        const footerBox = await dialog.locator(".system-config-footer").boundingBox();
        const submitBox = await submitBtn.boundingBox();
        const keyBox = await keyInput.boundingBox();
        if (footerBox && submitBox && keyBox) {
          expect(submitBox.y + submitBox.height).toBeLessThan(footerBox.y);
          expect(keyBox.y + keyBox.height).toBeLessThan(footerBox.y);
        }
      },
    );

    await journey.step(
      "检查预置服务商联动、官方 Key 申请链接、计费提示与面板排版",
      "默认选中 DeepSeek，展示官方注册链接与计费说明；面板没有推荐模型展示，「高级配置」单行完整显示，每个 label 紧贴自己的输入框；切换至智谱后链接同步更新。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const wizardSection = dialog.locator(".model-connect-wizard");

        // DeepSeek 官方链接与计费说明
        const keyLink = wizardSection.locator(".wizard-key-link");
        await expect(keyLink).toBeVisible();
        await expect(keyLink).toHaveAttribute("href", "https://platform.deepseek.com/api_keys");
        await expect(keyLink).toContainText("前往 DeepSeek 获取 API Key");
        await expect(wizardSection.locator(".wizard-billing-notice")).toContainText("调用模型将按服务商标准计费");

        // 不再有推荐模型徽章或等价展示
        await expect(wizardSection).not.toContainText("推荐模型");
        await expect(wizardSection.locator(".wizard-model-preview")).toHaveCount(0);

        // 「高级配置」单行完整显示：高度保持单行（折行会把按钮撑到两行高），宽度足以放下四个字
        const manualBtn = wizardSection.getByRole("button", { name: "高级配置" });
        const manualBox = await manualBtn.boundingBox();
        expect(manualBox).not.toBeNull();
        expect(manualBox!.height).toBeLessThanOrEqual(32);
        expect(manualBox!.width).toBeGreaterThan(50);

        // label 紧贴对应控件：API Key 与服务商的 label 下缘到输入框上缘的间距一眼能看出从属
        for (const controlId of ["wizard-api-key", "wizard-provider-select"]) {
          const labelBox = await wizardSection.locator(`label[for="${controlId}"]`).boundingBox();
          const controlBox = await wizardSection.locator(`#${controlId}`).boundingBox();
          expect(labelBox).not.toBeNull();
          expect(controlBox).not.toBeNull();
          expect(controlBox!.y - (labelBox!.y + labelBox!.height)).toBeLessThan(10);
        }

        // 切换至智谱 GLM
        const select = wizardSection.locator("#wizard-provider-select");
        await select.selectOption("zhipu");
        await expect(keyLink).toHaveAttribute("href", "https://open.bigmodel.cn/usercenter/apikeys");
        await expect(keyLink).toContainText("前往 智谱 GLM 获取 API Key");
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
      "成功路径与重复添加：全量登记模型，改名再连一次得到第二行且默认模型不变",
      "清空模型标识、换填有效 Key 后提交，向导自动把该服务商模型列表的全部模型登记进来，列表第一项测通并（在系统首个模型时）写入全局默认任务模型；同一服务商换个名字再连一次，列表出现第二行且同样全量登记，但全局默认保持不变。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const wizardSection = dialog.locator(".model-connect-wizard");

        authValid = true;
        // 模型标识留空：向导应登记该服务商模型列表的全部模型（stub 返回 alpha 与 omega 两项）
        await wizardSection.locator("#wizard-custom-model").fill("");
        await wizardSection.locator("#wizard-api-key").fill("valid-key-pass");
        await wizardSection.locator(".wizard-submit-button").click();

        // 验证成功提示：全量登记数量 + 设为默认（系统首个模型）
        const successAlert = wizardSection.locator(".wizard-alert-success");
        await expect(successAlert).toBeVisible();
        await expect(successAlert).toContainText("模型已连接");
        await expect(successAlert).toContainText("登记 2 个模型");
        await expect(successAlert).toContainText("已设为全局默认任务模型");

        // 全量登记：该服务商行显示已添加 2/2
        const firstRow = dialog.locator(".provider-row").filter({ hasText: "E2E 向导测试服务商" }).first();
        await expect(firstRow).toContainText("已添加 2/2");

        // 验证全局默认值中任务模型已更新为列表第一项，并记录该 profile id
        const navigation = dialog.getByRole("navigation", { name: "设置分组" });
        await navigation.getByRole("button", { name: /^全局默认值/ }).click();

        const taskModelSelect = dialog.getByLabel("任务模型", { exact: false });
        await expect(taskModelSelect).toBeVisible();
        await expect(taskModelSelect).toContainText("stub-model-alpha");

        const firstSettingsRes = await page.request.fetch(`${apiBaseUrl()}/api/settings`, {
          headers: authorizationHeader(),
        });
        const firstDefault = (await firstSettingsRes.json() as { effective: { modelId?: string } }).effective.modelId;
        expect(firstDefault).toBeDefined();

        // 回到模型注册表；分组切换会重挂注册表视图，向导随之收起，需重新展开
        await navigation.getByRole("button", { name: /^模型注册表/ }).click();

        // 同一服务商允许再加一次：改名字、换 Key，再「保存并连接」
        let wizardAgain = dialog.locator(".model-connect-wizard");
        if (!await wizardAgain.count()) {
          await dialog.getByRole("button", { name: /连接模型/ }).click();
          wizardAgain = dialog.locator(".model-connect-wizard");
        }
        await wizardAgain.locator("#wizard-provider-select").selectOption("custom");
        await wizardAgain.locator("#wizard-custom-name").fill("E2E 向导测试服务商二号");
        await wizardAgain.locator("#wizard-custom-url").fill(stubBaseUrl);
        // 模型标识留空：同样全量登记
        await wizardAgain.locator("#wizard-api-key").fill("valid-key-pass-2");
        await wizardAgain.locator(".wizard-submit-button").click();
        const secondSuccess = wizardAgain.locator(".wizard-alert-success");
        await expect(secondSuccess).toBeVisible();
        // 系统已有模型：提示登记数量且默认保持不变
        await expect(secondSuccess).toContainText("登记 2 个模型");
        await expect(secondSuccess).toContainText("全局默认任务模型保持不变");

        // 列表出现两行，第一行名字与凭据不变；全局默认模型 id 未变
        const res = await page.request.fetch(`${apiBaseUrl()}/api/providers`, {
          headers: authorizationHeader(),
        });
        const providerData = await res.json() as { providers: Array<{ name: string; hasApiToken?: boolean }> };
        const journeyProviders = providerData.providers.filter((p) => p.name.includes("E2E 向导测试服务商"));
        expect(journeyProviders.length).toBe(2);
        expect(journeyProviders.every((p) => p.hasApiToken)).toBe(true);

        const secondSettingsRes = await page.request.fetch(`${apiBaseUrl()}/api/settings`, {
          headers: authorizationHeader(),
        });
        const secondDefault = (await secondSettingsRes.json() as { effective: { modelId?: string } }).effective.modelId;
        expect(secondDefault).toBe(firstDefault);
      },
    );

    await journey.step(
      "预设落地：选定的厂商 endpoint、接口变种与模型列表策略原样进入创建请求",
      "选择 MiniMax 与智谱 GLM 后只填令牌并提交：创建请求必须带着该预设自己的 endpoint"
        + "（api.minimaxi.com / open.bigmodel.cn）、接口变种与 OpenAI 兼容 /models 发现策略，"
        + "而不是被向导的默认值覆盖。请求在浏览器边界被改写到本地 stub，服务端绝不访问厂商网络。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const wizardSection = dialog.locator(".model-connect-wizard");

        // 预设填进创建请求的原始值。这些断言原先只存在于 J7 的两步创建流程里，
        // 而创建已经并入连接卡片——路径换了，要守的性质没换：选了哪个厂商，
        // 建出来的 provider 就得带着那个厂商的 endpoint、变种与发现策略。
        const presets = [
          {
            apiVariant: "minimax",
            baseUrl: "https://api.minimaxi.com/v1",
            id: "minimax",
            key: "wizard-minimax-local-token",
          },
          {
            apiVariant: "deepseek",
            baseUrl: "https://open.bigmodel.cn/api/paas/v4",
            id: "zhipu",
            key: "wizard-zhipu-local-token",
          },
        ];

        for (const preset of presets) {
          let sentBody: Record<string, unknown> | undefined;
          // 捕获浏览器真正发出的 body，再把 baseUrl 改写到本地 stub 转发给 API：
          // 断言看到的是厂商原值，而服务端只会连 127.0.0.1。
          const presetRoute = async (route: Route) => {
            const request = route.request();
            const body = request.method() === "POST"
              ? request.postDataJSON() as Record<string, unknown>
              : undefined;
            if (body?.presetId !== preset.id) {
              await route.continue();
              return;
            }
            sentBody = body;
            const forwarded = await page.request.post(`${apiBaseUrl()}/api/providers`, {
              data: { ...body, baseUrl: stubBaseUrl },
              headers: authorizationHeader(),
            });
            await route.fulfill({
              body: await forwarded.body(),
              contentType: forwarded.headers()["content-type"],
              status: forwarded.status(),
            });
          };
          await page.route("**/api/providers", presetRoute);
          try {
            await wizardSection.locator("#wizard-provider-select").selectOption(preset.id);
            await wizardSection.locator("#wizard-api-key").fill(preset.key);
            await wizardSection.locator(".wizard-submit-button").click();
            await expect(wizardSection.locator(".wizard-alert-success")).toBeVisible();
          } finally {
            await page.unroute("**/api/providers", presetRoute);
          }

          expect(sentBody, `${preset.id} 的创建请求应当被捕获`).toBeDefined();
          expect(sentBody).toMatchObject({
            apiProtocol: "openai-chat-completions",
            apiVariant: preset.apiVariant,
            baseUrl: preset.baseUrl,
            modelDiscovery: "openai-models",
            presetId: preset.id,
          });
          // 令牌只进请求，不回显到响应里。
          expect(sentBody).toMatchObject({ apiToken: preset.key });
        }
      },
    );

    await journey.step(
      "保护已有配置：对已有服务商填入坏 Key，新建回滚且原有 Provider 与 Token 未被破坏",
      "针对已配置好的服务商再次填入错误 Key 提交：本次新建在测通失败后整体回滚，列表仍只有之前两行，原有 Provider 的有效 Token 和模型配置不受任何污染。",
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

        // 验证两行已有服务商依然健康存在，失败的新建已整体回滚（不会多出一行）
        const res = await page.request.fetch(`${apiBaseUrl()}/api/providers`, {
          headers: authorizationHeader(),
        });
        const providerData = await res.json() as { providers: Array<{ id: string; name: string; hasApiToken?: boolean }> };
        const journeyProviders = providerData.providers.filter((p) => p.name.includes("E2E 向导测试服务商"));
        expect(journeyProviders.length).toBe(2);
        expect(journeyProviders.every((p) => p.hasApiToken)).toBe(true);

        // 验证全局默认任务模型仍然指向有效的模型
        const settingsRes = await page.request.fetch(`${apiBaseUrl()}/api/settings`, {
          headers: authorizationHeader(),
        });
        const settingsData = await settingsRes.json() as { effective: { modelId?: string } };
        expect(settingsData.effective.modelId).toBeDefined();
      },
    );

    await journey.step(
      "主区手选：不展开高级配置就能获取模型列表，只勾选其中一个再连接",
      "连接卡片主区直接点「获取模型列表」（不必先点「高级配置」）：服务商返回的两个模型以复选框列出且默认全选（一键全加就是默认），此时后端没有新建任何服务商；去掉一个勾选后摘要变为只登记 1 个；「保存并连接」只登记所选那一个，服务商行显示已添加 1/2，全局默认不变，连接后计划清空。高级配置区仍承载服务商设置与手填模型。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const wizardSection = dialog.locator(".model-connect-wizard");
        authValid = true;

        await wizardSection.locator("#wizard-provider-select").selectOption("custom");
        await wizardSection.locator("#wizard-custom-name").fill("E2E 向导测试服务商三号");
        await wizardSection.locator("#wizard-custom-url").fill(stubBaseUrl);
        await wizardSection.locator("#wizard-custom-model").fill("");
        await wizardSection.locator("#wizard-api-key").fill("valid-key-pass-3");

        // 主区即可获取：不点「高级配置」，高级区保持关闭
        await expect(wizardSection.locator(".wizard-advanced")).toHaveCount(0);
        const fetchRow = wizardSection.locator(".wizard-fetch-side");
        await expect(fetchRow).toBeVisible();
        await expect(fetchRow.locator(".wizard-plan-summary")).toContainText("登记服务商返回的全部模型");

        // 获取列表走预览接口：用卡片里未保存的端点与 Key，不创建服务商。
        const previewResponse = page.waitForResponse((response) =>
          response.request().method() === "POST" && new URL(response.url()).pathname === "/api/providers/preview-models");
        await fetchRow.getByRole("button", { name: "获取模型列表" }).click();
        expect((await previewResponse).status()).toBe(200);
        const table = wizardSection.getByRole("table", { name: "服务商返回的模型" });
        await expect(table).toBeVisible();
        const alpha = table.getByRole("checkbox", { name: "stub-model-alpha" });
        const omega = table.getByRole("checkbox", { name: "stub-model-omega" });
        await expect(alpha).toBeChecked();
        await expect(omega).toBeChecked();
        await expect(table.getByRole("checkbox", { name: "全选" })).toBeChecked();
        await expect(table).toContainText("已选 2/2");
        await expect(fetchRow.locator(".wizard-plan-summary")).toContainText("登记 2 个模型");
        await expect(fetchRow.getByRole("button", { name: "刷新列表" })).toBeVisible();
        const beforeRes = await page.request.fetch(`${apiBaseUrl()}/api/providers`, { headers: authorizationHeader() });
        const before = (await beforeRes.json() as { providers: Array<{ name: string }> }).providers;
        expect(before.some((p) => p.name === "E2E 向导测试服务商三号")).toBe(false);

        // 高级配置区仍在，承载服务商精细字段与手填模型
        const advancedBtn = wizardSection.getByRole("button", { name: "高级配置" });
        await advancedBtn.click();
        const advanced = wizardSection.locator(".wizard-advanced");
        await expect(advanced).toBeVisible();
        await expect(advanced.getByRole("heading", { name: "服务商设置" })).toBeVisible();
        await expect(advanced.getByRole("heading", { name: "手动登记模型" })).toBeVisible();
        await advancedBtn.click();
        await expect(wizardSection.locator(".wizard-advanced")).toHaveCount(0);

        // 手选：去掉 omega，只留 alpha。
        await omega.uncheck();
        await expect(table.getByRole("checkbox", { name: "全选" })).not.toBeChecked();
        await expect(table).toContainText("已选 1/2");
        await expect(fetchRow.locator(".wizard-plan-summary")).toContainText("登记 1 个模型");

        await wizardSection.locator(".wizard-submit-button").click();
        const success = wizardSection.locator(".wizard-alert-success");
        await expect(success).toBeVisible();
        await expect(success).toContainText("登记 1 个模型");
        await expect(success).toContainText("全局默认任务模型保持不变");
        const row = dialog.locator(".provider-row").filter({ hasText: "E2E 向导测试服务商三号" });
        await expect(row).toContainText("已添加 1/2");

        // 登记的正是勾选的那一个。
        const providersRes = await page.request.fetch(`${apiBaseUrl()}/api/providers`, { headers: authorizationHeader() });
        const third = (await providersRes.json() as { providers: Array<{ id: string; name: string }> }).providers
          .find((p) => p.name === "E2E 向导测试服务商三号");
        expect(third).toBeDefined();
        const modelsRes = await page.request.fetch(`${apiBaseUrl()}/api/models`, { headers: authorizationHeader() });
        const models = await modelsRes.json() as Array<{ model: string; providerId: string }>;
        expect(models.filter((m) => m.providerId === third!.id).map((m) => m.model)).toEqual(["stub-model-alpha"]);

        // 连接后计划清空：列表表格消失，摘要回到「全部」。
        await expect(wizardSection.locator(".wizard-model-table")).toHaveCount(0);
        await expect(fetchRow.locator(".wizard-plan-summary")).toContainText("登记服务商返回的全部模型");
      },
    );

    await journey.step(
      "高级配置手填：手动添加一个模型再连接",
      "同一卡片里点「添加模型」展开与注册表行相同的手动表单，填模型 ID、名称与上下文后「加入列表」；条目带「手动」标记等待登记；「保存并连接」只登记这一个手填模型，服务商行显示已添加 1/3（列表两项加手填一项），手填的上下文随模型保存。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const wizardSection = dialog.locator(".model-connect-wizard");
        const advancedBtn = wizardSection.getByRole("button", { name: "高级配置" });
        if (await advancedBtn.getAttribute("aria-expanded") !== "true") await advancedBtn.click();
        const advanced = wizardSection.locator(".wizard-advanced");
        await expect(advanced).toBeVisible();
        await wizardSection.locator("#wizard-custom-name").fill("E2E 向导测试服务商四号");
        await wizardSection.locator("#wizard-api-key").fill("valid-key-pass-4");

        await advanced.locator(".provider-add-model-toggle").click();
        const manualForm = advanced.locator(".provider-manual-form");
        await expect(manualForm).toBeVisible();
        await manualForm.getByLabel("手动模型 ID").fill("stub-model-manual");
        await manualForm.getByLabel("模型名称（可选）").fill("手填模型");
        await manualForm.getByLabel("上下文（可选）").fill("32000");
        await manualForm.getByRole("button", { name: "加入列表" }).click();
        const manualList = advanced.getByRole("list", { name: "手动添加的模型" });
        await expect(manualList).toContainText("手填模型");
        await expect(manualList).toContainText("stub-model-manual");
        await expect(manualList).toContainText("手动");
        await expect(advanced.locator(".provider-manual-form")).toHaveCount(0);
        await expect(wizardSection.locator(".wizard-fetch-side .wizard-plan-summary")).toContainText("登记 1 个模型");

        await wizardSection.locator(".wizard-submit-button").click();
        const success = wizardSection.locator(".wizard-alert-success");
        await expect(success).toBeVisible();
        await expect(success).toContainText("登记 1 个模型");
        const row = dialog.locator(".provider-row").filter({ hasText: "E2E 向导测试服务商四号" });
        await expect(row).toContainText("已添加 1/3");

        // 手填的名称与上下文随模型登记。
        const modelsRes = await page.request.fetch(`${apiBaseUrl()}/api/models`, { headers: authorizationHeader() });
        const models = await modelsRes.json() as Array<{ facts?: { contextWindow?: number }; model: string; name: string }>;
        const manual = models.find((m) => m.model === "stub-model-manual");
        expect(manual).toBeDefined();
        expect(manual!.name).toContain("手填模型");
        expect(manual!.facts?.contextWindow).toBe(32000);
      },
    );

    await journey.step(
      "注册表内的全局默认任务模型选择器与全局默认值页读写同一设置项",
      "模型注册表顶部出现「全局默认任务模型」选择器：显示当前默认（第一次连接的模型）；改成三号服务商的模型后，「全局默认值」页的任务模型显示同一个新值，两边背后是同一个设置项。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });

        // 注册表顶部就有全局默认任务模型选择器，显示当前默认
        const registrySelect = dialog.locator("#registry-default-model");
        await expect(registrySelect).toBeVisible();
        const beforeValue = await registrySelect.inputValue();
        expect(beforeValue).not.toBe("");

        // 换一个：选择三号服务商登记的模型
        const modelsRes = await page.request.fetch(`${apiBaseUrl()}/api/models`, { headers: authorizationHeader() });
        const allModels = await modelsRes.json() as Array<{ id: string; model: string; providerId: string }>;
        const providersRes = await page.request.fetch(`${apiBaseUrl()}/api/providers`, { headers: authorizationHeader() });
        const third = (await providersRes.json() as { providers: Array<{ id: string; name: string }> }).providers
          .find((p) => p.name === "E2E 向导测试服务商三号");
        const target = allModels.find((m) => m.providerId === third!.id);
        expect(target).toBeDefined();
        await registrySelect.selectOption(target!.id);

        // API 层立即生效
        const settingsRes = await page.request.fetch(`${apiBaseUrl()}/api/settings`, { headers: authorizationHeader() });
        expect((await settingsRes.json() as { effective: { modelId?: string } }).effective.modelId).toBe(target!.id);

        // 全局默认值页的任务模型显示同一个新值——同一个设置项
        const navigation = dialog.getByRole("navigation", { name: "设置分组" });
        await navigation.getByRole("button", { name: /^全局默认值/ }).click();
        const taskModelSelect = dialog.getByLabel("任务模型", { exact: false });
        await expect(taskModelSelect).toBeVisible();
        const globalPageValue = await taskModelSelect.inputValue();
        expect(globalPageValue).toBe(target!.id);

        // 回到注册表，选择器仍显示该值（两边显示同步）
        await navigation.getByRole("button", { name: /^模型注册表/ }).click();
        await expect(dialog.locator("#registry-default-model")).toHaveValue(target!.id);
      },
    );

    await journey.step(
      "高级配置在卡片内展开精细设置：向导与系统设置都保持打开，服务商列表仍在",
      "连接模型卡片上点「高级配置」不会收起或关闭任何东西：卡片仍在，并在卡片内展开基础 URL 等精细字段；系统设置对话框仍在「模型注册表」，已配置服务商列表可见。标题行「收起」才负责收起向导，底栏「取消并关闭」才关闭对话框，三者互不串。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const wizardSection = dialog.locator(".model-connect-wizard");

        // 若向导已收起则先展开
        if (!await wizardSection.count()) {
          await dialog.getByRole("button", { name: /连接模型/ }).click();
        }

        // 自定义路径填一个新名称（无既有服务商匹配），确保「高级配置」处于展开
        await wizardSection.locator("#wizard-provider-select").selectOption("custom");
        await wizardSection.locator("#wizard-custom-name").fill(`高级配置展开检查 ${Date.now()}`);
        await wizardSection.locator("#wizard-custom-url").fill("");
        const advancedBtn = wizardSection.getByRole("button", { name: "高级配置" });
        if (await advancedBtn.getAttribute("aria-expanded") !== "true") await advancedBtn.click();

        // 关键回归：向导卡片仍在，高级字段在卡片内展开（自定义路径的协议/变种选择器）
        await expect(wizardSection).toBeVisible();
        await expect(wizardSection.locator(".wizard-advanced")).toBeVisible();
        await expect(wizardSection.locator("#wizard-api-protocol")).toBeVisible();

        // 展开后卡片增高，操作按钮被滚动留在对话框可见区域内、不压底栏
        const submitBox = await wizardSection.locator(".wizard-submit-button").boundingBox();
        const footerBox = await dialog.locator(".system-config-footer").boundingBox();
        expect(submitBox).not.toBeNull();
        expect(footerBox).not.toBeNull();
        // 量的是"按钮没有压在底栏上"。亚像素取整在不同渲染环境之间本来就会差一点：
        // 同一份布局本机量到按钮底边正好落在底栏上沿，CI 的渲染器量到 580.234px
        // 对 580px。用严格的浮点先后去表达这个性质，测的就成了渲染器而不是布局，
        // 所以给一个 CSS 像素的容差——真正的回归（按钮确实盖住底栏）是几十像素级的。
        const overlap = (submitBox!.y + submitBox!.height) - footerBox!.y;
        expect(overlap, `提交按钮压住底栏 ${overlap.toFixed(2)}px`).toBeLessThan(1);

        // 系统设置保持打开，注册表与已配置列表都在，底栏按钮完好
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole("heading", { name: "模型注册表" })).toBeVisible();
        await expect(dialog.getByRole("heading", { name: "已配置服务商" })).toBeVisible();
        await expect(dialog.locator(".system-config-footer").getByRole("button", { name: "取消并关闭" })).toBeVisible();

        // 不再有独立的添加 Provider 入口
        await expect(dialog.getByRole("button", { name: /添加 Provider/ })).toHaveCount(0);

        // 对照：标题行「收起」才负责收起向导
        await dialog.getByRole("button", { name: "收起" }).click();
        await expect(dialog.locator(".model-connect-wizard")).toHaveCount(0);
        await expect(dialog).toBeVisible();

        // 再展开后，底栏「取消并关闭」才关闭对话框
        await dialog.getByRole("button", { name: /连接模型/ }).click();
        await expect(dialog.locator(".model-connect-wizard")).toBeVisible();
        await dialog.locator(".system-config-footer").getByRole("button", { name: "取消并关闭" }).click();
        await expect(dialog).toBeHidden();
      },
    );
  } finally {
    await cleanupProviders();
    stubServer.close();
  }
});

});
