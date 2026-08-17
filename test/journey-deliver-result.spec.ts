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

import { expect } from "@playwright/test";

import { test } from "./helpers/e2e.ts";
import {
  artifactTree,
  cleanupJourney,
  createProjectAndSession,
  expandToolStep,
  openProjectSession,
  scriptedModel,
  sendUserMessage,
  waitForRunTerminal,
} from "./helpers/journeys.ts";

/**
 * E2E-META
 * Purpose: A researcher can receive one declared report, inspect and download it, update it as a new version, and distinguish scratch files from Artifacts.
 * Steps:
 *   1. Prepare a local stub model and an isolated Project/Session; confirm the Artifact catalog is empty.
 *   2. Ask for an analysis whose Python step creates a scratch CSV and a declared Markdown summary.
 *   3. Inspect marked tool I/O, preview/download the report, and inspect its working-directory/process provenance.
 *   4. Ask for an update of the same report and verify one Artifact has two switchable versions.
 *   5. Verify @ suggestions include only the declared report while the separate workspace-file tree also exposes the scratch CSV.
 * Environment: Isolated local stack at E2E_BASE_URL with managed Python ready and a journey-owned Project/Session.
 * Type: mocked
 * LLM: journey-owned OpenAI-compatible HTTP stub on 127.0.0.1; two deterministic user turns.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — Python executes in the offline local sandbox and non-local browser requests are aborted.
 * Credentials: E2E_API_TOKEN for the isolated local API only; the stub token has no external access.
 * CostSideEffects: no external cost; one local download and temporary records deleted in finally.
 */
