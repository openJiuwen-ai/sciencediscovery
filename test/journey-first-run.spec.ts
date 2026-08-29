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

import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { expect, type Page } from "@playwright/test";

import { test } from "./helpers/e2e.ts";
import {
  cleanupJourney,
  expandToolStep,
  handlePermissionsUntilTerminal,
  openProjectSession,
  scriptedModel,
  sendUserMessage,
  waitForRunTerminal,
  type JourneyFixture,
  type JourneyModel,
  type JourneyProject,
  type JourneySession,
} from "./helpers/journeys.ts";

test.use({ locale: "zh-CN" });

/**
 * E2E-META
 * Purpose: A first-time Chinese user can configure a model, create a Project, run two tasks, and return to the persisted work.
 * Steps:
 *   1. Open an empty zh-CN workbench and configure a Chat Completions reasoning variant through System settings.
 *   2. Create a Project through the UI, then explicitly select the newly registered model for the task.
 *   3. Send a shell-backed request, inspect its marked tool input/output, and observe completion.
 *   4. Send a second request whose output proves the persistent shell retained state from the first request.
 *   5. Reload and verify the same Project, Session, messages, and expandable tool history remain.
 * Environment: Isolated local stack at E2E_BASE_URL with an empty model/project catalog; zh-CN browser locale and persisted UI locale.
 * Type: mocked
 * LLM: journey-owned OpenAI-compatible HTTP stub on 127.0.0.1; two deterministic user turns.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — shell runs inside the local sandbox and non-local browser requests are aborted.
 * Credentials: E2E_API_TOKEN for the isolated local API only; the stub token has no external access.
 * CostSideEffects: no external cost; temporary model and Project records are deleted in finally.
 */
