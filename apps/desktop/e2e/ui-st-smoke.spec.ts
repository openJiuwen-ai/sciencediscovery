/**
 * E2E-META
 * Purpose: Exercise the Desktop ui st smoke journey against the deterministic API fixture.
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
// Deterministic browser-level UI-ST. The API is the same stateful mock used by
// Desktop E2E, while the browser, routing and persistence path are real.
import assert from "node:assert/strict";

import { expect, test } from "@playwright/test";
import { DEFAULT_PROJECT, TOKEN, TOKEN_STORAGE_KEY, installMockApi, makeSession } from "./fixtures.js";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [TOKEN_STORAGE_KEY, TOKEN] as const);
});

test.describe("@ui-st continuous UI state transitions", () => {
  test("GJ-02 session rename survives a reload", async ({ page }) => {
    const mock = await installMockApi(page, { sessions: [makeSession()] });
    await page.goto("/");
    await expect(page.locator(".app-shell")).toBeVisible();
    await page.locator(".task-head-title").dblclick();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("会话名称").fill("恢复后的研究");
    await dialog.getByLabel("会话名称").press("Enter");
    await expect(page.locator(".task-head-title")).toHaveText("恢复后的研究");
    await expect.poll(() => mock.state.sessions[0]?.title).toBe("恢复后的研究");
    await page.reload();
    await expect(page.locator(".task-head-title")).toHaveText("恢复后的研究");
  });

  test("GJ-03 memory setting writes through and remains visible after refresh", async ({ page }) => {
    const mock = await installMockApi(page, { sessions: [makeSession()], memorySettings: { enabled: false } });
    await page.goto("/");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "设置" });
    await dialog.getByRole("button", { name: "科学记忆", exact: true }).click();
    const toggle = dialog.getByRole("switch", { name: "启用科学记忆" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(dialog.locator(".memory-status")).toHaveCount(0);
    await toggle.click();
    await expect(dialog.locator(".memory-status")).toBeVisible();
    await expect.poll(() => mock.state.memorySettings.enabled).toBe(true);
    await page.reload();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const refreshed = page.getByRole("dialog", { name: "设置" });
    await refreshed.getByRole("button", { name: "科学记忆", exact: true }).click();
    await expect(refreshed.getByRole("switch", { name: "启用科学记忆" })).toBeChecked();
  });

  test("GJ-01 first-run setup carries model, approval-ready state and the first workspace", async ({ page }) => {
    const mock = await installMockApi(page, { models: [], sessions: [] });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "账号登录" })).toBeVisible();
    await expect(page.locator(".app-shell")).toHaveCount(0);

    await page.getByRole("button", { name: "暂不登录，配置自定义模型" }).click();
    await expect(page.getByRole("heading", { name: "自定义模型配置" })).toBeVisible();
    await page.getByLabel("基础URL").fill("http://127.0.0.1:9999/v1");
    await page.getByPlaceholder("请输入 API key").fill("sk-ui-st");
    await page.getByPlaceholder("例如 deepseek-chat").fill("ui-st-model");
    await page.getByRole("button", { name: "测试并继续" }).click();
    await expect(page.getByText("✓ 基础检查通过", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "保存并进入工作台" }).click();

    await expect(page.locator(".app-shell")).toBeVisible();
    expect(mock.state.overrides.modelId).toBe("model-1");
    expect(mock.state.models[0]?.model).toBe("ui-st-model");
  });

  test("GJ-04 remote Runner connection can be retried and disconnected from its details", async ({ page }) => {
    const mock = await installMockApi(page, {
      failOnce: { method: "POST", path: "/api/runners/runner-1/connect", message: "runner restarting" },
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
    const machine = settings.locator(".settings-card.is-machine").filter({ hasText: "gpu-01" });
    await machine.getByRole("button", { name: /gpu-01/ }).click();
    await expect(settings.getByRole("button", { name: "返回运行环境", exact: true })).toBeVisible();
    await machine.getByRole("button", { name: "连接", exact: true }).click();
    await expect(settings.getByText("runner restarting", { exact: true })).toBeVisible();
    expect(mock.calls.filter((call) => call.method === "POST" && call.path === "/api/runners/runner-1/connect")).toHaveLength(1);
    await machine.getByRole("button", { name: "连接", exact: true }).click();
    await expect(machine.getByRole("button", { name: "断开", exact: true })).toBeVisible();
    expect(mock.calls.filter((call) => call.method === "POST" && call.path === "/api/runners/runner-1/connect")).toHaveLength(2);
    await machine.getByRole("button", { name: "断开", exact: true }).click();
    await expect(machine.getByRole("button", { name: "连接", exact: true })).toBeVisible();
  });

  test("GJ-05 parallel Session outputs stay separated when the panel is refreshed", async ({ page }) => {
    const sessionTwo = makeSession({ id: "session-2", title: "并行分析" });
    const output = (sessionId: string, title: string) => ({
      artifact: {
        createdAt: "2026-10-01T08:00:00.000Z", createdInSessionTitle: title, id: `${sessionId}-artifact`,
        kind: "document", logicalName: `${sessionId}.md`, name: `${sessionId}.md`, origin: "run",
        projectId: "project-1", sessionId, title, updatedAt: "2026-10-01T09:30:00.000Z",
      },
      version: {
        artifactId: `${sessionId}-artifact`, content: { hash: `sha256:${sessionId}` }, createdAt: "2026-10-01T09:30:00.000Z",
        executionRunIds: [], id: `${sessionId}-version`, inputArtifactVersionIds: [], mediaType: "text/markdown",
        projectId: "project-1", sessionId, sourcePath: `${sessionId}.md`, version: 1,
      },
    });
    await installMockApi(page, {
      artifactContents: { "session-1-version": "主会话结果", "session-2-version": "并行会话结果" },
      artifactsBySession: { "session-1": [output("session-1", "主分析")], "session-2": [output("session-2", "并行分析")] },
      sessions: [makeSession(), sessionTwo],
    });
    await page.goto("/");
    await page.getByRole("button", { name: "工作区面板" }).click();
    const panel = page.locator(".workspace-panel");
    await panel.getByRole("tab", { name: "产物" }).click();
    const parallel = panel.locator(".panel-output").filter({ hasText: "并行分析" });
    await parallel.locator(".panel-output-head").click();
    await parallel.locator(".panel-list-row").filter({ hasText: "并行分析" }).click();
    await expect(panel.locator(".doc-body")).toContainText("并行会话结果");
    await expect(panel.locator(".panel-output").filter({ hasText: "主分析" })).toContainText("主分析");
    await expect(panel.locator(".panel-output").filter({ hasText: "主分析" })).not.toContainText("并行会话结果");
  });

  test("GJ-06 two Sessions keep their titles and selected conversation separate after reload", async ({ page }) => {
    await installMockApi(page, { sessions: [makeSession(), makeSession({ id: "session-2", title: "另一条研究" })] });
    await page.goto("/");
    await expect(page.locator(".side-session-name", { hasText: "晶体结构分析" })).toBeVisible();
    await expect(page.locator(".side-session-name", { hasText: "另一条研究" })).toBeVisible();
    await page.locator(".side-session-name", { hasText: "另一条研究" }).click();
    await expect(page.locator(".task-head-title")).toHaveText("另一条研究");
    await page.locator(".side-session-name", { hasText: "晶体结构分析" }).click();
    await expect(page.locator(".task-head-title")).toHaveText("晶体结构分析");
    await page.reload();
    await expect(page.locator(".task-head-title")).toHaveText("晶体结构分析");
    await page.locator(".side-session-name", { hasText: "另一条研究" }).click();
    await expect(page.locator(".task-head-title")).toHaveText("另一条研究");
  });

});

test("GJ-03 report artifact opens memory evidence and provenance in one continuous UI flow", { tag: "@ui-st" }, async ({ page }) => {
  const sessionId = "session-1";
  const report = {
    artifact: {
      createdAt: "2026-10-01T08:00:00.000Z",
      createdInSessionId: sessionId,
      createdInSessionTitle: "研究会话",
      currentVersion: 1,
      id: "artifact-report",
      kind: "markdown",
      logicalName: "report.md",
      name: "report.md",
      origin: "run",
      projectId: "project-1",
      sessionId,
      updatedAt: "2026-10-01T09:00:00.000Z",
    },
    version: {
      artifactId: "artifact-report",
      content: { hash: "sha256:report", size: 32 },
      createdAt: "2026-10-01T09:00:00.000Z",
      executionRunIds: ["run-1"],
      id: "version-1",
      inputArtifactVersionIds: [],
      mediaType: "text/markdown",
      projectId: "project-1",
      references: [{ id: "evidence-1", kind: "evidence", label: "evidence1" }],
      sessionId,
      sourcePath: "/runs/one/report.md",
      version: 1,
    },
  };
  const evidence = {
    id: "evidence-1",
    label: "Evidence",
    sessionId,
    excerpt: "转化率提升至 92%",
    createdAt: "2026-10-01T10:00:00.000Z",
    extra: { content: "在 350 °C 下，转化率提升至 92%。", evidence_id: "evidence-1", locator: "图 2" },
  };
  const mock = await installMockApi(page, {
    artifactContents: { "version-1": "# 报告\\n\\n转化率提升 [evidence1]。\\n" },
    artifactsBySession: { [sessionId]: [report] },
    memory: {
      hits: [evidence],
      chains: { "evidence-1|viewSourcePaper": { edges: [], nodes: [evidence, { id: "paper-1", label: "Paper", extra: { title: "Fixture paper", abstract: "Source abstract" } }], total: 2, truncated: false } },
    },
    sessions: [makeSession({ id: sessionId })],
  });
  await page.goto("/");
  await page.getByRole("button", { name: "工作区面板" }).click();
  const panel = page.locator(".workspace-panel");
  await panel.getByRole("tab", { name: "产物" }).click();
  await panel.getByRole("button", { name: "report.md" }).click();
  await expect(panel.locator(".doc-body")).toContainText("转化率提升");
  await panel.locator(".graph-chip").click();
  const dialog = page.locator(".memory-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".evidence-content-text")).toContainText("转化率提升至 92%");
  await dialog.getByRole("button", { name: "溯源" }).click();
  await expect(dialog.locator(".evidence-source-paper")).toHaveCount(1);
  expect(mock.calls.some((call) => call.path === "/api/memory/query/by-node-type")).toBe(true);
  expect(mock.calls.some((call) => call.path === "/api/memory/query/chain")).toBe(true);
});

/**
 * Issue #1348: the fold used to say 显示更多 with no count, so the ten rows
 * behind it read as Sessions that had been deleted. The browser case pins the
 * number the reader sees to the rows the press actually adds, and measures the
 * label at both column widths so it cannot be clipped back into silence.
 */
