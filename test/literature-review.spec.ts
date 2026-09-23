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

import { expect, type Page, type TestInfo } from "@playwright/test";

import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { requireRealEnv, requireRealStack, test } from "./helpers/e2e.ts";
import { cleanupJourney, createProjectAndSession, openProjectSession, scriptedModel, sendUserMessage, waitForRunTerminal } from "./helpers/journeys.ts";

// Static suite metadata is inherited by each framework-expanded journey. This
// file mixes a live-model journey with a quarantined one, so `model` and
// `status` are declared per journey rather than here.
test.describe("literature-review.spec", { tag: ["@category:e2e", "@os:linux", "@arch:amd64", "@sandbox:bubblewrap"] }, () => {

// Screenshots land under the local e2e environment (cwd when run from .e2e/).
const SCREENSHOTS = "screenshots";

async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: `${SCREENSHOTS}/${name}.png`, fullPage: false });
}

async function waitForToast(page: Page, text: string | RegExp, opts?: { timeout?: number; state?: "visible" | "hidden" }) {
  const toast = page.locator("[role='status']").filter({ hasText: text });
  await toast.waitFor({ timeout: opts?.timeout ?? 10000, state: opts?.state ?? "visible" });
  return toast;
}

async function approvePermissionCardsWhileRunning(
  page: Page,
  timeout = 620000,
): Promise<{ kind: "completed" | "error"; message: string }> {
  const deadline = Date.now() + timeout;
  const cards = page.locator("section[aria-label='Permission cards']");
  const allow = cards.locator("article.permission-card button").filter({ hasText: "Allow" }).first();
  const requestError = page.locator("[role='status']").filter({ hasText: "Request error" });
  const sendButton = page.locator("button.send-button");

  while (Date.now() < deadline) {
    if (await requestError.isVisible().catch(() => false)) {
      return { kind: "error", message: (await requestError.textContent()) ?? "Request error" };
    }
    if ((await sendButton.textContent().catch(() => ""))?.includes("Run analysis")) {
      return { kind: "completed", message: "" };
    }
    if (await allow.isVisible().catch(() => false)) {
      const card = allow.locator("xpath=ancestor::article[contains(@class, 'permission-card')]");
      await card.getByLabel(/Grant scope/).selectOption("conversation");
      await expect(allow).toBeEnabled();
      await allow.click();
      await waitForToast(page, "Permission granted");
    } else {
      await page.waitForTimeout(250);
    }
  }
  throw new Error(`permission monitor exceeded ${timeout} ms`);
}

