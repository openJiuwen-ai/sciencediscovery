import { expect } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { cleanupJourney, createProjectAndSession, openProjectSession, waitForRunTerminal } from "./helpers/journeys.ts";
import { ideaTreeModel } from "./helpers/idea-tree-model.ts";

/**
 * E2E-META
 * Purpose: Configure Idea Tree and complete a Python-backed leaf through real Specialist Subagents, then inspect persisted insight after refresh.
 * Steps:
 *   1. Create an isolated session and configure depth and role prompts in settings.
 *   2. Submit /idea-tree and execute design, three independent assessments and aggregation through Subagents.
 *   3. Inspect the scored leaf, propagated ROOT insight, and reload the tree.
 * Environment: Isolated committed local stack with evolve Python service; no Neo4j server required.
 * Type: mocked
 * LLM: journey-owned local OpenAI-compatible stub; actual Agent and Subagent loops.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none
 * Credentials: E2E_API_TOKEN for the isolated API; local stub token.
 * CostSideEffects: no external cost; temporary project and model removed after the journey.
 */
test("Idea Tree runs Python tree tools and real Specialist Subagents", { tag: "@mocked" }, async ({ page, journey }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(15_000);
  const stub = await ideaTreeModel();
  let fixture: Awaited<ReturnType<typeof createProjectAndSession>> | undefined;
  journey.scenario({ goal: "配置 Idea Tree，完成叶子评估并在刷新后查看回传结果", preconditions: ["隔离的本地栈与 Python evolve 服务已启动", "使用本地模拟模型，无 Neo4j 数据库"] });
  try {
    await journey.step("配置树预算和角色提示词", "设置页保存深度 2 和设计、回传提示词", async () => {
      fixture = await createProjectAndSession(page, { approvalMode: "always_allow", model: { ...stub, name: `Idea model ${Date.now()}` }, projectName: `Idea journey ${Date.now()}`, sessionTitle: "Idea Tree journey" });
      await openProjectSession(page, fixture);
      await page.getByRole("button", { name: /^(System configuration|系统设置)/ }).click();
      const dialog = page.getByRole("dialog", { name: /System configuration|系统设置/ });
      await dialog.getByRole("button", { name: /^Idea Tree/ }).click();
      const editor = dialog.locator(".idea-tree-settings");
      await editor.getByLabel(/Max depth|最大深度/).fill("2");
      await editor.getByLabel(/Max nodes|最大节点数/).fill("8");
      await editor.getByLabel(/Max search rounds|最大搜索轮数/).fill("2");
      await editor.locator("textarea").nth(0).fill("DESIGN-SETTING: generate one candidate.");
      await editor.locator("textarea").nth(2).fill("PROPAGATE-SETTING: retain uncertainty.");
      await editor.getByRole("button", { name: /Save|保存/ }).click();
      await expect.poll(async () => (await (await page.request.get(`${apiBaseUrl()}/api/settings/idea-tree`, { headers: authorizationHeader() })).json()).maxDepth).toBe(2);
      await dialog.getByRole("button", { name: /close|关闭/ }).first().click();
    });
    await journey.step("运行设计与三个独立评估 Subagent", "真实子 Agent 执行完成，Python 保存叶子分数及 ROOT insight", async () => {
      await page.locator("form.composer").getByRole("textbox").fill("/idea-tree Design and assess a catalyst. Skip literature research; use the supplied candidate and default three assessment dimensions.");
      await page.getByRole("button", { name: /^(Run analysis|运行分析)$/ }).click();
      let run: { id: string } | undefined;
      await expect.poll(async () => {
        const response = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture!.session.id}/runs`, { headers: authorizationHeader() });
        run = (await response.json())[0];
        return run?.id;
      }).toBeTruthy();
      expect((await waitForRunTerminal(page, fixture!.session.id, run!.id)).status).toBe("completed");
      expect(stub.errors).toEqual([]);
      const children = stub.requests.filter(r => !r.main);
      expect(children.length).toBeGreaterThanOrEqual(5);
      expect(children.some(r => r.system.includes("DESIGN-SETTING"))).toBe(true);
      expect(stub.requests.some(r => r.main && r.system.includes("PROPAGATE-SETTING"))).toBe(true);
      const assessments = children.filter(r => JSON.stringify(r.messages).includes("Immutable candidate:"));
      expect(assessments).toHaveLength(3);
      for (const request of assessments) expect(JSON.stringify(request.messages)).toContain("candidate-A: Fe-N-C catalyst");
      const response = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture!.session.id}/idea-tree/graph`, { headers: authorizationHeader() });
      expect(response.ok()).toBe(true);
      const { graph } = await response.json();
      expect(graph.nodes.find((n: any) => n.id === "1.1").score).toBe(7.05);
      expect(graph.nodes.find((n: any) => n.id === "ROOT").insight).toContain("ROOT insight:");
    });
    await journey.step("打开树并刷新恢复", "相同节点、评分和 insight 在刷新后仍可查看", async () => {
      await expect(page.locator(".idea-tree-view")).toContainText("3 nodes");
      await page.locator(".idea-tree-view").click();
      await expect(page.getByRole("dialog", { name: "Idea Tree explorer" }).getByText("ROOT insight: compare activity while preserving stability.", { exact: true })).toBeVisible();
      await page.reload();
      await openProjectSession(page, fixture!);
      await expect(page.locator(".idea-tree-view")).toContainText("3 nodes");
      await page.locator(".idea-tree-view").click();
      await expect(page.getByRole("dialog", { name: "Idea Tree explorer" }).getByText("ROOT insight: compare activity while preserving stability.", { exact: true })).toBeVisible();
    });
  } finally {
    if (fixture) await cleanupJourney(page, fixture);
    await stub.stop();
  }
});

