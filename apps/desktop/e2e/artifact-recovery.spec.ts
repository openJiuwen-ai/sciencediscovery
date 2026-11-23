// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { expect, test, type Page } from "@playwright/test";
import { CREATED_AT, TOKEN, TOKEN_STORAGE_KEY, installMockApi, makeSession, type ReplayRecord, type JsonRecord } from "./fixtures.js";
test.beforeEach(async ({ page }) => {
  await page.addInitScript(([key, token]) => {
    localStorage.setItem(key, token);
    localStorage.setItem("sciencediscovery-desktop:guide", "done");
  }, [TOKEN_STORAGE_KEY, TOKEN] as const);
});
async function installArtifactMock(page: Page, options: Parameters<typeof installMockApi>[1]) {
  const mock = await installMockApi(page, options);
  for (const [path, json] of Object.entries({
    "idea-tree/research": { items: [] },
    "idea-tree/graph": { graph: null, hasIdeaTreeRun: false, treeIds: [] },
    "configuration-requests": { items: [] },
  })) await page.route(`**/api/sessions/*/${path}`, route => route.fulfill({ json }));
  return mock;
}
const SESSION = "session-1";

function artifactOutput(id: string, version: number, turnId?: string, sessionId = SESSION): JsonRecord {
  return {
    artifact: { id, kind: "markdown", name: `${id}.md`, origin: turnId ? "llm_declared" : "user_upload" },
    version: {
      artifactId: id,
      createdAt: CREATED_AT,
      id: `${id}-v${version}`,
      sessionId,
      content: { hash: `${id}-${version}`, size: 256 },
      sourcePath: `outputs/${id}.md`,
      turnId,
      version,
    },
  };
}

/**
 * E2E-META
 * Purpose: Saved versions survive pruned history, live replay and Session switches.
 * Steps:
 *   1. Read and expand the saved reply's artifact cards.
 *   2. Send a revision and read both historical versions.
 *   3. Reload and switch Sessions without duplicate artifact strips.
 * Environment: Desktop Vite on 4175; page-owned API fixtures.
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none
 * Credentials: fixture-only token
 * CostSideEffects: no cost; page-local records only
 */
