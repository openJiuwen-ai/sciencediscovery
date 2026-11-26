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

/**
 * The Reviewer Specialist on screen: the checkpoint card in the transcript,
 * the two settings layers, and the artifact dialog's 审查 tab.
 *
 * The backend is mocked, so what these cases prove is the reading, not the
 * review: which review lands under which checkpoint, what each verdict colour
 * means, and that a re-run names the checkpoint message the server accepts.
 * The five verdict cases are separate on purpose — the acceptance criterion
 * "structure-only is green" is a claim about *why* green is allowed, and a
 * combined fixture could pass while that reason changed.
 *
 * The outcome-matrix case is the desktop reading of the web journey
 * `journey-reviewer-result-matrix.spec.ts`: same eight checkpoints, same
 * distinctions. What is not ported is the half of the web journeys that
 * asserts the service — a coordinator scheduling an audit, feedback being
 * consumed, records staying byte-identical across a skip. Those run against
 * the real stack and cannot be reached from this file's page-level mock.
 */
/**
 * E2E-META
 * Purpose: Exercise reviewer cards, review settings and artifact review actions in the Desktop UI.
 * Steps:
 *   1. Open a mocked session containing reviewer checkpoints and verdicts.
 *   2. Inspect verdict cards, settings controls and artifact review actions.
 * Environment: Isolated Desktop Vite app with deterministic local API mocks.
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none
 * Credentials: fixture access token only
 * CostSideEffects: isolated browser state only
 */
import { expect, test } from "@playwright/test";

import {
  TOKEN,
  TOKEN_STORAGE_KEY,
  installMockApi,
  makeSession,
  type JsonRecord,
} from "./fixtures.js";

const SESSION = "session-1";
const AT = "2026-10-01T09:00:00.000Z";

/** The transcript anchor a review is joined to. */
function checkpointMessage(id: string, toolCallId: string): JsonRecord {
  return {
    content: "",
    createdAt: AT,
    id,
    kind: "reviewer_checkpoint",
    reviewerCheckpoint: { status: "completed", toolCallId },
    role: "assistant",
  };
}

/** A checkpoint that produced no verdict, for one of the server's reasons. */
function unusedCheckpoint(id: string, toolCallId: string, over: JsonRecord): JsonRecord {
  return {
    content: "",
    createdAt: AT,
    id,
    kind: "reviewer_checkpoint",
    reviewerCheckpoint: { toolCallId, ...over },
    role: "assistant",
  };
}

/** A review that found nothing and confirmed delivery. */
function review(over: JsonRecord = {}): JsonRecord {
  return {
    artifactContentHash: "sha256:report",
    artifactId: "artifact-report",
    artifactLogicalName: "report.md",
    artifactVersionId: "version-1",
    checkpointId: "checkpoint-1",
    checks: ["structure", "citation", "completeness"],
    completeness: {
      required: [{ path: "output/report.md", state: "present" }],
      source: "brief",
      status: "complete",
    },
    createdAt: AT,
    decision: "ACCEPT_AND_PROCEED",
    findings: [],
    finishedAt: AT,
    id: "review-1",
    reviewLevel: "quick",
    reviewerSpecialistVersion: "1",
    sessionId: SESSION,
    status: "completed",
    toolCallId: "call-1",
    ...over,
  };
}

/** One artifact and one of its versions, in the shape the API answers with. */
function output(
  artifactId: string,
  name: string,
  versionId: string,
  over: { kind?: string; mediaType?: string; references?: JsonRecord[] } = {},
): JsonRecord {
  return {
    artifact: {
      createdAt: AT,
      createdInSessionId: SESSION,
      createdInSessionTitle: "晶体结构分析",
      currentVersion: 1,
      id: artifactId,
      kind: over.kind ?? "markdown",
      logicalName: name,
      name,
      origin: "run",
      projectId: "project-1",
      sessionId: SESSION,
      updatedAt: AT,
    },
    version: {
      artifactId,
      content: { hash: `sha256:${artifactId}`, size: 18 },
      createdAt: AT,
      executionRunIds: [],
      id: versionId,
      inputArtifactVersionIds: [],
      mediaType: over.mediaType ?? "text/markdown",
      projectId: "project-1",
      references: over.references,
      sessionId: SESSION,
      sourcePath: `/runs/one/${name}`,
      version: 1,
    },
  };
}

