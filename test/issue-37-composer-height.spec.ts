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

import { test, expect, type Page } from "@playwright/test";

import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";

/**
 * 会话 Composer 高度回归测试。
 *
 * 场景:
 *  S1 桌面空闲会话:消息区明显大于输入区
 *  S2 长草稿触顶:textarea 受上限约束，消息区仍 ≥55%
 *  S3 引用 chip 机制不变量:2 chip → 6+ chip 可读占比不明显下降，pill 不裁切
 *  S4 发送可达:多 chip 触顶时发送按钮在 composer 框内
 *  S5 真实 isRunning:mock LLM 挂起制造真实 running，验证 composer-compact
 *  S6 三档视口量测:1366×768 / 1440×900 / 1920×1080 × (空态 / 触顶 / chip)
 *  S7 窄屏 sanity:500 / 600 宽发送与模型选择可达
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
  const chips = await page.locator(".composer-reference-chips button").evaluateAll((buttons) =>
    buttons.map((button) => {
      const chip = button.getBoundingClientRect();
      const container = button.parentElement?.getBoundingClientRect();
      return {
        height: chip.height,
        fullyVisible: !!container && chip.top >= container.top - 1 && chip.bottom <= container.bottom + 1,
      };
    }),
  );
  expect(chips.length, "至少存在一个引用 chip").toBeGreaterThan(0);
  for (const chip of chips) {
    expect(chip.height, "chip 应保持完整 pill 高度").toBeGreaterThanOrEqual(20);
    expect(chip.fullyVisible, "chip 不得被容器半截裁切").toBeTruthy();
  }
}

async function screenshot(page: Page, name: string) {
  fs.mkdirSync(SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: `${SCREENSHOTS}/${RUN_ID}-${name}.png`, fullPage: false });
}

// ---- UI 操作 ----

async function openSession(page: Page, projectName: string, sessionTitle: string) {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const projectButton = page.locator(".nav-item").filter({ hasText: projectName });
  await expect(projectButton).toBeVisible();
  await projectButton.click();
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

  test("S1 桌面空闲会话:消息区明显大于输入区", async ({ page }) => {
    const logs: string[] = [];
    attachLogCollector(page, logs);
    await page.setViewportSize({ width: 1366, height: 768 });
    await openSession(page, fixture.projectName, fixture.layoutSession);

    const m = await measure(page);
    resultsLog.push({ scenario: "S1 idle 1366x768", ...m });
    expect(m.messagesRatio, `消息可读占比 ${(m.messagesRatio * 100).toFixed(1)}% ≥ 55%`).toBeGreaterThanOrEqual(0.55);
    expect(m.messagesReadable, "消息区明显大于 composer").toBeGreaterThan(m.composerH * 1.5);
    expect(m.messagesOverflowY).toBe("auto");
    expect(m.composerTop, "composer 不与消息区重叠").toBeGreaterThanOrEqual(m.messagesBottom - 1);
    // 空态 textarea 应在 1–2 行量级(显著低于修复前约 100px)
    expect(m.textareaH, `空态 textarea ${m.textareaH}px 应接近 1–2 行`).toBeLessThanOrEqual(60);
    await screenshot(page, "s1-idle-1366x768");
    expect(logs, `控制台错误: ${logs.join("; ")}`).toEqual([]);
  });

  test("S2 长草稿触顶:textarea 受上限,消息区仍可读", async ({ page }) => {
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
    expect(m.messagesRatio, `触顶后消息可读占比 ${(m.messagesRatio * 100).toFixed(1)}% ≥ 55%`).toBeGreaterThanOrEqual(0.55);
    await screenshot(page, "s2-capped-draft-1366x768");
    expect(logs, `控制台错误: ${logs.join("; ")}`).toEqual([]);
  });

  test("S3 引用 chip 机制不变量:占比不随 chip 数量明显下降", async ({ page }) => {
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
    expect(two.messagesRatio, `2 chip 占比 ${(two.messagesRatio * 100).toFixed(1)}% ≥ 55%`).toBeGreaterThanOrEqual(0.55);
    await expectChipsFullyVisible(page);
    await screenshot(page, "s3-capped-2chips-1366x768");

    // 再加 4 个,共 6 chip
    for (const label of fixture.refSessions.slice(2, 6)) {
      await addSessionChip(page, label);
    }
    await page.waitForTimeout(100);
    const six = await measure(page);
    resultsLog.push({ scenario: "S3 capped + 6 chips 1366x768", ...six });
    expect(six.messagesRatio, `6 chip 占比 ${(six.messagesRatio * 100).toFixed(1)}% ≥ 55%`).toBeGreaterThanOrEqual(0.55);
    expect(
      two.messagesRatio - six.messagesRatio,
      `chip 2→6 占比下降 ${((two.messagesRatio - six.messagesRatio) * 100).toFixed(1)}pt 应 ≤ 3pt`,
    ).toBeLessThanOrEqual(0.03);
    await expectChipsFullyVisible(page);
    await screenshot(page, "s3-capped-6chips-1366x768");
    expect(logs, `控制台错误: ${logs.join("; ")}`).toEqual([]);
  });

  test("S4 发送可达:多 chip 触顶时发送按钮在 composer 框内可点", async ({ page }) => {
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

  test("S5 真实 isRunning:composer-compact 紧凑且可继续输入", async ({ page, context }) => {
    test.setTimeout(120000);
    const logs: string[] = [];
    attachLogCollector(page, logs);
    await context.tracing.start({ screenshots: true, snapshots: true });
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

    // 运行中反馈:按钮转为 Running…,composer 进入 compact
    const sendButton = page.locator("button.send-button");
    await expect(sendButton).toContainText("Running", { timeout: 10000 });
    await expect(page.locator(".composer.composer-compact")).toBeVisible();

    const running = await measure(page);
    resultsLog.push({ scenario: "S5 running compact 1366x768", idleComposerH: idle.composerH, ...running });
    expect(running.composerH, `running composer ${running.composerH}px ≤ 空闲基线 ${idle.composerH}px`).toBeLessThanOrEqual(idle.composerH + 2);
    expect(running.messagesRatio, `running 消息可读占比 ${(running.messagesRatio * 100).toFixed(1)}% ≥ 55%`).toBeGreaterThanOrEqual(0.55);
    // 运行中仍可继续输入(产品允许),发送键在框内给出 Running… 反馈
    await expect(textarea).toBeEnabled();
    await textarea.fill("queued follow-up question");
    expectSendInsideComposer(running);
    await expect(sendButton).toBeVisible();
    await screenshot(page, "s5-running-compact");

    // 释放 mock,任务应完成并给出明确结果反馈
    gate.release();
    await expect(sendButton).toContainText("Run analysis", { timeout: 60000 });
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

    await context.tracing.stop({ path: `${SCREENSHOTS}/${RUN_ID}-s5-trace.zip` });
    expect(logs, `控制台错误: ${logs.join("; ")}`).toEqual([]);
  });

  test("S6 三档视口量测:空态 / 触顶 / 触顶+2chip / 触顶+6chip 均 ≥55%", async ({ page }) => {
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
      expect(idle.messagesRatio, `${tag} 空态占比 ${(idle.messagesRatio * 100).toFixed(1)}%`).toBeGreaterThanOrEqual(0.55);
      if (vp.width === 1366) await screenshot(page, `s6-idle-${tag}`);

      const textarea = page.locator(".composer textarea");
      await textarea.fill(LONG_DRAFT);
      await page.waitForTimeout(150);
      const capped = await measure(page);
      const cap = Math.min(200, 0.2 * vp.height);
      resultsLog.push({ scenario: `S6 capped ${tag}`, cap, ...capped });
      expect(capped.textareaH, `${tag} textarea ≤ ${cap}px`).toBeLessThanOrEqual(cap + 2);
      expect(capped.messagesRatio, `${tag} 触顶占比 ${(capped.messagesRatio * 100).toFixed(1)}%`).toBeGreaterThanOrEqual(0.55);

      await addSessionChip(page, fixture.refSessions[0]);
      await addSessionChip(page, fixture.refSessions[1]);
      await page.waitForTimeout(100);
      const two = await measure(page);
      resultsLog.push({ scenario: `S6 capped+2chips ${tag}`, ...two });
      expect(two.messagesRatio, `${tag} 触顶+2chip 占比 ${(two.messagesRatio * 100).toFixed(1)}%`).toBeGreaterThanOrEqual(0.55);

      for (const label of fixture.refSessions.slice(2, 6)) {
        await addSessionChip(page, label);
      }
      await page.waitForTimeout(100);
      const six = await measure(page);
      resultsLog.push({ scenario: `S6 capped+6chips ${tag}`, ...six });
      expect(six.messagesRatio, `${tag} 触顶+6chip 占比 ${(six.messagesRatio * 100).toFixed(1)}%`).toBeGreaterThanOrEqual(0.55);
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

  test("S7 窄屏 sanity:500/600 宽发送与模型选择可达", async ({ page }) => {
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
      expect(selectW, `${tag} 模型 select 宽 ${selectW}px 不应卡 150px`).toBeGreaterThan(200);

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
