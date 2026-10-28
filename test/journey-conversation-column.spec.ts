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
import {
  cleanupJourney,
  createProjectAndSession,
  openProjectSession,
  scriptedModel,
  sendUserMessage,
  waitForRunTerminal,
  type JourneyFixture,
} from "./helpers/journeys.ts";

async function expectSharedColumn(page: Page, capped: boolean): Promise<void> {
  const geometry = await page.locator(".conversation").evaluate(pane => {
    const box = (selector: string) => {
      const element = pane.querySelector(selector);
      if (!element) throw new Error(`Missing conversation element: ${selector}`);
      const { x, width } = element.getBoundingClientRect();
      return { x, width };
    };
    const { x, width } = pane.getBoundingClientRect();
    return { pane: { x, width }, user: box(".message.user"), timeline: box(".run-timeline"), composer: box("form.composer") };
  });
  for (const block of [geometry.user, geometry.timeline]) {
    expect(Math.abs(block.x - geometry.composer.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(block.width - geometry.composer.width)).toBeLessThanOrEqual(1);
  }
  expect(Math.abs(geometry.composer.x + geometry.composer.width / 2 - geometry.pane.x - geometry.pane.width / 2)).toBeLessThanOrEqual(1);
  if (capped) expect(geometry.composer.width).toBe(1000);
  else expect(geometry.composer.width).toBeLessThan(1000);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await expect(page.locator("form.composer")).toBeInViewport();
}

test.describe("conversation column", { tag: ["@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@arch:arm64", "@model:mock", "@sandbox:bubblewrap"] }, () => {
  /**
   * E2E-META
   * Purpose: A researcher reads a centered conversation and writes in an equally wide composer, with right-aligned user bubbles at desktop and narrow widths.
   * Steps:
   *   1. Complete a short exchange in a 2560px viewport and check the shared 1000px column and 390px artifact panel.
   *   2. Send a long mixed-language prompt, check wrapping and completed process records, and preserve a follow-up draft.
   *   3. Resize through desktop, drawer and stacking boundaries; verify matched column edges and reachable composer.
   *   4. Reopen the Session with a delayed response and check its centered loading skeleton.
   * Environment: Isolated local stack at E2E_BASE_URL with a journey-owned Project/Session; Chromium DPR 1.
   * Type: mocked
   * LLM: journey-owned OpenAI-compatible HTTP stub on 127.0.0.1; no live model.
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none — non-local browser requests are aborted.
   * Credentials: E2E_API_TOKEN for the isolated local API only.
   * CostSideEffects: no external cost; temporary Project and model are deleted in finally.
   */
  test("transcript and composer share a centered column with right-aligned user bubbles", { tag: "@mocked" }, async ({ page, journey }) => {
    test.setTimeout(180_000);
    journey.scenario({
      goal: "在宽屏中阅读居中的会话列，发送右对齐的短消息和长消息，并在缩窄窗口后继续编辑草稿。",
      preconditions: ["隔离本地栈已启动", "仅使用本地脚本模型", "浏览器 DPR 为 1"],
    });
    await page.setViewportSize({ width: 2560, height: 1440 });
    const stub = await scriptedModel([
      [{ reasoning: "Check the requested layout without changing scientific content.", text: "The conversation is ready for the next research question." }],
      [{ text: "The full research request remains available after resizing." }],
    ]);
    let fixture: JourneyFixture | undefined;
    try {
      await journey.step("宽屏共用居中的 1000px 会话列", "短消息气泡和头像在右侧，回复头像在左侧，输入框与时间线同宽，产物面板仍为 390px。", async () => {
        fixture = await createProjectAndSession(page, {
          model: { ...stub, name: `Conversation column ${Date.now()}` },
          projectName: `Conversation column ${Date.now()}`,
          sessionTitle: "Centered research conversation",
        });
        await openProjectSession(page, fixture);
        const run = await sendUserMessage(page, fixture.session.id, "Hello, 你好。");
        expect((await waitForRunTerminal(page, fixture.session.id, run.id)).status).toBe("completed");
        await expect(page.locator(".messages")).toContainText("The conversation is ready");
        await expectSharedColumn(page, true);
        expect((await page.locator(".workspace-panel").boundingBox())!.width).toBe(390);
        const user = page.locator(".message.user").first();
        const row = (await user.boundingBox())!;
        const avatar = (await user.locator(".avatar").boundingBox())!;
        const bubble = (await user.locator(".markdown-body").boundingBox())!;
        expect(bubble.width).toBeLessThan(row.width / 2);
        expect(bubble.x).toBeGreaterThan(row.x + row.width / 2);
        expect(avatar.x).toBeGreaterThan(bubble.x + bubble.width);
        expect(Math.abs(avatar.x + avatar.width - row.x - row.width)).toBeLessThanOrEqual(1);
        const assistant = page.locator(".run-identity").first();
        expect((await assistant.locator(".avatar").boundingBox())!.x).toBe(row.x);
      });

      await journey.step("长消息换行且过程记录与正文对齐", "中英文长请求完整保留并换行；过程记录留在头像缩进内，调整窗口前保留后续草稿。", async () => {
        const prompt = "Please compare the experimental evidence. 请完整保留所有实验条件与结论。 ".repeat(12).trim();
        const run = await sendUserMessage(page, fixture!.session.id, prompt);
        expect((await waitForRunTerminal(page, fixture!.session.id, run.id)).status).toBe("completed");
        const bubble = page.locator(".message.user .markdown-body").last();
        await expect(bubble).toHaveText(prompt);
        const box = (await bubble.boundingBox())!;
        expect(box.height).toBeGreaterThan(70);
        expect(box.width).toBeLessThanOrEqual(1000);
        const record = page.locator(".run-timeline > .process-record").first();
        await expect(record).toBeVisible();
        const timeline = (await page.locator(".run-timeline").first().boundingBox())!;
        const recordBox = (await record.boundingBox())!;
        expect(recordBox.x).toBeGreaterThan(timeline.x);
        expect(Math.abs(recordBox.x + recordBox.width - timeline.x - timeline.width)).toBeLessThanOrEqual(1);
        await page.locator("form.composer textarea").fill("Follow-up draft 后续研究问题");
        await page.setViewportSize({ width: 1920, height: 1080 });
        await expectSharedColumn(page, true);
      });

      await journey.step("缩窄窗口后会话和输入框仍然匹配", "经过侧栏抽屉和窄屏堆叠边界后没有横向溢出；约 900px 和手机宽度下输入框仍在第一屏，草稿保留。", async () => {
        for (const width of [1440, 1280, 1181, 1180, 1179, 1025, 1024, 1023, 901, 900, 899, 601, 600, 599, 390]) {
          await page.setViewportSize({ width, height: 800 });
          await expectSharedColumn(page, false);
          await expect(page.locator("form.composer textarea")).toHaveValue("Follow-up draft 后续研究问题");
          if (width <= 1024) {
            await expect(page.locator("#app-sidebar")).toBeHidden();
            await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
          }
        }
      });

      await journey.step("加载中的骨架仍位于居中列", "重新加载会话时骨架宽度为 1000px，加载完成后的正文和输入框回到同一列。", async () => {
        await page.setViewportSize({ width: 2560, height: 1440 });
        // Leave the old page before intercepting so its polling requests cannot
        // be caught by the gate and then cancelled by the navigation itself.
        await page.goto("about:blank");
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const route = `**/api/sessions/${fixture!.session.id}`;
        await page.route(route, async request => { await gate; await request.continue(); });
        try {
          await page.goto("/", { waitUntil: "domcontentloaded" });
          const skeleton = page.locator(".message-skeleton");
          await expect(skeleton).toBeVisible();
          const skeletonBox = (await skeleton.boundingBox())!;
          expect(skeletonBox.width).toBe(1000);
          const pane = (await page.locator(".conversation").boundingBox())!;
          expect(Math.abs(skeletonBox.x + skeletonBox.width / 2 - pane.x - pane.width / 2)).toBeLessThanOrEqual(1);
        } finally {
          release();
          await page.unrouteAll({ behavior: "wait" });
        }
        await expect(page.locator(".message-skeleton")).toHaveCount(0);
        await expectSharedColumn(page, true);
      });
    } finally {
      if (fixture) await cleanupJourney(page, fixture);
      await stub.stop();
    }
  });
});
