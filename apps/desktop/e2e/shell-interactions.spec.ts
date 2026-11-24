/**
 * E2E-META
 * Purpose: Exercise the Desktop shell interactions journey against the deterministic API fixture.
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
 * The shell around the conversation: the header's panel control, the welcome
 * page's starter prompts, the toasts, the dialogs, and the star count.
 *
 * Each of these is state that outlives a render — a draft that has to be
 * cleared, a toast that has to leave on a timer, a dialog that has to keep the
 * settings page behind it open. None of it can be proved by a static string of
 * markup, which is why these are browser cases.
 */
import { expect, test, type Page } from "@playwright/test";

import {
  TOKEN,
  TOKEN_STORAGE_KEY,
  installMockApi,
  makeSession,
  type Mock,
} from "./fixtures.js";

const CATEGORY = "文献调研";
const TOPIC = "研究现状综述";
const TOPIC_PROMPT = "请检索并综述近三年水体中微塑料检测方法的研究现状，列出主要技术路线、代表工作和仍未解决的问题。";

async function upload(page: Page, name = "data.csv"): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "上传文件" }).click();
  await (await chooser).setFiles({ buffer: Buffer.from("a,b\n1,2\n"), mimeType: "text/csv", name });
}

/** 设置 › 沙箱网络 writes the sandbox policy and answers with the one info-tone
 *  notice the app still raises: an upload that lands is reported by its card,
 *  so the toast tests need a different gesture. The fixture starts on 开放网络,
 *  which makes 无网络 a change worth writing. */
async function saveNetworkPolicy(page: Page): Promise<void> {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("button", { name: "沙箱网络", exact: true }).click();
  await dialog.getByRole("button", { name: "无网络", exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [TOKEN_STORAGE_KEY, TOKEN] as const,
  );
});

test.describe("SessionBar", () => {
  test("the panel control opens the panel and hands over to its own collapse", async ({ page }) => {
    await installMockApi(page, { sessions: [makeSession()] });
    await page.goto("/");

    const panel = page.locator(".workspace-panel");
    const toggle = page.getByRole("button", { name: "工作区面板" });
    await expect(toggle).toBeVisible();
    // The panel is rendered for the whole task page so its splitter keeps its
    // identity across a toggle; the closed state is the shell's class, and the
    // stylesheet turns it into a hidden column.
    await expect(page.locator(".app-shell")).toHaveClass(/workspace-hidden/u);
    await expect(panel).toBeHidden();

    await toggle.click();

    await expect(page.locator(".app-shell")).toHaveClass(/panel-open/u);
    await expect(panel).toBeVisible();
    await expect(page.getByRole("tab", { name: "产物" })).toBeVisible();
    // Two controls for one action would be the same button drawn twice.
    await expect(toggle).toHaveCount(0);

    await page.getByRole("button", { name: "收起面板" }).click();
    await expect(page.locator(".app-shell")).toHaveClass(/workspace-hidden/u);
    await expect(panel).toBeHidden();
    await expect(page.getByRole("button", { name: "工作区面板" })).toBeVisible();
  });

  test("the rename prompt refuses an empty name and Escape keeps the old one", async ({ page }) => {
    const mock = await installMockApi(page, { sessions: [makeSession()] });
    await page.goto("/");

    const title = page.locator(".task-head-title");
    // The element is there before the session is: double-clicking a title the
    // page has not loaded yet is a click on a span with no handler.
    await expect(title).toHaveText("晶体结构分析");
    await title.dblclick();

    const dialog = page.getByRole("dialog");
    const field = dialog.getByLabel("会话名称");
    await expect(field).toHaveValue("晶体结构分析");
    await field.fill("   ");
    await expect(dialog.getByRole("button", { name: "确认" })).toBeDisabled();

    await field.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.locator(".task-head-title")).toHaveText("晶体结构分析");
    expect(mock.calls.some((call) => call.method === "PATCH")).toBe(false);
  });
});

