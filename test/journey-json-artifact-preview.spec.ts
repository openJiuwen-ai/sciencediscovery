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

import { expect, type Locator } from "@playwright/test";

import { test } from "./helpers/e2e.ts";
import {
  artifactTree,
  cleanupJourney,
  createProjectAndSession,
  openProjectSession,
  scriptedModel,
  sendUserMessage,
  waitForRunTerminal,
} from "./helpers/journeys.ts";


/** Issue #69-shaped document: formatted JSON whose dna/rna values never contain a space. */
const DNA_VALUE = "GTCAACACTGGTTTGAAAACGGCGGCGGCGACGCTTCAGCGGCGGCAGCTGCAGCGTGAGCGTGACCACGACGGCATTCATCTATGTGCTGCAGAAGCCTGGGCTCGGTTCCCGCAGGCGCCTGAAGCAGCTGAAGCGGTGAAGCGGTGGCGGCGATTGATGGCGTACGTCAACGGCGGCGGCGACGTTCAGCGGCGGCAGCUGCAGCGUGAGCGUGACCACGACGGCAUUCAUCUAUGUGCUGCAGAAGCCUGGGCUCGGUUCCCGCAGGCGCCUGAAGCAGCUGAAGCGGUGAAGCGGUGGCGGCGAUUGAUGGCGUACGUCAACGGCGGCGG";
const RNA_VALUE = DNA_VALUE.replace(/T/g, "U");
const PROTEIN_VALUE = "MQLVEGGGDVAGGSLRLSCTASGASIETTLQSLGWFRQAPGQEREAVAIGDQNTYYADSVKGRFTISRDNAKNTVTLQMNNLKPEDTAIYYCAASPRTGSLSLPESYVYMGGTQVTVSS";

function sequencesDocument() {
  const designs = [0, 1, 2, 3].map((index) => ({
    chain: "B",
    design: `output_00000${index}_d1design_0`,
    dna: DNA_VALUE,
    dna_length: DNA_VALUE.length,
    organism: "Escherichia coli general",
    protein: PROTEIN_VALUE,
    protein_length: PROTEIN_VALUE.length,
    rna: RNA_VALUE,
    variant: 0,
  }));
  return JSON.stringify({
    organism: "Escherichia coli general",
    results: designs,
    total_designs: designs.length,
    total_sequences: designs.length,
  }, null, 2);
}

/** Geometry guard for #69: the dialog must fit the viewport and nothing inside it may bleed past the card or force page-level horizontal scroll. */
async function previewGeometry(modal: Locator) {
  return modal.evaluate((dialog) => {
    const dialogRect = dialog.getBoundingClientRect();
    const body = dialog.querySelector<HTMLElement>(".artifact-modal-body");
    const pre = dialog.querySelector<HTMLElement>("pre.artifact-source-preview");
    const bleeders: string[] = [];
    dialog.querySelectorAll<HTMLElement>(".artifact-modal-body *").forEach((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.right > dialogRect.right + 1) {
        bleeders.push(`${element.tagName.toLowerCase()}.${String(element.className).split(" ")[0]} right=${Math.round(rect.right)}`);
      }
    });
    return {
      bleeders: bleeders.slice(0, 8),
      bodyClientWidth: body?.clientWidth ?? 0,
      bodyScrollWidth: body?.scrollWidth ?? 0,
      dialogLeft: Math.round(dialogRect.left),
      dialogRight: Math.round(dialogRect.right),
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      preClientWidth: pre?.clientWidth ?? 0,
      preScrollWidth: pre?.scrollWidth ?? 0,
      viewportWidth: window.innerWidth,
    };
  });
}

/** The whole story of #69: an oversized dialog whose right edge left the viewport, taking the content with it. */
function expectDialogOnScreen(geometry: Awaited<ReturnType<typeof previewGeometry>>) {
  expect(geometry.dialogLeft, "dialog bleeds past the left viewport edge").toBeGreaterThanOrEqual(0);
  expect(geometry.dialogRight, `dialog right edge ${geometry.dialogRight} exceeds the ${geometry.viewportWidth}px viewport`).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  expect(geometry.bleeders, `content bleeds past the dialog: ${geometry.bleeders.join(", ")} (dialog right=${geometry.dialogRight})`).toHaveLength(0);
  expect(geometry.documentScrollWidth).toBeLessThanOrEqual(geometry.documentClientWidth);
  expect(geometry.bodyScrollWidth).toBeLessThanOrEqual(geometry.bodyClientWidth + 1);
}

