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
 * 设置 › 远程 as a set of multi-step flows.
 *
 * Registration probes before it answers, a connect streams a log while it runs,
 * and an untrusted host key is a question rather than a failure. Each of those
 * is a sequence of two or three requests whose intermediate states are what the
 * operator acts on, so the cases here drive the controls and then read what was
 * actually sent.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  DEFAULT_PROJECT,
  TOKEN,
  TOKEN_STORAGE_KEY,
  installMockApi,
  makeSession,
  type JsonRecord,
  type Mock,
} from "./fixtures.js";

const GIB = 1024 ** 3;

function runner(over: JsonRecord = {}): JsonRecord {
  return {
    alias: "gpu-01",
    capabilities: { platform: "Linux" },
    connectionKind: "ssh",
    createdAt: "2026-10-01T08:00:00.000Z",
    hasPrivateKey: true,
    id: "runner-1",
    runnerCommand: "sciencediscovery-runner",
    runnerStatus: { hostId: "runner-1", state: "disconnected" },
    status: "ready",
    updatedAt: "2026-10-01T08:00:00.000Z",
    ...over,
  };
}

function localRunner(over: JsonRecord = {}): JsonRecord {
  return {
    alias: "local",
    connectionKind: "direct",
    createdAt: "2026-10-01T08:00:00.000Z",
    id: "local",
    runnerCommand: "sciencediscovery-runner",
    status: "ready",
    updatedAt: "2026-10-01T08:00:00.000Z",
    ...over,
  };
}

function resources(over: JsonRecord = {}): JsonRecord {
  return {
    capturedAt: "2026-10-01T09:30:00.000Z",
    cpuCores: 64,
    loadAverage1m: 1.25,
    memoryFreeBytes: 16 * GIB,
    memoryTotalBytes: 64 * GIB,
    uptimeSeconds: 3600,
    workspaceDisk: { availableBytes: 90 * GIB, path: "/data/workspace", totalBytes: 100 * GIB },
    ...over,
  };
}

function npuInventory(): JsonRecord {
  return {
    capturedAt: "2026-10-01T09:30:00.000Z",
    devices: [
      { chipName: "910B3", health: "OK", hostIndex: 0, sandboxUsable: true },
      { chipName: "910B3", health: "OK", hostIndex: 1, sandboxUsable: true },
    ],
    supported: true,
  };
}

async function openRemote(page: Page): Promise<Locator> {
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "远程", exact: true }).click();
  return dialog;
}

function calls(mock: Mock, method: string, path: string): JsonRecord[] {
  return mock.calls
    .filter((entry) => entry.method === method && entry.path === path)
    .map((entry) => (entry.body === undefined ? {} : JSON.parse(entry.body) as JsonRecord));
}

function card(dialog: Locator, name: string): Locator {
  return dialog.locator(".settings-card.is-machine").filter({ hasText: name });
}

/** The key file is a path field with a browse button beside it, not a `label`
 *  wrapping its input, so it is found by the field it belongs to. */
function keyField(scope: Locator): Locator {
  return scope.locator(".machine-field").filter({ hasText: "私钥文件" }).getByRole("textbox");
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [TOKEN_STORAGE_KEY, TOKEN] as const,
  );
});

