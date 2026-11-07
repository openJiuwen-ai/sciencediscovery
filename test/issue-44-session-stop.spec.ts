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
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { HANG_MODEL_ID, installStubModels, type StubModels } from "./support/stub-models.js";

// Static suite metadata is inherited by each framework-expanded journey.
test.describe("issue-44-session-stop.spec", { tag: ["@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@status:reviewed", "@model:mock", "@sandbox:bubblewrap"] }, () => {

// 用户场景 E2E：Session Stop 按钮 + 跨会话 Run 隔离。
//
// 前置：本地栈已启动（./scripts/run-local.sh）；本用例自己通过 /api/models 注册
// 一个「接受 POST /v1/chat/completions 但永不响应」的桩模型（hang-model）——run
// 因此会停在模型层，精确复现「卡住」状态。
//
// 运行：E2E_BASE_URL=<api-origin> npx playwright test --config test/playwright.config.ts \
//         issue-44-session-stop
// 截图写到运行 cwd 下的 screenshots/。

const SCREENSHOTS = "screenshots";
const API_BASE = apiBaseUrl();

let stubs: StubModels | undefined;

const state = {
  project: `Issue44 E2E ${Date.now()}`,
  sessionA: "会话A-会卡住",
  sessionB: "会话B-并发可跑",
};

async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: `${SCREENSHOTS}/${name}.png`, fullPage: false });
}

function waitForToast(page: Page, text: string | RegExp, opts?: { timeout?: number; state?: "visible" | "hidden" }) {
  const toast = page.locator("[role='status']").filter({ hasText: text });
  return toast.waitFor({ timeout: opts?.timeout ?? 10000, state: opts?.state ?? "visible" });
}