const REPORT_OUTPUT = output("artifact-report", "report.md", "version-1");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [TOKEN_STORAGE_KEY, TOKEN] as const,
  );
});

test("a confirmed delivery is green, and its checks are one press away", async ({ page }) => {
  await installMockApi(page, {
    reviewer: { reviews: [review()] },
    sessions: [makeSession({ messages: [checkpointMessage("message-checkpoint-1", "call-1")] })],
  });
  await page.goto("/");

  // The review is joined to its checkpoint by tool call id, so it is drawn
  // under that turn rather than at the end of the session.
  const card = page.locator(".review-card");
  await expect(card).toHaveClass(/is-pass/u);
  await expect(card.locator(".review-title")).toHaveText("审查");
  await expect(card.locator(".review-summary")).toHaveText("未发现问题");
  await expect(card.locator(".review-count")).toHaveText("3 项检查");

  await card.locator(".review-head").click();
  const rows = card.locator(".review-item");
  // The completeness verdict answers for delivery; the two checks that ran
  // are the rows below it, and the third is not repeated.
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).locator(".review-item-title")).toHaveText("交付完整");
  await expect(rows.nth(1).locator(".review-item-title")).toHaveText("结构检查通过");
  await expect(rows.nth(2).locator(".review-item-title")).toHaveText("引用检查通过");
  await expect(rows.nth(0).locator(".review-pill")).toHaveText("快速");
  // Its own section names the file: the card's header reports the worst
  // artifact, so the file in hand has no other place to say which it is.
  await expect(card.locator(".review-artifact-name")).toHaveText("report.md");
  await expect(card.locator(".review-artifact")).toHaveClass(/is-framed/u);
});

test("a checkpoint over two artifacts names both, in separate sections", async ({ page }) => {
  await installMockApi(page, {
    reviewer: {
      reviews: [
        review(),
        review({
          artifactId: "artifact-appendix",
          artifactLogicalName: "appendix.md",
          completeness: undefined,
          decision: "REVISE_AND_RETRY",
          findings: [{
            code: "CITATION_UNCITED_CLAIM",
            evidenceRefs: [],
            id: "finding-appendix",
            message: "§2 的结论没有引用。",
            severity: "warning",
            status: "open",
          }],
          id: "review-2",
          stale: true,
        }),
      ],
    },
    sessions: [makeSession({ messages: [checkpointMessage("message-checkpoint-1", "call-1")] })],
  });
  await page.goto("/");

  const card = page.locator(".review-card");
  // The header answers for the worse of the two, and counts the other one:
  // a superseded verdict is history (amber), which is what the header says.
  await expect(card).toHaveClass(/is-warn/u);
  await expect(card.locator(".review-count").first()).toHaveText("1 通过 · 1 需处理");
  await card.locator(".review-head").click();

  const sections = card.locator(".review-artifact");
  await expect(sections).toHaveCount(2);
  await expect(sections.nth(0).locator(".review-artifact-name")).toHaveText("report.md");
  await expect(sections.nth(1).locator(".review-artifact-name")).toHaveText("appendix.md");
  // Each section carries its own verdict, not the card's: the passing file
  // behind a failing one still has to read as a pass.
  await expect(sections.nth(0).locator(".review-artifact-verdict")).toHaveText("未发现问题");
  await expect(sections.nth(1).locator(".review-artifact-verdict")).toHaveText("1 个提醒（已过期）");
  await expect(sections.nth(0)).toHaveClass(/is-pass/u);
  await expect(sections.nth(1)).toHaveClass(/is-warn/u);
});

test("a review that never verified delivery is grey, not green", async ({ page }) => {
  await installMockApi(page, {
    reviewer: {
      // No recorded delivery verdict, and checks that were never
      // structure-only: nothing in this review claims the delivery was seen.
      reviews: [review({ checks: ["structure", "citation"], completeness: undefined })],
    },
    sessions: [makeSession({ messages: [checkpointMessage("message-checkpoint-1", "call-1")] })],
  });
  await page.goto("/");

  const card = page.locator(".review-card");
  // Not a finding, and not a pass: the summary says the delivery was never
  // verified, and the colour stays the one "nothing was found" uses.
  await expect(card).toHaveClass(/is-neutral/u);
  await expect(card.locator(".review-summary")).toHaveText("未验证交付");
});

