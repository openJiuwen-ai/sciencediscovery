// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { expect, test } from "@playwright/test";
import { CREATED_AT, TOKEN, TOKEN_STORAGE_KEY, installMockApi, makeSession } from "./fixtures.js";

/**
 * E2E-META
 * Purpose: Export, import and branch research through the desktop conversation controls.
 * Steps: 1. Open a session menu and export. 2. Import through both new-session menus.
 * 3. Branch from an earlier reply and verify the later conversation is absent.
 * Environment: Desktop app with a journey-owned in-memory control plane.
 * Type: mocked
 * LLM: none. WebSearch: none. PaperSources: none. MCP: none.
 * OtherExternal: none. Credentials: fixture token only. CostSideEffects: local fixtures only.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [TOKEN_STORAGE_KEY, TOKEN]);
});

const messages = [
  { id: "u1", role: "user", content: "上文问题", createdAt: CREATED_AT },
  { id: "a1", role: "assistant", content: "中间回复", createdAt: CREATED_AT },
  { id: "u2", role: "user", content: "下文问题", createdAt: CREATED_AT },
  { id: "a2", role: "assistant", content: "下文结论", createdAt: CREATED_AT },
];

test("session menu exports research with two scope cards", async ({ page }, info) => {
  await installMockApi(page, { sessions: [makeSession({ messages })] });
  await page.route("**/research-package/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/preview")) {
      expect(url.searchParams.get("sessionId")).toBe("session-1");
      await route.fulfill({ json: { revision: "revision-1", estimatedBytes: url.searchParams.get("level") === "complete" ? 8192 : 2048, files: [{ path: "results.csv", size: 123, selected: true }], omissions: [] } });
    } else if (url.pathname.endsWith("/exports")) {
      expect(route.request().postDataJSON()).toMatchObject({ sessionId: "session-1", level: "complete", revision: "revision-1" });
      await route.fulfill({ json: { id: "export-1", status: "completed", filename: "conversation.sdresearch" } });
    } else await route.fulfill({ body: "local package bytes" });
  });
  await test.step("1. Find export between rename and delete, without a top toolbar", async () => {
    await page.goto("/");
    await expect(page.locator(".task-head-title")).toHaveText("晶体结构分析");
    await expect(page.locator(".research-package-bar")).toHaveCount(0);
    await page.getByRole("button", { name: "会话菜单", exact: true }).click();
    await expect(page.getByRole("menuitem")).toHaveText(["✎重命名", "导出会话", "🗑删除"]);
    await page.getByRole("menuitem", { name: "导出会话" }).click();
  });
  await test.step("2. Inspect both real UI cards and download the selected scope", async () => {
    const dialog = page.getByRole("dialog", { name: "导出会话" });
    await expect(dialog.getByRole("button", { name: /^必要导出/ })).toContainText("2.0 KiB");
    await expect(dialog.getByRole("button", { name: /^完整导出/ })).toContainText("8.0 KiB");
    await expect(dialog).toContainText("整个会话及其研究材料");
    await dialog.getByRole("button", { name: /^完整导出/ }).click();
    await expect(dialog.getByText("工作区文件 · 1")).toBeVisible();
    await dialog.getByRole("button", { name: "开始后台导出" }).click();
    await expect(page.getByRole("status")).toContainText("conversation.sdresearch");
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载", exact: true }).click();
    expect((await downloaded).suggestedFilename()).toBe("conversation.sdresearch");
  });
  await info.attach("journey-report", { body: "1. Session-menu placement verified.\n2. Both size cards, full research scope and package download verified.\n", contentType: "text/plain" });
});

