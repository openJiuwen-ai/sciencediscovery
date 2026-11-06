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
import * as fs from "node:fs";

import { expect, type Page } from "@playwright/test";

import { test } from "./helpers/e2e.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";

// Static suite metadata is inherited by each framework-expanded journey.
test.describe("issue-37-composer-height.spec", { tag: ["@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@status:reviewed", "@model:mock", "@sandbox:bubblewrap"] }, () => {

/**
 * 会话 Composer 高度回归测试。
 *
 * 场景:
 *  S1 桌面空闲会话:消息区明显大于输入区
 *  S2 长草稿触顶:textarea 受上限约束，消息区仍保有可读高度
 *  S3 引用 chip 机制不变量:2 chip → 6+ chip 可读占比不明显下降，pill 不裁切
 *  S4 发送可达:多 chip 触顶时发送按钮在 composer 框内
 *  S5 真实 isRunning:mock LLM 挂起制造真实 running，验证 composer-compact
 *  S6 三档视口量测:1366×768 / 1440×900 / 1920×1080 × (空态 / 触顶 / chip)
 *  S7 窄屏 sanity:500 / 600 宽发送与模型选择可达
 *  S8 现场条件回归:右侧工作区打开 + 矮视口(1366×640 / 1280×640)，发送按钮在 composer 卡片内且不叠专家下拉/审批图标
 *
 * 运行:E2E_BASE_URL=http://127.0.0.1:4310 npx playwright test issue-37-composer-height
 */

const SCREENSHOTS = "screenshots/issue-37-composer-height";
const { authorization: AUTH } = authorizationHeader();
const API_BASE = apiBaseUrl();
const RUN_ID = `e2e-${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}`;

const LONG_DRAFT = Array.from(
  { length: 48 },
  (_, i) => `Draft line ${i + 1}: literature context and constraints for the analysis.`,
).join("\n");

// Two floors, one per state of the composer. At rest the transcript owns most
// of the viewport, so it keeps at least 55%; once the draft hits its cap and
// the chip row wraps, the footer stacks a model row, an orchestration row and
// an action row, and the invariant becomes the weaker but explicit one that the
// conversation never gives up more than two thirds of the column to the
// composer, at any measured viewport.
const MIN_IDLE_MESSAGES_RATIO = 0.55;
const MIN_COMPOSER_MESSAGES_RATIO = 1 / 3;

// ---- API helpers ----

async function apiRequest(path: string, init: RequestInit = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      authorization: AUTH,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string };
    throw new Error(`${path} failed: ${body.error ?? response.statusText}`);
  }
  return response;
}

// ---- Mock LLM（可控挂起，用于真实 isRunning）----

type ChatMessage = { content?: string; role?: string };
type ChatBody = { messages?: ChatMessage[] };

function sseChunk(id: string, model: string, delta: Record<string, unknown>, finishReason: string | null, usage?: unknown) {
  return {
    choices: [{ delta, finish_reason: finishReason, index: 0 }],
    created: 1,
    id,
    model,
    object: "chat.completion.chunk",
    ...(usage ? { usage } : {}),
  };
}

const LONG_ANSWER = Array.from(
  { length: 60 },
  (_, i) => `Finding ${i + 1}: the evidence suggests a measurable effect with caveats.`,
).join("\n\n");

interface MockGate {
  hold: boolean;
  waiters: Array<() => void>;
  release: () => void;
}

function startMockLlm(gate: MockGate): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatBody;
      if (gate.hold) {
        await new Promise<void>((resolve) => gate.waiters.push(resolve));
      }
      const model = "issue37-e2e-model";
      const payload = [
        sseChunk("c1", model, { content: LONG_ANSWER, role: "assistant" }, null),
        sseChunk("c1", model, {}, "stop", { completion_tokens: 800, prompt_tokens: 50, total_tokens: 850 }),
      ];
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const chunk of payload) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        stop: () => new Promise<void>((done) => {
          server.closeAllConnections?.();
          server.close(() => done());
        }),
      });
    });
    server.on("error", reject);
  });
}

// ---- 量测 ----

interface MeasureResult {
  viewportW: number;
  viewportH: number;
  messagesReadable: number;
  messagesRatio: number;
  composerH: number;
  composerTop: number;
  messagesBottom: number;
  textareaH: number;
  chipRowH: number;
  send: { x: number; y: number; w: number; h: number };
  composerBox: { x: number; y: number; w: number; h: number };
  messagesOverflowY: string;
}

