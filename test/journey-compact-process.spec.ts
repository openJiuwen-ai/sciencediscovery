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
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { cleanupJourney, createProjectAndSession, openProjectSession, scriptedModel, sendUserMessage, waitForRunTerminal } from "./helpers/journeys.ts";

/**
 * E2E-META
 * Purpose: A researcher sees live cards become compact records without losing tool output, files or authorization behavior.
 * Steps:
 *   1. Open a local Project and check default-open workspace folders, closed secondary sections and absent disabled features.
 *   2. Collapse Files, send a request, verify streaming updates keep it closed, then grant permission and observe the running tool.
 *   3. Check completed records, copyable output and the unchanged declared Artifact card.
 *   4. Run a failing tool and verify its compact error record.
 *   5. Reload on a narrow viewport and inspect persisted records and workspace files.
 * Environment: Isolated API/Runner on E2E_BASE_URL with a run-owned data directory.
 * Type: mocked
 * LLM: journey-owned local OpenAI-compatible scripted model.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none; real shell tools execute inside the local sandbox.
 * Credentials: E2E_API_TOKEN for the local API only.
 * CostSideEffects: no external cost; temporary Project, files and model removed in finally.
 */
test("完成的过程去框，运行卡片和文件操作保留", { tag: "@mocked" }, async ({ page, journey }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem("sciencediscovery-locale", "zh-CN"));
  journey.scenario({ goal: "在同一个会话中查看运行、成功和失败，并能重新打开结果与文件。",
    preconditions: ["隔离 API/Runner 已启动", "只调用本地脚本模型，不使用真实模型密钥"] });
  const stub = await scriptedModel([
    [
      { tool: "run_shell", text: "我会先生成报告，再核对产物。", reasoning: "先生成一个可核对的本地报告。", delayMs: 7000,
        arguments: { command: "sleep 6; mkdir -p results; printf '# Card check\\n\\nCARD_OK\\n' > results/report.md; echo CARD_OK" } },
      { tool: "declare_artifact", arguments: { path: "results/report.md" } },
      { text: "报告已生成，内容是 CARD_OK。" },
    ],
    [
      { tool: "run_shell", reasoning: "检查失败结果仍然可以展开。", delayMs: 1000,
        arguments: { command: "sleep 4; echo CARD_ERROR >&2; exit 7" } },
      { text: "命令失败，错误标记 CARD_ERROR 已保留。" },
    ],
  ]);
  let fixture: Awaited<ReturnType<typeof createProjectAndSession>> | undefined;
  try {
    await journey.step("有内容的一级分区默认展开", "文件默认展开；没有任务内容时任务分区隐藏，未启用的科学记忆也不显示。",
      async () => {
        fixture = await createProjectAndSession(page, { approvalMode: "ask_for_dangerous",
          model: { ...stub, apiVariant: "deepseek", name: `卡片本地测试 ${Date.now()}` }, projectName: `卡片验收 ${Date.now()}`, sessionTitle: "卡片生命周期" });
        await openProjectSession(page, fixture);
        const folders = page.locator(".workspace-folder:visible");
        await expect(folders).toHaveCount(1);
        await expect(page.locator('[data-folder="tasks"]')).toBeHidden();
        await expect(page.locator('[data-folder="memory"]')).toHaveCount(0);
        await expect(page.locator(".workspace-folder[open]:visible")).toHaveCount(1);
        await expect(page.locator(".workspace-folder .workspace-fold[open]")).toHaveCount(0);
        for (const [index, name] of ["文件"].entries()) {
          const heading = folders.nth(index).locator(":scope > summary");
          await expect(heading).toHaveText(name);
          await expect(heading.locator("svg")).toHaveCount(1);
          await expect(heading).toHaveCSS("border-top-width", "1px");
          await expect(heading).toHaveCSS("background-color", "rgb(250, 251, 252)");
        }
        await expect(page.locator('[data-folder="tasks"] .workspace-fold')).toHaveCount(0);
        await expect(page.locator('[data-folder="files"]')).toHaveAttribute("open", "");
      });
    await journey.step("空列表隐藏，上传仍可用", "没有文件或产物时不显示空入口，拖放文件保留白底与虚线框以及大小限制。", async () => {
      const files = page.locator('[data-folder="files"]');
      await expect(files).toHaveAttribute("open", "");
      const upload = files.locator(".drop-zone");
      await expect(upload).toHaveCSS("background-color", "rgb(255, 255, 255)");
      await expect(upload).toHaveCSS("border-top-style", "dashed");
      await expect(upload.locator("small")).toHaveText("每个最大 1 GiB");
      await expect(files.locator(".artifact-catalog-section")).toHaveCount(0);
      await expect(files.locator(".physical-files")).toHaveCount(0);
    });
    let runId = "";
    await journey.step("思考中保留原卡片，文件分区保持收起", "流式更新后文件分区不会自动打开，思考仍有边框、底色和完整文本。",
      async () => {
        const files = page.locator('[data-folder="files"]');
        await files.locator(":scope > summary").click();
        await expect(files).not.toHaveAttribute("open", "");
        const run = await sendUserMessage(page, fixture!.session.id, "生成本地 Markdown 报告并注册为产物。");
        runId = run.id;
        const thinking = page.locator(".timeline-disclosure.thinking.running");
        await expect(thinking).toContainText("先生成一个可核对的本地报告");
        await expect(thinking).not.toHaveClass(/process-record/);
        expect(await thinking.evaluate((el) => getComputedStyle(el).borderTopWidth)).not.toBe("0px");
        const identity = page.locator(".run-timeline > .run-identity");
        await expect(identity).toHaveCount(1);
        await expect(page.locator(".run-timeline .message-body")).toHaveCount(0);
        expect((await identity.boundingBox())!.y).toBeLessThan((await thinking.boundingBox())!.y);
        await expect(files).not.toHaveAttribute("open", "");
      });
    await journey.step("批准后显示有框工具", "批准卡消失，工具仍在执行时保持边框并显示准确关联的已授权。",
      async () => {
        const permission = page.locator(".permission-card.pending").first();
        await expect(permission).toBeVisible();
        const files = page.locator('[data-folder="files"]');
        await expect(files).not.toHaveAttribute("open", "");
        await files.locator(":scope > summary").click();
        await expect(files).toHaveAttribute("open", "");
        await permission.getByRole("button", { name: "允许同类操作", exact: true }).click();
        await expect(page.locator(".permission-card")).toHaveCount(0);
        const tool = page.locator(".timeline-disclosure.tool.running").first();
        await expect(tool).toBeVisible();
        expect(await tool.evaluate((el) => getComputedStyle(el).borderTopWidth)).not.toBe("0px");
        await expect(tool.locator(".tool-authorization")).toHaveText("已授权");
        const authorization = (await tool.locator(".tool-authorization").boundingBox())!;
        const status = (await tool.locator(".timeline-status").boundingBox())!;
        expect(Math.abs(authorization.y + authorization.height / 2 - status.y - status.height / 2)).toBeLessThan(2);
        expect(authorization.x + authorization.width).toBeLessThan(status.x);
      });
    await journey.step("完成后保留灰色可展开记录和产物卡", "完成的工具无框，结果可展开；本轮产物仍有原框且能打开固定版本。",
      async () => {
        expect((await waitForRunTerminal(page, fixture!.session.id, runId)).status).toBe("completed");
        const tool = page.locator(".timeline-disclosure.tool.completed").filter({ hasText: "run_shell" });
        await expect(tool).toHaveClass(/process-record/);
        await expect(tool).not.toHaveAttribute("open", "");
        expect(await tool.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("0px");
        const timeline = tool.locator("xpath=..");
        await expect(timeline.locator(".message.assistant .avatar")).toHaveCount(1);
        await expect(timeline.locator(".message.assistant .message-role")).toHaveCount(1);
        await expect(timeline.locator(".message-body")).toHaveCount(2);
        await expect(timeline.locator(":scope > :first-child")).toHaveClass(/run-identity/);
        const summary = tool.locator(":scope > summary");
        await expect(summary).toHaveCSS("min-height", "28px");
        await expect(tool).toHaveCSS("margin-bottom", "4px");
        await expect(timeline.locator(".assistant-continuation").first()).toHaveCSS("margin-bottom", "12px");
        const nextTool = timeline.locator(".timeline-disclosure.tool.completed").filter({ hasText: "declare_artifact" });
        const toolBox = (await tool.boundingBox())!;
        const nextToolBox = (await nextTool.boundingBox())!;
        expect(nextToolBox.y - toolBox.y - toolBox.height).toBeGreaterThanOrEqual(0);
        expect(nextToolBox.y - toolBox.y - toolBox.height).toBeLessThanOrEqual(4);
        await expect(summary.locator("svg:visible")).toHaveCount(0);
        const textLeft = (await timeline.locator(".message-body").first().boundingBox())!.x;
        expect(Math.abs((await summary.locator(".timeline-label").boundingBox())!.x - textLeft)).toBeLessThan(1);
        await page.mouse.move(0, 0);
        const muted = "rgb(102, 112, 133)";
        await summary.hover();
        await expect.poll(() => summary.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(17, 24, 39)");
        await page.mouse.move(0, 0);
        await expect.poll(() => summary.evaluate((el) => getComputedStyle(el).color)).toBe(muted);
        await page.keyboard.press("Tab");
        await summary.focus();
        await expect.poll(() => summary.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(17, 24, 39)");
        await page.keyboard.press("Enter");
        await expect(tool).toHaveAttribute("open", "");
        await page.keyboard.press("Enter");
        await expect(tool).not.toHaveAttribute("open", "");
        await tool.locator(":scope > summary").click();
        expect(await tool.evaluate((el) => getComputedStyle(el).borderTopWidth)).not.toBe("0px");
        const stdout = tool.locator(".tool-io-section").filter({ hasText: "stdout" });
        await stdout.locator(":scope > summary").click();
        await expect(stdout.locator("pre")).toContainText("CARD_OK");
        await expect(tool.locator(".tool-authorization")).toHaveText("已授权");
        const artifact = page.getByRole("region", { name: "本轮产物", exact: true });
        await expect(artifact).toBeVisible();
        expect(await artifact.evaluate((el) => getComputedStyle(el).borderTopWidth)).not.toBe("0px");
        await artifact.getByRole("button", { name: /report.md/ }).click();
        await expect(page.getByRole("dialog")).toContainText("CARD_OK");
        await page.getByRole("dialog").getByRole("button", { name: /关闭|Close/ }).first().click();
        await summary.scrollIntoViewIfNeeded();
      });
    await journey.step("重新收起为统一的灰色文字行", "收起后没有图标和边框，正文只保留一次头像与身份栏。", async () => {
      const tool = page.locator(".timeline-disclosure.tool.completed").filter({ hasText: "run_shell" });
      await tool.locator(":scope > summary").click();
      await expect(tool).not.toHaveAttribute("open", "");
      expect(await tool.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("0px");
      await page.mouse.move(0, 0);
    });
    await journey.step("展开后在数量左侧显示多选图标", "收起只显示总数；展开后多选图标出现在数量左边，切换多选不收起面板。", async () => {
      const files = page.locator('[data-folder="files"]');
      const physical = files.locator(".physical-files");
      await expect(files.locator(".artifact-catalog-section > summary .fold-meta")).toHaveText("1");
      await expect(files.locator(".artifact-catalog-section")).toHaveCSS("background-color", "rgb(255, 255, 255)");
      await expect(physical.locator(":scope > summary .fold-meta")).toHaveText(/^\d+$/);
      await expect(physical.locator(":scope > summary button")).toHaveCount(0);
      const executions = page.locator(".agent-activity .workspace-fold").filter({ has: page.locator("summary strong", { hasText: "执行" }) });
      await expect(executions.locator(":scope > summary .fold-meta")).toHaveText(/^[1-9]\d*$/);
      const tasks = page.locator('[data-folder="tasks"]');
      await expect(tasks).toBeVisible();
      await expect(tasks).toHaveAttribute("open", "");
      await tasks.locator(":scope > summary").click();
      await expect(tasks).not.toHaveAttribute("open", "");
      await expect(files).toHaveAttribute("open", "");
      await tasks.locator(":scope > summary").click();
      await expect(executions.locator(":scope > summary")).not.toContainText("进行中");
      await physical.locator(":scope > summary").click();
      const select = physical.getByRole("button", { name: "多选工作区文件", exact: true });
      await expect(select).toBeVisible();
      await expect(physical.locator(":scope > summary button")).toHaveCount(1);
      const selectBox = (await select.boundingBox())!;
      expect(selectBox.x + selectBox.width).toBeLessThanOrEqual((await physical.locator(":scope > summary .fold-meta").boundingBox())!.x);
      await select.click();
      const cancel = physical.getByRole("button", { name: "取消多选工作区文件", exact: true });
      await expect(cancel).toHaveAttribute("aria-pressed", "true");
      await expect(physical).toHaveAttribute("open", "");
      await cancel.click();
      await expect(select).toHaveAttribute("aria-pressed", "false");
      await physical.locator(":scope > summary").click();
      await expect(physical.locator(":scope > summary button")).toHaveCount(0);
    });
    await journey.step("失败也去框并保留错误", "失败工具有红点和失败文字，展开后错误原文可见。",
      async () => {
        const run = await sendUserMessage(page, fixture!.session.id, "执行一次受控的失败命令，保留错误。");
        await waitForRunTerminal(page, fixture!.session.id, run.id);
        const failed = page.locator(".timeline-disclosure.tool.failed");
        await expect(failed).toHaveClass(/process-record/);
        await expect(failed.locator(":scope > summary")).toContainText("失败");
        expect(await failed.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("0px");
        await expect(failed.locator(":scope > summary svg:visible")).toHaveCount(0);
        expect(await failed.locator(":scope > summary").evaluate((el) => getComputedStyle(el, "::after").width)).toBe("6px");
        await failed.locator(":scope > summary").click();
        expect(await failed.evaluate((el) => getComputedStyle(el).borderTopWidth)).not.toBe("0px");
        const error = failed.locator(".tool-io-section").filter({ hasText: "CARD_ERROR" }).last();
        await error.locator(":scope > summary").click();
        await expect(error.locator("pre")).toContainText("CARD_ERROR");
        await failed.locator(":scope > summary").scrollIntoViewIfNeeded();
      });
    await journey.step("收起失败在文字旁显示红点", "红点紧跟失败文字，文字左边界不变，没有额外警告图标和状态徽章。", async () => {
      const failed = page.locator(".timeline-disclosure.tool.failed");
      await failed.locator(":scope > summary").click();
      await expect(failed).not.toHaveAttribute("open", "");
      await expect(failed.locator(":scope > summary .timeline-icon")).toBeHidden();
      await expect(failed.locator(":scope > summary .timeline-status")).toBeHidden();
      const layout = await failed.locator(":scope > summary").evaluate((el) => {
        const label = el.querySelector(".timeline-label")!;
        const range = document.createRange();
        range.selectNodeContents(label.querySelector("strong")!);
        return {
          labelRight: label.getBoundingClientRect().right,
          textRight: range.getBoundingClientRect().right,
          gap: getComputedStyle(el).columnGap,
          dotMargin: getComputedStyle(el, "::after").marginLeft,
          flexGrow: getComputedStyle(label).flexGrow,
        };
      });
      expect(Math.abs(layout.labelRight - layout.textRight)).toBeLessThan(2);
      expect(layout.gap).toBe("8px");
      expect(layout.dotMargin).toBe("0px");
      expect(layout.flexGrow).toBe("0");
      await page.mouse.move(0, 0);
    });
    await journey.step("窄屏刷新后访问原文件", "历史权限卡不会回来，目录仍默认关闭，文件可以从工作区入口访问且页面不横向溢出。",
      async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.reload();
        await expect(page.locator(".timeline-disclosure.tool.failed")).toBeVisible();
        await expect(page.locator(".permission-card")).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        // On mobile the existing workspace drawer must be opened first.
        const show = page.getByRole("button", { name: /显示工作区|Show workspace|打开工作区/ });
        if (await show.isVisible().catch(() => false)) await show.click();
        const files = page.locator('[data-folder="files"]');
        await expect(files).toHaveAttribute("open", "");
        await files.locator(":scope > summary").click();
        await expect(files).not.toHaveAttribute("open", "");
        await files.locator(":scope > summary").click();
        const physical = files.locator(".physical-files");
        await physical.locator(":scope > summary").click();
        await physical.getByLabel("文件夹 results", { exact: true }).click();
        await expect(physical.getByRole("button", { name: "打开 results/report.md", exact: true })).toBeVisible();
      });
  } finally {
    if (fixture) await cleanupJourney(page, fixture);
    await stub.stop();
  }
});

/**
 * E2E-META
 * Purpose: Skill entry cards stay actionable until their own summary Run or exact draft review is processed.
 * Steps:
 *   1. Complete a normal Run without a writable library and verify no Skill entry; create a library, reload and verify the entry is enabled.
 *   2. Start Skill summarization from the UI and check live then completed presentation.
 *   3. Ask skill-creator to create a real draft and open/close its review UI without processing.
 *   4. Discard that exact draft through the public API and verify the browser and reload show a processed record.
 * Environment: Fresh isolated local API/Runner with only the built-in Skill library initially.
 * Type: mocked
 * LLM: journey-owned local scripted model; no external requests.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none
 * Credentials: E2E_API_TOKEN for the local stack only.
 * CostSideEffects: no external cost; Project/model/draft cleanup; the isolated test library remains in test data.
 */
test("Skill 入口按自己的任务与草稿状态去框", { tag: "@mocked" }, async ({ page, journey }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem("sciencediscovery-locale", "zh-CN"));
  journey.scenario({ goal: "确认源对话完成和打开审核窗口都不会提前压缩尚未处理的 Skill 入口。",
    preconditions: ["隔离本地 API", "测试自己创建项目、模型和草稿"] });
  const skillName = `card-lifecycle-check-${Date.now()}`;
  const stub = await scriptedModel([
    [{ text: "普通分析已完成。" }],
    [{ delayMs: 6500, text: "这次分析没有足够可复用知识，不创建提案。" }],
    [
      { tool: "read_skill", arguments: { skillId: "skill-creator" } },
      { tool: "create_skill", arguments: { name: skillName, description: "Validate a small local table.",
        instructions: "# Table validation\n\nRead the input table and report its row count without changing its values." } },
      { text: "草稿已生成，等待用户审核。" },
    ],
  ]);
  let fixture: Awaited<ReturnType<typeof createProjectAndSession>> | undefined;
  let draftId: string | undefined;
  const api = async (path: string, method = "GET", data?: unknown) => {
    const response = await page.request.fetch(apiBaseUrl() + path, { method, headers: authorizationHeader(), ...(data ? { data } : {}) });
    expect(response.ok(), `${method} ${path}: ${response.status()}`).toBe(true);
    return response.json();
  };
  try {
    await journey.step("未配置可写库时完成普通源任务", "没有可写 Skill 库时不显示总结入口，也不出现不可点击的创建提案按钮。",
      async () => {
        const libraries = await api("/api/skill-libraries") as Array<{ id: string }>;
        expect(libraries.every((library) => library.id === "built-in-skills"), "Run this journey with fresh isolated Skill library data").toBe(true);
        fixture = await createProjectAndSession(page, { approvalMode: "always_allow", model: { ...stub, name: "Skill lifecycle local stub" },
          projectName: `Skill 生命周期 ${Date.now()}`, sessionTitle: "Skill 入口验证" });
        await openProjectSession(page, fixture);
        const source = await sendUserMessage(page, fixture.session.id, "做一次普通分析。");
        await waitForRunTerminal(page, fixture.session.id, source.id);
        await expect(page.locator(".skill-evolution-card")).toHaveCount(0);
      });
    await journey.step("创建可写库后显示入口", "配置完成后刷新，只显示最新合格运行的一个可点击总结入口。", async () => {
        await api("/api/skill-libraries", "POST", { id: "project-skills", name: "Local lifecycle test library" });
        await page.reload();
        const card = page.locator(".skill-evolution-card");
        await expect(card).toHaveCount(1);
        await expect(card.getByRole("button")).toBeEnabled();
        await expect(card.locator("xpath=../..")).toHaveClass("process-live");
      });
    await journey.step("发起总结后仍保留卡片", "请求已受理不算处理完成，运行期间保留原方框。",
      async () => {
        await page.locator(".skill-evolution-card").getByRole("button").click();
        await expect.poll(() => stub.calls.filter((call) => call.turn === 1).length).toBeGreaterThan(0);
        await expect(page.locator(".skill-evolution-card").locator("xpath=../..")).toHaveClass("process-live");
      });
    await journey.step("总结任务结束后变为灰色记录", "不声称已生成草稿，只如实显示总结运行已完成。",
      async () => {
        const record = page.locator("details.process-record").filter({ has: page.locator(".skill-evolution-card") });
        await expect(record).toBeVisible({ timeout: 30_000 });
        await expect(record.locator(":scope > summary")).toContainText("已完成");
        expect(await record.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("0px");
      });
    await journey.step("创建真实待审草稿并打开再关闭审核", "草稿仍待审，关闭审核界面不会变成已处理记录。",
      async () => {
        const run = await sendUserMessage(page, fixture!.session.id, "/skill-creator 创建一个统计本地表格行数的 Skill 草稿。");
        await waitForRunTerminal(page, fixture!.session.id, run.id);
        const drafts = await api("/api/skill-review-drafts") as Array<{ draftId: string; name: string }>;
        draftId = drafts.find((draft) => draft.name === skillName)?.draftId;
        expect(draftId).toBeTruthy();
        const card = page.locator(".skill-review-timeline-cta");
        await expect(card).toHaveCount(1);
        await expect(card.locator("xpath=../..")).toHaveClass("process-live");
        await card.getByRole("button").click();
        const settings = page.getByRole("dialog", { name: "系统设置", exact: true });
        await expect(settings).toBeVisible();
        await page.getByRole("button", { name: "关闭 Skill 浏览器", exact: true }).click();
        await settings.getByRole("button", { name: "取消并关闭", exact: true }).and(settings.locator(".icon-button")).click();
        await expect(card.locator("xpath=../..")).toHaveClass("process-live");
      });
    await journey.step("处理特定草稿后刷新", "服务端处理完成才去框，刷新后仍是同一草稿的已处理记录。",
      async () => {
        await api(`/api/skill-review-drafts/${draftId}`, "DELETE");
        draftId = undefined;
        const record = page.locator("details.process-record").filter({ has: page.locator(".skill-review-timeline-cta") });
        await expect(record).toBeVisible();
        await expect(record.locator(":scope > summary")).toContainText(skillName);
        await page.reload();
        await expect(record).toBeVisible();
        await expect(record.locator(":scope > summary")).toContainText("审核已处理");
      });
  } finally {
    if (draftId) await api(`/api/skill-review-drafts/${draftId}`, "DELETE").catch(() => undefined);
    if (fixture) await cleanupJourney(page, fixture);
    await stub.stop();
  }
});
