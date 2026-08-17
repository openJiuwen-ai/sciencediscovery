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
 * Purpose: A user can delegate a review, inspect the completed subagent's work, and receive both declared deliverables without exposing private workspace files as Artifacts.
 * Steps:
 *   1. Prepare a local scripted model whose main request delegates one general-purpose subtask.
 *   2. Let the subagent create and declare review notes while retaining a private file; let the main Agent create and declare the final report.
 *   3. Inspect the subagent card's identity, terminal state, tool/text steps, and usage feedback.
 *   4. Verify the main answer and both declared Artifacts, while private files stay out of the Artifact catalog and @ suggestions.
 *   5. Open the separate physical-file tree and reload the Session to verify persisted subagent state.
 * Environment: Isolated local stack at E2E_BASE_URL with shell sandbox and a journey-owned Project/Session.
 * Type: mocked
 * LLM: journey-owned OpenAI-compatible HTTP stub on 127.0.0.1; main/subagent routing uses the general-purpose preset system marker.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — shell runs inside local main/subagent sandboxes and non-local browser requests are aborted.
 * Credentials: E2E_API_TOKEN for the isolated local API only; the stub token has no external access.
 * CostSideEffects: no external cost; temporary model and Project records are deleted in finally.
 */
test("J4 委派子任务后可核对过程与两份交付物", { tag: "@mocked" }, async ({ journey, page }) => {
  test.setTimeout(240_000);
  const mainMarker = `J4-MAIN-${Date.now()}`;
  const childMarker = `J4-CHILD-${Date.now()}`;
  const stub = await scriptedModel([
    {
      arguments: {
        description: "Review the analysis workspace",
        prompt: "Create review/notes.md with a concise quality review, retain private/context.txt as working material, and declare only the review notes.",
        subagent_type: "general-purpose",
        timeout_seconds: 120,
      },
      delayMs: 500,
      tool: "task",
    },
    {
      arguments: {
        command: `mkdir -p results && printf '# Final report\\n\\n${mainMarker}\\n' > results/final.md && echo ${mainMarker}`,
      },
      tool: "run_shell",
    },
    { arguments: { path: "results/final.md" }, tool: "declare_artifact" },
    { text: "The delegated review is complete. The final deliverable is results/final.md and the review is review/notes.md." },
  ], [
    {
      arguments: {
        command: `mkdir -p review private && printf '# Review notes\\n\\n${childMarker}\\n' > review/notes.md && printf 'private context' > private/context.txt && echo ${childMarker}`,
      },
      delayMs: 700,
      tool: "run_shell",
    },
    { arguments: { path: "review/notes.md" }, tool: "declare_artifact" },
    { text: `The review notes are ready with marker ${childMarker}.` },
  ]);
  const fixture = await createProjectAndSession(page, {
    approvalMode: "always_allow",
    model: {
      apiToken: stub.apiToken,
      baseUrl: stub.baseUrl,
      model: stub.model,
      name: `J4 local model ${Date.now()}`,
    },
    projectName: `J4 delegate subtask ${Date.now()}`,
    sessionTitle: `J4 delegation session ${Date.now()}`,
  });

  journey.scenario({
    goal: "一位研究员把一块耗时的质量核查交给助手去做。他要能看清助手现在做到哪一步、"
      + "最后哪些成果是助手交上来的，同时不希望助手的草稿纸混进项目成果里。",
    preconditions: [
      "隔离栈已启动，已有一个由旅程创建的项目与会话，审批模式为「始终允许」",
      "模型由旅程自带的本地 stub 驱动：主脚本委派一次 general-purpose 子任务并声明 results/final.md，"
        + "子脚本声明 review/notes.md 且保留一个不声明的私有文件",
      "已知产品缺口 F5：子 Agent 声明的产物当前不会进入 Project 产物目录，"
        + "第 5 步按用户预期断言两份交付物，因此本旅程预期为 FAIL，断言不降级",
    ],
  });

  let tree!: Awaited<ReturnType<typeof artifactTree>>;
  try {
    await journey.step(
      "提出一个需要分工的请求",
      "任务发出后运行走到完成态，说明主 Agent 和它委派出去的助手都跑完了。",
      async () => {
        await openProjectSession(page, fixture);
        const run = await sendUserMessage(
          page,
          fixture.session.id,
          "Delegate an independent quality review, then prepare the final report and return both useful deliverables.",
        );
        expect((await waitForRunTerminal(page, fixture.session.id, run.id)).status).toBe("completed");
      },
    );

    await journey.step(
      "在主对话里看到这位「助手」",
      "主对话出现一张 Subagent 卡片，写明它接到的任务、类型 general-purpose 和已完成的状态。",
      async () => {
        const subagentSection = page.locator("section[aria-label='Subagent activity']");
        await expect(subagentSection).toBeVisible();
        const card = subagentSection.locator("article.subagent-card").first();
        await expect(card).toHaveClass(/completed/);
        await expect(card).toContainText("Review the analysis workspace");
        await expect(card).toContainText("general-purpose");
        await expect(card).toContainText("completed");
      },
    );

    await journey.step(
      "展开卡片核对助手到底做了什么",
      "卡片展开后能看到助手自己的工具步骤、它的回复和用量信息，过程是可核对的而不是黑箱。",
      async () => {
        const card = page.locator("section[aria-label='Subagent activity'] article.subagent-card").first();
        const toggle = card.locator("> button");
        if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
        const details = card.locator(".subagent-details");
        await expect(details).toContainText(childMarker);
        await expect(details).toContainText(/tokens|Usage unavailable/);
        await expect(details.locator(".subagent-steps [data-kind='tool']")).toHaveCount(2);
        await expect(details.locator(".subagent-steps [data-kind='assistant']"))
          .toContainText("review notes are ready");
      },
    );

    await journey.step(
      "分清哪部分是主 Agent 做的",
      "主对话的工具步骤和最终答复由主 Agent 给出，答复点名了两份交付物，"
        + "而助手内部的过程标记没有泄漏到主答复里。",
      async () => {
        await expect(await expandToolStep(page, { contains: mainMarker })).toContainText(mainMarker);
        const assistant = page.locator(".message.assistant").last();
        await expect(assistant).toContainText("results/final.md");
        await expect(assistant).toContainText("review/notes.md");
        await expect(assistant).not.toContainText(childMarker);
      },
    );

    await journey.step(
      "在产物目录里拿到两份交付物",
      "主 Agent 的 results/final.md 与助手的 review/notes.md 平等地出现在同一个项目产物目录里，"
        + "助手的私有文件不在其中。（已知缺口 F5：助手那份当前不会出现，本步预期失败）",
      async () => {
        tree = await artifactTree(page);
        await expect(tree.artifactCount).toHaveText("2", { timeout: 30_000 });
        await expect(tree.artifacts).toHaveCount(2);
        await expect(tree.catalog.getByRole("button", { name: "Open results/final.md" })).toBeVisible();
        await expect(tree.catalog.getByRole("button", { name: "Open review/notes.md" })).toBeVisible();
        await expect(tree.catalog).not.toContainText("private/context.txt");
      },
    );

    await journey.step(
      "用 @ 引用这两份交付物",
      "候选里正好是这两份声明过的交付物，助手的私有文件不在候选里。",
      async () => {
        const candidates = await tree.mentionCandidates();
        await expect(candidates).toHaveCount(2);
        await expect(candidates.filter({ hasText: "results/final.md" })).toHaveCount(1);
        await expect(candidates.filter({ hasText: "review/notes.md" })).toHaveCount(1);
        await expect(candidates.filter({ hasText: "private/context.txt" })).toHaveCount(0);
        await page.locator("form.composer").getByRole("textbox").fill("");
      },
    );

    await journey.step(
      "确认助手的草稿纸确实存在，只是不算成果",
      "打开工作区文件树后，助手私有目录下的文件都能看到；它们只是没有资格进入产物目录。",
      async () => {
        await tree.openPhysicalFiles();
        const physicalNames = await tree.physicalFiles.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("title") ?? element.textContent ?? ""));
        expect(physicalNames).toContain("results/final.md");
        expect(physicalNames.some((name) => /subagents\/.+\/review\/notes\.md$/.test(name))).toBe(true);
        expect(physicalNames.some((name) => /subagents\/.+\/private\/context\.txt$/.test(name))).toBe(true);
      },
    );

    await journey.step(
      "刷新之后助手的记录还在",
      "重新进入会话，Subagent 卡片仍是完成态，仍写着它当初接到的任务。",
      async () => {
        await page.reload();
        await openProjectSession(page, fixture);
        const persistedCard = page.locator("section[aria-label='Subagent activity'] article.subagent-card").first();
        await expect(persistedCard).toHaveClass(/completed/);
        await expect(persistedCard).toContainText("Review the analysis workspace");
      },
    );
  } finally {
    await cleanupJourney(page, fixture);
    await stub.stop();
  }
});
