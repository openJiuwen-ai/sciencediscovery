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
import { kePipelineStub } from "./helpers/ke-stub.ts";

test.use({ locale: "zh-CN" });

/**
 * E2E-META
 * Purpose: A researcher can create a knowledge base, issue a seed query, and watch the ingestion jobs reach success with the seeded documents ready — entirely through the product UI.
 * Steps:
 *   1. Open the knowledge-engine page from the workbench navigation in a zh-CN browser.
 *   2. Create a knowledge base through the create panel, then select it in the KB list so the seed panel renders.
 *   3. Issue the seed query through the seed panel and observe the job status enter a queued/running state.
 *   4. Register a journey-owned stub as the default model so the extraction pipeline has a non-agent LLM to call.
 *   5. Wait until the job status reports the seed pipeline succeeded and the documents list shows the seeded documents ready.
 *   6. Reload, re-select the knowledge base, and confirm the documents persist.
 * Environment: Isolated local stack at E2E_BASE_URL started with SCIENCE_AGENT_KE_SCHOLARLY_FIXTURE_DIR pointing at test/fixtures/scholarly so all scholarly connectors replay local fixtures; zh-CN locale.
 * Type: mocked
 * LLM: journey-registered OpenAI-compatible HTTP stub on 127.0.0.1 returning a fixed extraction JSON for the non-agent pipeline calls.
 * WebSearch: none
 * PaperSources: fixture replay only — arxiv / semantic-scholar / europepmc (search + JATS full text) / openalex / unpaywall / pubmed responses come from test/fixtures/scholarly; un-recorded URLs fail loudly by design.
 * MCP: none
 * OtherExternal: none — non-local browser requests are aborted by the network guard.
 * Credentials: E2E_API_TOKEN for the isolated local API only; the stub token has no external access.
 * CostSideEffects: no external cost; knowledge-base records live inside the disposable isolated data dir.
 */
