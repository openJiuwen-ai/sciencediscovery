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

import { test } from "./helpers/e2e.ts";
import { installStubModels, SLOW_LAST_CONTENT_STEP, SLOW_MODEL_ID, SLOW_MODEL_NAME, type StubModels } from "./support/stub-models.js";

// Static suite metadata is inherited by each framework-expanded journey.
test.describe("issue-44-background-timeline.spec", { tag: ["@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@status:reviewed", "@model:mock", "@sandbox:bubblewrap"] }, () => {

// Follow-up to the Session Stop / per-Session run isolation change: a run that
// keeps streaming while the user works in another Session must still show its
// progress when they switch back. Before the fix the background Session's
// events were dropped, so returning to it showed only the user message while
// Stop was still offered.
//
// 前置：本地栈已启动（./scripts/run-local.sh）；本用例自己通过 /api/models 注册
// 一个 OpenAI 兼容的桩模型（slow-model）——它流式返回固定数量的 reasoning / content
// 片段（最后一个是 `Partial finding <SLOW_LAST_CONTENT_STEP>.`），之后保持连接但
// 不再发送任何内容。这样 run 既有可见的中间步骤又始终在进行中，而且**被丢弃的片段
// 不会再补回来**，用例才能真正区分「缓冲了后台事件」和「只是没被清空」。
//
// 运行：E2E_BASE_URL=<api-origin> npx playwright test --config test/playwright.config.ts \
//         issue-44-background-timeline

const SCREENSHOTS = "screenshots";
const LAST_CONTENT_STEP = SLOW_LAST_CONTENT_STEP;

const state = {
  project: `Issue44 BG ${Date.now()}`,
  sessionA: "会话A-后台长任务",
  sessionB: "会话B-打断者",
};

async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: `${SCREENSHOTS}/${name}.png`, fullPage: false });
}

function waitForToast(page: Page, text: string | RegExp) {
  return page.locator("[role='status']").filter({ hasText: text }).waitFor({ timeout: 10000 });
}

async function createProject(page: Page, name: string) {
  await page.getByRole("button", { name: "Add project" }).click();
  const dialog = page.getByRole("dialog", { name: "Create Project" });
  await dialog.getByLabel("Project name").fill(name);
  await dialog.getByRole("button", { name: "Create Project" }).click();
  await waitForToast(page, "Project created");
  await expect(dialog).toBeHidden();
}

/** One click creates the Session; its name is set through the inline rename
 *  editor, and the stub model is picked in the composer's model popover. */
async function createSession(page: Page, name: string) {
  const rows = page.locator("#sessions-panel-content button.nav-item");
  await expect(rows.first()).toBeVisible();
  const before = await rows.count();
  await page.getByRole("button", { name: "Add session" }).click();
  // Count the new row instead of waiting for the toast: the previous Session's
  // toast is often still on screen and would let the next step run too early.
  await expect(rows).toHaveCount(before + 1);
  const activeSession = page.locator("#sessions-panel-content button.nav-item.active").first();
  await expect(activeSession).toBeVisible();
  // Creating a Session hands focus to the composer; the inline editor commits
  // and closes on blur, so let that handoff land before opening it.
  await expect(page.locator(".composer textarea")).toBeFocused();
  await activeSession.dblclick();
  const editor = page.locator("input.nav-inline-rename");
  await expect(editor).toBeVisible();
  await editor.fill(name);
  await editor.press("Enter");
  await expect(page.locator("#sessions-panel-content button.nav-item", { hasText: name }).first()).toBeVisible();
  await expect(page.locator("h1")).toContainText(name);

  await page.getByLabel("Model for this task").click();
  const option = page.getByRole("option").filter({ hasText: SLOW_MODEL_ID }).first();
  await expect(option).toBeVisible();
  await option.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Choose a model" })).toBeHidden();
  // The picker closes before its PATCH completes. Do not switch Session until
  // the saved model is projected back into this Session's composer.
  await expect(page.getByLabel("Model for this task")).toContainText(SLOW_MODEL_NAME);
}

async function openSession(page: Page, name: string) {
  await page.locator("button.nav-item", { hasText: name }).first().click();
  await expect(page.locator("h1")).toContainText(name);
  await expect(page.getByLabel("Model for this task")).toContainText(SLOW_MODEL_NAME);
  await expect(page.locator(".composer textarea")).toBeVisible();
}

const runButton = (page: Page) => page.getByRole("button", { name: "Run analysis" });
const stopButton = (page: Page) => page.getByRole("button", { name: "Stop the current run" });
const timeline = (page: Page) => page.locator("section[aria-label='Agent activity']");
const streamedAnswer = (page: Page) => timeline(page).locator("article.message.assistant.streaming");

async function startRun(page: Page, text: string) {
  await page.locator(".composer textarea").fill(text);
  await expect(runButton(page)).toBeEnabled();
  await runButton(page).click();
  await expect(stopButton(page)).toBeEnabled();
}

async function stopRunIfRunning(page: Page) {
  if (await stopButton(page).isVisible().catch(() => false)) {
    await stopButton(page).click();
    await expect(runButton(page)).toBeVisible({ timeout: 20000 });
  }
}

let stubs: StubModels | undefined;

