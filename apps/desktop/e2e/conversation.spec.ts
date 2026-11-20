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

import { CREATED_AT, TOKEN, TOKEN_STORAGE_KEY, installMockApi, makeSession, type JsonRecord, type ReplayRecord } from "./fixtures.js";

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

test("send stays disabled for whitespace and while the composer is empty", async ({ page }) => {
  await installMockApi(page, { sessions: [makeSession()] });
  await page.goto("/");

  const composer = page.locator("#composer-textarea");
  const send = page.getByRole("button", { name: "发送" });

  await composer.fill("   \n  ");
  await expect(send).toBeDisabled();
  await expect(composer).toBeEnabled();
});

const SESSION = "session-1";

function artifactOutput(id: string, version: number, turnId?: string, sessionId = SESSION): JsonRecord {
  return {
    artifact: { id, kind: "markdown", name: `${id}.md`, origin: turnId ? "llm_declared" : "user_upload" },
    version: {
      artifactId: id,
      createdAt: CREATED_AT,
      id: `${id}-v${version}`,
      sessionId,
      sourcePath: `outputs/${id}.md`,
      turnId,
      version,
    },
  };
}

test("each completed reply keeps its artifact version through live replay and reopening", async ({ page }) => {
  test.setTimeout(60_000);
  const firstAnswer = "已完成第一轮报告。";
  const secondAnswer = "已加入质量检查。";
  const firstRun = { id: "first-run", userMessageId: "first-question", assistantMessageId: "first-answer", status: "completed" };
  const firstMessages = [
    { content: "汇总实验结果", createdAt: CREATED_AT, id: "first-question", role: "user" },
    { content: firstAnswer, createdAt: CREATED_AT, id: "first-answer", role: "assistant" },
    { content: "谢谢", createdAt: CREATED_AT, id: "plain-question", role: "user" },
    { content: "很高兴能帮到你。", createdAt: CREATED_AT, id: "plain-answer", role: "assistant" },
  ];
  const mockRuns: ReplayRecord[] = [
    {
      // A pruned log can still have the status. The persisted answer owns the list.
      events: [{ run: firstRun, status: "completed", type: "run.status" }],
      run: firstRun,
    },
    {
      events: [],
      run: { id: "plain-run", userMessageId: "plain-question", assistantMessageId: "plain-answer", status: "completed" },
    },
  ];
  const outputs = [
    artifactOutput("report", 1, "first-run"),
    ...Array.from({ length: 5 }, (_, index) => artifactOutput(`table-${index + 1}`, 1, "first-run")),
    artifactOutput("upload", 1),
    artifactOutput("unattributed", 1, "missing-run"),
  ];
  const mock = await installMockApi(page, {
    artifactContents: { "report-v1": "原始报告内容", "report-v2": "带质量检查的报告内容" },
    artifactsBySession: {
      [SESSION]: outputs,
      "session-2": [artifactOutput("other-session", 1, "run-1", "session-2")],
    },
    runsBySession: { [SESSION]: mockRuns },
    sessions: [makeSession({ messages: firstMessages }), makeSession({ id: "session-2", title: "另一个会话" })],
    subagentsBySession: {
      [SESSION]: [
        { id: "nested-child", parentTurnId: "child", sessionId: SESSION },
        { id: "child", parentTurnId: "run-1", sessionId: SESSION },
      ],
    },
  });
  let sending = false;
  let resumeReplay = () => {};
  const replayReady = new Promise<void>(resolve => { resumeReplay = resolve; });
  await page.route("**/api/sessions/session-1/runs", async (route) => {
    if (sending) await replayReady;
    await route.fallback();
  });
  await page.route("**/api/sessions/session-1/messages", async (route) => {
    const answer = { content: secondAnswer, createdAt: CREATED_AT, id: "message-assistant", role: "assistant" };
    const run = { id: "run-1", userMessageId: "message-user", assistantMessageId: answer.id, status: "completed" };
    const savedEvents = [
      { type: "run.completed", files: [], message: answer },
      { type: "run.status", status: "completed", run },
    ];
    mockRuns.push({ run, events: savedEvents });
    mock.state.sessions[0]!.messages = [...firstMessages, {
      content: "补充质量检查", createdAt: CREATED_AT, id: "message-user", role: "user",
    }, answer];
    const nestedOutput = artifactOutput("report", 2, "nested-child");
    outputs.push(nestedOutput);
    // A status frame can be the first frame after reconnecting to a run.
    const events = [
      { type: "run.status", status: "running", run: { ...run, status: "running" } },
      { type: "artifact.upserted", artifact: nestedOutput.artifact },
      ...savedEvents,
    ];
    await route.fulfill({
      body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      contentType: "text/event-stream",
    });
  });

  await page.goto("/");
  const lists = page.getByRole("region", { name: "本轮产物" });
  const reply = (text: string) => page.locator(".message.assistant").filter({ hasText: text });
  const v1 = reply(firstAnswer).getByRole("button", { name: "report.md v1" });
  const v2 = reply(secondAnswer).getByRole("button", { name: "report.md v2" });
  await expect(v1).toBeVisible({ timeout: 15_000 });
  await expect(lists).toHaveCount(1);
  const firstList = reply(firstAnswer).getByRole("region", { name: "本轮产物" });
  await expect(firstList.getByRole("listitem")).toHaveCount(5);
  await firstList.getByRole("button", { name: "展开全部 6 项产物" }).click();
  await expect(firstList.getByRole("listitem")).toHaveCount(6);
  await test.step("artifact rows fill the card and meet without gaps", async () => {
    const header = await firstList.locator("header").boundingBox();
    const rows = await firstList.locator(".run-artifact-row").evaluateAll(elements =>
      elements.map(element => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      })
    );
    expect(header).not.toBeNull();
    for (const [index, row] of rows.entries()) {
      expect(row.x).toBeCloseTo(header!.x, 0);
      expect(row.width).toBeCloseTo(header!.width, 0);
      if (index > 0) expect(row.y).toBeCloseTo(rows[index - 1]!.y + rows[index - 1]!.height, 0);
    }
  });
  await firstList.getByRole("button", { name: "收起产物" }).click();
  await expect(reply("很高兴能帮到你。").getByRole("region", { name: "本轮产物" })).toHaveCount(0);

  sending = true;
  await page.locator("#composer-textarea").fill("补充质量检查");
  try {
    await page.locator("#composer-textarea").press("Enter");
    await expect(v2).toBeVisible({ timeout: 15_000 });
    await expect(lists).toHaveCount(2);
  } finally {
    // Let the persisted transcript take over even if a live assertion fails.
    resumeReplay();
  }
  await expect(v2).toBeVisible();
  await expect(lists).toHaveCount(2);
  await expect(lists.getByText(/upload|unattributed|other-session/)).toHaveCount(0);

  const panel = page.locator(".workspace-panel");
  await v2.click();
  await expect(panel.getByText("带质量检查的报告内容")).toBeVisible();
  await expect(v2).toHaveAttribute("aria-current", "true");
  await v1.click();
  await expect(panel.getByText("原始报告内容")).toBeVisible();
  await expect(v1).toHaveAttribute("aria-current", "true");
  expect(mock.calls.filter(({ path }) => path.endsWith("/artifact-versions/report-v1/content"))).toHaveLength(1);

  await page.reload();
  await expect(v1).toBeVisible({ timeout: 15_000 });
  await expect(v2).toBeVisible();
  await expect(lists).toHaveCount(2);
  await panel.getByRole("button", { name: "收起面板" }).click();
  await page.locator(".side-session-name", { hasText: "另一个会话" }).click();
  await expect(lists).toHaveCount(0);
  await page.locator(".side-session-name", { hasText: "晶体结构分析" }).click();
  await expect(lists).toHaveCount(2);
});

