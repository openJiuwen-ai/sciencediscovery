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
// Wiring contract (landed with W7): document rows are `ke-document-<docId>`
// buttons opening <KeDocumentReader>; each entity evidence card with a docId
// exposes a `ke-evidence-source` button opening it with highlightQuote set.
// The stub evidence_quote is calibrated VERBATIM against the recorded fixture
// corpus (first seed hit, arXiv 1901.02624 parsed by the same paper worker):
// it appears on one line of the parsed fulltext, so the provenance gate keeps
// the relation on that document and the reader highlights the exact block.
test("J-KE4 三级阅读与证据原文高亮", { tag: "@mocked" }, async ({ journey, page, playwright }) => {
  test.setTimeout(600_000);
  journey.scenario({
    goal: "知识库建成后，研究人员点开任意文档三级阅读（摘要/结构/原文），"
      + "并从实体证据卡一键跳到被高亮的原文出处。",
    preconditions: [
      "隔离栈以 fixture 模式启动（SCIENCE_AGENT_KE_SCHOLARLY_FIXTURE_DIR 指向 test/fixtures/scholarly），不出网",
      "浏览器已持有本实例的访问 token，语言为 zh-CN",
      "抽取管线模型由旅程注册的本地 stub 提供（evidence_quote 已对 fixture 语料逐字校准）",
    ],
  });
  await page.addInitScript(() => window.localStorage.setItem("sciencediscovery-locale", "zh-CN"));

  const seedQuery = "Ebola virus glycoprotein antibody neutralization";
  const kbName = `J-KE4 知识库 ${Date.now()}`;
  // Verbatim sentence from the parsed fulltext of the first seed hit
  // (arXiv 1901.02624, pdfplumber output) — see the note above the test.
  const evidenceQuote = "localized on the virus spike glycoprotein leading to neutralization of viral infection";
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
        evidence_quote: evidenceQuote,
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
        await expect(page.getByTestId("ke-job-status").locator("[data-status='pending'],[data-status='running']")).toHaveCount(0, { timeout: 180_000 });
        await expect(page.getByTestId("ke-job-status").locator("[data-status='failed'],[data-status='dead']")).toHaveCount(0);
      },
    );

    await journey.step(
      "L0 摘要层",
      "点开第一篇就绪文档（✓），阅读器默认落在 L0：确定性摘要非空、章节标签渲染。",
      async () => {
        await page.locator('[data-testid^="ke-document-"]').filter({ hasText: "✓" }).first().click();
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
      "实体详情面板的证据卡点查看原文，阅读器自动切到 L1 并高亮包含逐字引文的块。",
      async () => {
        await page.getByTestId("ke-doc-close").click();
        await page.locator('[data-testid^="ke-kb-"]').filter({ hasText: kbName }).click();
        await expect(
          page.getByTestId("ke-graph-canvas").or(page.getByTestId("ke-roots")),
        ).toBeVisible({ timeout: 60_000 });
        // Roots (community bubbles) may render first; the reader journey needs
        // the entity graph, so drill to the full view when it does.
        if (await page.getByTestId("ke-roots").isVisible().catch(() => false)) {
          await page.getByTestId("ke-breadcrumb-all").click();
          await expect(page.getByTestId("ke-graph-canvas")).toBeVisible({ timeout: 30_000 });
        }
        // Deterministic node tap through the canvas test hook (same as J-KE2)
        // — blind-clicking canvas pixels is flaky.
        await page.evaluate(() => {
          const cy = (window as unknown as { __keGraphCy?: { nodes(): { first(): { emit(e: string): void } } } }).__keGraphCy;
          cy?.nodes().first().emit("tap");
        });
        const detail = page.getByTestId("ke-entity-detail");
        await expect(detail).toBeVisible({ timeout: 30_000 });
        await page.getByTestId("ke-evidence-source").first().click();
        await expect(page.getByTestId("ke-doc-reader")).toBeVisible();
        // The reader auto-switches to L1 from any stored level and locates the
        // block with gate parity (verbatim substring OR ≥85% word overlap —
        // the same arms that admitted the evidence), so the highlight must
        // land; a total miss would be a real product bug.
        await expect(page.getByTestId("ke-doc-highlight")).toBeVisible({ timeout: 30_000 });
        await expect(page.getByTestId("ke-doc-highlight")).toContainText("glycoprotein");
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
