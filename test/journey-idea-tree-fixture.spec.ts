import { expect } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { cleanupJourney, createProjectAndSession, openProjectSession } from "./helpers/journeys.ts";
import { ideaResearchModel } from "./helpers/idea-research-model.ts";

/**
 * E2E-META
 * Purpose: Start autonomous research, pause an in-flight design, manually continue three rounds, inspect persisted results and end another research.
 * Steps:
 *   1. Open the existing tree panel from /idea-tree and configure supplied materials, rounds and role prompt.
 *   2. Pause during design and verify no assessments start from the late response.
 *   3. Continue manually and inspect three rounds, independent assessments and persisted ROOT insight after reload.
 *   4. End another research using the confirmation control.
 * Environment: Isolated API/web and evolve Python processes; no runner or Neo4j needed for this workflow.
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
  const panel = page.getByRole("region", { name: "Idea Tree 研究控制" });
  const read = async () => {
    const response = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture!.session.id}/idea-tree/research`, {headers: authorizationHeader()});
    expect(response.ok()).toBe(true);
    return (await response.json()).items;
  };
  journey.scenario({goal: "从给定材料自主探索多个方向，暂停后手动继续，并完成多轮改进", preconditions: ["隔离 API 与 Python evolve 服务", "本地模拟模型，实际后端与文件持久化，无 Subagent、Runner 或 Neo4j"]});
  try {
    await journey.step("从会话进入研究配置", "命令打开树面板，填写材料与三轮预算，不创建聊天计划", async () => {
      fixture = await createProjectAndSession(page, {model: {...stub, name: `Idea engine ${Date.now()}`}, projectName: `Idea engine ${Date.now()}`, sessionTitle: "自主催化剂探索"});
      await openProjectSession(page, fixture);
      await page.locator("form.composer").getByRole("textbox").fill("/idea-tree Compare low-cost Fe and Mn catalysts; no cobalt.");
      await page.getByRole("button", {name: /^(Run analysis|运行分析)$/}).click();
      await expect(panel.getByLabel("研究目标与约束")).toHaveValue("Compare low-cost Fe and Mn catalysts; no cobalt.");
      await panel.getByLabel("给定材料", {exact: true}).fill("User supplied: near-neutral water; recovery and leaching matter.");
      await panel.getByLabel("最多探索轮数").fill("3");
      await panel.getByLabel("每轮最多候选").fill("1");
      await panel.getByLabel("最大深度").fill("4");
      await panel.getByRole("button", {name: "查看或替换本次角色提示词"}).click();
      await panel.getByLabel("设计提示词", {exact: true}).fill("DESIGN-OVERRIDE: design from supplied materials only.");
      await panel.getByRole("button", {name: "启动研究", exact: true}).click();
      await expect.poll(() => stub.requests.some(r => r.system.includes("DESIGN-OVERRIDE"))).toBe(true);
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
      await panel.getByRole("button", {name: "继续", exact: true}).click();
      await expect.poll(async () => (await read())[0].research.status, {timeout: 30_000}).toBe("completed");
      const [{graph, research}] = await read();
      expect(research.round).toBe(3);
      expect(graph.nodes.filter((n: any) => n.kind === "candidate").map((n: any) => n.score)).toEqual([7, 7, 7]);
      const assessments = stub.requests.filter(r => r.payload.perspective);
      expect(assessments).toHaveLength(9);
      for (const r of assessments) expect(r.payload.assessments).toBeUndefined();
      expect(stub.requests.find(r => r.payload.round === 2)?.payload.nodes.some((n: any) => n.insight)).toBe(true);
      const runs = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture!.session.id}/runs`, {headers: authorizationHeader()});
      expect(await runs.json()).toEqual([]);
      await page.reload();
      await expect(panel).toContainText("第 3 / 3 轮");
      await panel.getByRole("button", {name: "查看树与结果"}).click();
      await expect(page.getByRole("dialog", {name: "Idea Tree explorer"})).toContainText("Shared insight: improve recovery");
    });
    await journey.step("结束另一次研究", "确认结束保留已有状态，不能再继续", async () => {
      await page.reload();
      // Hold a second model's design so termination is checked before the workflow completes.
      const second = await ideaResearchModel();
      try {
        // Reuse the session model endpoint with a controlled second stub.
        const response = await page.request.put(`${apiBaseUrl()}/api/models/${fixture!.model!.id}`, {headers: authorizationHeader(), data: {baseUrl: second.baseUrl}});
        expect(response.ok()).toBe(true);
        await panel.getByRole("button", {name: "新建研究"}).click();
        await panel.getByLabel("研究目标与约束").fill("Termination check");
        await panel.getByRole("button", {name: "启动研究", exact: true}).click();
        await expect.poll(() => second.requests.length).toBeGreaterThanOrEqual(2);
        await panel.getByRole("button", {name: "结束研究", exact: true}).click();
        await expect(panel).toContainText("结束后不能继续");
        await panel.getByRole("button", {name: "确认结束"}).click();
        second.resume();
        await expect.poll(async () => (await read())[0].research.status).toBe("ended");
        await expect(panel).toContainText("已结束");
      } finally { await second.stop(); }
    });
  } finally {
    if (fixture) await cleanupJourney(page, fixture);
    await stub.stop();
  }
});
