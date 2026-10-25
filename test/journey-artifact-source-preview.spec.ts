// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { artifactTree, cleanupJourney, createProjectAndSession, openProjectSession, type JourneyFixture } from "./helpers/journeys.ts";

const SCRIPT = '# Scientific analysis / 科学分析\ndef score(value):\n    """A multiline\n    description."""\n\n    return value * 2\n';
const LARGE = "research output\n".repeat(7_000) + "FULL_FILE_END";
const NOTEBOOK = JSON.stringify({ metadata: { language_info: { name: "python" } }, nbformat: 4, nbformat_minor: 5,
  cells: [{ cell_type: "markdown", source: ["# Notebook results"], metadata: {} },
    { cell_type: "code", source: ["result = 42\n", "print(result)"], metadata: {}, outputs: [], execution_count: 1 }] });
const FILES = [
  { name: "analysis.py", mimeType: "text/x-python", buffer: Buffer.from(SCRIPT) },
  { name: "config.yaml", mimeType: "text/yaml", buffer: Buffer.from("model:\n  name: example\n  iterations: 42\n") },
  { name: "notes.unknown", mimeType: "application/octet-stream", buffer: Buffer.from("实验记录\nunknown UTF-8 text\nlast line") },
  { name: "empty.txt", mimeType: "text/plain", buffer: Buffer.alloc(0) },
  { name: "large.log", mimeType: "text/plain", buffer: Buffer.from(LARGE) },
  { name: "report.md", mimeType: "text/markdown", buffer: Buffer.from("# Research results\n\n**Readable** prose.\n") },
  { name: "table.json", mimeType: "application/json", buffer: Buffer.from('[{"sample":"A","value":42}]') },
  { name: "results.csv", mimeType: "text/csv", buffer: Buffer.from("sample,value\nA,42\nB,21\n") },
  { name: "analysis.ipynb", mimeType: "application/x-ipynb+json", buffer: Buffer.from(NOTEBOOK) },
  { name: "binary.bin", mimeType: "application/octet-stream", buffer: Buffer.from([0xff, 0xfe, 0x41]) },
  { name: "figure.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6hjAAAAAASUVORK5CYII=", "base64") },
  { name: "report.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF") },
  { name: "dashboard.html", mimeType: "text/html", buffer: Buffer.from("<!doctype html><h1>Research dashboard</h1>") },
  { name: "molecule.pdb", mimeType: "chemical/x-pdb", buffer: Buffer.from("ATOM      1  CA  ALA A   1      10.000  12.000  14.000  1.00 20.00           C \nEND\n") },
];

async function openArtifact(page: Page, name: string): Promise<Locator> {
  const tree = await artifactTree(page);
  await tree.catalog.getByRole("button", { name: `Open ${name}`, exact: true }).click();
  const modal = page.getByRole("dialog", { name: `Artifact: ${name}`, exact: true });
  await expect(modal).toBeVisible();
  return modal;
}
async function closeArtifact(modal: Locator) { await modal.getByRole("button", { name: "Close artifact viewer" }).click(); }
async function upload(page: Page) {
  await page.locator("aside.workspace-panel label.drop-zone input[type=file]").setInputFiles(FILES);
  await expect((await artifactTree(page)).artifacts).toHaveCount(FILES.length);
}
async function expectNumbered(modal: Locator, language: string, lines?: number) {
  const source = modal.locator(".numbered-source").first();
  await expect(source).toHaveAttribute("data-language", language);
  await expect(source.locator(".source-line-number").first()).toHaveText("1");
  if (lines) {
    await expect(source.locator(".source-line-number")).toHaveCount(lines);
    await expect(source.locator(".source-line-number").last()).toHaveText(String(lines));
  }
}