test.describe("欢迎页", () => {
  test("a category opens its topics, a topic fills the composer, and the chip clears", async ({ page }) => {
    await installMockApi(page);
    await page.goto("/");

    await page.getByRole("button", { name: CATEGORY, exact: true }).click();
    await page.getByRole("button", { name: TOPIC, exact: true }).click();

    // The prompt is placed, not sent: it stays editable in the composer.
    const composer = page.getByPlaceholder("有什么需要我帮忙的…");
    await expect(composer).toHaveValue(TOPIC_PROMPT);
    await expect(page.locator(".composer-tag-label")).toHaveText(CATEGORY);
    // Picking the topic folds the row back to the three categories.
    await expect(page.getByRole("button", { name: TOPIC, exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "取消分类" }).click();
    await expect(page.locator(".composer-tag")).toHaveCount(0);
    // The prompt the reader was given is theirs still; clearing the chip only
    // drops the subject.
    await expect(composer).toHaveValue(TOPIC_PROMPT);
  });
});

test.describe("Toast", () => {
  test("a notice leaves on its own, an error stays long enough to be read", async ({ page }) => {
    await page.clock.install();
    await installMockApi(page, { sessions: [makeSession()] });
    await page.goto("/");

    await saveNetworkPolicy(page);
    const notice = page.locator(".toast.toast-info");
    await expect(notice).toContainText("沙箱网络已保存");

    await page.clock.fastForward(3_900);
    await expect(notice).toBeVisible();
    await page.clock.fastForward(200);
    await expect(page.locator(".toast.toast-info")).toHaveCount(0);
  });

  test("a failure is still on screen when a notice would have gone", async ({ page }) => {
    await page.clock.install();
    await installMockApi(page, {
      fail: { message: "workspace is read-only", method: "POST", path: "/api/sessions/session-1/workspace/upload" },
      sessions: [makeSession()],
    });
    await page.goto("/");

    await upload(page);
    const failure = page.locator(".toast.toast-error");
    await expect(failure).toContainText("workspace is read-only");

    await page.clock.fastForward(4_500);
    await expect(failure).toBeVisible();
    await page.clock.fastForward(3_600);
    await expect(page.locator(".toast.toast-error")).toHaveCount(0);
  });

  test("a toast can be dismissed before its timer runs out", async ({ page }) => {
    await installMockApi(page, { sessions: [makeSession()] });
    await page.goto("/");

    await saveNetworkPolicy(page);
    const notice = page.locator(".toast.toast-info");
    await expect(notice).toBeVisible();
    await notice.getByRole("button", { name: "取消" }).click();
    await expect(page.locator(".toast")).toHaveCount(0);
  });
});

test.describe("确认框", () => {
  test("Escape answers the confirmation and does not accept it", async ({ page }) => {
    const mock = await installMockApi(page, {
      runners: [{
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
      }],
    });
    await page.goto("/");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "设置" });
    await settings.getByRole("button", { name: "运行环境", exact: true }).click();
    // The machine's own page holds its controls: the list row selects it.
    await settings.getByRole("button", { name: /gpu-01/u }).first().click();
    await settings.getByRole("button", { name: "删除", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "删除机器「gpu-01」？" })).toBeVisible();

    await page.keyboard.press("Escape");

    await expect(page.getByRole("dialog", { name: "删除机器「gpu-01」？" })).toHaveCount(0);
    expect(mock.calls.some((call) => call.method === "DELETE")).toBe(false);
    // One Escape answers one dialog: the confirmation takes the key as "no",
    // and the settings page behind it stays where it is. Both listen for
    // Escape, so this is also the proof that the outer one reads
    // `defaultPrevented` rather than closing on any Escape it sees.
    await expect(settings).toBeVisible();
  });

  test("开放网络 asks before it is written, and cancelling keeps the mode", async ({ page }) => {
    const mock = await installMockApi(page, {
      sandboxNetwork: { allowedDomains: [], mode: "none" },
      sessions: [makeSession()],
    });
    await page.goto("/");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "设置" });
    await settings.getByRole("button", { name: "沙箱网络", exact: true }).click();
    const none = settings.getByRole("button", { name: "无网络", exact: true });
    const open = settings.getByRole("button", { name: "开放网络", exact: true });
    const writes = () => mock.calls.filter((call) => call.method === "PUT" && call.path === "/api/sandbox-network-settings");
    await expect(none).toHaveAttribute("aria-pressed", "true");

    // The warning question comes first, and cancelling it writes nothing.
    await open.click();
    const confirm = page.getByRole("dialog", { name: "开放网络" });
    await expect(confirm).toContainText("确定要这样吗？");
    expect(writes()).toHaveLength(0);
    await confirm.locator(".modal-footer").getByRole("button", { name: "取消", exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect(none).toHaveAttribute("aria-pressed", "true");
    expect(writes()).toHaveLength(0);

    // Accepting writes the open mode once and says it landed.
    await open.click();
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "开放网络", exact: true }).click();
    await expect(open).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".toast.toast-info")).toContainText("沙箱网络已保存");
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(writes()[0]!.body ?? "{}")).toMatchObject({ allowedDomains: [], mode: "open" });
  });

  test("pressing the mode that is already active asks nothing and writes nothing", async ({ page }) => {
    const mock = await installMockApi(page, {
      sandboxNetwork: { allowedDomains: [], mode: "open" },
      sessions: [makeSession()],
    });
    await page.goto("/");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "设置" });
    await settings.getByRole("button", { name: "沙箱网络", exact: true }).click();
    const open = settings.getByRole("button", { name: "开放网络", exact: true });
    await expect(open).toHaveAttribute("aria-pressed", "true");

    await open.click();

    // Before the fix this raised the confirmation anyway; accepting it then
    // wrote nothing and said nothing. Neither the question nor a write belongs
    // to a press on the mode the page already shows.
    await expect(page.getByRole("dialog", { name: "开放网络" })).toHaveCount(0);
    expect(mock.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  });
});

