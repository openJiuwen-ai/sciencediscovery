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

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect } from "@playwright/test";
import type { PaperAcquisition } from "../packages/schema/src/index.js";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { test } from "./helpers/e2e.ts";
import { artifactTree, cleanupJourney, createProjectAndSession, openProjectSession, type JourneyFixture } from "./helpers/journeys.ts";

// Use the same PDF generator as the paper-upload integration tests.
async function experimentPdf(): Promise<Buffer> {
  const dataDir = process.env.SCIENCE_DISCOVERY_DATA_DIR || process.env.SCIENCE_AGENT_DATA_DIR;
  const python = process.env.SCIENCE_AGENT_PAPER_PYTHON_PATH
    || (dataDir ? resolve(dataDir, "envs/paper/bin/python") : fileURLToPath(new URL("../services/paper/.venv/bin/python", import.meta.url)));
  const { stdout } = await promisify(execFile)(python, ["-c", [
    "import sys",
    "from reportlab.pdfgen import canvas",
    "pdf = canvas.Canvas(sys.stdout.buffer, pagesize=(500, 300))",
    "pdf.drawString(40, 240, 'Protocol: 25 C; three replicates; time in seconds.')",
    "pdf.drawString(40, 220, 'Rate constant: 0.125 per second.')",
    "pdf.save()",
  ].join("\n")], { encoding: "buffer" });
  return stdout;
}

