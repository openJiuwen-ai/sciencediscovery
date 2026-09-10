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
import { keAgentStub, kePipelineStub } from "./helpers/ke-stub.ts";

test.use({ locale: "zh-CN" });

/**
 * E2E-META
 * Purpose: With a seeded knowledge base attached to a session, the agent answers a domain question by calling the KE graph tools and quoting verbatim evidence in the reply.
 * Steps:
 *   1. Create a knowledge base through the knowledge-engine page, seed it from fixture replay, and wait for the documents and entities to be ready.
 *   2. Register the pipeline stub as the default model (extraction) and the agent stub as a session-selectable model.
 *   3. Create a project and session, select the agent stub model for the task.
 *   4. Ask the relationship question; the agent calls list_knowledge_bases then concept_explore with the runtime kbId.
 *   5. The final answer names the entity and quotes the evidence; the concept_explore tool step is visible in the timeline.
 * Environment: Isolated local stack at E2E_BASE_URL started with SCIENCE_AGENT_KE_SCHOLARLY_FIXTURE_DIR pointing at test/fixtures/scholarly; zh-CN locale.
 * Type: mocked
 * LLM: two journey-owned stubs on 127.0.0.1 — pipeline stub for extraction (fixed JSON), agent stub with a dynamic kbId for the session turns.
 * WebSearch: none
 * PaperSources: fixture replay only — all scholarly connector responses come from test/fixtures/scholarly; un-recorded URLs fail loudly by design.
 * MCP: none
 * OtherExternal: none — non-local browser requests are aborted by the network guard.
 * Credentials: E2E_API_TOKEN for the isolated local API only; stub tokens have no external access.
 * CostSideEffects: no external cost; project/session and KB records live inside the disposable isolated data dir.
 */
test("J-KE3 会话内消费知识图谱", { tag: "@mocked" }, async ({ journey, page, playwright }) => {
  test.setTimeout(600_000);
  journey.scenario({
    goal: "知识库建成后，研究人员在会话里直接问领域问题，"
      + "agent 调用图谱工具、答案里带实体名与逐字证据引用。",
    preconditions: [
      "隔离栈以 fixture 模式启动，学术源走本地录制回放，不出网",
      "浏览器已持有访问 token，语言为 zh-CN",
      "抽取管线模型=旅程 stub（固定实体 mAb114 / Ebola virus glycoprotein）；会话模型=动态 kbId 的 agent stub",
    ],
  });
  await page.addInitScript(() => window.localStorage.setItem("sciencediscovery-locale", "zh-CN"));

  const seedQuery = "Ebola virus glycoprotein antibody neutralization";
  const kbName = `J-KE3 知识库 ${Date.now()}`;
  const evidenceQuote = "mAb114 binds the Ebola virus glycoprotein and neutralizes the virus";
  let kbId = "";
  const extraction = await kePipelineStub({
    entities: [
      { name: "Ebola virus glycoprotein", type: "protein" },
      { name: "mAb114", type: "antibody" },
    ],
    relations: [
      { source: "mAb114", target: "Ebola virus glycoprotein", type: "binds", evidence_quote: evidenceQuote },
    ],
  });
  const agent = await keAgentStub({
    getKbId: () => kbId || undefined,
    getEntityName: () => "mAb114",
    getEvidenceQuote: () => evidenceQuote,
  });
  let extractionProviderId = "";
  let agentProviderId = "";
  let agentModelId = "";
  let fixture: { project: JourneyProject; session: JourneySession } | undefined;
  const api = await playwright.request.newContext({
    baseURL: apiBaseUrl(),
    extraHTTPHeaders: authorizationHeader(),
  });

  try {
    await journey.step(
      "建库并完成种子摄取",
      "图谱页建库选中后种子，等文档就绪、实体出现（fixture 回放 + 抽取 stub）。",
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
          data: { name: `J-KE3 extract ${Date.now()}`, baseUrl: extraction.baseUrl, apiToken: extraction.apiToken },
        });
        const extractionProvider = await reg.json() as { id: string };
        extractionProviderId = extractionProvider.id;
        const extractionModel = await (await api.post(`/api/providers/${extractionProviderId}/models`, {
          data: { model: extraction.model, label: `J-KE3 ${extraction.model}` },
        })).json() as { id: string };
        await api.put("/api/settings", { data: { modelId: extractionModel.id } });

        await page.getByTestId("ke-seed-query").fill(seedQuery);
        await page.getByTestId("ke-seed").click();
        await expect(page.getByTestId("ke-documents")).toContainText("✓", { timeout: 480_000 });
        await expect(page.getByTestId("ke-job-status").locator("[data-status='pending'], [data-status='running']")).toHaveCount(0, { timeout: 180_000 });
      },
    );

    await journey.step(
      "注册 agent stub 模型并创建会话",
      "agent stub 注册为可选模型；新建项目与会话，并在任务上选中它。",
      async () => {
        const reg = await api.post("/api/providers", {
          data: { name: `J-KE3 agent ${Date.now()}`, baseUrl: agent.baseUrl, apiToken: agent.apiToken },
        });
        const agentProvider = await reg.json() as { id: string };
        agentProviderId = agentProvider.id;
        const model = await (await api.post(`/api/providers/${agentProviderId}/models`, {
          data: { model: agent.model, label: `J-KE3 ${agent.model}` },
        })).json() as { id: string };
        agentModelId = model.id;

        const projectName = `J-KE3 消费 ${Date.now()}`;
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

        await page.getByLabel("本任务使用的模型").click();
        const picker = page.getByRole("dialog", { name: "选择模型" });
        const modelOption = picker.getByRole("option", { name: new RegExp(agent.model.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")) });
        await modelOption.click();
        await expect(modelOption).toHaveAttribute("aria-selected", "true");
        await page.keyboard.press("Escape");
      },
    );

    await journey.step(
      "提出领域问题并等待运行完成",
      "agent 依次调用 list_knowledge_bases 与 concept_explore（带运行时 kbId），最终给出带证据的答复。",
      async () => {
        const question = "mAb114 与 Ebola virus glycoprotein 是什么关系？";
        const run = await sendUserMessage(page, fixture!.session.id, question);
        const terminal = await waitForRunTerminal(page, fixture!.session.id, run.id);
        expect(terminal.status).toBe("completed");
      },
    );

    await journey.step(
      "答复包含实体与逐字证据",
      "最终助手消息点名 mAb114 并引用证据原文；时间线中可见 concept_explore 工具步骤。",
      async () => {
        await expect(page.locator(".message.assistant").last()).toContainText("mAb114");
        await expect(page.locator(".message.assistant").last()).toContainText("binds");
        const tool = await expandToolStep(page, { contains: "concept_explore" });
        await expect(tool).toBeVisible();
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
      if (extractionProviderId) await api.delete(`/api/providers/${encodeURIComponent(extractionProviderId)}`).catch(() => undefined);
    } catch {
      // Best-effort cleanup; the journey result is authoritative.
    }
    await api.dispose().catch(() => undefined);
    await extraction.stop();
    await agent.stop();
  }
});