test("J-KE1 建库并完成一次种子摄取", { tag: "@mocked" }, async ({ journey, page, playwright }) => {
  test.setTimeout(300_000);
  journey.scenario({
    goal: "一位研究人员要在知识引擎页新建知识库、发起一次种子摄取，"
      + "看着任务跑到成功、文档就绪，刷新后工作仍然在。",
    preconditions: [
      "隔离栈以 fixture 模式启动（SCIENCE_AGENT_KE_SCHOLARLY_FIXTURE_DIR 指向 test/fixtures/scholarly），不出网",
      "浏览器已持有本实例的访问 token，语言为 zh-CN",
      "抽取管线模型由旅程注册的本地 stub 提供，stub 返回固定抽取 JSON",
      "fixture 录制件覆盖种子查询触发的全部学术源 URL（未录制即响亮报错，测试应当失败而不是假成功）",
    ],
  });
  await page.addInitScript(() => window.localStorage.setItem("sciencediscovery-locale", "zh-CN"));

  const seedQuery = "Ebola virus glycoprotein antibody neutralization";
  const kbName = `J-KE1 知识库 ${Date.now()}`;
  // Extraction JSON follows packages/knowledge-engine/src/extraction/parse.ts:
  // entities {name,type}; relations {source,target,type,evidence_quote} where
  // evidence_quote must appear VERBATIM in the ingested fulltext or the
  // provenance gate drops the relation. The quote below is a placeholder to
  // calibrate against the recorded fixture corpus at the stage gate.
  const stub = await kePipelineStub({
    entities: [
      { name: "Ebola virus glycoprotein", type: "protein" },
      { name: "mAb114", type: "antibody" },
    ],
    relations: [
      {
        source: "mAb114",
        target: "Ebola virus glycoprotein",
        type: "binds",
        evidence_quote: "mAb114 binds the Ebola virus glycoprotein and neutralizes the virus",
      },
    ],
  });
  let providerId = "";
  let modelId = "";

  try {
    await journey.step(
      "打开知识引擎页",
      "工作台导航进入知识引擎页，页面骨架（建库输入框与空图状态）可见。",
      async () => {
        await page.goto("/");
        await page.getByRole("button", { name: "Knowledge Engine" }).click();
        await expect(page.getByTestId("knowledge-engine-page")).toBeVisible();
        await expect(page.getByLabel("new kb name")).toBeVisible();
        await expect(page.getByTestId("ke-graph-empty")).toBeVisible();
      },
    );

    await journey.step(
      "创建知识库并选中",
      "填写名称点 Create 后新库出现在列表；点列表项选中它，种子面板出现。",
      async () => {
        await page.getByLabel("new kb name").fill(kbName);
        await page.getByTestId("ke-create-kb").click();
        const kbItem = page.locator('[data-testid^="ke-kb-"]').filter({ hasText: kbName });
        await expect(kbItem).toBeVisible({ timeout: 30_000 });
        // Creating does not auto-select; the Seed panel only renders for the active KB.
        await kbItem.click();
        await expect(page.getByLabel("seed query")).toBeVisible();
      },
    );

    await journey.step(
      "发起种子查询",
      "填入种子查询点 Seed，ke-job-status 随即出现任务并处于排队/运行态。",
      async () => {
        await page.getByLabel("seed query").fill(seedQuery);
        await page.getByTestId("ke-seed").click();
        await expect(page.getByTestId("ke-job-status")).not.toContainText("no jobs yet", { timeout: 30_000 });
      },
    );

    await journey.step(
      "注册抽取 stub 为默认模型",
      "通过设置 API 注册本地 stub 服务商与模型并设为默认，使抽取管线有非 agent LLM 可调。",
      async () => {
        const api = page.request;
        const provider = await api.post(`${apiBaseUrl()}/api/providers`, {
          headers: authorizationHeader(),
          data: { name: `J-KE1 stub ${Date.now()}`, baseUrl: stub.baseUrl, apiToken: stub.apiToken },
        });
        expect(provider.ok()).toBeTruthy();
        const providerBody = await provider.json() as { id: string };
        providerId = providerBody.id;
        const model = await api.post(`${apiBaseUrl()}/api/providers/${providerId}/models`, {
          headers: authorizationHeader(),
          data: { model: stub.model, label: `J-KE1 ${stub.model}` },
        });
        expect(model.ok()).toBeTruthy();
        const modelBody = await model.json() as { id: string };
        modelId = modelBody.id;
        const settings = await api.put(`${apiBaseUrl()}/api/settings`, {
          headers: authorizationHeader(),
          data: { modelId },
        });
        expect(settings.ok()).toBeTruthy();
      },
    );

    await journey.step(
      "等待种子管线完成",
      "ke-job-status 报告任务成功（无失败/死信），ke-documents 列出已就绪的种子文档。",
      async () => {
        await expect(page.getByTestId("ke-job-status")).toContainText(/succeeded/, { timeout: 240_000 });
        await expect(page.getByTestId("ke-job-status")).not.toContainText(/dead|failed/);
        await expect(page.getByTestId("ke-documents")).toContainText("✓", { timeout: 30_000 });
      },
    );

    await journey.step(
      "刷新后知识库仍在",
      "重进知识引擎页，重选同名知识库后文档列表仍可见。",
      async () => {
        await page.reload();
        await page.getByRole("button", { name: "Knowledge Engine" }).click();
        await expect(page.getByTestId("knowledge-engine-page")).toBeVisible();
        const restored = page.locator('[data-testid^="ke-kb-"]').filter({ hasText: kbName });
        await expect(restored).toBeVisible({ timeout: 30_000 });
        await restored.click();
        await expect(page.getByTestId("ke-documents")).toBeVisible();
      },
    );
  } finally {
    // The stub provider/model/default override must not leak into later
    // journeys sharing this stack (J1/J6/J7 assert a clean registry).
    if (providerId) {
      const api = await playwright.request.newContext({
        baseURL: apiBaseUrl(),
        extraHTTPHeaders: authorizationHeader(),
      });
      try {
        const settingsRaw = await api.get("/api/settings").catch(() => undefined);
        const settings = settingsRaw ? ((await settingsRaw.json().catch(() => ({}))) as { overrides?: Record<string, unknown> }) : undefined;
        const overrides = { ...(settings?.overrides ?? {}) };
        let changed = false;
        for (const key of ["modelId", "reviewModelId"]) {
          if (overrides[key] === modelId) {
            delete overrides[key];
            changed = true;
          }
        }
        if (changed) await api.put("/api/settings", { data: overrides }).catch(() => undefined);
        await api.delete(`/api/providers/${encodeURIComponent(providerId)}`).catch(() => undefined);
      } catch {
        // Best-effort cleanup; the journey result is authoritative.
      }
      await api.dispose().catch(() => undefined);
    }
    await stub.stop();
  }
});