async function measure(page: Page): Promise<MeasureResult> {
  return page.evaluate(() => {
    const messages = document.querySelector<HTMLElement>(".messages");
    const composer = document.querySelector<HTMLElement>(".composer");
    const textarea = document.querySelector<HTMLElement>(".composer textarea");
    const send = document.querySelector<HTMLElement>(".send-button");
    if (!messages || !composer || !textarea || !send) throw new Error("layout elements missing");
    const m = messages.getBoundingClientRect();
    const cs = getComputedStyle(messages);
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const c = composer.getBoundingClientRect();
    const t = textarea.getBoundingClientRect();
    const s = send.getBoundingClientRect();
    const chips = document.querySelector<HTMLElement>(".composer-reference-chips");
    return {
      viewportW: window.innerWidth,
      viewportH: window.innerHeight,
      messagesReadable: m.height - pad,
      messagesRatio: (m.height - pad) / window.innerHeight,
      composerH: c.height,
      composerTop: c.top,
      messagesBottom: m.bottom,
      textareaH: t.height,
      chipRowH: chips ? chips.getBoundingClientRect().height : 0,
      send: { x: s.x, y: s.y, w: s.width, h: s.height },
      composerBox: { x: c.x, y: c.y, w: c.width, h: c.height },
      messagesOverflowY: cs.overflowY,
    };
  });
}

function expectSendInsideComposer(m: MeasureResult) {
  expect(m.send.x, "send 左边在 composer 内").toBeGreaterThanOrEqual(m.composerBox.x - 1);
  expect(m.send.y, "send 上边在 composer 内").toBeGreaterThanOrEqual(m.composerBox.y - 1);
  expect(m.send.x + m.send.w, "send 右边在 composer 内").toBeLessThanOrEqual(m.composerBox.x + m.composerBox.w + 1);
  expect(m.send.y + m.send.h, "send 下边在 composer 内").toBeLessThanOrEqual(m.composerBox.y + m.composerBox.h + 1);
}

async function expectChipsFullyVisible(page: Page) {
  const chips = page.locator(".composer-reference-chips button");
  const count = await chips.count();
  expect(count, "至少存在一个引用 chip").toBeGreaterThan(0);
  const metric = (element: Element) => {
    const box = element.getBoundingClientRect();
    const container = element.parentElement?.getBoundingClientRect();
    return {
      height: box.height,
      fullyVisible: !!container && box.top >= container.top - 1 && box.bottom <= container.bottom + 1,
    };
  };
  // The row has a max-height and scrolls once it wraps past it, so a pill may
  // legitimately straddle the scroll boundary. What must never happen is a row
  // that fits clipping a pill: when nothing scrolls, every chip renders whole.
  const atRest = await chips.evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect();
    const container = element.parentElement;
    const band = container?.getBoundingClientRect();
    return {
      height: box.height,
      scrolls: !!container && container.scrollHeight > container.clientHeight + 1,
      whole: !!band && box.top >= band.top - 1 && box.bottom <= band.bottom + 1,
    };
  }));
  for (const [index, chip] of atRest.entries()) {
    expect(chip.height, `第 ${index + 1} 个 chip 应保持完整 pill 高度`).toBeGreaterThanOrEqual(20);
    if (!chip.scrolls) {
      expect(chip.whole, `第 ${index + 1} 个 chip 在行未触顶时不得被裁切`).toBeTruthy();
    }
  }
  for (let index = 0; index < count; index += 1) {
    // A wrapped row caps its height and scrolls; each further pill must still
    // be reachable and whole once scrolled in.
    const chip = chips.nth(index);
    await chip.scrollIntoViewIfNeeded();
    const metrics = await chip.evaluate(metric);
    expect(metrics.height, "chip 应保持完整 pill 高度").toBeGreaterThanOrEqual(20);
    expect(metrics.fullyVisible, "chip 滚动后应完整可见").toBeTruthy();
  }
}

async function screenshot(page: Page, name: string) {
  fs.mkdirSync(SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: `${SCREENSHOTS}/${RUN_ID}-${name}.png`, fullPage: false });
}

// ---- UI 操作 ----

// Below the 1024px breakpoint the sidebar is off-canvas and every navigation
// click has to reopen it first; on desktop the toggle is hidden and this no-ops.
async function openNavigationDrawer(page: Page) {
  const toggle = page.locator(".sidebar-drawer-toggle");
  if (await toggle.isVisible()) {
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  }
}

async function openSession(page: Page, projectName: string, sessionTitle: string) {
  await page.goto("/");
  await expect(page.locator(".app-shell")).toBeVisible();
  // The shell renders before bootstrap selects its default Project/Session.
  // That selection closes navigation; wait for its public URL projection before
  // opening the drawer, just as the desktop helper waits for a ready destination.
  await expect(page).toHaveURL(/\/projects\/[^/]+\/sessions\/[^/?]+(?:\?.*)?$/);
  await openNavigationDrawer(page);
  const projectButton = page.locator(".nav-item").filter({ hasText: projectName });
  await expect(projectButton).toBeVisible();
  await projectButton.click();
  await expect(page.locator("#sessions-panel-content .nav-skeleton")).toHaveCount(0);
  await expect(page.locator("#sessions-panel-content button.nav-item.active")).toHaveCount(1);
  await openNavigationDrawer(page);
  const sessionButton = page.locator(".nav-item").filter({ hasText: sessionTitle });
  await expect(sessionButton).toBeVisible();
  await sessionButton.click();
  await expect(page.locator("h1")).toContainText(sessionTitle);
  await expect(page.locator(".composer textarea")).toBeVisible();
}