test.describe("GitHub star", () => {
  test("the count is fetched once and then read from its cache", async ({ page }) => {
    let requests = 0;
    await page.route("https://api.github.com/repos/**", async (route) => {
      requests += 1;
      await route.fulfill({
        body: JSON.stringify({ stargazers_count: 5432 }),
        contentType: "application/json",
        status: 200,
      });
    });
    await installMockApi(page);
    await page.goto("/");

    await expect(page.locator(".side-star-count")).toHaveText("5.4k");
    expect(requests).toBe(1);

    await page.reload();
    await expect(page.locator(".side-star-count")).toHaveText("5.4k");
    // A day is long enough that a reload is served from the local copy.
    expect(requests).toBe(1);
  });

  test("an offline machine shows the link without a number", async ({ page }) => {
    await page.route("https://api.github.com/repos/**", (route) => route.abort());
    await installMockApi(page);
    await page.goto("/");

    await expect(page.getByRole("link", { name: "在 GitHub 上加星" })).toBeVisible();
    await expect(page.locator(".side-star-count")).toHaveCount(0);
  });
});

test.describe("sidebar", () => {
  test("a folded sidebar is still folded after a reload", async ({ page }) => {
    await installMockApi(page, { sessions: [makeSession()] });
    await page.goto("/");

    // The column starts folded open, then the reader asks for the width.
    const shell = page.locator(".app-shell");
    await expect(shell).not.toHaveClass(/sidebar-hidden/u);
    await page.getByRole("button", { name: "收起侧栏" }).click();
    await expect(shell).toHaveClass(/sidebar-hidden/u);

    await page.reload();

    // The width the reader asked for is still theirs, like the panel's state.
    await expect(shell).toHaveClass(/sidebar-hidden/u);
    await expect(page.getByRole("button", { name: "显示侧栏" })).toBeVisible();
  });
});
