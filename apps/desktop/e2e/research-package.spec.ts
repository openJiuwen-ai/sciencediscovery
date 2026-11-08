// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { expect, test } from "@playwright/test";
import { CREATED_AT, TOKEN, TOKEN_STORAGE_KEY, installMockApi, makeSession } from "./fixtures.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

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

for (const kind of ["continuation", "branch"] as const) {
  test(`${kind} recovers from a durable failure with a fresh request and a visible sidebar row`, async ({ page }, info) => {
    const source = Object.assign(makeSession({ messages }), kind === "continuation" ? { researchSnapshot: { role: "imported_snapshot", state: "ready", continuationAvailable: true } } : {});
    const mock = await installMockApi(page, { sessions: [source] });
    const keys: string[] = [];
    const stored = new Map<string, any>();
    await page.route(kind === "branch" ? "**/conversation-branches" : "**/research-continuations", async route => {
      const key = route.request().postDataJSON().requestId;
      keys.push(key);
      if (!stored.has(key)) {
        const first = stored.size === 0;
        const operation = { id: key, sourceSessionId: "session-1", state: first ? kind === "continuation" ? "copying" : "failed" : "ready", error: first ? "Temporary restore failure" : undefined, entrySessionId: first ? undefined : "retry-result" };
        stored.set(key, operation);
        if (!first) mock.state.sessions.push(makeSession({ id: "retry-result", title: "重试成功", messages: kind === "branch" ? messages.slice(0, 2) : messages }));
      }
      await route.fulfill({ json: stored.get(key) });
    });
    await page.route("**/research-continuations/*", async route => {
      const key = new URL(route.request().url()).pathname.split("/").at(-1)!;
      stored.get(key).state = "failed";
      await route.fulfill({ json: stored.get(key) });
    });
    await test.step("1. Acknowledge and display a durable operation failure", async () => {
      await page.goto("/");
      await expect(page.locator(".conversation")).toContainText("下文结论");
      if (kind === "continuation") await page.getByRole("button", { name: "继续聊天", exact: true }).click();
      else {
        await page.getByRole("button", { name: "回复菜单" }).first().click();
        await page.getByRole("menuitem", { name: "创建新分支聊天" }).click();
        await page.getByRole("dialog").getByRole("button", { name: "创建新分支聊天", exact: true }).click();
      }
      await expect(page.locator(".research-package-status").first()).toContainText("Temporary restore failure");
    });
    await test.step("2. Retry without reload, then navigate to the new session and back", async () => {
      if (kind === "continuation") await page.getByRole("button", { name: "继续聊天", exact: true }).click();
      else await page.getByRole("dialog").getByRole("button", { name: "创建新分支聊天", exact: true }).click();
      await expect(page.locator(".task-head-title")).toHaveText("重试成功");
      await expect(page.locator(".side-sub.is-active .side-session-name")).toHaveText("重试成功");
      expect(keys).toHaveLength(2); expect(keys[0]).not.toBe(keys[1]);
      await page.locator(".side-session-name", { hasText: "晶体结构分析" }).click();
      await expect(page.locator(".task-head-title")).toHaveText("晶体结构分析");
      await page.locator(".side-session-name", { hasText: "重试成功" }).click();
      await expect(page.locator("#composer-textarea")).toBeVisible();
    });
    await info.attach("journey-report", { body: `${kind}: durable failure, fresh-key retry, refreshed sidebar and round-trip navigation passed.`, contentType: "text/plain" });
  });
}