test("a structure-only review is green because it never claimed delivery", async ({ page }) => {
  await installMockApi(page, {
    reviewer: {
      reviews: [review({ checks: ["structure"], completeness: undefined })],
    },
    sessions: [makeSession({ messages: [checkpointMessage("message-checkpoint-1", "call-1")] })],
  });
  await page.goto("/");

  const card = page.locator(".review-card");
  await expect(card).toHaveClass(/is-pass/u);
  await expect(card.locator(".review-summary")).toHaveText("未发现问题");
  await expect(card.locator(".review-summary")).not.toHaveText("未验证交付");
});

test("a delivery that was checked and found incomplete is red", async ({ page }) => {
  await installMockApi(page, {
    reviewer: {
      reviews: [review({
        completeness: {
          required: [{ path: "output/predictions.npy", state: "missing" }],
          source: "brief",
          status: "incomplete",
        },
        decision: "REVISE_AND_RETRY",
        findings: [{
          code: "DELIVERABLE_MISSING",
          evidenceRefs: [],
          id: "finding-delivery",
          message: "output/predictions.npy is required",
          severity: "critical",
          status: "open",
        }],
      })],
    },
    sessions: [makeSession({ messages: [checkpointMessage("message-checkpoint-1", "call-1")] })],
  });
  await page.goto("/");

  const card = page.locator(".review-card");
  await expect(card).toHaveClass(/is-fail/u);
  await expect(card.locator(".review-summary")).toHaveText("交付不完整");

  await card.locator(".review-head").click();
  const missing = card.locator(".review-item.is-fail").first();
  await expect(missing).toContainText("output/predictions.npy");
});

test("a verdict on a replaced version says it is history, and offers a re-run", async ({ page }) => {
  await installMockApi(page, {
    reviewer: { reviews: [review({ stale: true })] },
    sessions: [makeSession({ messages: [checkpointMessage("message-checkpoint-1", "call-1")] })],
  });
  await page.goto("/");

  const card = page.locator(".review-card");
  await expect(card).toHaveClass(/is-warn/u);
  await expect(card.locator(".review-summary")).toHaveText("未发现问题（已过期）");

  await card.locator(".review-head").click();
  await expect(card.locator(".review-banner.is-stale")).toContainText("产物已有新版本");
  await expect(card.locator(".review-rerun")).toBeVisible();
});

test("the built-in Review Specialist is always listed and carries no switch", async ({ page }) => {
  const mock = await installMockApi(page, { sessions: [] });
  await page.goto("/");

  const openSpecialists = async () => {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByTitle("可复用的指令与工具组合").click();
    return dialog;
  };

  const dialog = await openSpecialists();
  const builtIn = dialog.getByTestId("built-in-reviewer");
  // The card names the specialist and says what uses it — nothing else. It is
  // part of the application, like the reference client's built-in row, so the
  // page offers no way to switch it off.
  await expect(builtIn).toContainText("审查");
  await expect(builtIn).toContainText("由自动审阅使用");
  await expect(builtIn.getByRole("switch")).toHaveCount(0);
  await expect(builtIn.locator("button")).toHaveCount(0);
  expect(
    mock.calls.some((call) => call.path === "/api/reviewer-specialist/settings" && call.method === "PUT"),
  ).toBe(false);

  await page.keyboard.press("Escape");
  await page.reload();

  // It is the application's, not the server's list: it is still there after a
  // reload, with no switch added once the list has been read again.
  const reopened = await openSpecialists();
  const again = reopened.getByTestId("built-in-reviewer");
  await expect(again).toContainText("由自动审阅使用");
  await expect(again.getByRole("switch")).toHaveCount(0);
});

