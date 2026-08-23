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

import { expect, type Page } from "@playwright/test";

import type { ModelProfile, ModelProvider } from "@sciencediscovery/schema";

import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { test } from "./helpers/e2e.ts";
import {
  cleanupJourney,
  createProjectAndSession,
  openProjectSession,
  sendUserMessage,
  waitForRunTerminal,
  type JourneyFixture,
} from "./helpers/journeys.ts";

test.use({ locale: "zh-CN" });

interface ProviderStub {
  baseUrl: string;
  chatBodies: Array<Record<string, unknown>>;
  failListing: () => void;
  listAuth: Array<string | undefined>;
  stop: () => Promise<void>;
}

function providerStub(): Promise<ProviderStub> {
  let failListing = false;
  const chatBodies: Array<Record<string, unknown>> = [];
  const listAuth: Array<string | undefined> = [];
  let sequence = 0;
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        listAuth.push(request.headers.authorization);
        if (failListing) {
          response.writeHead(403, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "fixture model-list permission denied" } }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          data: [
            {
              id: "deepseek-v4-flash",
              context_length: 131_072,
              pricing: { completion: "0.000003", input_cache_read: "0.0000002", prompt: "0.0000015" },
              supports_image_in: true,
              supports_reasoning: true,
            },
            { id: "fixture-unknown" },
          ],
        }));
        return;
      }
      if (request.method === "POST" && request.url === "/v1/chat/completions") {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        chatBodies.push(body);
        sequence += 1;
        const id = `chatcmpl-provider-${sequence}`;
        const chunk = (delta: Record<string, unknown>, finishReason: string | null) => ({
          choices: [{ delta, finish_reason: finishReason, index: 0 }],
          created: 1,
          id,
          model: "deepseek-v4-flash",
          object: "chat.completion.chunk",
        });
        response.writeHead(200, { "cache-control": "no-cache", "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify(chunk({ reasoning_content: "Provider settings verified.", role: "assistant" }, null))}\n\n`);
        response.write(`data: ${JSON.stringify(chunk({ content: "The selected provider model is active." }, null))}\n\n`);
        response.write(`data: ${JSON.stringify({
          ...chunk({}, "stop"),
          usage: { completion_tokens: 12, prompt_tokens: 24, total_tokens: 36 },
        })}\n\n`);
        response.end("data: [DONE]\n\n");
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "fixture route not found" }));
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve({
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      chatBodies,
      failListing: () => { failListing = true; },
      listAuth,
      stop: () => new Promise<void>((resolveStop) => {
        server.closeAllConnections?.();
        server.close(() => resolveStop());
      }),
    }));
    server.on("error", reject);
  });
}

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
 * Purpose: Provider 与模型目录完整用户旅程——内置预设只填令牌、自定义 Provider、模型发现成功/失败降级、可溯源能力价格、会话模型和思考强度真实进入 Run，以及中英文和窄屏可用。
 * Steps:
 *   1. 打开模型注册表，确认常见 Provider 预设与自定义入口。
 *   2. 选择智谱内置预设，仅填令牌连接；核对默认 endpoint/协议未要求用户填写，令牌不回传。
 *   3. 查看维护目录的 GLM-5.2 上下文、视觉、思考、美元输入/输出/缓存价、官方来源与更新时间，并添加模型。
 *   4. 新建自定义 DeepSeek 兼容 Provider，填写 endpoint、令牌、协议变种与模型列表策略，发现模拟服务返回的模型。
 *   5. 验证远端事实逐字段覆盖、未知事实保持未知、价格单位与来源清楚，并添加 DeepSeek 模型。
 *   6. 刷新模型列表遭遇 403 时显示明确错误、保留上次结果，并可手动添加精确模型 ID。
 *   7. 在 600px 窄屏确认 Provider 表单、目录卡片无横向溢出且仍可操作。
 *   8. 新建会话并在对话框切换模型；不支持模型隐藏思考控件，DeepSeek 显示模式/强度，选择 enabled/max 后刷新仍保存。
 *   9. 发送一条消息并从模拟服务收到答复，核对实际请求使用所选模型且携带 DeepSeek thinking.type=enabled 与 reasoning_effort=max。
 *   10. 通过设置切换英文，确认 Provider 设置和对话内模型/思考控件的英文标签。
 * Environment: Isolated local stack at E2E_BASE_URL with isolated data dir；模型列表与 Chat Completions 均由本 spec 的 loopback mock 提供。
 * Type: mocked
 * LLM: local deterministic HTTP/SSE fixture only；不调用真实或付费模型 API。
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — 非本地浏览器请求被拦截。
 * Credentials: E2E_API_TOKEN（隔离实例）与两个仅供本地 fixture 使用的演示令牌；断言令牌不从 Provider API 回传。
 * CostSideEffects: none；创建的项目、Provider 与模型配置在 finally 中清理。
 */
