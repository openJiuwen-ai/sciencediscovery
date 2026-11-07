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

import { randomUUID } from "node:crypto";
import { expect, test as base } from "@playwright/test";
import { createJourneyReporter, type JourneyReporter } from "../../../test/helpers/journey-report.ts";
import { CREATED_AT, TOKEN_STORAGE_KEY, installMockApi, makeSession, type ReplayRecord } from "./fixtures.js";

// Reuse automatic step reports without the repository-wide Web stack fixture.
const test = base.extend<{ journey: JourneyReporter }>({
  journey: async ({ page }, use, testInfo) => {
    const reporter = createJourneyReporter(page, testInfo);
    try {
      await use(reporter);
    } finally {
      await reporter.finalize();
    }
  },
});

/**
 * Desktop L2 journey. All API responses are page-owned mocks; this verifies
 * live SSE rendering and persisted replay, not backend timeout enforcement.
 * No backend, Runner, model server, credentials or timeout-setting writes.
 */
test("failure cards merge timeout records and remain readable after reload", async ({ page, journey }) => {
  let recover = false;
  let turn = 0;
  const session = makeSession();
  const runs: ReplayRecord[] = [];
  const mock = await installMockApi(page, {
    sessions: [session],
    runsBySession: { [session.id]: runs },
  });
  await page.addInitScript(({ key, token }) => {
    localStorage.setItem(key, token);
    if (localStorage.getItem("sciencediscovery-desktop:locale") === null) {
      localStorage.setItem("sciencediscovery-desktop:locale", "zh-CN");
    }
  }, { key: TOKEN_STORAGE_KEY, token: randomUUID() });

  // Registered after the common API mock so this route owns message sends.
  // Both the SSE and subsequent GETs use the same per-page persisted records.
  await page.route(`**/api/sessions/${session.id}/messages`, async route => {
    turn++;
    const { content } = route.request().postDataJSON() as { content: string };
    const user = { id: `user-${turn}`, role: "user", content, createdAt: CREATED_AT };
    const run = {
      id: `run-${turn}`, sessionId: session.id, userMessageId: user.id,
      createdAt: CREATED_AT, finishedAt: CREATED_AT, prompt: content, queueOrder: turn,
      status: recover ? "completed" : "failed",
      ...(recover ? { assistantMessageId: `answer-${turn}` } : {}),
    };
    const message = recover
      ? { id: `answer-${turn}`, role: "assistant", content: "DESKTOP_RECOVERY_OK", createdAt: CREATED_AT }
      : { id: `notice-${turn}`, role: "assistant", kind: "timeout_notice", createdAt: CREATED_AT,
          content: "Agent idle timeout: no gateway progress for 1000 ms",
          timeout: { kind: "gateway_idle", reason: "no gateway progress for 1000 ms", timeoutMs: 1000 } };
    const events = [
      { run: { ...run, status: "running" }, type: "run.queued" },
      { model: { name: "Local mock" }, runId: run.id, settings: {}, type: "run.started" },
      ...(recover ? [
        { responseId: `response-${turn}`, turn: 1, type: "assistant.response.started" },
        { delta: message.content, responseId: `response-${turn}`, turn: 1, type: "assistant.delta" },
        { files: [], message, type: "run.completed" },
      ] : [{ error: "Agent run stalled: no gateway progress for 1000 ms", errorCode: "timeout", type: "run.failed" }]),
      { run, status: run.status, type: "run.status" },
    ];
    const stored = mock.state.sessions[0];
    if (!stored) throw new Error("Mock Session is missing");
    stored.messages = [...(stored.messages ?? []), user, message];
    runs.push({ run, events });
    await route.fulfill({
      body: events.map((event, index) => `id: ${index + 1}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      contentType: "text/event-stream", status: 200,
    });
  });
  const cards = page.locator(".run-failure");
  const openSession = async () => {
    await page.goto("/");
    const project = page.locator(".side-project-toggle").filter({ hasText: "默认项目" });
    await expect(project).toBeVisible();
    if (await project.getAttribute("aria-expanded") === "false") await project.click();
    const group = page.locator(".side-project").filter({ has: project }).locator("..");
    await group.locator(".side-session").filter({ hasText: session.title }).click();
    await expect(page.locator("#composer-textarea")).toBeEnabled();
  };
  const submit = async (text: string) => {
    await page.locator("#composer-textarea").fill(text);
    await page.getByRole("button", { name: "发送", exact: true }).click();
  };
  journey.scenario({
    goal: "每次运行失败只显示一张可读的告警卡片，诊断完整，刷新后不重复，恢复后可继续工作。",
    preconditions: ["Desktop Vite 页面", "每个页面独立的内存 API/SSE mock，无真实后端或模型"],
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSession();
  await journey.step("运行超时只显示一张告警", "1440×900 下，失败摘要清晰，原始诊断默认折叠，同一次超时不再显示两张卡片。", async () => {
    await submit("Please answer the first timeout check");
    await expect(cards).toHaveCount(1);
    await expect(cards.locator("h3")).toHaveText("运行超时");
    await expect(cards.locator(".run-failure-summary")).toContainText("Agent 在 1 秒内没有产生进展");
    await expect(cards.locator("pre")).toBeHidden();
    await expect(page.locator("#composer-textarea")).toBeEnabled();
    expect(mock.state.sessions[0]?.messages).toHaveLength(2);
  });
  await journey.step("窄窗口展开完整诊断", "390×844 下，卡片可见且不横向溢出，键盘可展开与收起技术详情。", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const summary = cards.locator("summary");
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(cards.locator("pre")).toBeVisible();
    await expect(cards.locator("pre")).toContainText("no gateway progress for 1000 ms");
    await expect(cards.locator("pre")).toContainText("Agent idle timeout");
    expect(await cards.evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1))).toBe(true);
    const box = await cards.boundingBox();
    if (!box) throw new Error("Failure card has no visible bounds");
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  });
  await journey.step("刷新并再次失败", "重新打开会话后仍只有一张卡片；第二次超时产生第二张卡片，两次失败不会误合并。", async () => {
    await cards.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(cards.locator("pre")).toBeHidden();
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSession();
    await expect(cards).toHaveCount(1);
    await submit("Please answer the second timeout check");
    await expect(cards).toHaveCount(2);
    await expect(page.locator("#composer-textarea")).toBeEnabled();
  });
  await journey.step("恢复后继续任务", "模型恢复后，相同会话正常显示最终结果，之前两次失败的记录仍然保留。", async () => {
    recover = true;
    await submit("Please answer after recovery");
    await expect(page.getByText("DESKTOP_RECOVERY_OK", { exact: true })).toBeVisible();
    await expect(page.locator("#composer-textarea")).toBeEnabled();
    await expect(cards).toHaveCount(2);
  });
  await journey.step("英文中等窗口读取历史告警", "960×720 下，英文标题和摘要完整显示，历史失败每次仍只占一张卡片。", async () => {
    await page.evaluate(() => localStorage.setItem("sciencediscovery-desktop:locale", "en"));
    await page.setViewportSize({ width: 960, height: 720 });
    await openSession();
    await expect(cards).toHaveCount(2);
    await expect(cards.first().locator("h3")).toHaveText("Run timed out");
    await expect(cards.first().locator(".run-failure-summary")).toContainText("made no progress for 1 second");
  });
});


for (const kind of ["runner_exec", "kernel_idle", undefined] as const) {
  test(`standalone ${kind ?? "legacy"} timeout does not mark a completed run as timed out`, async ({ page, journey }) => {
    const raw = "opaque operation timeout diagnostic";
    await installMockApi(page, { sessions: [makeSession({ messages: [
      { id: "question", role: "user", content: "Continue after a tool timeout", createdAt: CREATED_AT },
      { id: "notice", role: "assistant", kind: "timeout_notice", content: raw, createdAt: CREATED_AT,
        ...(kind ? { timeout: { kind, reason: raw, timeoutMs: 1000 } } : {}) },
      { id: "answer", role: "assistant", content: "The task completed after recovery", createdAt: CREATED_AT },
    ] })] });
    await page.addInitScript(({ key, token }) => {
      localStorage.setItem(key, token);
      if (localStorage.getItem("sciencediscovery-desktop:locale") === null) {
        localStorage.setItem("sciencediscovery-desktop:locale", "zh-CN");
      }
    }, { key: TOKEN_STORAGE_KEY, token: randomUUID() });
    journey.scenario({
      goal: "工具或内核超时后任务继续完成时，告警准确描述局部超时，不误报整个运行超时。",
      preconditions: ["Desktop 页面及独立内存 API", "历史超时通知与后续完成回答，无真实后端"],
    });
    for (const locale of ["zh-CN", "en"] as const) {
      await journey.step(`Read the persisted timeout in ${locale}`, "标题标明受影响的操作，完成回答保留，原始诊断可以展开。", async () => {
        if (locale === "en") await page.evaluate(() => localStorage.setItem("sciencediscovery-desktop:locale", "en"));
        await page.goto("/");
        const card = page.locator(".run-failure");
        const expected = kind === "runner_exec"
          ? { "zh-CN": "工具执行超时", en: "Tool execution timed out" }
          : kind === "kernel_idle"
            ? { "zh-CN": "内核空闲超时", en: "Kernel idle timeout" }
            : { "zh-CN": "超时提示", en: "Timeout notice" };
        await expect(card).toHaveCount(1);
        await expect(card.locator("h3")).toHaveText(expected[locale]);
        await expect(card).not.toContainText(/运行超时|运行已终止|run was terminated|Run timed out/);
        await expect(page.getByText("The task completed after recovery", { exact: true })).toBeVisible();
        await card.locator("summary").click();
        await expect(card.locator("pre")).toHaveText(raw);
      });
    }
  });
}
