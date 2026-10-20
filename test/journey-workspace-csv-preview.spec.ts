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

import { expect, type Locator, type Page } from "@playwright/test";

import { test } from "./helpers/e2e.ts";
import {
  artifactTree,
  cleanupJourney,
  createProjectAndSession,
  openProjectSession,
  scriptedModel,
  sendUserMessage,
  waitForRunTerminal,
  type JourneyFixture,
} from "./helpers/journeys.ts";

// Static suite metadata is inherited by each framework-expanded journey.
test.describe("journey-workspace-csv-preview.spec", { tag: ["@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"] }, () => {
test.use({ locale: "en-US" });

/** A small measurement table: one missing condition and one missing p-value. */
const MEASUREMENTS_CSV = [
  "sample_id,condition,expression,p_value",
  "S-01,control,4.21,0.031",
  "S-02,treated,7.85,0.002",
  "S-03,treated,6.40,NA",
  "S-04,control,3.95,0.120",
  "S-05,,5.10,0.045",
].join("\n");

/** Comma-rich prose: it must keep the browser hand-off, not turn into a table. */
const RUN_NOTES = "Plate 2, lane 4: re-run S-03 tomorrow, before the 10:00 slot.\nKeep the control, treated split.\n";

/** Uploads are also listed in the Artifact catalog; the journey clicks the workspace file tree. */
function workspaceFile(page: Page, path: string): Locator {
  return page.locator("aside.workspace-panel details.physical-files").getByRole("button", { exact: true, name: `Open ${path}` });
}

function csvViewer(page: Page, fileName: string): Locator {
  return page.getByRole("dialog", { name: `CSV Visualization Workspace: ${fileName}` });
}

/** Count tabs the page opens; window.open with noopener has no opener, so watch the context. */
function watchNewTabs(page: Page): { count: () => number; stop: () => void } {
  let opened = 0;
  const onPage = () => { opened += 1; };
  page.context().on("page", onPage);
  return { count: () => opened, stop: () => page.context().off("page", onPage) };
}

/**
 * E2E-META
 * Purpose: Workspace CSV files open in the interactive table viewer in place, whether uploaded or written by the agent without a declaration, while other workspace files keep opening in a new browser tab.
 * Steps:
 *   1. Prepare a local stub model and an isolated Project/Session; upload a CSV and a comma-rich text note through the workspace drop zone.
 *   2. Open the uploaded CSV from the workspace file tree; the viewer appears in the page, no tab opens, and only the existing workspace file endpoint is read.
 *   3. Check charts, column-type choices, missing-value filtering and row search inside the viewer, then close it.
 *   4. Ask the agent to write an intermediate CSV without declaring it; it appears in the file tree but not the Artifact catalog.
 *   5. Open the undeclared CSV from the file tree; the same viewer opens it.
 *   6. Open the text note; it still opens in a new browser tab and no viewer appears.
 * Environment: Isolated local stack at E2E_BASE_URL with a journey-owned Project/Session; English browser locale.
 * Type: mocked
 * LLM: journey-owned OpenAI-compatible HTTP stub on 127.0.0.1; one deterministic run_shell turn.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — the shell command runs in the offline local sandbox and non-local browser requests are aborted.
 * Credentials: E2E_API_TOKEN for the isolated local API only; the stub token has no external access.
 * CostSideEffects: no external cost; uploads and one workspace write in a temporary Project deleted in finally.
 */
test("工作区里的 CSV 直接在交互表格中打开", { tag: "@mocked" }, async ({ journey, page }) => {
  test.setTimeout(180_000);
  journey.scenario({
    goal: "研究员把自己的 CSV 拖进工作区、或者让 Agent 写出中间表格后，想在提问前直接用图表、筛选和列类型检查数据，而不是看一个新标签页里的纯文本或下载。",
    preconditions: [
      "隔离 Web/API 已启动，界面语言为英文",
      "模型由旅程自带的本地 stub 驱动：一轮里用 run_shell 写出 scratch/undeclared.csv，且不声明为产物",
    ],
  });
  await page.addInitScript(() => localStorage.setItem("sciencediscovery-locale", "en"));
  const stub = await scriptedModel([
    [
      {
        arguments: { command: "mkdir -p scratch && printf 'gene,log2fc,padj\\nTP53,1.8,0.004\\nMYC,-0.6,0.21\\nEGFR,2.4,0.0007\\n' > scratch/undeclared.csv && cat scratch/undeclared.csv" },
        tool: "run_shell",
      },
      { text: "The intermediate table is at scratch/undeclared.csv; I did not declare it as an Artifact." },
    ],
  ], undefined, { waitForShellCompletion: true });
  let fixture: JourneyFixture | undefined;
  const tabs = watchNewTabs(page);
  try {
    fixture = await createProjectAndSession(page, {
      approvalMode: "always_allow",
      model: { apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: `Workspace CSV model ${Date.now()}` },
      projectName: `Workspace CSV ${Date.now()}`,
      sessionTitle: "Check my table before asking",
    });
    const sessionId = fixture.session.id;

    await journey.step(
      "打开会话，把一份 CSV 和一份文本笔记拖进工作区",
      "两份文件都出现在右侧「Workspace files」文件树里（上传的文件同时以 uploaded 记录出现在产物目录，旅程只点文件树）。",
      async () => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await openProjectSession(page, fixture!);
        await page.locator("aside.workspace-panel label.drop-zone input[type=file]").setInputFiles([
          { buffer: Buffer.from(MEASUREMENTS_CSV), mimeType: "text/csv", name: "measurements.csv" },
          { buffer: Buffer.from(RUN_NOTES), mimeType: "text/plain", name: "run-notes.txt" },
        ]);
        const tree = await (await artifactTree(page)).openPhysicalFiles();
        await expect(tree.getByRole("button", { name: "Open measurements.csv" })).toBeVisible();
        await expect(tree.getByRole("button", { name: "Open run-notes.txt" })).toBeVisible();
      },
    );

    await journey.step(
      "在文件树里点击上传的 CSV",
      "交互表格查看器在当前页面打开，标题写着文件名和「Workspace file」，没有打开新标签页；这次打开只读了一次已有的工作区文件接口，没有写入任何东西。",
      async () => {
        const apiCalls: string[] = [];
        const onRequest = (request: { method: () => string; url: () => string }) => {
          const url = new URL(request.url());
          if (url.pathname.startsWith("/api/")) apiCalls.push(`${request.method()} ${url.pathname}${url.search}`);
        };
        page.on("request", onRequest);
        try {
          await workspaceFile(page, "measurements.csv").click();
          const viewer = csvViewer(page, "measurements.csv");
          await expect(viewer).toBeVisible();
          await expect(viewer.locator(".csva-file-heading")).toContainText("Workspace file");
          await expect(viewer.locator(".csva-source-strip")).toContainText("5 rows");
          await expect(viewer.locator(".csva-source-strip")).toContainText("4 fields");
          await expect(viewer.getByText("Input version pinned")).toHaveCount(0);
        } finally {
          page.off("request", onRequest);
        }
        expect(tabs.count()).toBe(0);
        const fileRead = `GET /api/sessions/${encodeURIComponent(sessionId)}/file?path=measurements.csv`;
        expect(apiCalls.filter((call) => call === fileRead)).toHaveLength(1);
        expect(apiCalls.filter((call) => !call.startsWith("GET "))).toEqual([]);
      },
    );

    await journey.step(
      "在查看器里看图表、列类型和缺失值，并筛一条记录",
      "默认视图画出图表；编码下拉里按类型列出各列（expression 是 quantitative）；类别筛选里能看到缺失的 condition；搜索 S-03 后只剩 1 条可见记录；按 Esc 关闭查看器。",
      async () => {
        const viewer = csvViewer(page, "measurements.csv");
        await expect(viewer.locator(".csva-chart-stage svg.main-svg").first()).toBeVisible({ timeout: 20_000 });
        await expect(viewer.locator("select option", { hasText: "expression / quantitative" }).first()).toBeAttached();
        await expect(viewer.locator(".csva-filter-values label", { hasText: "Missing" })).toBeVisible();
        await viewer.getByPlaceholder("ID, group, gene...").fill("S-03");
        await expect(viewer.locator(".csva-chart-meta")).toContainText("1 visible records");
        await page.keyboard.press("Escape");
        await expect(viewer).toHaveCount(0);
      },
    );

    await journey.step(
      "让 Agent 写一份中间 CSV，但不声明成产物",
      "运行完成后 scratch/undeclared.csv 出现在文件树里，产物目录里没有它。",
      async () => {
        const run = await sendUserMessage(page, sessionId, "Write the intermediate differential table to scratch/undeclared.csv, but do not declare it as an Artifact.");
        expect((await waitForRunTerminal(page, sessionId, run.id)).status).toBe("completed");
        const tree = await artifactTree(page);
        await expect(tree.catalog.getByRole("button", { name: /scratch\/undeclared\.csv/ })).toHaveCount(0);
        const files = await tree.openPhysicalFiles();
        await expect(files.getByRole("button", { name: "Open scratch/undeclared.csv" })).toBeVisible();
      },
    );

    await journey.step(
      "点击这份未声明的 CSV",
      "同一个交互表格查看器打开它，来源条写着它在工作区里的路径 scratch/undeclared.csv；关闭后回到会话。",
      async () => {
        await workspaceFile(page, "scratch/undeclared.csv").click();
        const viewer = csvViewer(page, "undeclared.csv");
        await expect(viewer).toBeVisible();
        await expect(viewer.locator(".csva-source-strip code")).toHaveText("scratch/undeclared.csv");
        await expect(viewer.locator(".csva-source-strip")).toContainText("3 rows");
        await expect(viewer.locator("select option", { hasText: "log2fc / quantitative" }).first()).toBeAttached();
        expect(tabs.count()).toBe(0);
        await viewer.getByRole("button", { name: "Close CSV Visualization Workspace" }).click();
        await expect(viewer).toHaveCount(0);
      },
    );

    await journey.step(
      "点击文本笔记",
      "文本文件照旧在新的浏览器标签页里打开，页面上没有出现表格查看器。",
      async () => {
        const newTab = page.context().waitForEvent("page");
        await workspaceFile(page, "run-notes.txt").click();
        const tab = await newTab;
        expect(tab.url()).toMatch(/^blob:/);
        await tab.close();
        await expect(page.getByRole("dialog", { name: /^CSV Visualization Workspace/ })).toHaveCount(0);
      },
    );
  } finally {
    tabs.stop();
    if (fixture) await cleanupJourney(page, fixture);
    await stub.stop();
  }
});

});