test("the session's automatic review and level are written and survive a reload", async ({ page }) => {
  const mock = await installMockApi(page, { sessions: [makeSession()] });
  await page.goto("/");
  await expect(page.locator(".side-session-name", { hasText: "晶体结构分析" })).toBeVisible();

  const openSessionMenu = async () => {
    await page.getByRole("button", { name: "会话设置" }).click();
    return page.locator(".session-menu");
  };

  let menu = await openSessionMenu();
  // With the master switch on, the session layer speaks for itself and needs
  // no explanation.
  await expect(menu.locator(".session-menu-note")).toHaveCount(0);
  // Deep is a choice behind the level row; the switch above it has one value.
  await menu.getByRole("button", { name: "审查档位" }).click();
  // Both levels are named in the interface language, and the row already
  // shows the current one.
  await expect(page.locator(".session-flyout-row .session-flyout-label"))
    .toHaveText(["快速", "深度"]);
  await expect(menu.getByRole("button", { name: "审查档位" })).toContainText("快速");
  await page.locator(".session-flyout-row", { hasText: "深度" }).click();
  await expect
    .poll(() => mock.state.reviewer.sessionSettings[SESSION]?.level)
    .toBe("deep");
  menu = await openSessionMenu();
  await expect(menu.getByRole("button", { name: "审查档位" })).toContainText("深度");

  const automatic = menu.getByRole("switch", { name: "自动审阅" });
  await expect(automatic).toHaveAttribute("aria-checked", "true");
  await automatic.click();
  await expect(automatic).toHaveAttribute("aria-checked", "false");
  // Automatic review off does not make the level idle: 立即审查 reads it too,
  // so the row stays open and says why it still matters.
  await expect(menu.getByRole("button", { name: "审查档位" })).toBeEnabled();
  await expect(menu.getByRole("button", { name: "审查档位" }))
    .toHaveAttribute("title", "自动审阅已关闭；立即审查仍会使用这个档位。");
  await expect
    .poll(() => mock.state.reviewer.sessionSettings[SESSION]?.automaticReviewEnabled)
    .toBe(false);

  await page.reload();
  await expect(page.locator(".side-session-name", { hasText: "晶体结构分析" })).toBeVisible();
  menu = await openSessionMenu();
  await expect(menu.getByRole("switch", { name: "自动审阅" })).toHaveAttribute("aria-checked", "false");
});

test("会话设置 asks for a review now, and automatic review being off does not stop it", async ({ page }) => {
  const mock = await installMockApi(page, {
    reviewer: {
      sessionSettings: { [SESSION]: { automaticReviewEnabled: false, level: "quick" } },
    },
    sessions: [makeSession()],
  });
  await page.goto("/");

  await page.getByRole("button", { name: "会话设置" }).click();
  const menu = page.locator(".session-menu");
  // 自动审阅 decides whether a review happens by itself; this row is the
  // reader asking for one, so the switch being off leaves it enabled — and so
  // does the level row, because a manual run still reads the level.
  await expect(menu.getByRole("button", { name: "审查档位" })).toBeEnabled();
  // Ask for Deep before asking for a review: the coordinator takes the level
  // from the Session, so the task it queues has to say deep.
  await menu.getByRole("button", { name: "审查档位" }).click();
  await page.locator(".session-flyout-row", { hasText: "深度" }).click();
  await expect.poll(() => mock.state.reviewer.sessionSettings[SESSION]?.level).toBe("deep");

  // The flyout closes the menu; the action row is one press away again.
  await page.getByRole("button", { name: "会话设置" }).click();
  const run = page.locator(".session-menu").getByRole("button", { name: "立即审查" });
  await expect(run).toBeEnabled();

  await run.click();
  await expect(page.locator(".toast.toast-info")).toContainText("已开始审查。");
  // The request names a fresh message id: the coordinator appends the
  // checkpoint under that id, so a re-used one would overwrite an older card.
  await expect.poll(() => mock.state.reviewer.tasks.length).toBe(1);
  const queued = mock.state.reviewer.tasks[0] as { checkpointMessageId?: string; origin?: string; reviewLevel?: string };
  expect(queued.origin).toBe("manual");
  expect(queued.reviewLevel).toBe("deep");
  expect(queued.checkpointMessageId).toMatch(/^[0-9a-f-]{36}$/u);

  // The click leaves a card where the review happened rather than only a
  // toast: the written checkpoint is drawn at once, and the coordinator's own
  // copy of it replaces it when the queue empties (the mock's run produces no
  // review record, so what settles is the empty verdict).
  await expect(page.getByTestId("review-card-running")).toBeVisible();
  // The queue is read on a 6s tick, which is what ends the run here.
  await expect(page.getByTestId("review-card"))
    .toContainText("这个检查点没有产生审查记录。", { timeout: 15_000 });
});

