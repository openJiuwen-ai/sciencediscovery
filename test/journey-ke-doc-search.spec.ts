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
import { kePipelineStub, keSearchAgentStub } from "./helpers/ke-stub.ts";

test.use({ locale: "zh-CN" });

/**
 * E2E-META
 * Purpose: With a seeded knowledge base, the agent answers a what-do-the-papers-SAY question through the document tools — kb_search returns anchor-level passage hits and kb_expand reads the block behind a real anchor from the search result.
 * Steps:
 *   1. Create a knowledge base through the knowledge-engine page, seed it from fixture replay, and wait for documents ready.
 *   2. Register the pipeline stub (extraction) and the search agent stub (session model); create a project, a session, and select the stub model.
 *   3. Ask the passage question; the agent calls list_knowledge_bases, then kb_search with the runtime kbId.
 *   4. The stub lifts the real anchorId out of the kb_search result and calls kb_expand with it; the final answer cites the anchor; both tool steps are visible in the timeline.
 * Environment: Isolated local stack at E2E_BASE_URL started with SCIENCE_AGENT_KE_SCHOLARLY_FIXTURE_DIR pointing at test/fixtures/scholarly; zh-CN locale.
 * Type: mocked
 * LLM: two journey-owned stubs on 127.0.0.1 — pipeline stub for extraction (fixed JSON), search agent stub with a dynamic kbId that parses tool results from the request history.
 * WebSearch: none
 * PaperSources: fixture replay only — all scholarly connector responses come from test/fixtures/scholarly; un-recorded URLs fail loudly by design.
 * MCP: none
 * OtherExternal: none — non-local browser requests are aborted by the network guard.
 * Credentials: E2E_API_TOKEN for the isolated local API only; stub tokens have no external access.
 * CostSideEffects: no external cost; project/session and KB records live inside the disposable isolated data dir.
 */
test("J-KE5 会话内检索论文原文段落", { tag: "@mocked" }, async ({ journey, page, playwright }) => {
  test.setTimeout(600_000);
  journey.scenario({
    goal: "知识库建成后，研究人员在会话里问论文原文怎么说，"
      + "agent 调用 kb_search 命中段落、再用 kb_expand 展开真实锚点的上下文并引用作答。",
    preconditions: [
      "隔离栈以 fixture 模式启动，学术源走本地录制回放，不出网",
      "浏览器已持有访问 token，语言为 zh-CN",
      "抽取管线模型=旅程 stub；会话模型=会解析工具结果、按真实锚点继续调用的 search agent stub",
    ],
  });
  await page.addInitScript(() => window.localStorage.setItem("sciencediscovery-locale", "zh-CN"));

  const seedQuery = "Ebola virus glycoprotein antibody neutralization";
  const searchQuery = "glycoprotein neutralization";
  const kbName = `J-KE5 知识库 ${Date.now()}`;
  let kbId = "";
  const extraction = await kePipelineStub({
    entities: [
      { name: "Ebola virus glycoprotein", type: "protein" },
      { name: "mAb114", type: "antibody" },
    ],
    relations: [
      {
        source: "mAb114",
        target: "Ebola virus glycoprotein",
        type: "binds",
        evidence_quote: "localized on the virus spike glycoprotein leading to neutralization of viral infection",
      },
    ],
  });
  const agent = await keSearchAgentStub({
    getKbId: () => kbId || undefined,
    getSearchQuery: () => searchQuery,
  });
  let extractionProviderId = "";
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
          data: { name: `J-KE5 extract ${Date.now()}`, baseUrl: extraction.baseUrl, apiToken: extraction.apiToken },
        });
        const extractionProvider = await reg.json() as { id: string };
        extractionProviderId = extractionProvider.id;
        const extractionModel = await (await api.post(`/api/providers/${extractionProviderId}/models`, {
          data: { model: extraction.model, label: `J-KE5 ${extraction.model}` },
        })).json() as { id: string };
        await api.put("/api/settings", { data: { modelId: extractionModel.id } });

        await page.getByTestId("ke-seed-query").fill(seedQuery);
        await page.getByTestId("ke-seed").click();
        await expect(page.getByTestId("ke-documents")).toContainText("✓", { timeout: 480_000 });
        await expect(page.getByTestId("ke-job-status").locator("[data-status='pending'], [data-status='running']")).toHaveCount(0, { timeout: 180_000 });
      },
    );

    await journey.step(
      "注册 search agent stub 并创建会话",
      "search agent stub 注册为可选模型；新建项目与会话，并在任务上选中它。",
      async () => {
        const reg = await api.post("/api/providers", {
          data: { name: `J-KE5 agent ${Date.now()}`, baseUrl: agent.baseUrl, apiToken: agent.apiToken },
        });
        const agentProvider = await reg.json() as { id: string };
        agentProviderId = agentProvider.id;
        const model = await (await api.post(`/api/providers/${agentProviderId}/models`, {
          data: { model: agent.model, label: `J-KE5 ${agent.model}` },
        })).json() as { id: string };

        const projectName = `J-KE5 检索 ${Date.now()}`;
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
      "提出原文段落问题并等待运行完成",
      "agent 依次调用 list_knowledge_bases 与 kb_search（带运行时 kbId），从结果里取真实锚点再调 kb_expand，最终作答。",
      async () => {
        const question = "库内论文关于 glycoprotein 中和的原文段落是怎么说的？";
        const run = await sendUserMessage(page, fixture!.session.id, question);
        const terminal = await waitForRunTerminal(page, fixture!.session.id, run.id);
        expect(terminal.status).toBe("completed");
      },
    );

    await journey.step(
      "工具链与引用可验证",
      "时间线可见 kb_search 与 kb_expand 工具步骤；最终答复引用 {docId}:{type}:{index} 形态的真实锚点。",
      async () => {
        const searchStep = await expandToolStep(page, { contains: "kb_search" });
        await expect(searchStep).toBeVisible();
        const expandStep = await expandToolStep(page, { contains: "kb_expand" });
        await expect(expandStep).toBeVisible();
        const answer = page.locator(".message.assistant").last();
        await expect(answer).toContainText("glycoprotein");
        await expect(answer).toContainText(/:[a-z]+:\d+/);
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
