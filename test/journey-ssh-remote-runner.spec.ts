// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

import { expect } from "@playwright/test";

import type {
  Project,
  RegisterRemoteHostRequest,
  RemoteHostTarget,
  RemoteWorkspaceSyncRecord,
  SessionDetail,
} from "@sciencediscovery/schema";

import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { test } from "./helpers/e2e.ts";
import { cleanupJourney, createProjectAndSession, openProjectSession } from "./helpers/journeys.ts";

test.use({ locale: "zh-CN" });

/**
 * E2E-META
 * Purpose: 用户可以用两种方式接入远程 runner（SSH 添加机器由产品自动部署，或自行在另一台机器启动 runner 后按 IP、端口和 token 连接），为 Session 固定选机，并确认设置页不提供任何文件同步入口。
 * Steps:
 *   1. 打开远程计算设置，确认 SSH 自动部署说明、自行部署表单和一次性 SSH/SLURM 作业边界。
 *   2. 用 IP、端口和 token 登记一台自行部署的 runner，确认列表显示它已通过 token 认证。
 *   3. 将 SSH 机器加入 Project 允许名单，再把当前 Session 从本地固定到该机器；机器不能由 Agent 自动选择。
 *   4. 连接 runner，确认它是产品自动部署的，并展示本地/远端版本及差异提示。
 *   5. 确认设置页没有路径输入、Push 或 Pull 控件；模型完成的同步记录只读展示，删除远端 workspace 仍需用户显式确认。
 *   6. 断开 runner 后，Session 仍固定到该机器，同步记录保持不变。
 * Environment: Isolated local stack at E2E_BASE_URL；Project/Session 真实创建，SSH 主机、自动部署、隧道和同步记录由浏览器本地路由确定性模拟。
 * Type: mocked
 * LLM: none — 验证设置、状态和选机用户流程，不发起模型调用。
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — 非本地请求被拦截；不连接真实 SSH 主机或真实 runner。
 * Credentials: E2E_API_TOKEN（隔离实例）；无 SSH 密钥或远端凭证，登记用的 token 只是模拟值。
 * CostSideEffects: none；Project/Session 在 finally 中清理。
 */