test("a review already under way is stopped from the same row", async ({ page }) => {
  await installMockApi(page, {
    reviewer: {
      // Queued in the coordinator: the row has something to stop.
      tasks: [{
        artifactVersionIds: [],
        checkpointMessageId: "message-checkpoint-1",
        createdAt: AT,
        feedbackPolicy: "record",
        id: "task-manual-1",
        inputFingerprint: "manual",
        origin: "manual",
        reviewLevel: "quick",
        sessionId: SESSION,
        status: "running",
        toolCallId: "call-1",
      }],
    },
    sessions: [makeSession({ messages: [checkpointMessage("message-checkpoint-1", "call-1")] })],
  });
  await page.goto("/");

  await page.getByRole("button", { name: "会话设置" }).click();
  const menu = page.locator(".session-menu");
  await expect(menu.getByRole("button", { name: "立即审查" })).toHaveCount(0);
  await menu.getByRole("button", { name: "停止审查" }).click();

  await expect(page.locator(".toast.toast-info")).toContainText("已停止审查。");
});

test("the artifact dialog's 审查 tab shows the version's verdict and can queue a re-run", async ({ page }) => {
  const report = output(
    "artifact-report",
    "report.md",
    "version-1",
  );
  const main = output("artifact-main", "main.md", "main-version-1", {
    references: [{ id: "artifact-report", kind: "artifact", label: "artifact1", version: 1 }],
  });
  const mock = await installMockApi(page, {
    artifactContents: {
      "main-version-1": "# 汇总\n\n结论见 [artifact1]。\n",
      "version-1": "# 报告\n\n晶格常数是 5.43 Å。\n",
    },
    artifactsBySession: { [SESSION]: [main, report] },
    artifactVersions: {
      [`${SESSION}|artifact-main`]: [main.version],
      [`${SESSION}|artifact-report`]: [report.version],
    },
    reviewer: {
      // The version on screen is no longer the current one: the verdict is
      // history, which is exactly the case whose way forward is a re-run.
      reviews: [review({ stale: true })],
      // The queue is where the dialog finds the message id a re-run names.
      tasks: [{
        artifactVersionIds: ["version-1"],
        checkpointMessageId: "message-checkpoint-1",
        createdAt: AT,
        feedbackPolicy: "record",
        id: "task-1",
        inputFingerprint: "fingerprint",
        origin: "artifact_registered",
        reviewIds: ["review-1"],
        reviewLevel: "quick",
        sessionId: SESSION,
        status: "completed",
        toolCallId: "call-1",
      }],
    },
    sessions: [makeSession({ messages: [checkpointMessage("message-checkpoint-1", "call-1")] })],
  });
  await page.goto("/");

  await page.getByRole("button", { name: "工作区面板" }).click();
  const panel = page.locator(".workspace-panel");
  await panel.getByRole("tab", { name: "产物" }).click();
  await panel.getByRole("button", { name: "main.md" }).click();
  await expect(panel.locator(".doc-body")).toContainText("结论见");
  // The citation is the way into the artifact the review answered for.
  await panel.locator(".graph-chip").first().click();

  const dialog = page.locator(".artifact-dialog");
  await expect(dialog.locator("h2")).toHaveText("report.md");
  await dialog.getByRole("button", { name: "审查", exact: true }).click();

  // The tab shows the reviews of the version on screen, with the same verdict
  // the conversation card draws.
  const artifact = dialog.locator(".review-artifact");
  await expect(artifact).toBeVisible();
  await expect(artifact).toContainText("结构检查通过");
  // A verdict on a replaced version is marked as history, and the re-run is
  // the way forward from it.
  await expect(artifact.locator(".review-banner.is-stale")).toContainText("产物已有新版本");
  await expect(dialog.locator(".review-artifact-head")).toHaveCount(0);

  await artifact.getByRole("button", { name: "重新审查" }).click();

  await expect(dialog.locator(".review-dialog .doc-note")).toHaveText("已加入审查队列。");
  // The action is gone while its own request is in flight: a second click
  // would mint another checkpoint and queue the same work twice.
  await expect(artifact.getByRole("button", { name: "重新审查" })).toHaveCount(0);
  const queued = mock.calls.find(
    (call) => call.method === "POST" && call.path === `/api/sessions/${SESSION}/reviewer-specialist/review`,
  );
  expect(queued).toBeDefined();
  // The route appends a new checkpoint: reusing the one this verdict was drawn
  // on is refused by the store (its tool call id belongs to another task), so
  // the dialog mints an id of its own.
  const posted = JSON.parse(queued!.body!) as { messageId?: string };
  expect(posted.messageId).toMatch(/^[0-9a-f-]{36}$/u);
  expect(posted.messageId).not.toBe("message-checkpoint-1");
});

