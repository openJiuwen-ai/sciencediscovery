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

// Static suite metadata is inherited by each framework-expanded journey.
test.describe("journey-ke-latex-ingest.spec", { tag: ["@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"] }, () => {

test.use({ locale: "zh-CN" });

/**
 * E2E-META
 * Purpose: A researcher seeds a knowledge base with an arXiv paper that ships LaTeX source and the pipeline ingests it through the LaTeX-first channel (not PDF text extraction), with the formulas and citation anchors preserved for the graph — entirely through the product UI.
 * Steps:
 *   1. Open the knowledge-engine page, create a knowledge base, and select it.
 *   2. Issue the phrase-quoted seed query "attention is all you need" through the seed panel and register the journey-owned extraction stub as the default model.
 *   3. Wait until the seed pipeline succeeds and the documents list shows the paper ready.
 *   4. Assert through the API that the document was ingested via the arxiv-latex channel.
 *   5. Open the three-level reader on the document and confirm the LaTeX-derived fulltext parses into anchored blocks (the L1 structure view renders).
 * Environment: Isolated local stack at E2E_BASE_URL started with SCIENCE_AGENT_KE_SCHOLARLY_FIXTURE_DIR pointing at test/fixtures/scholarly so all scholarly connectors replay local fixtures; zh-CN locale.
 * Type: mocked
 * LLM: journey-registered OpenAI-compatible HTTP stub on 127.0.0.1 returning a fixed extraction JSON whose evidence_quote is verbatim in the LaTeX-derived fulltext.
 * WebSearch: none
 * PaperSources: fixture replay only — arXiv phrase search (trimmed Atom feed with the single 1706.03762 entry), empty-result fixtures for europepmc/openalex/pubmed/semantic-scholar, the real gzip e-print tarball for 1706.03762, and a PDF-source e-print fallback body; un-recorded URLs fail loudly by design.
 * MCP: none
 * OtherExternal: none — non-local browser requests are aborted by the network guard.
 * Credentials: E2E_API_TOKEN for the isolated local API only; the stub token has no external access.
 * CostSideEffects: no external cost; knowledge-base records live inside the disposable isolated data dir.
 */
test("J-KE7 arXiv LaTeX 源走 LaTeX-first 摄取通道", { tag: "@mocked" }, async ({ journey, page, playwright }) => {
  test.setTimeout(900_000);
  journey.scenario({
    goal: "一位研究人员用带引号的短语种子查询引入一篇有 LaTeX 源的 arXiv 论文，"
      + "管线应当走 LaTeX-first 通道完成摄取（ingest_channel=arxiv-latex），"
      + "并且阅读器能把 LaTeX 转写的全文解析成带锚点的结构块。",
    preconditions: [
      "隔离栈以 fixture 模式启动（SCIENCE_AGENT_KE_SCHOLARLY_FIXTURE_DIR 指向 test/fixtures/scholarly），不出网",
      "fixture 覆盖：arXiv 短语查询（裁剪至 1706.03762 单条目）、四个空结果学术源、1706.03762 真实 gzip e-print tarball",
      "抽取管线模型由旅程注册的本地 stub 提供，stub 的 evidence_quote 与 LaTeX 转写全文逐字一致",
    ],
  });
  await page.addInitScript(() => window.localStorage.setItem("sciencediscovery-locale", "zh-CN"));

  // Quotes keep arXiv's word-OR search honest — the fixture feed was recorded
  // for the phrase query and contains only the target paper.
  const seedQuery = "\"attention is all you need\"";
  const kbName = `J-KE7 知识库 ${Date.now()}`;
  // The evidence quote is VERBATIM from texToMarkdown(extractCombinedTex(
  // .../e-print/1706.03762)) — the provenance gate (and the C3① validator)
  // would drop anything the LaTeX channel never produced.
  const stub = await kePipelineStub({
    entities: [
      { name: "Transformer", type: "method" },
      { name: "self-attention", type: "method" },
    ],
    relations: [
      {
        source: "Transformer",
        target: "self-attention",
        type: "uses",
        evidence_quote: "the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely",
      },
    ],
  });
  let providerId = "";
  let modelId = "";

  try {
    await journey.step(
      "打开知识引擎页并建库",
      "工作台导航进入知识引擎页，新建知识库并选中，种子面板出现。",
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
      "发起短语种子查询",
      "填入带引号的种子查询点 Seed，任务进入排队/运行态。",
      async () => {
        await page.getByTestId("ke-seed-query").fill(seedQuery);
        await page.getByTestId("ke-seed").click();
        await expect(page.getByTestId("ke-job-status").locator("[data-status]").first()).toBeVisible({ timeout: 30_000 });
      },
    );

    await journey.step(
      "注册抽取 stub 为默认模型",
      "通过设置 API 注册本地 stub 服务商与模型并设为默认，使抽取管线有非 agent LLM 可调。",
      async () => {
        const api = page.request;
        const provider = await api.post(`${apiBaseUrl()}/api/providers`, {
          headers: authorizationHeader(),
          data: { name: `J-KE7 stub ${Date.now()}`, baseUrl: stub.baseUrl, apiToken: stub.apiToken },
        });
        expect(provider.ok()).toBeTruthy();
        providerId = (await provider.json() as { id: string }).id;
        const model = await api.post(`${apiBaseUrl()}/api/providers/${providerId}/models`, {
          headers: authorizationHeader(),
          data: { model: stub.model, label: `J-KE7 ${stub.model}` },
        });
        expect(model.ok()).toBeTruthy();
        modelId = (await model.json() as { id: string }).id;
        const settings = await api.put(`${apiBaseUrl()}/api/settings`, {
          headers: authorizationHeader(),
          data: { modelId },
        });
        expect(settings.ok()).toBeTruthy();
      },
    );

    let docId = "";
    await journey.step(
      "等待 LaTeX 摄取完成",
      "ke-job-status 无失败/死信，ke-documents 列出就绪文档；API 侧确认 ingest_channel=arxiv-latex。",
      async () => {
        await expect(page.getByTestId("ke-documents")).toContainText("✓", { timeout: 600_000 });
        await expect(page.getByTestId("ke-job-status").locator("[data-status='pending'], [data-status='running']")).toHaveCount(0, { timeout: 180_000 });
        await expect(page.getByTestId("ke-job-status").locator("[data-status='failed'], [data-status='dead']")).toHaveCount(0);
        // API walk: list all KBs, find ours, then its documents.
        const kbs = await page.request.get(`${apiBaseUrl()}/api/knowledge-engine/kbs`, {
          headers: authorizationHeader(),
        });
        expect(kbs.ok()).toBeTruthy();
        const kbList = (await kbs.json() as { kbs: Array<{ id: string; name: string }> }).kbs;
        const kb = kbList.find((entry) => entry.name === kbName);
        expect(kb, "created KB must be listed").toBeTruthy();
        const docs = await page.request.get(`${apiBaseUrl()}/api/knowledge-engine/kbs/${kb!.id}/documents`, {
          headers: authorizationHeader(),
        });
        expect(docs.ok()).toBeTruthy();
        const docList = (await docs.json() as {
          documents: Array<{ id: string; title: string | null; status: string; ingestChannel: string | null }>;
        }).documents;
        const paper = docList.find((entry) => (entry.title ?? "").includes("Attention Is All You Need"));
        expect(paper, "the seeded arXiv paper must be ingested").toBeTruthy();
        expect(paper!.status).toBe("ready");
        // The whole point of J-KE7: the LaTeX channel, not PDF extraction.
        expect(paper!.ingestChannel).toBe("arxiv-latex");
        docId = paper!.id;
      },
    );

    await journey.step(
      "阅读器解析 LaTeX 转写全文",
      "点文档行的查看按钮打开三级阅读器（默认 L0 摘要），切到 L1 后结构块渲染出 TeX 转写的锚点块。",
      async () => {
        await page.getByTestId(`ke-document-${docId}`).click();
        await expect(page.getByTestId("ke-doc-reader")).toBeVisible({ timeout: 30_000 });
        // The reader opens on the deterministic L0 summary — itself derived
        // from the LaTeX channel's markdown (tags from the paper outline).
        await expect(page.getByTestId("ke-doc-summary")).toBeVisible({ timeout: 30_000 });
        // Switch to L1: the structure level must have parsed the LaTeX-derived
        // fulltext into anchored blocks.
        await page.getByTestId("ke-doc-level-L1").click();
        await expect(page.getByTestId("ke-doc-blocks").locator("[data-testid^='ke-doc-block']").first()).toBeVisible({ timeout: 30_000 });
        await page.getByTestId("ke-doc-close").click();
      },
    );
  } finally {
    // Same cleanup discipline as J-KE1: the stub provider/model/default must
    // not leak into journeys sharing this stack.
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
