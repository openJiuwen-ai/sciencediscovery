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

/** Session contract for remote runners: the fixed-target field is replaced by an allowlist override. */
type SessionWithRemoteOverride = SessionDetail & { remoteRunnerHostIds?: string[] | null };

/**
 * E2E-META
 * Purpose: 远程计算全局页只做机器目录（列表优先、点添加才出表单、卡片操作同组等宽）；Project 在自己的设置里维护允许名单，Session 在自己的设置里覆盖（收窄或禁用），允许远端不锁死本机执行；会话栏徽章完整可读且不暗示互斥选机。
 * Steps:
 *   1. 打开远程计算设置：默认只有机器列表和一个添加按钮，没有常驻表单；SSH 表单接受别名或 IP/hostname，端口可省略。
 *   2. 主机卡片的 Connect/Refresh/Delete 在同一操作组、同一行、等宽。
 *   3. SSH 凭据只接受本机密钥路径，不出现私钥粘贴框；生成密钥后只展示可复制公钥。
 *   4. ssh_config 先展示 Host 列表，点选一项后把别名、端口、用户和密钥路径导入可编辑表单。
 *   5. 登记请求只发送 privateKeyPath；未知主机密钥在设置对话框内确认后重试成功。
 *   6. 更新凭据时用户名回填、秘密不回显；外层保存不会丢弃子表单，提交后卡片展示安全的已保存标记和最新探测错误。
 *   7. 在 Project 设置里勾选允许名单，Session 可收窄、禁用或恢复继承；没有互斥选机下拉。
 *   8. 会话栏徽章完整显示且文案只表示“远端可用”；连接 runner 后展示版本差异与部署来源。
 *   9. 远端 workspace 只读同步记录与删除入口在 Session 设置里，且没有任何路径输入或 Push/Pull 控件。
 * Environment: Isolated local stack at E2E_BASE_URL；Project/Session 真实创建，SSH 主机、自动部署、隧道和同步记录由浏览器本地路由确定性模拟。
 * Type: mocked
 * LLM: none — 验证设置、状态和徽章用户流程，不发起模型调用。
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — 非本地请求被拦截；不连接真实 SSH 主机或真实 runner。
 * Credentials: E2E_API_TOKEN（隔离实例）；SSH 路径、公钥、密码和 runner token 都是浏览器路由内的模拟值。
 * CostSideEffects: none；Project/Session 在 finally 中清理。
 */