test("each completed reply keeps its artifact version through live replay and reopening", { tag: "@mocked" }, async ({ page }) => {
  test.setTimeout(60_000);
  const firstAnswer = "已完成第一轮报告。";
  const secondAnswer = "已加入质量检查。";
  const firstRun = { id: "first-run", userMessageId: "first-question", assistantMessageId: "first-answer", sessionId: SESSION, status: "completed" };
  const firstMessages = [
    { content: "汇总实验结果", createdAt: CREATED_AT, id: "first-question", role: "user" },
    { content: firstAnswer, createdAt: CREATED_AT, id: "first-answer", role: "assistant" },
    { content: "谢谢", createdAt: CREATED_AT, id: "plain-question", role: "user" },
    { content: "很高兴能帮到你。", createdAt: CREATED_AT, id: "plain-answer", role: "assistant" },
  ];
  const mockRuns: ReplayRecord[] = [
    {
      // A pruned log can still have the status. The persisted answer owns the list.
      events: [{ run: firstRun, sessionId: SESSION, status: "completed", type: "run.status" }],
      run: firstRun,
    },
    {
      events: [],
      run: { id: "plain-run", userMessageId: "plain-question", assistantMessageId: "plain-answer", sessionId: SESSION, status: "completed" },
    },
  ];
  const outputs = [
    artifactOutput("report", 1, "first-run"),
    ...Array.from({ length: 5 }, (_, index) => artifactOutput(`table-${index + 1}`, 1, "first-run")),
    artifactOutput("upload", 1),
    artifactOutput("unattributed", 1, "missing-run"),
  ];
  const mock = await installArtifactMock(page, {
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
    const run = { id: "run-1", userMessageId: "message-user", assistantMessageId: answer.id, sessionId: SESSION, status: "completed" };
    const savedEvents = [
      { type: "run.completed", files: [], message: answer },
      { type: "run.status", sessionId: SESSION, status: "completed", run },
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
  const v1 = lists.getByRole("button", { name: /report\.md · .*v1/ });
  const v2 = lists.getByRole("button", { name: /report\.md · .*v2/ });
  const panel = page.locator(".workspace-panel");
  await test.step("1. Read and expand a stored reply with pruned history", async () => {
  await expect(v1).toBeVisible({ timeout: 15_000 });
  await expect(lists).toHaveCount(1);
  const firstList = reply(firstAnswer).getByRole("region", { name: "本轮产物" });
  await expect(firstList.getByRole("listitem")).toHaveCount(6);
  await firstList.getByRole("button", { name: /还有 1 个/ }).click();
  await expect(firstList.getByRole("listitem")).toHaveCount(6);
  await firstList.getByRole("button", { name: "收起", exact: true }).click();
  await expect(reply("很高兴能帮到你。").getByRole("region", { name: "本轮产物" })).toHaveCount(0);
  });

  await test.step("2. Revise the report and read both exact saved versions", async () => {
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

  await v2.click();
  await expect(panel.getByText("带质量检查的报告内容")).toBeVisible();
  await v1.click();
  await expect(panel.getByText("原始报告内容")).toBeVisible();
  expect(mock.calls.filter(({ path }) => path.endsWith("/artifact-versions/report-v1/content"))).toHaveLength(1);
  });

  await test.step("3. Reopen and switch Sessions without duplicate cards", async () => {
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
  const run = { id: "saved-run", userMessageId: "question", assistantMessageId: "answer", sessionId: SESSION, status: "completed" };
  const outputs = [artifactOutput("direct", 1, run.id), artifactOutput("child-report", 1, "child")];
  await installArtifactMock(page, {
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
  const childOutput = reply.getByRole("button", { name: /child-report\.md · .*v2/ });
  await test.step("1. Read the saved reply during a temporary catalog outage", async () => {
    await page.goto("/");
    await expect(reply.getByRole("button", { name: /direct\.md · .*v1/ })).toBeVisible();
    await expect.poll(() => catalogReads).toBeGreaterThan(0);
    await expect(reply.getByRole("button", { name: /child-report\.md · .*v1/ })).toHaveCount(0);
  });
  await test.step("2. Continue the session and recover outputs from the same child", async () => {
    await page.locator("#composer-textarea").fill("继续检查实验结果");
    await page.locator("#composer-textarea").press("Enter");
    await expect(childOutput).toBeVisible();
    await expect(reply.getByRole("button", { name: /child-report\.md · .*v1/ })).toHaveCount(0);
  });
  await test.step("3. Read the recovered version without reopening the session", async () => {
    await childOutput.click();
    await expect(page.locator(".workspace-panel").getByText("已恢复的子 Agent 报告")).toBeVisible();
    expect(successfulCatalogReads).toBe(1);
  });
});

/**
 * E2E-META
 * Purpose: Cancelled outputs remain readable while blocked outputs stay hidden.
 * Steps:
 *   1. Open a cancelled run followed by a blocked run.
 *   2. Read only the cancelled run's partial result cards.
 * Environment: Desktop Vite on 4175; page-owned API fixtures.
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none
 * Credentials: fixture-only token
 * CostSideEffects: no cost; page-local records only
 */
test("only terminal runs show their saved artifacts, even without a reply", { tag: "@mocked" }, async ({ page }) => {
  const cancelled = { id: "cancelled-run", userMessageId: "stopped-question", sessionId: SESSION, status: "cancelled" };
  const blocked = { id: "blocked-run", userMessageId: "waiting-question", sessionId: SESSION, status: "blocked" };
  await installArtifactMock(page, {
    artifactsBySession: { [SESSION]: [
      artifactOutput("partial", 1, cancelled.id),
      artifactOutput("pending", 1, blocked.id),
    ] },
    runsBySession: { [SESSION]: [
      { run: cancelled, events: [] },
      { run: blocked, events: [{ run: blocked, sessionId: SESSION, status: "blocked", type: "run.status" }] },
    ] },
    sessions: [makeSession({ messages: [
      { content: "已经取消", createdAt: CREATED_AT, id: "stopped-question", role: "user" },
      { content: "等待批准", createdAt: CREATED_AT, id: "waiting-question", role: "user" },
    ] })],
  });
  await test.step("1. Open the cancelled and blocked turns", async () => { await page.goto("/"); });
  await test.step("2. Read only the cancelled turn's saved files", async () => {
    const lists = page.getByRole("region", { name: "本轮产物" });
    await expect(lists.getByRole("button", { name: /partial\.md · .*v1/ })).toBeVisible();
    await expect(lists.getByRole("button", { name: /pending\.md · .*v1/ })).toHaveCount(0);
    await expect(lists).toHaveCount(1);
  });
});

/**
 * E2E-META
 * Purpose: A failed history read leaves terminal outcomes and saved files readable.
 * Steps:
 *   1. Open completed, failed and cancelled turns without answers or event logs.
 *   2. Read each outcome and open its saved result.
 * Environment: Desktop Vite on 4175; page-owned API fixtures with HTTP 503 logs.
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none
 * Credentials: fixture-only token
 * CostSideEffects: no cost; page-local records only
 */
test("unavailable event history preserves no-answer outcomes and result access", { tag: "@mocked" }, async ({ page }) => {
  const statuses = ["completed", "failed", "cancelled"];
  await installArtifactMock(page, {
    sessions: [makeSession({ messages: statuses.map(status => ({
      id: `${status}-question`, role: "user", content: `Read ${status} result`, createdAt: CREATED_AT,
    })) })],
    runsBySession: { [SESSION]: statuses.map(status => ({ events: [], run: {
      id: status, sessionId: SESSION, status, userMessageId: `${status}-question`,
    } })) },
    artifactsBySession: { [SESSION]: statuses.map(status => artifactOutput(status, 1, status)) },
    artifactContents: Object.fromEntries(statuses.map(status => [`${status}-v1`, `Saved ${status} result`])),
  });
  await page.route("**/api/sessions/session-1/runs/*/events", route => route.fulfill({ status: 503, json: { error: "History unavailable" } }));
  await test.step("1. Read outcomes and result cards despite unavailable history", async () => {
    await page.goto("/");
    await expect(page.locator(".turn-artifacts")).toHaveCount(3);
    await expect(page.locator(".message.assistant .text")).toHaveCount(0);
    for (const label of ["已完成", "运行失败", "已取消"]) await expect(page.getByText(label, { exact: true })).toBeVisible();
  });
  await test.step("2. Open each result at its saved version", async () => {
    for (const status of statuses) {
      await page.locator(".turn-artifacts").getByRole("button", { name: new RegExp(`${status}\\.md · .*v1`) }).click();
      await expect(page.locator(".doc-body")).toContainText(`Saved ${status} result`);
    }
  });
});
