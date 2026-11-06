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
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect } from "@playwright/test";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { test } from "./helpers/e2e.ts";
import { cleanupJourney, createProjectAndSession, type JourneyFixture } from "./helpers/journeys.ts";

/**
 * E2E-META
 * Purpose: Read one Desktop card per failed run, inspect diagnostics, reload and recover.
 * Steps:
 *   1. Submit a task to a silent local model and read one failure card at 1440px.
 *   2. Open diagnostics at 390px and verify readable content and keyboard disclosure.
 *   3. Reload and repeat the failure, keeping one card per user turn.
 *   4. Recover the local model and complete another task in the same Session.
 *   5. Read the persisted cards in English at 960px.
 * Environment: Isolated built API serving apps/desktop/dist at E2E_BASE_URL; native executor; no Runner or sidecars needed for text-only requests.
 * Type: mocked
 * LLM: Journey-owned loopback HTTP model; silent responses time out, then deterministic successful SSE.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none
 * Credentials: E2E_API_TOKEN for isolated API; runtime-generated synthetic model credential.
 * CostSideEffects: Creates and removes a local model, Project and Session; restores isolated timeout settings; no external calls or cost.
 */
test("Desktop failure cards merge timeout records and remain readable after reload", {
  tag: ["@mocked", "@isolation:instance", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:none"],
}, async ({ page, journey }) => {
  test.setTimeout(90_000);
  let recover = false;
  let modelRequests = 0;
  const model = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      modelRequests++;
      if (!recover) return;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "DESKTOP_RECOVERY_OK" }, finish_reason: null, index: 0 }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
  const origin = apiBaseUrl();
  const headers = authorizationHeader();
  const previousTimeouts = await (await page.request.get(`${origin}/api/timeout-settings`, { headers })).json();
  let fixture: JourneyFixture | undefined;
  const cards = page.locator(".run-failure");
  await page.addInitScript(() => {
    localStorage.setItem("sciencediscovery-desktop:locale", "zh-CN");
    localStorage.setItem("sciencediscovery-desktop:guide", "1");
  });
  const openSession = async () => {
    await page.goto("/");
    await page.locator(".side-project-toggle").filter({ hasText: fixture!.project.name }).click();
    await page.locator(".side-session").filter({ hasText: fixture!.session.title }).click();
    await expect(page.locator("#composer-textarea")).toBeEnabled();
  };
  const submit = async (text: string) => {
    await page.locator("#composer-textarea").fill(text);
    await page.getByRole("button", { name: "发送", exact: true }).click();
  };
  journey.scenario({ goal: "每次运行失败只显示一张可读的告警卡片，诊断完整，刷新后不重复，恢复后可继续工作。", preconditions: ["独立 API 和 Desktop 构建", "native 执行器、仅本地模型桩，无 Runner/sidecar", "单 worker、单浏览器"] });
  try {
    const configured = await page.request.put(`${origin}/api/timeout-settings`, { headers, data: { ...previousTimeouts, gatewayIdleTimeoutMs: 1000, gatewayTurnTimeoutMs: 0 } });
    expect(configured.ok()).toBe(true);
    fixture = await createProjectAndSession(page, {
      projectName: `Desktop cards ${Date.now()}`, sessionTitle: "Failure card checks",
      model: { baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`, apiToken: randomUUID(), model: "desktop-card-local", name: `Desktop card ${Date.now()}`, apiVariant: "openai" },
    });
    await openSession();
    await journey.step("运行超时只显示一张告警", "1440×900 下，失败摘要清晰，原始诊断默认折叠，同一次超时不再显示两张卡片。", async () => {
      await submit("Please answer the first timeout check");
      await expect(cards).toHaveCount(1);
      await expect(cards.locator("h3")).toHaveText("运行未完成");
      await expect(cards.locator(".run-failure-summary")).toContainText("请求超时");
      await expect(cards.locator("pre")).toBeHidden();
      await expect(page.locator("#composer-textarea")).toBeEnabled();
      await expect.poll(() => modelRequests).toBeGreaterThan(0);
      const detail = await (await page.request.get(`${origin}/api/sessions/${fixture!.session.id}`, { headers })).json();
      expect(detail.messages.filter((message: { kind?: string }) => message.kind === "timeout_notice")).toHaveLength(1);
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
      await page.keyboard.press("Enter");
      await expect(cards.locator("pre")).toBeHidden();
    });
    await journey.step("刷新并再次失败", "重新打开会话后仍只有一张卡片；第二次超时产生第二张卡片，两次失败不会误合并。", async () => {
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
      await page.addInitScript(() => localStorage.setItem("sciencediscovery-desktop:locale", "en"));
      await page.setViewportSize({ width: 960, height: 720 });
      await openSession();
      await expect(cards).toHaveCount(2);
      await expect(cards.first().locator("h3")).toHaveText("Run incomplete");
      await expect(cards.first().locator(".run-failure-summary")).toContainText("timed out");
    });
  } finally {
    await page.request.put(`${origin}/api/timeout-settings`, { headers, data: previousTimeouts });
    if (fixture) await cleanupJourney(page, fixture);
    model.closeAllConnections();
    await new Promise<void>(resolve => model.close(() => resolve()));
  }
});
