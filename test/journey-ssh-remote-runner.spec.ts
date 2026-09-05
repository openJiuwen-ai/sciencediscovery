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
 *   1. 打开远程计算设置：默认只有机器列表和两个添加按钮，没有常驻表单；SSH 表单接受别名或 IP/hostname，端口可省略。
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
    goal: "一位用户把一台远程 Linux runner 登记进机器目录，在 Project 里允许它，并在一个 Session 里收窄或恢复继承；允许远端不等于锁死本机执行。",
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
    } : { hostId, state: "disconnected" },
    status: "ready",
    updatedAt: new Date().toISOString(),
  });

  await page.route("**/api/remote-hosts", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        json: [sshHost(), ...(registeredSshHost ? [registeredSshHost] : []), ...(directHost ? [directHost] : [])],
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
  await page.route(`**/api/remote-hosts/${hostId}/runner/*`, async (route) => {
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
    return route.fulfill({ json: project });
  });
  await page.route(`**/api/sessions/${fixture.session.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const body = route.request().postDataJSON() as { remoteRunnerHostIds?: string[] | null };
    if ("remoteRunnerHostIds" in body) {
      if (body.remoteRunnerHostIds === null) delete session.remoteRunnerHostIds;
      else session = { ...session, remoteRunnerHostIds: body.remoteRunnerHostIds };
    }
    return route.fulfill({ json: session });
  });
  await page.route(`**/api/sessions/${fixture.session.id}/remote-workspace/sync-records`, (route) =>
    route.fulfill({ json: syncRecords }));

  /** The global Remote compute group inside the system settings dialog. */
  const openRemoteSettings = async () => {
    const dialog = page.getByRole("dialog", { name: "系统设置" });
    if (!await dialog.isVisible()) await page.getByRole("button", { name: /^系统设置/ }).click();
    await dialog.getByRole("navigation", { name: "设置分组" })
      .getByRole("button", { name: /^远程计算/ })
      .click();
    return dialog;
  };
  const openProjectSettings = async () => {
    await page.goto(`/projects/${encodeURIComponent(fixture.project.id)}/settings`);
    return page.getByRole("dialog", { name: "project settings" });
  };
  const openSessionSettings = async () => {
    await page.goto(`/projects/${encodeURIComponent(fixture.project.id)}/sessions/${encodeURIComponent(fixture.session.id)}/settings`);
    return page.getByRole("dialog", { name: "session settings" });
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
        await expect(dialog.getByRole("button", { name: "Add SSH machine" })).toBeVisible();
        await expect(dialog.getByRole("button", { name: "Add self-deployed runner" })).toBeVisible();
        await expect(dialog.getByText("Runner ID: local", { exact: true })).toBeVisible();
        await expect(dialog.getByText(`Runner ID: ${hostId}`, { exact: true })).toBeVisible();
        await expect(dialog.getByText("Python and R analysis on the lab GPU", { exact: true })).toBeVisible();
        // No blank form competes with the list, and no scoped controls live here.
        await expect(dialog.getByLabel("SSH alias or IP/hostname")).toHaveCount(0);
        await expect(dialog.getByLabel("Token", { exact: true })).toHaveCount(0);
        await expect(dialog.getByRole("checkbox", { name: /institution-linux/ })).toHaveCount(0);
        await expect(dialog.getByRole("combobox", { exact: true, name: "Runner" })).toHaveCount(0);
        await expect(dialog.getByRole("combobox", { name: "Allowed remote runners" })).toHaveCount(0);
        await expect(dialog.getByText(/one-shot job card remains a separate feature/)).toHaveCount(0);
        await expect(dialog.getByText(/All Shell\/Python\/R commands execute through sandboxed Runners/)).toBeVisible();
      },
    );

    await journey.step(
      "主机卡片操作同组同行且等宽",
      "Connect runner、Refresh probe、Delete 在同一操作组、同一行，宽度一致；Delete 不单独占一行。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const actions = dialog.locator(".remote-host-card .remote-host-actions").first();
        const names = ["Connect runner", "Refresh probe", "Delete"];
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
      },
    );

    await journey.step(
      "SSH 凭据只有本机密钥路径，没有私钥粘贴框",
      "点 Add SSH machine 才出现表单；凭据默认收起，展开后可填用户名、密码和本机私钥路径，页面没有任何私钥文本粘贴入口。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await dialog.getByRole("button", { name: "Add SSH machine" }).click();
        await expect(dialog.getByLabel("SSH alias or IP/hostname")).toBeVisible();
        await expect(dialog.getByLabel("Port (optional)")).toBeVisible();
        await expect(dialog.getByText(/alias from your SSH config or a plain IP\/hostname/)).toBeVisible();
        await expect(dialog.getByLabel("Password (optional)")).toHaveCount(0);
        await dialog.getByRole("button", { name: "Credentials (optional)" }).click();
        await expect(dialog.getByLabel("Private key file (optional)")).toBeVisible();
        await expect(dialog.getByRole("textbox", { name: /private key/i })).toHaveCount(1);
        await expect(dialog.locator("textarea")).toHaveCount(0);
        await expect(dialog.getByText(/Paste an SSH private key/)).toHaveCount(0);
      },
    );

    await journey.step(
      "ssh_config 先展示可导入的 Host 列表",
      "点 Import from ssh_config 后出现已有 Host 列表，可先看别名、目标地址、端口和用户，再选择要导入的一台。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await dialog.getByRole("button", { name: "Import from ssh_config" }).click();
        const list = dialog.locator(".remote-host-import-list");
        await expect(list.getByRole("button", { name: /institution-linux/ })).toBeVisible();
        await expect(list.getByRole("button", { name: /gpu-lab/ })).toContainText("gpu.institution.edu · port 2200 · scientist");
      },
    );

    await journey.step(
      "点选 ssh_config 条目后仍可编辑",
      "选择 gpu-lab 后，单条配置的别名、端口、用户和密钥路径进入普通表单；用户可继续修改这些值。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await dialog.locator(".remote-host-import-list").getByRole("button", { name: /gpu-lab/ }).click();
        await expect(dialog.getByText(/Imported gpu-lab from ssh_config/)).toBeVisible();
        await expect(dialog.getByLabel("SSH alias or IP/hostname")).toHaveValue("gpu.institution.edu");
        await expect(dialog.getByLabel("Private key file (optional)")).toHaveValue("~/.ssh/id_ed25519");
        await dialog.getByLabel("SSH alias or IP/hostname").fill("gpu-lab-custom");
        await dialog.getByLabel("Port (optional)").fill("2299");
        await dialog.getByLabel("Username").fill("operator");
        await expect(dialog.getByLabel("SSH alias or IP/hostname")).toHaveValue("gpu-lab-custom");
        await expect(dialog.getByLabel("Port (optional)")).toHaveValue("2299");
        await expect(dialog.getByLabel("Username")).toHaveValue("operator");
      },
    );

    await journey.step(
      "生成密钥后只展示可复制公钥",
      "点 Generate a key pair 后，密钥路径自动填入；页面只展示一行可复制公钥，并明确提示把它加入远端 authorized_keys。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await dialog.getByRole("button", { name: "Generate a key pair" }).click();
        await expect(dialog.getByLabel("Private key file (optional)")).toHaveValue(generatedKeyPath);
        const generated = dialog.locator(".remote-host-pubkey");
        await expect(generated).toContainText("Public key generated");
        await expect(generated).toContainText("authorized_keys");
        await expect(generated.locator("code").last()).toHaveText(generatedPublicKey);
        await generated.getByRole("button", { name: "Copy public key" }).click();
        await expect(generated.getByRole("button", { name: "Copied" })).toBeVisible();
        await expect(dialog.locator("textarea")).toHaveCount(0);
      },
    );

    await journey.step(
      "密钥路径随登记提交，未知主机密钥在设置内信任",
      "提交时只发送密钥路径而不发送私钥文本；未信任指纹在设置内确认后重试成功，机器卡片继续提供公钥复制入口。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        await dialog.getByLabel("Runner name", { exact: true }).fill("CPU sandbox");
        await dialog.getByLabel("Description", { exact: true }).fill("CPU preprocessing");
        await dialog.getByLabel("SSH alias or IP/hostname").fill("192.168.100.236");
        await dialog.getByLabel("Username").fill("researcher");
        await dialog.getByLabel("Password (optional)").fill("s3cret");
        await dialog.getByRole("button", { name: "Probe and add" }).click();
        await expect(dialog.getByRole("alert")).toContainText("Unknown host key");
        await expect(dialog.getByRole("alert")).toContainText("ssh-ed25519 · SHA256:e2e-fingerprint");
        await expect(dialog.getByText(/known_hosts/)).toHaveCount(0);
        await expect(page.locator(".permission-card")).toHaveCount(0);
        await dialog.getByRole("button", { name: "Trust and continue" }).click();
        const card = dialog.locator(".remote-host-card", { hasText: "192.168.100.236" });
        await expect(card).toBeVisible();
        expect(lastSshRegisterBody?.username).toBe("researcher");
        expect(lastSshRegisterBody?.password).toBe("s3cret");
        expect(lastSshRegisterBody?.privateKeyPath).toBe(generatedKeyPath);
        expect("privateKey" in (lastSshRegisterBody as unknown as Record<string, unknown>)).toBe(false);
        expect(lastSshRegisterBody?.trustHostKey).toEqual({ algorithm: "ssh-ed25519", fingerprint: "SHA256:e2e-fingerprint" });
        await expect(card.getByRole("button", { name: "Copy public key" })).toBeVisible();
        await expect(dialog.getByLabel("Password (optional)")).toHaveCount(0);
      },
    );

    await journey.step(
      "已登记机器可在卡片里更新凭据",
      "SSH 卡片的 Credentials 表单回填用户名但不回显秘密；外层保存会提示先处理该表单。提交后卡片展示用户名、密码/密钥已保存标记，以及立即重探测得到的真实认证错误。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const card = dialog.locator(".remote-host-card", { hasText: "192.168.100.236" });
        await card.getByRole("button", { name: "Credentials" }).click();
        await expect(card.getByLabel("Username")).toHaveValue("researcher");
        await expect(card.getByLabel("Password", { exact: true })).toHaveValue("");
        await expect(card.getByLabel("Password", { exact: true })).toHaveAttribute("placeholder", /keep the stored one/);
        await dialog.locator(".system-config-footer").getByRole("button", { name: "保存", exact: true }).click();
        const blockedSaveAlert = dialog.getByRole("alert").filter({ hasText: "Save credentials" });
        await expect(blockedSaveAlert).toBeVisible();
        await expect(card.getByRole("button", { name: "Save credentials" })).toBeVisible();
        await blockedSaveAlert.getByRole("button").click();
        await card.getByLabel("Username").fill("operator");
        await card.getByLabel("Password", { exact: true }).fill("new-secret");
        await card.getByLabel("Private key file", { exact: true }).fill("~/.ssh/updated_ed25519");
        await expect(card.locator("textarea")).toHaveCount(0);
        await card.getByRole("button", { name: "Save credentials" }).click();
        await expect.poll(() => savedCredentials.username).toBe("operator");
        expect(savedCredentials.password).toBe("new-secret");
        expect(savedCredentials.privateKeyPath).toBe("~/.ssh/updated_ed25519");
        expect("privateKey" in savedCredentials).toBe(false);
        await expect(card.getByLabel("Username")).toHaveCount(0);
        await expect(card.getByRole("alert")).toHaveText(authenticationError);
        await expect(card.getByRole("alert")).toBeVisible();
        await expect(card.getByRole("alert")).toHaveCSS("white-space", "pre-wrap");
        await expect(card.getByRole("alert")).toHaveCSS("text-overflow", "clip");
        await expect(card).toContainText("user operator · password stored · key stored");
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
        await dialog.getByRole("button", { name: "Add self-deployed runner" }).click();
        await dialog.getByLabel("Name", { exact: true }).fill("lab-workstation");
        await dialog.getByLabel("Description", { exact: true }).fill("Self-deployed CPU sandbox");
        await dialog.getByLabel("IP address or hostname").fill("192.168.1.20");
        await dialog.getByLabel(/^Port$/).fill("4311");
        await dialog.getByLabel("Token", { exact: true }).fill("e2e-mock-token");
        await dialog.getByRole("button", { name: "Connect and add" }).click();
        await expect(dialog.getByText("Runner ID: e2e-direct-runner", { exact: true })).toBeVisible();
        await expect(dialog.getByText("Self-deployed CPU sandbox", { exact: true })).toBeVisible();
        await expect(dialog.getByText(/self-deployed · http:\/\/192\.168\.1\.20:4311 · token authenticated/)).toBeVisible();
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
        await expect(dialog.getByText("Remote compute", { exact: true })).toBeVisible();
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
        await dialog.getByRole("button", { name: "Close scoped settings" }).click();
      },
    );

    await journey.step(
      "Session 设置里覆盖允许名单",
      "Session 继承 Project 名单，可收窄到子集或全部禁用，也可恢复继承；没有互斥的 Execution runner 下拉。",
      async () => {
        const dialog = await openSessionSettings();
        const mode = dialog.getByRole("combobox", { name: "Allowed remote runners" });
        await expect(mode).toHaveValue("inherit");
        await expect(dialog.getByRole("combobox", { exact: true, name: "Runner" })).toHaveCount(0);
        await mode.selectOption("override");
        await expect.poll(() => session.remoteRunnerHostIds).toEqual([hostId]);
        const hostToggle = dialog.getByRole("checkbox", { name: /institution-linux/ });
        await expect(hostToggle).toBeChecked();
        // Narrow to nothing: this Session forbids every remote machine.
        await hostToggle.click();
        await expect.poll(() => session.remoteRunnerHostIds).toEqual([]);
        // Back to inheriting the Project allowlist.
        await mode.selectOption("inherit");
        await expect.poll(() => session.remoteRunnerHostIds ?? null).toBeNull();
      },
    );

    await journey.step(
      "远端 workspace 只读记录在 Session 设置里",
      "同步记录只读展示，没有路径输入、Push 或 Pull 控件；删除远端 workspace 仍需用户显式确认。",
      async () => {
        const dialog = page.getByRole("dialog", { name: "session settings" });
        await expect(dialog.getByText("Remote workspace", { exact: true })).toBeVisible();
        await expect(dialog.getByText(/Only the model transfers files/)).toBeVisible();
        await expect(dialog.getByText(/pull · completed · 1 files · 64 bytes · results\/report\.md/)).toBeVisible();
        await expect(dialog.getByLabel(/Paths/)).toHaveCount(0);
        await expect(dialog.getByRole("button", { name: /Push|Pull/ })).toHaveCount(0);
        await expect(dialog.getByRole("button", { name: "Delete remote workspace" })).toBeVisible();
        await dialog.getByRole("button", { name: "Close scoped settings" }).click();
      },
    );

    await journey.step(
      "会话栏徽章完整显示「远端可用」",
      "徽章完整可读、不被截断，文案表示这个 Session 可以使用远端机，而不是固定在某一台上。",
      async () => {
        const badge = page.locator(".session-runner-target");
        await expect(badge).toHaveText("Remote available");
        await expect(badge).toHaveAttribute("title", /Local runner stays available/);
        await expect(page.locator('[title="Fixed Session execution target"]')).toHaveCount(0);
        const clipped = await badge.evaluate((element) => element.scrollWidth > element.clientWidth + 1);
        expect(clipped).toBe(false);
      },
    );

    await journey.step(
      "连接后说明是自动部署并提示版本差异",
      "状态变为 connected，页面同时展示本地和远端版本、version differs 以及 deployed by ScienceDiscovery。",
      async () => {
        const dialog = await openRemoteSettings();
        await dialog.getByRole("button", { name: "Connect runner" }).first().click();
        await expect(dialog.getByText("connected", { exact: true })).toBeVisible();
        await expect(dialog.getByText(
          /Remote 0\.0\.0-remote · local 0\.0\.0-local · version differs · deployed by ScienceDiscovery/,
        )).toBeVisible();
      },
    );

    await journey.step(
      "窄窗口下机器操作仍同行等宽",
      "缩窄窗口后，机器卡片不产生横向溢出，Disconnect、Refresh、Credentials、Delete 仍在同一操作组中同行等宽。",
      async () => {
        await page.setViewportSize({ width: 900, height: 720 });
        const dialog = page.getByRole("dialog", { name: "系统设置" });
        const actions = dialog.locator(".remote-host-card .remote-host-actions").first();
        const boxes = await Promise.all(["Disconnect", "Refresh probe", "Credentials", "Delete"].map(async (name) => {
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
      },
    );
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await cleanupJourney(page, fixture);
  }
});