test.describe("登记", () => {
  test("an SSH machine is registered with its port, login and executable", async ({ page }) => {
    const mock = await installMockApi(page);
    const dialog = await openRemote(page);

    await dialog.getByRole("button", { name: "新增远端 Runner" }).click();
    const form = dialog.locator(".settings-card.is-form");
    await form.getByLabel("SSH 别名或 IP/主机名").fill("gpu-01");
    await form.getByLabel("SSH 端口").fill("2222");
    await form.getByLabel("登录用户").fill("alice");
    await form.getByLabel("登录密码").fill("s3cret");
    await form.getByRole("button", { name: "登记并测试" }).click();

    await expect(card(dialog, "gpu-01")).toBeVisible();
    await expect(card(dialog, "gpu-01")).toContainText("未连接");
    const [body] = calls(mock, "POST", "/api/remote-hosts");
    expect(body).toMatchObject({
      alias: "gpu-01",
      connectionKind: "ssh",
      password: "s3cret",
      port: 2222,
      runnerCommand: "sciencediscovery-runner",
      username: "alice",
    });
    // The form is closed once the machine is stored.
    await expect(form).toHaveCount(0);
  });

  test("a self-deployed Runner is registered with its endpoint and token", async ({ page }) => {
    const mock = await installMockApi(page);
    const dialog = await openRemote(page);

    await dialog.getByRole("button", { name: "新增远端 Runner" }).click();
    const form = dialog.locator(".settings-card.is-form");
    await form.getByRole("button", { name: "自部署", exact: true }).click();
    await form.getByLabel("SSH 别名或 IP/主机名").fill("lab-box");
    await form.getByLabel("地址").fill("10.0.0.9");
    await form.getByLabel("端口").fill("4400");
    await form.getByLabel("访问令牌").fill("runner-token");
    await form.getByRole("button", { name: "登记并连接" }).click();

    await expect(card(dialog, "lab-box")).toBeVisible();
    const [body] = calls(mock, "POST", "/api/remote-hosts");
    expect(body).toMatchObject({
      alias: "lab-box",
      connectionKind: "direct",
      endpoint: { host: "10.0.0.9", port: 4400, protocol: "http" },
      token: "runner-token",
    });
  });

  test("an incomplete form cannot be registered", async ({ page }) => {
    await installMockApi(page);
    const dialog = await openRemote(page);

    await dialog.getByRole("button", { name: "新增远端 Runner" }).click();
    const form = dialog.locator(".settings-card.is-form");
    await expect(form.getByRole("button", { name: "登记并测试" })).toBeDisabled();

    await form.getByLabel("SSH 别名或 IP/主机名").fill("gpu-01");
    await expect(form.getByRole("button", { name: "登记并测试" })).toBeEnabled();

    // A direct machine needs an address and a token as well as a name.
    await form.getByRole("button", { name: "自部署", exact: true }).click();
    await expect(form.getByRole("button", { name: "登记并连接" })).toBeDisabled();
    await form.getByLabel("地址").fill("10.0.0.9");
    await form.getByLabel("访问令牌").fill("runner-token");
    await expect(form.getByRole("button", { name: "登记并连接" })).toBeEnabled();
  });

  test("an unknown host key is a question with its fingerprint, answered once", async ({ page }) => {
    const mock = await installMockApi(page, {
      hostKey: { algorithm: "ssh-ed25519", fingerprint: "SHA256:6vCf3yZ9q1" },
    });
    const dialog = await openRemote(page);

    await dialog.getByRole("button", { name: "新增远端 Runner" }).click();
    const form = dialog.locator(".settings-card.is-form");
    await form.getByLabel("SSH 别名或 IP/主机名").fill("gpu-01");
    await form.getByRole("button", { name: "登记并测试" }).click();

    const question = dialog.locator(".host-key-card");
    await expect(question).toBeVisible();
    await expect(question).toContainText("还不认识 gpu-01 的主机密钥。");
    await expect(question).toContainText("SHA256:6vCf3yZ9q1");
    // The record exists already; continuing trusts it rather than registering twice.
    expect(calls(mock, "POST", "/api/remote-hosts")).toHaveLength(1);

    await question.getByRole("button", { name: "信任并继续" }).click();

    await expect(question).toHaveCount(0);
    await expect(card(dialog, "gpu-01")).toBeVisible();
    // The prompt is the key state the page holds, so the extra `trusted`
    // flag travels with it; the API reads the two fields it knows.
    expect(calls(mock, "POST", "/api/remote-hosts/runner-1/trust-host-key")).toEqual([
      { algorithm: "ssh-ed25519", fingerprint: "SHA256:6vCf3yZ9q1", trusted: false },
    ]);
    expect(calls(mock, "POST", "/api/remote-hosts")).toHaveLength(1);
  });

  test("an ssh_config entry prefills the form from the API's own file", async ({ page }) => {
    const mock = await installMockApi(page, {
      sshConfig: [{
        alias: "gpu-01",
        hostName: "10.0.0.9",
        identityFile: "/home/me/.ssh/id_ed25519",
        identityKeyReadable: true,
        port: 2222,
        username: "alice",
      }],
    });
    const dialog = await openRemote(page);

    await dialog.getByRole("button", { name: "新增远端 Runner" }).click();
    const form = dialog.locator(".settings-card.is-form");
    await form.getByRole("button", { name: "从 ssh_config 导入" }).click();
    await form.getByRole("button", { name: /gpu-01/u }).click();

    await expect(form.getByLabel("SSH 别名或 IP/主机名")).toHaveValue("10.0.0.9");
    await expect(form.getByLabel("SSH 端口")).toHaveValue("2222");
    await expect(form.getByLabel("登录用户")).toHaveValue("alice");
    await expect(keyField(form)).toHaveValue("/home/me/.ssh/id_ed25519");
    await expect(form.getByRole("status")).toContainText("已从 ssh_config 导入 gpu-01");
    // The entry is resolved as its own request: the list deliberately omits keys.
    expect(calls(mock, "GET", "/api/remote-hosts/ssh-config")).toHaveLength(2);
  });

  test("a generated key pair fills the path and shows only the public half", async ({ page }) => {
    const mock = await installMockApi(page);
    const dialog = await openRemote(page);

    await dialog.getByRole("button", { name: "新增远端 Runner" }).click();
    const form = dialog.locator(".settings-card.is-form");
    await form.getByRole("button", { name: "生成密钥对" }).click();

    await expect(keyField(form)).toHaveValue("/data/keys/generated_ed25519");
    await expect(form.locator(".path-chip")).toContainText("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE2E");
    expect(calls(mock, "POST", "/api/remote-hosts/generate-key")).toHaveLength(1);
  });
});