test("J2 交付的报告可预览下载并保留版本", { tag: "@mocked" }, async ({ journey, page }) => {
  test.setTimeout(210_000);
  const firstMarker = `J2-FIRST-${Date.now()}`;
  const secondMarker = `J2-SECOND-${Date.now()}`;
  const stub = await scriptedModel([
    [
      {
        arguments: {
          code: [
            "from pathlib import Path",
            "Path('scratch').mkdir(exist_ok=True)",
            "Path('results').mkdir(exist_ok=True)",
            "Path('scratch/intermediate.csv').write_text('value\\n40\\n44\\n', encoding='utf-8')",
            "Path('results/summary.md').write_text('# Summary\\n\\nmean=42.0\\n', encoding='utf-8')",
            `print('${firstMarker}')`,
          ].join("\n"),
          kernelMode: "ephemeral",
        },
        delayMs: 500,
        tool: "run_python",
      },
      { arguments: { path: "results/summary.md" }, tool: "declare_artifact" },
      { text: "The analysis is complete. Download or preview results/summary.md; its mean is 42.0." },
    ],
    [
      {
        arguments: {
          code: [
            "from pathlib import Path",
            "Path('results/summary.md').write_text('# Summary\\n\\nmean=50.0\\n', encoding='utf-8')",
            `print('${secondMarker}')`,
          ].join("\n"),
          kernelMode: "ephemeral",
        },
        tool: "run_python",
      },
      { arguments: { path: "results/summary.md" }, tool: "declare_artifact" },
      { text: "The updated results/summary.md now reports mean=50.0." },
    ],
  ]);
  const fixture = await createProjectAndSession(page, {
    approvalMode: "always_allow",
    model: {
      apiToken: stub.apiToken,
      baseUrl: stub.baseUrl,
      model: stub.model,
      name: `J2 local model ${Date.now()}`,
    },
    projectName: `J2 deliver result ${Date.now()}`,
    sessionTitle: `J2 report session ${Date.now()}`,
  });

  journey.scenario({
    goal: "一位做数据分析的研究员，要的不是聊天里贴出的数字，而是项目里多出一份能预览、能下载、"
      + "改过之后还能看到上一版的交付物；同时不希望中间临时文件冒充成果。",
    preconditions: [
      "隔离栈已启动，托管 Python 可用",
      "已有一个由旅程创建的项目与会话，审批模式为「始终允许」，产物目录初始为空",
      "模型由旅程自带的本地 stub 驱动：第一轮写中间 CSV 与 summary 并只声明 summary，第二轮改写同一份 summary",
    ],
  });

  let tree!: Awaited<ReturnType<typeof artifactTree>>;
  try {
    await journey.step(
      "进入会话，确认还没有任何产物",
      "右栏产物区是空的，计数为 0，说明后面出现的东西确实是这次分析产生的。",
      async () => {
        await openProjectSession(page, fixture);
        tree = await artifactTree(page);
        await expect(tree.artifactCount).toHaveText("0");
        await expect(tree.artifacts).toHaveCount(0);
      },
    );

    await journey.step(
      "提出分析需求并等待运行结束",
      "运行结束后，展开代码执行步骤能看到本轮的输出标记，说明计算真的在本机跑过。",
      async () => {
        const firstRun = await sendUserMessage(
          page,
          fixture.session.id,
          "Analyze the small measurement set, keep intermediate data private, and deliver a Markdown summary.",
        );
        expect((await waitForRunTerminal(page, fixture.session.id, firstRun.id)).status).toBe("completed");
        const tool = await expandToolStep(page, { contains: firstMarker });
        await expect(tool).toContainText(firstMarker);
      },
    );

    await journey.step(
      "在右栏看到唯一的一份交付物",
      "产物区出现 results/summary.md，归在当前会话分组下，计数为 1；"
        + "同一次执行写出的 scratch/intermediate.csv 因为没有被声明，不出现在这里。",
      async () => {
        tree = await artifactTree(page);
        await expect(tree.artifactCount).toHaveText("1", { timeout: 30_000 });
        await expect(tree.artifacts).toHaveCount(1);
        await expect(tree.sessionGroups.first()).toContainText(fixture.session.title);
        await expect(tree.catalog.getByRole("button", { name: "Open results/summary.md" })).toBeVisible();
        await expect(tree.catalog.getByRole("button", { name: /scratch\/intermediate\.csv/ })).toHaveCount(0);
      },
    );

    await journey.step(
      "预览、下载这份报告并查看它的来源",
      "报告在面板内预览出第一版内容，可下载为 summary.md；溯源里能看到这次执行的工作目录与进程环境。",
      async () => {
        await tree.catalog.getByRole("button", { name: "Open results/summary.md" }).click();
        const modal = page.getByRole("dialog", { name: "Artifact: results/summary.md" });
        await expect(modal.locator(".manuscript-preview")).toContainText("mean=42.0");
        const downloadPromise = page.waitForEvent("download");
        await modal.getByRole("button", { name: "Download current version" }).click();
        const download = await downloadPromise;
        expect(download.suggestedFilename()).toBe("summary.md");
        await modal.getByRole("button", { name: "Provenance" }).click();
        await expect(modal).toContainText("Working directory");
        await expect(modal).toContainText(/Process environment/);
        await modal.getByRole("button", { name: "Close artifact viewer" }).click();
      },
    );

    await journey.step(
      "要求改一版，确认它还是同一份交付物",
      "第二轮运行结束后，产物区仍然只有一条 results/summary.md，而不是多出第二份同名文件。",
      async () => {
        const secondRun = await sendUserMessage(
          page,
          fixture.session.id,
          "Revise the existing summary with the updated measurements; keep it as the same deliverable.",
        );
        expect((await waitForRunTerminal(page, fixture.session.id, secondRun.id)).status).toBe("completed");
        await expect(await expandToolStep(page, { contains: secondMarker })).toContainText(secondMarker);
        tree = await artifactTree(page);
        await expect(tree.artifactCount).toHaveText("1", { timeout: 30_000 });
        await expect(tree.artifacts).toHaveCount(1);
      },
    );

    await journey.step(
      "在版本之间来回切换，确认旧版本没有丢",
      "版本选择器给出两个版本；默认显示新版本的数值，切回上一版能重新看到旧数值。",
      async () => {
        await tree.catalog.getByRole("button", { name: "Open results/summary.md" }).click();
        const modal = page.getByRole("dialog", { name: "Artifact: results/summary.md" });
        const versionSelect = modal.getByLabel("Artifact version");
        await expect(versionSelect.locator("option")).toHaveCount(2);
        await expect(modal.locator(".manuscript-preview")).toContainText("mean=50.0");
        const olderVersion = await versionSelect.locator("option").nth(1).getAttribute("value");
        expect(olderVersion).toBeTruthy();
        await versionSelect.selectOption(olderVersion!);
        await expect(modal.locator(".manuscript-preview")).toContainText("mean=42.0");
        await modal.getByRole("button", { name: "Close artifact viewer" }).click();
      },
    );

    await journey.step(
      "在输入框用 @ 引用产物",
      "候选里只有已声明的 results/summary.md，并显示包含目录的完整名字；未声明的中间文件不在候选里。",
      async () => {
        const candidates = await tree.mentionCandidates();
        await expect(candidates).toHaveCount(1);
        await expect(candidates.first()).toContainText("results/summary.md");
        await expect(candidates.filter({ hasText: "scratch/intermediate.csv" })).toHaveCount(0);
        await page.locator("form.composer").getByRole("textbox").fill("");
      },
    );

    await journey.step(
      "打开「查看工作区文件」核对中间文件确实存在",
      "中间文件本身没有丢：在这棵独立的工作区文件树里能看到它，它只是没有资格进入产物目录。",
      async () => {
        await tree.openPhysicalFiles();
        await expect(tree.physicalFiles.filter({ hasText: "summary.md" })).toHaveCount(1);
        await expect(tree.physicalFiles.filter({ hasText: "intermediate.csv" })).toHaveCount(1);
        await expect(page.getByRole("button", { name: "Open scratch/intermediate.csv" })).toBeVisible();
      },
    );
  } finally {
    await cleanupJourney(page, fixture);
    await stub.stop();
  }
});
