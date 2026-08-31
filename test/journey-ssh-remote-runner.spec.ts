// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

import { expect } from "@playwright/test";

import type { Project, RemoteHostTarget, RemoteWorkspaceSyncRecord, SessionDetail } from "@sciencediscovery/schema";

import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { test } from "./helpers/e2e.ts";
import { cleanupJourney, createProjectAndSession, openProjectSession } from "./helpers/journeys.ts";

test.use({ locale: "zh-CN" });

/**
 * E2E-META
 * Purpose: 用户可在 Project 允许 Linux SSH runner 后，为 Session 固定选机，查看连接与版本差异，并只通过显式操作同步两个持久 workspace。
 * Steps:
 *   1. 打开远程计算设置，确认预装、Linux、版本提示和一次性 SSH/SLURM 作业边界。
 *   2. 将远程机加入 Project 允许名单，再把当前 Session 从本地固定到该机器；机器不能由 Agent 自动选择。
 *   3. 连接 runner，显示本地/远端版本及差异提示，不出现自动安装或升级动作。
 *   4. 验证选机与连接本身不产生同步记录；显式 push、pull 后才各新增一条方向、文件数与字节数记录。
 *   5. 断开 runner 后，Session 仍固定到该机器，已有同步记录保留且没有隐式新增。
 * Environment: Isolated local stack at E2E_BASE_URL；Project/Session 真实创建，SSH 主机、隧道和同步响应由浏览器本地路由确定性模拟。
 * Type: mocked
 * LLM: none — 验证设置、状态和显式同步用户流程，不发起模型调用。
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — 非本地请求被拦截；不连接真实 SSH 主机。
 * Credentials: E2E_API_TOKEN（隔离实例）；无 SSH 密钥或远端凭证。
 * CostSideEffects: none；Project/Session 在 finally 中清理。
 */