async function createProject(page: Page, name: string) {
  await page.getByRole("button", { name: "Add project" }).click();
  const dialog = page.getByRole("dialog", { name: "Create Project" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Project name").fill(name);
  await dialog.getByRole("button", { name: "Create Project" }).click();
  await waitForToast(page, "Project created");
  await expect(dialog).toBeHidden();
}

async function createSession(
  page: Page,
  name: string,
  opts: { connectorIds?: string[]; skillIds?: string[]; testInfo?: TestInfo } = {},
) {
  await page.getByRole("button", { name: "Add session" }).click();
  const dialog = page.getByRole("dialog", { name: "Create Session" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Session name").fill(name);

  if (opts.skillIds?.length) {
    await dialog.getByLabel("Skill settings mode").selectOption("override");
    for (const skillId of opts.skillIds) {
      const skillChoice = dialog.locator(".settings-choices label").filter({ hasText: skillId }).locator("input[type='checkbox']");
      if (opts.testInfo && await skillChoice.count() === 0) {
        opts.testInfo.skip(true, `BLOCKED: required seeded skill is unavailable (${skillId})`);
      }
      await skillChoice.check();
    }
  }

  if (opts.connectorIds?.length) {
    await dialog.getByLabel("Connector settings mode").selectOption("override");
    for (const connectorId of opts.connectorIds) {
      await dialog.locator(".settings-choices label").filter({ hasText: connectorId }).locator("input[type='checkbox']").check();
    }
  }

  await dialog.getByRole("button", { name: "Create Session" }).click();
  await waitForToast(page, "Session created");
  await expect(dialog).toBeHidden();
}

async function openWorkspace(page: Page) {
  await page.goto("/");
  // The visible assertion below is the wait. `networkidle` cannot be reached
  // once the workbench restores a Session and starts its pollers, and it stood
  // here only as a redundant prefix to it — see timeouts-runtime-status.spec.ts.
  await expect(page.getByText("ScienceDiscovery").first()).toBeVisible();
}

test.describe("Wave0+1 Linux Web literature review E2E", () => {
  /**
   * E2E-META
   * Purpose: The full literature-review journey works end to end: workspace
   *   loads, models are registered, a PubMed-backed evidence brief run
   *   completes with a canonical clickable citation.
   * Steps:
   *   1. Verify the workspace and the seeded model registry.
   *   2. Create a project and a session with the evidence-brief skill.
   *   3. Enable the PubMed connector, set plan to auto, pick the Flash model.
   *   4. Run a TP53 research prompt and wait for completion.
   *   5. Assert a canonical PubMed citation in the summary or artifact.
   * Environment: Running stack at E2E_BASE_URL whose model registry is seeded with
 *   working DeepSeek V4 Pro/Flash entries ("Key saved"); PubMed connector
   *   and life-science-evidence-brief skill available.
 * Type: real
   * LLM: Real turns through E2E_LLM_BASE_URL using E2E_LLM_MODEL.
   * WebSearch: None.
   * PaperSources: Live PubMed queries; results and rate limits vary.
   * MCP: PubMed connector exposed through the product's MCP flow.
   * OtherExternal: Local ScienceDiscovery API, gateway, browser UI, and runner.
   * Credentials: E2E_LLM_BASE_URL, E2E_LLM_MODEL, E2E_LLM_TOKEN; seeded model key.
   * CostSideEffects: Billable tokens, PubMed traffic, local projects/sessions, screenshots.
 */
  test("Linux Web工作台、模型配置与简单文献调研主路径", { tag: ["@real", "@model:real"] }, async ({ page }, testInfo) => {
    // The product allows progress-producing literature turns up to 600 s.
    // Keep the browser alive long enough to assert success or its explicit
    // product error instead of racing the application timeout.
    test.setTimeout(660000);
    requireRealEnv(testInfo, "E2E_LLM_BASE_URL", "E2E_LLM_MODEL", "E2E_LLM_TOKEN");
    await requireRealStack(testInfo);
    await openWorkspace(page);

    // 1. 确认 Linux Web 工作台可访问与模型已配置（已有历史项目时不假设空白落地页）
    await expect(page.locator(".app-shell")).toBeVisible();
    await expect(page.getByText("ScienceDiscovery").first()).toBeVisible();
    await screenshot(page, "01-landing");

    await page.getByRole("button", { name: "System configuration" }).click();
    const config = page.getByRole("dialog", { name: "System configuration" });
    await expect(config).toBeVisible();
    await config.getByRole("button", { name: "Model registry" }).click();
    const modelPro = config.getByText("DeepSeek V4 Pro");
    const modelFlash = config.getByText("DeepSeek V4 Flash");
    const savedKey = config.getByText("Key saved").first();
    if (await modelPro.count() === 0 || await modelFlash.count() === 0 || await savedKey.count() === 0) {
      testInfo.skip(true, "BLOCKED: model registry lacks seeded DeepSeek V4 Pro/Flash credentials");
    }
    await expect(modelPro).toBeVisible();
    await expect(modelFlash).toBeVisible();
    await expect(savedKey).toBeVisible();
    await screenshot(page, "02-model-registry");
    await config.getByRole("button", { name: "Done" }).click();
    await expect(config).toBeHidden();

    // 2. 创建 Project
    await createProject(page, `E2E Lit Review ${Date.now()}`);
    await screenshot(page, "03-project-created");

    // 3. 创建 Session，启用 life-science-evidence-brief skill
    await createSession(page, `Lit Review Session ${Date.now()}`, {
      skillIds: ["life-science-evidence-brief"],
      testInfo,
    });
    await screenshot(page, "04-session-created");

    // 4. 启用 PubMed connector（Domain loop 卡片）
    const pubMedConnector = page.locator("button.connector-card").filter({ hasText: "PubMed" });
    if (await pubMedConnector.count() === 0) {
      testInfo.skip(true, "BLOCKED: required seeded PubMed connector is unavailable");
    }
    await pubMedConnector.click();
    await expect(page.locator("button.connector-card.enabled").filter({ hasText: "PubMed" })).toBeVisible();
    await screenshot(page, "05-pubmed-enabled");

    // 为端到端自动跑通，将 plan 设置为自动接受，避免人工审批阻塞
    await page.getByLabel("Plan").selectOption("auto");
    // Use the configured low-latency profile for the live E2E. The Pro profile
    // remains covered by the registry assertion above, but is too slow for a
    // deterministic browser gate in this environment.
    await page.getByLabel("Model for this task").selectOption({ label: "DeepSeek V4 Flash · deepseek-v4-flash" });
    await screenshot(page, "05b-plan-auto");

    // 5. 发起文献调研主题提问
    const composer = page.locator(".composer textarea");
    await composer.fill("Research human TP53 and create a cited evidence brief.");
    await screenshot(page, "06-question-typed");
    const runButton = page.getByRole("button", { name: "Run analysis" });
    await expect(runButton).toBeInViewport();
    await runButton.click({ trial: true });
    const messageRequest = page.waitForRequest((request) => request.method() === "POST" && /\/api\/sessions\/[^/]+\/messages$/.test(request.url()));
    const messageResponse = page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/sessions\/[^/]+\/messages$/.test(response.url()));
    await runButton.click();
    const [submittedRequest, submittedResponse] = await Promise.all([messageRequest, messageResponse]);
    expect(submittedResponse.status(), `message run should start successfully: ${submittedRequest.url()}`).toBe(200);

    // 确认进入运行状态：运行中主按钮切换为可点的 Stop
    await expect(page.getByRole("button", { name: "Stop the current run" })).toBeVisible({ timeout: 20000 });
    await screenshot(page, "06b-running");

    // 等待真实 API、模型与 connector 链路完成；若外部模型超过产品
    // deadline，保留明确的 Request error，而不是让测试静默超时。
    const outcome = await approvePermissionCardsWhileRunning(page);
    expect(outcome.kind, `run ended with visible error: ${outcome.message}`).toBe("completed");
    const assistant = page.locator(".message.assistant").first();
    await expect(assistant).toBeVisible({ timeout: 30000 });
    await screenshot(page, "07-first-response");

    // 继续等待运行真正结束
    await expect(page.getByRole("button", { name: "Run analysis" })).toBeVisible({ timeout: 30000 });
    await screenshot(page, "08-run-completed");

    // 6. 验证总结与可核验引用
    const lastAssistant = page.locator(".message.assistant").last();
    const responseText = await lastAssistant.textContent() ?? "";
    expect(responseText.length).toBeGreaterThan(100);
    const sessionHasCanonicalCitation = /\[PMID:\d+\]\(https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/\d+\/\)/i.test(responseText);

    // Artifact is optional for Wave 1, but when the concise Session response
    // omits inline citations it must contain the canonical clickable evidence.
    const briefFile = page.locator("button.file-row").filter({ hasText: "evidence_brief.md" });
    await expect(briefFile.first()).toBeVisible({ timeout: 10000 }).catch(() => {
      // 如果没有生成文件，这是可接受的（取决于 backend 实现）
    });
    await screenshot(page, "09-evidence-brief-in-workspace");

    // 打开简报预览（如果文件存在）
    let artifactHasCanonicalCitation = false;
    if (await briefFile.first().isVisible().catch(() => false)) {
      await briefFile.first().click();
      const docPanel = page.getByRole("dialog", { name: /Rendered Markdown/ });
      await expect(docPanel).toBeVisible({ timeout: 10000 });
      artifactHasCanonicalCitation = await docPanel
        .locator("a[href^='https://pubmed.ncbi.nlm.nih.gov/']")
        .filter({ hasText: /^PMID:\d+$/i })
        .first()
        .isVisible()
        .catch(() => false);
      await screenshot(page, "10-evidence-brief-preview");
      await docPanel.getByRole("button", { name: "Close Markdown reader" }).click();
    }
    expect(
      sessionHasCanonicalCitation || artifactHasCanonicalCitation,
      "Session summary or evidence artifact should contain a canonical clickable PubMed citation",
    ).toBe(true);
  });

  /**
   * E2E-META
   * Purpose: A paper source whose connector is not enabled cannot be searched behind the user's back: the Agent's
   *   call to it fails visibly in the conversation, nothing is sent to the source, and once the user enables the
   *   connector in the Composer the next Run is given its tools.
   * Steps:
   *   1. Create a Project and Session with arXiv switched off in the Composer's connector picker.
   *   2. Ask for an arXiv search; the scripted model calls the arXiv tool anyway. The Run still completes, the tool
   *      call shows as failed, the model was never offered an arXiv tool, and no arXiv invocation was recorded.
   *   3. Enable arXiv in the connector picker and ask again: this Run is offered the arXiv tools.
   * Environment: Isolated local stack at E2E_BASE_URL with a journey-owned Project/Session.
   * Type: mocked
   * LLM: journey-owned OpenAI-compatible HTTP stub on 127.0.0.1, capturing the offered tool names.
   * WebSearch: None.
   * PaperSources: None — arXiv is never reached: disabled, its call fails locally; enabled, it is only offered.
   * MCP: arXiv connector's tool offering only.
   * OtherExternal: Local ScienceDiscovery API and browser UI only; non-local browser requests are aborted.
   * Credentials: E2E_API_TOKEN for the isolated local API only.
   * CostSideEffects: No external cost; the journey's Project and model are removed in finally.
   */
  test("Connector 未启用时的失败反馈", { tag: ["@mocked", "@model:mock"] }, async ({ journey, page }) => {
    test.setTimeout(180_000);
    await page.addInitScript(() => window.localStorage.setItem("sciencediscovery-locale", "zh-CN"));
    const stub = await scriptedModel([
      [{ tool: "mcp__arxiv__search", arguments: { query: "CRISPR TP53" } }, { text: "arXiv 连接器未启用，无法检索。请先在连接器中启用 arXiv。" }],
      [{ text: "arXiv 已可用。" }],
    ]);
    const fixture = await createProjectAndSession(page, {
      approvalMode: "always_allow",
      model: { apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: `Connector feedback ${Date.now()}` },
      projectName: `Connector feedback ${Date.now()}`,
      sessionTitle: "未启用的文献源",
    });
    journey.scenario({
      goal: "研究员请 Agent 检索一个没有启用的文献源时，能在对话里看到这次调用失败、知道要先启用它；启用之后下一次运行就能用。",
      preconditions: ["隔离栈已启动，本旅程独占 Project/Session", "模型是本机脚本桩，arXiv 不会被真正访问"],
    });
    const arxivChoice = page.locator(".connector-picker-popover").getByRole("checkbox", { name: /arXiv/ });
    const setArxiv = async (enabled: boolean) => {
      await page.locator(".connector-picker-trigger").click();
      await expect(arxivChoice).toBeVisible();
      if (await arxivChoice.isChecked() !== enabled) await arxivChoice.click();
      if (enabled) await expect(arxivChoice).toBeChecked();
      else await expect(arxivChoice).not.toBeChecked();
      await page.keyboard.press("Escape");
    };
    const offeredArxiv = (turn: number) => stub.calls.filter((call) => call.turn === turn)
      .flatMap((call) => call.offeredTools ?? []).filter((name) => name.startsWith("mcp__arxiv__"));
    try {
      await journey.step("在会话里关闭 arXiv", "Composer 的连接器选择里 arXiv 未勾选。", async () => {
        await openProjectSession(page, fixture);
        await setArxiv(false);
      });

      await journey.step("请 Agent 检索 arXiv", "运行正常结束；对 arXiv 的调用显示为失败，模型从未拿到 arXiv 工具，也没有任何 arXiv 调用记录。", async () => {
        const run = await sendUserMessage(page, fixture.session.id, "在 arXiv 上检索 CRISPR TP53 的论文。");
        expect((await waitForRunTerminal(page, fixture.session.id, run.id)).status).toBe("completed");
        expect(offeredArxiv(0)).toEqual([]);
        const failed = page.locator(".timeline-disclosure.tool.failed").filter({ hasText: /arxiv/i });
        await expect(failed).toHaveCount(1);
        await expect(failed.locator(":scope > summary")).toContainText("失败");
        await expect(page.getByText("arXiv 连接器未启用，无法检索。请先在连接器中启用 arXiv。", { exact: true }).first()).toBeVisible();
        const response = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture.session.id}/mcp/invocations`, { headers: authorizationHeader() });
        expect(response.ok()).toBe(true);
        const invocations = await response.json() as Array<{ sourceId?: string }>;
        expect(invocations.filter((invocation) => invocation.sourceId === "arxiv")).toEqual([]);
      });

      await journey.step("启用 arXiv 后再问一次", "勾选 arXiv 后，下一次运行的模型拿到了 arXiv 的工具。", async () => {
        await setArxiv(true);
        const run = await sendUserMessage(page, fixture.session.id, "现在可以用 arXiv 了吗？");
        expect((await waitForRunTerminal(page, fixture.session.id, run.id)).status).toBe("completed");
        expect(offeredArxiv(1)).toContain("mcp__arxiv__search");
      });
    } finally {
      await cleanupJourney(page, fixture);
      await stub.stop();
    }
  });
});

});
