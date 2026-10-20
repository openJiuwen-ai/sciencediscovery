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
  expectNoArtifactCatalog,
  openProjectSession,
  scriptedModel,
  sendUserMessage,
  waitForRunTerminal,
} from "./helpers/journeys.ts";

// Static suite metadata is inherited by each framework-expanded journey.
test.describe("journey-artifact-viewer-large-screen.spec", { tag: ["@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"] }, () => {

const PROSE = "Growth was measured every thirty minutes across all eight carbon sources, and the lag phase shortened as the inoculum density increased, "
  + "which is consistent with quorum-dependent activation of the uptake operon rather than with a simple dilution effect. "
  + "Replicates agreed within five percent for every condition except the lowest glucose concentration, where two wells evaporated and were excluded. "
  + "The remaining conditions support the original hypothesis, and the table below lists every replicate so the exclusion can be checked.";
const COLUMNS = ["condition", "replicate", "carbon_source", "concentration_mM", "inoculum_od", "lag_h", "growth_rate_per_h", "max_od600", "doubling_min", "auc", "plate", "well", "status", "notes"];

function reportMarkdown(): string {
  const row = (index: number) => `| C${index} | ${index % 3 + 1} | glucose | ${(index * 2.5).toFixed(1)} | 0.05 | ${(2 + index / 10).toFixed(2)} | 0.61 | 1.42 | 68 | 9.81 | P1 | A${index} | kept | measured by the overnight reader |`;
  return [
    "# Growth assay summary",
    "",
    PROSE,
    "",
    PROSE,
    "",
    "## Per-replicate results",
    "",
    `| ${COLUMNS.join(" | ")} |`,
    `| ${COLUMNS.map(() => "---").join(" | ")} |`,
    ...Array.from({ length: 6 }, (_, index) => row(index + 1)),
    "",
    "- Plates were read at 600 nm with path-length correction enabled on every run of the overnight reader.",
    "- Wells with evaporation over ten percent were excluded before fitting the logistic growth curves.",
  ].join("\n");
}

/** Where a dialog sits on the page, and how wide its content may run. */
async function dialogGeometry(dialog: Locator) {
  return dialog.evaluate((panel) => {
    const rect = panel.getBoundingClientRect();
    const body = panel.querySelector<HTMLElement>(".artifact-modal-body");
    const paragraph = panel.querySelector<HTMLElement>(".markdown-body > p");
    const table = panel.querySelector<HTMLElement>(".markdown-table-scroll");
    const source = panel.querySelector<HTMLElement>("pre.artifact-source-preview");
    return {
      bodyClientHeight: body?.clientHeight ?? 0,
      bodyClientWidth: body?.clientWidth ?? 0,
      bodyScrollHeight: body?.scrollHeight ?? 0,
      height: Math.round(rect.height),
      left: Math.round(rect.left),
      paragraphWidth: Math.round(paragraph?.getBoundingClientRect().width ?? 0),
      sourceHeight: Math.round(source?.getBoundingClientRect().height ?? 0),
      sourceWidth: Math.round(source?.getBoundingClientRect().width ?? 0),
      tableWidth: Math.round(table?.getBoundingClientRect().width ?? 0),
      top: Math.round(rect.top),
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      width: Math.round(rect.width),
    };
  });
}

/** The issue's content-viewer size: 1600×960 at most, otherwise the viewport less an 80px margin, centred. */
async function expectViewerSize(page: Page, dialog: Locator, viewport: { height: number; width: number }) {
  await page.setViewportSize(viewport);
  const width = Math.min(1600, viewport.width - 80);
  const height = Math.min(960, viewport.height - 80);
  await expect.poll(async () => {
    const geometry = await dialogGeometry(dialog);
    return [geometry.width, geometry.height, geometry.left, geometry.top];
  }).toEqual([width, height, (viewport.width - width) / 2, (viewport.height - height) / 2]);
  return dialogGeometry(dialog);
}

/**
 * E2E-META
 * Purpose: A researcher opening an artifact, or the detail viewer that shares its window, on a large screen gets a large content window (1600×960 at most, otherwise the viewport less 80px, full viewport at 900px and below) whose prose stays at a readable measure while tables and source use the window, and the settings dialog keeps its own size.
 * Steps:
 *   1. Prepare a local stub model and an isolated Project/Session; confirm the Artifact catalog is empty.
 *   2. Ask for a summary whose shell step writes and declares a Markdown report with a wide table and a long Python source.
 *   3. Open the report at 1920×1080: the viewer is 1600×960 and centred, paragraphs keep about 76ch, and the wide table uses the window width.
 *   4. Open the Python source: its preview uses the window width and height without scrolling the window itself.
 *   5. Resize to 2560×1440, 1280×800 and 900×800: the viewer stays capped at 1600×960, follows the viewport less 80px, and becomes the full viewport.
 *   6. Open the report's workspace-file provenance detail at 1920×1080: it uses the same 1600×960 window.
 *   7. Open System configuration at 1920×1080: the settings dialog keeps its own size rather than the viewer's.
 * Environment: Isolated local stack at E2E_BASE_URL with the bubblewrap sandbox and a journey-owned Project/Session; no managed Python is needed.
 * Type: mocked
 * LLM: journey-owned OpenAI-compatible HTTP stub on 127.0.0.1; one deterministic user turn.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — the shell step runs in the offline local sandbox and non-local browser requests are aborted.
 * Credentials: E2E_API_TOKEN for the isolated local API only; the stub token has no external access.
 * CostSideEffects: no external cost; temporary records are deleted in finally.
 */
test("J309 大屏打开产物时查看器放大且正文保持可读宽度", { tag: "@mocked" }, async ({ journey, page }) => {
  test.setTimeout(210_000);
  const shell = [
    "mkdir -p results",
    `cat > results/report.md <<'REPORT'\n${reportMarkdown()}\nREPORT`,
    "for i in $(seq 1 240); do printf 'value_%03d = fit_logistic(curve[%d], lag=0.5, rate=0.61, ceiling=1.42)  # replicate %d of the overnight plate\\n' \"$i\" \"$i\" \"$i\"; done > results/analysis.py",
    "wc -l results/analysis.py",
  ].join("\n");
  const stub = await scriptedModel([
    [
      { arguments: { command: shell }, delayMs: 300, tool: "run_shell" },
      { arguments: { path: "results/report.md" }, tool: "declare_artifact" },
      { arguments: { path: "results/analysis.py" }, tool: "declare_artifact" },
      { text: "Declared results/report.md and results/analysis.py." },
    ],
  ]);
  const fixture = await createProjectAndSession(page, {
    approvalMode: "always_allow",
    model: {
      apiToken: stub.apiToken,
      baseUrl: stub.baseUrl,
      model: stub.model,
      name: `J309 local model ${Date.now()}`,
    },
    projectName: `J309 large viewer ${Date.now()}`,
    sessionTitle: `J309 large viewer session ${Date.now()}`,
  });

  journey.scenario({
    goal: "研究员在大屏上打开产物，要让图表、表格和源码用上整块屏幕，而不是挤在约 1080px 的小卡片里；"
      + "正文段落仍保持好读的行宽，设置对话框不跟着变大。",
    preconditions: [
      "隔离栈已启动，bubblewrap 沙箱可用",
      "已有一个由旅程创建的项目与会话，审批模式为「始终允许」，产物目录初始为空",
      "模型由旅程自带的本地 stub 驱动：一轮写出并声明 report.md（长段落 + 14 列宽表格）与 analysis.py（240 行源码）",
    ],
  });

  try {
    await journey.step(
      "进入会话，确认还没有任何产物",
      "右栏还没有产物区，后面打开的产物确实来自这次分析。",
      async () => {
        await page.setViewportSize({ width: 1920, height: 1080 });
        await openProjectSession(page, fixture);
        await expectNoArtifactCatalog(page);
      },
    );

    await journey.step(
      "提出分析需求并等待运行结束",
      "stub 模型写出并声明报告和源码两份产物，运行正常完成。",
      async () => {
        const run = await sendUserMessage(page, fixture.session.id, "Summarize the growth assay as a report and keep the fitting script.");
        const terminal = await waitForRunTerminal(page, fixture.session.id, run.id);
        expect(terminal.status, terminal.error).toBe("completed");
      },
    );

    let tree!: Awaited<ReturnType<typeof artifactTree>>;
    await journey.step(
      "在 1920×1080 下打开 Markdown 报告",
      "查看器是居中的 1600×960 窗口，四周仍能看到变暗的页面；段落保持约 76 个字符的行宽，宽表格铺满窗口宽度。",
      async () => {
        tree = await artifactTree(page);
        await expect(tree.artifactCount).toHaveText("2", { timeout: 30_000 });
        await tree.catalog.getByRole("button", { name: "Open results/report.md" }).click();
        const dialog = page.getByRole("dialog", { name: "Artifact: results/report.md" });
        await expect(dialog.locator(".markdown-table-scroll")).toBeVisible();
        const geometry = await expectViewerSize(page, dialog, { width: 1920, height: 1080 });
        expect(geometry.paragraphWidth, "a paragraph keeps a readable measure instead of spanning the window").toBeLessThanOrEqual(760);
        expect(geometry.paragraphWidth).toBeGreaterThan(500);
        expect(geometry.tableWidth, "the wide table uses the window width").toBeGreaterThan(1500);
      },
    );

    await journey.step(
      "换到 Python 源码",
      "源码预览铺满窗口的宽度和高度，长文件在预览框里自己滚动，窗口本身不出现第二条滚动条。",
      async () => {
        await page.getByRole("dialog", { name: "Artifact: results/report.md" }).getByRole("button", { name: "Close artifact viewer" }).click();
        await tree.catalog.getByRole("button", { name: "Open results/analysis.py" }).click();
        const dialog = page.getByRole("dialog", { name: "Artifact: results/analysis.py" });
        await expect(dialog.locator("pre.artifact-source-preview")).toContainText("value_240");
        const geometry = await expectViewerSize(page, dialog, { width: 1920, height: 1080 });
        expect(geometry.sourceWidth, "source preview uses the window width").toBeGreaterThanOrEqual(geometry.bodyClientWidth - 60);
        expect(geometry.sourceHeight, "source preview uses the window height").toBeGreaterThan(640);
        expect(geometry.bodyScrollHeight, "the window body does not scroll on top of the preview").toBeLessThanOrEqual(geometry.bodyClientHeight + 1);
      },
    );

    await journey.step(
      "在 2560×1440 下仍以 1600×960 为上限",
      "更大的窗口里查看器停在 1600×960 并居中，不会无限拉宽。",
      async () => {
        await expectViewerSize(page, page.getByRole("dialog", { name: "Artifact: results/analysis.py" }), { width: 2560, height: 1440 });
      },
    );

    await journey.step(
      "缩到 1280×800",
      "查看器是视口减去 80px 的 1200×720，不再停在 1080px 宽。",
      async () => {
        await expectViewerSize(page, page.getByRole("dialog", { name: "Artifact: results/analysis.py" }), { width: 1280, height: 800 });
      },
    );

    await journey.step(
      "缩到 900×800",
      "900px 及以下保持原来的整视口查看器。",
      async () => {
        await page.setViewportSize({ width: 900, height: 800 });
        const dialog = page.getByRole("dialog", { name: "Artifact: results/analysis.py" });
        await expect.poll(async () => {
          const geometry = await dialogGeometry(dialog);
          return [geometry.width, geometry.height, geometry.left, geometry.top];
        }).toEqual([900, 800, 0, 0]);
      },
    );

    await journey.step(
      "回到 1920×1080，打开报告的工作区文件溯源详情",
      "节点详情查看器与产物查看器共用同一个 1600×960 窗口。",
      async () => {
        const viewer = page.getByRole("dialog", { name: "Artifact: results/analysis.py" });
        await viewer.getByRole("button", { name: "Close artifact viewer" }).click();
        await expect(viewer).toHaveCount(0);
        await page.setViewportSize({ width: 1920, height: 1080 });
        const files = await tree.openPhysicalFiles();
        // With a fine pointer the provenance icon only appears while its row is hovered.
        const row = files.locator(".workspace-file-tree-row").filter({ has: page.getByRole("button", { name: "Open results/report.md" }) });
        await row.hover();
        await row.getByRole("button", { name: "View provenance for results/report.md" }).click();
        const dialog = page.getByRole("dialog", { name: "Detail: report.md" });
        await expect(dialog).toBeVisible();
        await expectViewerSize(page, dialog, { width: 1920, height: 1080 });
      },
    );

    await journey.step(
      "关闭详情后打开系统设置",
      "系统设置对话框保持它自己的约 80% 视口尺寸（1536×864），没有变成查看器的 1600×960。",
      async () => {
        const detail = page.getByRole("dialog", { name: "Detail: report.md" });
        await detail.getByRole("button", { name: "Close detail viewer" }).click();
        await expect(detail).toHaveCount(0);
        await page.getByRole("button", { name: /^(System configuration|系统设置)/ }).click();
        const dialog = page.getByRole("dialog", { name: /^(System configuration|系统设置)$/ });
        await expect(dialog).toBeVisible();
        await expect.poll(async () => dialog.evaluate((panel) => {
          const rect = panel.getBoundingClientRect();
          return [Math.round(rect.width), Math.round(rect.height)];
        })).toEqual([1536, 864]);
      },
    );
  } finally {
    await cleanupJourney(page, fixture);
    await stub.stop();
  }
});

});
