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
 * Purpose: 以服务商为中心的注册表：添加控件与编辑器分组紧凑可扫读；行内模型表（一行一模型）可扫读；
 *   手动登记支持逗号分隔的强度档声明；保存失败保留 Provider 草稿；旧的独立“模型卡片”入口已删除；桌面与窄屏可用。
 * Steps:
 *   1. 打开系统设置并进入模型注册表：空态、添加控件收在列表下「添加 Provider」按钮后（预置下拉+自定义按钮）、编辑器默认隐藏；旧独立模型入口不再出现。
 *   2. 显式选择自定义服务商：编辑器按分组展开，协议与变种同行紧凑；保存后服务商行自动展开并预载模型列表。
 *   3. 行内手动表单登记模型并以逗号分隔声明可接受强度档（原文）；视觉紧跟强度且与价格分开；“已添加”计数与行内模型行出现。
 *   4. 编辑 Provider 时保存失败：错误清楚、草稿保留；恢复后保存成功并重开保持一致。
 *   5. manual 发现为空时已添加模型仍在行内表占一行且排前、不出空态；模型自身名称无服务商前缀，已添加行提供删除；最后一行悬停详情逃出设置对话框裁切链且完整位于视口。
 *   6. 窄屏（600px）：对话框不越界、高级网格单列、模型行不横向溢出。
 *   7. 从已添加模型行执行删除，删除成功后行和已添加计数立即更新。
 * Environment: Isolated local stack at E2E_BASE_URL with isolated data dir；Provider 与模型由本旅程创建并清理。
 * Type: mocked
 * LLM: none — 仅配置 Provider 与模型并回读，不发起点模型调用。
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — 非本地浏览器请求被拦截；令牌为本地演示值，端点 127.0.0.1:4321 不接收请求。
 * Credentials: E2E_API_TOKEN（隔离实例）与新建 Provider 的本地演示令牌（无外部访问）。
 * CostSideEffects: none；创建的 Provider 与模型记录在 finally 中删除。
 */
