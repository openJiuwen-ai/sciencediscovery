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
import { keAntiHallucinationAgentStub, kePipelineStub } from "./helpers/ke-stub.ts";

test.use({ locale: "zh-CN" });

/**
 * E2E-META
 * Purpose: A researcher asks the agent to assert a "first-ever report" novelty claim about the knowledge base; the agent runs the anti-hallucination checks (novelty_check + verify_citation) and its final answer is derived from the actual check results — the overreaching claim is flagged instead of echoed.
 * Steps:
 *   1. Create a knowledge base through the knowledge-engine page, seed it from fixture replay, and wait for documents ready (the seeded graph contains the mAb114→GP relation the claim overreaches about).
 *   2. Register the pipeline stub (extraction) and the anti-hallucination agent stub (session model); create a project and session and select the stub model.
 *   3. Ask the novelty question; the agent calls list_knowledge_bases, then novelty_check with the runtime kbId, then verify_citation on the calibrated quote.
 *   4. The final answer reflects the REAL check results parsed from the tool history — collision verdict + verbatim citation — and drops the "first-ever" framing; both tool steps are visible in the timeline.
 * Environment: Isolated local stack at E2E_BASE_URL started with SCIENCE_AGENT_KE_SCHOLARLY_FIXTURE_DIR pointing at test/fixtures/scholarly; zh-CN locale.
 * Type: mocked
 * LLM: two journey-owned stubs on 127.0.0.1 — pipeline stub for extraction (fixed JSON), anti-hallucination agent stub whose final answer is derived from the parsed novelty/verify tool results (dynamic, not canned).
 * WebSearch: none
 * PaperSources: fixture replay only — all scholarly connector responses come from test/fixtures/scholarly; un-recorded URLs fail loudly by design.
 * MCP: none
 * OtherExternal: none — non-local browser requests are aborted by the network guard.
 * Credentials: E2E_API_TOKEN for the isolated local API only; stub tokens have no external access.
 * CostSideEffects: no external cost; project/session and KB records live inside the disposable isolated data dir.
 */
test("J-KE6 反幻觉：夸大新颖性声明被检查结果标注", { tag: "@mocked" }, async ({ journey, page, playwright }) => {
  test.setTimeout(900_000);
  journey.scenario({
    goal: "研究人员让 agent 断言一条「首次发现」的新颖性声明，"
      + "agent 先跑 novelty_check 与 verify_citation，答案依据真实检查结果降级表述而不是复读夸大。",
    preconditions: [
      "隔离栈以 fixture 模式启动，学术源走本地录制回放，不出网",
      "浏览器已持有访问 token，语言为 zh-CN",
      "抽取管线模型=旅程 stub（校准 quote 逐字命中 fixture 全文）；会话模型=按工具结果作答的反幻觉 stub",
    ],
  });
  await page.addInitScript(() => window.localStorage.setItem("sciencediscovery-locale", "zh-CN"));

  const seedQuery = "Ebola virus glycoprotein antibody neutralization";
  // Names BOTH entities exactly as the stub extracts them, so the relation
  // probe hits deterministically (ends-named arm → collision).
  const noveltyClaim = "首次报道 mAb114 与 Ebola virus glycoprotein 的结合";
  const quote = "localized on the virus spike glycoprotein leading to neutralization of viral infection";
  const kbName = `J-KE6 知识库 ${Date.now()}`;
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
        evidence_quote: quote,
      },
    ],
  });
  const agent = await keAntiHallucinationAgentStub({
    getKbId: () => kbId || undefined,
    getNoveltyClaim: () => noveltyClaim,
    getQuote: () => quote,
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
      "图谱页建库选中后种子，等文档就绪（fixture 回放 + 抽取 stub，校准 quote 使关系通过溯源门）。",
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
          data: { name: `J-KE6 extract ${Date.now()}`, baseUrl: extraction.baseUrl, apiToken: extraction.apiToken },
        });
        const extractionProvider = await reg.json() as { id: string };
        extractionProviderId = extractionProvider.id;
        const extractionModel = await (await api.post(`/api/providers/${extractionProviderId}/models`, {
          data: { model: extraction.model, label: `J-KE6 ${extraction.model}` },
        })).json() as { id: string };
        await api.put("/api/settings", { data: { modelId: extractionModel.id } });

        await page.getByTestId("ke-seed-query").fill(seedQuery);
        await page.getByTestId("ke-seed").click();
        await expect(page.getByTestId("ke-documents")).toContainText("✓", { timeout: 600_000 });
        await expect(page.getByTestId("ke-job-status").locator("[data-status='pending'], [data-status='running']")).toHaveCount(0, { timeout: 180_000 });
      },
    );

    await journey.step(
      "注册反幻觉 stub 并创建会话",
      "反幻觉 agent stub 注册为可选模型；新建项目与会话，并在任务上选中它。",
      async () => {
        const reg = await api.post("/api/providers", {
          data: { name: `J-KE6 agent ${Date.now()}`, baseUrl: agent.baseUrl, apiToken: agent.apiToken },
        });
        const agentProvider = await reg.json() as { id: string };
        agentProviderId = agentProvider.id;
        const model = await (await api.post(`/api/providers/${agentProviderId}/models`, {
          data: { model: agent.model, label: `J-KE6 ${agent.model}` },
        })).json() as { id: string };

        const projectName = `J-KE6 反幻觉 ${Date.now()}`;
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
      "提出夸大新颖性问题并等待运行完成",
      "agent 依次调用 list_knowledge_bases、novelty_check（带运行时 kbId 与声明）、verify_citation（校准引文），随后作答。",
      async () => {
        const question = `可以声称「${noveltyClaim}」吗？`;
        const run = await sendUserMessage(page, fixture!.session.id, question);
        const terminal = await waitForRunTerminal(page, fixture!.session.id, run.id);
        expect(terminal.status).toBe("completed");
      },
    );

    await journey.step(
      "夸大被标注而非复读",
      "时间线可见 novelty_check 与 verify_citation 步骤；最终答复引用真实 verdict=collision 与 verbatim 核验结果，并明确放弃「首次」表述。",
      async () => {
        const noveltyStep = await expandToolStep(page, { contains: "novelty_check" });
        await expect(noveltyStep).toBeVisible();
        const verifyStep = await expandToolStep(page, { contains: "verify_citation" });
        await expect(verifyStep).toBeVisible();

        const answer = page.locator(".message.assistant").last();
        // The stub derives the answer from the REAL tool results: the seeded
        // mAb114→GP relation forces collision, the calibrated quote forces
        // verbatim — anything else is a product bug.
        await expect(answer).toContainText("collision");
        await expect(answer).toContainText("不能声称首次发现");
        await expect(answer).toContainText("verbatim");
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
