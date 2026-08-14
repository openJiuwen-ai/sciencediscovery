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

import { test, expect, type Page } from "@playwright/test";

import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";

// 用户场景 E2E：Session Stop 按钮 + 跨会话 Run 隔离。
//
// 前置：本地栈已启动（./scripts/run-local.sh），并已注册一个「接受 POST
// /v1/chat/completions 但永不响应」的桩模型，命名为 HANG_MODEL_LABEL——run 因此
// 会停在模型层，精确复现「卡住」状态。
//
// 运行：E2E_BASE_URL=<api-origin> npx playwright test --config test/playwright.config.ts \
//         issue-44-session-stop
// 截图写到运行 cwd 下的 screenshots/。

const SCREENSHOTS = "screenshots";
const HANG_MODEL_LABEL = "Issue44 Hanging Model · hang-model";
const API_BASE = apiBaseUrl();

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

async function createSession(page: Page, name: string) {
  await page.getByRole("button", { name: "Add session" }).click();
  const dialog = page.getByRole("dialog", { name: "Create Session" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Session name").fill(name);
  await dialog.getByRole("button", { name: "Create Session" }).click();
  await waitForToast(page, "Session created");
  await expect(dialog).toBeHidden();
}

async function openProject(page: Page, name: string) {
  await page.locator("button.nav-item", { hasText: name }).first().click();
}

async function openSession(page: Page, name: string) {
  await page.locator("button.nav-item", { hasText: name }).first().click();
  await expect(page.locator(".composer textarea")).toBeVisible();
}

async function selectHangModel(page: Page) {
  await page.getByLabel("Model for this task").selectOption({ label: HANG_MODEL_LABEL });
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

async function stopRunAndExpectRecovery(page: Page) {
  await stopButton(page).click();
  await waitForToast(page, "Run stopped");
  await expect(runButton(page)).toBeVisible();
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

test.describe("Session Stop 与 Run 会话隔离", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".app-shell")).toBeVisible();
  });

  test("S0 前置：用户创建项目与两个会话并选择模型", async ({ page }) => {
    await createProject(page, state.project);
    await screenshot(page, "s0-01-project-created");

    await createSession(page, state.sessionA);
    await selectHangModel(page);
    await screenshot(page, "s0-02-session-a");

    await createSession(page, state.sessionB);
    await selectHangModel(page);
    await screenshot(page, "s0-03-session-b");
  });

  test("S1 运行中可见可点 Stop，停止后无需刷新可再 Run", async ({ page }) => {
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

  test("S2 会话 A 卡住时，会话 B（含新建会话）可 Run", async ({ page }) => {
    await openProject(page, state.project);
    await openSession(page, state.sessionA);

    // A 发起并保持卡住
    await startRun(page, "会话 A 的长任务（保持卡住）");
    await screenshot(page, "s2-01-a-running");

    // A 卡住时新建会话 C，验证新会话的 Run 不会被默认禁用。
    await expect(page.getByRole("button", { name: "Add session" })).toBeEnabled();
    await createSession(page, "会话C-卡住时新建");
    await selectHangModel(page);

    // C 的 Run 必须可点且能发出
    await startRun(page, "会话 C 的任务（A 卡住时发起）");
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
  });

  test("S3 重复 Stop / 无 active run 时不炸", async ({ page }) => {
    await openProject(page, state.project);
    await openSession(page, state.sessionA);

    // 无 active run 时服务端 cancel → 409，且 UI 无任何异常
    const idleCancel = await cancelViaApi(page, state.sessionA);
    expect(idleCancel.status()).toBe(409);
    await expect(page.locator("[role='status']").filter({ hasText: "Request error" })).toHaveCount(0);

    // 发起 run → 第一次 cancel（API 路径等价于 Stop 的服务端动作）→ 200
    await startRun(page, "幂等性验证任务");
    const firstCancel = await cancelViaApi(page, state.sessionA);
    expect(firstCancel.status()).toBe(200);
    const body = (await firstCancel.json()) as { cancelled?: boolean };
    expect(body.cancelled).toBe(true);

    // UI 感知到取消并恢复
    await waitForToast(page, "Run stopped");
    await expect(runButton(page)).toBeVisible();

    // 第二次 cancel（重复 Stop 幂等）→ 409，UI 不崩、Composer 可用
    const secondCancel = await cancelViaApi(page, state.sessionA);
    expect(secondCancel.status()).toBe(409);
    await fillComposer(page, "重复 Stop 后仍然可以输入并运行");
    await expect(runButton(page)).toBeEnabled();
    await expect(page.locator("[role='status']").filter({ hasText: "Request error" })).toHaveCount(0);
    await screenshot(page, "s3-01-idempotent-stop-composer-usable");
  });

  test("S4 观感与可理解性（桌面 + 移动视口）", async ({ page }) => {
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