test("the outcome matrix keeps Quick and Deep apart, and a skip says why", async ({ page }) => {
  // One checkpoint per outcome, in the order the reader meets them: what
  // passed, what only passed its checks, what it flagged, what deep review
  // found, what could not conclude, what failed, and the two opt-outs.
  const matrix: JsonRecord[] = [
    review({
      artifactId: "artifact-quick-pass",
      artifactLogicalName: "quick-pass.md",
      artifactVersionId: "version-quick-pass",
      checks: ["citation", "completeness"],
      completeness: {
        required: [{ path: "report.md", state: "present" }],
        source: "brief",
        status: "complete",
      },
      id: "review-quick-pass",
      reviewLevel: "quick",
      toolCallId: "quick-pass",
    }),
    review({
      artifactId: "artifact-quick-unverified",
      artifactLogicalName: "quick-unverified.md",
      artifactVersionId: "version-quick-unverified",
      checks: ["citation"],
      completeness: undefined,
      id: "review-quick-unverified",
      reviewLevel: "quick",
      toolCallId: "quick-unverified",
    }),
    review({
      artifactId: "artifact-quick-warning",
      artifactLogicalName: "quick-warning.md",
      artifactVersionId: "version-quick-warning",
      checks: ["citation"],
      completeness: undefined,
      decision: "REVISE_AND_RETRY",
      findings: [{
        code: "CITATION_IDENTIFIER_MISSING",
        evidenceRefs: [],
        id: "warning",
        message: "缺少可识别的引文标识符。",
        severity: "warning",
        status: "open",
      }],
      id: "review-quick-warning",
      reviewLevel: "quick",
      toolCallId: "quick-warning",
    }),
    review({
      artifactId: "artifact-deep-contradiction",
      artifactLogicalName: "deep-contradiction.md",
      artifactVersionId: "version-deep-contradiction",
      checks: undefined,
      completeness: undefined,
      findings: [{
        code: "COMPUTATION_EVIDENCE_VALUE_MISMATCH",
        evidenceRefs: [],
        id: "mismatch",
        message: "锁定 Evidence 与报告数值不一致。",
        severity: "critical",
        status: "open",
      }],
      id: "review-deep-contradiction",
      reviewLevel: "deep",
      sourceAssessments: [{
        assessment: {
          assessment: "CONTRADICTED",
          claimId: "claim",
          locatorIds: [],
          policyVersion: "1",
          rationale: "锁定数值不一致。",
        },
        claim: {
          artifactVersionId: "version-deep-contradiction",
          citationKeys: [],
          id: "claim",
          kind: "computation",
          requiredEvidenceLevel: "E4",
          text: "Response was 42%.",
        },
        locators: [],
        snapshots: [],
      }],
      toolCallId: "deep-contradiction",
    }),
    review({
      artifactId: "artifact-deep-inconclusive",
      artifactLogicalName: "deep-inconclusive.md",
      artifactVersionId: "version-deep-inconclusive",
      checks: undefined,
      completeness: undefined,
      id: "review-deep-inconclusive",
      notChecked: [{ check: "claim_support", reason: "Quick review parses citation format only." }],
      reviewLevel: "deep",
      smartDetail: { code: "SMART_CITATION_INCONCLUSIVE", message: "Paper Reader timeout" },
      smartStatus: "inconclusive",
      toolCallId: "deep-inconclusive",
    }),
  ];
  await installMockApi(page, {
    reviewer: { reviews: matrix },
    sessions: [makeSession({
      messages: [
        checkpointMessage("message-quick-pass", "quick-pass"),
        checkpointMessage("message-quick-unverified", "quick-unverified"),
        checkpointMessage("message-quick-warning", "quick-warning"),
        checkpointMessage("message-deep-contradiction", "deep-contradiction"),
        checkpointMessage("message-deep-inconclusive", "deep-inconclusive"),
        unusedCheckpoint("message-deep-failed", "deep-failed", {
          error: "来源核验未完成",
          status: "failed",
        }),
        unusedCheckpoint("message-global-off", "automatic-review:global-off", {
          skipReason: "specialist_disabled",
          status: "skipped",
        }),
        unusedCheckpoint("message-session-off", "automatic-review:session-off", {
          skipReason: "automatic_review_disabled",
          status: "skipped",
        }),
      ],
    })],
  });
  await page.goto("/");

  const cards = page.locator(".review-card");
  await expect(cards).toHaveCount(8);

  // A genuine pass: the citation checks ran and delivery was confirmed, so the
  // card may go green — but it still has to say the claims were not checked.
  const quickPass = cards.nth(0);
  await expect(quickPass).toHaveClass(/is-pass/u);
  await expect(quickPass.locator(".review-summary")).toHaveText("未发现问题");
  await quickPass.locator(".review-head").click();
  await expect(quickPass.locator(".review-note")).toHaveText("本次只核对引用格式，未检查结论支撑。");
  await expect(quickPass.locator(".review-item-title").first()).toHaveText("交付完整");
  await expect(quickPass.locator(".review-item-title").nth(1)).toHaveText("引用检查通过");

  // The same check without a delivery verdict: a citation pass is not an
  // overall pass, and the card must not imply one.
  const unverified = cards.nth(1);
  await expect(unverified).toHaveClass(/is-neutral/u);
  await expect(unverified.locator(".review-summary")).toHaveText("未验证交付");
  await expect(unverified.locator(".review-summary")).not.toHaveText("未发现问题");

  const warning = cards.nth(2);
  // A warning's row is amber and says 提醒, so the frame and header must not
  // escalate it to a red "problem".
  await expect(warning).toHaveClass(/is-warn/u);
  await expect(warning.locator(".review-summary")).toHaveText("1 个提醒");
  await warning.locator(".review-head").click();
  await expect(warning.locator(".review-item-title")).toHaveText("缺少可识别的引文标识符。");
  await expect(warning.locator(".review-item-label")).toHaveText("引用");

  // A computation mismatch is a finding about the report, and the source
  // assessment that produced it is shown with its own verdict.
  const contradiction = cards.nth(3);
  await expect(contradiction).toHaveClass(/is-fail/u);
  await contradiction.locator(".review-head").click();
  await expect(contradiction.locator(".review-item-title"))
    .toHaveText(["锁定 Evidence 与报告数值不一致。", "Response was 42%."]);
  await expect(contradiction.locator(".review-item.is-fail").nth(1).locator(".review-badge"))
    .toHaveText("矛盾");

  // A source service that returned no verdict is not a report defect. The card
  // says it once, as the gap the Deep review left; a stage-level "semantics"
  // row would contradict the per-claim source rows and repeat this one. The
  // service's own error text never reaches the card.
  const inconclusive = cards.nth(4);
  await expect(inconclusive).toHaveClass(/is-neutral/u);
  await expect(inconclusive.locator(".review-summary")).toHaveText("未验证交付");
  await inconclusive.locator(".review-head").click();
  await expect(inconclusive.locator(".review-item-title")).toHaveText("主张与来源的对应");
  await expect(inconclusive.locator(".review-item-body")).toHaveText(
    "深度审查已经尝试核对结论与来源，但没能作出判断（可能缺少足够的原文，或读到的内容无法明确支持或否定结论），所以这一项仍算未检查。这不代表报告有问题。",
  );
  await expect(inconclusive).not.toContainText("来源核验没有得出结论");
  await expect(inconclusive).not.toContainText("Paper Reader timeout");

  // A failed checkpoint is the Reviewer's failure, not a verdict on the
  // artifact, and it keeps the reason the coordinator recorded.
  const failed = cards.nth(5);
  await expect(failed).toHaveClass(/is-fail/u);
  await expect(failed.locator(".review-summary")).toHaveText("审查失败");
  await failed.locator(".review-head").click();
  await expect(failed.locator(".review-empty")).toHaveText("来源核验未完成");

  // The two opt-outs produced nothing, so they say nothing about the artifact:
  // neutral, no claimed pass, no failure, and the reason where the reader can
  // act on it.
  const skipped = cards.nth(6);
  const skippedSession = cards.nth(7);
  for (const card of [skipped, skippedSession]) {
    await expect(card).toHaveClass(/is-neutral/u);
    await expect(card.locator(".review-summary")).toHaveText("已跳过审查");
    await expect(card.locator(".review-count")).toHaveCount(0);
    await card.locator(".review-head").click();
  }
  await expect(skipped.locator(".review-empty"))
    .toHaveText("审查专家已关闭，本次没有产生审查结论。");
  await expect(skippedSession.locator(".review-empty"))
    .toHaveText("此会话已关闭自动审阅，本次没有产生审查结论。");
  await expect(skipped).not.toContainText("未发现问题");
  await expect(skipped).not.toContainText("审查失败");

  // The record is the server's; a reload must read the same eight outcomes.
  await page.reload();
  await expect(cards).toHaveCount(8);
  await expect(cards.nth(0)).toHaveClass(/is-pass/u);
  await expect(cards.nth(2)).toHaveClass(/is-warn/u);
  await expect(cards.nth(6).locator(".review-summary")).toHaveText("已跳过审查");
  await expect(cards.nth(7)).toHaveClass(/is-neutral/u);
});