async function addSessionChip(page: Page, sessionLabel: string) {
  const textarea = page.locator(".composer textarea");
  await textarea.click();
  await textarea.press("End");
  await page.keyboard.type(` #${sessionLabel.split(" ")[0]}`, { delay: 20 });
  const menu = page.getByRole("listbox", { name: "# context suggestions" });
  await expect(menu).toBeVisible({ timeout: 5000 });
  await menu.getByRole("option").filter({ hasText: sessionLabel }).first().click();
  await expect(page.locator(".composer-reference-chips button").filter({ hasText: sessionLabel })).toBeVisible();
}

async function removeAllChips(page: Page) {
  const chips = page.locator(".composer-reference-chips button");
  while ((await chips.count()) > 0) {
    await chips.first().click();
  }
}

function attachLogCollector(page: Page, logs: string[]) {
  page.on("console", (msg) => {
    if (msg.type() === "error") logs.push(`[${msg.type()}] ${msg.text()}`);
  });
  page.on("pageerror", (err) => logs.push(`[pageerror] ${err.message}`));
}

// ---- 测试数据（beforeAll 创建，afterAll 清理）----

interface Fixture {
  projectId: string;
  projectName: string;
  layoutSession: string;
  runSession: string;
  refSessions: string[];
  sessionIds: string[];
  modelId: string;
}

const fixture: Fixture = {
  projectId: "",
  projectName: `Issue37 E2E ${Date.now()}`,
  layoutSession: `Layout session ${Date.now()}`,
  runSession: `Run session ${Date.now()}`,
  refSessions: [],
  sessionIds: [],
  modelId: "",
};

let mockStop: (() => Promise<void>) | undefined;
const gate: MockGate = {
  hold: false,
  waiters: [],
  release() {
    this.hold = false;
    for (const resolve of this.waiters.splice(0)) resolve();
  },
};

const resultsLog: Array<Record<string, unknown>> = [];

test.beforeAll(async () => {
  const mock = await startMockLlm(gate);
  mockStop = mock.stop;
  const modelRes = await apiRequest("/api/models", {
    method: "POST",
    body: JSON.stringify({ apiToken: "e2e-mock-token", baseUrl: mock.baseUrl, model: "issue37-e2e-model", name: `Issue37 E2E model ${Date.now()}`, vision: false }),
  });
  fixture.modelId = ((await modelRes.json()) as { id: string }).id;

  const projectRes = await apiRequest("/api/projects", { method: "POST", body: JSON.stringify({ name: fixture.projectName }) });
  fixture.projectId = ((await projectRes.json()) as { id: string }).id;

  const createSession = async (title: string) => {
    const res = await apiRequest(`/api/projects/${encodeURIComponent(fixture.projectId)}/sessions`, {
      method: "POST",
      body: JSON.stringify({ approvalMode: "always_allow", modelId: fixture.modelId, title }),
    });
    const session = (await res.json()) as { id: string };
    fixture.sessionIds.push(session.id);
  };

  await createSession(fixture.layoutSession);
  await createSession(fixture.runSession);
  for (let i = 1; i <= 6; i += 1) {
    const title = `RefAlpha${i} session ${Date.now()}`;
    fixture.refSessions.push(title);
    await createSession(title);
  }
});

