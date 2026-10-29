// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");

import type { ArtifactReviewRun, ReviewerSkipReason } from "@sciencediscovery/schema";
import { expect } from "@playwright/test";

import { test } from "./helpers/e2e.ts";
import { cleanupJourney, createProjectAndSession, openProjectSession } from "./helpers/journeys.ts";

// Static suite metadata is inherited by each framework-expanded journey.
test.describe("journey-reviewer-result-matrix.spec", { tag: ["@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"] }, () => {

type Case = { checkpoint: "completed" | "failed" | "skipped"; toolCallId: string; review?: ArtifactReviewRun; skipReason?: ReviewerSkipReason };

function review(toolCallId: string, overrides: Partial<ArtifactReviewRun> = {}): ArtifactReviewRun {
  return {
    artifactContentHash: "a".repeat(64), artifactId: `artifact-${toolCallId}`, artifactLogicalName: `${toolCallId}.md`,
    artifactVersionId: `version-${toolCallId}`, checkpointId: `checkpoint-${toolCallId}`, createdAt: "2026-09-16T00:00:00.000Z",
    decision: "ACCEPT_AND_PROCEED", findings: [], finishedAt: "2026-09-16T00:00:01.000Z", id: `review-${toolCallId}`,
    reviewerSpecialistVersion: "mock-matrix", sessionId: "", status: "completed", toolCallId, ...overrides,
  };
}

/**
 * E2E-META
 * Purpose: A researcher can distinguish Quick and Deep review outcomes without operational source failures being presented as report defects.
 * Steps:
 *   1. Open an isolated Session containing a controlled matrix of read-only review records.
 *   2. Inspect Quick pass, warning and critical outcomes.
 *   3. Inspect Deep contradiction, inconclusive downgrade and failed checkpoint outcomes.
 *   4. Distinguish skipped capability opt-outs from actual review outcomes, including after refresh.
 * Environment: Isolated local API/Runner; browser routes only the read-only Session and Artifact-review responses to deterministic fixtures.
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — non-local browser requests are aborted.
 * Credentials: E2E_API_TOKEN
 * CostSideEffects: Creates and deletes one isolated Project/Session; no external calls.
 */
test("研究员可区分 Quick 与 Deep 审核结果矩阵", { tag: "@mocked" }, async ({ journey, page }) => {
  journey.scenario({
    goal: "研究员在同一会话中核对 Quick/Deep 的通过、告警、矛盾、降级与失败展示。",
    preconditions: ["隔离 API 与 Runner 已启动", "只读审核记录由浏览器 mock 固定，不访问模型或外部来源"],
  });
  const fixture = await createProjectAndSession(page, { projectName: `Reviewer matrix ${Date.now()}`, sessionTitle: "审核结果矩阵" });
  const cases: Case[] = [
    // A genuine Quick pass: the citation checks passed and the task's declared
    // deliverable is present, so the card may say "Citation-format checks passed".
    { checkpoint: "completed", toolCallId: "quick-pass", review: review("quick-pass", { checks: ["citation", "completeness"], completeness: { required: [{ path: "report.md", state: "present" }], source: "brief", status: "complete" }, reviewLevel: "quick" }) },
    // The same checks without any delivery verdict: a citation pass must not be
    // presented as an overall pass, so this one must read "delivery not verified".
    { checkpoint: "completed", toolCallId: "quick-unverified", review: review("quick-unverified", { checks: ["citation"], reviewLevel: "quick" }) },
    { checkpoint: "completed", toolCallId: "quick-warning", review: review("quick-warning", { decision: "REVISE_AND_RETRY", findings: [{ code: "CITATION_IDENTIFIER_MISSING", evidenceRefs: [], id: "warning", message: "缺少可识别的引文标识符。", severity: "warning", status: "open" }], reviewLevel: "quick" }) },
    { checkpoint: "completed", toolCallId: "deep-contradiction", review: review("deep-contradiction", { findings: [{ code: "COMPUTATION_EVIDENCE_VALUE_MISMATCH", evidenceRefs: [], id: "mismatch", message: "锁定 Evidence 与报告数值不一致。", severity: "critical", status: "open" }], reviewLevel: "deep", sourceAssessments: [{ assessment: { assessment: "CONTRADICTED", claimId: "claim", locatorIds: ["locator"], policyVersion: "1", rationale: "锁定数值不一致。" }, claim: { artifactVersionId: "version-deep-contradiction", citationKeys: [], id: "claim", kind: "computation", requiredEvidenceLevel: "E4", text: "Response was 42%." }, locators: [], snapshots: [] }] }) },
    { checkpoint: "completed", toolCallId: "deep-inconclusive", review: review("deep-inconclusive", { reviewLevel: "deep", smartDetail: { code: "SMART_CITATION_INCONCLUSIVE", message: "Paper Reader timeout" }, smartStatus: "inconclusive" }) },
    { checkpoint: "failed", toolCallId: "deep-failed" },
    { checkpoint: "skipped", toolCallId: "automatic-review:global-off", skipReason: "specialist_disabled" },
    { checkpoint: "skipped", toolCallId: "automatic-review:session-off", skipReason: "automatic_review_disabled" },
  ];
  const sessionPath = `**/api/sessions/${fixture.session.id}`;
  await page.route(sessionPath, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const detail = await response.json() as { messages: unknown[] };
    await route.fulfill({ response, json: { ...detail, messages: [...detail.messages, ...cases.map((item) => ({ content: "Reviewer Specialist review", createdAt: "2026-09-16T00:00:00.000Z", id: `checkpoint-${item.toolCallId}`, kind: "reviewer_checkpoint", reviewerCheckpoint: { ...(item.checkpoint === "failed" ? { error: "来源核验未完成" } : {}), status: item.checkpoint, skipReason: item.skipReason, toolCallId: item.toolCallId }, role: "assistant" }))] } });
  });
  await page.route(`**/api/sessions/${fixture.session.id}/artifact-reviews`, (route) => route.fulfill({ json: cases.flatMap((item) => item.review ? [{ ...item.review, sessionId: fixture.session.id }] : []) }));
  try {
    await journey.step("进入带有审核记录的会话", "时间线显示六条只读审核记录和两条未执行的中性跳过记录。", async () => {
      await openProjectSession(page, fixture);
      await expect(page.locator(".reviewer-specialist-panel")).toHaveCount(8);
    });
    await journey.step("核对 Quick 的通过与告警", "仅检查引用格式的 Quick 项会说明结论支撑未检查；没有交付结论时必须显示未验证而不是通过；缺引用标识符显示告警。", async () => {
      const quickPass = page.locator(".reviewer-specialist-panel").filter({ hasText: "quick-pass.md" });
      await expect(quickPass).toContainText("Citation-format checks passed");
      await expect(quickPass).toContainText("claim support was not checked");
      await expect(page.locator(".reviewer-specialist-panel").filter({ hasText: "quick-warning.md" })).toContainText("Citation identifier missing");
      // Nothing verified delivery here, so the card says so and never claims a pass.
      const quickUnverified = page.locator(".reviewer-specialist-panel").filter({ hasText: "quick-unverified.md" });
      await expect(quickUnverified).toContainText("Checks passed; delivery not verified");
      await expect(quickUnverified).not.toContainText("Quick review passed");
    });
    await journey.step("核对 Deep 的矛盾、降级与失败", "数值矛盾可见；来源降级不伪装成报告缺陷；失败项保留失败状态。", async () => {
      const all = page.locator(".reviewer-specialist-panel");
      await expect(all.filter({ hasText: "deep-contradiction.md" })).toContainText("Computation contradiction");
      await expect(all.filter({ hasText: "deep-inconclusive.md" })).not.toContainText("Paper Reader timeout");
      await expect(all.filter({ hasText: "Review incomplete" })).toContainText("Review failed");
    });
    await journey.step("区分未执行与审查结果", "两个关闭原因均显示中性已跳过，不声称通过、完成或失败；刷新后保持一致。", async () => {
      const skipped = page.locator(".reviewer-specialist-panel").filter({ hasText: "Review skipped" });
      await expect(skipped).toHaveCount(2);
      for (let index = 0; index < 2; index++) {
        await expect(skipped.nth(index)).not.toHaveClass(/failed|running/);
        await expect(skipped.nth(index)).not.toContainText(/review passed|Review completed|Review failed/);
        await skipped.nth(index).locator("summary").click();
        await expect(skipped.nth(index).locator(".reviewer-specialist-results")).toContainText("No review result was produced.");
      }
      await expect(skipped.filter({ hasText: "off in System configuration" })).toHaveCount(1);
      await expect(skipped.filter({ hasText: "turned off for this session" })).toHaveCount(1);
      await page.reload();
      await expect(skipped).toHaveCount(2);
      await expect(skipped.first().locator("strong").first()).toContainText("Review skipped");
    });
  } finally { await cleanupJourney(page, fixture); }
});

});