/**
 * E2E-META
 * Purpose: A researcher opens a JSON artifact whose values contain long unbreakable strings (DNA/RNA-like) and can read the loaded preview completely in-panel — nothing is silently clipped at the container edge — while the table/raw switch, truncation hint and download contracts stay intact.
 * Steps:
 *   1. Prepare a local stub model and an isolated Project/Session; confirm the Artifact catalog is empty.
 *   2. Ask for an analysis whose Python step declares a long-sequence JSON, a record-array JSON, and an over-budget JSON.
 *   3. Open the long-sequence JSON in the artifact viewer: the full dna/rna values stay readable inside the dialog, with no content bleeding past the card and no page-level horizontal scroll, on desktop and on a narrow viewport.
 *   4. Open the record-array JSON: the table renders by default and Raw JSON still shows the original document.
 *   5. Open the over-budget JSON: the visible truncation hint is shown and the full file still downloads.
 * Environment: Isolated local stack at E2E_BASE_URL with managed Python ready and a journey-owned Project/Session.
 * Type: mocked
 * LLM: journey-owned OpenAI-compatible HTTP stub on 127.0.0.1; one deterministic user turn.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — Python executes in the offline local sandbox and non-local browser requests are aborted.
 * Credentials: E2E_API_TOKEN for the isolated local API only; the stub token has no external access.
 * CostSideEffects: no external cost; one local download and temporary records deleted in finally.
 */