test("J1 首次进入即可完成并恢复两轮分析", { tag: "@mocked" }, async ({ journey, page, playwright }) => {
  test.setTimeout(180_000);
  journey.scenario({
    goal: "一位第一次打开 ScienceDiscovery 的中文用户，要把工作台配起来，"
      + "并确认产品真的在本机执行命令、记得上一条命令留下的状态，刷新之后工作也还在。",
    preconditions: [
      "隔离栈已启动，浏览器已持有本实例的访问 token",
      "实例内没有可用模型、没有项目；模型与项目都由本旅程自己创建并在结束时清理",
      "浏览器语言与界面语言均为 zh-CN",
      "模型由旅程自带的本地 stub 驱动，不访问任何外部服务",
    ],
  });
  await page.addInitScript(() => window.localStorage.setItem("sciencediscovery-locale", "zh-CN"));

  const firstMarker = `J1-FIRST-${Date.now()}`;
  const persistentValue = `J1-PERSIST-${Date.now()}`;
  const secondMarker = `J1-SECOND-${Date.now()}`;
  const stub = await scriptedModel([
    [
      {
        arguments: {
          command: `cd /workspace && export J1_VAR=${persistentValue} && echo ${firstMarker}`,
          kernelMode: "persistent",
        },
        delayMs: 700,
        tool: "run_shell",
      },
      { text: `首次分析已完成，工具输出标记为 ${firstMarker}。` },
    ],
    [
      {
        arguments: {
          command: `pwd -P && printf '${secondMarker}:%s\\n' "$J1_VAR"`,
          kernelMode: "persistent",
        },
        delayMs: 700,
        tool: "run_shell",
      },
      { text: `第二次分析已完成，并从第二条命令读回 ${persistentValue}。` },
    ],
  ]);

  const firstPrompt = "在持久 shell 中保存一个值，并把本轮标记打印出来。";
  const secondPrompt = "继续使用同一个持久 shell，只用第二条命令读回刚才保存的值。";
  let fixture: JourneyFixture | undefined;
  let modelName = "";
  let providerName = "";
  let providerId = "";
  let model: JourneyModel | undefined;

  const apiJsonSafe = async (path: string, init?: { data?: unknown; method?: string }) => {
    const response = await page.request.fetch(`${apiBaseUrl()}${path}`, {
      ...(init?.data === undefined ? {} : { data: init.data }),
      headers: authorizationHeader(),
      method: init?.method ?? "GET",
    });
    if (!response.ok()) return undefined;
    return response.json() as Promise<unknown>;
  };

  // Cleanup runs in `finally` after the page may already be gone, so it uses a
  // standalone request context instead of `page.request` (which silently fails
  // once the page fixture is gone). Disposed at the very end of `finally`.
  const api = await playwright.request.newContext({
    baseURL: apiBaseUrl(),
    extraHTTPHeaders: authorizationHeader(),
  });

  try {
    await journey.step(
      "打开工作台首页",
      "首页标题与侧栏品牌是 ScienceDiscovery，并给出「创建项目」「配置模型」这两个上手入口。",
      async () => {
        await page.goto("/");
        await expect(page).toHaveTitle("ScienceDiscovery");
        await expect(page.getByText("ScienceDiscovery").first()).toBeVisible();
        await expect(page.getByText("创建项目", { exact: true })).toBeVisible();
        await expect(page.getByText("配置模型", { exact: true })).toBeVisible();
      },
    );

    await journey.step(
      "在模型注册表添加自定义服务商并手动登记模型",
      "注册表以服务商为中心：添加是“下拉+自定义服务商按钮”而不再是预置卡墙，编辑器只在显式选择后才出现；填写本地端点与令牌、选 DeepSeek 变种后保存（模型列表策略跟随基础接口，不再由用户选择）；行展开后点「添加模型」才出现手动表单，登记模型；保存后行内显示已添加计数，重开设置后仍在。",
      async () => {
        await page.getByRole("button", { name: /^系统设置/ }).click();
        const settings = page.getByRole("dialog", { name: "系统设置" });
        await settings.getByRole("navigation", { name: "设置分组" })
          .getByRole("button", { name: /^模型注册表/ })
          .click();
        await expect(settings.getByRole("heading", { name: "模型注册表" })).toBeVisible();
        // The editor only appears after an explicit choice, never on open.
        await expect(settings.getByRole("region", { name: "服务商编辑器" })).toHaveCount(0);
        providerName = `J1 自定义服务商 ${Date.now()}`;
        await settings.getByRole("button", { name: "自定义服务商" }).click();
        const editor = settings.getByRole("region", { name: "服务商编辑器" });
        await expect(editor).toBeVisible();
        await editor.getByLabel("服务商名称").fill(providerName);
        await editor.getByLabel("LLM API 令牌").fill(stub.apiToken);
        // 自定义服务商的高级连接默认展开；配置端点与变种。模型列表策略不再由
        // 用户选择——它跟随基础接口，且总是去问服务商自己的接口。
        await editor.getByLabel("基础 URL").fill(stub.baseUrl);
        await editor.getByLabel("接口变种").selectOption("deepseek");
        const providerSave = page.waitForResponse((response) =>
          response.request().method() === "POST" && new URL(response.url()).pathname === "/api/providers");
        await editor.getByRole("button", { name: "保存" }).click();
        const savedProvider = await (await providerSave).json() as { id: string; name: string };
        providerId = savedProvider.id;
        expect(savedProvider.name).toBe(providerName);
        // 保存后自动展开该服务商并预载。手动表单收在「添加模型」后面，先点开
        // 再填；添加不再写思考默认值，新档案落在省略思考参数的模型默认上。
        const row = settings.locator(".provider-row").filter({ hasText: providerName });
        await expect(row.locator(".provider-row-detail")).toBeVisible();
        await row.locator(".provider-add-model-toggle").click();
        await expect(settings.getByLabel("思考默认值（可选）")).toHaveCount(0);
        await settings.getByLabel("手动模型 ID").fill(stub.model);
        const modelResponsePromise = page.waitForResponse((response) =>
          response.request().method() === "POST" && new URL(response.url()).pathname
            === `/api/providers/${providerId}/models`);
        await settings.locator(".provider-manual-form").getByRole("button", { name: "添加模型" }).click();
        model = await (await modelResponsePromise).json() as JourneyModel;
        await expect(row).toContainText("已添加 1");
        await expect(row.locator(".provider-model-row").filter({ hasText: stub.model })).toBeVisible();

        // 关闭后重开：服务商与已添加模型仍在。
        await settings.getByRole("button", { name: "取消并关闭" }).filter({ hasText: "取消并关闭" }).click();
        await expect(settings).toBeHidden();
        await page.getByRole("button", { name: /^系统设置/ }).click();
        const reopened = page.getByRole("dialog", { name: "系统设置" });
        await reopened.getByRole("navigation", { name: "设置分组" })
          .getByRole("button", { name: /^模型注册表/ })
          .click();
        await expect(reopened.locator(".provider-row").filter({ hasText: providerName }))
          .toContainText("已添加 1");
        // 手动登记（manual 策略无目录建议）的模型在重开设置后仍占有行内表一行，不被发现为空吞掉。
        const reopenedRow = reopened.locator(".provider-row").filter({ hasText: providerName });
        if (!await reopenedRow.locator(".provider-row-detail").count()) {
          await reopenedRow.locator(".provider-row-summary").click();
        }
        await expect(reopenedRow.locator(".provider-model-row").filter({ hasText: stub.model })).toBeVisible();
        await reopened.getByRole("button", { name: "取消并关闭" }).filter({ hasText: "取消并关闭" }).click();
        await expect(reopened).toBeHidden();
      },
    );

    await journey.step(
      "创建项目并为这次任务选择模型",
      "项目创建后自动打开它的第一个会话；在「本任务使用的模型」里能选中刚配置好的模型。",
      async () => {
        const projectName = `J1 首次分析 ${Date.now()}`;
        await page.getByRole("button", { name: "添加项目" }).click();
        const createProject = page.getByRole("dialog", { name: "创建项目" });
        await createProject.getByLabel("项目名称").fill(projectName);
        const projectResponsePromise = page.waitForResponse((response) =>
          response.request().method() === "POST" && new URL(response.url()).pathname === "/api/projects");
        await createProject.getByRole("button", { name: "创建项目", exact: true }).click();
        const created = await (await projectResponsePromise).json() as {
          firstSession: JourneySession;
          project: JourneyProject;
        };
        fixture = { model: model!, project: created.project, session: created.firstSession };

        await expect(page.getByRole("heading", { name: created.firstSession.title })).toBeVisible();
        // The composer trigger opens the connector-style popover; the model row
        // carries the manually registered model. Close the popover with Escape
        // (the popover has no explicit close button).
        await page.getByLabel("本任务使用的模型").click();
        const picker = page.getByRole("dialog", { name: "选择模型" });
        const modelOption = picker.getByRole("option", { name: new RegExp(stub.model.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")) });
        await modelOption.click();
        await expect(modelOption).toHaveAttribute("aria-selected", "true");
        await page.keyboard.press("Escape");
        await expect(picker).toBeHidden();
        await expect(page.locator(".model-picker-trigger-name")).toContainText(stub.model);
        // 手动添加不再写思考默认值，新档案落在省略思考控制字段的「模型默认」上。
        await expect(page.locator(".model-picker-trigger-thinking")).toContainText("\u6a21\u578b\u9ed8\u8ba4");
      },
    );

    await journey.step(
      "发出第一条分析任务并批准权限请求",
      "任务发出后主按钮变成可点的「停止当前运行」；受控动作的审批卡出现在主对话，批准后本轮运行完成。",
      async () => {
        const firstRun = await sendUserMessage(page, fixture!.session.id, firstPrompt);
        await expect(page.getByRole("button", { name: "停止当前运行" })).toBeVisible();
        const { decisions, run: firstTerminal } = await handlePermissionsUntilTerminal(
          page,
          fixture!.session.id,
          firstRun.id,
          { decision: "allow-matching" },
        );
        expect(decisions).toBe(1);
        expect(firstTerminal.status).toBe("completed");
      },
    );

    await journey.step(
      "查看第一轮的执行过程与结束态",
      "展开工具步骤能看到本轮的输出标记；助手给出答复，主按钮回到「运行分析」，可以再发一条。",
      async () => {
        const firstTool = await expandToolStep(page, { contains: firstMarker });
        await expect(firstTool).toContainText(firstMarker);
        await expect(page.locator(".message.assistant").last()).toContainText("首次分析已完成");
        await expect(page.getByRole("button", { name: "运行分析" })).toBeVisible();
      },
    );

    await journey.step(
      "再发一条任务，确认它记得上一条命令留下的状态",
      "第二条命令只负责读取，输出里带回第一条命令保存的值，说明同一会话的 shell 状态是连续的。",
      async () => {
        const secondRun = await sendUserMessage(page, fixture!.session.id, secondPrompt);
        const secondTerminal = await waitForRunTerminal(page, fixture!.session.id, secondRun.id);
        expect(secondTerminal.status).toBe("completed");
        const secondTool = await expandToolStep(page, { contains: secondMarker });
        await expect(secondTool).toContainText(`${secondMarker}:${persistentValue}`);
        await expect(page.locator(".message.assistant").last()).toContainText(persistentValue);
      },
    );

    await journey.step(
      "刷新页面后回到同一个会话",
      "两轮的用户消息都还在，两条工具步骤都还在，展开后仍能看到上一轮读回的值。",
      async () => {
        await page.reload();
        await openProjectSession(page, fixture!);
        await expect(page.locator(".message.user").filter({ hasText: firstPrompt })).toBeVisible();
        await expect(page.locator(".message.user").filter({ hasText: secondPrompt })).toBeVisible();
        // Each run exposes the requested shell tool on its first model step.
        await expect(page.getByRole("region", { name: "Agent 活动" }).locator("details.timeline-disclosure.tool"))
          .toHaveCount(2);
        await expect(await expandToolStep(page, { contains: secondMarker })).toContainText(persistentValue);
      },
    );

    await journey.step(
      "删除服务商：确认后模型一并移除，注册表回到空态",
      "先删除项目释放会话引用，再在服务商行点“编辑”后点“删除”：确认后 DELETE 命中该服务商；其未被引用的模型一并删除，注册表回到“还没有服务商”的空态。",
      async () => {
        // The project/session referencing the journey model must go first so
        // the provider delete is accepted.
        await cleanupJourney(page, fixture!);
        fixture = undefined;
        await page.getByRole("button", { name: /^系统设置/ }).click();
        const settings = page.getByRole("dialog", { name: "系统设置" });
        await settings.getByRole("navigation", { name: "设置分组" })
          .getByRole("button", { name: /^模型注册表/ })
          .click();
        const row = settings.locator(".provider-row").filter({ hasText: providerName });
        if (!await row.locator(".provider-row-detail").count()) {
          await row.locator(".provider-row-summary").click();
        }
        await row.getByRole("button", { name: "编辑", exact: true }).click();
        const editor = settings.getByRole("region", { name: "服务商编辑器" });
        // A manually added model may have become the global default; clear the
        // runtime-setting reference first so the provider delete is accepted.
        if (model) {
          const current = await apiJsonSafe("/api/settings") as { overrides?: Record<string, unknown> } | undefined;
          const overrides2 = { ...(current?.overrides ?? {}) };
          let changed = false;
          for (const key of ["modelId", "reviewModelId"]) {
            if (overrides2[key] === model.id) {
              delete overrides2[key];
              changed = true;
            }
          }
          if (changed) await apiJsonSafe("/api/settings", { data: overrides2, method: "PUT" });
        }
        const deleteResponse = page.waitForResponse((response) => response.request().method() === "DELETE"
          && new URL(response.url()).pathname === `/api/providers/${providerId}`);
        page.once("dialog", (confirmation) => {
          void confirmation.accept();
        });
        await editor.getByRole("button", { name: "删除" }).click();
        expect((await deleteResponse).status()).toBe(200);
        await expect(settings.locator(".provider-row")).toHaveCount(0);
        await expect(settings.getByText("还没有服务商——点击下方“添加 Provider”选择预置或自定义服务商。")).toBeVisible();
        // The unreferenced model profile is deleted together with the provider.
        model = undefined;
        const registryCount = await apiJsonSafe("/api/models");
        expect((registryCount as unknown[]).length).toBe(0);
        await settings.getByRole("button", { name: "取消并关闭" }).filter({ hasText: "取消并关闭" }).click();
        await expect(settings).toBeHidden();
      },
    );
  } finally {
    try {
      if (fixture) {
        await api.delete(`/api/projects/${encodeURIComponent(fixture.project.id)}`, {
          data: { confirmationId: fixture.project.id },
        }).catch(() => undefined);
      }
      if (model) {
        // A manually added model may have become the global default, so clear
        // the runtime-setting reference before deleting it.
        const settingsRaw: unknown = await api.get("/api/settings").then((r) => r.json());
        const settings = settingsRaw as { overrides?: Record<string, unknown> } | undefined;
        const overrides = { ...(settings?.overrides ?? {}) };
        let changed = false;
        for (const key of ["modelId", "reviewModelId"]) {
          if (overrides[key] === model.id) {
            delete overrides[key];
            changed = true;
          }
        }
        if (changed) await api.put("/api/settings", { data: overrides }).catch(() => undefined);
        await api.delete(`/api/models/${encodeURIComponent(model.id)}`).catch(() => undefined);
      }
      if (providerId) {
        await api.delete(`/api/providers/${encodeURIComponent(providerId)}`).catch(() => undefined);
      }
    } catch {
      // Best-effort cleanup; the journey result is authoritative.
    }
    await api.dispose().catch(() => undefined);
    await stub.stop();
  }
});
