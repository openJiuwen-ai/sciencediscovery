/**
 * E2E-META
 * Purpose: Exercise the Desktop settings interactions journey against the deterministic API fixture.
 * Steps:
 *   1. Open the Desktop browser entry and drive the user-facing interaction.
 *   2. Assert the resulting UI state and fixture-side request or persistence effect.
 * Environment: Isolated Desktop Vite app with deterministic local API mocks.
 * Type: mocked
 * LLM: none; model behavior is deterministic fixture data.
 * WebSearch: none
 * PaperSources: none
 * MCP: deterministic fixture responses only where the journey requires them.
 * OtherExternal: none
 * Credentials: none
 * CostSideEffects: none
 */
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
import { expect, test as base, type Locator, type Page } from "@playwright/test";

import { createJourneyReporter, type JourneyReporter } from "../../../test/helpers/journey-report.ts";

import { LOCALE_STORAGE_KEY } from "../src/state/storage.js";
import {
  TOKEN,
  TOKEN_STORAGE_KEY,
  installMockApi,
  type JsonRecord,
  type ModelRecord,
  type Mock,
} from "./fixtures.js";

const test = base.extend<{ journey: JourneyReporter }>({
  journey: async ({ page }, use, info) => {
    const reporter = createJourneyReporter(page, info);
    try {
      await use(reporter);
    } finally {
      await reporter.finalize();
    }
  },
});

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