test.afterAll(async () => {
  gate.release();
  for (const sessionId of fixture.sessionIds) {
    await apiRequest(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE", body: JSON.stringify({ confirmationId: sessionId }) }).catch(() => undefined);
  }
  if (fixture.projectId) {
    await apiRequest(`/api/projects/${encodeURIComponent(fixture.projectId)}`, {
      method: "DELETE",
      body: JSON.stringify({ confirmationId: fixture.projectId }),
    }).catch(() => undefined);
  }
  if (fixture.modelId) {
    await apiRequest(`/api/models/${encodeURIComponent(fixture.modelId)}`, { method: "DELETE" }).catch(() => undefined);
  }
  if (mockStop) await mockStop();
  fs.mkdirSync(SCREENSHOTS, { recursive: true });
  fs.writeFileSync(`${SCREENSHOTS}/${RUN_ID}-measurements.json`, JSON.stringify(resultsLog, null, 2));
});

test.describe("会话 Composer 高度 E2E", () => {
  test.describe.configure({ mode: "serial" });

  /**
   * E2E-META
   * Purpose: 桌面空闲会话中消息区保持为大块可滚动区域，输入区约 1–2 行。
   * Steps:
   *   1. 在 1366×768 打开 fixture 会话。
   *   2. 量测消息区、composer 与 textarea 几何。
   *   3. 断言消息占比 ≥55%、消息区高度 > 1.5×composer、消息区可滚动且不与 composer 重叠、textarea ≤60px。
   *   4. 断言无 console 错误。
   * Environment: 隔离本地栈；项目、布局会话、运行会话与 mock LLM 由本 spec 的 fixture 提供；1366×768 视口。
   * Type: mocked
   * LLM: 本地确定性 SSE fixture；不调用真实或付费模型。
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none — 浏览器与 API 请求均指向 127.0.0.1。
   * Credentials: 隔离实例的 E2E_API_TOKEN 与桩模型令牌。
   * CostSideEffects: none；fixture 在套件结束时清理。
   */
  test("S1 桌面空闲会话:消息区明显大于输入区", { tag: "@mocked" }, async ({ page }) => {
    const logs: string[] = [];
    attachLogCollector(page, logs);
    await page.setViewportSize({ width: 1366, height: 768 });
    await openSession(page, fixture.projectName, fixture.layoutSession);

    const m = await measure(page);
    resultsLog.push({ scenario: "S1 idle 1366x768", ...m });
    expect(m.messagesRatio, `消息可读占比 ${(m.messagesRatio * 100).toFixed(1)}% ≥ ${MIN_IDLE_MESSAGES_RATIO * 100}%`).toBeGreaterThanOrEqual(MIN_IDLE_MESSAGES_RATIO);
    expect(m.messagesReadable, "消息区明显大于 composer").toBeGreaterThan(m.composerH * 1.5);
    expect(m.messagesOverflowY).toBe("auto");
    expect(m.composerTop, "composer 不与消息区重叠").toBeGreaterThanOrEqual(m.messagesBottom - 1);
    // 空态 textarea 应在 1–2 行量级(显著低于修复前约 100px)
    expect(m.textareaH, `空态 textarea ${m.textareaH}px 应接近 1–2 行`).toBeLessThanOrEqual(60);
    await screenshot(page, "s1-idle-1366x768");
    expect(logs, `控制台错误: ${logs.join("; ")}`).toEqual([]);
  });

  /**
   * E2E-META
   * Purpose: 长草稿触顶时 textarea 受上限约束，消息区仍保有可读高度。
   * Steps:
   *   1. 1366×768 打开会话并填入 48 行长草稿。
   *   2. 量测 textarea 与消息区。
   *   3. 断言 textarea ≤ min(200px, 20% 视口)+2，消息占比 ≥33%。
   *   4. 断言无 console 错误。
   * Environment: 隔离本地栈；fixture 项目与会话；1366×768 视口。
   * Type: mocked
   * LLM: 本地确定性 SSE fixture；不调用真实或付费模型。
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none — 浏览器与 API 请求均指向 127.0.0.1。
   * Credentials: 隔离实例的 E2E_API_TOKEN 与桩模型令牌。
   * CostSideEffects: none；fixture 在套件结束时清理。
   */
  test("S2 长草稿触顶:textarea 受上限,消息区仍可读", { tag: "@mocked" }, async ({ page }) => {
    const logs: string[] = [];
    attachLogCollector(page, logs);
    await page.setViewportSize({ width: 1366, height: 768 });
    await openSession(page, fixture.projectName, fixture.layoutSession);

    const textarea = page.locator(".composer textarea");
    await textarea.fill(LONG_DRAFT);
    await page.waitForTimeout(150);

    const m = await measure(page);
    const cap = Math.min(200, 0.2 * m.viewportH);
    resultsLog.push({ scenario: "S2 capped draft 1366x768", cap, ...m });
    expect(m.textareaH, `textarea ${m.textareaH}px ≤ 上限 ${cap}px`).toBeLessThanOrEqual(cap + 2);
    expect(m.messagesRatio, `触顶后消息可读占比 ${(m.messagesRatio * 100).toFixed(1)}% ≥ ${MIN_COMPOSER_MESSAGES_RATIO * 100}%`).toBeGreaterThanOrEqual(MIN_COMPOSER_MESSAGES_RATIO);
    await screenshot(page, "s2-capped-draft-1366x768");
    expect(logs, `控制台错误: ${logs.join("; ")}`).toEqual([]);
  });

  /**
   * E2E-META
   * Purpose: 引用 chip 从 2 个增至 6 个时，消息区占比不明显下降，chip 不被裁切。
   * Steps:
   *   1. 长草稿下用 # 添加 2 个会话引用。
   *   2. 量测并断言占比 ≥33%、chip 完整可见。
   *   3. 再加 4 个 chip 并重复量测。
   *   4. 断言 2→6 占比下降 ≤3pt 且 chip 完整可见，无 console 错误。
   * Environment: 隔离本地栈；fixture 项目与会话；1366×768 视口。
   * Type: mocked
   * LLM: 本地确定性 SSE fixture；不调用真实或付费模型。
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none — 浏览器与 API 请求均指向 127.0.0.1。
   * Credentials: 隔离实例的 E2E_API_TOKEN 与桩模型令牌。
   * CostSideEffects: none；fixture 在套件结束时清理。
   */
  test("S3 引用 chip 机制不变量:占比不随 chip 数量明显下降", { tag: "@mocked" }, async ({ page }) => {
    const logs: string[] = [];
    attachLogCollector(page, logs);
    await page.setViewportSize({ width: 1366, height: 768 });
    await openSession(page, fixture.projectName, fixture.layoutSession);

    const textarea = page.locator(".composer textarea");
    await textarea.fill(LONG_DRAFT);
    await page.waitForTimeout(150);

    // 通过 UI 添加 2 个 # 会话引用 chip
    await addSessionChip(page, fixture.refSessions[0]);
    await addSessionChip(page, fixture.refSessions[1]);
    await page.waitForTimeout(100);
    const two = await measure(page);
    resultsLog.push({ scenario: "S3 capped + 2 chips 1366x768", ...two });
    expect(two.messagesRatio, `2 chip 占比 ${(two.messagesRatio * 100).toFixed(1)}% ≥ ${MIN_COMPOSER_MESSAGES_RATIO * 100}%`).toBeGreaterThanOrEqual(MIN_COMPOSER_MESSAGES_RATIO);
    await expectChipsFullyVisible(page);
    await screenshot(page, "s3-capped-2chips-1366x768");

    // 再加 4 个,共 6 chip
    for (const label of fixture.refSessions.slice(2, 6)) {
      await addSessionChip(page, label);
    }
    await page.waitForTimeout(100);
    const six = await measure(page);
    resultsLog.push({ scenario: "S3 capped + 6 chips 1366x768", ...six });
    expect(six.messagesRatio, `6 chip 占比 ${(six.messagesRatio * 100).toFixed(1)}% ≥ ${MIN_COMPOSER_MESSAGES_RATIO * 100}%`).toBeGreaterThanOrEqual(MIN_COMPOSER_MESSAGES_RATIO);
    expect(
      two.messagesRatio - six.messagesRatio,
      `chip 2→6 占比下降 ${((two.messagesRatio - six.messagesRatio) * 100).toFixed(1)}pt 应 ≤ 3pt`,
    ).toBeLessThanOrEqual(0.03);
    await expectChipsFullyVisible(page);
    await screenshot(page, "s3-capped-6chips-1366x768");
    expect(logs, `控制台错误: ${logs.join("; ")}`).toEqual([]);
  });

  /**
   * E2E-META
   * Purpose: 6 个 chip 且草稿触顶时，发送按钮仍在 composer 框内可点，模型选择仍可达。
   * Steps:
   *   1. 1366×768 填入长草稿并添加 6 个 chip。
   *   2. 量测 composer 几何。
   *   3. 断言发送按钮在 composer 内、可见可用，且 Model for this task 可见。
   *   4. 断言无 console 错误。
   * Environment: 隔离本地栈；fixture 项目与会话；1366×768 视口。
   * Type: mocked
   * LLM: 本地确定性 SSE fixture；不调用真实或付费模型。
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none — 浏览器与 API 请求均指向 127.0.0.1。
   * Credentials: 隔离实例的 E2E_API_TOKEN 与桩模型令牌。
   * CostSideEffects: none；fixture 在套件结束时清理。
   */
  test("S4 发送可达:多 chip 触顶时发送按钮在 composer 框内可点", { tag: "@mocked" }, async ({ page }) => {
    const logs: string[] = [];
    attachLogCollector(page, logs);
    await page.setViewportSize({ width: 1366, height: 768 });
    await openSession(page, fixture.projectName, fixture.layoutSession);

    const textarea = page.locator(".composer textarea");
    await textarea.fill(LONG_DRAFT);
    for (const label of fixture.refSessions) {
      await addSessionChip(page, label);
    }
    await page.waitForTimeout(100);

    const m = await measure(page);
    resultsLog.push({ scenario: "S4 capped + 6 chips send reachability 1366x768", ...m });
    expectSendInsideComposer(m);
    const sendButton = page.locator("button.send-button");
    await expect(sendButton).toBeVisible();
    await expect(sendButton).toBeEnabled();
    // 模型选择主路径仍可达
    await expect(page.getByLabel("Model for this task")).toBeVisible();
    await screenshot(page, "s4-send-reachable-6chips");
    expect(logs, `控制台错误: ${logs.join("; ")}`).toEqual([]);
  });

  /**
   * E2E-META
   * Purpose: 真实运行中 composer 进入紧凑形态且仍可输入与排队，完成后消息区可滚动。
   * Steps:
   *   1. 1366×768 打开运行会话并量取空闲基线。
   *   2. 挂起 mock LLM 后发送，断言 Stop 出现、composer-compact 可见。
   *   3. 断言运行中 composer 不高于空闲基线、消息占比 ≥33%、textarea 可用、Add to queue 可见。
   *   4. 释放 mock，断言 Run 恢复、回复出现、消息区可滚动到底。
   *   5. 断言无 console 错误。
   * Environment: 隔离本地栈；fixture 运行会话与可挂起的 loopback mock LLM；1366×768 视口。
   * Type: mocked
   * LLM: 本地确定性 SSE fixture，可挂起以制造真实运行态；不调用真实或付费模型。
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none — 浏览器与 API 请求均指向 127.0.0.1。
   * Credentials: 隔离实例的 E2E_API_TOKEN 与桩模型令牌。
   * CostSideEffects: none；fixture 在套件结束时清理。
   */
  test("S5 真实 isRunning:composer-compact 紧凑且可继续输入", { tag: "@mocked" }, async ({ page }) => {
    test.setTimeout(120000);
    const logs: string[] = [];
    attachLogCollector(page, logs);
    await page.setViewportSize({ width: 1366, height: 768 });
    await openSession(page, fixture.projectName, fixture.runSession);

    // 空闲基线
    const idle = await measure(page);
    resultsLog.push({ scenario: "S5 idle baseline (run session) 1366x768", ...idle });

    // 挂起 mock LLM → 真实 running 状态
    gate.hold = true;
    const textarea = page.locator(".composer textarea");
    await textarea.fill("Summarize the evidence in one paragraph.");
    await page.locator("button.send-button").click();

    // 运行中反馈:主操作换成可点的 Stop,composer 进入 compact
    const stopButton = page.getByRole("button", { name: "Stop the current run" });
    await expect(stopButton).toBeVisible({ timeout: 10000 });
    await expect(page.locator(".composer.composer-compact")).toBeVisible();

    const running = await measure(page);
    resultsLog.push({ scenario: "S5 running compact 1366x768", idleComposerH: idle.composerH, ...running });
    expect(running.composerH, `running composer ${running.composerH}px ≤ 空闲基线 ${idle.composerH}px`).toBeLessThanOrEqual(idle.composerH + 2);
    expect(running.messagesRatio, `running 消息可读占比 ${(running.messagesRatio * 100).toFixed(1)}% ≥ ${MIN_IDLE_MESSAGES_RATIO * 100}%`).toBeGreaterThanOrEqual(MIN_IDLE_MESSAGES_RATIO);
    // 运行中仍可继续输入(产品允许),并可在框内排队后续消息
    await expect(textarea).toBeEnabled();
    await textarea.fill("queued follow-up question");
    expectSendInsideComposer(running);
    await expect(page.getByRole("button", { name: "Add to queue" })).toBeVisible();
    await screenshot(page, "s5-running-compact");

    // 释放 mock,任务应完成并给出明确结果反馈
    gate.release();
    await expect(page.getByRole("button", { name: "Run analysis" })).toBeVisible({ timeout: 60000 });
    await expect(page.locator(".messages")).toContainText("Finding 1", { timeout: 10000 });
    await screenshot(page, "s5-run-completed");

    // 完成后消息区内部滚动仍可用(长回复)
    const scrollable = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>(".messages");
      if (!el) return { ok: false, reason: "no .messages" };
      const canScroll = el.scrollHeight > el.clientHeight + 4;
      el.scrollTop = 0;
      const top = el.scrollTop;
      el.scrollTop = el.scrollHeight;
      return { ok: canScroll, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, top, bottom: el.scrollTop };
    });
    resultsLog.push({ scenario: "S5 messages scroll after run", ...scrollable });
    expect(scrollable.ok, `消息区可滚动 scrollHeight=${scrollable.scrollHeight} clientHeight=${scrollable.clientHeight}`).toBeTruthy();
    expect(scrollable.bottom, "消息区可滚动到底部").toBeGreaterThan(0);

    expect(logs, `控制台错误: ${logs.join("; ")}`).toEqual([]);
  });

  /**
   * E2E-META
   * Purpose: 三档桌面视口下，空态、触顶与 chip 增长都保持可读的消息占比，排版不随宽度退化。
   * Steps:
   *   1. 依次在 1366×768、1440×900、1920×1080 打开 fixture 会话并量测空态占比。
   *   2. 填入长草稿触顶，断言 textarea 受上限约束、消息占比不低于下限。
   *   3. 依次加到 2 个与 6 个引用 chip，断言占比不低于下限。
   *   4. 断言 2→6 chip 占比下降 ≤3pt、发送按钮仍在 composer 内。
   *   5. 清空草稿与 chip 后进入下一档视口，最后断言无 console 错误。
   * Environment: 隔离本地栈；fixture 项目与会话；1366×768 / 1440×900 / 1920×1080 视口。
   * Type: mocked
   * LLM: 本地确定性 SSE fixture；不调用真实或付费模型。
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none — 浏览器与 API 请求均指向 127.0.0.1。
   * Credentials: 隔离实例的 E2E_API_TOKEN 与桩模型令牌。
   * CostSideEffects: none；fixture 在套件结束时清理。
   */
  test("S6 三档视口量测:空态 / 触顶 / 触顶+2chip / 触顶+6chip 均保持可读占比", { tag: "@mocked" }, async ({ page }) => {
    test.setTimeout(240000);
    const logs: string[] = [];
    attachLogCollector(page, logs);
    const viewports = [
      { width: 1366, height: 768 },
      { width: 1440, height: 900 },
      { width: 1920, height: 1080 },
    ];
    for (const vp of viewports) {
      const tag = `${vp.width}x${vp.height}`;
      await page.setViewportSize(vp);
      await openSession(page, fixture.projectName, fixture.layoutSession);
      await page.waitForTimeout(150);

      const idle = await measure(page);
      resultsLog.push({ scenario: `S6 idle ${tag}`, ...idle });
      expect(idle.messagesRatio, `${tag} 空态占比 ${(idle.messagesRatio * 100).toFixed(1)}%`).toBeGreaterThanOrEqual(MIN_IDLE_MESSAGES_RATIO);
      if (vp.width === 1366) await screenshot(page, `s6-idle-${tag}`);

      const textarea = page.locator(".composer textarea");
      await textarea.fill(LONG_DRAFT);
      await page.waitForTimeout(150);
      const capped = await measure(page);
      const cap = Math.min(200, 0.2 * vp.height);
      resultsLog.push({ scenario: `S6 capped ${tag}`, cap, ...capped });
      expect(capped.textareaH, `${tag} textarea ≤ ${cap}px`).toBeLessThanOrEqual(cap + 2);
      expect(capped.messagesRatio, `${tag} 触顶占比 ${(capped.messagesRatio * 100).toFixed(1)}%`).toBeGreaterThanOrEqual(MIN_COMPOSER_MESSAGES_RATIO);

      await addSessionChip(page, fixture.refSessions[0]);
      await addSessionChip(page, fixture.refSessions[1]);
      await page.waitForTimeout(100);
      const two = await measure(page);
      resultsLog.push({ scenario: `S6 capped+2chips ${tag}`, ...two });
      expect(two.messagesRatio, `${tag} 触顶+2chip 占比 ${(two.messagesRatio * 100).toFixed(1)}%`).toBeGreaterThanOrEqual(MIN_COMPOSER_MESSAGES_RATIO);

      for (const label of fixture.refSessions.slice(2, 6)) {
        await addSessionChip(page, label);
      }
      await page.waitForTimeout(100);
      const six = await measure(page);
      resultsLog.push({ scenario: `S6 capped+6chips ${tag}`, ...six });
      expect(six.messagesRatio, `${tag} 触顶+6chip 占比 ${(six.messagesRatio * 100).toFixed(1)}%`).toBeGreaterThanOrEqual(MIN_COMPOSER_MESSAGES_RATIO);
      expect(
        two.messagesRatio - six.messagesRatio,
        `${tag} chip 2→6 占比下降 ${((two.messagesRatio - six.messagesRatio) * 100).toFixed(1)}pt 应 ≤ 3pt`,
      ).toBeLessThanOrEqual(0.03);
      expectSendInsideComposer(six);
      await screenshot(page, `s6-capped-6chips-${tag}`);

      // 复位:清空草稿并移除 chip,避免影响下一视口
      await textarea.fill("");
      await removeAllChips(page);
    }
    expect(logs, `控制台错误: ${logs.join("; ")}`).toEqual([]);
  });

  /**
   * E2E-META
   * Purpose: 右侧工作区打开且视口很矮（1366×640 / 1280×640）时，发送按钮仍在卡片内，不与专家下拉或审批控件重叠。
   * Steps:
   *   1. 两档矮视口打开工作区与会话。
   *   2. 空态与触顶各量测，断言发送按钮在 composer 内。
   *   3. 用矩形交集断言发送按钮与专家下拉、审批图标的重叠面积为 0。
   *   4. 断言无 console 错误。
   * Environment: 隔离本地栈；fixture 项目与会话；工作区展开；1366×640 与 1280×640 视口。
   * Type: mocked
   * LLM: 本地确定性 SSE fixture；不调用真实或付费模型。
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none — 浏览器与 API 请求均指向 127.0.0.1。
   * Credentials: 隔离实例的 E2E_API_TOKEN 与桩模型令牌。
   * CostSideEffects: none；fixture 在套件结束时清理。
   */
  test("S8 现场条件:工作区打开 + 矮视口,发送在卡片内且不叠专家/审批", { tag: "@mocked" }, async ({ page }) => {
    const logs: string[] = [];
    attachLogCollector(page, logs);
    for (const vp of [{ width: 1366, height: 640 }, { width: 1280, height: 640 }]) {
      const tag = `${vp.width}x${vp.height}`;
      await page.setViewportSize(vp);
      await openSession(page, fixture.projectName, fixture.layoutSession);

      // 现场条件:右侧工作区保持打开(默认打开;若被收起则点展开按钮)
      if (!(await page.locator("aside.workspace-panel").isVisible().catch(() => false))) {
        await page.locator(".workspace-expander").click();
      }
      await expect(page.locator("aside.workspace-panel")).toBeVisible();

      const idle = await measure(page);
      resultsLog.push({ scenario: `S8 workspace open idle ${tag}`, ...idle });
      expectSendInsideComposer(idle);

      // 长草稿压力下仍不得溢出卡片或叠住专家下拉/审批图标
      const composerTextarea = page.locator(".composer textarea");
      await composerTextarea.fill(LONG_DRAFT);
      await page.waitForTimeout(150);
      const capped = await measure(page);
      resultsLog.push({ scenario: `S8 workspace open capped ${tag}`, ...capped });
      expectSendInsideComposer(capped);
      const overlap = await page.evaluate(() => {
        const send = document.querySelector<HTMLElement>(".send-button");
        const specialist = document.querySelector<HTMLElement>(".orchestration-controls select");
        const approvals = document.querySelector<HTMLElement>(".approval-mode-toggle");
        if (!send) return { send: false, specialist: 0, approvals: 0 };
        const s = send.getBoundingClientRect();
        const area = (el: HTMLElement | null) => {
          if (!el) return 0;
          const r = el.getBoundingClientRect();
          const w = Math.min(s.right, r.right) - Math.max(s.x, r.x);
          const h = Math.min(s.bottom, r.bottom) - Math.max(s.y, r.y);
          return w > 0 && h > 0 ? w * h : 0;
        };
        return { send: true, specialist: area(specialist), approvals: area(approvals) };
      });
      resultsLog.push({ scenario: `S8 send-vs-select overlap ${tag}`, ...overlap });
      expect(overlap.specialist, `${tag} 发送按钮与专家下拉重叠面积`).toBe(0);
      expect(overlap.approvals, `${tag} 发送按钮与审批图标重叠面积`).toBe(0);
      await screenshot(page, `s8-workspace-open-${tag}`);
    }
    expect(logs, `控制台错误: ${logs.join("; ")}`).toEqual([]);
  });

  /**
   * E2E-META
   * Purpose: 500/600 窄屏下模型选择不被压成一条，发送按钮仍在 composer 内可点。
   * Steps:
   *   1. 在 500×800 与 600×800 打开 fixture 会话。
   *   2. 断言模型选择控件可见可用且宽度未被压扁。
   *   3. 输入短消息，断言发送按钮可见可用且在 composer 框内。
   *   4. 断言无 console 错误。
   * Environment: 隔离本地栈；fixture 项目与会话；500×800 与 600×800 视口。
   * Type: mocked
   * LLM: 本地确定性 SSE fixture；不调用真实或付费模型。
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none — 浏览器与 API 请求均指向 127.0.0.1。
   * Credentials: 隔离实例的 E2E_API_TOKEN 与桩模型令牌。
   * CostSideEffects: none；fixture 在套件结束时清理。
   */
  test("S7 窄屏 sanity:500/600 宽发送与模型选择可达", { tag: "@mocked" }, async ({ page }) => {
    const logs: string[] = [];
    attachLogCollector(page, logs);
    for (const vp of [{ width: 500, height: 800 }, { width: 600, height: 800 }]) {
      const tag = `${vp.width}x${vp.height}`;
      await page.setViewportSize(vp);
      await openSession(page, fixture.projectName, fixture.layoutSession);
      await page.waitForTimeout(150);

      const modelSelect = page.getByLabel("Model for this task");
      await expect(modelSelect).toBeVisible();
      await expect(modelSelect).toBeEnabled();
      const selectW = (await modelSelect.boundingBox())?.width ?? 0;
      resultsLog.push({ scenario: `S7 narrow ${tag}`, selectWidth: selectW });
      // 不得卡死在 150px 通栏回归:堆叠布局下应接近容器宽度
      expect(selectW, `${tag} 模型选择宽 ${selectW}px 不应卡 150px`).toBeGreaterThan(200);

      const textarea = page.locator(".composer textarea");
      await textarea.fill("quick question");
      const sendButton = page.locator("button.send-button");
      await expect(sendButton).toBeVisible();
      await expect(sendButton).toBeEnabled();
      const m = await measure(page);
      resultsLog.push({ scenario: `S7 narrow ${tag} composer`, ...m });
      expectSendInsideComposer(m);
      await screenshot(page, `s7-narrow-${tag}`);
      await textarea.fill("");
    }
    expect(logs, `控制台错误: ${logs.join("; ")}`).toEqual([]);
  });

});

});
