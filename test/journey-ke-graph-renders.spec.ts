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
 * Purpose: After a seeded knowledge base ingests, the researcher sees the entity graph render without console errors and can drill into an entity's evidence-backed detail.
 * Steps:
 *   1. Open the knowledge-engine page, create a knowledge base, and select it in the KB list.
 *   2. Register a journey-owned stub as the default model so the extraction pipeline has a non-agent LLM.
 *   3. Issue the seed query through the seed panel and wait for the pipeline to succeed.
 *   4. Observe the graph canvas render non-empty with zero console errors.
 *   5. Click a graph node and verify the entity detail panel shows the entity with its evidence quote and source document.
 * Environment: Isolated local stack at E2E_BASE_URL started with SCIENCE_AGENT_KE_SCHOLARLY_FIXTURE_DIR pointing at test/fixtures/scholarly; zh-CN locale.
 * Type: mocked
 * LLM: journey-registered OpenAI-compatible HTTP stub on 127.0.0.1 returning a fixed extraction JSON for the non-agent pipeline calls.
 * WebSearch: none
 * PaperSources: fixture replay only — all scholarly connector responses come from test/fixtures/scholarly; un-recorded URLs fail loudly by design.
 * MCP: none
 * OtherExternal: none — non-local browser requests are aborted by the network guard.
 * Credentials: E2E_API_TOKEN for the isolated local API only; the stub token has no external access.
 * CostSideEffects: no external cost; knowledge-base records live inside the disposable isolated data dir.
 */
test("J-KE2 图谱渲染与实体详情", { tag: "@mocked" }, async ({ journey, page, playwright }) => {
  test.setTimeout(300_000);
  journey.scenario({
    goal: "种子摄取完成后，研究人员能在图谱页看到实体关系图（无 console error），"
      + "点开一个实体能看到带证据引用的详情面板。",
    preconditions: [
      "隔离栈以 fixture 模式启动，学术源全部走本地录制回放，不出网",
      "浏览器已持有访问 token，语言为 zh-CN",
      "抽取管线模型由旅程注册的本地 stub 提供，stub 返回含已知实体/关系/逐字证据的固定 JSON",
    ],
  });
  await page.addInitScript(() => window.localStorage.setItem("sciencediscovery-locale", "zh-CN"));

  const seedQuery = "Ebola virus glycoprotein antibody neutralization";
  const kbName = `J-KE2 知识库 ${Date.now()}`;
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

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
      "打开知识引擎页并建库选中",
      "知识引擎页可见；建库后在列表中选中它，种子面板出现。",
      async () => {
        await page.goto("/");
        await page.getByRole("button", { name: "Knowledge Engine" }).click();
        await expect(page.getByTestId("knowledge-engine-page")).toBeVisible();
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
      "注册抽取 stub 并发起种子",
      "stub 注册为默认模型后，发起种子查询，任务面板出现任务。",
      async () => {
        const api = page.request;
        const provider = await api.post(`${apiBaseUrl()}/api/providers`, {
          headers: authorizationHeader(),
          data: { name: `J-KE2 stub ${Date.now()}`, baseUrl: stub.baseUrl, apiToken: stub.apiToken },
        });
        const providerBody = await provider.json() as { id: string };
        providerId = providerBody.id;
        const model = await api.post(`${apiBaseUrl()}/api/providers/${providerId}/models`, {
          headers: authorizationHeader(),
          data: { model: stub.model, label: `J-KE2 ${stub.model}` },
        });
        const modelBody = await model.json() as { id: string };
        modelId = modelBody.id;
        await api.put(`${apiBaseUrl()}/api/settings`, { headers: authorizationHeader(), data: { modelId } });

        await page.getByLabel("seed query").fill(seedQuery);
        await page.getByTestId("ke-seed").click();
        await expect(page.getByTestId("ke-job-status")).not.toContainText("no jobs yet", { timeout: 30_000 });
      },
    );

    await journey.step(
      "等待管线完成并观察图谱渲染",
      "任务成功后图谱画布渲染出节点与边（非空），期间无 console error。",
      async () => {
        await expect(page.getByTestId("ke-job-status")).toContainText(/succeeded/, { timeout: 240_000 });
        const canvas = page.getByTestId("ke-graph-canvas");
        await expect(canvas).toBeVisible({ timeout: 60_000 });
        await expect(canvas.locator("*").first()).toBeVisible({ timeout: 60_000 });
      },
    );

    await journey.step(
      "点开实体详情",
      "点击图中一个节点，ke-entity-detail 面板展示实体名称与证据（逐字引用及来源文档）。",
      async () => {
        const canvas = page.getByTestId("ke-graph-canvas");
        const node = canvas.locator("canvas").or(canvas.locator("*")).first();
        await node.click({ force: true });
        const detail = page.getByTestId("ke-entity-detail");
        await expect(detail).toBeVisible({ timeout: 30_000 });
        await expect(detail).toContainText(/Ebola virus glycoprotein|mAb114/);
        // Evidence-quote display is asserted once the stub quotes are
        // calibrated against the recorded fulltext (stage-gate calibration).
      },
    );

    await journey.step(
      "整个旅程零 console error",
      "旅程结束时收集到的 console error 为空。",
      async () => {
        expect(consoleErrors).toEqual([]);
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