test("hover import defaults to no project and allows an existing project", async ({ page }, info) => {
  const mock = await installMockApi(page, { sessions: [makeSession({ messages })] });
  const targets: string[] = [];
  await page.route("**/research-package/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/inspect")) return route.fulfill({ json: { manifest: { source: { title: "恢复的研究" }, omissions: [] }, objectCount: 2, recordsBytes: 100 } });
    const projectId = path.split("/")[3]!;
    targets.push(projectId);
    mock.state.sessions.push(makeSession({ id: `import-${projectId}`, projectId, title: "恢复的研究", messages }));
    await route.fulfill({ json: { importedSessionIds: [`import-${projectId}`] } });
  });
  await page.route("**/research-continuations", async route => {
    const source = new URL(route.request().url()).pathname.split("/")[3]!;
    const record = mock.state.sessions.find(session => session.id === source)!;
    const id = `continued-${source}`;
    mock.state.sessions.push({ ...record, id, title: "可继续的研究" });
    await route.fulfill({ json: { id: `op-${source}`, sourceSessionId: source, state: "ready", entrySessionId: id } });
  });
  await page.goto("/");
  await expect(page.locator(".task-head-title")).toHaveText("晶体结构分析");
  await expect(page.locator(".conversation")).toContainText("下文结论");
  await test.step("The import option only appears over the arrow; original create actions remain unchanged", async () => {
    await expect(page.getByRole("menuitem", { name: "导入会话" })).toBeHidden();
    await page.getByRole("button", { name: "新建会话选项", exact: true }).hover();
    await expect(page.getByRole("menuitem", { name: "导入会话" })).toBeVisible();
    await page.locator(".task-head-title").hover();
    await expect(page.getByRole("menuitem", { name: "导入会话" })).toBeHidden();
    await expect(page.getByRole("button", { name: "在「默认项目」中导入会话" })).toHaveCount(0);
    await page.getByRole("button", { name: "新建会话", exact: true }).click();
    await expect(page.locator(".landing")).toBeVisible();
    expect(targets).toEqual([]);
  });
  for (const project of ["inbox-1", "project-1"]) {
    await test.step(`Import and continue in ${project}`, async () => {
      await page.getByRole("button", { name: "新建会话选项", exact: true }).hover();
      await page.getByRole("menuitem", { name: "导入会话" }).click();
      const dialog = page.getByRole("dialog", { name: "导入会话" });
      await expect(dialog.getByLabel("项目归属")).toHaveValue("");
      if (project === "project-1") await dialog.getByLabel("项目归属").selectOption(project);
      await dialog.locator("input[type=file]").setInputFiles({ name: "study.sdresearch", mimeType: "application/octet-stream", buffer: Buffer.from("fixture") });
      await expect(dialog).toContainText("恢复的研究");
      await dialog.getByRole("button", { name: "确认导入" }).click();
      await expect(page.locator(".task-head-title")).toHaveText("可继续的研究");
      await expect(page.locator("#composer-textarea")).toBeVisible();
      await expect(page.locator(".conversation")).toContainText("下文结论");
    });
  }
  expect(targets).toEqual(["inbox-1", "project-1"]);
  await info.attach("journey-report", { body: "Hover-only import, unchanged create actions, no-project default and optional project assignment verified; history restored into a writable conversation.", contentType: "text/plain" });
});

test("reply menu branches at the selected reply without its later conversation", async ({ page }, info) => {
  const mock = await installMockApi(page, { sessions: [makeSession({ messages })] });
  await page.route("**/conversation-branches", async route => {
    expect(route.request().postDataJSON().messageId).toBe("a1");
    mock.state.sessions.push(makeSession({ id: "branch-1", title: "分支会话", messages: messages.slice(0, 2) }));
    await route.fulfill({ json: { id: "branch-operation", sourceSessionId: "session-1", state: "ready", entrySessionId: "branch-1" } });
  });
  await test.step("1. Create a branch from the earlier reply's own menu", async () => {
    await page.goto("/");
    await expect(page.locator(".conversation")).toContainText("下文结论");
    await page.getByRole("button", { name: "回复菜单" }).first().click();
    await page.getByRole("menuitem", { name: "创建新分支聊天" }).click();
    const dialog = page.getByRole("dialog", { name: "创建新分支聊天" });
    await expect(dialog.locator("blockquote")).toHaveText("中间回复");
    await dialog.getByRole("button", { name: "创建新分支聊天" }).click();
  });
  await test.step("2. Verify the prefix, writable composer and unchanged source", async () => {
    await expect(page.locator(".task-head-title")).toHaveText("分支会话");
    await expect(page.locator(".conversation")).toContainText("上文问题");
    await expect(page.locator(".conversation")).toContainText("中间回复");
    await expect(page.locator(".conversation")).not.toContainText("下文问题");
    await expect(page.locator("#composer-textarea")).toBeVisible();
    expect(mock.state.sessions.find(session => session.id === "session-1")!.messages).toHaveLength(4);
  });
  await info.attach("journey-report", { body: "Selected reply and preceding context restored; later turns absent; original unchanged.", contentType: "text/plain" });
});
