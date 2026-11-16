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

/**
 * The turn: type, send, watch the stream land, and read the persisted
 * transcript. The mock answers a send with an SSE body, so this exercises the
 * same parser and reducer the real service drives.
 */
import { expect, test } from "@playwright/test";

import { TOKEN, TOKEN_STORAGE_KEY, installMockApi, makeSession } from "./fixtures.js";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [TOKEN_STORAGE_KEY, TOKEN] as const,
  );
});

test("a message sent from the composer becomes the turn on screen", async ({ page }) => {
  const mock = await installMockApi(page, { sessions: [makeSession()] });
  await page.goto("/");

  const composer = page.locator("#composer-textarea");
  const send = page.getByRole("button", { name: "发送" });
  await expect(composer).toBeVisible();
  // Wait for the boot listing to settle: opening the resumed Session replaces
  // the composer's state, and typing into the one from before the load lands in
  // a box that is about to be re-rendered.
  await expect(page.locator(".side-session-name", { hasText: "晶体结构分析" })).toBeVisible();
  await expect(send).toBeDisabled();

  await composer.fill("请分析这个晶体结构");
  await expect(send).toBeEnabled();
  await composer.press("Shift+Enter");
  await expect(composer).toHaveValue("请分析这个晶体结构\n");

  await composer.press("Enter");

  // The box empties on the press, before the answer arrives.
  await expect(composer).toHaveValue("");
  await expect(page.locator(".message.user")).toContainText("请分析这个晶体结构");
  await expect(page.locator(".message.assistant")).toContainText("晶格常数是 5.43 Å。");
  await expect(send).toBeDisabled();

  expect(
    mock.calls.some(
      (call) =>
        call.method === "POST" &&
        call.path === "/api/sessions/session-1/messages" &&
        call.body?.includes("请分析这个晶体结构") === true,
    ),
  ).toBe(true);
  // The turn is recorded on the server, not only drawn from the stream.
  expect(mock.state.sessions[0]?.messages).toHaveLength(2);
});

test("connector diagnostics remain available after reloading a completed conversation", async ({ page }) => {
  const diagnostic = "example: degraded; omitted tools: search.";
  await installMockApi(page, {
    assistantAnswer: "继续分析现有资料。",
    messageRunEvents: [{ summary: diagnostic, type: "mcp.readiness" }],
    runsBySession: { "session-1": [] },
    sessions: [makeSession()],
  });
  await page.goto("/");
  const session = page.locator(".side-session-name", { hasText: "晶体结构分析" });
  const answer = page.getByText("继续分析现有资料。", { exact: true });
  const fold = page.locator(".run-fold > summary");
  const notice = page.getByText("有 1 个本版本不认识的事件被跳过。", { exact: true });

  await test.step("Read the connector diagnostic from the live conversation", async () => {
    await expect(session).toBeVisible();
    const composer = page.locator("#composer-textarea");
    await composer.fill("分析已有的实验数据");
    await composer.press("Enter");
    await expect(answer).toBeVisible();
    await fold.click();
    await expect(page.getByText("MCP 连接器状态")).toBeVisible();
    await expect(page.getByText(diagnostic, { exact: true })).toBeVisible();
    await expect(notice).toHaveCount(0);
  });

  await test.step("Reopen the session and read the same diagnostic from its history", async () => {
    await page.reload();
    await session.click();
    await expect(answer).toBeVisible();
    const details = page.locator(".run-fold");
    await expect(details).toHaveCount(1);
    if (await details.getAttribute("open") === null) await fold.click();
    await expect(page.getByText(diagnostic, { exact: true })).toBeVisible();
    await expect(notice).toHaveCount(0);
  });
});

test("send stays disabled for whitespace and while the composer is empty", async ({ page }) => {
  await installMockApi(page, { sessions: [makeSession()] });
  await page.goto("/");

  const composer = page.locator("#composer-textarea");
  const send = page.getByRole("button", { name: "发送" });

  await composer.fill("   \n  ");
  await expect(send).toBeDisabled();
  await expect(composer).toBeEnabled();
});
