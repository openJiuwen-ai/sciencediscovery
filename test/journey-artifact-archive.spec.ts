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

import { execFileSync } from "node:child_process";

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
  type JourneyFixture,
} from "./helpers/journeys.ts";

// Static suite metadata is inherited by each framework-expanded journey.
test.describe("journey-artifact-archive.spec", { tag: ["@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"] }, () => {

/**
 * Read the downloaded archive with CPython's `zipfile`, which shares no code
 * with the packer under test. Handing the file back to the same library that
 * wrote it would pass even on an archive no other unzip tool accepts, and the
 * user opens this one with their own tool.
 */
function readZipText(archivePath: string): Record<string, string> {
  const script = [
    "import json, sys, zipfile",
    "with zipfile.ZipFile(sys.argv[1]) as archive:",
    "    print(json.dumps({name: archive.read(name).decode('utf-8') for name in archive.namelist()}))",
  ].join("\n");
  return JSON.parse(execFileSync("python3", ["-c", script, archivePath], { encoding: "utf8" })) as Record<string, string>;
}

/**
 * E2E-META
 * Purpose: A researcher can select several declared Artifacts and take them away as one ZIP whose entries keep their catalog paths and content.
 * Steps:
 *   1. Prepare a local stub model and an isolated Project/Session.
 *   2. Ask for an analysis that writes and declares two deliverables in different folders.
 *   3. Turn on multi-select and pick both; the download control only becomes usable once something is selected.
 *   4. Download the selection and read the ZIP with an independent unpacker: both paths present, content unchanged.
 * Environment: Isolated local stack at E2E_BASE_URL with managed Python ready and a journey-owned Project/Session.
 * Type: mocked
 * LLM: journey-owned OpenAI-compatible HTTP stub on 127.0.0.1; one deterministic user turn.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — the shell step runs in the offline local sandbox and non-local browser requests are aborted.
 * Credentials: E2E_API_TOKEN for the isolated local API only; the stub token has no external access.
 * CostSideEffects: no external cost; one local download into the run's output directory and temporary records deleted in finally.
 */
test("J10 多份交付物可以打包成一个压缩包带走", { tag: "@mocked" }, async ({ journey, page }, testInfo) => {
  test.setTimeout(210_000);
  await page.addInitScript(() => window.localStorage.setItem("sciencediscovery-locale", "zh-CN"));
  const marker = `J10-${Date.now()}`;
  const summaryText = "# Summary\n\nmean=42.0\n";
  const tableText = "sample,value\na,40\nb,44\n";
  const stub = await scriptedModel([
    [
      {
        arguments: {
          command: "python3 - <<'PY'\n" + [
            "from pathlib import Path",
            "Path('results').mkdir(exist_ok=True)",
            "Path('tables').mkdir(exist_ok=True)",
            `Path('results/summary.md').write_text(${JSON.stringify(summaryText)}, encoding='utf-8')`,
            `Path('tables/measurements.csv').write_text(${JSON.stringify(tableText)}, encoding='utf-8')`,
            `print('${marker}')`,
          ].join("\n") + "\nPY",
        },
        delayMs: 500,
        tool: "run_shell",
      },
      { arguments: { path: "results/summary.md" }, tool: "declare_artifact" },
      { arguments: { path: "tables/measurements.csv" }, tool: "declare_artifact" },
      { text: "Both deliverables are ready: results/summary.md and tables/measurements.csv." },
    ],
  ]);
  const fixture: JourneyFixture = await createProjectAndSession(page, {
    approvalMode: "always_allow",
    model: {
      apiToken: stub.apiToken,
      baseUrl: stub.baseUrl,
      model: stub.model,
      name: `J10 local model ${Date.now()}`,
    },
    projectName: `J10 artifact archive ${Date.now()}`,
    sessionTitle: `J10 archive session ${Date.now()}`,
  });

  journey.scenario({
    goal: "一位研究员这轮分析交付了两份东西：一份报告和一张数据表。她要把这两份一次性打包带给同事，"
      + "而不是一个个点开下载，并且压缩包解开后目录结构和内容要跟产物区看到的一致。",
    preconditions: [
      "隔离栈已启动，托管 Python 可用",
      "已有一个由旅程创建的项目与会话，审批模式为「始终允许」",
      "模型由旅程自带的本地 stub 驱动：一轮里写出并声明 results/summary.md 与 tables/measurements.csv",
    ],
  });

  try {
    await journey.step(
      "让分析产出两份交付物",
      "运行结束后产物区出现两条记录：results/summary.md 和 tables/measurements.csv。",
      async () => {
        await openProjectSession(page, fixture);
        const run = await sendUserMessage(page, fixture.session.id, "Produce the summary report and the measurement table, and declare both as deliverables.");
        const terminal = await waitForRunTerminal(page, fixture.session.id, run.id);
        expect(terminal.status, terminal.error).toBe("completed");
        await expect(await expandToolStep(page, { contains: marker })).toContainText(marker);
        const tree = await artifactTree(page);
        await expect(tree.artifactCount).toHaveText("2", { timeout: 30_000 });
        await expect(tree.artifacts).toHaveCount(2);
      },
    );

    await journey.step(
      "进入多选并勾选这两份产物",
      "没选任何东西时「下载所选」是灰的；勾上两份之后它才可用，按钮上还写明已选 2 项。",
      async () => {
        const tree = await artifactTree(page);
        const download = tree.catalog.getByRole("button", { name: "下载所选" });
        await expect(download).toBeDisabled();
        await tree.catalog.getByRole("button", { name: "多选", exact: true }).click();
        await expect(download).toBeDisabled();
        for (const name of ["results/summary.md", "tables/measurements.csv"]) {
          await tree.catalog.getByRole("checkbox", { name: `选择 ${name}` }).click();
        }
        await expect(download).toBeEnabled();
        await expect(download).toHaveAttribute("title", /已选 2 项/);
      },
    );

    await journey.step(
      "下载压缩包并核对里面的内容",
      "浏览器收到 artifacts.zip；用独立的解压实现打开它，里面就是那两份文件，路径与内容跟产物区一致，界面也提示压缩包已下载。",
      async () => {
        const tree = await artifactTree(page);
        const downloadPromise = page.waitForEvent("download");
        await tree.catalog.getByRole("button", { name: "下载所选" }).click();
        const download = await downloadPromise;
        expect(download.suggestedFilename()).toBe("artifacts.zip");
        const archivePath = testInfo.outputPath("artifacts.zip");
        await download.saveAs(archivePath);
        const entries = readZipText(archivePath);
        expect(Object.keys(entries).sort()).toEqual(["results/summary.md", "tables/measurements.csv"]);
        expect(entries["results/summary.md"]).toBe(summaryText);
        expect(entries["tables/measurements.csv"]).toBe(tableText);
        await expect(page.getByText("产物压缩包已下载")).toBeVisible();
      },
    );
  } finally {
    await cleanupJourney(page, fixture);
    await stub.stop();
  }
});

});