test("J6 模型设置分组紧凑、可扫读且窄屏可用", { tag: "@mocked" }, async ({ journey, page }) => {
  test.setTimeout(180_000);
  journey.scenario({
    goal: "一位用户要为模型服务商配置策略：先确认注册表入口与空态、添加控件紧凑清楚，"
      + "再验证服务商编辑器分组、行内模型表可扫读、思考档位、失败恢复，并确认桌面和窄屏下都整齐可用。",
    preconditions: [
      "隔离栈已启动，浏览器已持有本实例的访问 token",
      "实例内没有可用模型与服务商；新建的 Provider 与模型由本旅程创建并在结束时清理",
      "浏览器与界面语言均为 zh-CN",
      "mocked：仅配置并回读，不发起任何模型调用",
    ],
  });
  await page.addInitScript(() => window.localStorage.setItem("science-agent-locale", "zh-CN"));

  const providerName = `J6 紧凑服务商 ${Date.now()}`;
  const demoToken = "sk-e2e-demo-local";
  let createdProviderId: string | undefined;
  let createdModelId: string | undefined;
  const geometryModelIds = new Set<string>();

  // The add panel starts open when nothing is configured yet (first-run
  // path) and stays closed once a provider exists; only click when needed.
  const openAddPanel = async (dialog: ReturnType<typeof page.getByRole>) => {
    if (!await dialog.locator(".provider-add-panel").count()) {
      await dialog.getByRole("button", { name: /添加 Provider/ }).first().click();
    }
    return dialog.locator(".provider-add-panel");
  };

  const openModelRegistry = async () => {
    const dialog = page.getByRole("dialog", { name: "系统设置" });
    if (!await dialog.isVisible()) {
      await page.getByRole("button", { name: /^系统设置/ }).click();
    }
    await dialog.getByRole("navigation", { name: "设置分组" })
      .getByRole("button", { name: /^模型注册表/ })
      .click();
    return dialog;
  };

  try {
    await journey.step(
      "打开模型注册表：空态、添加控件与编辑器默认隐藏",
      "注册表入口高亮；右侧出现标题与说明；还没有服务商时给出“添加预置或自定义”的空态引导。"
      + "添加收在列表下「添加 Provider」按钮后（点开才有预置下拉与自定义按钮），编辑器只在显式选择后出现；旧的高级独立模型入口不再存在。",
      async () => {
        await page.goto("/");
        await expect(page).toHaveTitle("ScienceDiscovery");
        const dialog = await openModelRegistry();
        await expect(dialog.getByRole("heading", { name: "模型注册表" })).toBeVisible();
        await expect(dialog.getByText("管理运行时设置可用的模型配置和凭证。")).toBeVisible();
        await expect(dialog.getByText("还没有服务商——点击下方“添加 Provider”选择预置或自定义服务商。")).toBeVisible();
        await expect(dialog.getByRole("button", { name: /添加 Provider/ }).first()).toBeVisible();
        // 空态即首启路径：添加面板默认已展开，不能再点（那会把面板收起）。
        await expect(dialog.locator(".provider-add-panel")).toBeVisible();
        await expect(dialog.locator(".provider-add-panel").getByLabel("添加 Provider", { exact: true })).toBeVisible();
        await expect(dialog.locator(".provider-add-panel").getByRole("button", { name: /^自定义服务商$/ })).toBeVisible();
        await expect(dialog.getByRole("region", { name: "服务商编辑器" })).toHaveCount(0);
        await expect(dialog.getByRole("region", { name: "模型元数据目录" })).toBeVisible();
        // 九条 4：高级独立模型配置已删除——不再有“+ 添加模型”入口或模型卡片。
        await expect(dialog.getByRole("button", { name: "+ 添加模型" })).toHaveCount(0);
        await expect(dialog.locator(".model-card")).toHaveCount(0);
        const nav = dialog.getByRole("navigation", { name: "设置分组" })
          .getByRole("button", { name: /^模型注册表/ });
        await expect(nav).toHaveAttribute("aria-current", "page");
      },
    );

    await journey.step(
      "显式选择自定义服务商：编辑器分组紧凑可扫读",
      "点“自定义服务商”后才出现编辑器——打开注册表绝不自动选中任何服务商。"
      + "主区是名称与密钥；高级连接默认展开：基础 URL 独占一行，接口协议、接口变种与 LLM 网络代理服务器同一行，不再单独选择模型列表策略。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await openAddPanel(dialog);
        await dialog.locator(".provider-add-panel").getByRole("button", { name: /^自定义服务商$/ }).click();
        const editor = dialog.getByRole("region", { name: "服务商编辑器" });
        await expect(editor).toBeVisible();
        await expect(editor.getByLabel("服务商名称")).toBeVisible();
        await expect(editor.getByLabel("LLM API 令牌")).toBeVisible();
        await expect(editor.getByLabel("基础 URL")).toBeVisible();
        await expect(editor.getByLabel("基础接口")).toBeVisible();
        await expect(editor.getByLabel("接口变种")).toBeVisible();
        await expect(editor.getByLabel("模型列表")).toHaveCount(0);
        await expect(editor.getByText("LLM 网络代理服务器")).toBeVisible();
        // 基础 URL 独占一行；接口协议、接口变种与代理同一行。
        const pairings = await editor.evaluate(() => {
          const rowOf = (label: string) => {
            const s = Array.from(document.querySelectorAll(".provider-editor label > span"))
              .find((x) => x.textContent.trim() === label);
            return s ? s.parentElement.getBoundingClientRect() : null;
          };
          const url = rowOf("基础 URL");
          const protocol = rowOf("基础接口");
          const variant = rowOf("接口变种");
          const proxy = rowOf("LLM 网络代理服务器");
          return {
            urlOwnRow: Boolean(url && protocol && url.top < protocol.top - 4),
            protocolVariantSameRow: Boolean(protocol && variant && Math.abs(protocol.top - variant.top) < 2),
            variantProxySameRow: Boolean(variant && proxy && Math.abs(variant.top - proxy.top) < 2),
          };
        });
        expect(pairings.urlOwnRow).toBe(true);
        expect(pairings.protocolVariantSameRow).toBe(true);
        expect(pairings.variantProxySameRow).toBe(true);
      },
    );

    await journey.step(
      "保存自定义服务商并手动登记模型，选最强思考",
      "填写本地端点、令牌、DeepSeek 变种与“手动 ID 与维护目录”后保存；服务商行立即展开并预载。"
      + "行内手动表单收在「添加模型」按钮后；用逗号分隔的原文强度档（如 max）声明可接受思考强度，"
      + "支持视觉紧跟思考强度且不与价格一组；不提供强度时默认省略思考参数。登记后出现“已添加”计数与行内模型行，操作变为删除。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const editor = dialog.getByRole("region", { name: "服务商编辑器" });
        await editor.getByLabel("服务商名称").fill(providerName);
        await editor.getByLabel("LLM API 令牌").fill(demoToken);
        await editor.getByLabel("基础 URL").fill("http://127.0.0.1:4321/v1");
        await editor.getByLabel("接口变种").selectOption("deepseek");
        const providerSave = page.waitForResponse((response) =>
          response.request().method() === "POST" && new URL(response.url()).pathname === "/api/providers");
        await editor.getByRole("button", { name: "保存", exact: true }).click();
        const saved = await (await providerSave).json() as { id: string; name: string };
        createdProviderId = saved.id;

        const row = dialog.locator(".provider-row").filter({ hasText: providerName });
        await expect(row.locator(".provider-row-detail")).toBeVisible();
        // 手动表单收在“添加模型”按钮后，不常驻。
        await expect(row.locator(".provider-manual-form")).toHaveCount(0);
        await row.locator(".provider-add-model-toggle").click();
        await expect(row.locator(".provider-manual-form")).toBeVisible();
        await expect(dialog.getByLabel("思考默认值（可选）")).toHaveCount(0);
        await dialog.getByLabel("手动模型 ID").fill("deepseek-chat");
        await dialog.getByLabel("思考强度档（逗号分隔，可选）").fill("low,max");
        const manualLayout = await row.locator(".provider-manual-form").evaluate((form) => {
          const children = Array.from(form.children);
          const effort = children.findIndex((child) => child.textContent?.includes("思考强度档"));
          const vision = children.findIndex((child) => child.classList.contains("provider-manual-vision"));
          const price = children.findIndex((child) => child.classList.contains("provider-manual-price"));
          const effortRect = children[effort]?.getBoundingClientRect();
          const visionRect = children[vision]?.getBoundingClientRect();
          const priceRect = children[price]?.getBoundingClientRect();
          return {
            effort,
            price,
            sameRow: Boolean(effortRect && visionRect && Math.abs(effortRect.top - visionRect.top) < 2),
            vision,
            priceBelow: Boolean(visionRect && priceRect && priceRect.top > visionRect.top + 2),
          };
        });
        expect(manualLayout.vision).toBe(manualLayout.effort + 1);
        expect(manualLayout.price).toBeGreaterThan(manualLayout.vision);
        expect(manualLayout.sameRow).toBe(true);
        expect(manualLayout.priceBelow).toBe(true);
        const modelResponsePromise = page.waitForResponse((response) =>
          response.request().method() === "POST" && new URL(response.url()).pathname
            === `/api/providers/${createdProviderId}/models`);
        await dialog.locator(".provider-manual-form").getByRole("button", { name: "添加模型" }).click();
        const created = await (await modelResponsePromise).json() as { id: string };
        createdModelId = created.id;
        await expect(row).toContainText("已添加 1");
        const modelRow = row.locator(".provider-model-row").filter({ hasText: "deepseek-chat" });
        await expect(modelRow).toBeVisible();
        await expect(modelRow.locator(".provider-model-cell-name strong")).toHaveText("DeepSeek Chat");
        await expect(modelRow.locator(".provider-model-cell-name strong")).not.toContainText(providerName);
        await expect(modelRow.getByRole("button", { name: "删除" })).toBeEnabled();
      },
    );

    await journey.step(
      "编辑 Provider 保存失败时保留草稿，恢复后可保存",
      "点“编辑”打开同一草稿；修改名称后保存被本地故障注入拒绝——错误清楚可见、草稿保留、服务商仍可用；恢复后重试保存成功。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const row = dialog.locator(".provider-row").filter({ hasText: providerName });
        await row.getByRole("button", { name: "编辑", exact: true }).click();
        const editor = dialog.getByRole("region", { name: "服务商编辑器" });
        const updatedName = providerName + " 未保存";
        await editor.getByLabel("服务商名称").fill(updatedName);
        const providerPath = "/api/providers/" + encodeURIComponent(createdProviderId!);
        const providerUrl = (url: URL) => url.pathname === providerPath;
        await page.route(providerUrl, async (route) => {
          await route.fulfill({
            body: JSON.stringify({ error: "fixture provider save denied" }),
            contentType: "application/json",
            status: 500,
          });
        });
        await editor.getByRole("button", { name: "保存", exact: true }).click();
        await expect(dialog.getByText(/fixture provider save denied/)).toBeVisible();
        await expect(editor.getByLabel("服务商名称")).toHaveValue(updatedName);
        await expect(dialog.getByRole("region", { name: "已配置服务商" })).toBeVisible();
        await page.unroute(providerUrl);

        const expectedName = providerName + " 已更新";
        await editor.getByLabel("服务商名称").fill(expectedName);
        const saveResponse = page.waitForResponse((response) =>
          response.request().method() === "PUT" && new URL(response.url()).pathname === providerPath);
        await editor.getByRole("button", { name: "保存", exact: true }).click();
        expect((await saveResponse).ok()).toBe(true);
        await expect(dialog.locator(".provider-row").filter({ hasText: expectedName })).toBeVisible();
      },
    );

    await journey.step(
      "已添加模型持久占行，测试下拉可选",
      "manual 发现策略不返回服务商模型列表，但手动登记的模型必须仍在行内表占一行且排最前：保存服务商、重开设置后仍在，"
      + "不出现“服务商未返回模型”空态；行计数为“已添加 1”，并出现在“选择要测试的模型”下拉中，可单独测试。"
      + "悬停模型表最后一行时，详情卡可以跨出设置对话框边界且仍完整显示在视口内。",
      async () => {
        const dialog = await openModelRegistry();
        const row = dialog.locator(".provider-row").filter({ hasText: providerName + " 已更新" });
        if (!await row.locator(".provider-row-detail").count()) {
          await row.locator(".provider-row-summary").click();
        }
        await expect(row).toContainText("已添加 1");
        // 发现为空也不能吞掉已添加模型：行内表仍有该模型一行且提供删除。
        const modelRow = row.locator(".provider-model-row").filter({ hasText: "deepseek-chat" });
        await expect(modelRow).toBeVisible();
        await expect(modelRow.getByRole("button", { name: "删除" })).toBeEnabled();
        await expect(modelRow.locator(".provider-model-cell-name strong")).toHaveText("DeepSeek Chat");
        await expect(row.locator(".provider-model-row").first()).toContainText("deepseek-chat");
        await expect(row.getByText("服务商未返回模型")).toHaveCount(0);
        const testSelect = row.getByLabel("选择要测试的模型");
        await expect(testSelect).toBeVisible();
        // 选项文本是显示名（服务商 · 目录标签），按 profile id 锚定而不是原文 id。
        await expect(testSelect.locator(`option[value="${createdModelId}"]`)).toHaveCount(1);
        const options = await testSelect.locator("option").allTextContents();
        expect(options.some((text) => text.includes("DeepSeek Chat"))).toBe(true);

        // Add enough disposable rows to make the settings detail genuinely
        // scrollable. Without this fixture, a one-row table stays near the
        // top of the dialog and cannot exercise the clipping boundary.
        for (let index = 1; index <= 12; index += 1) {
          const response = await page.request.fetch(
            `${apiBaseUrl()}/api/providers/${encodeURIComponent(createdProviderId!)}/models`,
            {
              data: {
                label: `J6 geometry model ${String(index).padStart(2, "0")}`,
                model: `j6-geometry-${String(index).padStart(2, "0")}`,
              },
              headers: authorizationHeader(),
              method: "POST",
            },
          );
          expect(response.ok(), `geometry model ${index} should be created`).toBe(true);
          const created = await response.json() as { id: string };
          geometryModelIds.add(created.id);
        }

        await page.reload();
        const geometryDialog = await openModelRegistry();
        const geometryRow = geometryDialog.locator(".provider-row").filter({ hasText: providerName + " 已更新" });
        if (!await geometryRow.locator(".provider-row-detail").count()) {
          await geometryRow.locator(".provider-row-summary").click();
        }
        await expect(geometryRow.locator(".provider-model-row")).toHaveCount(13);

        // Use a tall desktop viewport and place the actual last row below the
        // dialog's clipping boundary while leaving room for the popup below
        // the anchor. A descendant popup would still be clipped here.
        await page.setViewportSize({ width: 1_360, height: 1_300 });
        const lastModelRow = geometryRow.locator(".provider-model-table .provider-model-row").last();
        await expect(lastModelRow).toContainText("j6-geometry-12");
        const placement = await lastModelRow.evaluate((node) => {
          const scroller = node.closest<HTMLElement>(".settings-group-detail");
          const dialogNode = node.closest<HTMLElement>(".system-config-dialog");
          if (!scroller || !dialogNode) throw new Error("model row is outside the settings dialog");
          const current = node.getBoundingClientRect();
          const dialogRect = dialogNode.getBoundingClientRect();
          const targetBottom = Math.min(window.innerHeight - 244, dialogRect.bottom - 96);
          const maxScroll = scroller.scrollHeight - scroller.clientHeight;
          scroller.scrollTop = Math.min(maxScroll, scroller.scrollTop + current.bottom - targetBottom);
          const placed = node.getBoundingClientRect();
          return {
            dialogBottom: dialogRect.bottom,
            maxScroll,
            rowBottom: placed.bottom,
            scrollTop: scroller.scrollTop,
            targetBottom,
            viewportHeight: window.innerHeight,
          };
        });
        expect(placement.maxScroll).toBeGreaterThan(0);
        expect(placement.scrollTop).toBeGreaterThan(0);
        expect(Math.abs(placement.rowBottom - placement.targetBottom)).toBeLessThan(2);
        expect(placement.rowBottom).toBeGreaterThan(placement.dialogBottom - 120);
        expect(placement.rowBottom + 244).toBeLessThanOrEqual(placement.viewportHeight);
        await lastModelRow.hover();
        const popup = page.locator("body > .provider-model-popup");
        await expect(popup).toBeVisible();
        const popupGeometry = await popup.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          const dialogRect = document.querySelector(".system-config-dialog")!.getBoundingClientRect();
          return {
            bottom: rect.bottom,
            dialogBottom: dialogRect.bottom,
            fullyInViewport: rect.left >= 0 && rect.top >= 0
              && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
            portalAtBody: node.parentElement === document.body,
          };
        });
        expect(popupGeometry.portalAtBody).toBe(true);
        expect(popupGeometry.fullyInViewport).toBe(true);
        expect(popupGeometry.bottom).toBeGreaterThan(popupGeometry.dialogBottom + 1);
        await geometryDialog.getByRole("button", { name: "取消并关闭" }).filter({ hasText: "取消并关闭" }).click();
        await expect(geometryDialog).toBeHidden();

        for (const modelId of [...geometryModelIds]) {
          const response = await page.request.fetch(`${apiBaseUrl()}/api/models/${encodeURIComponent(modelId)}`, {
            headers: authorizationHeader(),
            method: "DELETE",
          });
          expect(response.ok(), `geometry model ${modelId} should be deleted`).toBe(true);
          geometryModelIds.delete(modelId);
        }
        await page.reload();
      },
    );

    await journey.step(
      "窄屏下设置对话框仍整齐可用",
      "视口收到约 600px 宽后重新打开设置：对话框不超出屏幕、页面无横向滚动；高级配置网格转为单列，"
      + "行内模型行两端都在对话框边界内，逗号分隔的思考强度输入展开后可见可操作。",
      async () => {
        await page.setViewportSize({ width: 600, height: 900 });
        const dialog = await openModelRegistry();
        const row = dialog.locator(".provider-row").filter({ hasText: providerName + " 已更新" });
        if (!await row.locator(".provider-row-detail").count()) {
          await row.locator(".provider-row-summary").click();
        }
        await row.getByRole("button", { name: "编辑", exact: true }).click();
        const geometry = await dialog.evaluate(() => {
          const d = document.querySelector(".system-config-dialog")!.getBoundingClientRect();
          const topOf = (label: string) => {
            const s = Array.from(document.querySelectorAll(".provider-editor label > span"))
              .find((x) => x.textContent.trim() === label);
            return s ? s.parentElement.getBoundingClientRect().top : null;
          };
          const protocolTop = topOf("基础接口");
          const variantTop = topOf("接口变种");
          const modelRows = Array.from(document.querySelectorAll(".provider-model-row"))
            .every((el) => {
              const b = el.getBoundingClientRect();
              return b.right <= d.right + 1 && b.left >= d.left - 1;
            });
          const selects = Array.from(document.querySelectorAll(".provider-settings select"))
            .every((el) => {
              const b = el.getBoundingClientRect();
              return b.right <= d.right + 1 && b.left >= d.left - 1;
            });
          return {
            vw: window.innerWidth,
            dialogRight: Math.round(d.right),
            docScrollW: document.documentElement.scrollWidth,
            singleColumn: protocolTop != null && variantTop != null && Math.abs(protocolTop - variantTop) > 2,
            modelRowsInside: modelRows,
            selectsInside: selects,
          };
        });
        expect(geometry.dialogRight).toBeLessThanOrEqual(geometry.vw + 1);
        expect(geometry.docScrollW).toBeLessThanOrEqual(geometry.vw + 1);
        expect(geometry.singleColumn).toBe(true);
        expect(geometry.modelRowsInside).toBe(true);
        expect(geometry.selectsInside).toBe(true);
        // 思考档输入在收起的手动表单里：先点该行「添加模型」展开。
        await row.locator(".provider-add-model-toggle").click();
        await dialog.getByLabel("思考强度档（逗号分隔，可选）").scrollIntoViewIfNeeded();
        await expect(dialog.getByLabel("思考强度档（逗号分隔，可选）")).toBeInViewport();
      },
    );

    await journey.step(
      "已添加模型可以从行内表删除",
      "点击已添加模型行的“删除”，请求成功后模型行消失、已添加计数归零；失败时则应保留行并显示服务端错误。",
      async () => {
        const modelId = createdModelId!;
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const row = dialog.locator(".provider-row").filter({ hasText: providerName + " 已更新" });
        const modelRow = row.locator(".provider-model-row").filter({ hasText: "deepseek-chat" });
        const modelPath = `/api/models/${encodeURIComponent(modelId)}`;
        const modelUrl = (url: URL) => url.pathname === modelPath;
        await page.route(modelUrl, async (route) => {
          await route.fulfill({
            body: JSON.stringify({ error: "fixture model is still referenced" }),
            contentType: "application/json",
            status: 409,
          });
        });
        await modelRow.getByRole("button", { name: "删除" }).click();
        await expect(dialog.getByText(/无法删除模型.*fixture model is still referenced/)).toBeVisible();
        await expect(modelRow).toBeVisible();
        await page.unroute(modelUrl);

        // The first usable model becomes the global task default. Exercise
        // the real success path only after removing that public settings
        // reference; deleting a referenced model is correctly rejected.
        const settingsResponse = await page.request.fetch(`${apiBaseUrl()}/api/settings`, {
          headers: authorizationHeader(),
        });
        expect(settingsResponse.ok()).toBe(true);
        const settings = await settingsResponse.json() as { overrides?: Record<string, unknown> };
        const overrides = { ...(settings.overrides ?? {}) };
        for (const key of ["modelId", "reviewModelId"]) {
          if (overrides[key] === modelId) delete overrides[key];
        }
        const updateResponse = await page.request.fetch(`${apiBaseUrl()}/api/settings`, {
          data: overrides,
          headers: authorizationHeader(),
          method: "PUT",
        });
        expect(updateResponse.ok()).toBe(true);

        const responsePromise = page.waitForResponse((response) => response.request().method() === "DELETE"
          && new URL(response.url()).pathname === modelPath);
        await modelRow.getByRole("button", { name: "删除" }).click();
        expect((await responsePromise).ok()).toBe(true);
        await expect(modelRow).toHaveCount(0);
        await expect(row).toContainText("已添加 0");
        createdModelId = undefined;
      },
    );
  } finally {
    for (const modelId of geometryModelIds) {
      await page.request
        .fetch(`${apiBaseUrl()}/api/models/${encodeURIComponent(modelId)}`, {
          headers: authorizationHeader(),
          method: "DELETE",
        })
        .catch(() => undefined);
    }
    if (createdModelId) {
      // 手动添加的模型可能成为全局默认，删除前先清除 settings 引用。
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
    if (createdProviderId) {
      await page.request
        .fetch(`${apiBaseUrl()}/api/providers/${encodeURIComponent(createdProviderId)}`, {
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
