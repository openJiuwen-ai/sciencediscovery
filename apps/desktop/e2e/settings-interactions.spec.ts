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
 * The settings pages as write paths, not as first paints.
 *
 * `settings-screens.test.tsx` proves what each pane looks like before any data
 * arrives. These cases press the controls: a form that forgets to send a field,
 * a toggle that writes the wrong record, or a save that stays open after the
 * server refused it would all pass that static render and fail here.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  TOKEN,
  TOKEN_STORAGE_KEY,
  installMockApi,
  type JsonRecord,
  type ModelRecord,
  type Mock,
} from "./fixtures.js";

const MODELS: ModelRecord[] = [
  { id: "model-1", model: "qwen-max", name: "Qwen Max", providerId: "provider-1" },
];

function specialist(over: JsonRecord = {}): JsonRecord {
  return {
    builtIn: false,
    connectorIds: [],
    createdAt: "2026-10-01T08:00:00.000Z",
    description: "读晶体结构",
    enabled: true,
    enabledSkillIds: [],
    id: "specialist-1",
    instructions: "先读结构，再回答。",
    name: "晶体专家",
    updatedAt: "2026-10-01T08:00:00.000Z",
    ...over,
  };
}

function mcpServer(over: JsonRecord = {}): JsonRecord {
  return {
    args: [],
    authMode: "headers",
    checkedAt: "2026-10-01T08:00:00.000Z",
    command: "",
    cwd: "",
    description: "检索外部文献",
    durationMs: 4,
    enabled: true,
    env: {},
    headers: {},
    id: "mcp-1",
    name: "检索服务",
    oauth: { clientId: "", clientMetadataUrl: "", clientSecret: null, scope: "" },
    sourceId: "custom-1",
    status: "ready",
    timeoutSeconds: 30,
    tools: [{ id: "search", name: "search" }],
    transport: "http",
    url: "https://mcp.example/sse",
    ...over,
  };
}

function skill(over: JsonRecord = {}): JsonRecord {
  return {
    currentRevision: 1,
    // The version the package declared in SKILL.md; the card prints it as `v…`
    // and falls back to 第 N 版 only when it is missing.
    declaredVersion: "1.0.0",
    description: "按 DOI 检索文献",
    diagnostics: [],
    hash: "hash-1",
    id: "skill-1",
    name: "文献检索",
    readOnly: true,
    resourceSummary: { bytes: 10, files: 2, kinds: {} },
    source: "built-in",
    ...over,
  };
}

async function openSettings(page: Page, group: string): Promise<Locator> {
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: group, exact: true }).click();
  return dialog;
}

function writeCall(mock: Mock, method: string, path: string | RegExp): Record<string, unknown> | undefined {
  const match = (entry: { path: string }) => (
    typeof path === "string" ? entry.path === path : path.test(entry.path)
  );
  const call = mock.calls.find((entry) => entry.method === method && match(entry));
  return call?.body === undefined ? undefined : JSON.parse(call.body) as Record<string, unknown>;
}

/** The last write of a route, for a pane that rewrites the same object as the
 *  reader moves through its fields. */
function lastWriteCall(mock: Mock, method: string, path: string | RegExp) {
  const match = (entry: { path: string }) => (
    typeof path === "string" ? entry.path === path : path.test(entry.path)
  );
  const call = [...mock.calls].reverse().find((entry) => entry.method === method && match(entry));
  return call?.body === undefined ? undefined : JSON.parse(call.body) as Record<string, unknown>;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [TOKEN_STORAGE_KEY, TOKEN] as const,
  );
});

