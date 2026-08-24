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
 *   1. Open an empty zh-CN workbench and configure a local stub model through System settings.
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
test("J1 首次进入即可完成并恢复两轮分析", { tag: "@mocked" }, async ({ journey, page }) => {
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

    let model: JourneyModel | undefined;
    await journey.step(
      "在模型注册表新建一个模型",
      "新建草稿的基础 URL 与模型 ID 都是空的，URL 只给出「一般以 v1 结尾」这样的中性提示；"
        + "填好名称、URL、模型 ID 与令牌后可以保存并关闭。",
      async () => {
        await page.getByRole("button", { name: /^系统设置/ }).click();
        const settings = page.getByRole("dialog", { name: "系统设置" });
        await settings.getByRole("navigation", { name: "设置分组" })
          .getByRole("button", { name: /^模型注册表/ })
          .click();
        await expect(settings.getByRole("heading", { name: "模型注册表" })).toBeVisible();
        await settings.getByRole("button", { name: "+ 添加模型" }).click();

        const nameInput = settings.getByLabel("显示名称");
        const baseUrlInput = settings.getByLabel("OpenAI 兼容的基础 URL");
        const modelInput = settings.getByLabel("模型 ID");
        await expect(baseUrlInput).toHaveValue("");
        await expect(modelInput).toHaveValue("");
        await expect(baseUrlInput).toHaveAttribute("placeholder", "一般以 v1 结尾");
        await expect(modelInput).not.toHaveAttribute("placeholder", /openai|deepseek|gpt/i);

        modelName = `J1 本地模型 ${Date.now()}`;
        await nameInput.fill(modelName);
        await baseUrlInput.fill(stub.baseUrl);
        await modelInput.fill(stub.model);
        await settings.getByLabel("LLM API 令牌").fill(stub.apiToken);
        const modelResponsePromise = page.waitForResponse((response) =>
          response.request().method() === "POST" && new URL(response.url()).pathname === "/api/models");
        await settings.getByRole("button", { name: "保存并关闭" }).click();
        model = await (await modelResponsePromise).json() as JourneyModel;
        await expect(settings).toBeHidden();
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
        const composer = page.locator("form.composer");
        const modelPicker = composer.getByLabel("本任务使用的模型");
        const modelOption = modelPicker.locator("option").filter({ hasText: modelName });
        const modelValue = await modelOption.getAttribute("value");
        expect(modelValue).toBeTruthy();
        await modelPicker.selectOption(modelValue!);
        await expect(modelPicker.locator("option:checked")).toContainText(modelName);
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
        await expect(page.getByRole("region", { name: "Agent 活动" }).locator("details.timeline-disclosure.tool"))
          .toHaveCount(2);
        await expect(await expandToolStep(page, { contains: secondMarker })).toContainText(persistentValue);
      },
    );
  } finally {
    if (fixture) await cleanupJourney(page, fixture);
    await stub.stop();
  }
});
