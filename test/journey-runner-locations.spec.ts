// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { expect } from "@playwright/test";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { test } from "./helpers/e2e.ts";
import { cleanupJourney, createProjectAndSession, openProjectSession } from "./helpers/journeys.ts";

/**
 * E2E-META
 * Purpose: 用户从二级设置树管理本机和远程 Runner 的机器、工作区、科学环境，避免重复入口。
 * Steps:
 *   1. 浏览设置树并选择本机、远程 Runner 的三个详情页签。
 *   2. 浏览工作区文件，从读取失败恢复，确认机器作用域。
 *   3. 添加和取消 Runner，在 390px 选择目录并查看详情。
 *   4. 旧设置链接仍可进入 Runner 详情，会话 Runner 选择仍生效。
 * Environment: 隔离产品栈；真实 Project/Session；浏览器路由模拟 Runner 目录与管理响应。
 * Type: mocked
 * LLM: none — 设置旅程不调用模型。
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — Runner 响应由本地浏览器路由提供，不建立 SSH 连接。
 * Credentials: E2E_API_TOKEN，仅隔离实例。
 * CostSideEffects: 本地临时 Project/Session，在 finally 清理。
 */
test("R1 设置树按 Runner 集中管理机器、工作区和科学环境", { tag: "@mocked" }, async ({ page, journey }) => {
  journey.scenario({ goal: "从设置二级树选择机器，管理该机器的工作区与环境，添加新 Runner，并在手机宽度完成同样操作。", preconditions: ["隔离产品栈已启动", "使用真实 Project/Session，Runner 管理响应由本地路由提供"] });
  await page.addInitScript(() => localStorage.setItem("science-agent-locale", "zh-CN"));
  const fixture = await createProjectAndSession(page, { projectName: `Runner locations ${Date.now()}`, sessionTitle: "Shared workspace contract" });
  const ids = ["local", "location-remote"];
  let filesUnavailable = false;
  const descriptor = (id: string) => ({ id, alias: id, runnerName: id, location: id === "local" ? "local" : "remote", connectionKind: "direct", status: "ready", createdAt: "2026-01-01", updatedAt: "2026-01-01", endpoint: { host: "127.0.0.1", port: 4311, protocol: "http" }, runnerStatus: { state: "ready", hostId: id } });
  let descriptors = ids.map(descriptor);
  await page.route("**/api/runners", (route) => route.fulfill({ json: descriptors }));
  await page.route("**/api/remote-hosts", async (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: descriptors.filter((item) => item.id !== "local") });
    const host = descriptor(route.request().postDataJSON().alias);
    descriptors.push(host);
    await route.fulfill({ status: 201, json: host });
  });
  await page.route("**/api/remote-hosts/settings-new-runner", async (route) => {
    expect(route.request().method()).toBe("DELETE");
    descriptors = descriptors.filter((item) => item.id !== "settings-new-runner");
    await route.fulfill({ json: { deleted: true } });
  });
  for (const id of ids) {
    await page.route(`**/api/runners/${id}/connect`, (route) => route.fulfill({ json: { state: "ready", hostId: id } }));
    await page.route(`**/api/runners/${id}/environment-setup`, (route) => route.fulfill({ json: { state: "disabled", provisioner: "micromamba", allowedChannels: [], starterPackages: { python: [], r: [] }, components: { micromamba: { state: "disabled" }, conda: { state: "disabled" } } } }));
    await page.route(`**/api/runners/${id}/environment-revisions`, (route) => route.fulfill({ json: [] }));
    await page.route(`**/api/runners/${id}/environments`, (route) => route.fulfill({ json: [{ id: `${id}-python`, name: `${id} Python`, language: "python", kind: "task" }] }));
    const workspaceKey = `${id === "local" ? "/application/projects" : "/runner/workspaces"}/${fixture.session.id}`;
    await page.route(`**/api/runners/${id}/workspaces`, (route) => route.fulfill({ json: [{ runnerId: id, sessionId: fixture.session.id, sessionTitle: fixture.session.title, projectName: fixture.project.name, workspaceKey, records: [] }] }));
    await page.route(`**/api/runners/${id}/workspaces/${fixture.session.id}/files`, (route) => route.fulfill(filesUnavailable ? { status: 503, json: { error: "Runner workspace temporarily unavailable" } } : { json: { runnerId: id, workspaceKey, files: [{ path: `${id}-result.txt`, size: 42 }] } }));
  }
  const dialog = page.getByRole("dialog", { name: "系统设置" });
  const nav = dialog.getByRole("navigation", { name: "设置分组" });
  const directory = dialog.getByRole("button", { name: /^设置目录/ });
  async function selectRunner(id: string) {
    if (await directory.isVisible()) await directory.click();
    await nav.getByRole("button", { name: id === "local" ? "本地 Runner" : id, exact: true }).click();
  }
  async function noOverflow() {
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await dialog.locator(".settings-group-detail").evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  }
  try {
    await openProjectSession(page, fixture);
    await journey.step("打开二级设置目录", "大类可展开；Runner 下有本机与远程，一个添加入口；没有全局工作区或环境小项。", async () => {
      await page.getByRole("button", { name: /^系统设置/ }).click();
      await expect(nav.locator(".settings-tree-category")).toHaveCount(5);
      await expect(nav.getByRole("button", { name: "添加 Runner", exact: true })).toHaveCount(1);
      await expect(nav.getByRole("button", { name: /^(工作区|环境|科学环境)$/ })).toHaveCount(0);
      const category = nav.getByRole("button", { name: "Runner", exact: true });
      await category.click();
      await expect(nav.getByRole("button", { name: "本地 Runner", exact: true })).toBeHidden();
      await category.click();
      await selectRunner("local");
      await expect(dialog.getByText("Runner ID：local", { exact: true })).toBeVisible();
      await expect(dialog.getByRole("tab")).toHaveText(["机器信息", "工作区", "科学环境"]);
      await expect(dialog.getByRole("button", { name: "环境与工作区", exact: true })).toHaveCount(0);
    });
    for (const id of ids) {
      await journey.step(`${id}：检查机器与工作区`, "只显示选中的机器；工作区归属和物理路径与该 Runner 一致。", async () => {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await selectRunner(id);
        await dialog.getByRole("button", { name: "检查连接", exact: true }).click();
        await expect(dialog.locator(".remote-host-card")).toHaveCount(1);
        await expect(dialog.getByText(`Runner ID：${id}`, { exact: true })).toBeVisible();
        await dialog.getByRole("tab", { name: "工作区", exact: true }).click();
        await expect(dialog.getByText(fixture.session.title, { exact: true })).toBeVisible();
        await expect(dialog.locator(".remote-workspace-host > code")).toContainText(id === "local" ? "/application/projects" : "/runner/workspaces");
        await expect(dialog.getByRole("combobox", { name: "管理 Runner" })).toHaveCount(0);
      });
      await journey.step(`${id}：读取失败后重试`, "文件读取失败保留提示；重试后只显示该机器的文件。", async () => {
        filesUnavailable = true;
        await dialog.getByRole("button", { name: "浏览文件", exact: true }).click();
        await expect(dialog.getByRole("alert")).toContainText("Runner workspace temporarily unavailable");
        filesUnavailable = false;
        await dialog.getByRole("button", { name: "浏览文件", exact: true }).click();
        await expect(dialog.getByRole("list", { name: "浏览文件" })).toContainText(`${id}-result.txt`);
        await expect(dialog.getByRole("alert")).toHaveCount(0);
      });
      await journey.step(`${id}：管理科学环境`, "科学环境列表属于所选 Runner，仍可添加环境和配置共享软件源。", async () => {
        await dialog.getByRole("tab", { name: "科学环境", exact: true }).click();
        await expect(dialog.getByText(`${id} Python`, { exact: true })).toBeVisible();
        await expect(dialog.getByRole("button", { name: "新增环境" })).toBeVisible();
        await expect(dialog.getByText("全局软件包源", { exact: true })).toBeVisible();
      });
    }
    await journey.step("添加 Runner 并取消", "添加入口打开 SSH 表单，取消后收起，目录保留原有机器。", async () => {
      await nav.getByRole("button", { name: "添加 Runner", exact: true }).click();
      await expect(dialog.getByRole("form")).toBeVisible();
      await expect(dialog.getByRole("combobox", { name: "连接方式" })).toHaveValue("ssh");
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await expect(dialog.getByRole("form")).toHaveCount(0);
      await expect(dialog.getByText("Runner ID：local", { exact: true })).toBeVisible();
    });
    await journey.step("新增直连 Runner", "提交成功收起表单，新 Runner 进入左侧目录且自动选中。", async () => {
      await nav.getByRole("button", { name: "添加 Runner", exact: true }).click();
      await dialog.getByRole("combobox", { name: "连接方式" }).selectOption("direct");
      await dialog.getByLabel("名称", { exact: true }).fill("settings-new-runner");
      await dialog.getByLabel("IP 地址或主机名", { exact: true }).fill("127.0.0.1");
      await dialog.getByLabel("Token", { exact: true }).fill("test-only-runner-token");
      await dialog.getByRole("button", { name: "连接并添加", exact: true }).click();
      await expect(nav.getByRole("button", { name: "settings-new-runner", exact: true })).toHaveAttribute("aria-current", "page");
      await expect(dialog.getByText("Runner ID：settings-new-runner", { exact: true })).toBeVisible();
      await expect(dialog.getByRole("form")).toHaveCount(0);
    });
    await journey.step("390px 浏览二级目录", "目录在窄屏完整展开，三台 Runner 可辨认，添加入口仍可用。", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await directory.click();
      await expect(nav.getByRole("button", { name: "本地 Runner", exact: true })).toBeVisible();
      await expect(nav.getByRole("button", { name: "settings-new-runner", exact: true })).toBeVisible();
      await noOverflow();
    });
    await journey.step("390px 查看机器信息", "选择机器后目录收起，身份与连接操作完整可用。", async () => {
      await nav.getByRole("button", { name: "本地 Runner", exact: true }).click();
      await expect(nav).toBeHidden();
      await expect(dialog.getByText("Runner ID：local", { exact: true })).toBeVisible();
      await noOverflow();
    });
    await journey.step("390px 查看工作区", "工作区路径、文件浏览和文件名不横向溢出。", async () => {
      await dialog.getByRole("tab", { name: "工作区", exact: true }).click();
      await dialog.getByRole("button", { name: "浏览文件", exact: true }).click();
      await expect(dialog.getByRole("list", { name: "浏览文件" })).toContainText("local-result.txt");
      await noOverflow();
    });
    await journey.step("390px 添加表单", "从目录打开表单后，连接方式与填写区域仍在可用宽度内；可取消返回。", async () => {
      await directory.click();
      await nav.getByRole("button", { name: "添加 Runner", exact: true }).click();
      await expect(dialog.getByRole("form")).toBeVisible();
      await noOverflow();
    });
    await journey.step("删除当前 Runner 后回到本机", "删除确认后目录去掉该机器，详情回到本机，无悬空选择。", async () => {
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await page.setViewportSize({ width: 1440, height: 1000 });
      await selectRunner("settings-new-runner");
      page.once("dialog", (prompt) => prompt.accept());
      await dialog.getByRole("button", { name: "删除", exact: true }).click();
      await expect(nav.getByRole("button", { name: "settings-new-runner", exact: true })).toHaveCount(0);
      await expect(dialog.getByText("Runner ID：local", { exact: true })).toBeVisible();
    });
    await journey.step("旧设置链接保持可达", "旧环境与 Runner 链接都进入本机三页签详情，不恢复重复的管理页。", async () => {
      for (const legacy of ["environments", "remote"]) {
        await page.goto(`/settings/${legacy}`);
        await expect(dialog.getByText("Runner ID：local", { exact: true })).toBeVisible();
        await expect(dialog.getByRole("tab")).toHaveCount(3);
      }
    });
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