test.describe("连接", () => {
  test("connect and disconnect are one write each, and the card follows", async ({ page }) => {
    const mock = await installMockApi(page, { runners: [runner()] });
    const dialog = await openRemote(page);
    const machine = card(dialog, "gpu-01");

    await machine.getByRole("button", { name: "连接", exact: true }).click();
    await expect(machine.getByRole("button", { name: "断开", exact: true })).toBeVisible();
    expect(calls(mock, "POST", "/api/runners/runner-1/connect")).toHaveLength(1);

    await machine.getByRole("button", { name: "断开", exact: true }).click();
    await expect(machine.getByRole("button", { name: "连接", exact: true })).toBeVisible();
    expect(calls(mock, "POST", "/api/runners/runner-1/disconnect")).toHaveLength(1);
  });

  test("a failed connect keeps the reason and the last lines of its log", async ({ page }) => {
    await installMockApi(page, {
      connectError: "ssh: connect to host 10.0.0.9 port 22: Connection refused",
      connectLog: ["connecting to gpu-01", "ssh handshake failed"],
      runners: [runner()],
    });
    const dialog = await openRemote(page);
    const machine = card(dialog, "gpu-01");

    await machine.getByRole("button", { name: "连接", exact: true }).click();

    // The reason belongs to the section rather than the card: a connect can
    // fail before the machine is even the subject of the message.
    await expect(dialog).toContainText("ssh: connect to host 10.0.0.9 port 22: Connection refused");
    const log = machine.getByRole("log");
    await expect(log).toContainText("connecting to gpu-01");
    await expect(log).toContainText("ssh handshake failed");
    // The card offers the attempt again rather than staying in "connecting".
    await expect(machine.getByRole("button", { name: "连接", exact: true })).toBeEnabled();
  });

  test("a connected machine shows its disk only once its details are opened", async ({ page }) => {
    await installMockApi(page, {
      runners: [runner({
        runnerStatus: {
          hostId: "runner-1",
          resources: resources(),
          remoteVersion: "0.9.0",
          state: "ready",
        },
      })],
    });
    const dialog = await openRemote(page);
    const machine = card(dialog, "gpu-01");

    await expect(machine).toContainText("就绪");
    // The readings are folded away by default: the card is about the connection.
    await expect(machine.getByText("磁盘已用")).toBeHidden();
    await machine.locator("summary").click();
    await expect(machine.getByText("磁盘已用")).toBeVisible();
    await expect(machine).toContainText("10.0 GiB / 100.0 GiB");
  });
});

test.describe("凭据", () => {
  test("explicit forgetting clears stored credentials and a later password can be saved", async ({ page }, testInfo) => {
    const mock = await installMockApi(page, { runners: [runner({ hasPassword: true, hasPrivateKey: true })] });
    const dialog = await openRemote(page);
    const machine = card(dialog, "gpu-01");
    await test.step("1. Keep saved credentials when fields are blank", async () => {
      await machine.getByRole("button", { name: "登录凭据" }).click();
      await machine.getByRole("button", { name: "保存并测试" }).click();
      await expect(machine.locator(".connect-log")).toHaveCount(0);
      expect(calls(mock, "PUT", "/api/remote-hosts/runner-1/credentials")[0]).toEqual({});
      expect(mock.state.runners[0]).toMatchObject({ hasPassword: true, hasPrivateKey: true });
    });
    await test.step("2. Explicitly forget the saved password, key and passphrase", async () => {
      await machine.getByRole("button", { name: "登录凭据" }).click();
      await machine.getByRole("checkbox", { name: "忘记已存的密码、私钥和口令" }).check();
      await expect(machine.getByLabel("登录密码")).toBeDisabled();
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 844 });
        const forget = machine.getByRole("checkbox", { name: "忘记已存的密码、私钥和口令" });
        await forget.scrollIntoViewIfNeeded();
        await expect(forget).toBeInViewport();
        await page.screenshot({ path: testInfo.outputPath(`forget-credentials-${width}.png`) });
      }
      await machine.getByRole("button", { name: "保存并测试" }).click();
      await expect(machine.locator(".connect-log")).toHaveCount(0);
      expect(calls(mock, "PUT", "/api/remote-hosts/runner-1/credentials")[1]).toEqual({ password: null, privateKeyPath: null, passphrase: null });
      expect(mock.state.runners[0]).toMatchObject({ hasPassword: false, hasPrivateKey: false });
    });
    await test.step("3. Save a replacement password", async () => {
      await machine.getByRole("button", { name: "登录凭据" }).click();
      await machine.getByLabel("登录密码").fill("replacement-test-password");
      await machine.getByRole("button", { name: "保存并测试" }).click();
      await expect(machine.locator(".connect-log")).toHaveCount(0);
      expect(calls(mock, "PUT", "/api/remote-hosts/runner-1/credentials")[2]).toEqual({ password: "replacement-test-password" });
      expect(mock.state.runners[0]).toMatchObject({ hasPassword: true, hasPrivateKey: false });
    });
  });

  test("empty fields keep what is stored; a filled one replaces it", async ({ page }) => {
    const mock = await installMockApi(page, {
      runners: [runner({ hasPassword: false, hasPrivateKey: true })],
    });
    const dialog = await openRemote(page);
    const machine = card(dialog, "gpu-01");

    await machine.getByRole("button", { name: "登录凭据" }).click();
    await expect(machine.getByLabel("登录密码")).toHaveAttribute("placeholder", "留空则沿用已存的密码");
    await expect(keyField(machine)).toHaveAttribute("placeholder", "留空则沿用已存的私钥");
    await machine.getByRole("button", { name: "保存并测试" }).click();

    await expect(machine.locator(".connect-log")).toHaveCount(0);
    expect(calls(mock, "PUT", "/api/remote-hosts/runner-1/credentials")).toEqual([{}]);

    await machine.getByRole("button", { name: "登录凭据" }).click();
    await machine.getByLabel("登录密码").fill("new-pass");
    await machine.getByRole("button", { name: "保存并测试" }).click();

    expect(calls(mock, "PUT", "/api/remote-hosts/runner-1/credentials")[1]).toEqual({ password: "new-pass" });
    await expect(machine).toContainText("已存密码");
  });
});