test.describe("Workspace paper intake", { tag: ["@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock"] }, () => {
  test.use({ locale: "en-US" });
  /**
   * E2E-META
   * Purpose: A researcher drops a PDF and CSV together, reads the parsed protocol in the same session, and recovers from an invalid PDF without losing other attachments.
   * Steps:
   *   1. Open an isolated session and drop a valid PDF and CSV through the workspace Drop files control.
   *   2. Open the extracted text in the workspace Markdown reader.
   *   3. Open the CSV in its existing table viewer.
   *   4. Use the file picker to upload an invalid PDF, a MIME-identified PDF and another CSV; confirm partial failure and continued parsing.
   * Environment: Isolated local Web/API with the real local paper worker and its existing ReportLab test dependency; no agent Run required.
   * Type: mocked
   * LLM: none
   * WebSearch: none
   * PaperSources: locally generated PDF; real pdfplumber extraction, no remote paper source.
   * MCP: none
   * OtherExternal: none; ReportLab generates the local fixture and non-local browser traffic is blocked.
   * Credentials: E2E_API_TOKEN for the isolated local API.
   * CostSideEffects: no external cost; temporary Project, Session and uploads are deleted in finally.
   */
  test("Drop files parses PDFs and preserves ordinary attachments through failures", { tag: "@mocked" }, async ({ journey, page }) => {
    test.setTimeout(180_000);
    journey.scenario({
      goal: "把实验 PDF 和 CSV 放入同一会话，直接阅读解析出的实验条件，并在一个 PDF 损坏时继续使用其他附件。",
      preconditions: ["隔离的英文 Web/API 已启动，使用真实本地论文解析器，不调用模型"],
    });
    await page.addInitScript(() => localStorage.setItem("sciencediscovery-locale", "en"));
    let fixture: JourneyFixture | undefined;
    let paper: PaperAcquisition;
    const uploads: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && /\/(papers|workspace)\/upload/.test(request.url())) uploads.push(request.url());
    });
    const papers = async (): Promise<PaperAcquisition[]> => {
      const response = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture!.session.id}/papers`, { headers: authorizationHeader() });
      expect(response.ok()).toBe(true);
      return response.json();
    };
    try {
      await journey.step("拖入实验 PDF 和 CSV", "PDF 成为当前会话里已解析的论文，CSV 保持普通附件，只有 PDF 进入论文上传接口。", async () => {
        fixture = await createProjectAndSession(page, { projectName: "Drop PDF intake", sessionTitle: "Read experimental protocol" });
        await openProjectSession(page, fixture);
        const drop = page.locator("aside.workspace-panel label.drop-zone");
        await expect(drop).toContainText("PDFs are parsed as papers automatically");
        const dataTransfer = await page.evaluateHandle(({ pdf }) => {
          const data = new DataTransfer();
          data.items.add(new File([Uint8Array.from(pdf)], "experiment_notes.PDF", { type: "application/octet-stream" }));
          data.items.add(new File(["time_s,value\n0,1\n1,0.88\n"], "measurements.csv", { type: "text/csv" }));
          return data;
        }, { pdf: [...await experimentPdf()] });
        await drop.dispatchEvent("drop", { dataTransfer });
        await dataTransfer.dispose();
        await expect.poll(async () => (await papers()).length).toBe(1);
        paper = (await papers())[0]!;
        expect(paper.status).toBe("succeeded");
        expect(paper.title).toBe("experiment_notes.PDF");
        expect(paper.sessionId).toBe(fixture.session.id);
        expect(paper.extraction.textCharacters).toBeGreaterThan(50);
        expect(uploads.filter((url) => url.includes("/papers/upload"))).toHaveLength(1);
        expect(uploads.filter((url) => url.includes("/workspace/upload"))).toHaveLength(1);
        const tree = await (await artifactTree(page)).openPhysicalFiles();
        await expect(tree.getByRole("button", { name: "Open measurements.csv", exact: true })).toBeVisible();
      });
      await journey.step("阅读解析后的实验条件", "解析后的 Markdown 正文在应用内显示温度、重复次数和单位。", async () => {
        const textPath = paper.manifestPath.replace(/manifest\.json$/, "") + paper.extraction.textPath;
        const tree = await (await artifactTree(page)).openPhysicalFiles();
        await tree.getByRole("button", { name: `Open ${textPath}`, exact: true }).click();
        const reader = page.getByRole("dialog", { name: `Rendered Markdown: ${textPath}`, exact: true });
        await expect(reader).toContainText("Protocol: 25 C; three replicates; time in seconds.");
        await expect(reader).toContainText("Rate constant: 0.125 per second.");
      });
      await journey.step("检查上传的 CSV", "CSV 仍在原来的交互表格中打开，并显示全部两行测量数据。", async () => {
        await page.keyboard.press("Escape");
        const tree = await (await artifactTree(page)).openPhysicalFiles();
        await tree.getByRole("button", { name: "Open measurements.csv", exact: true }).click();
        const viewer = page.getByRole("dialog", { name: "CSV Visualization Workspace: measurements.csv" });
        await expect(viewer.locator(".csva-source-strip")).toContainText("2 rows");
      });
      await journey.step("上传损坏 PDF 并继续处理其他附件", "损坏 PDF 明确报错；后面的 PDF 仍解析成功，新的 CSV 仍保存为附件，论文总数为两篇。", async () => {
        await page.keyboard.press("Escape");
        await page.locator("aside.workspace-panel label.drop-zone input[type=file]").setInputFiles([
          { buffer: Buffer.from("invalid pdf"), mimeType: "application/pdf", name: "broken.pdf" },
          { buffer: await experimentPdf(), mimeType: "application/pdf", name: "protocol" },
          { buffer: Buffer.from("sample,value\nA,3\n"), mimeType: "text/csv", name: "additional.csv" },
        ]);
        await expect.poll(async () => (await papers()).length).toBe(2);
        await expect(page.locator(".toast", { hasText: "broken.pdf" })).toBeVisible();
        expect((await papers()).map((item) => item.title).sort()).toEqual(["experiment_notes.PDF", "protocol"]);
        expect(uploads.filter((url) => url.includes("/papers/upload"))).toHaveLength(3);
        expect(uploads.filter((url) => url.includes("/workspace/upload"))).toHaveLength(2);
        const tree = await (await artifactTree(page)).openPhysicalFiles();
        await expect(tree.getByRole("button", { name: "Open additional.csv", exact: true })).toBeVisible();
      });
    } finally {
      if (fixture) await cleanupJourney(page, fixture);
    }
  });
});