/**
 * E2E-META
 * Purpose: Cancel a real in-flight Idea Tree Subagent and retry the same persisted leaf to completion.
 * Steps:
 *   1. Start an isolated Idea Tree whose design Subagent waits on the local model.
 *   2. Stop the run and verify the unscored leaf becomes retryable and its Subagent stops.
 *   3. Submit a plain-language continuation and finish the same leaf on attempt two.
 * Environment: Isolated committed local stack with evolve Python service and no Neo4j database.
 * Type: mocked
 * LLM: journey-owned local model with one intentionally held response, followed by deterministic answers.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none
 * Credentials: E2E_API_TOKEN for the local API.
 * CostSideEffects: temporary project and model, removed after the journey; no external cost.
 */
test("Idea Tree cancellation releases the leaf for a real retry", { tag: "@mocked" }, async ({ page, journey }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(15_000);
  const stub = await ideaTreeModel({ pauseDesign: true });
  let fixture: Awaited<ReturnType<typeof createProjectAndSession>> | undefined;
  const headers = authorizationHeader();
  const readGraph = async () => {
    const response = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture!.session.id}/idea-tree/graph`, { headers });
    expect(response.ok()).toBe(true);
    return (await response.json()).graph;
  };
  const runs = async (): Promise<Array<{ id: string }>> => (await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture!.session.id}/runs`, { headers })).json();
  const submit = async (prompt: string) => {
    const existing = new Set((await runs()).map(r => r.id));
    await page.locator("form.composer").getByRole("textbox").fill(prompt);
    await page.getByRole("button", { name: /^(Run analysis|运行分析)$/ }).click();
    let run: { id: string } | undefined;
    await expect.poll(async () => {
      run = (await runs()).find(r => !existing.has(r.id));
      return run?.id;
    }).toBeTruthy();
    return run!.id;
  };
  let firstRun = "";
  let originalTree = "";
  journey.scenario({ goal: "中止耗时的叶子执行，保留树并重试同一叶子", preconditions: ["本地模拟模型故意保持一次设计请求未完成", "使用真实取消接口与 Subagent 执行循环"] });
  try {
    await journey.step("启动叶子并等待设计 Subagent", "叶子处于 running，真实子 Agent 的模型请求仍在进行", async () => {
      const settings = await page.request.put(`${apiBaseUrl()}/api/settings/idea-tree`, { headers, data: { maxDepth: 2, maxNodes: 8, maxSearchRounds: 2 } });
      expect(settings.ok()).toBe(true);
      fixture = await createProjectAndSession(page, { approvalMode: "always_allow", model: { apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: `Retry model ${Date.now()}` }, projectName: `Idea retry ${Date.now()}`, sessionTitle: "Idea Tree retry" });
      await openProjectSession(page, fixture);
      firstRun = await submit("/idea-tree Design a catalyst; skip literature research.");
      await expect.poll(() => stub.requests.filter(r => !r.main).length).toBe(1);
      const graph = await readGraph();
      originalTree = graph.treeId;
      expect(graph.nodes.find((n: any) => n.id === "1.1").status).toBe("running");
    });
    await journey.step("停止运行并保留可重试叶子", "Run 被取消，子 Agent 不再 running，叶子没有伪造评分", async () => {
      await page.getByRole("button", { name: /Stop the current run|停止当前运行/ }).click();
      expect((await waitForRunTerminal(page, fixture!.session.id, firstRun)).status).toBe("cancelled");
      await expect.poll(async () => (await readGraph()).nodes.find((n: any) => n.id === "1.1").status).toBe("needs_retry");
      const graph = await readGraph();
      expect(graph.nodes.find((n: any) => n.id === "1.1").score).toBeNull();
      const response = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture!.session.id}/subagents`, { headers });
      expect(response.ok()).toBe(true);
      const children = await response.json();
      expect(children.length).toBe(1);
      expect(children[0].status).not.toBe("running");
    });
    await journey.step("重试同一叶子并完成回传", "复用原树与叶子，attempt=2，完成评分和 ROOT insight", async () => {
      stub.resume();
      const secondRun = await submit("Please continue. Retry the interrupted leaf and finish the tree.");
      expect((await waitForRunTerminal(page, fixture!.session.id, secondRun)).status).toBe("completed");
      const graph = await readGraph();
      expect(graph.treeId).toBe(originalTree);
      const leaf = graph.nodes.find((n: any) => n.id === "1.1");
      expect(leaf).toMatchObject({ status: "done", attemptCount: 2, score: 7.05 });
      expect(graph.nodes.find((n: any) => n.id === "ROOT").insight).toContain("ROOT insight:");
      await page.locator(".idea-tree-view").click();
      await expect(page.getByRole("dialog", { name: "Idea Tree explorer" })).toContainText("ROOT insight:");
    });
  } finally {
    if (fixture) await cleanupJourney(page, fixture);
    await stub.stop();
  }
});
