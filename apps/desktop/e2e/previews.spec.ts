/**
 * E2E-META
 * Purpose: Exercise the Desktop previews journey against the deterministic API fixture.
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
 * The panel's page for each kind of file a session leaves behind.
 *
 * A script is read line by line with its words coloured, a table is a table,
 * a picture is drawn, a PDF is the browser's viewer, and a workbook is its
 * first sheets with the tabs the workbook itself has. Every one of these used
 * to be `response.text()` printed in a monospaced block, which is why the
 * fixture now serves bytes and a type rather than a string.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { strToU8, zipSync } from "fflate";

import {
  TOKEN,
  TOKEN_STORAGE_KEY,
  installMockApi,
  makeSession,
  type FileContent,
  type MockOptions,
} from "./fixtures.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const PDF = Buffer.from(
  "%PDF-1.4\n"
  + "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
  + "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
  + "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n"
  + "trailer<</Root 1 0 R>>\n%%EOF\n",
  "latin1",
);

/** A workbook with two sheets, one shared string table and one inline string:
 *  enough for the reader to resolve both cell types and the sheet tabs. */
function workbook(): Buffer {
  const parts: Record<string, string> = {
    "xl/_rels/workbook.xml.rels":
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
      + "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
      + "<Relationship Id=\"rId1\" Target=\"worksheets/sheet1.xml\" Type=\"worksheet\"/>"
      + "<Relationship Id=\"rId2\" Target=\"worksheets/sheet2.xml\" Type=\"worksheet\"/>"
      + "</Relationships>",
    "xl/sharedStrings.xml":
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
      + "<sst xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" count=\"3\" uniqueCount=\"3\">"
      + "<si><t>样品</t></si><si><t>强度</t></si><si><t>A</t></si>"
      + "</sst>",
    "xl/workbook.xml":
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
      + "<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\""
      + " xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">"
      + "<sheets><sheet name=\"测量\" sheetId=\"1\" r:id=\"rId1\"/><sheet name=\"汇总\" sheetId=\"2\" r:id=\"rId2\"/></sheets>"
      + "</workbook>",
    "xl/worksheets/sheet1.xml":
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
      + "<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData>"
      + "<row r=\"1\"><c r=\"A1\" t=\"s\"><v>0</v></c><c r=\"B1\" t=\"s\"><v>1</v></c></row>"
      + "<row r=\"2\"><c r=\"A2\" t=\"s\"><v>2</v></c><c r=\"B2\"><v>12.5</v></c></row>"
      + "<row r=\"3\"><c r=\"A3\" t=\"inlineStr\"><is><t>B</t></is></c><c r=\"B3\"><v>3</v></c></row>"
      + "</sheetData></worksheet>",
    "xl/worksheets/sheet2.xml":
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
      + "<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData>"
      + "<row r=\"1\"><c r=\"A1\" t=\"inlineStr\"><is><t>项目</t></is></c><c r=\"B1\" t=\"inlineStr\"><is><t>数值</t></is></c></row>"
      + "<row r=\"2\"><c r=\"A2\" t=\"inlineStr\"><is><t>合计</t></is></c><c r=\"B2\"><v>15.5</v></c></row>"
      + "</sheetData></worksheet>",
  };
  const files = Object.fromEntries(Object.entries(parts).map(([path, xml]) => [path, strToU8(xml)]));
  return Buffer.from(zipSync(files));
}

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function file(path: string, content: FileContent): { files: unknown[]; fileContents: Record<string, FileContent> } {
  const size = typeof content.body === "string" ? Buffer.byteLength(content.body) : content.body.byteLength;
  return {
    files: [{ modifiedAt: "2026-10-01T09:30:00.000Z", path, size }],
    fileContents: { [path]: content },
  };
}

/** Open the workspace panel, switch it to 工作区 and open one file's row. */
async function openFile(page: Page, options: MockOptions, path: string): Promise<Locator> {
  await installMockApi(page, { sessions: [makeSession()], ...options });
  await page.goto("/");
  // A resumed Session reads its file tree on open; the row's absence before
  // that is a wait, not a failure.
  await page.getByRole("button", { name: "工作区面板" }).click();
  const panel = page.locator(".workspace-panel");
  await panel.getByRole("tab", { name: "工作区" }).click();
  const name = path.slice(path.lastIndexOf("/") + 1);
  const row = panel.getByRole("button", { name: new RegExp(name.replace(/\./gu, "\\."), "u") });
  await expect(row).toBeVisible();
  await row.click();
  await expect(panel.locator(".doc-body")).toBeVisible();
  return panel;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [TOKEN_STORAGE_KEY, TOKEN] as const,
  );
});