test("the sidebar fold names the older Sessions it holds and reveals exactly those", { tag: "@ui-st" }, async ({ page }) => {
  const sessions = Array.from({ length: 16 }, (_, index) =>
    makeSession({
      id: `session-${index + 1}`,
      projectId: "project-1",
      title: `会话 ${index + 1}`,
      updatedAt: new Date(Date.UTC(2026, 10, 24, 9, 0, index)).toISOString(),
    }),
  );
  await installMockApi(page, { projects: [{ ...DEFAULT_PROJECT }], sessions });
  await page.goto("/");

  const rows = page.locator(".side-row.side-sub");
  const more = page.locator(".side-more");
  await expect(more).toHaveText("显示更早的 10 个会话");
  await expect(page.locator(".side-project-rule")).toHaveText("最近 6 个");
  await expect(rows).toHaveCount(6);

  // 1440px is the 296px column; 1024px narrows it to 256px. The count is the
  // point of the label, so it has to fit at both.
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 950 });
    const label = await more.evaluate((node) => ({ client: node.clientWidth, scroll: node.scrollWidth }));
    assert.ok(label.scroll <= label.client, `the fold label is clipped at ${width}px`);
  }
  await page.setViewportSize({ width: 1440, height: 950 });

  await more.click();

  await expect(rows).toHaveCount(16);
  await expect(page.locator(".side-more")).toHaveCount(0);
  await expect(page.locator(".side-project-rule")).toHaveCount(0);
  // The expansion keeps the recency order: newest first, oldest last.
  await expect(page.locator(".side-session-name").first()).toHaveText("会话 16");
  await expect(page.locator(".side-session-name").last()).toHaveText("会话 1");
});