test("an automatic review's card arrives when the coordinator finishes, with no click", async ({ page }) => {
  const toolCallId = "automatic-review:message-auto";
  const mock = await installMockApi(page, {
    reviewer: {
      reviews: [review({ toolCallId })],
      // A quiet-window audit is running. The queue says so; no checkpoint
      // message exists yet, so the transcript has nothing to draw.
      tasks: [{
        artifactVersionIds: ["version-1"],
        checkpointMessageId: "message-auto",
        createdAt: AT,
        feedbackPolicy: "record",
        id: "task-auto",
        inputFingerprint: "automatic",
        origin: "artifact_registered",
        reviewLevel: "quick",
        sessionId: SESSION,
        status: "running",
        toolCallId,
      }],
    },
    sessions: [makeSession({ messages: [] })],
  });
  await page.goto("/");
  await expect(page.locator(".side-session-name", { hasText: "晶体结构分析" })).toBeVisible();
  const cards = page.locator(".review-card");
  await expect(cards).toHaveCount(0);

  // The window has read the queue once, so it knows a review is outstanding.
  await expect.poll(
    () => mock.calls.filter((call) => call.method === "GET" && call.path.endsWith("/reviewer-audit-tasks")).length,
  ).toBeGreaterThan(0);

  // The coordinator finishes: it writes the checkpoint and empties the queue.
  // An automatic audit publishes no event at this window, so the queue poll is
  // the only thing that can tell the page the card now exists — and the card
  // has to come from a fresh read of the transcript.
  const session = mock.state.sessions.find((entry) => entry.id === SESSION);
  session!.messages = [...(session!.messages as JsonRecord[]), checkpointMessage("message-auto", toolCallId)];
  mock.state.reviewer.tasks = [];

  await expect(cards).toHaveCount(1, { timeout: 15_000 });
  await expect(cards.locator(".review-summary")).toHaveText("未发现问题");
  // No click was involved, so there is no card of this window's own to settle:
  // the one above is the server's, joined by its tool call id and covering the
  // artifact once.
  await cards.locator(".review-head").click();
  await expect(cards.locator("[data-testid='review-artifact']")).toHaveCount(1);
});

test("a reviewer switched off on the server still says why the session cannot review", async ({ page }) => {
  await installMockApi(page, {
    reviewer: { settings: { enabled: false, feedbackPolicy: "record" } },
    sessions: [makeSession()],
  });
  await page.goto("/");
  await expect(page.locator(".side-session-name", { hasText: "晶体结构分析" })).toBeVisible();

  await page.getByRole("button", { name: "会话设置" }).click();
  const menu = page.locator(".session-menu");
  // The desktop does not offer a way to switch the reviewer off, but the
  // server setting can be off from another client or an older configuration.
  // The switch then belongs to a capability that stays off, so it is shown
  // but not offered, and the note says why.
  await expect(menu.locator(".session-menu-note"))
    .toHaveText("审查专家已关闭，此会话的自动审阅不会生效。");
  await expect(menu.getByRole("switch", { name: "自动审阅" })).toBeDisabled();
});