/**
 * E2E-META
 * Purpose: A temporary lineage read failure recovers on the next outputs refresh.
 * Steps:
 *   1. Open a saved reply while its subagent catalog is unavailable.
 *   2. Send a follow-up that refreshes a version from the same child.
 *   3. Open the recovered output without reopening the Session.
 * Environment: Desktop Vite harness on 4175; page-owned API routes and data.
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none
 * Credentials: fixture-only token
 * CostSideEffects: no cost; page-local records only
 */
test("subagent outputs recover after a catalog failure without reopening the session", { tag: "@mocked" }, async ({ page }) => {
  const run = { id: "saved-run", userMessageId: "question", assistantMessageId: "answer", status: "completed" };
  const outputs = [artifactOutput("direct", 1, run.id), artifactOutput("child-report", 1, "child")];
  await installMockApi(page, {
    artifactsBySession: { [SESSION]: outputs },
    artifactContents: { "child-report-v2": "已恢复的子 Agent 报告" },
    runsBySession: { [SESSION]: [{ run, events: [] }] },
    sessions: [makeSession({ messages: [
      { content: "汇总实验", createdAt: CREATED_AT, id: "question", role: "user" },
      { content: "实验汇总完成。", createdAt: CREATED_AT, id: "answer", role: "assistant" },
    ] })],
    subagentsBySession: { [SESSION]: [{ id: "child", parentTurnId: run.id, sessionId: SESSION }] },
  });
  let catalogReads = 0;
  let catalogAvailable = false;
  let successfulCatalogReads = 0;
  await page.route("**/api/sessions/session-1/subagents", async route => {
    catalogReads++;
    if (!catalogAvailable) {
      await route.fulfill({ status: 503, json: { error: "temporary catalog failure" } });
    } else {
      successfulCatalogReads++;
      await route.fallback();
    }
  });
  await page.route("**/api/sessions/session-1/messages", async route => {
    catalogAvailable = true;
    outputs.push(artifactOutput("child-report", 2, "child"));
    await route.fallback();
  });
  const reply = page.locator(".message.assistant").filter({ hasText: "实验汇总完成。" });
  const childOutput = reply.getByRole("button", { name: "child-report.md v2" });
  await test.step("1. Read the saved reply during a temporary catalog outage", async () => {
    await page.goto("/");
    await expect(reply.getByRole("button", { name: "direct.md v1" })).toBeVisible();
    await expect.poll(() => catalogReads).toBeGreaterThan(0);
    await expect(reply.getByRole("button", { name: "child-report.md v1" })).toHaveCount(0);
  });
  await test.step("2. Continue the session and recover outputs from the same child", async () => {
    await page.locator("#composer-textarea").fill("继续检查实验结果");
    await page.locator("#composer-textarea").press("Enter");
    await expect(childOutput).toBeVisible();
    await expect(reply.getByRole("button", { name: "child-report.md v1" })).toHaveCount(0);
  });
  await test.step("3. Read the recovered version without reopening the session", async () => {
    await childOutput.click();
    await expect(page.locator(".workspace-panel").getByText("已恢复的子 Agent 报告")).toBeVisible();
    expect(successfulCatalogReads).toBe(1);
  });
});

test("only terminal runs show their saved artifacts, even without a reply", async ({ page }) => {
  const cancelled = { id: "cancelled-run", userMessageId: "stopped-question", status: "cancelled" };
  const blocked = { id: "blocked-run", userMessageId: "waiting-question", status: "blocked" };
  await installMockApi(page, {
    artifactsBySession: { [SESSION]: [
      artifactOutput("partial", 1, cancelled.id),
      artifactOutput("pending", 1, blocked.id),
    ] },
    runsBySession: { [SESSION]: [
      { run: cancelled, events: [] },
      { run: blocked, events: [{ run: blocked, status: "blocked", type: "run.status" }] },
    ] },
    sessions: [makeSession({ messages: [
      { content: "已经取消", createdAt: CREATED_AT, id: "stopped-question", role: "user" },
      { content: "等待批准", createdAt: CREATED_AT, id: "waiting-question", role: "user" },
    ] })],
  });
  await page.goto("/");
  const lists = page.getByRole("region", { name: "本轮产物" });
  await expect(lists.getByRole("button", { name: "partial.md v1" })).toBeVisible();
  await expect(lists.getByRole("button", { name: "pending.md v1" })).toHaveCount(0);
  await expect(lists).toHaveCount(1);
});
