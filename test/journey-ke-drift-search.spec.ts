// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd.
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

import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { expect } from "@playwright/test";

import { test } from "./helpers/e2e.ts";
import {
  cleanupJourney,
  expandToolStep,
  sendUserMessage,
  waitForRunTerminal,
  type JourneyProject,
  type JourneySession,
} from "./helpers/journeys.ts";
import { keDriftAgentStub, keMultiShapePipelineStub } from "./helpers/ke-stub.ts";

test.use({ locale: "zh-CN" });

/**
 * E2E-META
 * Purpose: With a seeded knowledge base whose community reports are generated, the agent answers a "where does this topic live" orientation question through drift_search — stage one selects the matching community report, stage two returns seed entities and verbatim evidence inside it, and the final answer is derived from the real tool result.
 * Steps:
 *   1. Create a knowledge base through the knowledge-engine page, register the multi-shape stub (extraction + report arms) as the default model, and seed it from fixture replay.
 *   2. Wait for the pipeline to finish, then generate community reports from the panel until coverage is complete.
 *   3. Close the knowledge-engine overlay, register the drift agent stub as the session model, create a project and session.
 *   4. Ask the orientation question; the agent calls list_knowledge_bases, then drift_search with the runtime kbId and the theme query.
 *   5. The stub derives the final answer from the drift_search result in the request history (community title, first seed entity, verbatim quote); the timeline shows the drift_search step and the answer quotes the report title and evidence.
 * Environment: Isolated local stack at E2E_BASE_URL started with SCIENCE_AGENT_KE_SCHOLARLY_FIXTURE_DIR pointing at test/fixtures/scholarly; zh-CN locale.
 * Type: mocked
 * LLM: two journey-owned stubs on 127.0.0.1 — multi-shape pipeline stub branching by request content (extraction JSON / community-report JSON matched on the "Total members:" marker), drift agent stub that parses the drift_search result from the request history.
 * WebSearch: none
 * PaperSources: fixture replay only — all scholarly connector responses come from test/fixtures/scholarly; un-recorded URLs fail loudly by design.
 * MCP: none
 * OtherExternal: none — non-local browser requests are aborted by the network guard.
 * Credentials: E2E_API_TOKEN for the isolated local API only; stub tokens have no external access.
 * CostSideEffects: no external cost; project/session and KB records live inside the disposable isolated data dir.
 */
