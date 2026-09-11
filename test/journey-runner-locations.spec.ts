// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { expect } from "@playwright/test";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { test } from "./helpers/e2e.ts";
import { cleanupJourney, createProjectAndSession, openProjectSession } from "./helpers/journeys.ts";

/**
 * E2E-META
 * Purpose: 用户在相同 Runner 卡片中检查连接、查看工作区和处理失败，只改变 Runner 与工作区位置。
 * Steps:
 *   1. 打开统一目录。
 *   2. 分别选择本机和远程的相同操作，浏览工作区。
 *   3. 读取失败后重试，检查窄屏。
 * Environment: 隔离产品栈；真实 Project/Session；浏览器路由模拟两种位置的 Runner 响应。
 * Type: mocked
 * LLM: none — 设置旅程不调用模型；真实执行在 runner-location-journey.mjs 中验证。
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — Runner 响应由本地浏览器路由提供，无 SSH 或 NPU 假设。
 * Credentials: E2E_API_TOKEN，仅隔离实例。
 * CostSideEffects: 本地临时 Project/Session，在 finally 清理。
 */
test("R1 本机与远程使用同一套连接和工作区交互", { tag: "@mocked" }, async ({ page, journey }) => {
  journey.scenario({ goal: "用同一套操作管理两个位置的 Runner，并从文件读取失败恢复。", preconditions: ["隔离栈已启动", "目录响应由本地路由模拟，执行另有真实 API 旅程"] });
  await page.addInitScript(() => localStorage.setItem("science-agent-locale", "zh-CN"));
  const fixture = await createProjectAndSession(page, { projectName: `Runner locations ${Date.now()}`, sessionTitle: "Shared workspace contract" });
  const ids = ["local", "location-remote"];
  let filesUnavailable = false;
  const descriptors = ids.map((id) => ({ id, alias: id, runnerName: id, location: id === "local" ? "local" : "remote", connectionKind: "direct", status: "ready", createdAt: "2026-01-01", updatedAt: "2026-01-01", endpoint: { host: "127.0.0.1", port: 4311, protocol: "http" }, runnerStatus: { state: "ready", hostId: id } }));
  await page.route("**/api/runners", (route) => route.fulfill({ json: descriptors }));
  for (const id of ids) {
    await page.route(`**/api/runners/${id}/connect`, (route) => route.fulfill({ json: { state: "ready", hostId: id } }));
    await page.route(`**/api/runners/${id}/environment-setup`, (route) => route.fulfill({ json: { state: "disabled", provisioner: "micromamba", allowedChannels: [], starterPackages: { python: [], r: [] }, components: { micromamba: { state: "disabled" }, conda: { state: "disabled" } } } }));
    for (const path of ["environment-revisions", "environments"]) await page.route(`**/api/runners/${id}/${path}`, (route) => route.fulfill({ json: [] }));
    const workspaceKey = `${id === "local" ? "/application/projects" : "/runner/workspaces"}/${fixture.session.id}`;
    await page.route(`**/api/runners/${id}/workspaces`, (route) => route.fulfill({ json: [{ runnerId: id, sessionId: fixture.session.id, sessionTitle: fixture.session.title, projectName: fixture.project.name, workspaceKey, records: [] }] }));
    await page.route(`**/api/runners/${id}/workspaces/${fixture.session.id}/files`, (route) => route.fulfill(filesUnavailable ? { status: 503, json: { error: "Runner workspace temporarily unavailable" } } : { json: { runnerId: id, workspaceKey, files: [{ path: "result.txt", size: 42 }] } }));
  }
  try {
    await openProjectSession(page, fixture);
    await journey.step("打开统一 Runner 目录", "本机和远程出现在同一目录，只有一个添加入口。", async () => {
      await page.getByRole("button", { name: /^系统设置/ }).click();
      await page.getByRole("navigation", { name: "设置分组" }).getByRole("button", { name: /^Runner/ }).click();
      await expect(page.getByRole("button", { name: "添加 Runner", exact: true })).toHaveCount(1);
      for (const id of ids) await expect(page.getByText(`Runner ID：${id}`, { exact: true })).toBeVisible();
    });
    for (const id of ids) {
      const card = page.locator(".remote-host-card").filter({ has: page.getByText(`Runner ID：${id}`, { exact: true }) });
      await journey.step(`${id}：检查连接并查看工作区`, "相同按钮进入相同工作区面板，目录说明明确显示所属位置。", async () => {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await card.getByRole("button", { name: "检查连接", exact: true }).click();
        await card.getByRole("button", { name: "环境与工作区", exact: true }).click();
        await card.getByRole("button", { name: "工作区", exact: true }).click();
        await expect(card.getByText(fixture.session.title, { exact: true })).toBeVisible();
        await expect(card.locator(".remote-workspace-host > code")).toContainText(id === "local" ? "/application/projects" : "/runner/workspaces");
      });
      await journey.step(`${id}：读取失败后重试`, "失败保留可读提示，重试后显示文件；两种位置使用相同恢复操作。", async () => {
        filesUnavailable = true;
        await card.getByRole("button", { name: "浏览文件", exact: true }).click();
        await expect(card.getByRole("alert")).toContainText("Runner workspace temporarily unavailable");
        filesUnavailable = false;
        await card.getByRole("button", { name: "浏览文件", exact: true }).click();
        await expect(card.getByRole("list", { name: "浏览文件" })).toContainText("result.txt");
        await expect(card.getByRole("alert")).toHaveCount(0);
      });
      await journey.step(`${id}：窄屏查看结果`, "身份、操作和文件路径不横向溢出。", async () => {
        await page.setViewportSize({ width: 640, height: 960 });
        await card.locator(".remote-workspace-host").scrollIntoViewIfNeeded();
        expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        await expect(card.getByRole("list", { name: "浏览文件" })).toContainText("42 B");
      });
      await card.getByRole("button", { name: "环境与工作区", exact: true }).click();
    }
    await journey.step("空名单与本机选择显示真实数量", "未选择 Runner 时显示 0，重新允许本机后显示 1 和本机名称。", async () => {
      for (const runnerIds of [[], ["local"]]) {
        const response = await page.request.patch(`${apiBaseUrl()}/api/sessions/${fixture.session.id}`, { headers: authorizationHeader(), data: { runnerIds } });
        expect(response.ok()).toBe(true);
        await openProjectSession(page, fixture);
        const badge = page.locator(".session-runner-target");
        await expect(badge).toHaveText(`Runner · ${runnerIds.length}`);
        await expect(badge).toHaveAttribute("title", runnerIds.length ? "允许的 Runner：本地 Runner" : "此会话未选择任何 Runner");
      }
    });
  } finally { await cleanupJourney(page, fixture); }
});