test.describe("Read artifact and workspace source", { tag: ["@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"] }, () => {
  test.use({ locale: "en-US" });
  /**
   * E2E-META
   * Purpose: Read highlighted, numbered artifact source and retain specialized previews, truncation and full downloads.
   * Steps:
   *   1. Upload source files and specialized-preview fixtures in an isolated session.
   *   2. Read Python and YAML, unknown UTF-8 and empty files; inspect wrapped source on desktop and narrow screens.
   *   3. Read a truncated log and download the complete immutable artifact.
   *   4. Open Markdown, JSON table/Raw, CSV Raw, notebook cells/Source, image, PDF, HTML and molecule previews.
   *   5. Confirm invalid UTF-8 binary files show the download guidance.
   * Environment: Isolated product Web/API at E2E_BASE_URL; no model or Run required.
   * Type: mocked
   * LLM: none
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none; non-local browser requests are blocked.
   * Credentials: E2E_API_TOKEN for the isolated local API.
   * CostSideEffects: temporary Project, Session, uploads and a local download; records deleted in finally.
   */
  test("read source artifacts and preserve specialized previews", { tag: "@mocked" }, async ({ journey, page }) => {
    test.setTimeout(180_000);
    journey.scenario({ goal: "在产物面板阅读代码和文本，按行定位，并继续使用原有专用预览和全文下载。", preconditions: ["隔离的英文 Web/API 已启动；不调用模型"] });
    await page.addInitScript(() => localStorage.setItem("sciencediscovery-locale", "en"));
    let fixture: JourneyFixture | undefined;
    try {
      await journey.step("上传代码、文本和专用格式文件", "文件都进入当前项目的产物目录。", async () => {
        fixture = await createProjectAndSession(page, { projectName: "Artifact source reading", sessionTitle: "Read research outputs" });
        await openProjectSession(page, fixture);
        await upload(page);
      });
      await journey.step("阅读 Python 脚本并调整窗口宽度", "Python 有语法颜色，空行和多行字符串保持行号；窄屏仍可完整阅读。", async () => {
        const modal = await openArtifact(page, "analysis.py");
        await expectNumbered(modal, "python", SCRIPT.split("\n").length);
        await expect(modal.locator(".hljs-keyword", { hasText: "def" })).toBeVisible();
        await expect(modal.locator(".source-line-text").nth(3)).toContainText('description."""');
        for (const [width, height] of [[1440, 900], [760, 900], [390, 844], [1280, 600]]) {
          await page.setViewportSize({ width: width!, height: height! });
          await expect(modal.getByRole("button", { name: "Download current version" })).toBeVisible();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          const line = modal.locator(".source-line").nth(1);
          const gutter = await line.locator(".source-line-number").boundingBox();
          const content = await line.locator(".source-line-text").boundingBox();
          // Chromium can round adjacent grid boxes at fractional CSS pixels.
          expect(Math.abs(gutter!.y - content!.y)).toBeLessThan(1);
        }
        await page.setViewportSize({ width: 1440, height: 900 });
      });
      await journey.step("阅读配置、未知扩展名和空文件", "YAML 高亮；未知扩展名的中文文本带行号；空文件明确提示为空。", async () => {
        await closeArtifact(page.getByRole("dialog", { name: "Artifact: analysis.py" }));
        let modal = await openArtifact(page, "config.yaml");
        await expectNumbered(modal, "yaml", 4);
        await expect(modal.locator(".hljs-attr").first()).toBeVisible();
        await closeArtifact(modal);
        modal = await openArtifact(page, "notes.unknown");
        await expectNumbered(modal, "plaintext", 3);
        await expect(modal.locator(".numbered-source")).toContainText("实验记录");
        await closeArtifact(modal);
        modal = await openArtifact(page, "empty.txt");
        await expect(modal.getByText("This file is empty.")).toBeVisible();
        await expectNumbered(modal, "plaintext", 1);
        await closeArtifact(modal);
      });
      await journey.step("阅读超长日志并下载完整版本", "预览在 100,000 字符处截断并提示下载；下载内容保留文件尾部。", async () => {
        const modal = await openArtifact(page, "large.log");
        await expect(modal.getByText(/Preview truncated at 100,000/)).toBeVisible();
        const text = await modal.locator(".source-line-text").allTextContents();
        expect(text.join("")).toHaveLength(100_000);
        expect(text.join("")).not.toContain("FULL_FILE_END");
        const downloadPromise = page.waitForEvent("download");
        await modal.getByRole("button", { name: "Download current version" }).click();
        const download = await downloadPromise;
        let downloaded = "";
        for await (const chunk of (await download.createReadStream())!) downloaded += chunk.toString();
        expect(downloaded).toBe(LARGE);
        await closeArtifact(modal);
      });
      await journey.step("切换 Markdown、表格和 notebook 的源码视图", "默认的文章、表格和 notebook 单元格仍在，Source/Raw 都使用同一行号和高亮。", async () => {
        let modal = await openArtifact(page, "report.md");
        await expect(modal.getByRole("heading", { name: "Research results" })).toBeVisible();
        await modal.locator("summary").click();
        await expectNumbered(modal, "markdown", 4);
        await closeArtifact(modal);
        modal = await openArtifact(page, "table.json");
        await expect(modal.locator("table.dataset-table")).toContainText("42");
        await modal.getByRole("button", { name: "Raw JSON" }).click();
        await expectNumbered(modal, "json");
        await modal.getByRole("button", { name: "Table", exact: true }).click();
        await expect(modal.locator("table.dataset-table")).toBeVisible();
        await closeArtifact(modal);
        modal = await openArtifact(page, "results.csv");
        await expect(modal.getByRole("button", { name: /Open CSV Visualization Workspace/ })).toBeEnabled();
        await modal.locator("summary").click();
        await expectNumbered(modal, "plaintext", 4);
        await closeArtifact(modal);
        modal = await openArtifact(page, "analysis.ipynb");
        await expect(modal.getByRole("heading", { name: "Notebook results" })).toBeVisible();
        await expectNumbered(modal, "python", 2);
        await modal.locator("summary").click();
        await expect(modal.locator('.numbered-source[data-language="json"]')).toBeVisible();
      });
      await journey.step("继续查看图片、PDF、HTML、分子文件和二进制文件", "各专用入口保留；二进制显示下载提示，不显示源码。", async () => {
        await closeArtifact(page.getByRole("dialog", { name: "Artifact: analysis.ipynb" }));
        for (const [name, selector] of [["figure.png", ".annotatable-figure img"], ["report.pdf", "iframe.report-frame"], ["dashboard.html", ".dashboard-frame iframe"], ["molecule.pdb", ".molstar-launch-card"]]) {
          const modal = await openArtifact(page, name!);
          await expect(modal.locator(selector!)).toBeVisible();
          await expect(modal.locator(".numbered-source")).toHaveCount(0);
          await closeArtifact(modal);
        }
        const modal = await openArtifact(page, "binary.bin");
        await expect(modal.getByText("Binary artifact: use the download button to inspect it.")).toBeVisible();
        await expect(modal.locator(".numbered-source")).toHaveCount(0);
      });
    } finally { if (fixture) await cleanupJourney(page, fixture); }
  });

  /**
   * E2E-META
   * Purpose: Read workspace text files in-app, preserve the Markdown reader and download untruncated source.
   * Steps:
   *   1. Upload text fixtures in an isolated Project/Session and expand Workspace files.
   *   2. Open Python, unknown UTF-8 and empty text without opening browser tabs.
   *   3. Open a large log, see truncation guidance and download the full file.
   *   4. Open Markdown and its numbered source; reopen Python at a narrow viewport.
   * Environment: Isolated product Web/API at E2E_BASE_URL; English locale; no Run required.
   * Type: mocked
   * LLM: none
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none; non-local browser requests are blocked.
   * Credentials: E2E_API_TOKEN for the isolated local API.
   * CostSideEffects: temporary Project, uploads and a local download; records deleted in finally.
   */
  test("read workspace source without leaving the app", { tag: "@mocked" }, async ({ journey, page }) => {
    journey.scenario({ goal: "在工作区直接阅读脚本和笔记，不必切换浏览器标签页，并能下载完整文件。", preconditions: ["隔离英文 Web/API；不调用模型"] });
    await page.addInitScript(() => localStorage.setItem("sciencediscovery-locale", "en"));
    let fixture: JourneyFixture | undefined;
    let newTabs = 0;
    const onPage = () => { newTabs++; };
    page.context().on("page", onPage);
    try {
      await journey.step("上传文件并展开工作区文件树", "工作区列出代码、笔记和日志文件。", async () => {
        fixture = await createProjectAndSession(page, { projectName: "Workspace source reading", sessionTitle: "Read my scripts" });
        await openProjectSession(page, fixture);
        await upload(page);
        await (await artifactTree(page)).openPhysicalFiles();
      });
      const open = (name: string) => page.locator("aside.workspace-panel details.physical-files").getByRole("button", { name: `Open ${name}`, exact: true }).click();
      await journey.step("直接阅读代码、未知类型文本和空文本", "阅读器显示内容和行号；代码高亮，未打开新标签页。", async () => {
        for (const [name, language] of [["analysis.py", "python"], ["notes.unknown", "plaintext"], ["empty.txt", "plaintext"]]) {
          await open(name!);
          const reader = page.getByRole("dialog", { name: `Text file: ${name}`, exact: true });
          await expectNumbered(reader, language!);
          await reader.getByRole("button", { name: "Close text reader" }).click();
        }
        expect(newTabs).toBe(0);
      });
      await journey.step("查看截断提示并下载全文", "日志预览有截断说明，下载保留完整的原始内容。", async () => {
        await open("large.log");
        const reader = page.getByRole("dialog", { name: "Text file: large.log" });
        await expect(reader.getByText(/Preview truncated at 100,000/)).toBeVisible();
        const downloadPromise = page.waitForEvent("download");
        await reader.getByRole("button", { name: "Download full file" }).click();
        let content = "";
        for await (const chunk of (await (await downloadPromise).createReadStream())!) content += chunk.toString();
        expect(content).toBe(LARGE);
        await page.keyboard.press("Escape");
        await expect(reader).toHaveCount(0);
      });
      await journey.step("保留 Markdown 阅读器，并在窄屏查看脚本", "Markdown 默认渲染，源码带行号；窄屏脚本与下载、关闭控件都可读可用。", async () => {
        await open("report.md");
        const markdown = page.getByRole("dialog", { name: "Rendered Markdown: report.md" });
        await expect(markdown.getByRole("heading", { name: "Research results" })).toBeVisible();
        await markdown.locator("summary").click();
        await expectNumbered(markdown, "markdown");
        await page.keyboard.press("Escape");
        await open("analysis.py");
        await page.setViewportSize({ width: 390, height: 844 });
        const reader = page.getByRole("dialog", { name: "Text file: analysis.py" });
        await expectNumbered(reader, "python");
        await expect(reader.getByRole("button", { name: "Download full file" })).toBeVisible();
        await expect(reader.getByRole("button", { name: "Close text reader" })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        expect(newTabs).toBe(0);
      });
    } finally { page.context().off("page", onPage); if (fixture) await cleanupJourney(page, fixture); }
  });
});