test.describe("专家", () => {
  const page = (over: JsonRecord = {}) => ({
    connectors: [{ displayName: "PubMed", id: "connector-1" }],
    skills: [skill()],
    specialists: [specialist(over)],
  });

  test("a specialist's form writes its runtime and the capabilities picked in it", async ({ page: browser }) => {
    const mock = await installMockApi(browser, page());
    const dialog = await openSettings(browser, "专家");

    // The page can edit an existing row; there is no 新增专家 since #584, so
    // the form is reached through the card it belongs to.
    const card = dialog.locator(".settings-card").filter({ hasText: "晶体专家" });
    await card.getByRole("button", { name: "编辑" }).click();
    const form = browser.getByRole("dialog", { name: "编辑专家" });
    await expect(form).toBeVisible();
    // A specialist with no explicit lists has been inheriting everything, which
    // the form shows as 完全访问 rather than as two empty lists.
    await expect(form.getByRole("radio", { name: /完全访问/u })).toBeChecked();

    await form.getByLabel("描述（可选）").fill("看分子结构");
    await form.getByLabel("运行时").selectOption("codex");
    await form.locator(".settings-row", { hasText: "模型" }).locator("input").fill("gpt-5");

    // The first capability picked is what turns 完全访问 into an explicit pair
    // of lists; until then the record carries nothing.
    await form.getByRole("button", { name: "添加技能" }).click();
    const picker = browser.getByRole("dialog", { name: "添加技能和连接器" });
    await picker.getByRole("checkbox", { name: /文献检索/u }).check();
    await picker.getByRole("tab", { name: /连接器/u }).click();
    await picker.getByRole("checkbox", { name: /PubMed/u }).check();
    await picker.getByRole("button", { name: "添加", exact: true }).click();
    await expect(picker).toBeHidden();
    await expect(form.locator(".settings-ability-list")).toContainText("文献检索");

    await form.getByRole("button", { name: "保存", exact: true }).click();

    await expect(form).toBeHidden();
    expect(writeCall(mock, "PUT", "/api/specialists/specialist-1")).toMatchObject({
      connectorIds: ["connector-1"],
      description: "看分子结构",
      enabledSkillIds: ["skill-1"],
      instructions: "先读结构，再回答。",
      name: "晶体专家",
      runtime: { kind: "codex", model: "gpt-5" },
    });
  });

  test("editing and deleting a specialist use the card's own actions", async ({ page: browser }) => {
    const mock = await installMockApi(browser, page());
    const dialog = await openSettings(browser, "专家");

    const card = dialog.locator(".settings-card").filter({ hasText: "晶体专家" });
    await card.getByRole("button", { name: "编辑" }).click();
    const form = browser.getByRole("dialog", { name: "编辑专家" });
    await form.getByLabel("名称").fill("晶体专家（改）");
    await form.getByRole("button", { name: "保存", exact: true }).click();

    await expect(dialog.locator(".settings-card").filter({ hasText: "晶体专家（改）" })).toBeVisible();
    expect(writeCall(mock, "PUT", "/api/specialists/specialist-1")).toMatchObject({
      name: "晶体专家（改）",
    });

    await dialog
      .locator(".settings-card")
      .filter({ hasText: "晶体专家（改）" })
      .getByRole("button", { name: "删除" })
      .click();
    const confirm = browser.getByRole("dialog", { name: "删除专家「晶体专家（改）」？" });
    await expect(confirm).toBeVisible();
    // The settings overlay sits above the confirmation's backdrop, so the
    // accept button is painted but not clickable. The case drives it by
    // keyboard, which still exercises the same action; the layering defect is
    // recorded in TEST-PLAN rather than hidden by a pointer workaround.
    await confirm.getByRole("button", { name: "删除" }).press("Enter");

    await expect(dialog.locator(".settings-card").filter({ hasText: "晶体专家（改）" })).toHaveCount(0);
    expect(mock.calls.some((call) => call.method === "DELETE" && call.path === "/api/specialists/specialist-1")).toBe(
      true,
    );
  });

  test("a built-in specialist can only be switched off", async ({ page: browser }) => {
    const mock = await installMockApi(browser, page({ builtIn: true, name: "内置专家" }));
    const dialog = await openSettings(browser, "专家");

    const card = dialog.locator(".settings-card").filter({ hasText: "内置专家" });
    await expect(card.getByRole("button", { name: "删除" })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "编辑" })).toHaveCount(0);

    await card.getByRole("switch", { name: "内置专家 · 已启用" }).click();
    await expect(card.getByRole("switch", { name: "内置专家 · 已启用" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await expect(card).toContainText("已停用");
    expect(writeCall(mock, "PUT", "/api/specialists/specialist-1")).toEqual({ enabled: false });
  });

  test("a rejected save keeps the form and names the reason", async ({ page: browser }) => {
    await installMockApi(browser, {
      ...page(),
      fail: { message: "name already exists", method: "PUT", path: "/api/specialists/specialist-1" },
    });
    const dialog = await openSettings(browser, "专家");

    await dialog.locator(".settings-card").filter({ hasText: "晶体专家" }).getByRole("button", { name: "编辑" }).click();
    const form = browser.getByRole("dialog", { name: "编辑专家" });
    await form.getByLabel("名称").fill("重复的专家");
    await form.getByRole("button", { name: "保存", exact: true }).click();

    // The reason belongs to the form that was refused, and the form stays open
    // with the name still in it rather than sending the reader back to the list.
    await expect(form.locator(".row-note.is-error")).toHaveText("name already exists");
    await expect(form.getByLabel("名称")).toHaveValue("重复的专家");
  });
});

test.describe("MCP 服务器", () => {
  const sources: JsonRecord[] = [
    {
      manifest: {
        description: "随产品提供的检索工具",
        displayName: "内置检索",
        id: "builtin-search",
        tools: { search: { description: "检索", id: "search" } },
      },
      status: { status: "ready" },
    },
  ];

  test("a custom server is written whole, with its env and transport", async ({ page }) => {
    const mock = await installMockApi(page, { mcpServers: [mcpServer()], mcpSources: sources });
    const dialog = await openSettings(page, "MCP 服务器");

    // Custom and built-in servers share one page: the ones the user added are
    // listed first, and the product's own follow with a switch instead of
    // edit/delete, because they have no record of their own. There is no
    // 新增服务器 since #584 — the form below is the one an existing row opens.
    await expect(dialog.locator(".settings-card").filter({ hasText: "内置检索" })).toBeVisible();

    const card = dialog.locator(".settings-card").filter({ hasText: "检索服务" });
    await card.getByRole("button", { name: "编辑" }).click();
    const form = page.getByRole("dialog", { name: "编辑服务器" });
    await form.locator(".settings-row", { hasText: "说明" }).locator("input").fill("跑在本地");
    await form.getByLabel("传输方式").selectOption("stdio");
    await form.locator(".settings-row", { hasText: "命令" }).locator("input").fill("node");
    await form.getByRole("button", { name: "新增一项" }).click();
    await form.getByLabel("环境变量 键 1").fill("TOKEN");
    await form.getByLabel("环境变量 值 1").fill("secret");
    await form.getByRole("button", { name: "保存", exact: true }).click();

    await expect(form).toBeHidden();
    // The whole record goes on a save, not only the fields that changed: the
    // switch in it, the transport it now speaks and the secret it now carries
    // are one write.
    expect(writeCall(mock, "PUT", "/api/mcp/servers/mcp-1")).toMatchObject({
      args: [],
      command: "node",
      description: "跑在本地",
      enabled: true,
      env: { TOKEN: "secret" },
      name: "检索服务",
      transport: "stdio",
    });
  });

  test("a server can be tested from its card and stopped or started in its edit form", async ({ page }) => {
    const mock = await installMockApi(page, {
      mcpServers: [mcpServer()],
      mcpSources: sources,
    });
    const dialog = await openSettings(page, "MCP 服务器");
    const card = dialog.locator(".settings-card").filter({ hasText: "检索服务" });

    await card.getByRole("button", { name: "测试" }).click();
    // The toast prints the status the service reported; `ready` is its own
    // spelling, not the card's translated 已连接.
    await expect(page.locator(".toast")).toContainText("测试结果：ready");
    expect(mock.calls.some((call) => call.method === "POST" && call.path === "/api/mcp/servers/mcp-1/test")).toBe(
      true,
    );

    const selection = card.getByRole("switch", { name: "检索服务 · 默认使用" });
    await expect(selection).toHaveAttribute("aria-checked", "false");
    for (const enabled of [false, true]) {
      await card.getByRole("button", { name: "编辑" }).click();
      const form = page.getByRole("dialog", { name: "编辑服务器" });
      await form.getByRole("checkbox", { name: "启用服务", exact: true }).setChecked(enabled);
      await form.getByRole("button", { name: "保存", exact: true }).click();
      await expect(form).toBeHidden();
      await expect(card.getByRole("button", { name: "编辑" })).toBeEnabled();
      expect(lastWriteCall(mock, "PUT", "/api/mcp/servers/mcp-1")).toMatchObject({ enabled });
      expect(mock.state.mcpServers[0]?.enabled).toBe(enabled);
      await expect(selection).toHaveAttribute("aria-checked", "false");
    }
    expect(mock.calls.filter((call) => call.method === "PUT" && call.path === "/api/settings")).toHaveLength(0);
  });

  test("default source selection survives reopening without changing permissions or service state", async ({ page }) => {
    const plugins = { "connector.builtin-search": { enabled: false, config: { mode: "fixture" } } };
    const mock = await installMockApi(page, {
      mcpServers: [mcpServer({ enabled: false, status: "disabled" })],
      mcpSources: sources,
      overrides: { plugins },
    });
    let dialog = await openSettings(page, "MCP 服务器");
    const builtin = () => dialog.getByRole("switch", { name: "内置检索 · 默认使用" });
    const custom = () => dialog.getByRole("switch", { name: "检索服务 · 默认使用" });
    await expect(builtin()).toHaveAttribute("aria-checked", "false");
    await builtin().click();
    await expect(builtin()).toHaveAttribute("aria-checked", "true");
    await custom().click();
    await expect(custom()).toHaveAttribute("aria-checked", "true");
    expect(lastWriteCall(mock, "PUT", "/api/settings")).toMatchObject({
      enabledConnectorIds: ["web", "builtin-search", "mcp-1"], plugins,
    });
    expect(mock.state.mcpServers[0]?.enabled).toBe(false);
    expect(mock.calls.some((call) => call.method === "PUT" && call.path.startsWith("/api/mcp/servers/"))).toBe(false);

    // A fresh page reads the stored selection, including a source whose
    // permission still prohibits calls. Selection never grants permission.
    dialog = await openSettings(page, "MCP 服务器");
    await expect(builtin()).toHaveAttribute("aria-checked", "true");
    await expect(custom()).toHaveAttribute("aria-checked", "true");
    await builtin().click();
    await expect(builtin()).toHaveAttribute("aria-checked", "false");
    await custom().click();
    await expect(custom()).toHaveAttribute("aria-checked", "false");
    dialog = await openSettings(page, "MCP 服务器");
    await expect(builtin()).toHaveAttribute("aria-checked", "false");
    await expect(custom()).toHaveAttribute("aria-checked", "false");
    expect(mock.state.overrides.enabledConnectorIds).toEqual(["web"]);
    expect(mock.state.overrides.plugins).toEqual(plugins);
  });

  test("select all and clear selection preserve unlisted sources and unrelated overrides", async ({ page }) => {
    const plugins = { "connector.builtin-search": { enabled: false } };
    const mock = await installMockApi(page, {
      mcpServers: [mcpServer()], mcpSources: sources,
      overrides: { enabledConnectorIds: ["unlisted"], plugins },
    });
    const dialog = await openSettings(page, "MCP 服务器");
    const builtin = dialog.getByRole("switch", { name: "内置检索 · 默认使用" });
    const custom = dialog.getByRole("switch", { name: "检索服务 · 默认使用" });
    await dialog.getByRole("button", { name: "全部选用", exact: true }).click();
    await expect(builtin).toHaveAttribute("aria-checked", "true");
    await expect(custom).toHaveAttribute("aria-checked", "true");
    expect(lastWriteCall(mock, "PUT", "/api/settings")).toMatchObject({
      enabledConnectorIds: ["unlisted", "builtin-search", "mcp-1"], plugins,
    });
    await dialog.getByRole("button", { name: "取消全选", exact: true }).click();
    await expect(builtin).toHaveAttribute("aria-checked", "false");
    await expect(custom).toHaveAttribute("aria-checked", "false");
    expect(lastWriteCall(mock, "PUT", "/api/settings")).toMatchObject({
      enabledConnectorIds: ["unlisted"], plugins,
    });
    expect(mock.state.mcpServers[0]?.enabled).toBe(true);
  });

  test("a rejected default selection keeps the saved value and allows retry", async ({ page }) => {
    const options = {
      mcpSources: sources,
      fail: { message: "selection save refused", method: "PUT", path: "/api/settings" },
    };
    const mock = await installMockApi(page, options);
    const dialog = await openSettings(page, "MCP 服务器");
    const selection = dialog.getByRole("switch", { name: "内置检索 · 默认使用" });
    await selection.click();
    await expect(dialog.locator(".row-note.is-error")).toHaveText("selection save refused");
    await expect(selection).toHaveAttribute("aria-checked", "false");
    await expect(selection).toBeEnabled();
    expect(mock.state.overrides.enabledConnectorIds).toBeUndefined();
    options.fail.path = "/not-this-request";
    await selection.click();
    await expect(selection).toHaveAttribute("aria-checked", "true");
    await expect(dialog.locator(".row-note.is-error")).toHaveCount(0);
    expect(mock.state.overrides.enabledConnectorIds).toEqual(["web", "builtin-search"]);
  });

  test("a failed test shows the provider's own reason", async ({ page }) => {
    await installMockApi(page, {
      mcpServers: [mcpServer()],
      mcpSources: sources,
      mcpTest: "error",
    });
    const dialog = await openSettings(page, "MCP 服务器");
    const card = dialog.locator(".settings-card").filter({ hasText: "检索服务" });

    await card.getByRole("button", { name: "测试" }).click();
    await expect(page.locator(".toast")).toContainText("connection refused");
  });

  test("a blank secret key is refused before a request is made", async ({ page }) => {
    const mock = await installMockApi(page, { mcpServers: [mcpServer()], mcpSources: sources });
    const dialog = await openSettings(page, "MCP 服务器");

    await dialog.locator(".settings-card").filter({ hasText: "检索服务" }).getByRole("button", { name: "编辑" }).click();
    const form = page.getByRole("dialog", { name: "编辑服务器" });
    await form.getByLabel("传输方式").selectOption("stdio");
    await form.getByRole("button", { name: "新增一项" }).click();
    await form.getByRole("button", { name: "保存", exact: true }).click();

    // A keyless slot would send an environment variable with no name, so the
    // form refuses it instead of letting the server guess.
    await expect(form.locator(".row-note.is-error")).toHaveText("键不能为空。");
    expect(mock.calls.some((call) => call.method === "PUT" && call.path === "/api/mcp/servers/mcp-1")).toBe(false);
  });

  test("deleting a custom server asks first", async ({ page }) => {
    const mock = await installMockApi(page, {
      mcpServers: [mcpServer()],
      mcpSources: sources,
    });
    const dialog = await openSettings(page, "MCP 服务器");
    const card = dialog.locator(".settings-card").filter({ hasText: "检索服务" });

    await card.getByRole("button", { name: "删除" }).click();
    const confirm = page.getByRole("dialog", { name: "删除服务器「检索服务」？" });
    // See the note on the 专家 delete case: the settings overlay covers the
    // confirmation's backdrop, so the button is activated by keyboard.
    await confirm.getByRole("button", { name: "删除" }).press("Enter");

    await expect(dialog.locator(".settings-card").filter({ hasText: "检索服务" })).toHaveCount(0);
    expect(mock.calls.some((call) => call.method === "DELETE" && call.path === "/api/mcp/servers/mcp-1")).toBe(true);
  });
});

test.describe("超时", () => {
  test("a value is written in milliseconds when its field is left, and zero means unlimited", async ({ page }) => {
    const mock = await installMockApi(page, { models: MODELS });
    const dialog = await openSettings(page, "超时");

    const idle = dialog.getByRole("spinbutton", { name: "网关空闲超时" });
    await expect(idle).toHaveValue("240");
    // Nothing is written while the field still has focus: the value on screen
    // is a draft until the reader leaves it.
    await idle.fill("90");
    expect(writeCall(mock, "PUT", "/api/timeout-settings")).toBeUndefined();

    await idle.blur();
    await expect
      .poll(() => lastWriteCall(mock, "PUT", "/api/timeout-settings"))
      .toMatchObject({ gatewayIdleTimeoutMs: 90_000 });

    // The switch is not a draft at all: it writes on the press.
    const unlimited = dialog.getByRole("switch", { name: "单轮超时 · 不限" });
    await expect(unlimited).toHaveAttribute("aria-checked", "true");
    await unlimited.click();
    await expect(dialog.getByRole("spinbutton", { name: "单轮超时" })).toHaveValue("60");
    await expect
      .poll(() => lastWriteCall(mock, "PUT", "/api/timeout-settings"))
      .toMatchObject({ gatewayIdleTimeoutMs: 90_000, gatewayTurnTimeoutMs: 60_000 });
  });

  test("a refused write says why and puts the field back", async ({ page }) => {
    await installMockApi(page, {
      fail: { message: "quota exceeded", method: "PUT", path: "/api/timeout-settings" },
      models: MODELS,
    });
    const dialog = await openSettings(page, "超时");

    const idle = dialog.getByRole("spinbutton", { name: "网关空闲超时" });
    await idle.fill("90");
    await idle.blur();

    await expect(dialog.locator(".row-note.is-error")).toHaveText("quota exceeded");
    // The stored value is what the service still has, so that is what the
    // field goes back to rather than leaving a value nobody saved.
    await expect(idle).toHaveValue("240");
  });

  test("leaving a pane keeps what was written, because there is no draft to drop", async ({ page }) => {
    await installMockApi(page, { models: MODELS });
    const dialog = await openSettings(page, "超时");

    const idle = dialog.getByRole("spinbutton", { name: "网关空闲超时" });
    await idle.fill("90");
    await idle.blur();
    await expect(idle).toHaveValue("90");

    await dialog.getByRole("button", { name: "通用", exact: true }).click();
    await dialog.getByRole("button", { name: "超时", exact: true }).click();

    await expect(dialog.getByRole("spinbutton", { name: "网关空闲超时" })).toHaveValue("90");
  });
});

test.describe("设置对话框", () => {
  test("Escape and the rail's 会话 both leave it, and 设置 opens it again", async ({ page }) => {
    await installMockApi(page, { models: MODELS });
    await page.goto("/");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "设置" });
    await expect(dialog).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(dialog).toBeVisible();
    // The surface covers the whole window, so there is no corner of backdrop
    // left to click and no close control of its own: the rail's 会话 is the
    // pointer's way out, and Escape the keyboard's.
    await expect(dialog.getByRole("button", { name: "关闭设置" })).toHaveCount(0);
    await page.getByRole("button", { name: "会话", exact: true }).click();
    await expect(dialog).toBeHidden();
  });

  test("a category folds without losing the pane on screen", async ({ page }) => {
    await installMockApi(page, { models: MODELS });
    const dialog = await openSettings(page, "模型");

    const category = dialog.getByRole("button", { name: "智能", exact: true });
    await expect(dialog.getByRole("button", { name: "模型", exact: true })).toBeVisible();
    await category.click();
    await expect(dialog.getByRole("button", { name: "模型", exact: true })).toBeHidden();
    await category.click();
    await expect(dialog.getByRole("button", { name: "模型", exact: true })).toBeVisible();
    await expect(dialog.locator(".model-row")).toHaveCount(1);
  });

  test("there is no footer to save or close with, because every pane writes on its press", async ({ page }) => {
    await installMockApi(page, { models: MODELS });
    const dialog = await openSettings(page, "模型");

    // A shared 保存 could only ever be disabled, and 保存并关闭 would be a
    // second way out of a dialog that already has two.
    await expect(dialog.getByRole("button", { name: "保存", exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "保存并关闭" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "关闭设置" })).toHaveCount(0);

    // Every pane has already written what the reader did, so leaving needs no
    // confirmation step of its own.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});

test.describe("技能", () => {
  const skills = [
    skill(),
    skill({ description: "画分子图", id: "skill-2", name: "分子绘图", resourceSummary: { bytes: 4, files: 3, kinds: {} } }),
  ];

  test("JiuwenSwarm built-in and local switches work without ScienceDiscovery skills", async ({ page }, testInfo) => {
    await installMockApi(page, {
      models: MODELS,
      jiuwenSwarmSkills: [
        { name: "xlsx", description: "Read spreadsheets", enabled: true, source: "builtin" },
        { name: "local-tool", description: "A local skill", enabled: false, source: "local" },
      ],
    });
    let dialog: Locator;
    await test.step("1. Open skills and identify JiuwenSwarm sources", async () => {
      dialog = await openSettings(page, "技能");
      await expect(dialog.locator(".settings-card")).toHaveCount(2);
      await expect(dialog.locator(".settings-card").filter({ hasText: "xlsx" })).toContainText("JiuwenSwarm 内置");
      await expect(dialog.locator(".settings-card").filter({ hasText: "local-tool" })).toContainText("JiuwenSwarm 安装");
    });
    await test.step("2. Disable the built-in and enable the local skill", async () => {
      await dialog.getByRole("switch", { name: "启用或停用「xlsx」" }).click();
      await expect(dialog.locator(".settings-card").filter({ hasText: "xlsx" })).toContainText("已停用");
      await dialog.getByRole("switch", { name: "启用或停用「local-tool」" }).click();
      await expect(dialog.locator(".settings-card").filter({ hasText: "local-tool" })).toContainText("已启用");
      await page.screenshot({ path: testInfo.outputPath("jiuwenswarm-skills.png") });
    });
    await test.step("3. Reload and verify both saved switches", async () => {
      await page.reload();
      dialog = await openSettings(page, "技能");
      await expect(dialog.locator(".settings-card").filter({ hasText: "xlsx" })).toContainText("已停用");
      await expect(dialog.locator(".settings-card").filter({ hasText: "local-tool" })).toContainText("已启用");
    });
  });

  test("same-named skills use separate switches and bulk actions include built-ins", async ({ page }) => {
    const mock = await installMockApi(page, {
      models: MODELS,
      skills: [skill({ id: "xlsx", name: "SD spreadsheets" })],
      jiuwenSwarmSkills: [
        { name: "xlsx", description: "Native spreadsheets", enabled: true, source: "builtin" },
        { name: "sciencediscovery-xlsx", skillId: "xlsx", description: "Imported spreadsheets", enabled: true, source: "sciencediscovery" },
      ],
    });
    const dialog = await openSettings(page, "技能");
    await expect(dialog.locator(".settings-card")).toHaveCount(2);
    await dialog.getByRole("switch", { name: "启用或停用「xlsx」", exact: true }).click();
    await expect(dialog.locator(".settings-card").filter({ hasText: "Native spreadsheets" })).toContainText("已停用");
    await expect(dialog.locator(".settings-card").filter({ hasText: "SD spreadsheets" })).toContainText("已启用");
    expect(writeCall(mock, "PUT", /^\/api\/jiuwenswarm\/skills\/xlsx$/u)).toEqual({ enabled: false });
    await dialog.getByRole("button", { name: "一键关闭", exact: true }).click();
    await expect(dialog.getByRole("switch", { checked: true })).toHaveCount(0);
    expect(writeCall(mock, "PUT", /^\/api\/jiuwenswarm\/skills-by-id\/xlsx$/u)).toEqual({ enabled: false });
    await dialog.getByRole("button", { name: "一键启用", exact: true }).click();
    await expect(dialog.getByRole("switch", { checked: true })).toHaveCount(2);
  });

  test("a refused built-in switch keeps its saved state and reports the failure", async ({ page }) => {
    await installMockApi(page, {
      models: MODELS, skills, skillToggleFailures: ["xlsx"],
      jiuwenSwarmSkills: [{ name: "xlsx", description: "Native spreadsheets", enabled: true, source: "builtin" }],
    });
    const dialog = await openSettings(page, "技能");
    await expect(dialog.locator(".settings-card")).toHaveCount(3);
    await dialog.getByRole("button", { name: "一键关闭", exact: true }).click();
    await expect(dialog.locator(".settings-card").filter({ hasText: "xlsx" })).toContainText("已启用");
    await expect(dialog).toContainText("xlsx: Skill switch failed");
    await expect(dialog.locator(".settings-card").filter({ hasText: "分子绘图" })).toContainText("已停用");
    await dialog.getByRole("switch", { name: "启用或停用「xlsx」", exact: true }).click();
    await expect(dialog).toContainText("Skill switch failed");
    await expect(dialog.getByRole("switch", { name: "启用或停用「xlsx」", exact: true })).toBeChecked();
  });

  test("a switch updates JiuwenSwarm globally and survives a reload", async ({ page }) => {
    const mock = await installMockApi(page, {
      models: MODELS,
      jiuwenSwarmSkills: [{ skillId: "skill-1", name: "skill-1", description: "", enabled: true, source: "sciencediscovery" }],
      skills,
    });
    const dialog = await openSettings(page, "技能");

    const card = dialog.locator(".settings-card").filter({ hasText: "分子绘图" });
    await expect(card).toContainText("已停用");
    await card.getByRole("switch", { name: "启用或停用「分子绘图」" }).click();
    await expect(card).toContainText("已启用");

    expect(writeCall(mock, "PUT", /^\/api\/jiuwenswarm\/skills-by-id\/skill-2$/u)).toEqual({ enabled: true });
    expect(mock.state.jiuwenSwarmSkills.find((skill) => skill.skillId === "skill-2")?.enabled).toBe(true);
    expect(mock.calls.some((call) => call.method === "PUT" && /\/projects\/[^/]+\/settings$/u.test(call.path))).toBe(false);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await page.reload();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const reopened = page.getByRole("dialog", { name: "设置" });
    await reopened.getByRole("button", { name: "技能", exact: true }).click();
    await expect(reopened.locator(".settings-card").filter({ hasText: "分子绘图" })).toContainText("已启用");
  });

  test("bulk enable continues after one skill fails and shows the saved state", async ({ page }) => {
    const mock = await installMockApi(page, {
      models: MODELS, skills, skillToggleFailures: ["skill-1"],
    });
    const dialog = await openSettings(page, "技能");
    await expect(dialog.locator(".settings-card")).toHaveCount(2);
    await dialog.getByRole("button", { name: "一键启用", exact: true }).click();
    await expect(dialog.locator(".settings-card").filter({ hasText: "分子绘图" })).toContainText("已启用");
    await expect(dialog.locator(".settings-card").filter({ hasText: "文献检索" })).toContainText("已停用");
    await expect(dialog).toContainText("Skill switch failed");
    expect(mock.state.jiuwenSwarmSkills.find((skill) => skill.skillId === "skill-2")?.enabled).toBe(true);
  });

  test("a card opens to the skill's source, version and file count", async ({ page }) => {
    await installMockApi(page, {
      models: MODELS,
      projectSettings: { effective: { enabledSkillIds: [] }, overrides: {}, sources: {} },
      skills,
    });
    const dialog = await openSettings(page, "技能");
    const card = dialog.locator(".settings-card").filter({ hasText: "分子绘图" });

    await card.locator(".settings-card-main").click();
    // The count is the package's own files plus its SKILL.md, and the version
    // is the one the package declared rather than the revision number.
    await expect(card.locator(".settings-detail")).toContainText("内置 · v1.0.0 · 4 个文件");
  });

  test("switching back paints the remembered list before the refresh answers", async ({ page }) => {
    const mock = await installMockApi(page, {
      models: MODELS,
      projectSettings: { effective: { enabledSkillIds: [] }, overrides: {}, sources: {} },
      skills,
    });
    const dialog = await openSettings(page, "技能");
    const card = dialog.locator(".settings-card").filter({ hasText: "分子绘图" });
    await expect(card).toBeVisible();
    const reads = () => mock.calls.filter((call) => call.method === "GET" && call.path === "/api/skills").length;
    const before = reads();

    // Hold the next read back. The pane is about to be remounted, and its
    // answer must not be what puts the list on screen.
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/skills", async (route) => {
      await held;
      await route.fallback();
    });

    await dialog.getByRole("button", { name: "专家", exact: true }).click();
    await dialog.getByRole("button", { name: "技能", exact: true }).click();

    // The last answer is painted at once; the loading frame a returning user
    // used to read as "the app is slow" is not drawn.
    await expect(card).toBeVisible();
    await expect(dialog.getByText("正在读取…")).toHaveCount(0);

    // And the read still went out behind it, so a remembered list is shown
    // only until the server answers rather than instead of asking.
    release();
    await expect.poll(reads).toBeGreaterThan(before);
    await expect(card).toBeVisible();
  });

  test("a refresh that fails keeps the remembered list under the failure", async ({ page }) => {
    await installMockApi(page, {
      models: MODELS,
      projectSettings: { effective: { enabledSkillIds: [] }, overrides: {}, sources: {} },
      skills,
    });
    const dialog = await openSettings(page, "技能");
    const card = dialog.locator(".settings-card").filter({ hasText: "分子绘图" });
    await expect(card).toBeVisible();

    // Every later read of the list fails. The pane is about to be opened from
    // its last answer, and the refresh behind it must not take that answer
    // away — a stale list under a visible failure beats an empty page.
    await page.route("**/api/skills", (route) =>
      route.fulfill({ body: JSON.stringify({ error: "service unavailable" }), contentType: "application/json", status: 503 }));

    await dialog.getByRole("button", { name: "专家", exact: true }).click();
    await dialog.getByRole("button", { name: "技能", exact: true }).click();

    await expect(dialog.getByRole("button", { name: "重试" })).toBeVisible();
    await expect(card).toBeVisible();
  });
});

test.describe("模型", () => {
  test("a failed probe prints the endpoint's own reason", async ({ page }) => {
    await installMockApi(page, {
      modelTest: { category: "authorization", message: "invalid api key", ok: false },
      models: MODELS,
    });
    const dialog = await openSettings(page, "模型");

    await dialog.getByRole("button", { name: "测试连接" }).click();
    await expect(dialog.locator(".model-row-probe")).toContainText("✕ invalid api key");
  });

  test("the add form creates the provider, its model and the default in one chain", async ({ page }) => {
    const mock = await installMockApi(page, { models: MODELS });
    const dialog = await openSettings(page, "模型");

    await dialog.getByRole("button", { name: "添加模型" }).click();
    const modal = page.getByRole("dialog", { name: "添加模型" });
    await modal.getByLabel("基础URL").fill("https://gateway.example/v1");
    await modal.getByLabel("API key").fill("sk-test");
    await modal.getByPlaceholder("例如 deepseek-chat").fill("deepseek-chat");
    await modal.getByRole("button", { name: "测试连接" }).click();
    await expect(modal.locator(".test-result")).toContainText("✓ 连接成功（12 ms）");

    await modal.getByRole("button", { name: "保存", exact: true }).click();
    await expect(modal).toBeHidden();
    await expect(dialog.locator(".model-row").filter({ hasText: "deepseek-chat" })).toBeVisible();
    await expect(dialog.locator(".model-row").filter({ hasText: "deepseek-chat" })).toContainText("主模型");

    expect(mock.calls.some((call) => call.method === "POST" && call.path === "/api/providers")).toBe(true);
    expect(
      mock.calls.some((call) => call.method === "POST" && /^\/api\/providers\/[^/]+\/models$/u.test(call.path)),
    ).toBe(true);
    expect(writeCall(mock, "PUT", "/api/settings")).toMatchObject({ modelId: "model-2" });
  });

  test("a profile that fails its test is saved but never becomes the default", async ({ page }) => {
    const mock = await installMockApi(page, {
      modelTest: { category: "authorization", message: "key rejected", ok: false },
      models: MODELS,
    });
    const dialog = await openSettings(page, "模型");

    await dialog.getByRole("button", { name: "添加模型" }).click();
    const modal = page.getByRole("dialog", { name: "添加模型" });
    await modal.getByLabel("基础URL").fill("https://gateway.example/v1");
    await modal.getByLabel("API key").fill("sk-bad");
    await modal.getByPlaceholder("例如 deepseek-chat").fill("bad-model");
    await modal.getByRole("button", { name: "保存", exact: true }).click();

    await expect(modal).toBeVisible();
    // The form prints the provider's message as it came; it only adds the
    // category fallback when the message is empty.
    await expect(modal.locator(".test-result")).toHaveText("key rejected");
    expect(mock.calls.some((call) => call.method === "PUT" && call.path === "/api/settings")).toBe(false);
  });

  test("a row's delete asks first, and the row leaves only with the request", async ({ page }) => {
    const mock = await installMockApi(page, { models: MODELS });
    const dialog = await openSettings(page, "模型");
    const row = dialog.locator(".model-row").filter({ hasText: "qwen-max" });

    await row.getByRole("button", { name: "删除" }).click();
    const confirm = page.getByRole("dialog", { name: "删除模型「Qwen Max」？" });
    await expect(confirm).toBeVisible();
    // Nothing is written until the confirmation is accepted.
    expect(mock.calls.some((call) => call.method === "DELETE")).toBe(false);

    // See the note on the 专家 delete case: the settings overlay covers the
    // confirmation's backdrop, so the button is activated by keyboard.
    await confirm.getByRole("button", { name: "删除" }).press("Enter");

    await expect(row).toHaveCount(0);
    expect(mock.calls.some((call) => call.method === "DELETE" && call.path === "/api/models/model-1")).toBe(true);
  });
});