test.beforeAll(async () => {
  stubs = await installStubModels();
});

test.afterAll(async () => {
  await stubs?.dispose();
});

test.describe("后台会话的执行流不被吞掉", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".app-shell")).toBeVisible();
  });

  /**
   * E2E-META
   * Purpose: 前置场景——创建项目与两个会话（A 跑后台长任务、B 作打断者），并为两者选择流式桩模型。
   * Steps:
   *   1. 创建项目。
   *   2. 创建会话 A 与会话 B，各自内联改名并选择 slow-model。
   *   3. 断言两个会话都出现在侧栏。
   * Environment: 隔离本地栈；本 spec 自行注册 127.0.0.1 上的 slow-model 桩模型。
   * Type: mocked
   * LLM: 本地桩模型，流式返回固定片段后保持连接但静默；不调用真实或付费模型。
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none — 浏览器与 API 请求均指向 127.0.0.1。
   * Credentials: 隔离实例的 E2E_API_TOKEN 与桩模型令牌。
   * CostSideEffects: none；桩模型在套件结束时删除。
   */
  test("S0 前置：创建项目与两个会话", { tag: "@mocked" }, async ({ page }) => {
    await createProject(page, state.project);
    await createSession(page, state.sessionA);
    await createSession(page, state.sessionB);
  });

  /**
   * E2E-META
   * Purpose: 会话 A 在后台继续流式运行时切到 B 发起任务，再切回 A，离开期间到达的片段仍完整可见；B 的时间线不串台；结束后两者都能停止。
   * Steps:
   *   1. 在 A 发起长任务，等到首个片段后切到 B。
   *   2. 在 B 发起任务并等到首个片段。
   *   3. 切回 A，断言 Stop、时间线、离开前文本与最后片段仍在，thinking 折叠只有一份。
   *   4. 切到 B，断言其时间线独立。
   *   5. 依次停止 B 与 A，断言各自恢复 Run。
   * Environment: 隔离本地栈；slow-model 桩模型让后台运行持续且不重发已丢弃的片段。
   * Type: mocked
   * LLM: 本地桩模型，流式返回固定片段后保持连接但静默；不调用真实或付费模型。
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none — 浏览器与 API 请求均指向 127.0.0.1。
   * Credentials: 隔离实例的 E2E_API_TOKEN 与桩模型令牌。
   * CostSideEffects: none；桩模型在套件结束时删除。
   */
  test("S5 A 运行中切到 B 并发起新任务，切回 A 仍能看到 A 的执行流", { tag: "@mocked" }, async ({ page }) => {
    await page.locator("button.nav-item", { hasText: state.project }).first().click();
    await openSession(page, state.sessionA);

    // A 发起长任务：模型流式吐出固定数量的思考与答复片段后就不再发送任何内容，
    // 因此任何被客户端丢弃的片段都不会再补回来。
    await startRun(page, "会话 A 的长任务：请逐步分析这份数据");
    await expect(timeline(page)).toBeVisible({ timeout: 20000 });
    // 只等第一个片段就离开，把后面的片段全部留在「A 不在屏幕上」的时间窗内。
    await expect(streamedAnswer(page)).toContainText("Partial finding 1.", { timeout: 20000 });
    const answerBeforeSwitch = (await streamedAnswer(page).textContent())?.trim() ?? "";
    expect(answerBeforeSwitch).not.toContain(`Partial finding ${LAST_CONTENT_STEP}.`);
    await screenshot(page, "bg-01-a-running-with-timeline");

    // 切到 B 并在 B 发起新任务——这正是缺陷的触发路径。
    await openSession(page, state.sessionB);
    await expect(timeline(page)).toBeHidden();
    await startRun(page, "会话 B 的任务：打断一下");
    await expect(streamedAnswer(page)).toContainText("Partial finding 1.", { timeout: 20000 });
    await screenshot(page, "bg-02-b-running-independently");

    // 切回 A：Stop 仍在，执行流仍在，且**离开期间到达的片段也在**。
    // 桩模型此时已不再发送任何内容，所以这些片段只可能来自离开期间的缓冲。
    await openSession(page, state.sessionA);
    await expect(stopButton(page)).toBeVisible();
    await expect(timeline(page)).toBeVisible();
    await expect(streamedAnswer(page)).toContainText(answerBeforeSwitch.slice(0, 20));
    await expect(streamedAnswer(page)).toContainText(`Partial finding ${LAST_CONTENT_STEP}.`, { timeout: 20000 });
    await expect(page.locator("details.timeline-disclosure.thinking")).toHaveCount(1);
    await screenshot(page, "bg-03-back-to-a-timeline-preserved");

    // B 的时间线是自己的，没有被 A 串台。
    await openSession(page, state.sessionB);
    await expect(stopButton(page)).toBeVisible();
    await expect(streamedAnswer(page)).toContainText("Partial finding");
    await screenshot(page, "bg-04-b-timeline-independent");

    // 收尾：两个会话依次停止，各自回到可 Run 状态。
    await stopRunIfRunning(page);
    await expect(runButton(page)).toBeVisible();
    await openSession(page, state.sessionA);
    await stopRunIfRunning(page);
    await expect(runButton(page)).toBeVisible();
    await screenshot(page, "bg-05-both-stopped");
  });
});

});
