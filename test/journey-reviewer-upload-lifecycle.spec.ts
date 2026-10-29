// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { expect, request } from "@playwright/test";
import type { ArtifactReviewRun, ReviewFeedback, ReviewerAuditTask, ScientificArtifact, ScientificArtifactVersion, SessionDetail } from "@sciencediscovery/schema";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { test } from "./helpers/e2e.ts";
import { cleanupJourney, createProjectAndSession, openProjectSession, scriptedModel, sendUserMessage, waitForRunTerminal, type JourneyFixture } from "./helpers/journeys.ts";

const REPORT = "# Synthetic report fixture\n\nThis deterministic copy exercises artifact and review lifecycle only. It makes no scientific claims.\n";
const SKIP_REASON = "Automatic review was skipped because Reviewer Specialist is off in System configuration → Specialists. No review result was produced.";

test.describe("Jiuwen reviewer feedback attribution", { tag: ["@isolation:global", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:none"] }, () => {
  /**
   * E2E-META
   * Purpose: Separate normal MAIN feedback consumption from a skipped automatic audit using actual Jiuwen and persisted review records.
   * Steps:
   *   1. Upload an owned synthetic seed; actual Jiuwen materializes and declares a distinct report copy, then automatic Quick completes.
   *   2. Disable session automatic review; a successful second MAIN consumes ready feedback without creating any audit.
   *   3. Reenable session automatic review and disable the global specialist; a third MAIN publishes another distinct copy.
   *   4. Capture complete records while its audit is queued; verify skipped and reload preserve every review and feedback field and show a neutral reason.
   * Environment: Isolated committed JiuwenSwarm Web/API/Runner; E2E_SWARM_TASK=1. No shell execution or sandbox-policy changes.
   * Type: mocked
   * LLM: owned loopback OpenAI-compatible scripted model; actual Jiuwen agent loop and automatic Quick reviewer.
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none; non-local browser requests are aborted.
   * Credentials: E2E_API_TOKEN and synthetic local model token only.
   * CostSideEffects: Creates/deletes one owned Project/Session/model and four synthetic artifacts; restores global Reviewer setting; no paid calls.
   */
  test("actual Jiuwen distinguishes MAIN consumption from skipped review", { tag: "@mocked" }, async ({ page, journey }, info) => {
    test.setTimeout(230_000);
    expect(process.env.E2E_SWARM_TASK, "Actual Jiuwen backend is required").toBe("1");
    journey.scenario({ goal: "Prove that MAIN consumes existing feedback, whereas skipping an audit creates no review and changes no feedback.", preconditions: ["Actual isolated Jiuwen stack", "Owned local deterministic model", "No shell execution"] });
    await page.addInitScript(() => localStorage.setItem("sciencediscovery-locale", "en"));
    const paths = ["results/reviewed-copy.md", "results/no-audit-copy.md", "results/skipped-copy.md"];
    const materializations = paths.map(path => ({ artifact_id: "", version: 1, path }));
    const stub = await scriptedModel(paths.map((path, index) => [
      { tool: "materialize_artifact", arguments: materializations[index]! },
      { tool: "declare_artifact", arguments: { path } },
      { text: `Published the synthetic fixture copy ${path}.` },
    ]), undefined, { captureContext: true });
    let fixture: JourneyFixture | undefined;
    let originalReviewer: { enabled: boolean } | undefined;
    const api = async <T,>(path: string, method: "GET" | "PUT" = "GET", data?: unknown): Promise<T> => {
      const response = await page.request.fetch(`${apiBaseUrl()}${path}`, { method, headers: authorizationHeader(), ...(data === undefined ? {} : { data }), timeout: 10_000 });
      expect(response.ok(), `${method} ${path}: ${response.status()}`).toBeTruthy();
      return await response.json() as T;
    };
    let reviews: ArtifactReviewRun[] = [];
    let feedback: ReviewFeedback[] = [];
    let completedTask: ReviewerAuditTask;
    let skipped: ReviewerAuditTask;
    let skippedCheckpoint: SessionDetail["messages"][number]["reviewerCheckpoint"];
    try {
      originalReviewer = await api("/api/reviewer-specialist/settings");
      await api("/api/reviewer-specialist/settings", "PUT", { enabled: true });
      fixture = await createProjectAndSession(page, {
        approvalMode: "always_allow", projectName: `Reviewer causal lifecycle ${Date.now()}`, sessionTitle: "Review feedback attribution",
        model: { apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: `Reviewer lifecycle ${Date.now()}` },
      });
      const prefix = `/api/sessions/${fixture.session.id}`;
      const records = <T,>(resource: string) => api<T[]>(`${prefix}/${resource}`);
      const publishCopy = async (index: number) => {
        const run = await sendUserMessage(page, fixture!.session.id, `Materialize the owned synthetic seed as ${paths[index]} and declare that distinct copy. This is a lifecycle fixture, not new scientific analysis.`);
        const terminal = await waitForRunTerminal(page, fixture!.session.id, run.id, 35_000);
        expect(terminal.status, terminal.error).toBe("completed");
        const artifacts = await records<ScientificArtifact>("artifacts");
        const artifact = artifacts.find(item => item.logicalName === paths[index]);
        expect(artifact).toMatchObject({ origin: "llm_declared" });
        const versions = await records<ScientificArtifactVersion>(`artifacts/${artifact!.id}/versions`);
        expect(versions).toHaveLength(1);
        const content = await page.request.get(`${apiBaseUrl()}${prefix}/artifact-versions/${versions[0]!.id}/content`, { headers: authorizationHeader(), timeout: 10_000 });
        expect(content.ok()).toBeTruthy();
        expect(await content.text()).toBe(REPORT);
        expect(stub.calls.filter(call => call.turn === index && call.tool).map(call => call.tool)).toEqual(["materialize_artifact", "declare_artifact"]);
        return { run, version: versions[0]! };
      };
      await journey.step("Publish an owned fixture and complete a normal automatic Quick audit", "The uploaded seed is not automatically reviewed; exactly the Jiuwen-declared copy has one real Quick review and ready feedback.", async () => {
        await api(`${prefix}/reviewer-specialist/settings`, "PUT", { automaticReviewEnabled: true, level: "quick" });
        const upload = await page.request.post(`${apiBaseUrl()}${prefix}/workspace/upload`, {
          headers: authorizationHeader(), multipart: { files: { name: "seed.md", mimeType: "text/markdown", buffer: Buffer.from(REPORT) } }, timeout: 10_000,
        });
        expect(upload.ok()).toBeTruthy();
        const artifacts = await records<ScientificArtifact>("artifacts");
        expect(artifacts).toHaveLength(1);
        expect(artifacts[0]).toMatchObject({ origin: "user_upload", logicalName: "seed.md" });
        materializations.forEach(arguments_ => { arguments_.artifact_id = artifacts[0]!.id; });
        expect(await records("reviewer-audit-tasks")).toEqual([]);
        expect(await records("artifact-reviews")).toEqual([]);
        expect(await records("review-feedback")).toEqual([]);
        await openProjectSession(page, fixture!);
        const { run, version } = await publishCopy(0);
        await expect.poll(async () => {
          const tasks = await records<ReviewerAuditTask>("reviewer-audit-tasks");
          expect(tasks).toHaveLength(1);
          completedTask = tasks[0]!;
          return completedTask.status;
        }, { timeout: 90_000 }).toBe("completed");
        expect(completedTask!).toMatchObject({ origin: "artifact_registered", sourceRunId: run.id, reviewLevel: "quick", artifactVersionIds: [version.id] });
        reviews = await records<ArtifactReviewRun>("artifact-reviews");
        expect(reviews).toHaveLength(1);
        expect(reviews[0]).toMatchObject({ artifactVersionId: version.id, reviewLevel: "quick" });
        expect(completedTask!.reviewIds).toEqual(reviews.map(review => review.id));
        feedback = await records<ReviewFeedback>("review-feedback");
        expect(feedback).toHaveLength(1);
        expect(feedback[0]).toMatchObject({ taskId: completedTask!.id, policy: "record", status: "ready", reviewIds: completedTask!.reviewIds, artifactVersionIds: [version.id] });
        await expect(page.locator(".reviewer-specialist-card").last()).toContainText(paths[0]!);
        await expect(page.locator(".reviewer-specialist-card").last()).toContainText("Quick");
      });
      await journey.step("Consume feedback in a successful MAIN with no automatic audit", "Only status and consumedAt change. No reviewer task or review is created, establishing that MAIN — not skip — consumes feedback.", async () => {
        await api(`${prefix}/reviewer-specialist/settings`, "PUT", { automaticReviewEnabled: false, level: "quick" });
        const { run } = await publishCopy(1);
        const tasks = await records<ReviewerAuditTask>("reviewer-audit-tasks");
        expect(tasks.some(task => task.sourceRunId === run.id)).toBe(false);
        expect(tasks).toEqual([completedTask!]);
        expect(await records<ArtifactReviewRun>("artifact-reviews")).toEqual(reviews);
        const consumed = await records<ReviewFeedback>("review-feedback");
        expect(consumed).toHaveLength(feedback.length);
        expect(consumed.every(record => record.status === "consumed" && Boolean(record.consumedAt))).toBe(true);
        const withoutConsumption = ({ status: _status, consumedAt: _consumedAt, ...record }: ReviewFeedback) => record;
        expect(consumed.map(withoutConsumption)).toEqual(feedback.map(withoutConsumption));
        feedback = consumed;
        await info.attach("feedback-after-no-audit-MAIN", { body: JSON.stringify({ sourceRunId: run.id, tasks, reviews, feedback }, null, 2), contentType: "application/json" });
      });
      await journey.step("Queue a report while the global Reviewer is disabled", "The third successful MAIN leaves consumed feedback untouched; capture the full records before the real quiet window closes.", async () => {
        await api(`${prefix}/reviewer-specialist/settings`, "PUT", { automaticReviewEnabled: true, level: "quick" });
        await api("/api/reviewer-specialist/settings", "PUT", { enabled: false });
        await page.reload();
        await expect(page.getByRole("status").filter({ hasText: "Automatic review is unavailable" })).toBeVisible();
        const { run, version } = await publishCopy(2);
        await expect.poll(async () => {
          skipped = (await records<ReviewerAuditTask>("reviewer-audit-tasks")).find(task => task.sourceRunId === run.id)!;
          return skipped?.status;
        }).toBe("queued");
        expect(skipped!).toMatchObject({ artifactVersionIds: [version.id], sourceRunId: run.id });
        expect(await records<ArtifactReviewRun>("artifact-reviews")).toEqual(reviews);
        expect(await records<ReviewFeedback>("review-feedback")).toEqual(feedback);
        await info.attach("records-before-skip", { body: JSON.stringify({ task: skipped!, reviews, feedback }, null, 2), contentType: "application/json" });
      });
      await journey.step("Observe a neutral skip and reload", "The source-bound task/checkpoint are skipped, not passed/failed; every existing review and feedback field remains identical.", async () => {
        await expect.poll(async () => {
          skipped = (await records<ReviewerAuditTask>("reviewer-audit-tasks")).find(task => task.id === skipped!.id)!;
          return skipped.status;
        }, { timeout: 90_000 }).toBe("skipped");
        expect(skipped!).toMatchObject({ skipReason: "specialist_disabled" });
        expect(skipped!.reviewIds).toBeUndefined();
        expect(skipped!.errorSummary).toBeUndefined();
        expect(skipped!.supersededBy).toBeUndefined();
        const detail = await api<SessionDetail>(prefix);
        skippedCheckpoint = detail.messages.find(message => message.id === skipped!.checkpointMessageId)?.reviewerCheckpoint;
        expect(skippedCheckpoint).toMatchObject({ status: "skipped", skipReason: "specialist_disabled" });
        expect(await records<ArtifactReviewRun>("artifact-reviews")).toEqual(reviews);
        expect(await records<ReviewFeedback>("review-feedback")).toEqual(feedback);
        const panel = page.locator(".reviewer-specialist-panel").filter({ hasText: SKIP_REASON });
        const heading = panel.locator(".reviewer-specialist-panel-heading strong");
        await expect(heading).toContainText("Review skipped");
        await page.reload();
        await expect(heading).toBeVisible();
        await expect(panel).not.toHaveClass(/failed|running/);
        await expect(panel).not.toContainText(/review passed|Review completed|Review failed/);
        expect(await records<ReviewerAuditTask>("reviewer-audit-tasks")).toEqual([completedTask!, skipped!]);
        expect((await api<SessionDetail>(prefix)).messages.find(message => message.id === skipped!.checkpointMessageId)?.reviewerCheckpoint).toEqual(skippedCheckpoint);
        expect(await records<ArtifactReviewRun>("artifact-reviews")).toEqual(reviews);
        expect(await records<ReviewFeedback>("review-feedback")).toEqual(feedback);
        expect(await records("runs")).toHaveLength(3);
        await panel.locator("summary").click();
        const explanation = panel.locator(".reviewer-specialist-results").getByText(SKIP_REASON, { exact: true });
        await explanation.evaluate(node => node.scrollIntoView({ block: "center" }));
        await expect(explanation).toBeVisible();
        await info.attach("records-after-skip-and-reload", { body: JSON.stringify({ task: skipped!, checkpoint: skippedCheckpoint, reviews, feedback }, null, 2), contentType: "application/json" });
      });
    } finally {
      // A full test timeout may close page.request. Restore global state using
      // an independent context, and never let restoration skip owned cleanup.
      try {
        if (originalReviewer) {
          const cleanup = await request.newContext();
          try {
            const response = await cleanup.put(`${apiBaseUrl()}/api/reviewer-specialist/settings`, { headers: authorizationHeader(), data: { enabled: originalReviewer.enabled }, timeout: 10_000 });
            expect(response.ok()).toBeTruthy();
          } finally { await cleanup.dispose(); }
        }
      } finally {
        try { if (fixture) await cleanupJourney(page, fixture); }
        finally { await stub.stop(); }
      }
    }
  });
});
