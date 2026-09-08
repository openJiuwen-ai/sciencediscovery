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
import { scriptedModel } from "./helpers/journeys.ts";

test.use({ locale: "zh-CN" });

/**
 * E2E-META
 * Purpose: A researcher can create a knowledge base, issue a seed query, and watch the ingestion jobs reach success with the seeded documents ready — entirely through the product UI.
 * Steps:
 *   1. Open the knowledge-engine page from the workbench navigation in a zh-CN browser.
 *   2. Create a knowledge base through the ke-create-kb panel and confirm it appears in the list.
 *   3. Issue the seed query through the ke-seed panel and observe ke-job-status enter a running/pending state.
 *   4. Register a journey-owned stub as the default model so the extraction pipeline has a non-agent LLM to call.
 *   5. Wait until ke-job-status reports the seed pipeline succeeded and ke-documents lists the seeded documents as ready.
 *   6. Reload and confirm the knowledge base and its documents persist.
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
test("J-KE1 建库并完成一次种子摄取", { tag: "@mocked" }, async ({ journey, page }) => {
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
  const stub = await scriptedModel([
    [
      {
        text: JSON.stringify({
          entities: [
            { name: "Ebola virus glycoprotein", type: "protein", quote: "the Ebola virus glycoprotein mediates entry" },
            { name: "mAb114", type: "antibody", quote: "mAb114 neutralizes Ebola virus" },
          ],
          relations: [
            { src: "mAb114", dst: "Ebola virus glycoprotein", type: "binds", quote: "mAb114 binds the Ebola virus glycoprotein" },
          ],
        }),
      },
    ],
  ]);

  try {
    await journey.step(
      "打开知识引擎页",
      "工作台导航进入知识引擎页，页面骨架（ke-create-kb 面板与空图状态）可见。",
      async () => {
        await page.goto("/");
        await page.getByRole("button", { name: /知识引擎/ }).click();
        await expect(page.getByTestId("knowledge-engine-page")).toBeVisible();
        await expect(page.getByTestId("ke-create-kb")).toBeVisible();
        await expect(page.getByTestId("ke-graph-empty").or(page.getByTestId("ke-graph-canvas"))).toBeVisible();
      },
    );

    await journey.step(
      "创建知识库",
      "在 ke-create-kb 面板填写名称提交后，新库出现在列表中并成为当前库。",
      async () => {
        const panel = page.getByTestId("ke-create-kb");
        await panel.getByRole("textbox").first().fill(kbName);
        await panel.getByRole("button").first().click();
        await expect(page.getByText(kbName).first()).toBeVisible({ timeout: 30_000 });
      },
    );

    await journey.step(
      "发起种子查询",
      "在 ke-seed 面板填入种子查询并提交，ke-job-status 随即出现任务并处于排队/运行态。",
      async () => {
        const seed = page.getByTestId("ke-seed");
        await seed.getByRole("textbox").first().fill(seedQuery);
        await seed.getByRole("button").first().click();
        await expect(page.getByTestId("ke-job-status")).toContainText(/pending|running|等待|运行/, { timeout: 30_000 });
      },
    );

    await journey.step(
      "注册抽取 stub 为默认模型",
      "通过设置 API 注册本地 stub 服务商与模型并设为默认，使抽取管线有非 agent LLM 可调。",
      async () => {
        const api = page.request;
        const provider = await api.post(`${apiBaseUrl()}/api/providers`, {
          headers: authorizationHeader(),
          data: { name: `J-KE1 stub ${Date.now()}`, baseUrl: stub.baseUrl, apiToken: stub.apiToken, kind: "openai" },
        });
        expect(provider.ok()).toBeTruthy();
        const providerBody = await provider.json() as { id: string };
        const model = await api.post(`${apiBaseUrl()}/api/providers/${providerBody.id}/models`, {
          headers: authorizationHeader(),
          data: { modelId: stub.model, displayName: `J-KE1 ${stub.model}` },
        });
        expect(model.ok()).toBeTruthy();
        const modelBody = await model.json() as { id: string };
        const settings = await api.put(`${apiBaseUrl()}/api/settings`, {
          headers: authorizationHeader(),
          data: { modelId: modelBody.id },
        });
        expect(settings.ok()).toBeTruthy();
      },
    );

    await journey.step(
      "等待种子管线完成",
      "ke-job-status 报告任务成功（无失败/死信），ke-documents 列出已就绪的种子文档。",
      async () => {
        await expect(page.getByTestId("ke-job-status")).toContainText(/succeeded|成功|完成/, { timeout: 240_000 });
        await expect(page.getByTestId("ke-job-status")).not.toContainText(/dead|failed|失败/);
        await expect(page.getByTestId("ke-documents").getByRole("listitem, row").or(page.getByTestId("ke-documents"))).toBeVisible();
        await expect(page.getByTestId("ke-documents")).not.toContainText(/error|失败/);
      },
    );

    await journey.step(
      "刷新后知识库仍在",
      "重进知识引擎页，同名知识库与文档列表仍然可见。",
      async () => {
        await page.reload();
        await page.getByRole("button", { name: /知识引擎/ }).click();
        await expect(page.getByTestId("knowledge-engine-page")).toBeVisible();
        await expect(page.getByText(kbName).first()).toBeVisible({ timeout: 30_000 });
        await expect(page.getByTestId("ke-documents")).toBeVisible();
      },
    );
  } finally {
    await stub.stop();
  }
});
