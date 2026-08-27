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
  anthropicBodies: Array<Record<string, unknown>>;
  baseUrl: string;
  chatBodies: Array<Record<string, unknown>>;
  failListing: () => void;
  listAuth: Array<string | undefined>;
  listPaths: string[];
  origin: string;
  restoreListing: () => void;
  responsesBodies: Array<Record<string, unknown>>;
  stop: () => Promise<void>;
}

function providerStub(): Promise<ProviderStub> {
  let failListing = false;
  const anthropicBodies: Array<Record<string, unknown>> = [];
  const chatBodies: Array<Record<string, unknown>> = [];
  const listAuth: Array<string | undefined> = [];
  const listPaths: string[] = [];
  const responsesBodies: Array<Record<string, unknown>> = [];
  let sequence = 0;
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      if (request.method === "GET" && ["/v1/models", "/slow/v1/models", "/fast/v1/models"].includes(request.url ?? "")) {
        listAuth.push(request.headers.authorization);
        listPaths.push(request.url!);
        if (failListing) {
          response.writeHead(403, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "fixture model-list permission denied" } }));
          return;
        }
        const data = request.url === "/slow/v1/models"
          ? [{ id: "race-provider-a-model" }]
          : request.url === "/fast/v1/models"
            ? [{ id: "race-provider-b-model" }]
            : [
                {
                  id: "deepseek-v4-flash",
                  context_length: 131_072,
                  pricing: { completion: "0.000003", input_cache_read: "0.0000002", prompt: "0.0000015" },
                  supports_image_in: true,
                  supports_reasoning: true,
                },
                { id: "fixture-unknown" },
              ];
        const send = () => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ data }));
        };
        if (request.url === "/slow/v1/models") setTimeout(send, 350);
        else send();
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
      if (request.method === "POST" && request.url === "/v1/responses") {
        responsesBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        response.writeHead(200, { "cache-control": "no-cache", "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "GPT-5.5 xhigh is active." })}\n\n`);
        response.write(`data: ${JSON.stringify({
          type: "response.completed",
          response: { usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 } },
        })}\n\n`);
        response.end("data: [DONE]\n\n");
        return;
      }
      if (request.method === "POST" && request.url === "/v1/messages") {
        anthropicBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        response.writeHead(200, { "cache-control": "no-cache", "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 6 } } })}\n\n`);
        response.write(`data: ${JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        })}\n\n`);
        response.write(`data: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Claude Haiku 4.5 legacy thinking is active." },
        })}\n\n`);
        response.write(`data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 5 } })}\n\n`);
        response.end("data: [DONE]\n\n");
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "fixture route not found" }));
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve({
        anthropicBodies,
        baseUrl: `${origin}/v1`,
        chatBodies,
        failListing: () => { failListing = true; },
        listAuth,
        listPaths,
        origin,
        restoreListing: () => { failListing = false; },
        responsesBodies,
        stop: () => new Promise<void>((resolveStop) => {
          server.closeAllConnections?.();
          server.close(() => resolveStop());
        }),
      });
    });
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
 * Purpose: Provider 与模型目录完整用户旅程——草稿安全、内置预设只填令牌、自定义 Provider、发现成功/失败/乱序、双语可溯源价格、模型级思考能力与 Session/wire 一致性，以及桌面/窄屏真实几何。
 * Steps:
 *   1. 打开模型注册表，确认主视图无预设墙、无常驻编辑器；“添加 Provider”下拉列出预置，另有自定义入口。
 *   2. 核对目录状态行：models.dev 来源、打包快照时间与刷新按钮；刷新成功改时间、刷新失败保留旧数据且草稿不丢（浏览器边界伪造目录下载响应）。
 *   3. MiniMax 仅填令牌；Escape 取消关闭保留草稿，底部保存并关闭提交；请求在浏览器边界改写为 loopback/manual。
 *   4. 选择智谱内置预设，仅填令牌连接；核对默认 endpoint/协议未要求用户填写，令牌不回传。
 *   5. 维护目录的 GLM-5.2 展示能力、诚实未知价格（不冒用 z.ai 国际站定价），模型行无每模型来源链接，并添加模型。
 *   6. 新建自定义兼容 Provider；标题栏取消关闭保留草稿，底部保存发现 loopback 模型，状态提供文本可访问名。
 *   7. 验证远端事实逐字段覆盖、未知事实保持未知、价格单位与来源清楚，并添加 DeepSeek 模型。
 *   8. 用 DeepSeek 预设目录核对 USD 每百万 token 标准单价、缓存输入与规范去重来源（上游不再发布分时价）。
 *   9. 刷新模型列表遭遇 403 时显示明确错误、保留上次结果，并可手动添加精确模型 ID。
 *   10. 让 Provider A 迟到、B 先回，确认界面只保留 B 且添加请求发往 B。
 *   11. 删除被全局默认模型引用的 B，确认中文错误提供可恢复操作且不会误报保存/刷新失败。
 *   12. 在 600px 窄屏确认 Provider 表单、目录卡片无横向溢出且仍可操作。
 *   13. 新建会话，经小弹窗切换模型；不支持思考的模型无分档控件并提示，DeepSeek 思考分档按钮选 max 并跨刷新保存。
 *   14. 工作区展开时分别在 1440×900、600×900 对中文 Composer 做两两无重叠、紧凑高度、命中、边界与标签几何断言。
 *   15. 发送消息，核对 DeepSeek 所选模型、thinking.type=enabled 与 reasoning_effort=max 真实进入 wire。
 *   16. 选择 GPT-5.5，把旧 max 持久化收窄为 xhigh；刷新一致且 Responses wire 合法。
 *   17. 选择始终推理 Kimi K3，确认分档按钮无“关”仅有 low/high/max 强度，wire 只发送 reasoning_effort=low。
 *   18. 选择 Claude Haiku 4.5，分档按钮只给 关闭/模型默认/开启 无强度并提示 legacy，wire 使用合法固定预算。
 *   19. 切换英文，复核两档 Composer 几何，再确认弹窗分档按钮档位/“模型默认”文案及 DeepSeek 标准价格自然本地化。
 * Environment: Isolated local stack at E2E_BASE_URL with isolated data dir；模型列表、Chat Completions、Responses 与 Anthropic Messages 均由本 spec 的 loopback mock 提供。
 * Type: mocked
 * LLM: local deterministic HTTP/SSE fixture only；不调用真实或付费模型 API。
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — 非本地浏览器请求被拦截；MiniMax 浏览器请求在进入 API 前强制改写为 loopback/manual。
 * Credentials: E2E_API_TOKEN（隔离实例）与仅供本地 fixture 使用的演示令牌；断言令牌不从 Provider API 回传。
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
  let raceModelId = "";
  let raceProviderBId = "";

  const openModelRegistry = async () => {
    const dialog = page.getByRole("dialog", { name: /^(系统设置|System configuration)$/ });
    if (!await dialog.isVisible()) {
      await page.getByRole("button", { name: /^(系统设置|System configuration)/ }).click();
    }
    await dialog.getByRole("navigation", { name: /^(设置分组|Setting groups)$/ })
      .getByRole("button", { name: /^(模型注册表|Model registry)/ })
      .click();
    return dialog;
  };

  // Adding a provider: a dropdown lists the supported presets and a separate
  // button adds a fully custom provider. The editor only opens on an explicit
  // choice — never just because the registry was opened.
  // The preset dropdown and custom entry live behind one "添加 Provider"
  // button below the configured list; open it on demand.
  const openAddPanel = async (dialog: ReturnType<typeof page.getByRole>) => {
    if (!await dialog.locator(".provider-add-panel").count()) {
      await dialog.getByRole("button", { name: /^(添加 Provider|Add provider)/ }).first().click();
    }
    return dialog.locator(".provider-add-panel");
  };
  const choosePreset = async (presetId: string) => {
    await page.locator(".provider-add-panel").getByLabel(/^(添加 Provider|Add provider)$/).selectOption(presetId);
  };
  const addCustomProvider = async (dialog: ReturnType<typeof page.getByRole>) => {
    await (await openAddPanel(dialog)).getByRole("button", { name: /^(自定义服务商|Custom provider)$/ }).click();
  };

  // Conversation model selection goes through the connector-style popover:
  // click the composer trigger, pick a model row, then move the thinking
  // stop buttons, one labelled button per legal stop (off → default → strongest).
  const openModelPicker = async () => {
    await page.getByLabel(/^(本任务使用的模型|Model for this task)$/).click();
    return page.getByRole("dialog", { name: /^(选择模型|Choose a model)$/ });
  };
  const pickConversationModel = async ({ model }: { model: RegExp | string }) => {
    const picker = await openModelPicker();
    await picker.getByRole("option", { name: model }).click();
    return picker;
  };
  const closeModelPicker = async (picker: ReturnType<typeof page.getByRole>) => {
    await page.keyboard.press("Escape");
    await expect(picker).toBeHidden();
  };
  // The thinking control is a joined row of labelled stop buttons (radio
  // group): click a stop to select it; illegal stops are simply absent.
  const thinkingStops = (picker: ReturnType<typeof page.getByRole>) =>
    picker.getByRole("radiogroup", { name: /^(当前对话的思考，从关闭到最强|Thinking for this conversation, off to strongest)$/ })
      .getByRole("radio");
  const setThinkingStop = async (picker: ReturnType<typeof page.getByRole>, label: RegExp | string) => {
    await picker.getByRole("radio", { name: label }).click();
  };

  const verifyComposerGeometry = async ({
    labels,
    runButton,
    width,
  }: {
    labels: string[];
    runButton: string;
    width: number;
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const footer = page.locator(".composer-footer");
    await footer.scrollIntoViewIfNeeded();
    const geometry = await footer.evaluate((node) => {
      const footerRect = node.getBoundingClientRect();
      const groupSelectors = [
        { group: "model", selector: ".model-picker-trigger" },
        { group: "orchestration", selector: ".orchestration-controls select, .orchestration-controls button" },
        { group: "run", selector: ".composer-run-actions button" },
      ];
      const controls = groupSelectors.flatMap(({ group, selector }) => (
        Array.from(node.querySelectorAll<HTMLElement>(selector)).map((element) => ({ element, group }))
      )).filter(({ element }) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      const rectangles = controls.map(({ element, group }) => {
        const rect = element.getBoundingClientRect();
        return { bottom: rect.bottom, group, height: rect.height, left: rect.left, right: rect.right, top: rect.top, width: rect.width };
      });
      const overlaps: Array<{ left: string; right: string }> = [];
      for (let left = 0; left < rectangles.length; left += 1) {
        for (let right = left + 1; right < rectangles.length; right += 1) {
          const a = rectangles[left]!;
          const b = rectangles[right]!;
          if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
            && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) {
            overlaps.push({ left: `${left}:${a.group}`, right: `${right}:${b.group}` });
          }
        }
      }
      const labelSpans = Array.from(node.querySelectorAll<HTMLElement>("label > span"))
        .filter((element) => element.getBoundingClientRect().width > 0);
      return {
        centerTargetFailures: controls.flatMap(({ element, group }, index) => {
          const rect = element.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return hit === element || (hit !== null && element.contains(hit))
            ? []
            : [{
                control: `${index}:${group}:${element.tagName.toLowerCase()}:${element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 40) ?? ""}`,
                hit: hit ? `${hit.tagName.toLowerCase()}.${hit.className}` : "none",
              }];
        }),
        controlsInside: rectangles.every((rect) => rect.left >= footerRect.left - 1
          && rect.right <= footerRect.right + 1
          && rect.left >= -1
          && rect.right <= window.innerWidth + 1),
        groupCounts: Object.fromEntries(groupSelectors.map(({ group }) => [
          group,
          rectangles.filter((rect) => rect.group === group).length,
        ])),
        labelsUnclipped: labelSpans.every((span) => span.scrollWidth <= span.clientWidth + 1),
        modelTriggerHeight: node.querySelector<HTMLElement>(".model-picker-trigger")?.getBoundingClientRect().height ?? 0,
        overlaps,
        pageScrollWidth: document.documentElement.scrollWidth,
        selectHeights: controls
          .filter(({ element }) => element.tagName === "SELECT")
          .map(({ element }) => element.getBoundingClientRect().height),
        viewportWidth: window.innerWidth,
      };
    });
    expect(geometry.overlaps).toEqual([]);
    expect(geometry.centerTargetFailures).toEqual([]);
    expect(geometry.controlsInside).toBe(true);
    expect(geometry.labelsUnclipped).toBe(true);
    expect(geometry.pageScrollWidth).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    for (const group of ["model", "orchestration", "run"]) {
      expect(geometry.groupCounts[group]).toBeGreaterThan(0);
    }
    if (width <= 600) {
      expect(geometry.modelTriggerHeight).toBeGreaterThanOrEqual(24);
      expect(geometry.modelTriggerHeight).toBeLessThanOrEqual(48);
      expect(geometry.selectHeights.length).toBeGreaterThanOrEqual(2);
      expect(geometry.selectHeights.every((height) => height >= 24 && height <= 48)).toBe(true);
    }
    for (const label of labels) await expect(page.getByLabel(label)).toBeVisible();
    await expect(page.getByRole("button", { name: runButton })).toBeVisible();
    return geometry;
  };

  try {
    await journey.step(
      "模型注册表把常见预设收进“添加 Provider”",
      "模型注册表主视图是目录状态与已配置服务商，而不是铺开的预设墙；设置窗口放大到约 80% 视口保持响应式。展开“添加 Provider”后可见 DeepSeek、智谱 GLM、OpenAI、Anthropic、Gemini、DashScope 等常见预设；每张需密钥的卡片标明“只需令牌”，末尾是“自定义服务商”。",
      async () => {
        await page.goto("/");
        await expect(page).toHaveTitle("ScienceDiscovery");
        const dialog = await openModelRegistry();
        // The settings window is resized to roughly 80% of the viewport and
        // stays responsive: at 1280×720 it should measure about 1024×576.
        const dialogGeometry = await dialog.evaluate(() => {
          const rect = document.querySelector(".system-config-dialog")!.getBoundingClientRect();
          return { height: rect.height, width: rect.width, viewportHeight: window.innerHeight, viewportWidth: window.innerWidth };
        });
        expect(dialogGeometry.width).toBeGreaterThanOrEqual(0.78 * dialogGeometry.viewportWidth - 2);
        expect(dialogGeometry.width).toBeLessThanOrEqual(0.83 * dialogGeometry.viewportWidth + 2);
        expect(dialogGeometry.height).toBeGreaterThanOrEqual(0.78 * dialogGeometry.viewportHeight - 2);
        expect(dialogGeometry.height).toBeLessThanOrEqual(0.83 * dialogGeometry.viewportHeight + 2);
        await expect(dialog.locator(".provider-preset-card")).toHaveCount(0);
        await expect(dialog.getByRole("region", { name: "服务商编辑器" })).toHaveCount(0);
        await dialog.getByRole("button", { name: /添加 Provider/ }).first().click();
        const optionTexts = await dialog.locator(".provider-add-panel").getByLabel("添加 Provider").locator("option").allTextContents();
        for (const name of ["DeepSeek", "智谱 GLM", "OpenAI", "Anthropic", "Google Gemini", "Alibaba Cloud Model Studio"]) {
          expect(optionTexts.some((text) => text.includes(name))).toBe(true);
        }
        await expect(dialog.locator(".provider-add-controls").getByRole("button", { name: /^自定义服务商$/ })).toBeVisible();
      },
    );

    await journey.step(
      "目录带快照时间可手动刷新，失败保留旧数据且草稿不丢",
      "模型注册表顶部展示“模型元数据目录”状态行：标明快照随本次构建发布、最近更新于打包时间，并提供“刷新目录”按钮。手动刷新成功后状态行改为“最近更新于”新时间并提示“模型目录已更新”；随后模拟刷新失败时给出“无法刷新模型目录，仍在使用上一次的目录数据”，状态行时间与内容保留刷新后的快照，同时正在填写的自定义服务商草稿字段一个都不丢。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const status = dialog.getByRole("region", { name: "模型元数据目录" });
        await expect(status).toContainText("数据来源：models.dev");
        await expect(status).toContainText("随本次构建发布，最近更新于");
        await expect(status.getByRole("button", { name: "刷新目录" })).toBeVisible();

        const current = await apiJson<{ sourceUrl: string; snapshot?: { fetchedAt: string; origin: string } }>(
          page,
          "/api/model-catalog",
        );
        expect(current.snapshot?.origin).toBe("bundled");
        const refreshedAt = "2026-08-26T02:00:00.000Z";
        let simulatedRefresh: { body: unknown; status: number } | undefined;
        const refreshRoute = async (route: Route) => {
          if (!simulatedRefresh) {
            await route.continue();
            return;
          }
          await route.fulfill({
            body: JSON.stringify(simulatedRefresh.body),
            contentType: "application/json",
            status: simulatedRefresh.status,
          });
        };
        await page.route("**/api/model-catalog/refresh", refreshRoute);
        try {
          // 刷新成功：浏览器边界伪造一次成功的目录下载（origin=downloaded，新时间戳）。
          simulatedRefresh = {
            body: {
              ...current,
              snapshot: { ...(current.snapshot ?? {}), fetchedAt: refreshedAt, origin: "downloaded" },
            },
            status: 200,
          };
          await status.getByRole("button", { name: "刷新目录" }).click();
          await expect(page.getByText("模型目录已更新")).toBeVisible();
          await expect(status).toContainText("最近更新于 2026/8/26 02:00:00");
          await expect(status).not.toContainText("随本次构建发布");

          // 刷新失败：上游 502，保留上一次快照且草稿不丢。
          await addCustomProvider(dialog);
          const editor = dialog.getByRole("region", { name: "服务商编辑器" });
          const draftName = `J7 目录刷新草稿 ${Date.now()}`;
          await editor.getByLabel("服务商名称").fill(draftName);
          await editor.getByLabel("LLM API 令牌").fill("j7-catalog-draft-token");
          await editor.getByLabel("基础 URL").fill(stub.baseUrl);

          simulatedRefresh = {
            body: { error: "fixture catalog refresh denied" },
            status: 502,
          };
          await status.getByRole("button", { name: "刷新目录" }).click();
          await expect(page.getByText("无法刷新模型目录，仍在使用上一次的目录数据")).toBeVisible();
          await expect(status).toContainText("最近更新于 2026/8/26 02:00:00");
          await expect(editor.getByLabel("服务商名称")).toHaveValue(draftName);
          await expect(editor.getByLabel("LLM API 令牌")).toHaveValue("j7-catalog-draft-token");
          await expect(editor.getByLabel("基础 URL")).toHaveValue(stub.baseUrl);

          // 丢弃未保存草稿，恢复干净的注册表视图继续后续步骤。
          page.once("dialog", (confirmation) => { void confirmation.accept(); });
          await dialog.getByRole("button", { name: "取消并关闭" }).first().click();
          await expect(dialog).toBeHidden();
          await openModelRegistry();
        } finally {
          await page.unroute("**/api/model-catalog/refresh", refreshRoute);
        }
      },
    );

    await journey.step(
      "MiniMax 只填令牌且底部动作不会丢失草稿",
      "选择 MiniMax 预设后只填写令牌。按 Escape 时出现明确的未保存确认；取消关闭后令牌仍在。点击对话框底部“保存并关闭”会提交同一草稿并关闭设置。测试在浏览器边界核对预设原始 endpoint/发现策略，再把请求改写到本地 manual fixture，保证服务端绝不访问厂商网络。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await openAddPanel(dialog);
        await choosePreset("minimax");
        const editor = dialog.getByRole("region", { name: "服务商编辑器" });
        await editor.getByLabel("LLM API 令牌").fill("j7-minimax-local-token");

        let confirmationType = "";
        let confirmationMessage = "";
        page.once("dialog", (confirmation) => {
          confirmationType = confirmation.type();
          confirmationMessage = confirmation.message();
          void confirmation.dismiss();
        });
        await page.keyboard.press("Escape");
        expect(confirmationType).toBe("confirm");
        expect(confirmationMessage).toContain("放弃尚未保存的服务商修改");
        await expect(dialog).toBeVisible();
        await expect(editor.getByLabel("LLM API 令牌")).toHaveValue("j7-minimax-local-token");

        let originalBody: Record<string, unknown> | undefined;
        const providerRoute = async (route: Route) => {
          const request = route.request();
          const body = request.method() === "POST" ? request.postDataJSON() as Record<string, unknown> : undefined;
          if (body?.presetId !== "minimax") {
            await route.continue();
            return;
          }
          originalBody = body;
          const localResponse = await page.request.post(`${apiBaseUrl()}/api/providers`, {
            data: { ...body, baseUrl: stub.baseUrl, modelDiscovery: "manual" },
            headers: authorizationHeader(),
          });
          await route.fulfill({
            body: await localResponse.body(),
            contentType: localResponse.headers()["content-type"],
            status: localResponse.status(),
          });
        };
        await page.route("**/api/providers", providerRoute);
        try {
          const responsePromise = page.waitForResponse((response) => response.request().method() === "POST"
            && new URL(response.url()).pathname === "/api/providers");
          await dialog.getByRole("button", { name: "保存并关闭" }).click();
          const provider = await (await responsePromise).json() as ModelProvider;
          providerIds.push(provider.id);
          expect(originalBody).toMatchObject({
            apiProtocol: "openai-chat-completions",
            apiVariant: "minimax",
            baseUrl: "https://api.minimaxi.com/v1",
            modelDiscovery: "openai-models",
            presetId: "minimax",
          });
          await expect(dialog).toBeHidden();
        } finally {
          await page.unroute("**/api/providers", providerRoute);
        }
        await openModelRegistry();
      },
    );

    await journey.step(
      "内置智谱 Provider 只填令牌即可连接",
      "选择“智谱 GLM”后，名称与可靠默认连接参数已经预填且高级项保持收起；用户只填写令牌并保存。创建请求使用预设的 open.bigmodel.cn endpoint、DeepSeek 变种和维护目录策略，返回体只有 hasApiToken=true，不包含令牌。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await openAddPanel(dialog);
        await choosePreset("zhipu");
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
      "维护目录给出 GLM 能力与诚实未知价格",
      "GLM-5.2 标明维护建议而非厂商动态返回；紧凑模型行展示 1,000,000 上下文、131,072 最大输出、无视觉、有思考（高/最大）。由于上游只发布智谱国际站（z.ai）的价格、而本端点连接 open.bigmodel.cn，价格诚实地标注为「未知」而不是冒用另一个托管商的定价；界面不再出现每模型「官方来源」链接，数据来源统一是目录状态行的 models.dev。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await expect(dialog.getByText(/维护建议（并非服务商返回）/)).toBeVisible();
        const card = dialog.locator(".provider-model-row").filter({ hasText: "glm-5.2" });
        const facts = card.locator(".provider-model-row-facts .fact");
        await expect(facts.nth(0)).toHaveText("1M / 131k");
        await expect(facts.nth(0)).toHaveAttribute("title", /1,000,000 \/ 131,072/);
        await expect(facts.nth(1)).toHaveAttribute("title", "视觉：不支持");
        await expect(facts.nth(2)).toHaveText(/高 最大/);
        await expect(facts.nth(2)).toHaveAttribute("title", "思考：高 / 最大");
        // 价格诚实地为未知：可见为 "?"，悬停说明原因。
        await expect(facts.nth(3)).toHaveText("?");
        await expect(facts.nth(3)).toHaveAttribute("title", /未知/);
        await expect(card.getByRole("link")).toHaveCount(0);
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
      "新建自定义服务商，填写本地 endpoint、令牌、OpenAI Chat Completions、DeepSeek 变种和 /models 策略。点击标题栏关闭时确认未保存且取消后字段仍在；随后使用对话框底部“保存”提交。目录显示服务商真实返回的 deepseek-v4-flash 与 fixture-unknown，且模型列表请求携带 Bearer 令牌。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await addCustomProvider(dialog);
        const editor = dialog.getByRole("region", { name: "服务商编辑器" });
        await editor.getByLabel("服务商名称").fill(customName);
        await editor.getByLabel("LLM API 令牌").fill("j7-custom-local-token");
        await editor.getByLabel("基础 URL").fill(stub.baseUrl);
        await editor.getByLabel("基础接口").selectOption("openai-chat-completions");
        await editor.getByLabel("接口变种").selectOption("deepseek");
        await editor.getByLabel("模型列表").selectOption("openai-models");

        let confirmationMessage = "";
        page.once("dialog", (confirmation) => {
          confirmationMessage = confirmation.message();
          void confirmation.dismiss();
        });
        await dialog.getByRole("button", { name: "取消并关闭" }).first().click();
        expect(confirmationMessage).toContain("放弃尚未保存的服务商修改");
        await expect(editor.getByLabel("服务商名称")).toHaveValue(customName);
        await expect(editor.getByLabel("基础 URL")).toHaveValue(stub.baseUrl);

        const responsePromise = page.waitForResponse((response) => response.request().method() === "POST"
          && new URL(response.url()).pathname === "/api/providers");
        await dialog.locator(".system-config-footer").getByRole("button", { name: "保存", exact: true }).click();
        const provider = await (await responsePromise).json() as ModelProvider & Record<string, unknown>;
        providerIds.push(provider.id);
        expect(provider).not.toHaveProperty("apiToken");
        await expect(dialog.getByRole("region", { name: "已配置服务商" })
          .getByRole("button", { name: new RegExp(customName) })
          .getByRole("img", { name: "可用" })).toBeVisible();
        await expect(dialog.getByText(/服务商返回/)).toBeVisible();
        await expect(dialog.locator(".provider-model-row").filter({ hasText: "deepseek-v4-flash" })).toBeVisible();
        await expect(dialog.locator(".provider-model-row").filter({ hasText: "fixture-unknown" })).toBeVisible();
        expect(stub.listAuth).toEqual(["Bearer j7-custom-local-token"]);
      },
    );

    await journey.step(
      "远端覆盖、未知状态、价格单位与来源均可核对",
      "DeepSeek 卡片以远端返回的 131,072 上下文、视觉与思考为准，并显示 USD 1.5 / 3、缓存输入 0.2、每百万 tokens 及本地响应来源；fixture-unknown 的上下文、输出、视觉、思考和价格均明确显示“未知”，不伪造能力。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const known = dialog.locator(".provider-model-row").filter({ hasText: "deepseek-v4-flash" });
        const knownFacts = known.locator(".provider-model-row-facts .fact");
        await expect(knownFacts.nth(0)).toHaveText("131k / ?");
        await expect(knownFacts.nth(1)).toHaveAttribute("title", "视觉：支持");
        await expect(knownFacts.nth(2)).toHaveText(/低 高 最大/);
        await expect(knownFacts.nth(3)).toHaveText("1.5 / 3 / 0.2 USD/1M");
        await expect(knownFacts.nth(3)).toHaveAttribute("title", "输入 / 输出 / 缓存输入，每百万 tokens（USD）");
        await expect(known.getByRole("link")).toHaveCount(0);
        const unknown = dialog.locator(".provider-model-row").filter({ hasText: "fixture-unknown" });
        for (const title of await unknown.locator(".provider-model-row-facts .fact").evaluateAll(
          (nodes) => nodes.map((node) => node.getAttribute("title") ?? ""),
        )) {
          expect(title).toContain("未知");
        }
        const responsePromise = page.waitForResponse((response) => response.request().method() === "POST"
          && /\/api\/providers\/[^/]+\/models$/.test(new URL(response.url()).pathname));
        await known.getByRole("button", { name: "添加模型" }).click();
        const profile = await (await responsePromise).json() as ModelProfile;
        deepseekModelId = profile.id;
        modelIds.push(profile.id);
      },
    );

    await journey.step(
      "DeepSeek 目录展示标准美元单价并本地化来源",
      "使用 DeepSeek 内置预设的维护目录（连接参数由测试改为本地 manual）展示 USD/每百万 token 的 0.14 / 0.28 与缓存输入 0.0028。上游已不再发布分时价格，因此界面不再出现高峰/闲时时段，也不暴露 periods 等内部字段名；模型行不再附「官方来源」链接，Provider 行可折叠展开。",
      async () => {
        const deepseekProvider = await apiJson<ModelProvider>(page, "/api/providers", {
          data: {
            apiToken: "j7-deepseek-catalog-local-token",
            baseUrl: stub.baseUrl,
            modelDiscovery: "manual",
            presetId: "deepseek",
          },
          method: "POST",
        });
        providerIds.push(deepseekProvider.id);
        await page.reload();
        const dialog = await openModelRegistry();
        const registry = dialog.getByRole("region", { name: "已配置服务商" });
        await registry.getByRole("button", { name: /DeepSeek/ }).click();
        const flash = dialog.locator(".provider-model-row").filter({ hasText: "deepseek-v4-flash" });
        const flashPrice = flash.locator(".provider-model-row-facts .fact").nth(3);
        await expect(flashPrice).toHaveText("0.14 / 0.28 / 0.0028 USD/1M");
        await expect(flashPrice).toHaveAttribute("title", /每百万 tokens/);
        await expect(flash).not.toContainText("periods");
        await expect(flash.getByRole("link")).toHaveCount(0);

        // The pulled model list collapses with the provider row: closing the
        // row hides the inline table, expanding brings it back.
        await registry.getByRole("button", { name: /DeepSeek/ }).click();
        await expect(dialog.locator(".provider-model-table")).toHaveCount(0);
        await registry.getByRole("button", { name: /DeepSeek/ }).click();
        await expect(dialog.locator(".provider-model-row").filter({ hasText: "deepseek-v4-flash" })).toBeVisible();

        await registry.getByRole("button", { name: new RegExp(customName) }).click();
        await expect(dialog.locator(".provider-model-row").filter({ hasText: "deepseek-v4-flash" })).toBeVisible();
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
        await expect(dialog.locator(".provider-model-row").filter({ hasText: "deepseek-v4-flash" })).toBeVisible();
        await dialog.locator(".provider-add-model-toggle").click();
        await dialog.getByLabel("手动模型 ID").fill("fixture-manual");
        const responsePromise = page.waitForResponse((response) => response.request().method() === "POST"
          && /\/api\/providers\/[^/]+\/models$/.test(new URL(response.url()).pathname));
        await dialog.locator(".provider-manual-form").getByRole("button", { name: "添加模型" }).click();
        const profile = await (await responsePromise).json() as ModelProfile;
        modelIds.push(profile.id);
        expect(profile.model).toBe("fixture-manual");
        stub.restoreListing();
      },
    );

    await journey.step(
      "快速切换 Provider 时迟到结果不会串目录",
      "本地 Provider A 的 /models 故意延迟，Provider B 立即返回。用户连续选择 A、B 后，即使 A 最后到达，目录仍只显示 B 的模型；点击添加的 POST 也明确发往 B，不能把 A 的模型挂到 B。",
      async () => {
        const providerA = await apiJson<ModelProvider>(page, "/api/providers", {
          data: {
            apiToken: "j7-race-a-local-token",
            apiProtocol: "openai-chat-completions",
            apiVariant: "openai",
            baseUrl: `${stub.origin}/slow/v1`,
            modelDiscovery: "openai-models",
            name: "J7 Race Provider A",
          },
          method: "POST",
        });
        const providerB = await apiJson<ModelProvider>(page, "/api/providers", {
          data: {
            apiToken: "j7-race-b-local-token",
            apiProtocol: "openai-chat-completions",
            apiVariant: "openai",
            baseUrl: `${stub.origin}/fast/v1`,
            modelDiscovery: "openai-models",
            name: "J7 Race Provider B",
          },
          method: "POST",
        });
        providerIds.push(providerA.id, providerB.id);
        raceProviderBId = providerB.id;
        await page.reload();
        // The registry mounts ProviderModelSettings, which pre-loads every
        // configured provider's real model list in parallel (per-provider
        // listing slot). Register both responses before opening the registry
        // so the late A response still lands in A's own row and never bleeds
        // into B's catalog.
        const responseA = page.waitForResponse((response) => new URL(response.url()).pathname
          === `/api/providers/${providerA.id}/models`);
        const responseB = page.waitForResponse((response) => new URL(response.url()).pathname
          === `/api/providers/${providerB.id}/models`);
        const dialog = await openModelRegistry();
        await Promise.all([responseA, responseB]);
        const rowA = dialog.locator(".provider-row").filter({ hasText: "J7 Race Provider A" });
        const rowB = dialog.locator(".provider-row").filter({ hasText: "J7 Race Provider B" });
        await expect(rowA).toContainText("已添加 0/1");
        await expect(rowB).toContainText("已添加 0/1");
        // B's expanded row shows only B's own models — the late A response
        // never contaminates it.
        await rowB.locator(".provider-row-summary").click();
        await expect(rowB.locator(".provider-model-row").filter({ hasText: "race-provider-b-model" })).toBeVisible();
        await expect(rowB.locator(".provider-model-row").filter({ hasText: "race-provider-a-model" })).toHaveCount(0);
        // The late A response still lands in A's own row once it is expanded.
        await rowA.locator(".provider-row-summary").click();
        await expect(rowA.locator(".provider-model-row").filter({ hasText: "race-provider-a-model" })).toBeVisible();
        expect(stub.listPaths).toContain("/slow/v1/models");
        expect(stub.listPaths).toContain("/fast/v1/models");

        // Re-expand B (expanding A collapsed it) and add B's model to B.
        await rowB.locator(".provider-row-summary").click();
        const addResponse = page.waitForResponse((response) => response.request().method() === "POST"
          && new URL(response.url()).pathname === `/api/providers/${providerB.id}/models`);
        await rowB.locator(".provider-model-row")
          .filter({ hasText: "race-provider-b-model" })
          .getByRole("button", { name: "添加模型" })
          .click();
        const profile = await (await addResponse).json() as ModelProfile;
        modelIds.push(profile.id);
        raceModelId = profile.id;
        expect(profile.providerId).toBe(providerB.id);
        expect(profile.model).toBe("race-provider-b-model");
      },
    );

    await journey.step(
      "被全局默认模型引用的 Provider 给出本地化恢复提示",
      "把 Provider B 的模型设为全局默认后尝试删除 B。中文错误明确说明该服务商正被运行时设置引用，并指导先更换全局默认任务模型或评审模型；Provider 保持可用，恢复默认设置后用户可以继续操作。",
      async () => {
        const before = await apiJson<{ overrides: Record<string, unknown> }>(page, "/api/settings");
        await apiJson(page, "/api/settings", {
          data: { ...before.overrides, modelId: raceModelId },
          method: "PUT",
        });
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const providerRow = dialog.locator(".provider-row").filter({ hasText: "J7 Race Provider B" });
        if (!await providerRow.locator(".provider-row-detail").count()) {
          await providerRow.locator(".provider-row-summary").click();
        }
        // The editor never opens on its own; deleting is an explicit 编辑 first.
        await providerRow.getByRole("button", { name: "编辑", exact: true }).click();
        page.once("dialog", (confirmation) => {
          void confirmation.accept();
        });
        await dialog.getByRole("region", { name: "服务商编辑器" })
          .getByRole("button", { name: "删除" })
          .click();
        await expect(dialog.getByRole("alert")).toContainText(
          "此服务商正被运行时设置引用。请先更换全局默认任务模型或评审模型，再删除服务商。",
        );
        await expect(dialog.getByRole("region", { name: "已配置服务商" })
          .locator(".provider-row").filter({ hasText: "J7 Race Provider B" }).locator(".provider-row-summary")).toBeVisible();
        await apiJson(page, "/api/settings", { data: before.overrides, method: "PUT" });
        expect(raceProviderBId).toBeTruthy();
      },
    );

    await journey.step(
      "窄屏 Provider 设置仍紧凑且无横向溢出",
      "视口缩到 600×900 后，添加控件、编辑区、失败提示、手动添加表单与模型行保持单列可操作；对话框与页面没有横向溢出，输入框和模型行均在对话框边界内。",
      async () => {
        await page.setViewportSize({ width: 600, height: 900 });
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const geometry = await dialog.evaluate(() => {
          const bounds = document.querySelector(".system-config-dialog")!.getBoundingClientRect();
          const controls = Array.from(document.querySelectorAll(".provider-settings input, .provider-settings select, .provider-model-row"));
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
        await dialog.locator(".provider-add-model-toggle").click();
        await expect(dialog.getByLabel("手动模型 ID")).toBeVisible();
      },
    );

    await journey.step(
      "对话模型与思考强度遵守能力并跨刷新保存",
      "创建会话后，点击 Composer 的模型按钮弹出连接器风格的小弹窗，按 Provider 分组列出模型，DeepSeek 行为当前选中。切到不支持思考的 OpenAI fixture 时弹窗提示该模型不暴露思考字段、也没有分档控件；切回 DeepSeek 后思考是一排分档按钮：关闭 → 模型默认 → 低/高/最大，点“最大”即写入 Session，刷新页面仍显示同一模型与最大强度。",
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
        const picker = await pickConversationModel({ model: /J7 no-thinking fixture/ });
        await expect(picker.getByRole("option", { name: /J7 no-thinking fixture/ })).toHaveAttribute("aria-selected", "true");
        await expect(picker.getByText("此模型不暴露思考控制字段")).toBeVisible();
        await expect(thinkingStops(picker)).toHaveCount(0);
        await picker.getByRole("option", { name: /deepseek-v4-flash/ }).click();
        // 分档按钮：关闭 → 模型默认 → 低 → 高 → 最大
        await expect(thinkingStops(picker)).toHaveCount(5);
        await setThinkingStop(picker, "最大");
        await expect.poll(async () => {
          const session = await apiJson<{ thinkingEffort?: string; thinkingMode?: string }>(
            page,
            `/api/sessions/${encodeURIComponent(fixture!.session.id)}`,
          );
          return `${session.thinkingMode}/${session.thinkingEffort}`;
        }).toBe("enabled/max");
        await closeModelPicker(picker);
        await expect(page.locator(".model-picker-trigger-thinking")).toHaveText("最大");
        await page.reload();
        await openProjectSession(page, fixture);
        const reopened = await openModelPicker();
        await expect(reopened.getByRole("option", { name: /deepseek-v4-flash/ })).toHaveAttribute("aria-selected", "true");
        await expect(reopened.getByRole("radio", { name: "最大" })).toHaveAttribute("aria-checked", "true");
        await closeModelPicker(reopened);
      },
    );

    await journey.step(
      "Composer 在默认桌面与 600px 窄屏按可用容器换行",
      "工作区面板保持展开，在 1440×900 和 600×900 两个真实视口分别滚动到中文 Composer。模型选择入口（弹窗触发按钮）、审批、专家和运行控件都有可读标签/可访问名称，三类控件矩形两两不相交、中心命中自身、全部位于 Composer 和视口内；窄屏控件保持 24–48px 紧凑高度，页面无横向溢出。",
      async () => {
        await page.setViewportSize({ width: 1440, height: 900 });
        const showWorkspace = page.getByRole("button", { name: "显示工作区" });
        if (await showWorkspace.count()) await showWorkspace.click();
        await expect(page.getByRole("button", { name: "隐藏工作区" })).toBeVisible();
        const labels = ["本任务使用的模型", "审批", "专家"];
        await verifyComposerGeometry({ labels, runButton: "运行分析", width: 1440 });
        await verifyComposerGeometry({ labels, runButton: "运行分析", width: 600 });
      },
    );

    await journey.step(
      "所选模型与 DeepSeek 思考配置真实进入 Run",
      "发送消息后页面收到本地模拟模型的确定性答复；模拟服务捕获的真实 Chat Completions 请求 model=deepseek-v4-flash，thinking.type=enabled 且 reasoning_effort=max，证明选择不是仅界面展示。",
      async () => {
        await page.setViewportSize({ width: 1280, height: 720 });
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
      "GPT-5.5 只展示并发送合法 xhigh 强度",
      "通过 OpenAI 预设具体化 GPT-5.5 后，从 DeepSeek/max 切换模型会把 Session 的旧非法 max 原子归一化并持久化为 xhigh；刷新后模型与 xhigh 均保持。弹窗分档按钮恰为 关闭、模型默认、低、中、高、超高，不出现 max，本地 Responses fixture 收到 reasoning.effort=xhigh。",
      async () => {
        const provider = await apiJson<ModelProvider>(page, "/api/providers", {
          data: {
            apiToken: "j7-openai-local-token",
            baseUrl: stub.baseUrl,
            modelDiscovery: "manual",
            presetId: "openai",
          },
          method: "POST",
        });
        providerIds.push(provider.id);
        const gpt55 = await apiJson<ModelProfile>(page, `/api/providers/${encodeURIComponent(provider.id)}/models`, {
          data: { model: "gpt-5.5" },
          method: "POST",
        });
        modelIds.push(gpt55.id);
        await page.reload();
        await openProjectSession(page, fixture!);
        const picker = await pickConversationModel({ model: /gpt-5\.5/ });
        await expect(picker.getByRole("option", { name: /gpt-5\.5/ })).toHaveAttribute("aria-selected", "true");
        await expect.poll(async () => {
          const session = await apiJson<{ modelId?: string; thinkingEffort?: string }>(
            page,
            `/api/sessions/${encodeURIComponent(fixture!.session.id)}`,
          );
          return `${session.modelId}/${session.thinkingEffort}`;
        }).toBe(`${gpt55.id}/xhigh`);
        await closeModelPicker(picker);
        await page.reload();
        await openProjectSession(page, fixture!);
        const reopened = await openModelPicker();
        await expect(reopened.getByRole("option", { name: /gpt-5\.5/ })).toHaveAttribute("aria-selected", "true");
        // 关闭、模型默认、低、中、高、超高——没有 max 档。
        await expect(thinkingStops(reopened)).toHaveCount(6);
        await expect(reopened.getByRole("radio", { name: "超高" })).toHaveAttribute("aria-checked", "true");
        await expect(reopened.getByRole("radio", { name: "最大" })).toHaveCount(0);
        await closeModelPicker(reopened);
        const run = await sendUserMessage(page, fixture!.session.id, "Verify the GPT-5.5 Responses effort.");
        expect((await waitForRunTerminal(page, fixture!.session.id, run.id, 120_000)).status).toBe("completed");
        await expect(page.getByText("GPT-5.5 xhigh is active.")).toBeVisible();
        expect(stub.responsesBodies.at(-1)?.model).toBe("gpt-5.5");
        expect(stub.responsesBodies.at(-1)?.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
      },
    );

    await journey.step(
      "Kimi K3 始终推理且 low 强度真实进入请求",
      "通过 Moonshot Kimi 预设具体化 Kimi K3 后，思考分档按钮只有强度档（低、高、最大），没有“关”或“模型默认”，因为该模型不能关闭思考。点低后 Chat Completions wire 发送 reasoning_effort=low，且不发送无效 thinking.type。",
      async () => {
        const provider = await apiJson<ModelProvider>(page, "/api/providers", {
          data: {
            apiToken: "j7-kimi-local-token",
            baseUrl: stub.baseUrl,
            modelDiscovery: "manual",
            presetId: "moonshot",
          },
          method: "POST",
        });
        providerIds.push(provider.id);
        const k3 = await apiJson<ModelProfile>(page, `/api/providers/${encodeURIComponent(provider.id)}/models`, {
          data: { model: "kimi-k3" },
          method: "POST",
        });
        modelIds.push(k3.id);
        expect(k3.apiVariant).toBe("kimi-k3");
        await page.reload();
        await openProjectSession(page, fixture!);
        const picker = await pickConversationModel({ model: /kimi-k3/ });
        // 不能关闭思考的模型只有强度档，没有「关」。
        await expect(thinkingStops(picker)).toHaveCount(3);
        await expect(picker.getByRole("radio", { name: "关闭" })).toHaveCount(0);
        await setThinkingStop(picker, "低");
        await expect(picker.locator(".model-picker-slider-label strong")).toHaveText("低");
        await closeModelPicker(picker);
        const run = await sendUserMessage(page, fixture!.session.id, "Verify the Kimi K3 effort.");
        expect((await waitForRunTerminal(page, fixture!.session.id, run.id, 120_000)).status).toBe("completed");
        const request = stub.chatBodies.at(-1)!;
        expect(request.model).toBe("kimi-k3");
        expect(request.reasoning_effort).toBe("low");
        expect(request).not.toHaveProperty("thinking");
      },
    );

    await journey.step(
      "Claude Haiku 4.5 自动使用合法 legacy 思考预算",
      "通过默认 adaptive 的 Anthropic 预设具体化 Claude Haiku 4.5 时，模型自动落为 anthropic-legacy。Composer 弹窗展示旧式固定预算提示、分档按钮只给 关闭/模型默认/开启 三档；设置里该模型出现在 Anthropic 服务商的行内模型表（已添加在前）。开启后 Messages wire 使用 enabled+budget_tokens，且不发送仅 adaptive 支持的 output_config。",
      async () => {
        const provider = await apiJson<ModelProvider>(page, "/api/providers", {
          data: {
            apiToken: "j7-anthropic-local-token",
            baseUrl: stub.baseUrl,
            modelDiscovery: "manual",
            presetId: "anthropic",
          },
          method: "POST",
        });
        providerIds.push(provider.id);
        const haiku = await apiJson<ModelProfile>(page, `/api/providers/${encodeURIComponent(provider.id)}/models`, {
          data: { model: "claude-haiku-4-5" },
          method: "POST",
        });
        modelIds.push(haiku.id);
        expect(haiku.apiVariant).toBe("anthropic-legacy");
        await page.reload();
        await openProjectSession(page, fixture!);
        const picker = await pickConversationModel({ model: /claude-haiku-4-5/ });
        // 关闭、模型默认、开启——legacy 固定预算不提供强度档。
        await expect(thinkingStops(picker)).toHaveCount(3);
        await expect(picker.getByText(/旧式固定思考预算/)).toBeVisible();
        await setThinkingStop(picker, "开启");
        await closeModelPicker(picker);
        await expect(page.getByRole("note")).toContainText("此模型使用 Anthropic 旧式固定思考预算");

        const dialog = await openModelRegistry();
        // The advanced standalone profile editor is gone: the model lives in
        // its Anthropic provider's inline table, added models first.
        const anthropicRow = dialog.locator(".provider-row").filter({ hasText: "Anthropic" });
        if (!await anthropicRow.locator(".provider-row-detail").count()) {
          await anthropicRow.locator(".provider-row-summary").click();
        }
        const anthropicRow2 = dialog.locator(".provider-row").filter({ hasText: "Anthropic" });
        // The expanded Anthropic row lists both the catalog entry and the added
        // profile; the added row carries a disabled 已添加 button.
        const haikuAdded = anthropicRow2.locator(".provider-model-row")
          .filter({ hasText: "claude-haiku-4-5" })
          .getByRole("button", { name: "已添加" });
        await expect(haikuAdded).toHaveCount(1);
        await expect(haikuAdded).toBeDisabled();
        await expect(dialog.locator(".provider-model-row").first()).toContainText("claude-haiku-4-5");
        await dialog.getByRole("button", { name: "取消并关闭" }).first().click();
        await expect(dialog).toBeHidden();

        const run = await sendUserMessage(page, fixture!.session.id, "Verify Claude Haiku 4.5 legacy thinking.");
        expect((await waitForRunTerminal(page, fixture!.session.id, run.id, 120_000)).status).toBe("completed");
        await expect(page.getByText("Claude Haiku 4.5 legacy thinking is active.")).toBeVisible();
        const request = stub.anthropicBodies.at(-1)!;
        expect(request.model).toBe("claude-haiku-4-5");
        expect(request.thinking).toMatchObject({ type: "enabled" });
        expect((request.thinking as { budget_tokens: number }).budget_tokens).toBeGreaterThan(0);
        expect((request.thinking as { budget_tokens: number }).budget_tokens).toBeLessThan(request.max_tokens as number);
        expect(request).not.toHaveProperty("output_config");
      },
    );

    await journey.step(
      "设置与对话控件提供英文界面",
      "在系统设置的语言页选择 English 并保存关闭；对话区显示本地化模型选择入口，弹窗滑杆与“模型默认”文案同样本地化；在 1440×900、600×900 重复无重叠、紧凑高度、命中和溢出几何断言；重新打开模型注册表，Add provider 下拉列出预设、旁边有 Custom provider，Provider 行内展开可见模型表。",
      async () => {
        const zhPicker = await pickConversationModel({ model: /deepseek-v4-flash/ });
        await setThinkingStop(zhPicker, "最大");
        await closeModelPicker(zhPicker);
        const dialog = await openModelRegistry();
        await dialog.getByRole("navigation", { name: "设置分组" })
          .getByRole("button", { name: /^语言/ })
          .click();
        await dialog.getByLabel("界面语言").selectOption("en");
        await dialog.getByRole("button", { name: "保存并关闭" }).click();
        await expect(page.getByLabel("Model for this task")).toBeVisible();
        const enPicker = await openModelPicker();
        await expect(enPicker.getByRole("radio", { name: "Max" })).toHaveAttribute("aria-checked", "true");
        const enStopTexts = await thinkingStops(enPicker).allTextContents();
        expect(enStopTexts).toEqual(["Off", "Model default", "Low", "High", "Max"]);
        expect(enStopTexts).not.toContain("Auto");
        await expect(enPicker.getByRole("option", { name: /deepseek-v4-flash/ })).toHaveAttribute("aria-selected", "true");
        await closeModelPicker(enPicker);
        const labels = ["Model for this task", "Approvals", "Specialist"];
        await verifyComposerGeometry({ labels, runButton: "Run analysis", width: 1440 });
        await verifyComposerGeometry({ labels, runButton: "Run analysis", width: 600 });
        const englishDialog = await openModelRegistry();
        const enOptionTexts = await englishDialog.getByLabel("Add provider").locator("option").allTextContents();
        expect(enOptionTexts.some((text) => text.includes("DeepSeek"))).toBe(true);
        await expect(englishDialog.getByRole("button", { name: "Custom provider" })).toBeVisible();
        const registry = englishDialog.getByRole("region", { name: "Configured providers" });
        await registry.getByRole("button", { name: /DeepSeek/ }).click();
        const flash = englishDialog.locator(".provider-model-row").filter({ hasText: "deepseek-v4-flash" });
        await expect(flash).toContainText("USD 0.14 / 0.28");
        await expect(flash).toContainText("cached input 0.0028");
        await expect(flash).toContainText("per 1M tokens");
        await expect(flash).not.toContainText(/Peak|Off-peak|periods/);
        await expect(flash.getByRole("link")).toHaveCount(0);
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