test("F1 远程 Runner 两种接入方式与固定选机", { tag: "@mocked" }, async ({ journey, page }) => {
  test.setTimeout(120_000);
  journey.scenario({
    goal: "一位用户要把当前 Session 固定到一台远程 Linux runner：既可以用 SSH 让产品自动部署，也可以连接自己启动的 runner；文件同步只由模型完成。",
    preconditions: [
      "隔离栈已启动且浏览器持有本地访问 token",
      "本旅程不连接真实 SSH 主机，也不真的部署 runner",
      "主程序与远端 workspace 独立；同步只由模型发起，设置页不提供入口",
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
  let directHost: RemoteHostTarget | undefined;
  // The model transferred one file earlier in this Session; the settings page
  // may show that it happened but must not offer a way to repeat it.
  const syncRecords: RemoteWorkspaceSyncRecord[] = [{
    bytes: 64,
    createdAt: new Date().toISOString(),
    direction: "pull",
    fileCount: 1,
    hostId,
    id: "sync-1",
    paths: ["results/report.md"],
    sessionId: fixture.session.id,
    status: "completed",
  }];
  /** An SSH machine with no runner installed, so connecting has to deploy one. */
  const sshHost = (): RemoteHostTarget => ({
    alias: "institution-linux",
    capabilities: {
      conda: true,
      containerRuntimes: ["apptainer"],
      cpuCores: 32,
      cuda: "12.4",
      gpu: "NVIDIA A100",
      memoryBytes: 128 * 1024 ** 3,
      modules: true,
      nodeVersion: "v22.19.0",
      platform: "Linux",
      probedAt: new Date().toISOString(),
      runnerCommandAvailable: false,
      scratchPaths: ["/scratch"],
      slurm: true,
    },
    connectionKind: "ssh",
    createdAt: new Date().toISOString(),
    id: hostId,
    runnerCommand: "sciencediscovery-runner",
    runnerStatus: connected ? {
      connectedAt: new Date().toISOString(),
      deployed: true,
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
    if (route.request().method() === "GET") {
      return route.fulfill({ json: directHost ? [sshHost(), directHost] : [sshHost()] });
    }
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON() as RegisterRemoteHostRequest;
    directHost = {
      alias: body.alias,
      capabilities: {
        conda: false, containerRuntimes: [], cpuCores: null, cuda: null, gpu: null, memoryBytes: null,
        modules: false, nodeVersion: null, platform: "Linux", probedAt: new Date().toISOString(),
        runnerCommandAvailable: true, scratchPaths: [], slurm: false,
      },
      connectionKind: "direct",
      createdAt: new Date().toISOString(),
      endpoint: { host: body.endpoint?.host ?? "", port: body.endpoint?.port ?? 0, protocol: "http" },
      hasToken: Boolean(body.token),
      id: "e2e-direct-runner",
      runnerCommand: "sciencediscovery-runner",
      runnerStatus: { hostId: "e2e-direct-runner", state: "disconnected" },
      status: "ready",
      updatedAt: new Date().toISOString(),
    };
    return route.fulfill({ json: directHost, status: 201 });
  });
  await page.route(`**/api/remote-hosts/${hostId}/runner/*`, async (route) => {
    connected = route.request().url().endsWith("/connect");
    return route.fulfill({ json: sshHost().runnerStatus });
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
      "核对两种接入方式与独立作业边界",
      "页面说明 SSH 添加的机器由产品自动部署 runner，也可以连接用户自行启动的 runner；一次性 SSH/SLURM 作业仍是独立流程。",
      async () => {
        const dialog = await openRemoteSettings();
        await expect(dialog.getByRole("heading", { name: "SSH machines" })).toBeVisible();
        await expect(dialog.getByText(/deploys and starts its own runner over the same SSH connection/)).toBeVisible();
        await expect(dialog.getByRole("heading", { name: "Runner on another machine" })).toBeVisible();
        await expect(dialog.getByText(/connect to it by IP address and port/)).toBeVisible();
        await expect(dialog.getByText(/one-shot job card remains a separate feature/)).toBeVisible();
        await expect(dialog.getByText(/deployed automatically over SSH \(Node v22\.19\.0\)/)).toBeVisible();
      },
    );

    await journey.step(
      "登记一台自行部署的 runner",
      "填写名称、IP、端口和 token 后，列表出现该 runner 并标注 self-deployed 与 token authenticated。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await dialog.getByLabel("Name", { exact: true }).fill("lab-workstation");
        await dialog.getByLabel("IP address or hostname").fill("192.168.1.20");
        await dialog.getByLabel("Port", { exact: true }).fill("4311");
        await dialog.getByLabel("Token", { exact: true }).fill("e2e-mock-token");
        await dialog.getByRole("button", { name: "Connect and add" }).click();
        await expect(dialog.getByText(/self-deployed · http:\/\/192\.168\.1\.20:4311 · token authenticated/)).toBeVisible();
        await expect(dialog.getByLabel("Token", { exact: true })).toHaveValue("");
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
        await expect(page.getByText("Remote runner · institution-linux", { exact: true })).toBeVisible();
      },
    );

    await journey.step(
      "连接后说明是自动部署并提示版本差异",
      "状态变为 connected，页面同时展示本地和远端版本、version differs 以及 deployed by ScienceDiscovery。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await dialog.getByRole("button", { name: "Connect runner" }).first().click();
        await expect(dialog.getByText("connected", { exact: true })).toBeVisible();
        await expect(dialog.getByText(
          /Remote 0\.0\.0-remote · local 0\.0\.0-local · version differs · deployed by ScienceDiscovery/,
        )).toBeVisible();
      },
    );

    await journey.step(
      "设置页没有文件同步入口",
      "远端 workspace 区域没有路径输入、Push 或 Pull 控件；模型已完成的同步记录只读展示，删除远端 workspace 仍是显式操作。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await expect(dialog.getByRole("heading", { name: "Remote workspace" })).toBeVisible();
        await expect(dialog.getByText(/Only the model transfers files/)).toBeVisible();
        await expect(dialog.getByText(/pull · completed · 1 files · 64 bytes · results\/report\.md/)).toBeVisible();
        await expect(dialog.getByLabel(/Paths/)).toHaveCount(0);
        await expect(dialog.getByRole("button", { name: /Push|Pull/ })).toHaveCount(0);
        await expect(dialog.getByRole("button", { name: "Delete remote workspace" })).toBeVisible();
      },
    );

    await journey.step(
      "断开不切换目标也不隐式同步",
      "断开后状态为 disconnected；Session 下拉仍固定 institution-linux，同步记录保持不变且没有新增。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await dialog.getByRole("button", { name: "Disconnect" }).click();
        await expect(dialog.getByText("disconnected", { exact: true }).first()).toBeVisible();
        await expect(dialog.getByRole("combobox", { name: "Runner" })).toHaveValue(hostId);
        await expect(syncRecords).toHaveLength(1);
      },
    );
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await cleanupJourney(page, fixture);
  }
});