async function openSettings(page: Page, group: string, settingsLabel = "设置"): Promise<Locator> {
  await page.goto("/");
  await page.getByRole("button", { name: settingsLabel, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: settingsLabel });
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

  test("create the first specialist, discard a draft and save with defaults", async ({ page: browser }) => {
    await browser.addInitScript((key) => localStorage.setItem(key, "en"), LOCALE_STORAGE_KEY);
    const mock = await installMockApi(browser);
    const form = browser.getByRole("dialog", { name: "Add specialist" });
    await test.step("1. Open Add specialist from an empty catalog and discard a draft", async () => {
      const dialog = await openSettings(browser, "Specialists", "Settings");
      const add = dialog.getByRole("button", { name: "Add specialist" });
      // The built-in Review expert is always listed; the empty catalogue has
      // no "No specialists yet." line any more.
      await expect(dialog.getByTestId("built-in-reviewer")).toContainText("Review");
      await add.click();
      await form.getByRole("textbox", { name: "Name" }).fill("Discard this draft");
      await form.getByRole("combobox", { name: "Runtime" }).selectOption("codex");
      await form.getByRole("button", { name: "Cancel" }).click();
      await expect(form).toBeHidden();
      expect(writeCall(mock, "POST", "/api/specialists")).toBeUndefined();
      await add.click();
    });

    await test.step("2. Enter the required fields and save a Native specialist", async () => {
      const name = form.getByRole("textbox", { name: "Name" });
      const description = form.getByRole("textbox", { name: "Description" });
      const instructions = form.getByRole("textbox", { name: "Instructions" });
      const save = form.getByRole("button", { name: "Save", exact: true });
      await expect(name).toBeFocused();
      await expect(name).toHaveValue("");
      await expect(description).toHaveValue("");
      await expect(instructions).toHaveValue("");
      await expect(description).toHaveAttribute("maxlength", "500");
      await expect(instructions).toHaveAttribute("maxlength", "20000");
      await expect(form.getByRole("combobox", { name: "Runtime" })).toHaveValue("native");
      await expect(form.getByRole("radio", { name: /Full access/u })).toBeChecked();
      await expect(save).toBeDisabled();
      await name.fill("  Data quality reviewer  ");
      await description.fill("Checks missing values");
      await instructions.fill("   ");
      await expect(save).toBeDisabled();
      await instructions.fill("  Report anomalies with evidence.  ");
      await save.click();
      await expect(form).toBeHidden();
      await expect(browser.locator(".settings-card").filter({ hasText: "Data quality reviewer" })).toBeVisible();
      expect(mock.calls.filter((call) => call.method === "POST" && call.path === "/api/specialists")).toHaveLength(1);
      expect(writeCall(mock, "POST", "/api/specialists")).toEqual({
        connectorIds: [],
        description: "Checks missing values",
        enabledSkillIds: [],
        instructions: "Report anomalies with evidence.",
        name: "Data quality reviewer",
        runtime: { kind: "native" },
      });
    });
  });

  test("retry a refused specialist creation and find the new expert in the session picker", async ({ page: browser }) => {
    const options = {
      ...page(),
      fail: { message: "Specialist name already exists", method: "POST", path: "/api/specialists", status: 400 },
      hold: { method: "POST", path: "/api/specialists" },
    };
    const mock = await installMockApi(browser, options);
    const dialog = await openSettings(browser, "专家");
    const form = browser.getByRole("dialog", { name: "新增专家" });
    const save = form.getByRole("button", { name: "保存", exact: true });
    const name = form.getByRole("textbox", { name: "名称" });

    await test.step("1. Set up a new expert with an external runtime and specific capabilities", async () => {
      await dialog.getByRole("button", { name: "新增专家" }).click();
      await name.fill("晶体专家");
      await form.getByRole("textbox", { name: "描述" }).fill("复核文献引用");
      await form.getByRole("textbox", { name: "指令" }).fill("对照原文核对引用。");
      await form.getByRole("combobox", { name: "运行时" }).selectOption("codex");
      await form.locator(".settings-row", { hasText: "模型" }).locator("input").fill("gpt-5");
      await form.getByRole("button", { name: "添加技能" }).click();
      const picker = browser.getByRole("dialog", { name: "添加技能和连接器" });
      await picker.getByRole("checkbox", { name: /文献检索/u }).check();
      await picker.getByRole("tab", { name: /连接器/u }).click();
      await picker.getByRole("checkbox", { name: /PubMed/u }).check();
      await picker.getByRole("button", { name: "添加", exact: true }).click();
      await expect(picker).toBeHidden();
    });

    await test.step("2. Keep the draft on a duplicate name error and save with a different name", async () => {
      await save.click();
      await expect(save).toBeDisabled();
      await expect(form.getByRole("button", { name: "取消" })).toBeDisabled();
      await browser.keyboard.press("Escape");
      await expect(form).toBeVisible();
      mock.release();
      await expect(form.getByRole("alert")).toHaveText("Specialist name already exists");
      await expect(name).toHaveValue("晶体专家");
      await expect(form.getByRole("textbox", { name: "指令" })).toHaveValue("对照原文核对引用。");
      await expect(form.getByRole("combobox", { name: "运行时" })).toHaveValue("codex");
      options.fail.path = "/not-this-request";
      await name.fill("文献核查专家");
      await save.click();
      await expect(form).toBeHidden();
      await expect(dialog.locator(".settings-card").filter({ hasText: "文献核查专家" })).toBeVisible();
      expect(mock.calls.filter((call) => call.method === "POST" && call.path === "/api/specialists")).toHaveLength(2);
      expect(lastWriteCall(mock, "POST", "/api/specialists")).toMatchObject({
        connectorIds: ["connector-1"],
        description: "复核文献引用",
        enabledSkillIds: ["skill-1"],
        name: "文献核查专家",
        runtime: { kind: "codex", model: "gpt-5" },
      });
    });

    await test.step("3. Find the new expert without changing the current selection", async () => {
      await browser.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await browser.getByRole("button", { name: "会话设置" }).click();
      await browser.getByRole("button", { name: /^专家/u }).click();
      await expect(browser.getByRole("button", { name: /文献核查专家/u })).toBeVisible();
      await expect(browser.getByRole("button", { name: "无", exact: true })).toHaveAttribute("aria-current", "true");
    });
  });

  test("a specialist's form writes its runtime and the capabilities picked in it", async ({ page: browser }) => {
    const mock = await installMockApi(browser, page());
    const dialog = await openSettings(browser, "专家");

    const card = dialog.locator(".settings-card").filter({ hasText: "晶体专家" });
    await card.getByRole("button", { name: "「晶体专家」的操作" }).click();
    await card.getByRole("menuitem", { name: "编辑" }).click();
    const form = browser.getByRole("dialog", { name: "编辑专家" });
    await expect(form).toBeVisible();
    // A specialist with no explicit lists has been inheriting everything, which
    // the form shows as 完全访问 rather than as two empty lists.
    await expect(form.getByRole("radio", { name: /完全访问/u })).toBeChecked();

    await form.getByLabel("描述").fill("看分子结构");
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
    await card.getByRole("button", { name: "「晶体专家」的操作" }).click();
    await expect(card.getByRole("menuitem")).toHaveText(["编辑", "删除"]);
    await card.getByRole("menuitem", { name: "编辑" }).click();
    const form = browser.getByRole("dialog", { name: "编辑专家" });
    await form.getByLabel("名称").fill("晶体专家（改）");
    await form.getByRole("button", { name: "保存", exact: true }).click();

    await expect(dialog.locator(".settings-card").filter({ hasText: "晶体专家（改）" })).toBeVisible();
    expect(writeCall(mock, "PUT", "/api/specialists/specialist-1")).toMatchObject({
      name: "晶体专家（改）",
    });

    const renamed = dialog.locator(".settings-card").filter({ hasText: "晶体专家（改）" });
    await renamed.getByRole("button", { name: "「晶体专家（改）」的操作" }).click();
    await renamed.getByRole("menuitem", { name: "删除" }).click();
    const confirm = browser.getByRole("dialog", { name: "删除专家「晶体专家（改）」？" });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "删除" }).click();

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

  test("a partial bulk failure reloads the rows already saved", async ({ page: browser }) => {
    await installMockApi(browser, {
      ...page(),
      specialists: [specialist({ id: "custom-a", name: "先保存的专家" }), specialist({ id: "custom-b", name: "保存失败的专家" })],
      fail: { message: "Bulk save refused", method: "PUT", path: "/api/specialists/custom-b", status: 500 },
    });
    const dialog = await openSettings(browser, "专家");
    await dialog.getByRole("button", { name: "一键关闭", exact: true }).click();
    await expect(dialog.locator(".row-note.is-error")).toHaveText("Bulk save refused");
    await expect(dialog.locator(".settings-card").filter({ hasText: "先保存的专家" }).getByRole("switch")).toHaveAttribute("aria-checked", "false");
    await expect(dialog.locator(".settings-card").filter({ hasText: "保存失败的专家" }).getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });

  test("a rejected save keeps the form and names the reason", async ({ page: browser }) => {
    await installMockApi(browser, {
      ...page(),
      fail: { message: "name already exists", method: "PUT", path: "/api/specialists/specialist-1" },
    });
    const dialog = await openSettings(browser, "专家");

    const card = dialog.locator(".settings-card").filter({ hasText: "晶体专家" });
    await card.getByRole("button", { name: "「晶体专家」的操作" }).click();
    await card.getByRole("menuitem", { name: "编辑" }).click();
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

  /**
   * E2E-META
   * Purpose: Create a custom MCP server from an empty desktop settings list.
   * Steps:
   *   1. Open the form, inspect the defaults, and cancel a draft.
   *   2. Reopen the form and save a local server, retrying after a failed write.
   *   3. Test the saved server and verify it was not selected for sessions.
   * Environment: Desktop browser with the local mocked control plane.
   * Type: mocked
   * LLM: none
   * WebSearch: none
   * PaperSources: none
   * MCP: mocked settings and connection test only
   * OtherExternal: none
   * Credentials: local fixture token only
   * CostSideEffects: in-memory browser fixture only
   */
  test("creates and tests a custom server from an empty list", async ({ page, journey }) => {
    const mock = await installMockApi(page);
    journey.scenario({ goal: "Add a custom MCP server in desktop settings", preconditions: ["Empty MCP list"] });
    const settings = await openSettings(page, "MCP 服务器");
    const create = settings.getByRole("button", { name: "新增 MCP 服务器", exact: true });
    const form = page.getByRole("dialog", { name: "新增 MCP 服务器" });
    const name = form.getByRole("textbox", { name: "名称", exact: true });
    const transport = form.getByLabel("传输方式");
    const save = form.getByRole("button", { name: "确认添加", exact: true });

    await journey.step("Open and discard a new MCP configuration", "The empty list offers a blank form with the documented defaults.", async () => {
      await expect(settings.getByText("暂无可用的内置或自定义 MCP 来源。")).toBeVisible();
      await create.click();
      await settings.getByRole("menuitem", { name: "手动填写", exact: true }).click();
      await expect(form.getByRole("switch", { name: "启用服务" })).not.toBeChecked();
      await expect(form.getByRole("spinbutton", { name: "超时（秒）" })).toHaveValue("60");
      await expect(transport).toHaveValue("http");
      await name.fill("Discarded server");
      await form.getByRole("button", { name: "取消", exact: true }).click();
      await expect(form).toBeHidden();
    });

    await journey.step("Create a local MCP server after a refused save", "The draft survives the error, and a retry creates exactly one server.", async () => {
      await create.click();
      await settings.getByRole("menuitem", { name: "手动填写", exact: true }).click();
      await expect(name).toHaveValue("");
      await name.fill("Local Echo");
      await transport.selectOption("stdio");
      await form.getByRole("textbox", { name: "命令", exact: true }).fill("node");
      const args = form.getByRole("textbox", { name: "参数", exact: true });
      const scriptPath = "/srv/my MCP server/echo.mjs";
      await args.fill(`${scriptPath}\n--quiet`);
      await page.route("**/api/mcp/servers", async (route) => {
        await route.fulfill({ status: 503, json: { error: "保存服务暂不可用" } });
      }, { times: 1 });
      await save.click();
      await expect(form.getByRole("alert")).toContainText("保存服务暂不可用");
      await expect(name).toHaveValue("Local Echo");
      await expect(args).toHaveValue(`${scriptPath}\n--quiet`);
      await save.click();
      await expect(form).toBeHidden();
      await expect(settings.locator(".settings-card").filter({ hasText: "Local Echo" })).toBeVisible();
      expect(mock.state.mcpServers).toHaveLength(1);
      expect(writeCall(mock, "POST", "/api/mcp/servers")).toMatchObject({
        args: [scriptPath, "--quiet"], command: "node", enabled: false,
        name: "Local Echo", timeoutSeconds: 60, transport: "stdio",
      });
    });

    await journey.step("Test the saved connection", "The server can be tested without changing which sources sessions use by default.", async () => {
      const card = settings.locator(".settings-card").filter({ hasText: "Local Echo" });
      await card.getByRole("button", { name: "测试", exact: true }).click();
      await expect(page.locator(".toast-info").filter({ hasText: "连接测试成功" })).toBeVisible();
      await expect(card.getByRole("switch", { name: "Local Echo · 启用服务" })).not.toBeChecked();
      expect(mock.state.mcpServers[0]?.enabled).toBe(false);
    });
  });

  test("a custom server is written whole, with its env and transport", async ({ page }) => {
    const mock = await installMockApi(page, { mcpServers: [mcpServer()], mcpSources: sources });
    const dialog = await openSettings(page, "MCP 服务器");

    // Custom and built-in servers share one page: the ones the user added are
    // listed first, and the product's own follow with a switch instead of
    // edit/delete, because they have no record of their own.
    await expect(dialog.locator(".settings-card").filter({ hasText: "内置检索" })).toBeVisible();

    const card = dialog.locator(".settings-card").filter({ hasText: "检索服务" });
    await card.getByRole("button", { name: "检索服务的更多操作" }).click();
    await card.getByRole("menuitem", { name: "编辑", exact: true }).click();
    const form = page.getByRole("dialog", { name: "编辑服务器" });
    await form.getByLabel("说明", { exact: true }).fill("跑在本地");
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
    await expect(page.locator(".toast-info").filter({ hasText: "连接测试成功" })).toBeVisible();
    expect(mock.calls.some((call) => call.method === "POST" && call.path === "/api/mcp/servers/mcp-1/test")).toBe(
      true,
    );

    const selection = card.getByRole("switch", { name: "检索服务 · 启用服务" });
    await expect(selection).toHaveAttribute("aria-checked", "true");
    for (const enabled of [false, true]) {
      await card.getByRole("button", { name: "检索服务的更多操作" }).click();
    await card.getByRole("menuitem", { name: "编辑", exact: true }).click();
      const form = page.getByRole("dialog", { name: "编辑服务器" });
      await form.getByRole("switch", { name: "启用服务", exact: true }).setChecked(enabled);
      await form.getByRole("button", { name: "保存", exact: true }).click();
      await expect(form).toBeHidden();
      await expect(card.getByRole("button", { name: "检索服务的更多操作" })).toBeEnabled();
      expect(lastWriteCall(mock, "PUT", "/api/mcp/servers/mcp-1")).toMatchObject({ enabled });
      expect(mock.state.mcpServers[0]?.enabled).toBe(enabled);
      await expect(selection).toHaveAttribute("aria-checked", String(enabled));
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
    const details = page.getByRole("dialog", { name: "服务器详情", exact: true });
    const custom = () => details.getByRole("switch", { name: "默认使用", exact: true });
    const openCustom = async () => { await dialog.getByRole("button", { name: "查看检索服务详情", exact: true }).click(); };
    await expect(builtin()).toHaveAttribute("aria-checked", "false");
    await builtin().click();
    await expect(builtin()).toHaveAttribute("aria-checked", "true");
    await openCustom();
    await custom().click();
    await expect(custom()).toHaveAttribute("aria-checked", "true");
    expect(lastWriteCall(mock, "PUT", "/api/settings")).toMatchObject({
      enabledConnectorIds: ["web", "builtin-search", "mcp-1"], plugins,
    });
    expect(mock.state.mcpServers[0]?.enabled).toBe(false);
    expect(mock.calls.some((call) => call.method === "PUT" && call.path.startsWith("/api/mcp/servers/"))).toBe(false);

    await page.keyboard.press("Escape");
    // A fresh page reads the stored selection, including a source whose
    // permission still prohibits calls. Selection never grants permission.
    dialog = await openSettings(page, "MCP 服务器");
    await expect(builtin()).toHaveAttribute("aria-checked", "true");
    await openCustom();
    await expect(custom()).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await builtin().click();
    await expect(builtin()).toHaveAttribute("aria-checked", "false");
    await openCustom();
    await custom().click();
    await expect(custom()).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Escape");
    dialog = await openSettings(page, "MCP 服务器");
    await expect(builtin()).toHaveAttribute("aria-checked", "false");
    await openCustom();
    await expect(custom()).toHaveAttribute("aria-checked", "false");
    expect(mock.state.overrides.enabledConnectorIds).toEqual(["web"]);
    expect(mock.state.overrides.plugins).toEqual(plugins);
  });

  test("bulk enablement preserves unlisted defaults and unrelated overrides", async ({ page }) => {
    const plugins = { "connector.builtin-search": { enabled: false } };
    const mock = await installMockApi(page, { mcpServers: [mcpServer({ enabled: false })], mcpSources: sources,
      overrides: { enabledConnectorIds: ["unlisted"], plugins } });
    const dialog = await openSettings(page, "MCP 服务器");
    const custom = dialog.getByRole("switch", { name: "检索服务 · 启用服务" });
    await dialog.getByRole("button", { name: "一键启用", exact: false }).click();
    await expect(custom).toBeChecked();
    await dialog.getByRole("button", { name: "一键关闭", exact: false }).click();
    await expect(custom).not.toBeChecked();
    expect(mock.state.overrides).toMatchObject({ enabledConnectorIds: ["unlisted"], plugins });
    expect(mock.calls.filter((call) => call.method === "PUT" && call.path === "/api/settings")).toHaveLength(0);
    expect(mock.state.mcpServers[0]?.enabled).toBe(false);
  });

  test("a rejected default selection keeps the saved value and allows retry", { tag: "@ui-st" }, async ({ page }) => {
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

    const card = dialog.locator(".mcp-server-card").filter({ hasText: "检索服务" });
    await card.getByRole("button", { name: "检索服务的更多操作" }).click();
    await card.getByRole("menuitem", { name: "编辑", exact: true }).click();
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

    await card.getByRole("button", { name: "检索服务的更多操作" }).click();
    await card.getByRole("menuitem", { name: "删除", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "删除服务器「检索服务」？" });
    // See the note on the 专家 delete case: the settings overlay covers the
    // confirmation's backdrop, so the button is activated by keyboard.
    await confirm.getByRole("button", { name: "删除" }).press("Enter");

    await expect(dialog.locator(".settings-card").filter({ hasText: "检索服务" })).toHaveCount(0);
    expect(mock.calls.some((call) => call.method === "DELETE" && call.path === "/api/mcp/servers/mcp-1")).toBe(true);
  });
});

test.describe("超时", () => {
  async function openTimeouts(page: Page, over: JsonRecord = {}) {
    const mock = await installMockApi(page, { models: MODELS, ...over });
    const dialog = await openSettings(page, "超时");
    return { dialog, mock };
  }

  const ORDER_NOTE = "单轮超时不能短于网关空闲超时";

  test("states the ordering rule and writes a value in milliseconds when its field is left", async ({ page }) => {
    const { dialog, mock } = await openTimeouts(page);

    // The rule the service enforces is on the field the reader edits, so a
    // refused pair is not the first time they hear about it.
    await expect(dialog.getByText(/两者都设置时，单轮时限不短于网关空闲时限/u)).toBeVisible();

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

    // The switch is not a draft at all: it writes on the press, and the value
    // it restores is one the pair still accepts — the idle limit here, not a
    // fixed 60 s the service would refuse against it.
    const unlimited = dialog.getByRole("switch", { name: "单轮超时 · 不限" });
    await expect(unlimited).toHaveAttribute("aria-checked", "true");
    await unlimited.click();
    const turn = dialog.getByRole("spinbutton", { name: "单轮超时" });
    await expect(turn).toHaveValue("90");
    await expect
      .poll(() => lastWriteCall(mock, "PUT", "/api/timeout-settings"))
      .toMatchObject({ gatewayIdleTimeoutMs: 90_000, gatewayTurnTimeoutMs: 90_000 });
    await expect(turn).not.toHaveAttribute("aria-invalid", "true");
    await expect(dialog.locator(".row-note.is-error")).toHaveCount(0);
  });

  test("refuses a turn limit below the idle limit at the field, without a write", async ({ page }) => {
    const { dialog, mock } = await openTimeouts(page, {
      timeouts: { gatewayIdleTimeoutMs: 240_000, gatewayTurnTimeoutMs: 60_000 },
    });

    const turn = dialog.getByRole("spinbutton", { name: "单轮超时" });
    await expect(turn).toHaveValue("60");
    await turn.fill("30");
    await turn.blur();

    // The page refuses the pair itself: the draft stays where the reader can
    // correct it, the field says why, and nothing is put on the wire.
    await expect(turn).toHaveValue("30");
    await expect(turn).toHaveAttribute("aria-invalid", "true");
    await expect(dialog.locator(".row-note.is-error")).toContainText(ORDER_NOTE);
    expect(mock.calls.some((call) => call.method === "PUT" && call.path === "/api/timeout-settings")).toBe(false);

    // Correcting the draft writes the pair and clears the mark.
    await turn.fill("240");
    await turn.blur();
    await expect
      .poll(() => lastWriteCall(mock, "PUT", "/api/timeout-settings"))
      .toMatchObject({ gatewayIdleTimeoutMs: 240_000, gatewayTurnTimeoutMs: 240_000 });
    await expect(turn).not.toHaveAttribute("aria-invalid", "true");
    await expect(dialog.locator(".row-note.is-error")).toHaveCount(0);
  });

  test("keeps the reader's edits when the service refuses the write", async ({ page }) => {
    const { dialog, mock } = await openTimeouts(page, {
      failOnce: {
        message: "gatewayTurnTimeoutMs must be greater than or equal to gatewayIdleTimeoutMs when both timeouts are finite",
        method: "PUT",
        path: "/api/timeout-settings",
      },
      timeouts: { gatewayIdleTimeoutMs: 240_000, gatewayTurnTimeoutMs: 60_000 },
    });

    const idle = dialog.getByRole("spinbutton", { name: "网关空闲超时" });
    const turn = dialog.getByRole("spinbutton", { name: "单轮超时" });
    await idle.fill("30");
    await idle.blur();

    // The reader gets a sentence about their two timeouts, not the store's
    // field names, and the field the refusal names is the one marked.
    await expect(dialog.locator(".row-note.is-error")).toContainText(ORDER_NOTE);
    await expect(dialog.getByText(/gatewayTurnTimeoutMs/u)).toHaveCount(0);
    await expect(turn).toHaveAttribute("aria-invalid", "true");
    // The idle edit was not what the refusal named, so it is still theirs.
    await expect(idle).toHaveValue("30");

    // The retry carries both edits: nothing the reader changed was reverted.
    await turn.fill("240");
    await turn.blur();
    await expect
      .poll(() => lastWriteCall(mock, "PUT", "/api/timeout-settings"))
      .toMatchObject({ gatewayIdleTimeoutMs: 30_000, gatewayTurnTimeoutMs: 240_000 });
    await expect(dialog.locator(".row-note.is-error")).toHaveCount(0);
  });

  for (const locale of [
    { id: "zh-CN", group: "超时", idle: "网关空闲超时", rule: "两者都设置时，单轮时限不短于网关空闲时限", saved: "已保存", settings: "设置", turn: "单轮超时", unlimited: "不限" },
    { id: "en", group: "Timeouts", idle: "Gateway idle timeout", rule: "When both are set, the turn limit is at least the idle limit", saved: "Saved", settings: "Settings", turn: "Turn timeout", unlimited: "Unlimited" },
  ] as const) {
    test(`the ordering note keeps its own line and leaves the hint its width (${locale.id})`, async ({ page }) => {
      await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [LOCALE_STORAGE_KEY, locale.id]);
      const mock = await installMockApi(page, {
        models: MODELS,
        timeouts: { gatewayIdleTimeoutMs: 120_000, gatewayTurnTimeoutMs: 0 },
      });
      await page.setViewportSize({ width: 1280, height: 900 });
      const dialog = await openSettings(page, locale.group, locale.settings);
      await expect(dialog.getByText(locale.rule)).toBeVisible();

      // The turn limit starts unlimited; turning it off seeds the idle limit,
      // and a shorter value produces the note under the row.
      await dialog.getByRole("switch", { name: `${locale.turn} · ${locale.unlimited}` }).click();
      const turn = dialog.getByRole("spinbutton", { name: locale.turn });
      await expect(turn).toHaveValue("120");
      await expect(dialog.locator(".settings-detail-meta")).toContainText(locale.saved);
      await turn.fill("30");
      await turn.blur();
      await expect(turn).toHaveAttribute("aria-invalid", "true");

      const row = dialog.locator(".settings-row").filter({ hasText: locale.turn });
      const hint = row.locator(".row-title small");
      const note = row.locator(".row-note.is-error");
      await expect(note).toBeVisible();
      expect(writeCall(mock, "PUT", "/api/timeout-settings")).toMatchObject({ gatewayTurnTimeoutMs: 120_000 });

      for (const width of [1280, 960]) {
        await page.setViewportSize({ width, height: 900 });
        const [hintBox, noteBox] = await Promise.all([hint.boundingBox(), note.boundingBox()]);
        if (hintBox === null || noteBox === null) {
          throw new Error(`${locale.id}@${width}: expected hint and note boxes`);
        }
        // The hint column keeps a readable width instead of collapsing to the
        // note's max-content width.
        expect(hintBox.width, `${locale.id}@${width}: hint squeezed`).toBeGreaterThan(120);
        // The note is a line under the row, not text across the hint.
        expect(noteBox.y, `${locale.id}@${width}: note is not under the hint`).toBeGreaterThanOrEqual(
          hintBox.y + hintBox.height - 1,
        );
        const overlaps = hintBox.x < noteBox.x + noteBox.width
          && noteBox.x < hintBox.x + hintBox.width
          && hintBox.y < noteBox.y + noteBox.height
          && noteBox.y < hintBox.y + hintBox.height;
        expect(overlaps, `${locale.id}@${width}: note overlaps the hint`).toBe(false);
        // And the row itself does not overflow horizontally.
        const overflow = await row.evaluate((element) => element.scrollWidth - element.clientWidth);
        expect(overflow, `${locale.id}@${width}: row overflows`).toBeLessThanOrEqual(1);
      }

      // And the timestamp from the seed write no longer describes this draft.
      await expect(dialog.locator(".settings-detail-meta")).not.toContainText(locale.saved);
    });
  }

  test("a refused write says why and keeps the draft", async ({ page }) => {
    const { dialog } = await openTimeouts(page, {
      fail: { message: "quota exceeded", method: "PUT", path: "/api/timeout-settings" },
    });

    const idle = dialog.getByRole("spinbutton", { name: "网关空闲超时" });
    await idle.fill("90");
    await idle.blur();

    await expect(dialog.locator(".row-note.is-error")).toHaveText("quota exceeded");
    // A failure the page cannot attribute keeps the draft visible with the
    // reason beside it, instead of silently restoring the stored values.
    await expect(idle).toHaveValue("90");
  });

  test("leaving a pane keeps what was written, because there is no draft to drop", async ({ page }) => {
    const { dialog } = await openTimeouts(page);

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
      await expect(dialog.locator(".settings-card").filter({ hasText: "xlsx" })).toContainText("内置");
      await expect(dialog.locator(".settings-card").filter({ hasText: "local-tool" })).toContainText("外部");
      await expect(dialog.getByRole("switch", { name: "启用或停用「xlsx」" })).toHaveAttribute("aria-checked", "true");
      await expect(dialog.getByRole("switch", { name: "启用或停用「local-tool」" })).toHaveAttribute("aria-checked", "false");
    });
    await test.step("2. Disable the built-in and enable the local skill", async () => {
      await dialog.getByRole("switch", { name: "启用或停用「xlsx」" }).click();
      await expect(dialog.getByRole("switch", { name: "启用或停用「xlsx」" })).toHaveAttribute("aria-checked", "false");
      await dialog.getByRole("switch", { name: "启用或停用「local-tool」" }).click();
      await expect(dialog.getByRole("switch", { name: "启用或停用「local-tool」" })).toHaveAttribute("aria-checked", "true");
      await page.screenshot({ path: testInfo.outputPath("jiuwenswarm-skills.png") });
    });
    await test.step("3. Reload and verify both saved switches", async () => {
      await page.reload();
      dialog = await openSettings(page, "技能");
      await expect(dialog.getByRole("switch", { name: "启用或停用「xlsx」" })).toHaveAttribute("aria-checked", "false");
      await expect(dialog.getByRole("switch", { name: "启用或停用「local-tool」" })).toHaveAttribute("aria-checked", "true");
    });
  });

  test("a bulk press moves every row before the write answers", async ({ page }, testInfo) => {
    const catalog = Array.from({ length: 4 }, (_, index) => skill({
      description: `A catalog skill ${index + 1}`,
      id: `skill-${index + 1}`,
      name: `技能 ${index + 1}`,
    }));
    const mock = await installMockApi(page, {
      // The write is held open: what the page shows while it is in flight is
      // the thing the press promises, not something the answer painted.
      hold: { method: "PUT", path: "/api/jiuwenswarm/skills-batch" },
      models: MODELS,
      skills: catalog,
      jiuwenSwarmSkills: [
        ...catalog.map((entry) => ({
          description: entry.description,
          enabled: true,
          name: entry.id,
          skillId: entry.id,
          source: "sciencediscovery",
        })),
        { name: "xlsx", description: "Read spreadsheets", enabled: true, source: "builtin" },
        { name: "pdf", description: "Read papers", enabled: true, source: "builtin" },
      ],
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    const dialog = await openSettings(page, "技能");
    await expect(dialog.locator(".settings-card")).toHaveCount(6);
    await expect(dialog.getByRole("switch", { checked: true })).toHaveCount(6);
    // The whole list is in the shot: a screenshot of a scrolled pane would
    // say "every switch moved" while showing a few rows.
    await expect(dialog.locator(".settings-card").last()).toBeInViewport();

    await dialog.getByRole("button", { name: "一键关闭", exact: true }).click();

    // Still before the batch answers: every switch and tag already reads Off,
    // both bulk buttons are busy, and no row accepts a second writable press.
    await expect(dialog.getByRole("switch", { checked: true })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "一键启用", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "一键关闭", exact: true })).toBeDisabled();
    await expect(dialog.locator(".switch:disabled")).toHaveCount(6);
    await dialog.locator(".settings-group-detail").screenshot({
      animations: "disabled",
      path: testInfo.outputPath("disable-all-in-flight.png"),
    });

    mock.release();
    await expect(dialog.getByRole("button", { name: "一键关闭", exact: true })).toBeEnabled();
    await expect(dialog.getByRole("switch", { checked: true })).toHaveCount(0);
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
    await expect(dialog.getByRole("switch", { name: "启用或停用「xlsx」", exact: true })).toHaveAttribute("aria-checked", "false");
    await expect(dialog.getByRole("switch", { name: "启用或停用「SD spreadsheets」", exact: true })).toHaveAttribute("aria-checked", "true");
    expect(writeCall(mock, "PUT", /^\/api\/jiuwenswarm\/skills\/xlsx$/u)).toEqual({ enabled: false });
    await dialog.getByRole("button", { name: "一键关闭", exact: true }).click();
    await expect(dialog.getByRole("switch", { checked: true })).toHaveCount(0);
    // One write for both rows, not one per skill: the catalog row brings the
    // JiuwenSwarm name it is installed as, and the built-in its own name.
    expect(writeCall(mock, "PUT", "/api/jiuwenswarm/skills-batch")).toMatchObject({
      enabled: false,
      targets: [{ name: "sciencediscovery-xlsx", skillId: "xlsx" }, { name: "xlsx" }],
    });
    expect(mock.calls.some((call) => call.path.includes("skills-by-id"))).toBe(false);
    await dialog.getByRole("button", { name: "一键启用", exact: true }).click();
    await expect(dialog.getByRole("switch", { checked: true })).toHaveCount(2);
    expect(lastWriteCall(mock, "PUT", "/api/jiuwenswarm/skills-batch")).toMatchObject({ enabled: true });
  });

  test("a refused built-in switch keeps its saved state and reports the failure", async ({ page }, testInfo) => {
    const mock = await installMockApi(page, {
      models: MODELS, skills, skillBatchFailures: ["xlsx"], skillToggleFailures: ["xlsx"],
      jiuwenSwarmSkills: [{ name: "xlsx", description: "Native spreadsheets", enabled: true, source: "builtin" }],
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    const dialog = await openSettings(page, "技能");
    await expect(dialog.locator(".settings-card")).toHaveCount(3);
    await dialog.getByRole("button", { name: "一键关闭", exact: true }).click();
    // The bulk answer is per target: only the refused row reports, and it is
    // back at the value the server still holds while the rest moved.
    await expect(dialog.getByRole("switch", { name: "启用或停用「xlsx」", exact: true })).toHaveAttribute("aria-checked", "true");
    await expect(dialog).toContainText("xlsx: Skill switch failed");
    await expect(dialog.getByRole("switch", { name: "启用或停用「分子绘图」", exact: true })).toHaveAttribute("aria-checked", "false");
    await expect(dialog.getByRole("switch", { name: "启用或停用「文献检索」", exact: true })).toHaveAttribute("aria-checked", "false");
    expect(writeCall(mock, "PUT", "/api/jiuwenswarm/skills-batch")).toMatchObject({ enabled: false });
    await dialog.locator(".settings-group-detail").screenshot({
      animations: "disabled",
      path: testInfo.outputPath("bulk-refused-row.png"),
    });
    await dialog.getByRole("switch", { name: "启用或停用「xlsx」", exact: true }).click();
    await expect(dialog).toContainText("Skill switch failed");
    await expect(dialog.getByRole("switch", { name: "启用或停用「xlsx」", exact: true })).toBeChecked();
    await dialog.locator(".settings-group-detail").screenshot({
      animations: "disabled",
      path: testInfo.outputPath("single-switch-refused.png"),
    });
  });

  test("a bundled skill defaults on and its first disable survives a reload", async ({ page }) => {
    const mock = await installMockApi(page, {
      models: MODELS,
      jiuwenSwarmSkills: [{ skillId: "skill-1", name: "skill-1", description: "", enabled: true, source: "sciencediscovery" }],
      skills,
    });
    const dialog = await openSettings(page, "技能");

    const card = dialog.locator(".settings-card").filter({ hasText: "分子绘图" });
    await expect(card.getByRole("switch", { name: "启用或停用「分子绘图」" })).toHaveAttribute("aria-checked", "true");
    await card.getByRole("switch", { name: "启用或停用「分子绘图」" }).click();
    await expect(card.getByRole("switch", { name: "启用或停用「分子绘图」" })).toHaveAttribute("aria-checked", "false");

    expect(writeCall(mock, "PUT", /^\/api\/jiuwenswarm\/skills-by-id\/skill-2$/u)).toEqual({ enabled: false });
    expect(mock.state.jiuwenSwarmSkills.find((skill) => skill.skillId === "skill-2")?.enabled).toBe(false);
    expect(mock.calls.some((call) => call.method === "PUT" && /\/projects\/[^/]+\/settings$/u.test(call.path))).toBe(false);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await page.reload();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const reopened = page.getByRole("dialog", { name: "设置" });
    await reopened.getByRole("button", { name: "技能", exact: true }).click();
    await expect(reopened.getByRole("switch", { name: "启用或停用「分子绘图」" })).toHaveAttribute("aria-checked", "false");
  });

  test("bulk enable continues after one skill fails and shows the saved state", async ({ page }) => {
    const mock = await installMockApi(page, {
      models: MODELS, skills, skillBatchFailures: ["skill-1"],
      jiuwenSwarmSkills: [{ skillId: "skill-1", name: "skill-1", description: "", enabled: false, source: "sciencediscovery" }],
    });
    const dialog = await openSettings(page, "技能");
    await expect(dialog.locator(".settings-card")).toHaveCount(2);
    await dialog.getByRole("button", { name: "一键启用", exact: true }).click();
    await expect(dialog.getByRole("switch", { name: "启用或停用「分子绘图」" })).toHaveAttribute("aria-checked", "true");
    await expect(dialog.getByRole("switch", { name: "启用或停用「文献检索」" })).toHaveAttribute("aria-checked", "false");
    await expect(dialog).toContainText("Skill switch failed");
    expect(mock.state.jiuwenSwarmSkills.find((skill) => skill.skillId === "skill-1")?.enabled).toBe(false);
    expect(mock.state.jiuwenSwarmSkills.find((skill) => skill.skillId === "skill-2")?.enabled).toBe(true);
    const batch = writeCall(mock, "PUT", "/api/jiuwenswarm/skills-batch") as { enabled: boolean; targets: unknown[] };
    expect(batch.enabled).toBe(true);
    // The second row had no JiuwenSwarm name yet, so the bulk write carries
    // only its id; the server imports it because the action enables it.
    expect(batch.targets).toEqual([{ name: "skill-1", skillId: "skill-1" }, { skillId: "skill-2" }]);
    expect(mock.calls.some((call) => call.path.includes("skills-by-id"))).toBe(false);
  });

  test("a card opens to the skill's source and instructions", async ({ page }) => {
    await installMockApi(page, {
      models: MODELS,
      projectSettings: { effective: { enabledSkillIds: [] }, overrides: {}, sources: {} },
      skills,
    });
    await page.route("**/api/skills/skill-2", route => route.fulfill({ json: {
      ...skills[1], frontmatter: { license: "Apache-2.0" }, instructions: "读取分子结构并生成图像。", resources: [],
    } }));
    const dialog = await openSettings(page, "技能");
    const card = dialog.locator(".settings-card").filter({ hasText: "分子绘图" });

    await card.locator(".settings-card-main").click();
    // The card opens the Skill's own page: the source sits beside its name,
    // and the package's instructions are the page, not a folded box.
    const detail = dialog.locator(".skill-detail-page");
    await expect(detail).toBeVisible();
    await expect(detail.locator(".skill-detail-page-tag")).toContainText("内置");
    await expect(detail.locator(".skill-detail-doc")).toContainText("读取分子结构并生成图像。");
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
    await expect(modal.locator(".test-result")).toContainText("✓ 基础检查通过（12 ms）");

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

  test("a fetched model list opens over the dialog and scrolls to every entry", async ({ page }) => {
    const listed = Array.from({ length: 30 }, (_, index) => ({
      displayName: `Model ${index}`,
      id: `model-${index}`,
    }));
    await installMockApi(page, { models: MODELS });
    // Registered after the fixture, so it answers first for this one route: a
    // provider that reports a listing long enough to need scrolling.
    await page.route("**/api/providers/preview-models", (route) => route.fulfill({
      body: JSON.stringify({ models: listed }),
      contentType: "application/json",
      status: 200,
    }));

    const dialog = await openSettings(page, "模型");
    await dialog.getByRole("button", { name: "添加模型" }).click();
    const modal = page.getByRole("dialog", { name: "添加模型" });
    await modal.getByLabel("基础URL").fill("https://gateway.example/v1");
    await modal.getByLabel("API key").fill("sk-test");
    await modal.getByRole("button", { name: "刷新列表" }).click();

    // The click asked for the listing, so it opens without another click.
    const listbox = page.getByRole("listbox", { name: "模型名称" });
    await expect(listbox).toBeVisible();
    // Portalled to <body> (through the square anchor that backs its rounded
    // corners): the dialog's `overflow-y: auto` used to clip the menu after
    // its first row, which is what made the list hard to use.
    const anchor = page.locator(".field-combo-anchor");
    expect(await anchor.evaluate((element) => element.parentElement === document.body)).toBe(true);
    const box = await page.locator(".field-combo-menu").boundingBox();
    expect(box?.height ?? 0).toBeGreaterThan(200);

    // Scrolling the list — including a wheel over it — must not close the
    // menu the way the old input `onBlur` did.
    await listbox.hover();
    await page.mouse.wheel(0, 900);
    await expect(listbox).toBeVisible();
    await listbox.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(listbox.locator(".field-combo-option").last()).toContainText("model-29");

    // The last entry is reachable and choosing it fills the field.
    await listbox.locator(".field-combo-option").last().click();
    await expect(modal.getByPlaceholder("例如 deepseek-chat")).toHaveValue("model-29");
    await expect(listbox).toHaveCount(0);

    // A click on the field itself reopens the listing (not only the caret).
    await modal.getByPlaceholder("例如 deepseek-chat").click();
    await expect(listbox).toBeVisible();

    // The caret closes the list it opened. A real pointer sequence is what
    // catches the old order: the capture-phase outside handler closed the menu
    // on the button's pointerdown, and the click that followed reopened it.
    const caret = modal.locator(".field-combo-toggle");
    await caret.click();
    await expect(listbox).toHaveCount(0);
    await caret.click();
    await expect(listbox).toBeVisible();

    // Escape still belongs to the list when focus is not in the input: a click
    // on the list's own padding leaves focus on the page, where the input's
    // keydown handler never sees the key. Only the list may close.
    const menuBox = await page.locator(".field-combo-menu").boundingBox();
    if (!menuBox) throw new Error("the listing has no box");
    await page.mouse.click(menuBox.x + 2, menuBox.y + 2);
    await page.keyboard.press("Escape");
    await expect(listbox).toHaveCount(0);
    await expect(modal).toBeVisible();

    // Tab also closes the empty filtered state, so leaving the field does not
    // leave the 没有匹配 popup over the form. The empty state renders instead
    // of the listbox, so the assertion has to watch the portal itself.
    await caret.click();
    const modelInput = modal.getByPlaceholder("例如 deepseek-chat");
    await modelInput.fill("no-such-model");
    await expect(page.locator(".field-combo-empty")).toBeVisible();
    await modelInput.press("Tab");
    await expect(page.locator(".field-combo-anchor")).toHaveCount(0);
    await expect(page.locator(".field-combo-empty")).toHaveCount(0);
  });

  test("the provider chooser picks a preset and closes one Escape at a time", async ({ page }) => {
    const presets = [
      { baseUrl: "https://api.deepseek.com", id: "deepseek", name: "DeepSeek" },
      { baseUrl: "https://api.moonshot.cn/v1", id: "kimi", name: "Moonshot Kimi" },
    ];
    await installMockApi(page, { models: MODELS });
    await page.route("**/api/providers", (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      return route.fulfill({
        body: JSON.stringify({ presets, providers: [] }),
        contentType: "application/json",
        status: 200,
      });
    });

    const dialog = await openSettings(page, "模型");
    await dialog.getByRole("button", { name: "添加模型" }).click();
    const modal = page.getByRole("dialog", { name: "添加模型" });
    const trigger = modal.getByRole("button", { name: "服务商类型" });
    await trigger.click();
    const listbox = page.getByRole("listbox", { name: "服务商类型" });
    await expect(listbox).toBeVisible();

    // The list is drawn by the app, not by the OS, so it can carry the same
    // rows as the model listing: a check on the current value and no native
    // blue selection bar.
    await page.getByRole("option", { name: "DeepSeek" }).click();
    await expect(modal.getByLabel("基础URL")).toHaveValue("https://api.deepseek.com");

    // Escape closes the list only. The dialog and the settings surface both
    // listen for the key; the list claims it in the capture phase so only the
    // list closes.
    await trigger.click();
    await expect(listbox).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(listbox).toHaveCount(0);
    await expect(modal).toBeVisible();
    await expect(dialog).toBeVisible();
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

/**
 * The two heavy settings panes, read as first paints rather than as write
 * paths: what they show while the read is outstanding, and what a revisit
 * paints before the next read answers. The durations themselves (`/api/runners`
 * probes the Runner, `/api/usage/analytics` aggregates) are endpoint work, so
 * these cases hold the responses instead of measuring them.
 */
function localRunner(): JsonRecord {
  return {
    alias: "local",
    connectionKind: "direct",
    createdAt: "2026-10-01T08:00:00.000Z",
    id: "local",
    location: "local",
    runnerCommand: "sciencediscovery-runner",
    runnerStatus: { hostId: "local", state: "ready" },
    status: "ready",
    updatedAt: "2026-10-01T08:00:00.000Z",
  };
}

function usageSummary(): JsonRecord {
  const reporting = {
    invocationCount: 1, reportedInputCount: 1, reportedOutputCount: 1, reportedTotalCount: 1,
  };
  return {
    dailyByModel: [{
      cacheReadTokens: 60, cacheWriteTokens: 0, date: "2026-11-18", estimatedCosts: [],
      inputTokens: 80, model: "shared-model", modelProfileId: "profile-a",
      modelProfileName: "Model A", outputTokens: 20, reporting, totalTokens: 100,
    }],
    filters: { timeZone: "Asia/Shanghai" },
    generatedAt: "2026-11-18T04:05:00Z",
    overview: {
      cacheReadTokens: 60, cacheWriteTokens: 0, estimatedCosts: [], inputTokens: 80,
      outputTokens: 20, reporting, totalTokens: 100,
    },
  };
}

/** A route gate the spec opens and closes itself; `undefined` passes through. */
function routeGate() {
  let release: () => void = () => {};
  let gate: Promise<void> | undefined;
  return {
    hold: () => { gate = new Promise<void>((resolve) => { release = resolve; }); },
    pass: () => { gate = undefined; },
    wait: async () => {
      const waiting = gate;
      if (waiting) await waiting;
    },
    release: () => release(),
  };
}

test.describe("the heavy settings panes' first paint", () => {
  test("运行环境 paints Runner cards first, then the remembered catalog on a revisit", async ({ page }) => {
    const mock = await installMockApi(page, { runners: [localRunner()] });
    const gate = routeGate();
    await page.route("**/api/runners", async (route) => {
      await gate.wait();
      await route.fallback();
    });
    gate.hold();

    const dialog = await openSettings(page, "运行环境");
    const skeleton = dialog.locator(".settings-skeleton");
    const card = dialog.locator(".settings-card").filter({ hasText: "内置 Runner" });

    // The header and the section around the Runner list are drawn while the
    // catalog is still outstanding; only the values are missing.
    await expect(skeleton).toBeVisible();
    await expect(dialog.getByText("执行机器", { exact: true })).toBeVisible();
    await expect(dialog.locator(".settings-card.settings-skeleton-card")).toHaveCount(2);
    await expect(card).toHaveCount(0);

    const reads = () => mock.calls.filter((call) => call.method === "GET" && call.path === "/api/runners").length;
    const firstRead = reads();
    gate.release();
    gate.pass();
    await expect(card).toBeVisible();
    await expect(skeleton).toHaveCount(0);

    // A revisit is not a first visit: the catalog is painted from the cache,
    // the refresh still goes out, and the skeleton never returns.
    gate.hold();
    await dialog.getByRole("button", { name: "通用", exact: true }).click();
    await dialog.getByRole("button", { name: "运行环境", exact: true }).click();
    await expect(card).toBeVisible();
    await expect(skeleton).toHaveCount(0);

    gate.release();
    await expect.poll(reads).toBeGreaterThan(firstRead);
    await expect(card).toBeVisible();
  });

  test("模型用量 paints its metric and table skeleton first, then the remembered summary on a revisit", async ({ page }) => {
    await installMockApi(page, { models: MODELS });
    const gate = routeGate();
    let reads = 0;
    await page.route("**/api/usage/analytics*", async (route) => {
      reads += 1;
      await gate.wait();
      await route.fulfill({
        body: JSON.stringify(usageSummary()), contentType: "application/json", status: 200,
      });
    });
    gate.hold();

    const dialog = await openSettings(page, "模型用量");
    const skeleton = dialog.locator(".settings-skeleton");

    await expect(skeleton).toBeVisible();
    await expect(dialog.locator(".settings-skeleton-block.is-usage-metric-label")).toHaveCount(3);
    await expect(dialog.locator(".settings-skeleton-row")).toHaveCount(4);
    // The pane no longer falls back to a one-line loading placeholder.
    await expect(dialog.getByText("正在读取…", { exact: true })).toHaveCount(0);

    const firstRead = reads;
    gate.release();
    gate.pass();
    await expect(dialog.locator(".usage-settings-metric dd")).toHaveCount(3);
    await expect(dialog.getByText("Model A", { exact: true })).toBeVisible();
    await expect(skeleton).toHaveCount(0);

    // A revisit paints the last summary while the next read is still held.
    gate.hold();
    await dialog.getByRole("button", { name: "通用", exact: true }).click();
    await dialog.getByRole("button", { name: "模型用量", exact: true }).click();
    await expect(dialog.getByText("Model A", { exact: true })).toBeVisible();
    await expect(skeleton).toHaveCount(0);

    gate.release();
    await expect.poll(() => reads).toBeGreaterThan(firstRead);
    await expect(dialog.getByText("Model A", { exact: true })).toBeVisible();
  });
});