for (const snapshot of [
  { role: "imported_snapshot", state: "ready", continuationAvailable: false },
  { role: "imported_snapshot", state: "ready" },
  { role: "imported_snapshot", state: "importing", continuationAvailable: true },
  { role: "research_copy", state: "failed", continuationAvailable: true },
]) {
  test(`unavailable snapshot ${JSON.stringify(snapshot)} offers no rejected actions`, async ({ page }, info) => {
    await installMockApi(page, { sessions: [Object.assign(makeSession({ messages }), { researchSnapshot: snapshot })] });
    await test.step("Inspect the unavailable snapshot", async () => {
      await page.goto("/");
      await expect(page.locator(".conversation")).toContainText("下文结论");
      await expect(page.getByRole("button", { name: "继续聊天", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "回复菜单", exact: true })).toHaveCount(0);
      await expect(page.locator("#composer-textarea")).toHaveCount(0);
      await expect(page.locator(".research-package-resume")).toContainText("尚未完整恢复");
    });
    await info.attach("journey-report", { body: "Unavailable snapshot hides branch/send/upload and disables continuation with an explanation.", contentType: "text/plain" });
  });
}

test("a missing project reports a recoverable export error and stacked Escape only closes the top dialog", async ({ page }, info) => {
  await installMockApi(page, { sessions: [makeSession({ messages })] });
  await page.route("**/research-package/preview?*", route => route.fulfill({ status: 404, json: { error: "Project not found" } }));
  await test.step("1. Export after the project disappeared", async () => {
    await page.goto("/");
    await expect(page.locator(".task-head-title")).toHaveText("晶体结构分析");
    await page.getByRole("button", { name: "会话菜单", exact: true }).click();
    await page.getByRole("menuitem", { name: "导出会话" }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText("会话或所属项目已不存在");
    await expect(page.getByRole("button", { name: "开始后台导出" })).toBeDisabled();
  });
  await test.step("2. Close a stacked dialog without dismissing export", async () => {
    await page.evaluate(() => {
      const top = document.createElement("section"); top.setAttribute("role", "dialog"); top.setAttribute("aria-label", "Top dialog"); document.body.append(top);
      document.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); top.remove(); } }, { once: true });
    });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "导出会话" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
  await info.attach("journey-report", { body: "Missing-project error and topmost-only Escape behavior verified.", contentType: "text/plain" });
});

for (const locale of ["zh-CN", "en"]) {
  test(`review states: read-only import and export preparing/failure (${locale})`, async ({ page }, info) => {
    const en = locale === "en";
    await page.addInitScript(locale => localStorage.setItem("sciencediscovery-desktop:locale", locale), locale);
    await installMockApi(page, { sessions: [Object.assign(makeSession({ messages }), { researchSnapshot: { role: "imported_snapshot", state: "ready", continuationAvailable: true } })] });
    let fail = false;
    await page.route("**/research-package/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/preview")) return route.fulfill({ json: { revision: "r", estimatedBytes: 2048, files: [], omissions: [] } });
      await route.fulfill({ json: { id: "status-export", status: fail ? "failed" : "running", filename: "research.sdresearch", error: en ? "Export failed: storage unavailable (simulated failure)." : "导出失败：存储暂不可用（模拟失败）。" } });
    });
    const capture = async (name: string) => {
      const dir = process.env.REVIEW_SCREENSHOTS_DIR;
      if (dir) { await mkdir(dir, { recursive: true }); await page.screenshot({ path: join(dir, `${name}-${en ? "en" : "zh"}.png`), animations: "disabled" }); }
    };
    await test.step("1. Inspect the read-only imported conversation", async () => {
      await page.goto("/");
      await expect(page.locator(".conversation")).toContainText("下文结论");
      await expect(page.locator("#composer-textarea")).toHaveCount(0);
      await expect(page.getByRole("button", { name: en ? "Continue chatting" : "继续聊天", exact: true })).toBeEnabled();
      await expect(page.getByRole("button", { name: en ? "Reply menu" : "回复菜单", exact: true })).toHaveCount(0);
      await capture("10-imported-read-only");
    });
    await test.step("2. Inspect export preparation and failure without losing the conversation", async () => {
      await page.getByRole("button", { name: en ? "Session menu" : "会话菜单", exact: true }).click();
      await page.getByRole("menuitem", { name: en ? "Export conversation" : "导出会话" }).click();
      await page.getByRole("button", { name: en ? "Start background export" : "开始后台导出" }).click();
      await expect(page.locator(".research-package-status")).toContainText(en ? "export in progress" : "个导出进行中");
      await capture("11-export-preparing");
      fail = true;
      await expect(page.locator(".research-package-flash")).toContainText(en ? "Export failed" : "导出失败");
      await expect(page.getByRole("button", { name: en ? "Download" : "下载", exact: true })).toHaveCount(0);
      await capture("12-export-failed");
    });
    await info.attach("journey-report", { body: "Read-only UI, export preparing and explicit simulated failure verified. Screenshot data uses the desktop fixture control plane, not a real export failure.", contentType: "text/plain" });
  });
}

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
  await test.step("2. Inspect both real UI cards and save the selected scope automatically", async () => {
    const dialog = page.getByRole("dialog", { name: "导出会话" });
    await expect(dialog.getByRole("button", { name: /^必要导出/ })).toContainText("2.0 KiB");
    await expect(dialog.getByRole("button", { name: /^完整导出/ })).toContainText("8.0 KiB");
    await expect(dialog).toContainText("整个会话及其研究材料");
    await dialog.getByRole("button", { name: /^完整导出/ }).click();
    await expect(dialog.getByText("工作区文件 · 1")).toBeVisible();
    const downloaded = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "开始后台导出" }).click();
    expect((await downloaded).suggestedFilename()).toBe("conversation.sdresearch");
    await expect(page.locator(".research-package-flash")).toContainText("证据包已保存");
  });
  await info.attach("journey-report", { body: "1. Session-menu placement verified.\n2. Both size cards, full research scope and automatic save with completion feedback verified.\n", contentType: "text/plain" });
});

