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

import { requireRealEnv, requireRealStack, test } from "./helpers/e2e.ts";
import {
  artifactTree,
  cleanupJourney,
  createProjectAndSession,
  environmentSetup,
  openProjectSession,
  readRunActivity,
  sendUserMessage,
  waitForRunTerminal,
} from "./helpers/journeys.ts";

/**
 * E2E-META
 * Purpose: A real user request can generate measurements, calculate summary statistics, and deliver a referenced Markdown result through the full stack.
 * Steps:
 *   1. Gate real credentials/full-stack health, verify managed Python is ready, then register the requested model and prepare a Project/Session.
 *   2. Ask naturally for generated measurement data, mean/standard deviation, and a Markdown report whose filename the model chooses.
 *   3. Observe running/terminal feedback and at least one user-visible code-execution-class tool step.
 *   4. Verify a non-empty answer, at least one previewable .md Artifact, and a filename mentioned by the answer that matches the Artifact catalog.
 * Environment: Explicit real project on an isolated stack at E2E_BASE_URL with API/Runner/Gateway healthy and managed Python ready.
 * Type: real
 * LLM: live OpenAI-compatible provider selected by E2E_LLM_BASE_URL and E2E_LLM_MODEL; wording, filenames, and tool sequence vary.
 * WebSearch: none requested
 * PaperSources: none
 * MCP: local workspace/code/artifact tools only; exact tool name and call count are intentionally not fixed.
 * OtherExternal: configured live LLM endpoint; generated code executes in the offline local sandbox.
 * Credentials: E2E_API_TOKEN, E2E_LLM_BASE_URL, E2E_LLM_MODEL, and E2E_LLM_TOKEN.
 * CostSideEffects: billable provider tokens/rate limits; temporary local model and Project records are deleted in finally.
 */
test("J5 真实请求生成统计结果并交付 Markdown", { tag: "@real" }, async ({ journey, page }, testInfo) => {
  journey.scenario({
    goal: "一位不关心内部机制的研究员，只想像跟同事说话一样提一个需求，然后拿到能打开的结果文件。"
      + "这条旅程回答的是「用户那样说，产品自己走得通吗」。",
    preconditions: [
      "E2E_REAL=1，且 E2E_LLM_BASE_URL / E2E_LLM_MODEL / E2E_LLM_TOKEN 均已配置（缺失即判 BLOCKED）",
      "API / Runner / Gateway 健康，托管 Python base 已就绪",
      "模型是真实服务，措辞、文件名与工具顺序都不确定，只断言用户目标是否达成",
    ],
  });

  let real!: Record<string, string>;
  await journey.step(
    "确认真实模型凭据与整套栈的健康状态",
    "缺少任一真实模型环境变量、栈不健康或托管 Python 未就绪时，本旅程判为前置未满足（BLOCKED），而不是通过。",
    async () => {
      real = requireRealEnv(testInfo, "E2E_LLM_BASE_URL", "E2E_LLM_MODEL", "E2E_LLM_TOKEN");
      await requireRealStack(testInfo);
      test.setTimeout(600_000);
      const setup = await environmentSetup(page);
      testInfo.skip(
        setup.state !== "ready",
        `BLOCKED: managed Python base is not ready (${setup.state}: ${setup.message})`,
      );
    },
  );

  const fixture = await createProjectAndSession(page, {
    approvalMode: "always_allow",
    model: {
      apiToken: real.E2E_LLM_TOKEN,
      baseUrl: real.E2E_LLM_BASE_URL,
      model: real.E2E_LLM_MODEL,
      name: `J5 real model ${Date.now()}`,
    },
    projectName: `J5 real request ${Date.now()}`,
    sessionTitle: `J5 statistics session ${Date.now()}`,
  });

  let mentioned: string[] = [];
  let markdownArtifacts: string[] = [];
  let tree!: Awaited<ReturnType<typeof artifactTree>>;

  try {
    await journey.step(
      "用自然语言提出一个真实的分析需求",
      "任务发出后出现可点的停止按钮，随后运行走到完成态；全程用户没有指定任何工具或文件名。",
      async () => {
        await openProjectSession(page, fixture);
        const run = await sendUserMessage(
          page,
          fixture.session.id,
          "Generate a small set of measurement data, calculate its mean and standard deviation with code, and save a concise Markdown report. Tell me the report filename when you finish.",
        );
        await expect(page.getByRole("button", { name: "Stop the current run" })).toBeVisible({ timeout: 30_000 });
        const terminal = await waitForRunTerminal(page, fixture.session.id, run.id, 540_000);
        expect(terminal.status).toBe("completed");
      },
    );

    await journey.step(
      "确认产品确实动手算了，而不是只在聊天",
      "时间线里至少出现一次代码执行类的工具步骤；用户不关心它选的是 shell 还是 Python，所以不锁死工具与次数。",
      async () => {
        const activity = await readRunActivity(page, { expandTools: true });
        expect(
          activity.tools.some((tool) => /run (python|shell|r)|execute|code/i.test(`${tool.summary}\n${tool.details}`)),
          "the journey should visibly include at least one code-execution-class tool step",
        ).toBe(true);
      },
    );

    await journey.step(
      "看最终答复里给出的交付文件名",
      "助手的答复不为空，并且点名了一个 Markdown 文件；具体叫什么由模型决定，不做措辞断言。",
      async () => {
        const assistant = page.locator(".message.assistant").last();
        await expect(assistant).not.toHaveText("");
        const answer = (await assistant.innerText()).trim();
        mentioned = [...answer.matchAll(/(?:[\w.-]+\/)*[\w.-]+\.md\b/gi)].map((match) => match[0]!);
        expect(mentioned.length, "the final answer should mention its Markdown deliverable filename")
          .toBeGreaterThan(0);
      },
    );

    await journey.step(
      "在产物目录里找到答复提到的那份文件",
      "产物目录里至少有一份 Markdown 产物，且答复里提到的文件名能和它对上——说明「说写好了」不等于「写好了」这件事成立。",
      async () => {
        tree = await artifactTree(page);
        await expect.poll(() => tree.artifacts.count(), {
          message: "at least one declared Artifact should appear after the real run",
          timeout: 60_000,
        }).toBeGreaterThan(0);
        const artifactNames = await tree.artifacts.evaluateAll((elements) =>
          elements.map((element) => (element.getAttribute("title") ?? "").trim()).filter(Boolean));
        markdownArtifacts = artifactNames.filter((name) => name.toLowerCase().endsWith(".md"));
        expect(markdownArtifacts.length, "the real run should declare at least one Markdown Artifact")
          .toBeGreaterThan(0);
        expect(
          mentioned.some((name) => markdownArtifacts.some((artifact) =>
            artifact === name || artifact.split("/").at(-1) === name.split("/").at(-1))),
          `answer filenames (${mentioned.join(", ")}) should match the Artifact catalog (${markdownArtifacts.join(", ")})`,
        ).toBe(true);
      },
    );

    await journey.step(
      "打开这份交付物看看里面确实有内容",
      "在面板内打开产物，预览区不是空的——用户拿到的是一份能读的结果，而不是一个空文件。",
      async () => {
        await tree.catalog.getByRole("button", { name: `Open ${markdownArtifacts[0]}` }).click();
        const modal = page.getByRole("dialog", { name: `Artifact: ${markdownArtifacts[0]}` });
        await expect(modal).toBeVisible();
        await expect(modal.locator(".artifact-version-preview")).not.toHaveText("");
      },
    );
  } finally {
    await cleanupJourney(page, fixture);
  }
});