test.describe("文件预览", () => {
  test("a Python file is a numbered, coloured source page", async ({ page }) => {
    const source = [
      "import math",
      "",
      "def area(radius):",
      "    # 圆的面积",
      "    return math.pi * radius ** 2",
      "",
    ].join("\n");
    const panel = await openFile(page, file("plot.py", { body: source, contentType: "text/plain" }), "plot.py");

    // Five lines of code; the trailing newline is not a sixth empty line.
    await expect(panel.locator(".code-block")).toHaveAttribute("aria-label", "plot.py");
    await expect(panel.locator(".code-line")).toHaveCount(5);
    await expect(panel.locator(".code-line-number").first()).toHaveText("1");
    await expect(panel.locator(".code-line-number").nth(3)).toHaveText("4");
    await expect(panel.locator(".tok-keyword").first()).toHaveText("import");
    await expect(panel.locator(".tok-definition")).toHaveText("area");
    await expect(panel.locator(".tok-comment")).toHaveText("# 圆的面积");
    await expect(panel.locator(".tok-number").first()).toHaveText("2");
  });

  test("a CSV file is a table with a gutter, a numeric column and a row count", async ({ page }) => {
    const csv = "样品,强度\nA,12.5\nB,3\n";
    const panel = await openFile(page, file("samples.csv", { body: csv, contentType: "text/csv" }), "samples.csv");

    await expect(panel.locator(".data-table thead th:not(.data-gutter)")).toHaveText(["样品", "强度"]);
    await expect(panel.locator(".data-table tbody tr")).toHaveCount(2);
    // Numbers are set flush right; the sample names are not.
    await expect(panel.locator(".data-table tbody tr").first().locator("td.is-number")).toHaveText("12.5");
    await expect(panel.locator(".data-caption")).toHaveText("共 2 行");
  });

  test("a PNG is drawn from its bytes and toggles between fit and actual size", async ({ page }) => {
    const panel = await openFile(
      page,
      file("figure.png", { body: PNG, contentType: "image/png" }),
      "figure.png",
    );

    const image = panel.locator(".image-view img");
    await expect(image).toHaveAttribute("src", /^data:image\/png;base64,/u);
    await expect(image).toHaveAttribute("alt", "figure.png 的预览");
    await expect(panel.locator(".image-view")).not.toHaveClass(/is-actual/u);

    await panel.locator(".image-frame").click();
    await expect(panel.locator(".image-view")).toHaveClass(/is-actual/u);
    await expect(panel.locator(".image-frame")).toHaveAttribute("aria-pressed", "true");
    await panel.locator(".image-frame").click();
    await expect(panel.locator(".image-view")).not.toHaveClass(/is-actual/u);
  });

  test("a PDF is the browser's viewer, with a download beside it", async ({ page }) => {
    const panel = await openFile(
      page,
      file("paper.pdf", { body: PDF, contentType: "application/pdf" }),
      "paper.pdf",
    );

    const frame = panel.locator(".pdf-view iframe");
    await expect(frame).toHaveAttribute("title", "paper.pdf");
    await expect(frame).toHaveAttribute("src", /^data:application\/pdf;base64,/u);
    await expect(panel.locator(".pdf-view a")).toHaveAttribute("download", "paper.pdf");
  });

  test("a workbook is a table per sheet, with the workbook's own tabs", async ({ page }) => {
    const panel = await openFile(
      page,
      file("results.xlsx", { body: workbook(), contentType: XLSX_TYPE }),
      "results.xlsx",
    );

    await expect(panel.getByRole("tab", { name: "测量" })).toHaveAttribute("aria-selected", "true");
    await expect(panel.locator(".data-table thead th:not(.data-gutter)")).toHaveText(["样品", "强度"]);
    await expect(panel.locator(".data-table tbody tr")).toHaveCount(2);
    await expect(panel.locator(".data-table tbody")).toContainText("B");

    await panel.getByRole("tab", { name: "汇总" }).click();
    await expect(panel.locator(".data-table thead th:not(.data-gutter)")).toHaveText(["项目", "数值"]);
    await expect(panel.locator(".data-table tbody tr").first()).toContainText("15.5");
    await expect(panel.getByRole("tab", { name: "汇总" })).toHaveAttribute("aria-selected", "true");
  });

  test("a workbook this build cannot read says so instead of drawing an empty sheet", async ({ page }) => {
    const panel = await openFile(
      page,
      file("broken.xlsx", { body: Buffer.from("not a zip at all"), contentType: XLSX_TYPE }),
      "broken.xlsx",
    );

    await expect(panel.locator(".doc-placeholder")).toHaveText("这个工作簿无法读取，请下载后查看。");
    await expect(panel.locator(".data-table")).toHaveCount(0);
  });
});