test("J-KE9 会话内 DRIFT 主题定位", { tag: "@mocked" }, async ({ journey, page, playwright }) => {
  test.setTimeout(900_000);
  journey.scenario({
    goal: "社区报告就绪后，研究人员在会话里问主题版图，"
      + "agent 调用 drift_search 走两阶段检索：报告选中社区、社区内返回入口实体与逐字证据，答复由真实工具结果派生。",
    preconditions: [
      "隔离栈以 fixture 模式启动，学术源走本地录制回放，不出网",
      "浏览器已持有访问 token，语言为 zh-CN",
      "抽取与报告管线共用旅程注册的多形状 stub；会话模型=会解析 drift_search 结果的 drift agent stub",
      "当前图谱指纹下社区报告已生成（覆盖率全量）",
    ],
  });
  await page.addInitScript(() => window.localStorage.setItem("sciencediscovery-locale", "zh-CN"));

  // Exactly the recorded J-KE1 seed query — fixture URLs are byte-sensitive.
  const seedQuery = "Ebola virus glycoprotein antibody neutralization";
  const driftQuery = "glycoprotein antibody";
  const reportTitle = "Antibody response to the Ebola glycoprotein";
  const verbatimEvidence = "localized on the virus spike glycoprotein leading to neutralization";
  const kbName = `J-KE9 知识库 ${Date.now()}`;
  let kbId = "";
  const pipeline = await keMultiShapePipelineStub([
    {
      match: "Total members:",
      json: {
        title: reportTitle,
        summary: "This community groups neutralizing antibodies around the Ebola virus glycoprotein spike.",
        rating: 8,
        rating_explanation: "Highest-support protein hub with multiple antibody binders.",
        findings: [
          {
            summary: "mAb114 neutralizes GP",
            explanation: "The antibody localizes on the spike glycoprotein.",
            evidence: verbatimEvidence,
          },
        ],
      },
    },
    {
      match: "",
      json: {
        entities: [
          { name: "Ebola virus glycoprotein", type: "protein" },
          { name: "mAb114", type: "antibody" },
          { name: "REGN3471", type: "antibody" },
          { name: "interferon-alpha", type: "cytokine" },
          { name: "ISG15", type: "protein" },
        ],
        relations: [
          {
            source: "mAb114",
            target: "Ebola virus glycoprotein",
            type: "binds",
            evidence_quote: `${verbatimEvidence} of viral infection`,
          },
          {
            source: "REGN3471",
            target: "Ebola virus glycoprotein",
            type: "binds",
            evidence_quote: `${verbatimEvidence} of viral infection`,
          },
        ],
      },
    },
  ]);
  const agent = await keDriftAgentStub({
    getKbId: () => kbId || undefined,
    getDriftQuery: () => driftQuery,
  });
  let pipelineProviderId = "";
  let agentProviderId = "";
  let fixture: { project: JourneyProject; session: JourneySession } | undefined;
  const api = await playwright.request.newContext({
    baseURL: apiBaseUrl(),
    extraHTTPHeaders: authorizationHeader(),
  });

  try {
    await journey.step(
      "建库并完成种子摄取",
      "图谱页建库选中后种子，等文档就绪（fixture 回放 + 抽取 stub）。",
      async () => {
        await page.goto("/");
        await page.getByTestId("open-knowledge-engine").click();
        await expect(page.getByTestId("knowledge-engine-page")).toBeVisible();
        await page.getByTestId("ke-new-kb-name").fill(kbName);
        await page.getByTestId("ke-create-kb").click();
        const kbItem = page.locator('[data-testid^="ke-kb-"]').filter({ hasText: kbName });
        await expect(kbItem).toBeVisible({ timeout: 30_000 });
        kbId = ((await kbItem.getAttribute("data-testid")) ?? "").replace("ke-kb-", "");
        await kbItem.click();
        await expect(page.getByTestId("ke-seed-query")).toBeVisible();

        const reg = await api.post("/api/providers", {
          data: { name: `J-KE9 pipeline ${Date.now()}`, baseUrl: pipeline.baseUrl, apiToken: pipeline.apiToken },
        });
        const pipelineProvider = await reg.json() as { id: string };
        pipelineProviderId = pipelineProvider.id;
        const pipelineModel = await (await api.post(`/api/providers/${pipelineProviderId}/models`, {
          data: { model: pipeline.model, label: `J-KE9 ${pipeline.model}` },
        })).json() as { id: string };
        await api.put("/api/settings", { data: { modelId: pipelineModel.id } });

        await page.getByTestId("ke-seed-query").fill(seedQuery);
        await page.getByTestId("ke-seed").click();
        await expect(page.getByTestId("ke-documents")).toContainText("✓", { timeout: 600_000 });
        await expect(page.getByTestId("ke-job-status").locator("[data-status='pending'], [data-status='running']")).toHaveCount(0, { timeout: 180_000 });
      },
    );

    await journey.step(
      "生成社区报告至全覆盖",
      "点击生成并等待覆盖率行显示全部社区完成（drift 的 stage-1 语料就位）。",
      async () => {
        const panel = page.getByTestId("ke-reports-panel");
        await expect(panel).toBeVisible({ timeout: 30_000 });
        await expect(page.getByTestId("ke-reports-coverage")).toContainText(/\/\s*[1-9]\d*\s*个社区/, { timeout: 60_000 });
        await expect(page.getByTestId("ke-report-generate")).toBeEnabled({ timeout: 30_000 });
        await page.getByTestId("ke-report-generate").click({ timeout: 15_000 });
        await expect
          .poll(async () => {
            const text = await page.getByTestId("ke-reports-coverage").textContent();
            const match = text?.match(/(\d+)\s*\/\s*(\d+)/);
            return match ? match[1] === match[2] : false;
          }, { timeout: 300_000, intervals: [3_000] })
          .toBe(true);
      },
    );

    await journey.step(
      "注册 drift agent stub 并创建会话",
      "drift agent stub 注册为可选模型；新建项目与会话，并在任务上选中它。",
      async () => {
        // The knowledge-engine page is a full-page overlay covering the
        // workbench sidebar — close it before reaching for 添加项目.
        await page.getByTestId("ke-close").click();
        const reg = await api.post("/api/providers", {
          data: { name: `J-KE9 agent ${Date.now()}`, baseUrl: agent.baseUrl, apiToken: agent.apiToken },
        });
        const agentProvider = await reg.json() as { id: string };
        agentProviderId = agentProvider.id;
        const model = await (await api.post(`/api/providers/${agentProviderId}/models`, {
          data: { model: agent.model, label: `J-KE9 ${agent.model}` },
        })).json() as { id: string };

        const projectName = `J-KE9 主题定位 ${Date.now()}`;
        await page.getByRole("button", { name: "添加项目" }).click();
        const createProject = page.getByRole("dialog", { name: "创建项目" });
        await createProject.getByLabel("项目名称").fill(projectName);
        const projectResponsePromise = page.waitForResponse((response) =>
          response.request().method() === "POST" && new URL(response.url()).pathname === "/api/projects");
        await createProject.getByRole("button", { name: "创建项目", exact: true }).click();
        const created = await (await projectResponsePromise).json() as {
          firstSession: JourneySession;
          project: JourneyProject;
        };
        fixture = { project: created.project, session: created.firstSession };

        // The app fetches /api/models once at boot; refresh so the provider
        // registered out of band becomes selectable.
        await page.reload();
        await expect(page.getByRole("heading", { name: created.firstSession.title })).toBeVisible({ timeout: 30_000 });
        await page.getByLabel("本任务使用的模型").click();
        const picker = page.getByRole("dialog", { name: "选择模型" });
        const modelOption = picker.getByRole("option", { name: new RegExp(agent.model.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")) });
        await modelOption.click();
        await expect(modelOption).toHaveAttribute("aria-selected", "true");
        await page.keyboard.press("Escape");
      },
    );

    await journey.step(
      "提出主题定位问题并等待运行完成",
      "agent 依次调用 list_knowledge_bases 与 drift_search（带运行时 kbId），从两阶段检索结果派生最终作答。",
      async () => {
        const question = "库内主题版图：glycoprotein 抗体这个主题在哪些社区里？入口实体和证据是什么？";
        const run = await sendUserMessage(page, fixture!.session.id, question);
        const terminal = await waitForRunTerminal(page, fixture!.session.id, run.id);
        expect(terminal.status).toBe("completed");
      },
    );

    await journey.step(
      "工具链与派生作答可验证",
      "时间线可见 drift_search 工具步骤；最终答复包含真实报告标题、入口实体与逐字证据片段。",
      async () => {
        const driftStep = await expandToolStep(page, { contains: "drift_search" });
        await expect(driftStep).toBeVisible();
        const answer = page.locator(".message.assistant").last();
        await expect(answer).toContainText(reportTitle);
        await expect(answer).toContainText("Ebola virus glycoprotein");
        await expect(answer).toContainText("localized on the virus spike glycoprotein");
      },
    );
  } finally {
    try {
      if (fixture) {
        await cleanupJourney(page, fixture).catch(() => undefined);
      }
      const settingsRaw = await api.get("/api/settings").then((r) => r.json()).catch(() => ({}) as { overrides?: Record<string, unknown> });
      const overrides = { ...(settingsRaw?.overrides ?? {}) };
      let changed = false;
      for (const key of ["modelId", "reviewModelId"]) {
        if (overrides[key]) { delete overrides[key]; changed = true; }
      }
      if (changed) await api.put("/api/settings", { data: overrides }).catch(() => undefined);
      if (agentProviderId) await api.delete(`/api/providers/${encodeURIComponent(agentProviderId)}`).catch(() => undefined);
      if (pipelineProviderId) await api.delete(`/api/providers/${encodeURIComponent(pipelineProviderId)}`).catch(() => undefined);
    } catch {
      // Best-effort cleanup; the journey result is authoritative.
    }
    await api.dispose().catch(() => undefined);
    await pipeline.stop();
    await agent.stop();
  }
});
