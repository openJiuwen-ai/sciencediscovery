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
 * Purpose: After a knowledge base is seeded, the researcher reads any document through the three-level reader (L0 abstract / L1 anchored structure / L2 fulltext) and jumps from an entity evidence card to the highlighted source passage.
 * Steps:
 *   1. Create a knowledge base through the knowledge-engine page, register the journey extraction stub as the default model, seed from fixture replay, and wait for documents ready.
 *   2. Click a document row — the three-level reader opens at L0 with a deterministic summary and section tags.
 *   3. Switch to L1 — anchored blocks render with data-anchor ids plus a heading outline; switch to L2 — the full text renders.
 *   4. From the entity detail panel, click an evidence card's view-source action — the reader switches to L1 and highlights the block containing the verbatim quote (or honestly reports a miss).
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
// fixme (not a product bug): unskipped once the W7 reader is wired into
// KnowledgeEnginePage — blocked by the uncommitted W6 restyle of that file.
// Wiring contract this spec expects: document rows expose `ke-document-<docId>`
// buttons that open <KeDocumentReader>; entity evidence cards expose one
// `ke-evidence-source` button per quote that opens the reader with
// highlightQuote set. Node-click targeting and the stub evidence_quote
// (verbatim-in-fixture) are calibrated at wiring time — same as J-KE1's
// placeholder calibration note.
test.fixme("J-KE4 三级阅读与证据原文高亮", { tag: "@mocked" }, async ({ journey, page, playwright }) => {
  test.setTimeout(600_000);
  journey.scenario({
    goal: "知识库建成后，研究人员点开任意文档三级阅读（摘要/结构/原文），"
      + "并从实体证据卡一键跳到被高亮的原文出处。",
    preconditions: [
      "隔离栈以 fixture 模式启动（SCIENCE_AGENT_KE_SCHOLARLY_FIXTURE_DIR 指向 test/fixtures/scholarly），不出网",
      "浏览器已持有本实例的访问 token，语言为 zh-CN",
      "抽取管线模型由旅程注册的本地 stub 提供（evidence_quote 需逐字命中 fixture 全文，接线时校准）",
    ],
  });
  await page.addInitScript(() => window.localStorage.setItem("sciencediscovery-locale", "zh-CN"));

  const seedQuery = "Ebola virus glycoprotein antibody neutralization";
  const kbName = `J-KE4 知识库 ${Date.now()}`;
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
      "建库并播种（复用 J-KE1 引导）",
      "创建知识库、注册抽取 stub 为默认模型、发起种子并等待文档就绪（✓ 且无活跃任务）。",
      async () => {
        await page.goto("/");
        await page.getByTestId("open-knowledge-engine").click();
        await expect(page.getByTestId("knowledge-engine-page")).toBeVisible();
        await page.getByTestId("ke-new-kb-name").fill(kbName);
        await page.getByTestId("ke-create-kb").click();
        const kbItem = page.locator('[data-testid^="ke-kb-"]').filter({ hasText: kbName });
        await expect(kbItem).toBeVisible({ timeout: 30_000 });
        await kbItem.click();
        await page.getByTestId("ke-seed-query").fill(seedQuery);
        await page.getByTestId("ke-seed").click();
        await expect(page.getByTestId("ke-job-status").locator("[data-status]").first()).toBeVisible({ timeout: 30_000 });

        const api = page.request;
        const provider = await api.post(`${apiBaseUrl()}/api/providers`, {
          headers: authorizationHeader(),
          data: { name: `J-KE4 stub ${Date.now()}`, baseUrl: stub.baseUrl, apiToken: stub.apiToken },
        });
        expect(provider.ok()).toBeTruthy();
        providerId = ((await provider.json()) as { id: string }).id;
        const model = await api.post(`${apiBaseUrl()}/api/providers/${providerId}/models`, {
          headers: authorizationHeader(),
          data: { model: stub.model, label: `J-KE4 ${stub.model}` },
        });
        expect(model.ok()).toBeTruthy();
        modelId = ((await model.json()) as { id: string }).id;
        const settings = await api.put(`${apiBaseUrl()}/api/settings`, {
          headers: authorizationHeader(),
          data: { modelId },
        });
        expect(settings.ok()).toBeTruthy();

        await expect(page.getByTestId("ke-documents")).toContainText("✓", { timeout: 480_000 });
        await expect(page.getByTestId("ke-job-status").locator("[data-status='pending'],[data-status='running']")).toHaveCount(0, { timeout: 60_000 });
        await expect(page.getByTestId("ke-job-status").locator("[data-status='failed'],[data-status='dead']")).toHaveCount(0);
      },
    );

    await journey.step(
      "L0 摘要层",
      "点开第一篇就绪文档，阅读器默认落在 L0：确定性摘要非空、章节标签渲染。",
      async () => {
        await page.locator('[data-testid^="ke-document-"]').first().click();
        await expect(page.getByTestId("ke-doc-reader")).toBeVisible();
        await expect(page.getByTestId("ke-doc-level-L0")).toHaveAttribute("aria-selected", "true");
        await expect(page.getByTestId("ke-doc-summary")).not.toBeEmpty();
        await expect(page.getByTestId("ke-doc-tag").first()).toBeVisible();
      },
    );

    await journey.step(
      "L1 结构层与 L2 原文层",
      "切到 L1 看到带锚点的块与目录；切到 L2 看到全文。",
      async () => {
        await page.getByTestId("ke-doc-level-L1").click();
        await expect(page.getByTestId("ke-doc-blocks")).toBeVisible();
        await expect(page.locator('[data-testid="ke-doc-block"]').first()).toHaveAttribute(
          "data-anchor",
          /.+:(heading|paragraph|formula|table|list|figure|reference|code):\d+/,
        );
        await page.getByTestId("ke-doc-level-L2").click();
        await expect(page.getByTestId("ke-doc-fulltext")).not.toBeEmpty();
      },
    );

    await journey.step(
      "证据卡跳转原文高亮",
      "实体详情面板的证据卡点查看原文，阅读器回到 L1 并高亮包含逐字引文的块（未逐字命中时显示诚实提示）。",
      async () => {
        await page.getByTestId("ke-doc-close").click();
        await page.locator('[data-testid^="ke-kb-"]').filter({ hasText: kbName }).click();
        await expect(page.getByTestId("ke-graph-canvas")).toBeVisible({ timeout: 60_000 });
        // Selecting a node opens the bottom detail panel with evidence cards;
        // node-hit calibration happens at wiring time (cytoscape canvas).
        await page.locator('[data-testid="ke-graph-canvas"] canvas').first().click({ position: { x: 200, y: 120 } });
        await page.getByTestId("ke-evidence-source").first().click();
        await expect(page.getByTestId("ke-doc-reader")).toBeVisible();
        await expect(
          page.getByTestId("ke-doc-highlight").or(page.getByTestId("ke-doc-highlight-miss")),
        ).toBeVisible({ timeout: 30_000 });
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