test("F1 远程 Runner 机器目录与 Project/Session 允许名单", { tag: "@mocked" }, async ({ journey, page }) => {
  test.setTimeout(120_000);
  journey.scenario({
    goal: "用户登记远程 Runner，Project 提供默认值，Session 可独立选择 Project 未选的机器或恢复继承；本机始终可用，保存位于设置底部。",
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
  let session = await sessionResponse.json() as SessionWithRemoteOverride;
  let project: Project = {
    createdAt: new Date().toISOString(),
    id: fixture.project.id,
    name: fixture.project.name,
    remoteRunnerHostIds: [],
    settingsOverrides: {},
  };
  const authenticationError = "SSH authentication failed for operator@ssh.example.test:22.\nServer offered: publickey, password.\nActually tried: none, password, publickey (none is method discovery).\nStored credentials: password yes; key yes.\nThe server did not accept authentication. Check the credentials and the server\'s account/login policy.";
  const hostId = "e2e-linux-runner";
  let connected = false;
  let directHost: RemoteHostTarget | undefined;
  let registeredSshHost: RemoteHostTarget | undefined;
  let lastSshRegisterBody: RegisterRemoteHostRequest | undefined;
  const generatedKeyPath = "generated/remote-runner-ed25519";
  const generatedPublicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE2ePublicKeyForBrowserOnly sciencediscovery";
  const savedCredentials: Record<string, unknown> = {};
  // The model transferred one file earlier in this Session; the Session
  // settings may show that it happened but must not offer a way to repeat it.
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
    hostName: "192.0.2.40",
    port: 2222,
    username: "researcher",
    runnerName: "GPU analysis",
    description: "Python and R analysis on the lab GPU",
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
      slurm: false,
    },
    connectionKind: "ssh",
    createdAt: new Date().toISOString(),
    id: hostId,
    publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExistingPublicKey institution-linux",
    runnerCommand: "sciencediscovery-runner",
    runnerStatus: connected ? {
      connectedAt: new Date().toISOString(),
      deployed: true,
      hostId,
      localVersion: "0.0.0-local",
      remoteVersion: "0.0.0-remote",
      state: "ready",
      versionMismatch: true,
      resources: {
        capturedAt: new Date().toISOString(), cpuCores: 32, loadAverage1m: 1.25,
        memoryTotalBytes: 128 * 1024 ** 3, memoryFreeBytes: 80 * 1024 ** 3, uptimeSeconds: 86400,
        workspaceDisk: { path: "/data/sciencediscovery/remote-workspaces", totalBytes: 100 * 1024 ** 3, availableBytes: 60 * 1024 ** 3 },
      },
    } : { hostId, state: "disconnected" },
    status: "ready",
    updatedAt: new Date().toISOString(),
  });

  await page.route("**/api/{remote-hosts,runners}", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        json: [{ id: "local", alias: "local", location: "local", runnerStatus: { state: "ready" }, status: "ready", connectionKind: "direct", createdAt: "2026-01-01", updatedAt: "2026-01-01" }, sshHost(), ...(registeredSshHost ? [registeredSshHost] : []), ...(directHost ? [directHost] : [])],
      });
    }
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON() as RegisterRemoteHostRequest;
    if (body.connectionKind === "ssh") {
      lastSshRegisterBody = body;
      // Until the user trusts the fingerprint in the dialog, registration fails.
      if (!body.trustHostKey) {
        return route.fulfill({
          json: {
            code: "SSH_HOST_KEY_UNTRUSTED",
            details: { hostKey: { algorithm: "ssh-ed25519", fingerprint: "SHA256:e2e-fingerprint" } },
            error: "Host key verification failed",
          },
          status: 409,
        });
      }
      registeredSshHost = {
        alias: body.alias,
        runnerName: body.runnerName,
        description: body.description,
        capabilities: {
          conda: false, containerRuntimes: [], cpuCores: 4, cuda: null, gpu: null, memoryBytes: 16 * 1024 ** 3,
          modules: false, nodeVersion: "v22.19.0", platform: "Linux", probedAt: new Date().toISOString(),
          runnerCommandAvailable: false, scratchPaths: [], slurm: false,
        },
        connectionKind: "ssh",
        createdAt: new Date().toISOString(),
        id: "e2e-added-ssh",
        hasPassword: Boolean(body.password),
        hasPrivateKey: Boolean(body.privateKeyPath),
        port: typeof body.port === "number" ? body.port : undefined,
        ...(body.privateKeyPath ? { publicKey: generatedPublicKey } : {}),
        runnerCommand: body.runnerCommand ?? "sciencediscovery-runner",
        runnerStatus: { hostId: "e2e-added-ssh", state: "disconnected" },
        status: "ready",
        updatedAt: new Date().toISOString(),
        ...(body.username ? { username: body.username } : {}),
      };
      return route.fulfill({ json: registeredSshHost, status: 201 });
    }
    directHost = {
      runnerName: body.runnerName,
      description: body.description,
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
  await page.route("**/api/remote-hosts/ssh-config*", (route) => {
    const alias = new URL(route.request().url()).searchParams.get("alias");
    if (!alias) {
      return route.fulfill({
        json: [
          { alias: "institution-linux", hostName: "login.institution.edu", identityKeyReadable: false, port: 2222, username: "researcher" },
          { alias: "gpu-lab", hostName: "gpu.institution.edu", identityKeyReadable: false, port: 2200, username: "scientist" },
        ],
      });
    }
    return route.fulfill({
      json: {
        alias,
        hostName: alias === "gpu-lab" ? "gpu.institution.edu" : "login.institution.edu",
        identityFile: "~/.ssh/id_ed25519",
        identityKeyReadable: true,
        port: alias === "gpu-lab" ? 2200 : 2222,
        username: alias === "gpu-lab" ? "scientist" : "researcher",
      },
    });
  });
  await page.route("**/api/remote-hosts/generate-key", (route) => route.fulfill({
    json: { privateKeyPath: generatedKeyPath, publicKey: generatedPublicKey },
  }));
  await page.route("**/api/remote-hosts/key-files?*", (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    const directory = path?.includes("science keys") ? "/fixture-keys/science keys" : "/fixture-keys";
    return route.fulfill({ json: {
      directory, parentDirectory: "/fixture-keys", nextOffset: null,
      entries: directory.endsWith("science keys")
        ? [{ name: "id_ed25519", path: directory + "/id_ed25519", kind: "file" }]
        : [{ name: "science keys", path: directory + "/science keys", kind: "directory" }],
    } });
  });
  await page.route("**/api/remote-hosts/*/credentials", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    Object.assign(savedCredentials, body);
    registeredSshHost = {
      ...registeredSshHost!,
      capabilities: undefined,
      error: authenticationError,
      hasPassword: true,
      hasPrivateKey: true,
      status: "error",
      updatedAt: new Date().toISOString(),
      username: String(body.username),
    };
    return route.fulfill({ json: registeredSshHost });
  });
  await page.route(`**/api/runners/${hostId}/*`, async (route) => {
    connected = route.request().url().endsWith("/connect");
    return route.fulfill({ json: sshHost().runnerStatus });
  });
  // URL navigation reloads the app, so the Project list must reflect PATCHes
  // made through the scoped-settings dialogs.
  await page.route("**/api/projects", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ json: [project] });
  });
  await page.route(`**/api/projects/${fixture.project.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    project = { ...project, ...(route.request().postDataJSON() as Partial<Project>) };
    if (project.runnerIds) project.remoteRunnerHostIds = project.runnerIds.filter((id) => id !== "local");
    return route.fulfill({ json: project });
  });
  await page.route(`**/api/sessions/${fixture.session.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const body = route.request().postDataJSON() as { runnerIds?: string[] | null; remoteRunnerHostIds?: string[] | null };
    if (body.runnerIds === null) { delete session.runnerIds; delete session.remoteRunnerHostIds; }
    else if (body.runnerIds) { session.runnerIds = body.runnerIds; session.remoteRunnerHostIds = body.runnerIds.filter((id) => id !== "local"); }
    if ("remoteRunnerHostIds" in body) {
      if (body.remoteRunnerHostIds === null) delete session.remoteRunnerHostIds;
      else session = { ...session, remoteRunnerHostIds: body.remoteRunnerHostIds };
    }
    return route.fulfill({ json: session });
  });
  await page.route(`**/api/sessions/${fixture.session.id}/remote-workspace/sync-records`, (route) =>
    route.fulfill({ json: syncRecords }));
  let deletedWorkspace = false;
  await page.route(`**/api/runners/${hostId}/workspaces`, (route) => route.fulfill({ json: [{
    sessionId: fixture.session.id, sessionTitle: session.title, projectName: project.name,
    workspaceKey: `${project.id}/${session.id}`, records: syncRecords,
  }] }));
  await page.route(`**/api/runners/${hostId}/workspaces/${fixture.session.id}`, (route) => {
    expect(route.request().method()).toBe("DELETE"); deletedWorkspace = true;
    return route.fulfill({ json: { deleted: true } });
  });
  const remoteEnvironments = [{ id: "remote-python", name: "Remote Python base", language: "python", kind: "starter", currentRevisionId: "remote-revision" }];
  await page.route(`**/api/runners/${hostId}/environment-setup`, (route) => route.fulfill({ json: {
    state: "ready", provisioner: "micromamba", allowedChannels: ["conda-forge"],
    components: { micromamba: { state: "ready", phase: "ready", message: "Ready" }, conda: { state: "ready", phase: "ready", message: "Ready" } },
  } }));
  await page.route(`**/api/runners/${hostId}/environment-revisions`, (route) => route.fulfill({ json: [{ id: "remote-revision", packages: ["python", "numpy"] }] }));
  await page.route(`**/api/runners/${hostId}/environments`, async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      expect(body.language).toBe("r");
      remoteEnvironments.push({ id: "remote-r", name: body.name, language: "r", kind: "task", currentRevisionId: "remote-revision" });
      return route.fulfill({ status: 201, json: remoteEnvironments[1] });
    }
    return route.fulfill({ json: remoteEnvironments });
  });

  /** The global Remote compute group inside the system settings dialog. */
  const openRemoteSettings = async () => {
    const dialog = page.getByRole("dialog", { name: "系统设置" });
    if (!await dialog.isVisible()) await page.getByRole("button", { name: /^系统设置/ }).click();
    await dialog.getByRole("navigation", { name: "设置分组" })
      .getByRole("button", { name: /^Runner/ })
      .click();
    return dialog;
  };
  const openProjectSettings = async () => {
    await page.goto(`/projects/${encodeURIComponent(fixture.project.id)}/settings`);
    return page.getByRole("dialog", { name: "项目设置" });
  };
  const openSessionSettings = async () => {
    await page.goto(`/projects/${encodeURIComponent(fixture.project.id)}/sessions/${encodeURIComponent(fixture.session.id)}/settings`);
    return page.getByRole("dialog", { name: "会话设置" });
  };

  try {
    await openProjectSession(page, fixture);

    await journey.step(
      "全局页默认只有机器列表与添加入口",
      "远程计算页只管理机器目录：默认显示已配置列表，SSH 与自行接入的表单都藏在添加按钮后面；页面上没有 Project 允许名单，也没有 Session 选机。",
      async () => {
        const dialog = await openRemoteSettings();
        await expect(dialog.getByRole("heading", { name: "Runners" })).toBeVisible();
        await expect(dialog.getByText("GPU analysis", { exact: true })).toBeVisible();
        await expect(dialog.getByRole("button", { name: "添加 Runner", exact: true })).toBeVisible();
        await expect(dialog.getByText("Runner ID：local", { exact: true })).toBeVisible();
        await expect(dialog.getByText(`Runner ID：${hostId}`, { exact: true })).toBeVisible();
        await expect(dialog.getByText("Python and R analysis on the lab GPU", { exact: true })).toBeVisible();
        // No blank form competes with the list, and no scoped controls live here.
        await expect(dialog.getByLabel("SSH 别名或 IP/主机名")).toHaveCount(0);
        await expect(dialog.getByLabel("Token", { exact: true })).toHaveCount(0);
        await expect(dialog.getByRole("checkbox", { name: /institution-linux/ })).toHaveCount(0);
        await expect(dialog.getByRole("combobox", { exact: true, name: "Runner" })).toHaveCount(0);
        await expect(dialog.getByRole("combobox", { name: "允许的远程 Runner" })).toHaveCount(0);
        await expect(dialog.getByText(/一次性作业卡/)).toHaveCount(0);
        await expect(dialog.getByText(/所有 Shell\/Python\/R 命令均通过/)).toBeVisible();
      },
    );

    await journey.step(
      "先看机器身份，右侧操作，下方连接与资源详情",
      "名称、IP/端口和用户名在卡片顶部，操作在右侧同行等宽；未连接时磁盘提示仍在下方详情区域。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const actions = dialog.locator(".remote-host-card", { hasText: hostId }).locator(".remote-host-actions").first();
        const names = ["连接 Runner", "刷新资源", "删除"];
        const boxes = [];
        for (const name of names) {
          const button = actions.getByRole("button", { name });
          await expect(button).toBeVisible();
          boxes.push(await button.boundingBox());
        }
        const [connect, refresh, remove] = boxes;
        if (!connect || !refresh || !remove) throw new Error("Action buttons have no layout box");
        expect(Math.abs(connect.y - refresh.y)).toBeLessThan(2);
        expect(Math.abs(refresh.y - remove.y)).toBeLessThan(2);
        expect(Math.abs(connect.width - refresh.width)).toBeLessThan(2);
        expect(Math.abs(refresh.width - remove.width)).toBeLessThan(2);
        const card = dialog.locator(".remote-host-list .remote-host-card", { hasText: hostId });
        const header = card.locator(".remote-host-card-header");
        await expect(header).toContainText("GPU analysis");
        await expect(header).toContainText("192.0.2.40:2222");
        await expect(header).toContainText("用户 researcher");
        const identityBox = await header.locator(".remote-host-card-main").boundingBox();
        const headerBox = await header.boundingBox();
        const detailsBox = await card.locator(".remote-host-card-details").boundingBox();
        expect(connect.x).toBeGreaterThan(identityBox!.x + identityBox!.width);
        expect(detailsBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height);
        await expect(card.getByLabel("Runner 资源")).toContainText("连接 Runner 后进行测量");
        await card.scrollIntoViewIfNeeded();
      },
    );

    await journey.step(
      "添加 SSH 按连接登录与 Runner 信息分组",
      "用户名和密码直接可见，说明只有匹配配置提供 User 才能留空；导入属于连接区，密钥和高级参数按需展开。取消后表单收回。",
      async () => {
        await page.setViewportSize({ width: 1440, height: 1200 });
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await dialog.getByRole("button", { name: "添加 Runner", exact: true }).click();
        const form = dialog.getByRole("form", { name: "添加 SSH 机器" });
        await expect(form.getByRole("group", { name: "1. 连接" })).toBeVisible();
        await expect(form.getByRole("group", { name: "2. 登录" }).getByLabel("用户名", { exact: true })).toBeVisible();
        await expect(form.getByLabel("密码（可选）")).toBeVisible();
        await expect(form.getByText(/SSH 需要用户名/)).toBeVisible();
        await expect(form.getByLabel("Runner 可执行文件")).toBeHidden();
        await form.getByLabel("用户名", { exact: true }).fill("draft-user");
        await form.getByRole("button", { name: "取消", exact: true }).click();
        await expect(form).toHaveCount(0);
        await dialog.getByRole("button", { name: "添加 Runner", exact: true }).click();
        await expect(form.getByLabel("用户名", { exact: true })).toHaveValue("");
        await form.scrollIntoViewIfNeeded();
      },
    );

    await journey.step(
      "窄窗口添加表单按分组纵向排列",
      "640px 窗口内字段单列、用户名说明完整换行，没有横向溢出；高级 Runner 参数可展开编辑。",
      async () => {
        await page.setViewportSize({ width: 640, height: 1200 });
        const form = page.getByRole("form", { name: "添加 SSH 机器" });
        await form.getByText("Runner 高级设置", { exact: true }).click();
        await expect(form.getByLabel("Runner 可执行文件")).toBeVisible();
        await form.getByText("Runner 高级设置", { exact: true }).click();
        expect(await form.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        await form.getByRole("group", { name: "2. 登录" }).scrollIntoViewIfNeeded();
      },
    );

    await journey.step(
      "SSH 凭据只有本机密钥路径，没有私钥粘贴框",
      "在登录区按需展开 SSH key，可选择私钥文件或生成密钥；用户名和密码仍直接可见，没有私钥粘贴入口。",
      async () => {
        await page.setViewportSize({ width: 1440, height: 1200 });
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await expect(dialog.getByLabel("SSH 别名或 IP/主机名")).toBeVisible();
        await expect(dialog.getByLabel("端口（可选）")).toBeVisible();
        await expect(dialog.getByLabel("密码（可选）")).toBeVisible();
        await dialog.getByRole("button", { name: "SSH 密钥（可选）" }).click();
        await expect(dialog.getByLabel("私钥文件（可选）")).toBeVisible();
        await expect(dialog.getByRole("textbox", { name: /私钥文件/ })).toHaveCount(1);
        await expect(dialog.locator("textarea")).toHaveCount(0);
        await expect(dialog.getByText(/粘贴 SSH 私钥/)).toHaveCount(0);
      },
    );

    await journey.step(
      "在独立弹窗里浏览运行机器的密钥文件",
      "点击 Browse 打开独立模态选择框，目录不再挤进设置表单；不会弹出浏览器上传窗口。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await dialog.getByRole("button", { name: "浏览", exact: true }).click();
        const picker = page.getByRole("dialog", { name: "在应用所在机器上选择密钥" });
        await expect(picker).toBeVisible();
        expect(await picker.evaluate((element) => element.matches(":modal"))).toBe(true);
        await expect(picker).toContainText("运行 ScienceDiscovery 的机器");
        await picker.getByRole("button", { name: "science keys 文件夹" }).click();
        await expect(picker.getByRole("button", { name: "id_ed25519 选择文件" })).toBeVisible();
        await expect(dialog.locator('input[type="file"]')).toHaveCount(0);
        await picker.scrollIntoViewIfNeeded();
      },
    );

    await journey.step(
      "窄窗口仍能浏览和选择文件",
      "文件列表、目录位置及返回/取消操作在窄对话框内完整显示，不产生横向溢出。",
      async () => {
        await page.setViewportSize({ width: 640, height: 960 });
        const picker = page.getByRole("region", { name: "应用所在机器上的文件" });
        await picker.scrollIntoViewIfNeeded();
        expect(await picker.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        await expect(picker.getByRole("button", { name: "id_ed25519 选择文件" })).toBeVisible();
      },
    );

    await journey.step(
      "选择文件后回填路径，取消不会改动已选值",
      "选中运行机器上的文件后选择器收起，Private key file 显示完整路径；再次打开并取消仍保留该路径，用户还能手动编辑。",
      async () => {
        await page.setViewportSize({ width: 1440, height: 900 });
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await dialog.getByRole("button", { name: "id_ed25519 选择文件" }).click();
        await expect(dialog.getByLabel("私钥文件（可选）")).toHaveValue("/fixture-keys/science keys/id_ed25519");
        await expect(dialog.getByRole("region", { name: "应用所在机器上的文件" })).toHaveCount(0);
        await dialog.getByRole("button", { name: "浏览", exact: true }).click();
        await dialog.getByRole("button", { name: "取消选择" }).click();
        await dialog.getByRole("button", { name: "浏览", exact: true }).click();
        await page.getByRole("dialog", { name: "在应用所在机器上选择密钥" }).press("Escape");
        await expect(page.getByRole("dialog", { name: "在应用所在机器上选择密钥" })).toHaveCount(0);
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole("button", { name: "浏览", exact: true })).toBeFocused();
        await expect(dialog.getByLabel("私钥文件（可选）")).toHaveValue("/fixture-keys/science keys/id_ed25519");
        await expect(dialog.getByLabel("私钥文件（可选）")).toBeEditable();
        await dialog.getByLabel("私钥文件（可选）").scrollIntoViewIfNeeded();
      },
    );

    await journey.step(
      "ssh_config 先展示可导入的 Host 列表",
      "点 Import from ssh_config 后出现已有 Host 列表，可先看别名、目标地址、端口和用户，再选择要导入的一台。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await dialog.getByRole("button", { name: "从 ssh_config 导入" }).click();
        const list = dialog.locator(".remote-host-import-list");
        await expect(list.getByRole("button", { name: /institution-linux/ })).toBeVisible();
        await expect(list.getByRole("button", { name: /gpu-lab/ })).toContainText("gpu.institution.edu · 端口 2200 · scientist");
      },
    );

    await journey.step(
      "点选 ssh_config 条目后仍可编辑",
      "选择 gpu-lab 后，单条配置的别名、端口、用户和密钥路径进入普通表单；用户可继续修改这些值。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await dialog.locator(".remote-host-import-list").getByRole("button", { name: /gpu-lab/ }).click();
        await expect(dialog.getByText(/已从 ssh_config 导入 gpu-lab/)).toBeVisible();
        await expect(dialog.getByLabel("SSH 别名或 IP/主机名")).toHaveValue("gpu.institution.edu");
        await expect(dialog.getByLabel("私钥文件（可选）")).toHaveValue("~/.ssh/id_ed25519");
        await dialog.getByLabel("SSH 别名或 IP/主机名").fill("gpu-lab-custom");
        await dialog.getByLabel("端口（可选）").fill("2299");
        await dialog.getByLabel("用户名").fill("operator");
        await expect(dialog.getByLabel("SSH 别名或 IP/主机名")).toHaveValue("gpu-lab-custom");
        await expect(dialog.getByLabel("端口（可选）")).toHaveValue("2299");
        await expect(dialog.getByLabel("用户名")).toHaveValue("operator");
      },
    );

    await journey.step(
      "生成密钥后只展示可复制公钥",
      "点 Generate a key pair 后，密钥路径自动填入；页面只展示一行可复制公钥，并明确提示把它加入远端 authorized_keys。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await dialog.getByRole("button", { name: "生成密钥对" }).click();
        await expect(dialog.getByLabel("私钥文件（可选）")).toHaveValue(generatedKeyPath);
        const generated = dialog.locator(".remote-host-pubkey");
        await expect(generated).toContainText("已生成公钥");
        await expect(generated).toContainText("authorized_keys");
        await expect(generated.locator("code").last()).toHaveText(generatedPublicKey);
        await generated.getByRole("button", { name: "复制公钥" }).click();
        await expect(generated.getByRole("button", { name: "已复制" })).toBeVisible();
        await expect(dialog.locator("textarea")).toHaveCount(0);
      },
    );

    await journey.step(
      "密钥路径随登记提交，未知主机密钥在设置内信任",
      "提交时只发送密钥路径而不发送私钥文本；未信任指纹在设置内确认后重试成功，机器卡片继续提供公钥复制入口。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await dialog.getByLabel("Runner 名称", { exact: true }).fill("CPU sandbox");
        await dialog.getByLabel("描述", { exact: true }).fill("CPU preprocessing");
        await dialog.getByLabel("SSH 别名或 IP/主机名").fill("192.168.100.236");
        await dialog.getByLabel("用户名").fill("researcher");
        await dialog.getByLabel("密码（可选）").fill("s3cret");
        await dialog.getByRole("button", { name: "探测并添加" }).click();
        await expect(dialog.getByRole("alert")).toContainText("未知主机密钥");
        await expect(dialog.getByRole("alert")).toContainText("ssh-ed25519 · SHA256:e2e-fingerprint");
        await expect(dialog.getByText(/known_hosts/)).toHaveCount(0);
        await expect(page.locator(".permission-card")).toHaveCount(0);
        await dialog.getByRole("button", { name: "信任并继续" }).click();
        const card = dialog.locator(".remote-host-card", { hasText: "192.168.100.236" });
        await expect(card).toBeVisible();
        expect(lastSshRegisterBody?.username).toBe("researcher");
        expect(lastSshRegisterBody?.password).toBe("s3cret");
        expect(lastSshRegisterBody?.privateKeyPath).toBe(generatedKeyPath);
        expect("privateKey" in (lastSshRegisterBody as unknown as Record<string, unknown>)).toBe(false);
        expect(lastSshRegisterBody?.trustHostKey).toEqual({ algorithm: "ssh-ed25519", fingerprint: "SHA256:e2e-fingerprint" });
        await expect(card.getByRole("button", { name: "复制公钥" })).toBeHidden();
        await card.locator("summary").filter({ hasText: "公钥" }).click();
        await expect(card.getByRole("button", { name: "复制公钥" })).toBeVisible();
        await expect(dialog.getByLabel("密码（可选）")).toHaveCount(0);
      },
    );

    await journey.step(
      "已登记机器可在卡片里更新凭据",
      "SSH 卡片的 Credentials 表单回填用户名但不回显秘密；外层保存会提示先处理该表单。提交后卡片展示用户名、密码/密钥已保存标记，以及立即重探测得到的真实认证错误。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const card = dialog.locator(".remote-host-card", { hasText: "192.168.100.236" });
        await card.getByRole("button", { name: "凭据" }).click();
        await expect(card.getByLabel("用户名")).toHaveValue("researcher");
        await expect(card.getByLabel("密码", { exact: true })).toHaveValue("");
        await expect(card.getByLabel("密码", { exact: true })).toHaveAttribute("placeholder", /保留已保存的密码/);
        await dialog.locator(".system-config-footer").getByRole("button", { name: "保存", exact: true }).click();
        const blockedSaveAlert = dialog.getByRole("alert").filter({ hasText: "保存凭据" });
        await expect(blockedSaveAlert).toBeVisible();
        await expect(card.getByRole("button", { name: "保存凭据" })).toBeVisible();
        await blockedSaveAlert.getByRole("button").click();
        await card.getByLabel("用户名").fill("operator");
        await card.getByLabel("密码", { exact: true }).fill("new-secret");
        await card.getByRole("button", { name: "浏览", exact: true }).click();
        await card.getByRole("button", { name: "science keys 文件夹" }).click();
        await card.getByRole("button", { name: "id_ed25519 选择文件" }).click();
        await expect(card.getByLabel("私钥文件", { exact: true })).toHaveValue("/fixture-keys/science keys/id_ed25519");
        await expect(card.locator("textarea")).toHaveCount(0);
        await card.getByRole("button", { name: "保存凭据" }).click();
        await expect.poll(() => savedCredentials.username).toBe("operator");
        expect(savedCredentials.password).toBe("new-secret");
        expect(savedCredentials.privateKeyPath).toBe("/fixture-keys/science keys/id_ed25519");
        expect("privateKey" in savedCredentials).toBe(false);
        await expect(card.getByLabel("用户名")).toHaveCount(0);
        await expect(card.getByRole("alert")).toHaveText(authenticationError);
        await expect(card.getByRole("alert")).toBeVisible();
        await expect(card.getByRole("alert")).toHaveCSS("white-space", "pre-wrap");
        await expect(card.getByRole("alert")).toHaveCSS("text-overflow", "clip");
        await expect(card.locator(".remote-host-identity")).toContainText("用户 operator");
        await expect(card).toContainText("已存密码 · 已存密钥");
        await expect(card).not.toContainText("cannot deploy: no runner and no Node.js 22+ found");
        await card.scrollIntoViewIfNeeded();
      },
    );

    await journey.step(
      "窄屏仍完整显示 SSH 方法级错误",
      "机器卡片的独立告警保留换行，身份、服务器方法、已尝试方法和凭据状态不被省略或横向裁切。",
      async () => {
        await page.setViewportSize({ width: 640, height: 960 });
        const card = page.getByRole("dialog", { name: "系统设置" }).locator(".remote-host-card", { hasText: "192.168.100.236" });
        const alert = card.getByRole("alert");
        await alert.scrollIntoViewIfNeeded();
        await expect(alert).toHaveText(authenticationError);
        expect(await alert.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        for (const button of await card.locator(".remote-host-actions > button").all()) {
          expect(await button.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        }
      },
    );

    await journey.step(
      "登记一台自行部署的 runner",
      "点 Add self-deployed runner 才出现表单；填写名称、IP、端口和 token 并提交后，表单收起，列表出现该 runner 并标注 self-deployed 与 token authenticated。",
      async () => {
        await page.setViewportSize({ width: 1440, height: 900 });
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        // Dismiss the acknowledged error from the preceding SSH scenario.
        const priorError = dialog.getByRole("alert").filter({ hasText: "SSH authentication failed" }).filter({ has: page.getByRole("button") });
        if (await priorError.count()) await priorError.getByRole("button").click();
        await dialog.getByRole("button", { name: "添加 Runner", exact: true }).click();
        await dialog.getByLabel("连接方式", { exact: true }).selectOption("direct");
        await dialog.getByLabel("名称", { exact: true }).fill("lab-workstation");
        await dialog.getByLabel("描述", { exact: true }).fill("Self-deployed CPU sandbox");
        await dialog.getByLabel("IP 地址或主机名").fill("192.168.1.20");
        await dialog.getByLabel(/^端口$/).fill("4311");
        await dialog.getByLabel("Token", { exact: true }).fill("e2e-mock-token");
        await dialog.getByRole("button", { name: "连接并添加" }).click();
        await expect(dialog.getByText("Runner ID：e2e-direct-runner", { exact: true })).toBeVisible();
        await expect(dialog.getByText("Self-deployed CPU sandbox", { exact: true })).toBeVisible();
        await expect(dialog.getByText("自部署 · 直连", { exact: true })).toBeVisible();
        const directCard = dialog.locator(".remote-host-card", { hasText: "e2e-direct-runner" });
        await expect(directCard.locator(".remote-host-identity")).toContainText("192.168.1.20:4311");
        await expect(directCard.locator(".remote-host-identity")).toContainText("Token 认证");
        await expect(dialog.getByLabel("Token", { exact: true })).toHaveCount(0);
        await dialog.locator(".remote-host-card", { hasText: "e2e-direct-runner" }).scrollIntoViewIfNeeded();
      },
    );

    await journey.step(
      "Project 设置里维护允许名单",
      "允许名单在 Project 自己的设置里：复选框与机器名在同一阅读行；勾选后该 Project 允许这台机器。",
      async () => {
        await page.getByRole("dialog", { name: "系统设置" }).locator(".system-config-footer").getByRole("button", { name: "取消并关闭" }).click();
        const dialog = await openProjectSettings();
        await expect(dialog.getByText("Runner", { exact: true })).toBeVisible();
        const allowedHost = dialog.getByRole("checkbox", { name: /institution-linux/ });
        await allowedHost.click();
        await expect.poll(() => project.remoteRunnerHostIds).toEqual([hostId]);
        await expect(allowedHost).toBeChecked();
        // Checkbox and machine name share one reading line.
        const label = dialog.locator(".settings-choices label", { hasText: "institution-linux" });
        const box = await allowedHost.boundingBox();
        const textBox = await label.locator("span").first().boundingBox();
        if (!box || !textBox) throw new Error("Allowlist row has no layout box");
        expect(Math.abs((box.y + box.height / 2) - (textBox.y + textBox.height / 2))).toBeLessThan(6);
        const save = dialog.locator('button[type="submit"]');
        const remoteBox = await dialog.locator(".scoped-remote-settings").boundingBox();
        const saveBox = await save.boundingBox();
        expect(saveBox!.y).toBeGreaterThanOrEqual(remoteBox!.y + remoteBox!.height);
        await save.scrollIntoViewIfNeeded();
      },
    );

    await journey.step(
      "Session 设置里覆盖允许名单",
      "Session 可独立选择 Project 未选的机器，或清空/恢复默认；全部设置之后才是保存按钮。",
      async () => {
        await page.getByRole("dialog", { name: "项目设置" }).getByRole("button", { name: "关闭作用域设置" }).click();
        const dialog = await openSessionSettings();
        const mode = dialog.getByRole("combobox", { name: "允许的远程 Runner" });
        await expect(mode).toHaveValue("inherit");
        await expect(dialog.getByRole("combobox", { exact: true, name: "Runner" })).toHaveCount(0);
        await mode.selectOption("override");
        await expect.poll(() => session.remoteRunnerHostIds).toEqual([hostId]);
        const hostToggle = dialog.getByRole("checkbox", { name: /institution-linux/ });
        await expect(hostToggle).toBeChecked();
        const independentHost = dialog.getByRole("checkbox", { name: /lab-workstation/ });
        await independentHost.click();
        await expect.poll(() => session.remoteRunnerHostIds).toEqual([hostId, "e2e-direct-runner"]);
        expect(project.remoteRunnerHostIds).toEqual([hostId]);
        await independentHost.click();
        // Narrow to nothing: this Session forbids every remote machine.
        await hostToggle.click();
        await expect.poll(() => session.remoteRunnerHostIds).toEqual([]);
        // Back to inheriting the Project allowlist.
        await mode.selectOption("inherit");
        await expect.poll(() => session.remoteRunnerHostIds ?? null).toBeNull();
        // Leave the independent selection visible in this step's evidence.
        await mode.selectOption("override");
        await independentHost.click();
        await expect.poll(() => session.remoteRunnerHostIds).toEqual([hostId, "e2e-direct-runner"]);
        const saveBox = await dialog.locator('button[type="submit"]').boundingBox();
        const remoteBox = await dialog.locator(".scoped-remote-settings").boundingBox();
        expect(saveBox!.y).toBeGreaterThanOrEqual(remoteBox!.y + remoteBox!.height);
        await dialog.locator('button[type="submit"]').scrollIntoViewIfNeeded();
      },
    );

    await journey.step(
      "Session 只保留选机，工作区管理移到全局设置",
      "Session 设置不再展示工作区删除控件；全局设置按 Runner 展示 Project/Session 工作区及只读同步记录。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "会话设置" });
        await dialog.getByRole("combobox", { name: "允许的远程 Runner" }).selectOption("inherit");
        await expect(dialog.getByRole("button", { name: "删除远程工作区" })).toHaveCount(0);
        await dialog.getByRole("button", { name: "关闭作用域设置" }).click();
        const settings = await openRemoteSettings();
        await settings.getByRole("navigation", { name: "设置分组" }).getByRole("button", { name: /^环境/ }).click();
        await settings.getByRole("combobox", { name: "管理 Runner" }).selectOption(hostId);
        await settings.getByRole("button", { name: "工作区", exact: true }).click();
        await expect(settings.getByText("远程工作区", { exact: true })).toBeVisible();
        await settings.getByText("传输历史 · 1").click();
        await expect(settings.getByText(/主 Agent · pull · completed · 1 个文件 · results\/report\.md/)).toBeVisible();
        await expect(settings.getByRole("button", { name: /Push|Pull/ })).toHaveCount(0);
      },
    );

    await journey.step(
      "会话栏徽章完整显示「远端可用」",
      "徽章完整可读、不被截断，文案表示这个 Session 可以使用远端机，而不是固定在某一台上。",
      async () => {
        await page.getByRole("dialog", { name: "系统设置" }).locator(".system-config-footer").getByRole("button", { name: "取消并关闭" }).click();
        const badge = page.locator(".session-runner-target");
        await expect(badge).toHaveText("可用远程");
        await expect(badge).toHaveAttribute("title", /本地 Runner 始终可用/);
        await expect(page.locator('[title="Fixed Session execution target"]')).toHaveCount(0);
        const clipped = await badge.evaluate((element) => element.scrollWidth > element.clientWidth + 1);
        expect(clipped).toBe(false);
      },
    );

    await journey.step(
      "连接后查看 Runner 版本和资源使用量",
      "状态变为 connected，详情顶部显示更新时间，紧凑容量条展示磁盘已用 40/100 GiB（40%）、内存已用 48/128 GiB（37.5%），版本和 CPU 读数不重复。",
      async () => {
        const dialog = await openRemoteSettings();
        await dialog.getByRole("button", { name: "连接 Runner" }).first().click();
        await expect(dialog.getByText("已连接", { exact: true })).toBeVisible();
        await expect(dialog.getByText(
          /版本 0\.0\.0-remote · 本地 0\.0\.0-local/,
        )).toBeVisible();
        const resources = dialog.locator(".remote-host-card", { hasText: hostId }).getByLabel("Runner 资源");
        await expect(resources).toContainText("40.0 GiB / 100.0 GiB");
        await expect(resources).toContainText("/data/sciencediscovery/remote-workspaces");
        await expect(resources).toContainText("48.0 GiB / 128.0 GiB");
        await expect(resources.getByRole("meter", { name: "磁盘已用" })).toHaveAttribute("aria-valuenow", "40");
        await expect(resources.getByRole("meter", { name: "内存已用" })).toHaveAttribute("aria-valuenow", "37.5");
        await expect(dialog.getByText("SSH 隧道", { exact: true }).first()).toBeVisible();
        const card = resources.locator("xpath=ancestor::article");
        await expect(card.locator(".remote-host-disclosure > summary").first()).toContainText("更新于");
        await expect(card.getByText("版本不一致", { exact: true })).toBeVisible();
        await expect(card).not.toContainText("Filesystem free space");
        await expect(card).not.toContainText("reclaimable caches");
        await expect(card).not.toContainText("Load is a queue average");
        await expect(card).not.toContainText("SEA runner deployed automatically");
        await expect(card.getByLabel("Runner 连接")).not.toContainText("GiB");
        await resources.scrollIntoViewIfNeeded();
      },
    );

    await journey.step(
      "窄窗口下机器操作仍同行等宽",
      "缩窄窗口后，机器卡片不产生横向溢出，Disconnect、Refresh、Credentials、Delete 仍在同一操作组中同行等宽。",
      async () => {
        await page.setViewportSize({ width: 900, height: 1000 });
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const actions = dialog.locator(".remote-host-card", { hasText: hostId }).locator(".remote-host-actions").first();
        const boxes = await Promise.all(["检查连接", "刷新资源", "凭据", "删除"].map(async (name) => {
          const button = actions.getByRole("button", { name });
          await expect(button).toBeVisible();
          return button.boundingBox();
        }));
        if (boxes.some((box) => !box)) throw new Error("Narrow action buttons have no layout box");
        const [first, ...rest] = boxes as NonNullable<(typeof boxes)[number]>[];
        for (const box of rest) {
          expect(Math.abs(box.y - first!.y)).toBeLessThan(2);
          expect(Math.abs(box.width - first!.width)).toBeLessThan(2);
        }
        expect(await dialog.evaluate((element) => element.scrollWidth > element.clientWidth + 1)).toBe(false);
        const card = dialog.locator(".remote-host-list .remote-host-card", { hasText: hostId });
        const identityBox = await card.locator(".remote-host-card-main").boundingBox();
        const detailsBox = await card.locator(".remote-host-card-details").boundingBox();
        // The card header is a flex-wrap row: at this viewport the identity block
        // and the action group can share one row, and when the card narrows further
        // the actions wrap below the identity. Either placement must keep the two
        // card zones from overlapping, and the details must come after both.
        const actionsBeside = first!.x >= identityBox!.x + identityBox!.width - 1;
        const actionsBelow = first!.y >= identityBox!.y + identityBox!.height - 1;
        expect(actionsBeside || actionsBelow).toBe(true);
        expect(detailsBox!.y).toBeGreaterThanOrEqual(first!.y + first!.height);
        await expect(dialog.locator(".remote-host-card", { hasText: hostId }).getByLabel("Runner 资源")).toContainText("40.0 GiB / 100.0 GiB");
        await card.scrollIntoViewIfNeeded();
      },
    );
    await journey.step(
      "收起机器详情保留身份操作和更新时间",
      "点击 Machine details 后，两栏详情一起收起；机器身份、连接操作和更新时间仍可见。",
      async () => {
        const card = page.locator(".remote-host-list .remote-host-card", { hasText: hostId });
        await card.locator(".remote-host-disclosure > summary").first().click();
        await expect(card.getByLabel("Runner 资源")).toBeHidden();
        await expect(card.getByLabel("Runner 连接")).toBeHidden();
        await expect(card.getByRole("button", { name: "断开连接", exact: true })).toBeVisible();
        await expect(card.locator(".remote-host-disclosure > summary").first()).toContainText("更新于");
      },
    );
    await journey.step(
      "键盘展开紧凑详情",
      "用键盘重新展开后，容量标题和数值同行，左右信息不重复，磁盘与内存条恢复可见。",
      async () => {
        const card = page.locator(".remote-host-list .remote-host-card", { hasText: hostId });
        await card.locator(".remote-host-disclosure > summary").first().focus();
        await page.keyboard.press("Enter");
        await expect(card.getByRole("meter", { name: "磁盘已用" })).toBeVisible();
        await expect(card.getByRole("meter", { name: "内存已用" })).toBeVisible();
        for (const row of await card.locator(".remote-resource-meter-label").all()) {
          const label = await row.locator("span").boundingBox();
          const value = await row.locator("strong").boundingBox();
          expect(Math.abs(label!.y - value!.y)).toBeLessThan(2);
        }
        await card.scrollIntoViewIfNeeded();
      },
    );
    await journey.step("窄窗口 Project 保存位于末尾", "窄窗口中远程默认机器列表完整可读，保存位于列表下方且无横向溢出。", async () => {
      await page.getByRole("dialog", { name: "系统设置" }).locator(".system-config-footer").getByRole("button", { name: "取消并关闭" }).click();
      await page.setViewportSize({ width: 640, height: 960 });
      const dialog = await openProjectSettings();
      const save = dialog.locator('button[type="submit"]');
      await save.scrollIntoViewIfNeeded();
      const saveBox = await save.boundingBox();
      const remoteBox = await dialog.locator(".scoped-remote-settings").boundingBox();
      expect(saveBox!.y).toBeGreaterThanOrEqual(remoteBox!.y + remoteBox!.height);
      expect(await dialog.evaluate((element) => element.scrollWidth > element.clientWidth + 1)).toBe(false);
    });
    await journey.step("按 Runner 管理 Python 和 R 环境", "科学环境页明确所选 Runner，能看到远端 Python base 并在同一个 Runner 创建 R 环境。", async () => {
      await page.getByRole("dialog", { name: "项目设置" }).getByRole("button", { name: "关闭作用域设置" }).click();
      await page.setViewportSize({ width: 1440, height: 1000 });
      const dialog = await openRemoteSettings();
      await dialog.getByRole("navigation", { name: "设置分组" }).getByRole("button", { name: /^环境/ }).click();
      await dialog.getByRole("combobox", { name: "管理 Runner" }).selectOption(hostId);
      await expect(dialog.getByText("Remote Python base", { exact: true })).toBeVisible();
      await expect(dialog.getByRole("textbox", { name: "环境名称" })).toHaveCount(0);
      await dialog.getByRole("button", { name: "新增环境" }).click();
      await dialog.getByRole("combobox", { name: "环境初始工具" }).selectOption("r");
      await dialog.getByRole("textbox", { name: "环境名称" }).fill("Remote R analysis");
      await dialog.getByRole("button", { name: "创建", exact: true }).click();
      await expect(dialog.getByText("Remote R analysis", { exact: true })).toBeVisible();
      await expect(dialog.getByRole("textbox", { name: "环境名称" })).toHaveCount(0);
      await expect(dialog.getByRole("combobox", { name: "Remote R analysis 的包管理器" }).locator("option")).toHaveText(["conda", "pip", "CRAN", "Bioconductor"]);
    });
    await journey.step("窄窗口集中清理远端工作区", "工作区按 Project/Session 展示；取消删除不发请求，确认后显示清理结果，记录保留。", async () => {
      await page.setViewportSize({ width: 640, height: 960 });
      const dialog = page.getByRole("dialog", { name: "系统设置" });
      await dialog.getByRole("button", { name: "工作区", exact: true }).click();
      const remove = dialog.getByRole("button", { name: "删除远程工作区" });
      page.once("dialog", (prompt) => prompt.dismiss());
      await remove.click();
      expect(deletedWorkspace).toBe(false);
      page.once("dialog", (prompt) => prompt.accept());
      await remove.click();
      await expect(dialog.getByText("工作区已删除。后续执行会重新创建该位置。")).toBeVisible();
      expect(deletedWorkspace).toBe(true);
      await dialog.getByText("传输历史 · 1").click();
      expect(await dialog.evaluate((element) => element.scrollWidth > element.clientWidth + 1)).toBe(false);
    });
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await cleanupJourney(page, fixture);
  }
});