test("J8 打开超长字段 JSON 产物时预览完整可读且契约不变", { tag: "@mocked" }, async ({ journey, page }) => {
  test.setTimeout(210_000);
  const marker = `J8-SEQUENCES-${Date.now()}`;
  const bigPayload = "lorem ipsum dolor sit amet ".repeat(4_500);
  const python = [
    "import json",
    "from pathlib import Path",
    "Path('results').mkdir(exist_ok=True)",
    `sequences = json.loads(${JSON.stringify(sequencesDocument())})`,
    "Path('results/sequences.json').write_text(json.dumps(sequences, indent=2), encoding='utf-8')",
    "rows = [{'design': f'design-{i}', 'organism': 'Escherichia coli general', 'score': round(0.5 + i * 0.1, 2)} for i in range(6)]",
    "Path('results/table.json').write_text(json.dumps(rows, indent=2), encoding='utf-8')",
    `big = {'description': 'over-budget preview probe', 'payload': ${JSON.stringify(bigPayload)}}`,
    "Path('results/big.json').write_text(json.dumps(big, indent=2), encoding='utf-8')",
    `print('${marker}')`,
  ].join("\n");
  const stub = await scriptedModel([
    [
      { arguments: { code: python, kernelMode: "ephemeral" }, delayMs: 300, tool: "run_python" },
      { arguments: { path: "results/sequences.json" }, tool: "declare_artifact" },
      { arguments: { path: "results/table.json" }, tool: "declare_artifact" },
      { arguments: { path: "results/big.json" }, tool: "declare_artifact" },
      { text: "Declared results/sequences.json, results/table.json, and results/big.json." },
    ],
  ]);
  const fixture = await createProjectAndSession(page, {
    approvalMode: "always_allow",
    model: {
      apiToken: stub.apiToken,
      baseUrl: stub.baseUrl,
      model: stub.model,
      name: `J8 local model ${Date.now()}`,
    },
    projectName: `J8 json preview ${Date.now()}`,
    sessionTitle: `J8 json preview session ${Date.now()}`,
  });

  journey.scenario({
    goal: "研究员打开内容很多的 JSON 产物（含 DNA/RNA 这类无空格超长字段），要在面板里把预览内容完整读完，"
      + "不能在容器右缘无声消失；表格/Raw 切换、超长截断提示和下载也要保持原样。",
    preconditions: [
      "隔离栈已启动，托管 Python 可用",
      "已有一个由旅程创建的项目与会话，审批模式为「始终允许」，产物目录初始为空",
      "模型由旅程自带的本地 stub 驱动：一轮写出并声明 sequences.json（超长无空格 dna/rna 字段）、table.json（记录数组）与 big.json（超过预览预算）",
    ],
  });

  try {
    await journey.step(
      "进入会话，确认还没有任何产物",
      "右栏产物区是空的，计数为 0，后面的产物确实来自这次分析。",
      async () => {
        await openProjectSession(page, fixture);
        const tree = await artifactTree(page);
        await expect(tree.artifactCount).toHaveText("0");
        await expect(tree.artifacts).toHaveCount(0);
      },
    );

    await journey.step(
      "提出分析需求并等待运行结束",
      "stub 模型写出并声明三份 JSON 产物，运行正常完成。",
      async () => {
        const run = await sendUserMessage(
          page,
          fixture.session.id,
          "Deliver the sequence design summary as JSON artifacts.",
        );
        const terminal = await waitForRunTerminal(page, fixture.session.id, run.id);
        expect(terminal.status, terminal.error).toBe("completed");
      },
    );

    let tree!: Awaited<ReturnType<typeof artifactTree>>;
    await journey.step(
      "在右栏看到三份 JSON 产物",
      "产物区计数为 3，sequences.json / table.json / big.json 都在。",
      async () => {
        tree = await artifactTree(page);
        await expect(tree.artifactCount).toHaveText("3", { timeout: 30_000 });
        await expect(tree.artifacts).toHaveCount(3);
      },
    );

    await journey.step(
      "打开含超长 dna/rna 字段的 JSON，桌面视口下完整可读",
      "Preview 里是格式化 JSON；超长字段没有越过对话框右缘，页面也没有出现横向滚动。",
      async () => {
        await tree.catalog.getByRole("button", { name: "Open results/sequences.json" }).click();
        const modal = page.getByRole("dialog", { name: "Artifact: results/sequences.json" });
        const preview = modal.locator("pre.artifact-source-preview");
        await expect(preview).toBeVisible();
        await expect(preview).toContainText(DNA_VALUE);
        await expect(modal).not.toContainText("Preview truncated");
        expectDialogOnScreen(await previewGeometry(modal));
        const wrapped = await previewGeometry(modal);
        expect(wrapped.preScrollWidth, "long unbreakable values must wrap inside the preview instead of forcing horizontal scrolling").toBeLessThanOrEqual(wrapped.preClientWidth + 1);
      },
    );

    await journey.step(
      "窄视口下同样完整可读",
      "把窗口压窄后重开同一产物，超长字段仍然不越界、页面仍无横向滚动。",
      async () => {
        await page.setViewportSize({ width: 760, height: 900 });
        const modal = page.getByRole("dialog", { name: "Artifact: results/sequences.json" });
        const preview = modal.locator("pre.artifact-source-preview");
        await expect(preview).toContainText(RNA_VALUE);
        expectDialogOnScreen(await previewGeometry(modal));
        await page.setViewportSize({ width: 1440, height: 900 });
        await modal.getByRole("button", { name: "Close artifact viewer" }).click();
      },
    );

    await journey.step(
      "记录数组 JSON 仍是表格，可切 Raw JSON",
      "table.json 默认显示表格，切到 Raw JSON 能看到原始文档，再切回表格。",
      async () => {
        await tree.catalog.getByRole("button", { name: "Open results/table.json" }).click();
        const modal = page.getByRole("dialog", { name: "Artifact: results/table.json" });
        await expect(modal.locator(".dataset-table")).toBeVisible();
        await expect(modal.locator(".dataset-table")).toContainText("design-0");
        await modal.getByRole("button", { name: "Raw JSON" }).click();
        await expect(modal.locator("pre.artifact-source-preview")).toContainText('"design": "design-0"');
        await modal.getByRole("button", { name: "Table" }).click();
        await expect(modal.locator(".dataset-table")).toContainText("design-5");
        await modal.getByRole("button", { name: "Close artifact viewer" }).click();
      },
    );

    await journey.step(
      "超过预览预算的 JSON 有可见截断提示且能下载完整文件",
      "big.json 显示截断提示，Download 仍能拿到完整文件。",
      async () => {
        await tree.catalog.getByRole("button", { name: "Open results/big.json" }).click();
        const modal = page.getByRole("dialog", { name: "Artifact: results/big.json" });
        await expect(modal.locator("pre.artifact-source-preview")).toBeVisible();
        await expect(modal.getByText("Preview truncated; download the artifact for the full content.")).toBeVisible();
        const downloadPromise = page.waitForEvent("download");
        await modal.getByRole("button", { name: "Download current version" }).click();
        const download = await downloadPromise;
        expect(download.suggestedFilename()).toBe("big.json");
        await modal.getByRole("button", { name: "Close artifact viewer" }).click();
      },
    );
  } finally {
    await cleanupJourney(page, fixture);
    await stub.stop();
  }
});