test("J7 Provider 模型目录、失败降级与对话思考选择", { tag: "@mocked" }, async ({ journey, page }) => {
  test.setTimeout(240_000);
  journey.scenario({
    goal: "一位用户要用内置厂商快速接入，也要连接自己的兼容端点；随后核对模型事实、处理发现失败，"
      + "并在具体对话中选择模型与思考强度，确认它们真实进入请求。",
    preconditions: [
      "隔离栈已启动，浏览器已持有本实例访问 token",
      "模型目录和推理由 spec 内 loopback mock 提供，不访问任何真实厂商",
      "界面起始语言为简体中文，旅程末尾通过设置切换为英文",
    ],
  });
  await page.addInitScript(() => window.localStorage.setItem("science-agent-locale", "zh-CN"));

  const stub = await providerStub();
  const customName = `J7 自定义服务商 ${Date.now()}`;
  const providerIds: string[] = [];
  const modelIds: string[] = [];
  let fixture: JourneyFixture | undefined;

  const openModelRegistry = async () => {
    await page.getByRole("button", { name: /^(系统设置|System configuration)/ }).click();
    const dialog = page.getByRole("dialog", { name: /^(系统设置|System configuration)$/ });
    await dialog.getByRole("navigation", { name: /^(设置分组|Setting groups)$/ })
      .getByRole("button", { name: /^(模型注册表|Model registry)/ })
      .click();
    return dialog;
  };

  try {
    await journey.step(
      "模型注册表同时提供常见预设与自定义入口",
      "模型注册表展示 DeepSeek、智谱 GLM、OpenAI、Anthropic、Gemini、DashScope 等常见预设；每张需密钥的卡片标明“只需令牌”，旁边有“+ 自定义服务商”。",
      async () => {
        await page.goto("/");
        await expect(page).toHaveTitle("ScienceDiscovery");
        const dialog = await openModelRegistry();
        const presets = dialog.getByRole("region", { name: "常见服务商" });
        for (const name of ["DeepSeek", "智谱 GLM", "OpenAI", "Anthropic", "Google Gemini", "Alibaba Cloud Model Studio"]) {
          await expect(presets.getByRole("button", { name: new RegExp(name) })).toBeVisible();
        }
        await expect(presets.getByRole("button", { name: "+ 自定义服务商" })).toBeVisible();
        await expect(presets.getByRole("button", { name: /智谱 GLM.*只需令牌/ })).toBeVisible();
      },
    );

    await journey.step(
      "内置智谱 Provider 只填令牌即可连接",
      "选择“智谱 GLM”后，名称与可靠默认连接参数已经预填且高级项保持收起；用户只填写令牌并保存。创建请求使用预设的 open.bigmodel.cn endpoint、DeepSeek 变种和维护目录策略，返回体只有 hasApiToken=true，不包含令牌。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await dialog.getByRole("region", { name: "常见服务商" })
          .getByRole("button", { name: /智谱 GLM.*只需令牌/ })
          .click();
        const editor = dialog.getByRole("region", { name: "服务商编辑器" });
        await expect(editor.locator("details.provider-advanced")).toHaveJSProperty("open", false);
        await editor.getByLabel("LLM API 令牌").fill("j7-zhipu-local-token");
        const requestPromise = page.waitForRequest((request) => request.method() === "POST"
          && new URL(request.url()).pathname === "/api/providers");
        const responsePromise = page.waitForResponse((response) => response.request().method() === "POST"
          && new URL(response.url()).pathname === "/api/providers");
        await editor.getByRole("button", { name: "保存", exact: true }).click();
        const request = await requestPromise;
        const body = request.postDataJSON() as Record<string, unknown>;
        expect(body).toMatchObject({
          apiProtocol: "openai-chat-completions",
          apiVariant: "deepseek",
          baseUrl: "https://open.bigmodel.cn/api/paas/v4",
          modelDiscovery: "manual",
          presetId: "zhipu",
        });
        const response = await responsePromise;
        expect(response.status()).toBe(201);
        const provider = await response.json() as ModelProvider & Record<string, unknown>;
        providerIds.push(provider.id);
        expect(provider.hasApiToken).toBe(true);
        expect(provider).not.toHaveProperty("apiToken");
      },
    );

    await journey.step(
      "维护目录清楚展示 GLM 能力、价格与官方来源",
      "GLM-5.2 标明维护建议而非厂商动态返回；卡片展示 1,000,000 上下文、128,000 最大输出、无视觉、有思考、USD 输入 1.4 / 输出 4.4 / 缓存输入 0.26（每百万 tokens），并链接带 2026-08-23 更新时间的官方来源。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await expect(dialog.getByText(/维护建议（并非服务商返回）/)).toBeVisible();
        const card = dialog.locator("article.provider-model-card").filter({ hasText: "glm-5.2" });
        await expect(card).toContainText("1,000,000");
        await expect(card).toContainText("128,000");
        await expect(card).toContainText("视觉否");
        await expect(card).toContainText("思考是");
        await expect(card).toContainText("USD 1.4 / 4.4");
        await expect(card).toContainText("缓存输入 0.26");
        await expect(card.getByRole("link", { name: /官方来源 · 2026-08-23/ }).first()).toHaveAttribute("href", /bigmodel|z\.ai/);
        const responsePromise = page.waitForResponse((response) => response.request().method() === "POST"
          && /\/api\/providers\/[^/]+\/models$/.test(new URL(response.url()).pathname));
        await card.getByRole("button", { name: "添加模型" }).click();
        const profile = await (await responsePromise).json() as ModelProfile;
        modelIds.push(profile.id);
        await expect(card.getByRole("button", { name: "已添加" })).toBeDisabled();
      },
    );

    let deepseekModelId = "";
    await journey.step(
      "自定义 Provider 获取并规范化模型列表",
      "新建自定义服务商，填写本地 endpoint、令牌、OpenAI Chat Completions、DeepSeek 变种和 /models 策略。保存后目录显示服务商真实返回的 deepseek-v4-flash 与 fixture-unknown，且模型列表请求携带 Bearer 令牌。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await dialog.getByRole("button", { name: "+ 自定义服务商" }).click();
        const editor = dialog.getByRole("region", { name: "服务商编辑器" });
        await editor.getByLabel("服务商名称").fill(customName);
        await editor.getByLabel("LLM API 令牌").fill("j7-custom-local-token");
        await editor.getByLabel("基础 URL").fill(stub.baseUrl);
        await editor.getByLabel("基础接口").selectOption("openai-chat-completions");
        await editor.getByLabel("接口变种").selectOption("deepseek");
        await editor.getByLabel("模型列表").selectOption("openai-models");
        const responsePromise = page.waitForResponse((response) => response.request().method() === "POST"
          && new URL(response.url()).pathname === "/api/providers");
        await editor.getByRole("button", { name: "保存", exact: true }).click();
        const provider = await (await responsePromise).json() as ModelProvider & Record<string, unknown>;
        providerIds.push(provider.id);
        expect(provider).not.toHaveProperty("apiToken");
        await expect(dialog.getByText(/服务商返回/)).toBeVisible();
        await expect(dialog.locator("article.provider-model-card").filter({ hasText: "deepseek-v4-flash" })).toBeVisible();
        await expect(dialog.locator("article.provider-model-card").filter({ hasText: "fixture-unknown" })).toBeVisible();
        expect(stub.listAuth).toEqual(["Bearer j7-custom-local-token"]);
      },
    );

    await journey.step(
      "远端覆盖、未知状态、价格单位与来源均可核对",
      "DeepSeek 卡片以远端返回的 131,072 上下文、视觉与思考为准，并显示 USD 1.5 / 3、缓存输入 0.2、每百万 tokens 及本地响应来源；fixture-unknown 的上下文、输出、视觉、思考和价格均明确显示“未知”，不伪造能力。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const known = dialog.locator("article.provider-model-card").filter({ hasText: "deepseek-v4-flash" });
        await expect(known).toContainText("131,072");
        await expect(known).toContainText("视觉是");
        await expect(known).toContainText("思考是 · high / max");
        await expect(known).toContainText("USD 1.5 / 3");
        await expect(known).toContainText("缓存输入 0.2");
        await expect(known).toContainText("每百万 tokens");
        await expect(known.getByRole("link", { name: /官方来源 ·/ }).first()).toBeVisible();
        const unknown = dialog.locator("article.provider-model-card").filter({ hasText: "fixture-unknown" });
        expect(await unknown.locator(".provider-model-facts dd").allTextContents()).toEqual([
          "未知", "未知", "未知", "未知", "未知",
        ]);
        const responsePromise = page.waitForResponse((response) => response.request().method() === "POST"
          && /\/api\/providers\/[^/]+\/models$/.test(new URL(response.url()).pathname));
        await known.getByRole("button", { name: "添加模型" }).click();
        const profile = await (await responsePromise).json() as ModelProfile;
        deepseekModelId = profile.id;
        modelIds.push(profile.id);
      },
    );

    await journey.step(
      "模型列表权限失败时诚实降级并允许手动恢复",
      "强制刷新收到上游 403 后出现“无法刷新服务商模型列表”和 permission denied 详情，说明上次结果仍保留；原 deepseek 卡片仍在，用户可填写 fixture-manual 并成功添加，而不是收到伪造的刷新成功。",
      async () => {
        stub.failListing();
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await dialog.getByRole("button", { name: "刷新列表" }).click();
        const alert = dialog.getByRole("alert").filter({ hasText: "无法刷新服务商模型列表" });
        await expect(alert).toContainText("403");
        await expect(alert).toContainText("fixture model-list permission denied");
        await expect(alert).toContainText("上次成功结果仍保留");
        await expect(dialog.locator("article.provider-model-card").filter({ hasText: "deepseek-v4-flash" })).toBeVisible();
        await dialog.getByLabel("手动模型 ID").fill("fixture-manual");
        const responsePromise = page.waitForResponse((response) => response.request().method() === "POST"
          && /\/api\/providers\/[^/]+\/models$/.test(new URL(response.url()).pathname));
        await dialog.locator(".provider-manual-model").getByRole("button", { name: "添加模型" }).click();
        const profile = await (await responsePromise).json() as ModelProfile;
        modelIds.push(profile.id);
        expect(profile.model).toBe("fixture-manual");
      },
    );

    await journey.step(
      "窄屏 Provider 设置仍紧凑且无横向溢出",
      "视口缩到 600×900 后，预设、编辑区、失败提示、手动 ID 与模型目录保持单列可操作；对话框与页面没有横向溢出，输入框和目录卡片均在对话框边界内。",
      async () => {
        await page.setViewportSize({ width: 600, height: 900 });
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const geometry = await dialog.evaluate(() => {
          const bounds = document.querySelector(".system-config-dialog")!.getBoundingClientRect();
          const controls = Array.from(document.querySelectorAll(".provider-settings input, .provider-settings select, .provider-model-card"));
          return {
            controlsInside: controls.every((control) => {
              const rect = control.getBoundingClientRect();
              return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
            }),
            dialogRight: bounds.right,
            scrollWidth: document.documentElement.scrollWidth,
            viewport: window.innerWidth,
          };
        });
        expect(geometry.dialogRight).toBeLessThanOrEqual(geometry.viewport + 1);
        expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewport + 1);
        expect(geometry.controlsInside).toBe(true);
        await expect(dialog.getByLabel("手动模型 ID")).toBeVisible();
      },
    );

    await journey.step(
      "对话模型与思考强度遵守能力并跨刷新保存",
      "创建会话后，模型选择器实际选中 DeepSeek。切到不支持思考的 OpenAI fixture 时思考控件消失；切回 DeepSeek 后可选开启/最大，刷新页面仍显示同一模型、开启和最大。",
      async () => {
        const unsupported = await apiJson<ModelProfile>(page, "/api/models", {
          data: {
            apiToken: "j7-unsupported-local-token",
            apiVariant: "openai",
            baseUrl: stub.baseUrl,
            model: "fixture-no-thinking",
            name: "J7 no-thinking fixture",
          },
          method: "POST",
        });
        modelIds.push(unsupported.id);
        fixture = await createProjectAndSession(page, {
          modelId: deepseekModelId,
          projectName: `J7 Provider 项目 ${Date.now()}`,
          sessionTitle: "Provider 模型与思考强度",
        });
        await page.setViewportSize({ width: 1280, height: 720 });
        await openProjectSession(page, fixture);
        const modelSelect = page.getByLabel("本任务使用的模型");
        await expect(modelSelect).toHaveValue(deepseekModelId);
        await modelSelect.selectOption(unsupported.id);
        await expect(page.getByLabel("当前对话的思考模式")).toHaveCount(0);
        await modelSelect.selectOption(deepseekModelId);
        await page.getByLabel("当前对话的思考模式").selectOption("enabled");
        await page.getByLabel("当前对话的思考强度").selectOption("max");
        await expect(page.getByLabel("当前对话的思考强度")).toHaveValue("max");
        await expect.poll(async () => {
          const session = await apiJson<{ thinkingEffort?: string; thinkingMode?: string }>(
            page,
            `/api/sessions/${encodeURIComponent(fixture!.session.id)}`,
          );
          return `${session.thinkingMode}/${session.thinkingEffort}`;
        }).toBe("enabled/max");
        await page.reload();
        await openProjectSession(page, fixture);
        await expect(page.getByLabel("本任务使用的模型")).toHaveValue(deepseekModelId);
        await expect(page.getByLabel("当前对话的思考模式")).toHaveValue("enabled");
        await expect(page.getByLabel("当前对话的思考强度")).toHaveValue("max");
      },
    );

    await journey.step(
      "所选模型与 DeepSeek 思考配置真实进入 Run",
      "发送消息后页面收到本地模拟模型的确定性答复；模拟服务捕获的真实 Chat Completions 请求 model=deepseek-v4-flash，thinking.type=enabled 且 reasoning_effort=max，证明选择不是仅界面展示。",
      async () => {
        const run = await sendUserMessage(page, fixture!.session.id, "Verify the selected provider model and thinking controls.");
        const terminal = await waitForRunTerminal(page, fixture!.session.id, run.id, 120_000);
        expect(terminal.status).toBe("completed");
        await expect(page.getByText("The selected provider model is active.")).toBeVisible();
        expect(stub.chatBodies.length).toBeGreaterThan(0);
        const request = stub.chatBodies.at(-1)!;
        expect(request.model).toBe("deepseek-v4-flash");
        expect(request.thinking).toEqual({ type: "enabled" });
        expect(request.reasoning_effort).toBe("max");
      },
    );

    await journey.step(
      "设置与对话控件提供英文界面",
      "在系统设置的语言页选择 English 并保存关闭；对话区显示 Model for this task、Thinking mode for this conversation 和 Thinking effort for this conversation，重新打开模型注册表可见 Common providers、Custom provider 与 Provider model catalog。",
      async () => {
        const dialog = await openModelRegistry();
        await dialog.getByRole("navigation", { name: "设置分组" })
          .getByRole("button", { name: /^语言/ })
          .click();
        await dialog.getByLabel("界面语言").selectOption("en");
        await dialog.getByRole("button", { name: "保存并关闭" }).click();
        await expect(page.getByLabel("Model for this task")).toBeVisible();
        await expect(page.getByLabel("Thinking mode for this conversation")).toBeVisible();
        await expect(page.getByLabel("Thinking effort for this conversation")).toBeVisible();
        const englishDialog = await openModelRegistry();
        await expect(englishDialog.getByRole("region", { name: "Common providers" })).toBeVisible();
        await expect(englishDialog.getByRole("button", { name: "+ Custom provider" })).toBeVisible();
        await expect(englishDialog.getByRole("region", { name: "Provider model catalog" })).toBeVisible();
      },
    );
  } finally {
    if (fixture) await cleanupJourney(page, fixture);
    const settings = await apiJson<{ overrides?: Record<string, unknown> }>(page, "/api/settings").catch(() => undefined);
    if (settings?.overrides) {
      const overrides = { ...settings.overrides };
      let changed = false;
      for (const key of ["modelId", "reviewModelId"]) {
        if (typeof overrides[key] === "string" && modelIds.includes(overrides[key] as string)) {
          delete overrides[key];
          changed = true;
        }
      }
      if (changed) await apiJson(page, "/api/settings", { data: overrides, method: "PUT" }).catch(() => undefined);
    }
    for (const providerId of providerIds.toReversed()) {
      await apiJson(page, `/api/providers/${encodeURIComponent(providerId)}`, { method: "DELETE" }).catch(() => undefined);
    }
    for (const modelId of modelIds.toReversed()) {
      await apiJson(page, `/api/models/${encodeURIComponent(modelId)}`, { method: "DELETE" }).catch(() => undefined);
    }
    await stub.stop();
  }
});