test("F1 SSH 远程 Runner 固定选机并显式同步双 workspace", { tag: "@mocked" }, async ({ journey, page }) => {
  test.setTimeout(120_000);
  journey.scenario({
    goal: "一位用户要把当前 Session 固定到获准的 Linux SSH runner，确认版本提示，并按需推送输入、拉回结果。",
    preconditions: [
      "隔离栈已启动且浏览器持有本地访问 token",
      "远端 runner 由管理员预装；本旅程不部署、不升级、不连接真实 SSH",
      "主程序与远端 workspace 独立；同步端点由本地确定性响应模拟",
    ],
  });
  await page.addInitScript(() => window.localStorage.setItem("science-agent-locale", "zh-CN"));
  const fixture = await createProjectAndSession(page, {
    projectName: `F1 remote runner ${Date.now()}`,
    sessionTitle: "Remote workspace session",
  });
  const sessionResponse = await page.request.get(
    `${apiBaseUrl()}/api/sessions/${encodeURIComponent(fixture.session.id)}`,
    { headers: authorizationHeader() },
  );
  let session = await sessionResponse.json() as SessionDetail;
  let project: Project = {
    createdAt: new Date().toISOString(),
    id: fixture.project.id,
    name: fixture.project.name,
    remoteRunnerHostIds: [],
    settingsOverrides: {},
  };
  const hostId = "e2e-linux-runner";
  let connected = false;
  const syncRecords: RemoteWorkspaceSyncRecord[] = [];
  const host = (): RemoteHostTarget => ({
    alias: "institution-linux",
    capabilities: {
      conda: true,
      containerRuntimes: ["apptainer"],
      cpuCores: 32,
      cuda: "12.4",
      gpu: "NVIDIA A100",
      memoryBytes: 128 * 1024 ** 3,
      modules: true,
      platform: "Linux",
      probedAt: new Date().toISOString(),
      runnerCommandAvailable: true,
      scratchPaths: ["/scratch"],
      slurm: true,
    },
    createdAt: new Date().toISOString(),
    id: hostId,
    runnerCommand: "/opt/sciencediscovery/bin/runner",
    runnerStatus: connected ? {
      connectedAt: new Date().toISOString(),
      hostId,
      localVersion: "0.0.0-local",
      remoteVersion: "0.0.0-remote",
      state: "ready",
      versionMismatch: true,
    } : { hostId, state: "disconnected" },
    status: "ready",
    updatedAt: new Date().toISOString(),
  });

  await page.route("**/api/remote-hosts", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: [host()] });
    return route.continue();
  });
  await page.route(`**/api/remote-hosts/${hostId}/runner/*`, async (route) => {
    connected = route.request().url().endsWith("/connect");
    return route.fulfill({ json: host().runnerStatus });
  });
  await page.route(`**/api/projects/${fixture.project.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    project = { ...project, ...(route.request().postDataJSON() as Partial<Project>) };
    return route.fulfill({ json: project });
  });
  await page.route(`**/api/sessions/${fixture.session.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const body = route.request().postDataJSON() as { remoteRunnerHostId?: string | null };
    session = { ...session, ...(body.remoteRunnerHostId ? { remoteRunnerHostId: body.remoteRunnerHostId } : {}) };
    if (body.remoteRunnerHostId === null) delete session.remoteRunnerHostId;
    return route.fulfill({ json: session });
  });
  await page.route(`**/api/sessions/${fixture.session.id}/remote-workspace/sync-records`, (route) =>
    route.fulfill({ json: syncRecords }));
  await page.route(`**/api/sessions/${fixture.session.id}/remote-workspace/sync`, async (route) => {
    const body = route.request().postDataJSON() as { direction: "pull" | "push"; paths: string[] };
    const record: RemoteWorkspaceSyncRecord = {
      bytes: body.direction === "push" ? 120 : 64,
      createdAt: new Date().toISOString(),
      direction: body.direction,
      fileCount: 1,
      hostId,
      id: `sync-${syncRecords.length + 1}`,
      paths: body.paths,
      sessionId: fixture.session.id,
      status: "completed",
    };
    syncRecords.unshift(record);
    return route.fulfill({ json: { files: body.paths, record } });
  });

  try {
    await openProjectSession(page, fixture);
    const openRemoteSettings = async () => {
      const dialog = page.getByRole("dialog", { name: "系统设置" });
      if (!await dialog.isVisible()) await page.getByRole("button", { name: /^系统设置/ }).click();
      await dialog.getByRole("navigation", { name: "设置分组" })
        .getByRole("button", { name: /^远程计算/ })
        .click();
      return dialog;
    };

    await journey.step(
      "核对 Linux、预装与独立作业边界",
      "页面说明仅连接 Linux 机器上的预装 runner，只展示版本差异，不自动安装/升级；一次性 SSH/SLURM 作业仍是独立流程。",
      async () => {
        const dialog = await openRemoteSettings();
        await expect(dialog.getByRole("heading", { name: "SSH targets and runners" })).toBeVisible();
        await expect(dialog.getByText(/pre-installed runner executable/)).toBeVisible();
        await expect(dialog.getByText(/never installs or upgrades/)).toBeVisible();
        await expect(dialog.getByText(/one-shot job card remains a separate feature/)).toBeVisible();
        await expect(dialog.getByText(/Linux · runner \/opt\/sciencediscovery\/bin\/runner found/)).toBeVisible();
      },
    );

    await journey.step(
      "Project 允许后为 Session 固定选机",
      "机器先进入 Project 允许名单，才出现在 Session Runner 下拉框；Session 从 Local runner 明确切到 institution-linux。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const allowedHost = dialog.getByRole("checkbox", { name: "institution-linux" });
        await allowedHost.click();
        await expect.poll(() => project.remoteRunnerHostIds).toEqual([hostId]);
        await expect(allowedHost).toBeChecked();
        const runnerSelector = dialog.getByRole("combobox", { name: "Runner" });
        await runnerSelector.evaluate((element, value) => {
          const select = element as HTMLSelectElement;
          const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
          if (!setter) throw new Error("HTMLSelectElement value setter is unavailable");
          setter.call(select, value);
          select.dispatchEvent(new Event("change", { bubbles: true }));
        }, hostId);
        await expect.poll(() => session.remoteRunnerHostId).toBe(hostId);
        await expect(runnerSelector).toHaveValue(hostId);
        await expect(dialog.getByRole("button", { name: "Delete remote workspace" })).toBeVisible();
        await expect(page.getByText("Remote runner · institution-linux", { exact: true })).toBeVisible();
        await expect(syncRecords).toHaveLength(0);
      },
    );

    await journey.step(
      "连接并仅提示版本差异",
      "状态变为 connected，页面同时展示本地和远端版本及 version differs；没有安装或升级按钮。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await dialog.getByRole("button", { name: "Connect runner" }).click();
        await expect(dialog.getByText("connected", { exact: true })).toBeVisible();
        await expect(dialog.getByText(/Remote 0\.0\.0-remote · local 0\.0\.0-local · version differs/)).toBeVisible();
        await expect(dialog.getByRole("button", { name: /Install|Upgrade/ })).toHaveCount(0);
        await expect(syncRecords).toHaveLength(0);
      },
    );

    await journey.step(
      "显式 push 与 pull 才产生同步记录",
      "选机和连接没有同步记录；用户分别点击 push、pull 后出现两条带方向、文件数、字节数和路径的记录。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const paths = dialog.getByLabel("Paths (one per line)");
        await paths.fill("inputs/data.csv");
        await dialog.getByRole("button", { name: "Push selected paths" }).click();
        await expect(dialog.getByText(/push · completed · 1 files · 120 bytes · inputs\/data\.csv/)).toBeVisible();
        await paths.fill("results/report.md");
        await dialog.getByRole("button", { name: "Pull selected paths" }).click();
        await expect(dialog.getByText(/pull · completed · 1 files · 64 bytes · results\/report\.md/)).toBeVisible();
        await expect(syncRecords).toHaveLength(2);
      },
    );

    await journey.step(
      "断开不切换目标也不隐式同步",
      "断开后状态为 disconnected；Session 下拉仍固定 institution-linux，已有两条记录保持不变且没有新增。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await dialog.getByRole("button", { name: "Disconnect" }).click();
        await expect(dialog.getByText("disconnected", { exact: true })).toBeVisible();
        await expect(dialog.getByRole("combobox", { name: "Runner" })).toHaveValue(hostId);
        await expect(syncRecords).toHaveLength(2);
      },
    );
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await cleanupJourney(page, fixture);
  }
});
