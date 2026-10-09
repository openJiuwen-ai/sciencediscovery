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
import { keMultiShapePipelineStub } from "./helpers/ke-stub.ts";

// Static suite metadata is inherited by each framework-expanded journey.
test.describe("journey-ke-community-report.spec", { tag: ["@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"] }, () => {

test.use({ locale: "zh-CN" });

/**
 * E2E-META
 * Purpose: After a seeded knowledge base forms communities, the researcher generates community reports from the panel and reads a digest with findings and verbatim evidence; small communities get a deterministic stub instead of an LLM call.
 * Steps:
 *   1. Open the knowledge-engine page, create a knowledge base, select it, register a multi-shape stub as the default model, and seed it.
 *   2. Wait for the pipeline to finish so the graph has two communities (a 3-member linked cluster plus isolated entities).
 *   3. Click ke-report-generate and wait for the coverage line to show every community covered.
 *   4. Expand one report and verify summary, findings and verbatim evidence; verify a small community shows the deterministic stub summary.
 * Environment: Isolated local stack at E2E_BASE_URL started with SCIENCE_AGENT_KE_SCHOLARLY_FIXTURE_DIR pointing at test/fixtures/scholarly; zh-CN locale.
 * Type: mocked
 * LLM: journey-registered OpenAI-compatible HTTP stub on 127.0.0.1 branching by request content — extraction JSON for ingest calls, report JSON for community-report calls (matched on the "Total members:" prompt marker).
 * WebSearch: none
 * PaperSources: fixture replay only — all scholarly connector responses come from test/fixtures/scholarly; un-recorded URLs fail loudly by design.
 * MCP: none
 * OtherExternal: none — non-local browser requests are aborted by the network guard.
 * Credentials: E2E_API_TOKEN for the isolated local API only; the stub token has no external access.
 * CostSideEffects: no external cost; knowledge-base records live inside the disposable isolated data dir.
 */
test("J-KE8 社区报告生成与阅读", { tag: "@mocked" }, async ({ journey, page, playwright }) => {
  test.setTimeout(900_000);
  journey.scenario({
    goal: "种子摄取成社区后，研究人员在社区报告面板一键生成报告，"
      + "展开阅读带逐字证据的发现摘要；小社区走确定性占位而非 LLM。",
    preconditions: [
      "隔离栈以 fixture 模式启动，学术源全部走本地录制回放，不出网",
      "浏览器已持有访问 token，语言为 zh-CN",
      "抽取与报告管线共用旅程注册的多形状 stub（按请求内容分流）",
    ],
  });
  await page.addInitScript(() => window.localStorage.setItem("sciencediscovery-locale", "zh-CN"));

  // Exactly the recorded J-KE1 seed query — fixture URLs are byte-sensitive;
  // a quoted variant would request un-recorded arXiv URLs and die loudly.
  const seedQuery = "Ebola virus glycoprotein antibody neutralization";
  const kbName = `J-KE8 知识库 ${Date.now()}`;

  // Extraction arm: 3-member linked cluster (all quotes verbatim in the
  // corpus, gate-proven by J-KE2/J-KE4) + 2 isolated entities → Louvain
  // yields a ≥3-member community (real report path via the report arm) plus
  // small communities (deterministic stub path, no LLM).
  const stub = await keMultiShapePipelineStub([
    {
      match: "Total members:",
      json: {
        title: "Antibody response to the Ebola glycoprotein",
        summary: "This community groups neutralizing antibodies around the Ebola virus glycoprotein spike.",
        rating: 8,
        rating_explanation: "Highest-support protein hub with multiple antibody binders.",
        findings: [
          {
            summary: "mAb114 neutralizes GP",
            explanation: "The antibody localizes on the spike glycoprotein.",
            evidence: "localized on the virus spike glycoprotein leading to neutralization",
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
            evidence_quote: "localized on the virus spike glycoprotein leading to neutralization of viral infection",
          },
          {
            source: "REGN3471",
            target: "Ebola virus glycoprotein",
            type: "binds",
            evidence_quote: "localized on the virus spike glycoprotein leading to neutralization of viral infection",
          },
        ],
      },
    },
  ]);
  let providerId = "";
  let modelId = "";

  try {
    await journey.step(
      "打开知识引擎页并建库选中",
      "知识引擎页可见；建库后在列表中选中它，种子面板出现。",
      async () => {
        await page.goto("/");
        await page.getByTestId("open-knowledge-engine").click();
        await expect(page.getByTestId("knowledge-engine-page")).toBeVisible();
        await page.getByTestId("ke-new-kb-name").fill(kbName);
        await page.getByTestId("ke-create-kb").click();
        const kbItem = page.locator('[data-testid^="ke-kb-"]').filter({ hasText: kbName });
        await expect(kbItem).toBeVisible({ timeout: 30_000 });
        await kbItem.click();
        await expect(page.getByTestId("ke-seed-query")).toBeVisible();
      },
    );

    await journey.step(
      "注册多形状 stub 并发起种子",
      "stub 注册为默认模型后发起种子查询，任务面板出现任务。",
      async () => {
        const api = page.request;
        const provider = await api.post(`${apiBaseUrl()}/api/providers`, {
          headers: authorizationHeader(),
          data: { name: `J-KE8 stub ${Date.now()}`, baseUrl: stub.baseUrl, apiToken: stub.apiToken },
        });
        const providerBody = await provider.json() as { id: string };
        providerId = providerBody.id;
        const model = await api.post(`${apiBaseUrl()}/api/providers/${providerId}/models`, {
          headers: authorizationHeader(),
          data: { model: stub.model, label: `J-KE8 ${stub.model}` },
        });
        const modelBody = await model.json() as { id: string };
        modelId = modelBody.id;
        await api.put(`${apiBaseUrl()}/api/settings`, { headers: authorizationHeader(), data: { modelId } });

        await page.getByTestId("ke-seed-query").fill(seedQuery);
        await page.getByTestId("ke-seed").click();
        await expect(page.getByTestId("ke-job-status").locator("[data-status]").first()).toBeVisible({ timeout: 30_000 });
      },
    );

    await journey.step(
      "等待管线完成并确认社区就绪",
      "文档全部 ✓ 且活跃任务清空；报告面板出现且覆盖率显示社区总数。",
      async () => {
        await expect(page.getByTestId("ke-documents")).toContainText("✓", { timeout: 600_000 });
        await expect(page.getByTestId("ke-job-status").locator("[data-status='pending'], [data-status='running']")).toHaveCount(0, { timeout: 180_000 });
        const panel = page.getByTestId("ke-reports-panel");
        await expect(panel).toBeVisible({ timeout: 30_000 });
        // The coverage line must show a NON-ZERO community total — the panel
        // reads the page's centrally refreshed status (a mount-time snapshot
        // of the empty pre-seed graph would read 0/0 and disable generate).
        await expect(page.getByTestId("ke-reports-coverage")).toContainText(/\/\s*[1-9]\d*\s*个社区/, { timeout: 60_000 });
      },
    );

    await journey.step(
      "生成社区报告",
      "点击生成，任务逐社区完成，覆盖率行达到全部社区。",
      async () => {
        await expect(page.getByTestId("ke-report-generate")).toBeEnabled({ timeout: 30_000 });
        await page.getByTestId("ke-report-generate").click({ timeout: 15_000 });
        // Jobs run on the stack's 1s poll; the panel polls coverage every 3s.
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
      "阅读报告详情与逐字证据",
      "展开一个报告：标题/摘要/发现可见，发现带逐字证据引文；另有一个小社区占位报告。",
      async () => {
        const titled = page.locator('[data-testid^="ke-report-title-"]').filter({ hasText: "Antibody response to the Ebola glycoprotein" });
        await expect(titled.first()).toBeVisible({ timeout: 30_000 });
        const itemId = await titled.first().getAttribute("data-testid");
        const communityId = itemId?.replace("ke-report-title-", "");
        await expect(communityId).toBeTruthy();
        await page.getByTestId(`ke-report-item-${communityId}`).click();
        const detail = page.getByTestId(`ke-report-detail-${communityId}`);
        await expect(detail).toBeVisible();
        await expect(detail).toContainText("neutralizing antibodies");
        const finding = page.getByTestId(`ke-report-finding-${communityId}`).first();
        await expect(finding).toContainText("mAb114 neutralizes GP");
        await expect(finding).toContainText("localized on the virus spike glycoprotein leading to neutralization");
        // Small communities (isolated entities) get the deterministic stub —
        // the summary only renders while expanded, so walk the items.
        const items = page.locator('[data-testid^="ke-report-item-"]');
        const count = await items.count();
        let smallSeen = false;
        for (let i = 0; i < count; i++) {
          await items.nth(i).click();
          const small = page.locator('[data-testid^="ke-report-detail-"]', { hasText: "Small community" });
          if ((await small.count()) > 0) {
            smallSeen = true;
            break;
          }
        }
        expect(smallSeen, "small-community stub report visible").toBe(true);
      },
    );
  } finally {
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

});