async function createProject(page: Page, name: string) {
  await page.getByRole("button", { name: "Add project" }).click();
  const dialog = page.getByRole("dialog", { name: "Create Project" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Project name").fill(name);
  await dialog.getByRole("button", { name: "Create Project" }).click();
  await waitForToast(page, "Project created");
  await expect(dialog).toBeHidden();
}

/** Creating a Session is one click now: it lands with a generated title and
 *  becomes active, so the name is given through the inline rename editor. */
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
}

async function openProject(page: Page, name: string) {
  await page.locator("button.nav-item", { hasText: name }).first().click();
}

async function openSession(page: Page, name: string) {
  await page.locator("button.nav-item", { hasText: name }).first().click();
  await expect(page.locator(".composer textarea")).toBeVisible();
}

async function selectHangModel(page: Page) {
  await page.getByLabel("Model for this task").click();
  const option = page.getByRole("option").filter({ hasText: HANG_MODEL_ID }).first();
  await expect(option).toBeVisible();
  await option.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Choose a model" })).toBeHidden();
}

function runButton(page: Page) {
  return page.getByRole("button", { name: "Run analysis" });
}

function stopButton(page: Page) {
  return page.getByRole("button", { name: "Stop the current run" });
}

async function fillComposer(page: Page, text: string) {
  await page.locator(".composer textarea").fill(text);
}

async function startRun(page: Page, text: string) {
  await fillComposer(page, text);
  await expect(runButton(page)).toBeEnabled();
  await runButton(page).click();
  await expect(stopButton(page)).toBeVisible();
  await expect(stopButton(page)).toBeEnabled();
}

/** A stopped run is reported by the composer itself: Stop gives way to Run
 *  again without a reload. */
async function stopRunAndExpectRecovery(page: Page) {
  await stopButton(page).click();
  await expect(runButton(page)).toBeVisible({ timeout: 20000 });
}

async function cancelViaApi(page: Page, sessionName: string) {
  // 会话没有全局列表端点：先按项目名找到 projectId，再按标题匹配 sessionId。
  const auth = authorizationHeader();
  const projectsRes = await page.request.get(`${API_BASE}/api/projects`, { headers: auth });
  const projects = (await projectsRes.json()) as Array<{ id: string; name: string }>;
  const project = projects.find((p) => p.name === state.project);
  if (!project) throw new Error(`project not found via API: ${state.project}`);
  const sessionsRes = await page.request.get(`${API_BASE}/api/projects/${project.id}/sessions`, { headers: auth });
  const sessions = (await sessionsRes.json()) as Array<{ id: string; title: string }>;
  const session = sessions.find((s) => s.title === sessionName);
  if (!session) throw new Error(`session not found via API: ${sessionName}`);
  return page.request.post(`${API_BASE}/api/sessions/${session.id}/runs/current/cancel`, {
    headers: auth,
  });
}

test.beforeAll(async () => {
  stubs = await installStubModels();
});

test.afterAll(async () => {
  await stubs?.dispose();
});

test.describe("Session Stop 与 Run 会话隔离", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".app-shell")).toBeVisible();
  });

  /**
   * E2E-META
   * Purpose: 前置场景——用户创建项目与两个会话，并为两者选择会卡住的桩模型。
   * Steps:
   *   1. 创建项目。
   *   2. 创建会话 A 并选择 hang-model。
   *   3. 创建会话 B 并选择 hang-model。
   *   4. 截图留证。
   * Environment: 隔离本地栈；本 spec 自行注册 127.0.0.1 上的 hang-model 桩模型。
   * Type: mocked
   * LLM: 本地桩模型，接受流式请求后永不响应；不调用真实或付费模型。
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none — 浏览器与 API 请求均指向 127.0.0.1。
   * Credentials: 隔离实例的 E2E_API_TOKEN 与桩模型令牌。
   * CostSideEffects: none；桩模型在套件结束时删除。
   */
  test("S0 前置：用户创建项目与两个会话并选择模型", { tag: "@mocked" }, async ({ page }) => {
    await createProject(page, state.project);
    await screenshot(page, "s0-01-project-created");

    await createSession(page, state.sessionA);
    await selectHangModel(page);
    await screenshot(page, "s0-02-session-a");

    await createSession(page, state.sessionB);
    await selectHangModel(page);
    await screenshot(page, "s0-03-session-b");
  });

  /**
   * E2E-META
   * Purpose: 运行中 Stop 可见可点；停止后无需刷新即可再次运行，时间线不残留运行中条目。
   * Steps:
   *   1. 打开项目与会话 A。
   *   2. 发起运行并断言 Stop 可见可用，等待 6 秒仍保持运行。
   *   3. 点击 Stop，断言 composer 恢复 Run。
   *   4. 断言没有 running 时间线条目。
   *   5. 再次发起并停止第二轮，复核恢复。
   * Environment: 隔离本地栈；hang-model 桩模型让运行停在模型边界。
   * Type: mocked
   * LLM: 本地桩模型，接受流式请求后永不响应；不调用真实或付费模型。
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none — 浏览器与 API 请求均指向 127.0.0.1。
   * Credentials: 隔离实例的 E2E_API_TOKEN 与桩模型令牌。
   * CostSideEffects: none；桩模型在套件结束时删除。
   */
  test("S1 运行中可见可点 Stop，停止后无需刷新可再 Run", { tag: "@mocked" }, async ({ page }) => {
    await openProject(page, state.project);
    await openSession(page, state.sessionA);

    // 发起 Run：按钮应从「Run analysis」切换为可点的「Stop」
    await startRun(page, "请分析这份实验数据（第一轮，会被停掉）");
    await screenshot(page, "s1-01-running-stop-visible");

    // 挂起模型下等待 6s：仍是 Stop（run 未自行结束），复现「卡住」态
    await page.waitForTimeout(6000);
    await expect(stopButton(page)).toBeVisible();
    await expect(stopButton(page)).toBeEnabled();
    await screenshot(page, "s1-02-still-running-stuck");

    // 点击 Stop：出现可感知反馈（toast），Composer 回到 Run 形态
    await stopRunAndExpectRecovery(page);
    await screenshot(page, "s1-03-stopped-toast");

    // 时间线不应残留「运行中」条目（取消收尾可见）
    await expect(page.locator(".timeline-disclosure.running")).toHaveCount(0, { timeout: 5000 });

    // 无需刷新页面，可再次 Run
    await startRun(page, "同一会话第二轮（验证可再次运行）");
    await screenshot(page, "s1-04-run-again-without-reload");

    // 清理：停掉第二轮
    await stopRunAndExpectRecovery(page);
    await expect(page.locator(".timeline-disclosure.running")).toHaveCount(0, { timeout: 5000 });
  });

  /**
   * E2E-META
   * Purpose: 会话 A 卡住时，新建会话可独立运行；取消响应的终态事件被延迟时，仍无需刷新恢复 Run。
   * Steps:
   *   1. A 发起并保持卡住。
   *   2. 新建会话 C 并选择桩模型。
   *   3. 断言 C 可 Run 且进入运行态。
   *   4. 切回 A，断言仍运行且可 Stop。
   *   5. 延迟 C 的事件响应，依次停止 A 与 C，断言通过持久化状态恢复 Run。
   * Environment: 隔离本地栈；hang-model 桩模型让运行停在模型边界。
   * Type: mocked
   * LLM: 本地桩模型，接受流式请求后永不响应；不调用真实或付费模型。
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none — 浏览器与 API 请求均指向 127.0.0.1。
   * Credentials: 隔离实例的 E2E_API_TOKEN 与桩模型令牌。
   * CostSideEffects: none；桩模型在套件结束时删除。
   */
  test("S2 会话 A 卡住时，会话 B（含新建会话）可 Run", { tag: "@mocked" }, async ({ page }) => {
    await openProject(page, state.project);
    await openSession(page, state.sessionA);

    // A 发起并保持卡住
    await startRun(page, "会话 A 的长任务（保持卡住）");
    await screenshot(page, "s2-01-a-running");

    // A 卡住时新建会话 C，验证新会话的 Run 不会被默认禁用。
    await expect(page.getByRole("button", { name: "Add session" })).toBeEnabled();
    await createSession(page, "会话C-卡住时新建");
    await selectHangModel(page);

    // Buffer C's POST response so its terminal SSE frame cannot reach the
    // browser. The server still executes/cancels the real run; Stop must recover
    // by reconciling persisted status after its transport fallback.
    let releaseResponse = () => {};
    const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
    const messageRoute = "**/api/sessions/*/messages";
    await page.route(messageRoute, async route => {
      if (!route.request().postData()?.includes("会话 C 的任务")) return route.continue();
      const response = await route.fetch();
      await responseGate;
      await route.fulfill({ response });
    });
    try {
      // C 的 Run 必须可点且能发出
      await startRun(page, "会话 C 的任务（A 卡住时发起）");
      const sessionCId = new URL(page.url()).pathname.match(/\/sessions\/([^/]+)/)?.[1];
      expect(sessionCId).toBeTruthy();
      await expect.poll(async () => {
        const response = await page.request.get(`${API_BASE}/api/sessions/${sessionCId}/runs`, { headers: authorizationHeader() });
        expect(response.ok()).toBe(true);
        const runs = await response.json() as Array<{ status: string }>;
        return runs.some(run => run.status === "running" || run.status === "blocked");
      }).toBe(true);
      await screenshot(page, "s2-02-c-runnable-while-a-stuck");

      // 切回 A：仍能显示运行态并可 Stop
      await openSession(page, state.sessionA);
      await expect(stopButton(page)).toBeVisible();
      await expect(stopButton(page)).toBeEnabled();
      await screenshot(page, "s2-03-back-to-a-still-running");

      // 清理：依次停掉 A 与 C
      await stopRunAndExpectRecovery(page);
      await openSession(page, "会话C-卡住时新建");
      await stopRunAndExpectRecovery(page);
    } finally {
      releaseResponse();
      await page.unrouteAll({ behavior: "wait" });
    }
  });

  /**
   * E2E-META
   * Purpose: 无 active run 与重复 Stop 时取消都是幂等的成功，UI 不报错且 composer 继续可用。
   * Steps:
   *   1. 无运行时调用 cancel API，断言 200 且 cancelled=true。
   *   2. 发起运行后第一次 cancel，断言 200 且 UI 恢复 Run。
   *   3. 第二次 cancel，断言同样 200 且 cancelled=true。
   *   4. 断言没有 Request error 提示，输入与 Run 仍可用。
   * Environment: 隔离本地栈；hang-model 桩模型让运行停在模型边界。
   * Type: mocked
   * LLM: 本地桩模型，接受流式请求后永不响应；不调用真实或付费模型。
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none — 浏览器与 API 请求均指向 127.0.0.1。
   * Credentials: 隔离实例的 E2E_API_TOKEN 与桩模型令牌。
   * CostSideEffects: none；桩模型在套件结束时删除。
   */
  test("S3 重复 Stop / 无 active run 时不炸", { tag: "@mocked" }, async ({ page }) => {
    await openProject(page, state.project);
    await openSession(page, state.sessionA);

    // 无 active run 时服务端 cancel 是幂等的成功（没有可取消的 run，也不报错）
    const idleCancel = await cancelViaApi(page, state.sessionA);
    expect(idleCancel.status()).toBe(200);
    expect(((await idleCancel.json()) as { cancelled?: boolean }).cancelled).toBe(true);
    await expect(page.locator("[role='status']").filter({ hasText: "Request error" })).toHaveCount(0);

    // 发起 run → 第一次 cancel（API 路径等价于 Stop 的服务端动作）→ 200
    await startRun(page, "幂等性验证任务");
    const firstCancel = await cancelViaApi(page, state.sessionA);
    expect(firstCancel.status()).toBe(200);
    const body = (await firstCancel.json()) as { cancelled?: boolean };
    expect(body.cancelled).toBe(true);

    // UI 感知到取消并恢复
    await expect(runButton(page)).toBeVisible({ timeout: 20000 });

    // 第二次 cancel（重复 Stop 同样幂等）→ 200 且无异常，UI 不崩、Composer 可用
    const secondCancel = await cancelViaApi(page, state.sessionA);
    expect(secondCancel.status()).toBe(200);
    expect(((await secondCancel.json()) as { cancelled?: boolean }).cancelled).toBe(true);
    await fillComposer(page, "重复 Stop 后仍然可以输入并运行");
    await expect(runButton(page)).toBeEnabled();
    await expect(page.locator("[role='status']").filter({ hasText: "Request error" })).toHaveCount(0);
    await screenshot(page, "s3-01-idempotent-stop-composer-usable");
  });

  /**
   * E2E-META
   * Purpose: 桌面与移动视口下 Stop 的观感与可理解性——空输入禁用、运行中为 Stop、关键控件不重叠。
   * Steps:
   *   1. 打开会话 A，断言空输入时 Run 禁用、有输入时可用。
   *   2. 发起运行，断言 Stop 可见且文案为 Stop。
   *   3. 断言 textarea 与按钮矩形不重叠。
   *   4. 切到 390×844，断言 composer 输入区仍可见。
   * Environment: 隔离本地栈；hang-model 桩模型；桌面与 390×844 视口。
   * Type: mocked
   * LLM: 本地桩模型，接受流式请求后永不响应；不调用真实或付费模型。
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none — 浏览器与 API 请求均指向 127.0.0.1。
   * Credentials: 隔离实例的 E2E_API_TOKEN 与桩模型令牌。
   * CostSideEffects: none；桩模型在套件结束时删除。
   */
  test("S4 观感与可理解性（桌面 + 移动视口）", { tag: "@mocked" }, async ({ page }) => {
    await openProject(page, state.project);
    await openSession(page, state.sessionA);

    // 空输入：Run 禁用（防止空提交，可理解）；有输入：可点
    await expect(runButton(page)).toBeDisabled();
    await fillComposer(page, "观感检查");
    await expect(runButton(page)).toBeEnabled();
    await screenshot(page, "s4-01-composer-idle-desktop");

    // 运行中：按钮文字为 Stop 且带可理解的可访问名
    await runButton(page).click();
    await expect(stopButton(page)).toBeVisible();
    await expect(page.locator("button.send-button.stop-button")).toHaveText(/Stop/);
    await screenshot(page, "s4-02-composer-running-desktop");

    // 关键控件不被遮挡：textarea 与按钮均在实际可视区内且无重叠
    const taBox = await page.locator(".composer textarea").boundingBox();
    const btnBox = await stopButton(page).boundingBox();
    expect(taBox).not.toBeNull();
    expect(btnBox).not.toBeNull();
    if (taBox && btnBox) {
      const overlap = !(btnBox.x + btnBox.width <= taBox.x || taBox.x + taBox.width <= btnBox.x
        || btnBox.y + btnBox.height <= taBox.y || taBox.y + taBox.height <= btnBox.y);
      expect(overlap).toBe(false);
    }

    await stopRunAndExpectRecovery(page);

    // 移动视口下的 Composer
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".composer textarea")).toBeVisible();
    await screenshot(page, "s4-03-composer-mobile");
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status === "failed" || testInfo.status === "timedOut") {
      await screenshot(page, `${testInfo.title.slice(0, 2)}-failure`.replace(/\W+/g, "_"));
    }
  });
});

});
