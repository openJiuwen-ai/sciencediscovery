// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { cleanupJourney, createProjectAndSession, openProjectSession, scriptedModel, sendUserMessage, waitForRunTerminal, type JourneyFixture } from "./helpers/journeys.ts";

// Static suite metadata is inherited by each framework-expanded journey.
test.describe("journey-session-trajectory.spec", { tag: ["@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"] }, () => {

/** Ctrl+wheel over the timeline zooms around the pointer; deltaY maps to exp(-deltaY * 0.002). */
async function ctrlWheelZoom(page: Page, viewer: Locator, deltaY: number): Promise<void> {
  const box = (await viewer.locator(".trajectory-timeline").boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, deltaY);
  await page.keyboard.up("Control");
}

/** Show exactly one event kind in the list filter (clear all, then check one). */
async function filterOnlyKind(viewer: Locator, label: string): Promise<void> {
  const menu = viewer.locator(".trajectory-kinds");
  await menu.locator("summary").click();
  await menu.getByRole("button", { name: "清空", exact: true }).click();
  await menu.locator("label", { hasText: label }).locator("input").check();
  await menu.locator("summary").click();
}

/**
 * E2E-META
 * Purpose: Inspect and export a Session's real multi-agent trajectory inline in the conversation area.
 * Steps:
 *   1. Run a main Agent and delegated child, then continue the Session with a second Run.
 *   2. Keep all time lanes visible while selecting one Agent's records and navigating its input.
 *   3. Inspect reasoning with its exact context, export NDJSON, and verify Session isolation.
 *   4. Read tool arguments and results, with an optional raw JSON view.
 *   5. Inspect one final output per request with its token usage, without duplicate streaming text.
 *   6. Inspect tools as a separate collapsible field and labeled context navigation.
 *   7. Resize the timeline area and the event list with drag handles and the keyboard.
 *   8. Keep Agent labels pinned during horizontal scroll, zoom with Ctrl+wheel.
 *   9. Reload the trajectory URL and inspect later request messages and narrow-screen layout.
 *  10. Close the viewer with the keyboard and return to the Session.
 *  11. Switching away from the Session closes the trajectory; switching back does not reopen it.
 * Environment: Isolated current-worktree API/Web and Runner at E2E_BASE_URL.
 * Type: mocked
 * LLM: journey-owned deterministic HTTP model with main/subagent scripts.
 * WebSearch: none
 * PaperSources: none
 * MCP: none; MCP record projection is covered by component tests.
 * OtherExternal: none; one local sandboxed printf operation.
 * Credentials: E2E_API_TOKEN for the isolated local stack only.
 * CostSideEffects: Temporary model, Project and Session removed in finally; no external cost.
 */
test("查看多 Agent 轨迹、精确上下文并导出", { tag: "@mocked" }, async ({ page, journey }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => localStorage.setItem("sciencediscovery-locale", "zh-CN"));
  const stub = await scriptedModel([[
    { tool: "task", arguments: { description: "独立核查", prompt: "Use run_shell to print TRAJECTORY_CHILD, then report success.", subagent_type: "general-purpose" }, reasoning: "先委派独立核查。", delayMs: 300 },
    { text: "主任务核查完成。", reasoning: "结合子任务结果形成结论。" },
  ], [{ text: "第二轮确认完成。" }]], [
    { tool: "run_shell", arguments: { command: "printf TRAJECTORY_CHILD" }, reasoning: "核对工具执行结果。", delayMs: 300 },
    { text: "TRAJECTORY_CHILD 已核验。" },
  ]);
  let fixture: JourneyFixture | undefined;
  journey.scenario({ goal: "研究员检查主子 Agent 的执行时间、状态和模型实际输入，并导出证据。", preconditions: ["独立 API/Runner 已启动", "模型仅调用本地脚本桩"] });
  try {
    fixture = await createProjectAndSession(page, { approvalMode: "always_allow", projectName: `Trajectory ${Date.now()}`, sessionTitle: "执行证据", model: { ...stub, name: `Trajectory model ${Date.now()}`, apiVariant: "deepseek" } });
    await journey.step("运行主子任务", "主 Agent 委派独立核查，子 Agent 返回工具证据。", async () => {
      await openProjectSession(page, fixture!);
      const run = await sendUserMessage(page, fixture!.session.id, "请委派独立核查后汇总结果。");
      const terminal = await waitForRunTerminal(page, fixture!.session.id, run.id);
      expect(terminal.status).toBe("completed");
      await expect(page.getByText("主任务核查完成。", { exact: true }).first()).toBeVisible();
      const followup = await sendUserMessage(page, fixture!.session.id, "请确认上一轮结论。");
      expect((await waitForRunTerminal(page, fixture!.session.id, followup.id)).status).toBe("completed");
      await expect(page.getByText("第二轮确认完成。", { exact: true }).first()).toBeVisible();
      const entry = page.getByRole("button", { name: "轨迹", exact: true });
      await expect(entry).toHaveClass(/secondary-button compact-button/);
      await expect(entry).toHaveCSS("border-radius", "7px");
      await expect(entry).toHaveCSS("min-height", "34px");
      await expect(entry).toHaveCSS("white-space", "nowrap");
      await expect(entry).toHaveCSS("height", "34px");
      await entry.focus();
      await expect(entry).toBeFocused();
    });
    const viewer = page.getByRole("region", { name: "Session 轨迹" });
    await journey.step("查看时间轴和上下文来源", "主子 Agent 共用时间坐标，输入展示实际贡献块，彩色导航可跳转。", async () => {
      await page.getByRole("button", { name: "轨迹", exact: true }).click();
      // The trajectory is inline in the conversation area: no overlay, no modal.
      await expect(page.locator(".trajectory-backdrop")).toHaveCount(0);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(viewer).toBeVisible();
      await expect(page.locator(".messages")).toHaveCount(0);
      await expect(page.locator(".composer")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "对话", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(viewer.getByRole("button", { name: "刷新", exact: true })).toHaveCSS("border-radius", "7px");
      await expect(viewer.locator(".trajectory-lane")).toHaveCount(2);
      await expect(viewer.locator(".trajectory-legend")).not.toContainText("生命周期");
      await expect(viewer.locator(".trajectory-kinds-panel label").filter({ hasText: "生命周期" })).toHaveCount(0);
      // Filters: Agent first, then the multi-select kind dropdown.
      const agentSelectBox = (await viewer.getByLabel("Agent", { exact: true }).boundingBox())!;
      const kindsBox = (await viewer.locator(".trajectory-kinds > summary").boundingBox())!;
      expect(agentSelectBox.x).toBeLessThan(kindsBox.x);
      // The horizontal scrollbar is always on; the zoom menu and the dense-spacing notice are gone.
      await expect(viewer.locator(".trajectory-scroll")).toHaveCSS("overflow-x", "scroll");
      await expect(viewer.locator(".trajectory-scroll")).toHaveCSS("scrollbar-gutter", "stable");
      // The pane is vertically flipped so the scrollbar renders at the top of the timeline.
      await expect(viewer.locator(".trajectory-scroll")).toHaveCSS("transform", "matrix(1, 0, 0, -1, 0, 0)");
      await expect(viewer.locator(".trajectory-scroll > div").first()).toHaveCSS("transform", "matrix(1, 0, 0, -1, 0, 0)");
      await expect(viewer.getByLabel("时间轴缩放")).toHaveCount(0);
      await expect(viewer.getByText(/密集时间点已横向展开/)).toHaveCount(0);
      await expect(viewer.locator(".trajectory-zoom-hint")).toContainText("Ctrl");
      await expect(viewer.locator('.trajectory-track[data-category="events"]')).toHaveCount(0);
      for (const type of ["subagent.updated", "run.completed", "run.failed", "run.cancelled", "context_recovery"]) await expect(viewer.locator(`[data-event-type="${type}"]`)).toHaveCount(0);
      await expect(page).toHaveURL(/\/sessions\/[^/]+\/trajectory/);
      for (const type of ["run.started", "state_changed", "state.committed"]) await expect(viewer.locator(`.trajectory-event-list [data-event-type="${type}"]`)).toHaveCount(0);
      await expect(viewer.getByText(/非过期|已过期/)).toHaveCount(0);
      await expect(viewer.locator('.trajectory-track[data-category="model"]').first()).toBeVisible();
      await expect(viewer.locator('.trajectory-track[data-category="tools"]').first()).toBeVisible();
      await expect(viewer.locator(".trajectory-mark").first()).toHaveCSS("height", "10px");
      // A visual hit target must never turn sequential events into concurrency.
      const rowStructure = () => viewer.locator(".trajectory-lane").evaluateAll(lanes => lanes.map(lane => ({
        agent: lane.getAttribute("data-agent-id"), rows: [...lane.querySelectorAll(".trajectory-track")].map(row => ({
          category: row.getAttribute("data-category"), ids: [...row.querySelectorAll(".trajectory-mark")].map(mark => mark.getAttribute("data-entry-id")),
        })),
      })));
      const beforeZoom = await rowStructure();
      const initialWidth = await viewer.locator(".trajectory-track").first().evaluate(node => node.clientWidth);
      for (const deltaY of [-347, -347, -347, 1040]) {
        await ctrlWheelZoom(page, viewer, deltaY);
        expect(await rowStructure()).toEqual(beforeZoom);
      }
      // Continuous wheel zoom does not guarantee an exact 1.000 on the way back.
      await expect.poll(() => viewer.locator(".trajectory-track").first().evaluate(node => node.clientWidth)).toBeCloseTo(initialWidth, -1);
      const size = page.viewportSize()!;
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await rowStructure()).toEqual(beforeZoom);
      await page.setViewportSize(size);
      // The inline view fills the conversation area, whose width follows app-level
      // layout (the workspace panel keeps its narrow-screen clamp), so the exact
      // pixel width is not an invariant here — structure and a sane width are.
      await expect.poll(() => viewer.locator(".trajectory-track").first().evaluate(node => node.clientWidth)).toBeGreaterThan(200);
      const separations = await viewer.locator(".trajectory-track").evaluateAll(rows => rows.flatMap(row => {
        const boxes = [...row.querySelectorAll(".trajectory-mark")].map(mark => mark.getBoundingClientRect());
        return boxes.slice(1).map((box, i) => box.left - boxes[i]!.right);
      }));
      expect(separations.length).toBeGreaterThan(0);
      expect(separations.every(gap => gap >= 1.9)).toBe(true);
      await expect(viewer.getByRole("button", { name: "事件内容", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(viewer.locator(".trajectory-context-summary")).toContainText("系统提示");
      await expect(viewer.getByRole("button", { name: "模型上下文", exact: true })).toHaveCount(0);
      await expect(viewer.getByRole("button", { name: "组装证据", exact: true })).toHaveCount(0);
      await expect(viewer.getByLabel("Agent", { exact: true }).locator('option[value="all"]')).toHaveCount(0);
      await expect(viewer.locator(".trajectory-event-group > header")).not.toContainText(["独立核查"]);
      await expect(viewer.locator('[data-event-type="turn_start"]')).toHaveCount(0);
      await expect(viewer.getByRole("button", { name: "全部记录", exact: true })).toHaveCount(0);
      const headings = await viewer.locator(".trajectory-event-group > header").evaluateAll(nodes => nodes.map(node => `${node.querySelector("strong")?.textContent}:${node.querySelector("small")?.getAttribute("title")}`));
      expect(headings.length).toBe(2);
      expect(new Set(headings).size).toBe(headings.length);
      const invocationGroup = viewer.locator(".trajectory-event-group").filter({ has: page.locator('[data-event-type="context.captured"]') }).first();
      await expect(invocationGroup.locator('[data-event-type="context.captured"]')).toHaveCount(2);
      await expect(invocationGroup.locator('[data-event-type="tool.started"]')).toHaveCount(1);
      for (const type of ["session.updated", "run.queued", "run.status", "model_usage"]) await expect(viewer.locator(`[data-event-type="${type}"]`)).toHaveCount(0);
      await expect(viewer.locator(".trajectory-context section").first()).toBeVisible();
      expect(await viewer.locator(".trajectory-mark").count()).toBeGreaterThan(5);
      expect(await viewer.locator(".trajectory-minimap button").count()).toBeGreaterThan(2);
      await expect(viewer.locator(".trajectory-context section").first()).not.toContainText("来源未记录");
      await expect(viewer.locator('.trajectory-context [id^="trajectory-tool-"]')).toHaveCount(0);
      await expect(viewer.locator(".trajectory-tools > button")).toHaveAttribute("aria-expanded", "false");
      await viewer.locator(".trajectory-tools > button").click();
      await expect(viewer.locator(".trajectory-tool-list > details").first()).toBeVisible();
      const definition = viewer.locator(".trajectory-tool-list > details").filter({ has: page.locator("summary", { hasText: /^task$/ }) });
      await definition.locator("summary").click();
      await expect(definition.locator("pre")).toContainText("task");
      await viewer.locator(".trajectory-tools > button").click();
      await expect(viewer.locator(".trajectory-tool-list")).toBeHidden();
      await expect(viewer.locator(".trajectory-minimap")).toContainText("用户");
      expect(await viewer.locator(".trajectory-minimap").evaluate(node => node.clientWidth)).toBeGreaterThanOrEqual(100);
      await expect(viewer.locator(".trajectory-axis")).toContainText(/\d{2}:\d{2}:\d{2}/);
      await expect(viewer.locator(".trajectory-event-group header small").first()).toContainText(/Run .+/);
      await expect(viewer.getByRole("button", { name: /^历史版本/ })).toHaveCount(0);
      await viewer.locator('[data-event-type="context.captured"]').first().click();
      await viewer.locator(".trajectory-minimap button").last().click();
      expect(await viewer.locator(".trajectory-context").evaluate(el => el.scrollTop)).toBeGreaterThan(0);
      await viewer.getByRole("button", { name: "Agent 状态", exact: true }).click();
      await expect(viewer.locator(".trajectory-raw")).toContainText("checkpoint");
    });
    await journey.step("切换单个 Agent 查看", "下方只展示选中 Agent；时间图保留全部 Agent，点击子任务时间标记自动切换并定位。", async () => {
      const marks = await viewer.locator(".trajectory-mark").count();
      await filterOnlyKind(viewer, "模型输出");
      const childMark = viewer.locator('.trajectory-lane[data-agent-id^="subagent:"] .trajectory-mark[data-kind="input"]').first();
      const childId = await childMark.getAttribute("data-entry-id");
      const childAgent = await viewer.locator('.trajectory-lane[data-agent-id^="subagent:"]').getAttribute("data-agent-id");
      await childMark.click();
      await expect(viewer.getByLabel("Agent", { exact: true })).toHaveValue(childAgent!);
      // Clicking a mark whose kind was filtered out resets the kind filter to all-checked.
      expect(await viewer.locator(".trajectory-kinds-panel input").evaluateAll(nodes => nodes.every(n => (n as HTMLInputElement).checked))).toBe(true);
      await expect(viewer.locator(".trajectory-kinds > summary")).toContainText("所有类型");
      await expect(viewer.locator(`.trajectory-event-list [data-entry-id="${childId}"]`)).toHaveAttribute("aria-current", "true");
      const names = await viewer.locator(".trajectory-event-group > header strong").allTextContents();
      expect(names.length).toBeGreaterThan(0);
      expect(names.every(name => name === "独立核查")).toBe(true);
      await expect(viewer.locator(".trajectory-context-summary")).toBeVisible();
      await expect(viewer.locator(".trajectory-mark")).toHaveCount(marks);
      await expect(viewer.locator(".trajectory-lane")).toHaveCount(2);
    });
    await journey.step("放大时间轴核对并行结构", "放大到 8× 后事件仍处于原来的行，只有横向距离改变；点击时间标记仍定位同一节点。", async () => {
      const rows = () => viewer.locator(".trajectory-track").evaluateAll(nodes => nodes.map(row => [...row.querySelectorAll(".trajectory-mark")].map(mark => mark.getAttribute("data-entry-id"))));
      const before = await rows();
      const width = await viewer.locator(".trajectory-track").first().evaluate(node => node.clientWidth);
      await ctrlWheelZoom(page, viewer, -1040);
      await expect.poll(() => viewer.locator(".trajectory-track").first().evaluate(node => node.clientWidth)).toBeGreaterThan(width);
      expect(await rows()).toEqual(before);
      const mark = viewer.locator(".trajectory-mark").first();
      const id = await mark.getAttribute("data-entry-id");
      await mark.click();
      await expect(viewer.locator(`.trajectory-event-list [data-entry-id="${id}"]`)).toHaveAttribute("aria-current", "true");
      await expect(viewer.locator(".trajectory-context-summary")).toBeVisible();
    });
    await journey.step("拖动调整分区尺寸", "时间轴高度与列表宽度可拖动也可用键盘调整；标题栏保持紧凑单行。", async () => {
      // The title header stays a compact single line and has no resize handle.
      expect(await viewer.locator(".trajectory-header").evaluate(el => el.clientHeight)).toBeLessThanOrEqual(48);
      await expect(viewer.getByRole("separator", { name: "调整顶栏高度" })).toHaveCount(0);
      const timelineBlock = viewer.locator(".trajectory-timeline");
      const timelineHandle = viewer.getByRole("separator", { name: "调整时间轴高度" });
      await expect(timelineHandle).toHaveAttribute("aria-orientation", "horizontal");
      const timelineBefore = await timelineBlock.evaluate(el => el.clientHeight);
      // Dragging up shrinks the area.
      let handleBox = (await timelineHandle.boundingBox())!;
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y - 40, { steps: 4 });
      await page.mouse.up();
      expect(await timelineBlock.evaluate(el => el.clientHeight)).toBeLessThan(timelineBefore);
      // Dragging far past the content stops at the height that shows every lane;
      // dragging further does not grow it any more.
      handleBox = (await timelineHandle.boundingBox())!;
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 600, { steps: 6 });
      await page.mouse.up();
      const capped = await timelineBlock.evaluate(el => el.clientHeight);
      handleBox = (await timelineHandle.boundingBox())!;
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 200, { steps: 4 });
      await page.mouse.up();
      expect(await timelineBlock.evaluate(el => el.clientHeight)).toBe(capped);
      expect(Number(await timelineHandle.getAttribute("aria-valuenow"))).toBeLessThanOrEqual(Number(await timelineHandle.getAttribute("aria-valuemax")));
      const lastLaneBottom = await viewer.locator(".trajectory-scroll .trajectory-lane").last().evaluate(el => el.getBoundingClientRect().bottom);
      expect(lastLaneBottom).toBeLessThanOrEqual(await timelineBlock.evaluate(el => el.getBoundingClientRect().bottom) + 1);
      await timelineHandle.focus();
      await page.keyboard.press("ArrowUp");
      await expect.poll(() => timelineBlock.evaluate(el => el.clientHeight)).toBeLessThan(capped);
      const events = viewer.locator(".trajectory-events");
      const listHandle = viewer.locator(".trajectory-body > .trajectory-resizer");
      await expect(listHandle).toHaveAttribute("aria-orientation", "vertical");
      const listBefore = await events.evaluate(el => el.clientWidth);
      const listBox = (await listHandle.boundingBox())!;
      await page.mouse.move(listBox.x + 2, listBox.y + 40);
      await page.mouse.down();
      await page.mouse.move(listBox.x + 64, listBox.y + 40, { steps: 4 });
      await page.mouse.up();
      expect(await events.evaluate(el => el.clientWidth)).toBeGreaterThan(listBefore + 30);
    });
    await journey.step("固定 Agent 列并用 Ctrl+滚轮缩放", "时间轴横滚时 Agent 名固定并对齐所属行，Ctrl+滚轮横向缩放且页面不跟着滚。", async () => {
      const timeline = viewer.locator(".trajectory-timeline");
      const scroller = viewer.locator(".trajectory-scroll");
      const labelsCol = viewer.locator(".trajectory-labels");
      // The label column is a separate pane: track content structurally cannot
      // slide under the agent names.
      const labelsBox = (await labelsCol.boundingBox())!;
      const scrollBox = (await scroller.boundingBox())!;
      expect(scrollBox.x).toBeGreaterThanOrEqual(labelsBox.x + labelsBox.width - 1);
      await scroller.evaluate(el => { el.scrollLeft = 600; });
      const timelineBox = (await timeline.boundingBox())!;
      const lanes = await viewer.locator(".trajectory-scroll .trajectory-lane").all();
      const laneLabels = await viewer.locator(".trajectory-lane-label").all();
      expect(laneLabels.length).toBe(lanes.length);
      for (const [i, label] of laneLabels.entries()) {
        await expect(label).toBeInViewport();
        const labelBox = (await label.boundingBox())!;
        const laneBox = (await lanes[i]!.boundingBox())!;
        expect(Math.abs(labelBox.x - timelineBox.x)).toBeLessThanOrEqual(2);
        expect(labelBox.y).toBeGreaterThanOrEqual(laneBox.y - 1);
        expect(labelBox.y).toBeLessThanOrEqual(laneBox.y + laneBox.height);
      }
      const widthBefore = await viewer.locator(".trajectory-track").first().evaluate(el => el.clientWidth);
      await page.mouse.move(timelineBox.x + timelineBox.width * 0.6, timelineBox.y + timelineBox.height / 2);
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, -240);
      await page.keyboard.up("Control");
      await expect.poll(() => viewer.locator(".trajectory-track").first().evaluate(el => el.clientWidth)).toBeGreaterThan(widthBefore);
      const grownWidth = await viewer.locator(".trajectory-track").first().evaluate(el => el.clientWidth);
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, 240);
      await page.keyboard.up("Control");
      await expect.poll(() => viewer.locator(".trajectory-track").first().evaluate(el => el.clientWidth)).toBeLessThan(grownWidth);
      // The zoom is anchored at the pointer: the mark under it must not move.
      await scroller.evaluate(el => { el.scrollLeft = 0; });
      const anchorMark = viewer.locator(".trajectory-mark").first();
      const beforeBox = (await anchorMark.boundingBox())!;
      const anchorPoint = { x: beforeBox.x + beforeBox.width / 2, y: beforeBox.y + beforeBox.height / 2 };
      await page.mouse.move(anchorPoint.x, anchorPoint.y);
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, -240);
      await page.keyboard.up("Control");
      await expect.poll(async () => Math.abs(((await anchorMark.boundingBox())!).x - beforeBox.x)).toBeLessThanOrEqual(2);
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, 240);
      await page.keyboard.up("Control");
      await expect.poll(async () => Math.abs(((await anchorMark.boundingBox())!).x - beforeBox.x)).toBeLessThanOrEqual(2);
    });
    await journey.step("刷新后继续核对后续请求", "URL 保留内嵌轨迹视图；后续输入包含上一轮结果和最新问题，默认定位最新消息。", async () => {
      await page.reload();
      await expect(viewer).toBeVisible();
      await viewer.getByRole("button", { name: "返回对话", exact: true }).click();
      await expect(page).not.toHaveURL(/\/trajectory/);
      await page.goBack();
      await expect(viewer).toBeVisible();
      await page.goForward();
      await expect(viewer).toBeHidden();
      await page.goBack();
      await expect(viewer).toBeVisible();
      await expect(viewer.locator('[data-event-type="context.captured"]').first()).toBeVisible();
      const indexResponse = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture!.session.id}/trajectory`, { headers: authorizationHeader() });
      const index = await indexResponse.json();
      const main = index.entries.filter((e: { agentId: string; kind: string }) => e.agentId.startsWith("main:") && e.kind === "input");
      let target: { id: string; contextId: string } | undefined;
      for (const candidate of main) {
        const response = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture!.session.id}/trajectory/detail?id=${encodeURIComponent(candidate.id)}`, { headers: authorizationHeader() });
        const detail = await response.json();
        if (JSON.stringify(detail.context?.input.history).includes("请确认上一轮结论。")) {
          expect(JSON.stringify(detail.context.input.history)).toContain("主任务核查完成。");
          expect(detail.context.input.history.length).toBeGreaterThan(1);
          target = candidate; break;
        }
      }
      expect(target).toBeTruthy();
      expect(target!.contextId).not.toBe(main[0].contextId);
      await viewer.locator(`.trajectory-event-list button[data-entry-id="${target!.id}"]`).click();
      await expect(viewer.locator(".trajectory-context")).toContainText("请确认上一轮结论。");
      await expect(viewer.locator(".trajectory-context")).toContainText("主任务核查完成。");
      await expect(viewer.locator(".trajectory-context-summary")).toContainText("条消息");
      await expect(viewer.locator(".trajectory-minimap")).toContainText("工具结果");
      await expect(viewer.locator(".trajectory-minimap")).toContainText("task");
      await expect(viewer.locator('.trajectory-context section[id^="trajectory-message-"] details').first()).not.toHaveAttribute("open", "");
      await viewer.getByRole("button", { name: "最新消息", exact: true }).click();
      expect(await viewer.locator(".trajectory-context").evaluate(el => el.scrollTop)).toBeGreaterThan(0);
      const lastLabel = await viewer.locator(".trajectory-minimap button").last().textContent();
      await expect(viewer.locator('.trajectory-minimap button[aria-current="true"]')).toHaveText(lastLabel!);
    });
    await journey.step("展开独立工具定义", "工具定义属于独立 tools 字段，按名称折叠展示；消息中的工具结果仍留在消息原位置。", async () => {
      await viewer.locator(".trajectory-tools > button").click();
      const definition = viewer.locator(".trajectory-tool-list > details").filter({ has: page.locator("summary", { hasText: /^task$/ }) });
      await definition.locator("summary").click();
      await expect(definition.locator("pre")).toContainText("task");
      await definition.locator("summary").scrollIntoViewIfNeeded();
      expect(await viewer.locator(".trajectory-context").evaluate(el => el.clientHeight)).toBeGreaterThan(30);
      await expect(viewer.locator('.trajectory-minimap button[aria-current="true"]')).toBeInViewport({ ratio: 0.9 });
      await expect(viewer.locator('.trajectory-context [id^="trajectory-tool-"]')).toHaveCount(0);
    });
    await journey.step("选择思考节点并导出", "已记录思考对应固定上下文，导出含完整结束标记，未授权和其他 Session 无法读取。", async () => {
      await filterOnlyKind(viewer, "思考");
      await viewer.locator(".trajectory-event-list button").filter({ hasText: "思考内容" }).first().click();
      await expect(viewer.locator(".trajectory-readable")).toContainText("先委派独立核查。");
      await expect(viewer.locator(".trajectory-raw")).toHaveCount(0);
      await viewer.getByRole("button", { name: "原始 JSON", exact: true }).click();
      await expect(viewer.locator(".trajectory-raw")).toContainText("contextRef");
      await viewer.getByRole("button", { name: "查看本次输入", exact: true }).click();
      await expect(viewer.locator(".trajectory-context section").first()).toBeVisible();
      const downloadPromise = page.waitForEvent("download");
      await viewer.getByRole("button", { name: "导出 NDJSON", exact: true }).click();
      const download = await downloadPromise, stream = await download.createReadStream();
      const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
      const records = Buffer.concat(chunks).toString().trim().split("\n").map(line => JSON.parse(line));
      expect(records[0].sessionId).toBe(fixture!.session.id);
      expect(records.at(-1).type).toBe("complete");
      expect(records[0].historicalEntries).toEqual([]);
      expect(records[0].entries.some((e: { kind: string }) => e.kind === "lifecycle")).toBe(true); // Presentation does not delete audit evidence.
      const streams = new Map<string, number[]>();
      for (const entry of records[0].entries) {
        expect(Number.isFinite(Date.parse(entry.timestamp))).toBe(true);
        if (entry.streamId !== "main" && !entry.streamId?.startsWith("subagent-")) continue;
        const key = `${entry.agentId}:${entry.runId}`;
        streams.set(key, [...(streams.get(key) ?? []), entry.sequence]);
      }
      expect(streams.size).toBeGreaterThanOrEqual(3);
      const mainStarts = records[0].entries.filter((e: { agentId: string; label: string; turn: number }) => e.agentId.startsWith("main:") && e.label === "context.captured" && e.turn === 0);
      expect(new Set(mainStarts.map((e: { runId: string }) => e.runId)).size).toBe(2);
      for (const sequences of streams.values()) expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
      expect(records[0].entries.some((e: { id: string }) => /^(action:|before:|after:)/.test(e.id))).toBe(false);
      expect(records.some(r => r.context?.input && r.entry.agentId.startsWith("subagent:"))).toBe(true);
      const unauthorized = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture!.session.id}/trajectory`, { headers: { authorization: "Bearer wrong" } });
      expect(unauthorized.status()).toBe(401);
      const foreign = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture!.session.id}/trajectory/detail?id=foreign`, { headers: authorizationHeader() });
      expect(foreign.status()).toBe(404);
    });
    await journey.step("阅读工具参数", "工具卡片展示实际输入，原始 JSON 可切换。", async () => {
      await filterOnlyKind(viewer, "工具");
      await viewer.getByLabel("Agent", { exact: true }).selectOption({ label: "独立核查" });
      await viewer.locator('[data-event-type="tool.started"]').first().click();
      await expect(viewer.locator(".trajectory-readable")).toContainText("输入参数");
      await expect(viewer.locator(".trajectory-readable")).toContainText("printf TRAJECTORY_CHILD");
      await viewer.getByRole("button", { name: "原始 JSON", exact: true }).click();
      await expect(viewer.locator(".trajectory-raw")).toContainText("run_shell");
      await viewer.getByRole("button", { name: "解析内容", exact: true }).click();
      await viewer.locator(".trajectory-readable dt").filter({ hasText: "command" }).scrollIntoViewIfNeeded();
      await expect(viewer.locator(".trajectory-readable dt").filter({ hasText: "command" })).toBeInViewport();
    });
    await journey.step("核对单次模型用量", "主子 Agent 每次请求只显示一个最终返回，带本次 Token 用量，不重复展示流式正文。", async () => {
      await viewer.getByLabel("Agent", { exact: true }).selectOption({ index: 0 });
      await filterOnlyKind(viewer, "模型输出");
      const responsePromise = page.waitForResponse(response => response.url().endsWith(`/api/sessions/${fixture!.session.id}/trajectory`) && response.request().method() === "GET");
      await viewer.getByRole("button", { name: "刷新", exact: true }).click();
      const finalResponse = await responsePromise;
      const finalIndex = await finalResponse.json();
      const outputs = finalIndex.entries.filter((e: { eventType?: string }) => e.eventType === "model.completed") as Array<{ id: string; agentId: string; runId: string; contextId: string; turn: number }>;
      // A resumed child can add requests. Verify identities, not an incidental total.
      expect(outputs.length).toBeGreaterThanOrEqual(5);
      expect(new Set(outputs.map(e => `${e.agentId}:${e.runId}:${e.contextId}`)).size).toBe(outputs.length);
      for (const output of outputs) expect(finalIndex.entries.some((e: { kind: string; contextId: string }) => e.kind === "input" && e.contextId === output.contextId)).toBe(true);
      await expect(viewer.locator(".trajectory-event-list button")).toHaveCount(outputs.filter(e => e.agentId.startsWith("main:")).length);
      await expect(viewer.locator('.trajectory-event-list button:not([data-event-type="model.completed"])')).toHaveCount(0);
      await expect(viewer.locator('.trajectory-mark[data-kind="output"]')).toHaveCount(outputs.length);
      await viewer.getByLabel("Agent", { exact: true }).selectOption({ label: "独立核查" });
      const children = outputs.filter(e => e.agentId.startsWith("subagent:"));
      await expect(viewer.locator(".trajectory-event-list button")).toHaveCount(children.length);
      const childAnswer = children.find(e => e.turn === 1)!;
      expect(childAnswer).toBeTruthy();
      await viewer.locator(`.trajectory-event-list [data-entry-id="${childAnswer.id}"]`).click();
      await expect(viewer.locator(".trajectory-readable")).toContainText("TRAJECTORY_CHILD 已核验。");
      await expect(viewer.locator(".trajectory-readable")).toContainText("本次请求用量");
      await viewer.getByLabel("Agent", { exact: true }).selectOption({ index: 0 });
      await viewer.locator('[data-event-type="model.completed"]').first().click();
      const usage = viewer.locator(".trajectory-readable section").filter({ has: page.getByRole("heading", { name: "本次请求用量", exact: true }) });
      await expect(usage).toContainText("输入 Token20");
      await expect(usage).toContainText("输出 Token8");
      await expect(usage).toContainText("总 Token28");
      await usage.scrollIntoViewIfNeeded();
    });
    await journey.step("窄屏阅读", "查看器不超出视口，选中事件、Run 标签和模型用量可见。", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await viewer.evaluate(el => el.getBoundingClientRect().right <= window.innerWidth + 1)).toBe(true);
      await expect(viewer.getByRole("button", { name: "返回对话" })).toBeVisible();
      await expect(viewer.getByRole("button", { name: "全部记录", exact: true })).toHaveCount(0);
      await expect(viewer.locator(".trajectory-detail-heading .trajectory-run")).toBeVisible();
      await expect(viewer.locator('.trajectory-event-list button[aria-current="true"]')).toBeInViewport({ ratio: 0.95 });
      await viewer.locator(".trajectory-readable dt").filter({ hasText: "总 Token" }).scrollIntoViewIfNeeded();
      await expect(viewer.locator(".trajectory-readable dt").filter({ hasText: "总 Token" })).toBeInViewport();
      const listHeight = await viewer.locator(".trajectory-event-list").evaluate(el => el.clientHeight);
      expect(await viewer.locator(".trajectory-event-list button").first().evaluate(el => el.clientHeight)).toBeLessThanOrEqual(listHeight);
      const narrowHandle = viewer.locator(".trajectory-body > .trajectory-resizer");
      await expect(narrowHandle).toHaveAttribute("aria-orientation", "horizontal");
      const eventsBefore = await viewer.locator(".trajectory-events").evaluate(el => el.clientHeight);
      await narrowHandle.scrollIntoViewIfNeeded();
      const handleBox = (await narrowHandle.boundingBox())!;
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 2);
      await page.mouse.down();
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 42, { steps: 3 });
      await page.mouse.up();
      expect(await viewer.locator(".trajectory-events").evaluate(el => el.clientHeight)).toBeGreaterThan(eventsBefore + 20);
    });
    await journey.step("窄屏查看输入分区", "消息和工具定义独立显示；带文字的彩色导航可定位，工具列表可折叠且不越出视口。", async () => {
      await filterOnlyKind(viewer, "模型输入");
      await viewer.locator(".trajectory-event-list button").last().click();
      await expect(viewer.locator(".trajectory-context-summary")).toBeVisible();
      await expect(viewer.locator(".trajectory-minimap")).toContainText("用户");
      const pane = viewer.locator(".trajectory-context");
      expect(await pane.evaluate(el => el.clientHeight)).toBeGreaterThan(35);
      await viewer.locator(".trajectory-minimap button").last().click();
      await expect(viewer.locator(".trajectory-minimap button").last()).toHaveAttribute("aria-current", "true");
      await viewer.locator(".trajectory-tools > button").click();
      await expect(viewer.locator(".trajectory-tool-list")).toBeInViewport();
      expect(await pane.evaluate(el => el.clientHeight)).toBeGreaterThan(0);
      expect(await viewer.locator(".trajectory-input").evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await viewer.locator(".trajectory-tool-list > details").first().locator("summary").click();
      await expect(viewer.locator(".trajectory-tool-list > details").first().locator("pre")).toBeVisible();
      await viewer.locator(".trajectory-tools > button").click();
      await viewer.getByRole("button", { name: "原始 JSON", exact: true }).click();
      await expect(viewer.locator(".trajectory-raw")).toContainText('"systemPrompt"');
      await expect(viewer.locator(".trajectory-raw")).toContainText('"tools"');
      await viewer.getByRole("button", { name: "解析内容", exact: true }).click();
      await expect(viewer.locator(".trajectory-tools > button")).toHaveAttribute("aria-expanded", "false");
      await expect(viewer.locator('.trajectory-minimap button[aria-current="true"]')).toBeInViewport({ ratio: 0.9 });
    });
    await journey.step("返回会话", "键盘 Escape 返回 Session，轨迹入口保持单行可见。", async () => {
      await page.keyboard.press("Escape");
      await expect(viewer).toBeHidden();
      await expect(page).not.toHaveURL(/\/trajectory/);
      await expect(page.locator(".messages")).toBeVisible();
      await expect(page.locator(".composer")).toBeVisible();
      await expect(page.getByRole("button", { name: "轨迹", exact: true })).toBeInViewport();
      await expect(page.getByRole("button", { name: "轨迹", exact: true })).toHaveCSS("height", "34px");
      // The session-bar button toggles back into the inline trajectory view.
      await page.getByRole("button", { name: "轨迹", exact: true }).click();
      await expect(viewer).toBeVisible();
      await page.getByRole("button", { name: "对话", exact: true }).click();
      await expect(viewer).toBeHidden();
      await expect(page.locator(".messages")).toBeVisible();
    });
    await journey.step("切换会话即关闭轨迹", "离开轨迹所在 Session 即关闭视图；切回不静默重开，URL 也不写回 /trajectory。", async () => {
      await page.getByRole("button", { name: "轨迹", exact: true }).click();
      await expect(viewer).toBeVisible();
      await expect(page).toHaveURL(/\/sessions\/[^/]+\/trajectory/);
      const created = await page.request.post(`${apiBaseUrl()}/api/projects/${fixture!.project.id}/sessions`, { data: { title: "切走目标会话" }, headers: authorizationHeader() });
      expect(created.ok()).toBe(true);
      // The sidebar refetches its Session list on load; the trajectory restores from the URL.
      await page.reload();
      await expect(viewer).toBeVisible();
      const target = page.locator("button.nav-item").filter({ hasText: "切走目标会话" });
      await expect(target).toBeVisible();
      await target.click();
      await expect(page.getByRole("heading", { exact: true, name: "切走目标会话" })).toBeVisible();
      await expect(viewer).toHaveCount(0);
      await expect(page).not.toHaveURL(/\/trajectory/);
      const back = page.locator("button.nav-item").filter({ hasText: fixture!.session.title });
      await expect(back).toBeVisible();
      await back.click();
      await expect(page.getByRole("heading", { exact: true, name: fixture!.session.title })).toBeVisible();
      await expect(viewer).toHaveCount(0);
      await expect(page.locator(".messages")).toBeVisible();
      await expect(page).not.toHaveURL(/\/trajectory/);
    });
  } finally { if (fixture) await cleanupJourney(page, fixture); await stub.stop(); }
});

});