test.describe("删除", () => {
  test("deleting asks first and removes the machine once confirmed", async ({ page }) => {
    const mock = await installMockApi(page, { runners: [runner()] });
    const dialog = await openRemote(page);
    const machine = card(dialog, "gpu-01");

    await machine.getByRole("button", { name: "删除" }).click();
    const confirm = page.getByRole("dialog", { name: "删除机器「gpu-01」？" });
    await expect(confirm).toBeVisible();
    // The settings overlay is painted above the confirmation's backdrop, so the
    // accept button cannot be clicked with the pointer. Keyboard activation
    // still exercises the same action; the layering defect is recorded in
    // TEST-PLAN instead of being hidden by a pointer workaround.
    await confirm.getByRole("button", { name: "删除" }).press("Enter");

    await expect(machine).toHaveCount(0);
    await expect(dialog).toContainText("没有已登记的 Runner。");
    expect(calls(mock, "DELETE", "/api/remote-hosts/runner-1")).toHaveLength(1);
  });
});

test.describe("允许的机器", () => {
  test("the allowlist is written whole, and this machine is not one of its boxes", async ({ page }) => {
    const mock = await installMockApi(page, {
      projects: [{ ...DEFAULT_PROJECT, runnerIds: ["local", "runner-1"] }],
      runners: [localRunner(), runner()],
      sessions: [makeSession()],
    });
    const dialog = await openRemote(page);

    // The machine the app itself runs on always exists and cannot be
    // un-registered, so it has no card and no box: this page manages the
    // others, and the allowlist starts with whatever the Project stored.
    await expect(dialog.getByRole("checkbox", { name: /本地|local/u })).toHaveCount(0);
    const remote = dialog.getByRole("checkbox", { name: /gpu-01/u });
    await expect(remote).toBeChecked();

    await remote.click();

    // The whole list goes on every toggle, and the implicit local entry it was
    // stored with stays in it: only the machine the reader unticked left.
    expect(calls(mock, "PATCH", "/api/projects/project-1")).toEqual([{ runnerIds: ["local"] }]);
  });
});

test.describe("NPU", () => {
  test("a ticked card is saved as a list, not one write per card", async ({ page }) => {
    const mock = await installMockApi(page, {
      runners: [runner({
        runnerStatus: {
          hostId: "runner-1",
          resources: resources({ npu: npuInventory() }),
          state: "ready",
        },
      })],
    });
    const dialog = await openRemote(page);
    const machine = card(dialog, "gpu-01");
    await machine.locator("summary").click();

    const npuPanel = machine.locator(".npu-panel");
    await expect(machine).toContainText("本机 2 张 · 沙箱内可用 2 张");
    await machine.getByRole("checkbox", { name: /NPU 1/u }).check();
    await expect(npuPanel).toContainText("有未保存的勾选");
    await machine.getByRole("button", { name: "保存勾选" }).click();

    await expect(npuPanel).not.toContainText("有未保存的勾选");
    expect(calls(mock, "PUT", "/api/runners/runner-1/npu-devices")).toEqual([{ devices: [1] }]);
  });
});
