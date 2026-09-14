import { expect } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { cleanupJourney, createProjectAndSession, openProjectSession } from "./helpers/journeys.ts";
import { ideaResearchModel } from "./helpers/idea-research-model.ts";

/**
 * E2E-META
 * Purpose: Start autonomous research, pause an in-flight design, manually continue three rounds, inspect persisted results and end another research.
 * Steps:
 *   1. Configure tree budgets in system settings and start from the composer without an input dialog.
 *   2. Pause during design and verify no assessments start from the late response.
 *   3. Continue manually and inspect three rounds, independent assessments and persisted ROOT insight after reload.
 *   4. End another research using the confirmation control.
 * Environment: Isolated API/web, Runner and evolve Python processes; no Neo4j.
 * Type: mocked
 * LLM: journey-owned local OpenAI-compatible HTTP stub; Python calls it through the actual API proxy.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none
 * Credentials: E2E_API_TOKEN for the isolated API; local stub token.
 * CostSideEffects: no external cost; temporary project and model deleted after the journey.
 */
test("Idea Tree autonomous research can pause, resume and iterate", { tag: "@mocked" }, async ({ page, journey }) => {
  test.setTimeout(180_000);
  const stub = await ideaResearchModel();
  let fixture: Awaited<ReturnType<typeof createProjectAndSession>> | undefined;
  const card = page.getByRole("region", { name: "Idea Tree 研究控制" });
  const panel = page.getByRole("dialog", {name: "Idea Tree explorer"});
  const read = async () => {
    const response = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture!.session.id}/idea-tree/research`, {headers: authorizationHeader()});
    expect(response.ok()).toBe(true);
    return (await response.json()).items;
  };
  journey.scenario({goal: "从给定材料自主探索多个方向，暂停后手动继续，并完成多轮改进", preconditions: ["隔离 API 与 Python evolve 服务", "本地模拟模型，实际主 Agent 工具交接、Python 后端与文件持久化，无 Subagent 或 Neo4j"]});
  try {
    await journey.step("在系统设置配置研究", "保存三轮预算和设计提示词，再从会话启动，不创建输入弹窗或聊天计划", async () => {
      fixture = await createProjectAndSession(page, {model: {...stub, name: `Idea engine ${Date.now()}`}, projectName: `Idea engine ${Date.now()}`, sessionTitle: "自主催化剂探索"});
      await openProjectSession(page, fixture);
      await page.getByRole("button", {name: /^(System configuration|系统设置)/}).click();
      const dialog = page.getByRole("dialog", {name: /System configuration|系统设置/});
      await dialog.getByRole("button", {name: /^Idea Tree/}).click();
      const settings = dialog.locator(".idea-tree-settings");
      await settings.getByLabel(/Maximum exploration rounds|最多探索轮数/).fill("3");
      await settings.getByLabel(/Candidates per round|每轮最多候选/).fill("1");
      await settings.getByLabel(/Max depth|最大深度/).fill("4");
      await settings.locator("textarea").nth(0).fill("DESIGN-OVERRIDE: design from supplied materials only.");
      await settings.getByRole("button", {name: /Save|保存/}).click();
      await expect.poll(async () => (await (await page.request.get(`${apiBaseUrl()}/api/settings/idea-tree`, {headers: authorizationHeader()})).json()).candidatesPerRound).toBe(1);
      await dialog.getByRole("button", {name: /close|关闭/}).first().click();
      await page.locator("form.composer").getByRole("textbox").fill("/idea-tree Skip literature retrieval for this demo. Compare low-cost Fe and Mn catalysts; no cobalt. User supplied: near-neutral water, recovery and leaching matter.");
      await page.getByRole("button", {name: /^(Run analysis|运行分析)$/}).click();
      await expect(panel.getByRole("button", {name: "树配置", exact: true})).toHaveCount(0);
      await expect(panel.locator(".idea-tree-settings")).toHaveCount(0);
      await expect(page.getByLabel("研究目标与约束")).toHaveCount(0);
      await expect(page.getByLabel("给定材料", {exact: true})).toHaveCount(0);
      await expect(page.getByRole("dialog", {name: "Idea Tree explorer"})).toHaveCount(0);
      await expect.poll(() => stub.requests.some(r => r.system.includes("DESIGN-OVERRIDE"))).toBe(true);
      await expect(page.getByText(/已启动 Idea Tree 研究/)).toBeVisible();
      await card.getByRole("button", {name: /查看研究进度/}).click();
      await expect(panel.getByRole("list", {name: "研究执行进度"})).toContainText("设计候选");
    });
    await journey.step("暂停正在设计的候选", "先显示正在暂停，响应结束后保持暂停且尚无评分", async () => {
      await panel.getByRole("button", {name: "暂停", exact: true}).click();
      await expect(panel).toContainText("正在暂停");
      stub.resume();
      await expect(panel).toContainText("已暂停");
      const [{graph, research}] = await read();
      expect(research.status).toBe("paused");
      expect(graph.nodes.filter((n: any) => n.kind === "candidate")[0].score).toBeNull();
      expect(stub.requests.some(r => r.payload.perspective)).toBe(false);
    });
    await journey.step("手动继续并完成三轮", "三个候选完成独立评估，后续构思拿到前轮洞察，刷新后结果仍存在", async () => {
      stub.holdAssessments();
      await panel.getByRole("button", {name: "继续", exact: true}).click();
      const progress = panel.getByRole("list", {name: "研究执行进度"});
      for (const role of ["活性评估", "稳定性评估", "可持续性评估"]) {
        await expect(progress.getByRole("listitem").filter({hasText: role})).toContainText("执行中");
      }
      // Reload while model calls are still waiting: the stream starts with the
      // persisted current state, so all three in-flight stages remain visible.
      await page.reload();
      await card.getByRole("button", {name: /查看研究进度/}).click();
      await expect(progress.getByRole("listitem").filter({hasText: "执行中"})).toHaveCount(3);
      stub.releaseAssessments();
      await expect.poll(async () => (await read())[0].research.status, {timeout: 30_000}).toBe("completed");
      const [{graph, research}] = await read();
      expect(research.round).toBe(3);
      expect(graph.nodes.filter((n: any) => n.kind === "candidate").map((n: any) => n.score)).toEqual([7, 7, 7]);
      const assessments = stub.requests.filter(r => r.payload.perspective);
      expect(assessments).toHaveLength(9);
      for (const r of assessments) expect(r.payload.assessments).toBeUndefined();
      expect(stub.requests.find(r => r.payload.round === 2)?.payload.nodes.some((n: any) => n.insight)).toBe(true);
      const runs = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture!.session.id}/runs`, {headers: authorizationHeader()});
      const leadRuns = await runs.json();
      expect(leadRuns).toHaveLength(1);
      const eventsResponse = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture!.session.id}/runs/${leadRuns[0].id}/events`, {headers: authorizationHeader()});
      const events = await eventsResponse.json();
      expect(events.some((e: any) => e.event.type === "idea_research.created")).toBe(true);
      expect(events.some((e: any) => e.event.type === "subagent.updated")).toBe(false);
      expect(graph.nodes.filter((n: any) => n.kind === "candidate").every((n: any) => n.depth === 4 && n.childrenIds.length === 0)).toBe(true);
      expect(graph.nodes.filter((n: any) => n.kind === "direction").every((n: any) => n.score === null && Object.keys(n.stages).length === 0)).toBe(true);
      await page.reload();
      await expect(card).toContainText("第 3 / 3 轮");
      await card.getByRole("button", {name: /查看研究进度/}).click();
      const explorer = panel;
      await expect(explorer).toContainText("Shared insight: improve recovery");
      await expect(explorer).not.toContainText("Result handle");
      await expect(explorer).not.toContainText("revision 0");
    });
    await journey.step("结束另一次研究", "确认结束保留已有状态，不能再继续", async () => {
      await page.reload();
      const previous = stub.requests.length;
      stub.holdDesign();
      await page.locator("form.composer").getByRole("textbox").fill("/idea-tree-team Skip retrieval. Termination check");
      await page.getByRole("button", {name: /^(Run analysis|运行分析)$/}).click();
      await expect.poll(() => stub.requests.length).toBeGreaterThanOrEqual(previous + 2);
      await card.getByRole("button", {name: /查看研究进度/}).click();
      await panel.getByRole("button", {name: "结束研究", exact: true}).click();
      await expect(panel).toContainText("结束后不能继续");
      await panel.getByRole("button", {name: "确认结束"}).click();
      stub.resume();
      await expect.poll(async () => (await read())[0].research.status).toBe("ended");
      await expect(panel).toContainText("已结束");
    });
  } finally {
    if (fixture) await cleanupJourney(page, fixture);
    await stub.stop();
  }
});