test("hover import defaults to no project and allows an existing project", async ({ page }, info) => {
  const mock = await installMockApi(page, { sessions: [makeSession({ messages })] });
  const targets: string[] = [];
  await page.route("**/research-package/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/inspect")) return route.fulfill({ json: { manifest: { source: { title: "恢复的研究" }, omissions: [] }, objectCount: 2, recordsBytes: 100, packageChecksum: "inspected-package" } });
    expect(new URL(route.request().url()).searchParams.get("inspectionChecksum")).toBe("inspected-package");
    expect(route.request().postData()).toBeNull();
    const projectId = path.split("/")[3]!;
    targets.push(projectId);
    mock.state.sessions.push(Object.assign(makeSession({ id: `import-${projectId}`, projectId, title: "恢复的研究", messages }), { researchSnapshot: { role: "imported_snapshot", state: "ready", continuationAvailable: true } }));
    await route.fulfill({ json: { importedSessionIds: [`import-${projectId}`] } });
  });
  await page.route("**/research-continuations", async route => {
    const source = new URL(route.request().url()).pathname.split("/")[3]!;
    const record = mock.state.sessions.find(session => session.id === source)!;
    const id = `continued-${source}`;
    mock.state.sessions.push(Object.assign({ ...record, id, title: "可继续的研究" }, { researchSnapshot: { role: "research_copy", state: "ready" } }));
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
      await expect(page.locator(".side-sub.is-active .side-session-name")).toHaveText("可继续的研究");
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
    await expect(page.locator(".side-sub.is-active .side-session-name")).toHaveText("分支会话");
    await expect(page.locator(".conversation")).toContainText("上文问题");
    await expect(page.locator(".conversation")).toContainText("中间回复");
    await expect(page.locator(".conversation")).not.toContainText("下文问题");
    await expect(page.locator("#composer-textarea")).toBeVisible();
    expect(mock.state.sessions.find(session => session.id === "session-1")!.messages).toHaveLength(4);
  });
  await info.attach("journey-report", { body: "Selected reply and preceding context restored; later turns absent; original unchanged.", contentType: "text/plain" });
});
