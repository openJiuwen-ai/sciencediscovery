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

import { expect, type Page } from "@playwright/test";

import { requireRealEnv, requireRealStack, test } from "./helpers/e2e.ts";

import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";

// Static suite metadata is inherited by each framework-expanded journey.
test.describe("issue-67-34-inline-cards.spec", { tag: ["@category:e2e", "@os:linux", "@arch:amd64", "@model:real", "@sandbox:bubblewrap"] }, () => {

/**
 * Verification for the current run activity layout: Plans live in Workspace
 * Tasks, while Subagent records and outputs stay with their producing run.
 *
 * Requires the stack under test plus E2E_LLM_BASE_URL / E2E_LLM_MODEL /
 * E2E_LLM_TOKEN for a real model, and E2E_SCREENSHOTS for output.
 */

const API = apiBaseUrl();
const SCREENSHOTS = process.env.E2E_SCREENSHOTS ?? "screenshots";

async function api(path: string, init?: RequestInit) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...authorizationHeader(), "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`${path} -> ${response.status}: ${await response.text()}`);
  return response.json();
}

async function waitRunIdle(page: Page, timeout = 420_000) {
  // While a run streams, the composer offers Stop; it disappears when idle.
  await page.getByRole("button", { name: "Stop the current run" }).waitFor({ state: "hidden", timeout });
}

async function flowOrder(page: Page) {
  return page.locator(".messages").evaluate((container) =>
    Array.from(container.querySelectorAll(":scope > article.message, :scope > .run-timeline, .process-agent-record, .conversation-artifact-list")).map((element) => {
      if (element.classList.contains("process-agent-record")) return "subagent-record";
      if (element.classList.contains("conversation-artifact-list")) return "artifact-outputs";
      if (element.classList.contains("run-timeline")) return "run-timeline";
      return element.classList.contains("user") ? "user-message" : "assistant-message";
    }));
}

async function showWorkspacePlans(page: Page) {
  let workspace = page.locator("aside.workspace-panel");
  if (!await workspace.count()) {
    await page.getByRole("button", { name: /^(Show workspace|显示工作区)$/ }).click();
    workspace = page.locator("aside.workspace-panel");
  }
  await expect(workspace).toBeVisible();
  const folder = workspace.locator('[data-folder="tasks"]');
  if (await folder.getAttribute("open") === null) await folder.locator(":scope > summary").click();
  const plans = folder.locator("details.workspace-plan-section");
  await plans.waitFor({ state: "visible", timeout: 420_000 });
  if (await plans.getAttribute("open") === null) await plans.locator(":scope > summary").click();
  return plans;
}

async function setupSession(page: Page, options: { alwaysAllow?: boolean } = {}) {
  const model = await api("/api/models", {
    method: "POST",
    body: JSON.stringify({
      apiToken: process.env.E2E_LLM_TOKEN,
      baseUrl: process.env.E2E_LLM_BASE_URL,
      model: process.env.E2E_LLM_MODEL,
      name: `E2E inline-cards ${Date.now()}`,
      vision: false,
    }),
  });
  const project = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: `E2E inline cards ${Date.now()}` }) });
  const session = await api(`/api/projects/${project.id}/sessions`, { method: "POST", body: JSON.stringify({ title: "Inline cards" }) });
  await api(`/api/sessions/${session.id}`, { method: "PATCH", body: JSON.stringify({ modelId: model.id }) });
  if (options.alwaysAllow) {
    // Approval mode moves in a dedicated request; it cannot ride the model PATCH.
    await api(`/api/sessions/${session.id}`, { method: "PATCH", body: JSON.stringify({ approvalMode: "always_allow" }) });
  }

  await page.goto("/");
  // Select this run's project/session explicitly; the stack may hold others,
  // and a reload falls back to an auto-selected project rather than this one.
  // Waits guard against the project/session lists re-rendering while loading.
  async function selectInlineCardsSession() {
    const projectNav = page.locator(".nav-item", { hasText: project.name }).first();
    await projectNav.waitFor({ state: "visible" });
    await projectNav.click();
    const sessionNav = page.locator(".sessions .nav-item", { hasText: "Inline cards" }).first();
    await sessionNav.waitFor({ state: "visible" });
    await sessionNav.click();
    await expect(page.locator(".session-bar h1.session-bar-session")).toHaveText("Inline cards", { timeout: 20_000 });
  }
  await selectInlineCardsSession();
  return { project, selectInlineCardsSession, session };
}

/**
 * E2E-META
 * Purpose: Plans appear in Workspace Tasks; Subagent records stay with their
 *   producing run, default to collapsed, and retain their position across
 *   follow-up, reload, and session switch.
 * Steps:
 *   1. Register the real model, project, and session over the API.
 *   2. Run a prompt that produces a plan and a subagent; approve permissions.
 *   3. Assert card anchoring/collapse, reload, switch sessions, re-assert.
 * Environment: Running stack at E2E_API_URL / E2E_BASE_URL with the default bearer
 *   token; E2E_SCREENSHOTS for output.
 * Type: real
 * LLM: Real chat completions via E2E_LLM_BASE_URL; output and timing vary.
 * WebSearch: None.
 * PaperSources: None.
 * MCP: None required by the test.
 * OtherExternal: Local ScienceDiscovery API, gateway, browser UI, and runner.
 * Credentials: E2E_LLM_BASE_URL, E2E_LLM_MODEL, E2E_LLM_TOKEN; optional E2E_API_TOKEN.
 * CostSideEffects: Billable tokens, model rate limits, local projects/sessions/models, screenshots.
 */
test("workspace plan and run-anchored subagent survive follow-up and reload", { tag: "@real" }, async ({ page }, testInfo) => {
  test.setTimeout(900_000);
  requireRealEnv(testInfo, "E2E_LLM_BASE_URL", "E2E_LLM_MODEL", "E2E_LLM_TOKEN");
  await requireRealStack(testInfo, API);

  const { selectInlineCardsSession } = await setupSession(page, { alwaysAllow: true });

  // Round 1: ask for a Workspace Plan and a run-scoped Subagent record.
  await page.locator(".composer textarea").fill(
    "请先用 todo_create 创建恰好两项任务的计划（第一项：启动 subagent 回答 2+2；第二项：汇报结果），然后调用 task 工具启动 subagent，最后用一句话汇报。",
  );
  await page.getByRole("button", { name: "Run analysis" }).click();
  const plans = await showWorkspacePlans(page);
  const plan = plans.locator("article.plan-card").first();
  await expect(plan).toBeVisible();
  const subagent = page.locator(".messages details.process-agent-record").first();
  await expect(subagent.locator(":scope > summary")).toBeVisible({ timeout: 420_000 });
  await waitRunIdle(page);

  // The Workspace Plan and terminal Subagent record start collapsed.
  await expect(plan.locator(".plan-card-heading")).toHaveAttribute("aria-expanded", "false");
  await expect(subagent).not.toHaveAttribute("open", "");
  await expect(plan).toContainText("Plan");
  await expect(plan).toContainText(/\d+\/2 completed/);
  await page.screenshot({ path: `${SCREENSHOTS}/01-collapsed.png`, fullPage: true });

  // Explicit Workspace expansion survives the next run's live updates.
  await plan.locator(".plan-card-heading").click();
  await expect(plan.locator(".plan-card-heading")).toHaveAttribute("aria-expanded", "true");

  // Round 2: a plain follow-up in the same session exercises timeline replay.
  await page.locator(".composer textarea").fill("第二轮：直接回答 1+1 等于几。不要创建新计划，也不要启动 subagent。");
  await page.getByRole("button", { name: "Run analysis" }).click();
  await waitRunIdle(page);
  await expect(page.locator(".messages > article.message.user")).toHaveCount(2, { timeout: 60_000 });
  // Round 1's replayed timeline block plus round 2's active timeline.
  await expect(page.locator(".messages > .run-timeline")).toHaveCount(2, { timeout: 60_000 });

  const order = await flowOrder(page);
  const firstTimeline = order.indexOf("run-timeline");
  const subagentAt = order.indexOf("subagent-record");
  const secondUser = order.indexOf("user-message", 1);
  expect(firstTimeline, `round 1 timeline block missing in ${order.join()}`).toBeGreaterThanOrEqual(0);
  expect(subagentAt, `subagent card order in ${order.join()}`).toBeGreaterThan(firstTimeline);
  expect(subagentAt, `subagent card must precede round 2 in ${order.join()}`).toBeLessThan(secondUser);
  await expect(plan.locator(".plan-card-heading")).toHaveAttribute("aria-expanded", "true");
  await page.screenshot({ path: `${SCREENSHOTS}/02-anchored-after-migration.png`, fullPage: true });

  await subagent.locator(":scope > summary").click();
  await expect(subagent).toHaveAttribute("open", "");
  await showWorkspacePlans(page);
  await expect(plan.locator(".plan-item-list li").first()).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOTS}/03-expanded.png`, fullPage: true });

  // Reload: same anchors, same order, collapsed again by default.
  await page.reload();
  await selectInlineCardsSession();
  await showWorkspacePlans(page);
  await expect(plan).toBeVisible({ timeout: 60_000 });
  await expect(subagent.locator(":scope > summary")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".messages > .run-timeline")).toHaveCount(2, { timeout: 60_000 });
  const orderAfterReload = await flowOrder(page);
  expect(orderAfterReload).toEqual(order);
  await expect(plan.locator(".plan-card-heading")).toHaveAttribute("aria-expanded", "false");
  await expect(subagent).not.toHaveAttribute("open", "");
  await page.screenshot({ path: `${SCREENSHOTS}/04-after-reload.png`, fullPage: true });

  // Switch away and back: positions stay put.
  await page.getByRole("button", { name: "Add session" }).click();
  await expect(page.locator(".session-bar h1.session-bar-session")).toHaveText("Untitled session", { timeout: 20_000 });
  await selectInlineCardsSession();
  await showWorkspacePlans(page);
  await expect(plan).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".messages > .run-timeline")).toHaveCount(2, { timeout: 60_000 });
  const orderAfterSwitch = await flowOrder(page);
  expect(orderAfterSwitch).toEqual(order);
  await page.screenshot({ path: `${SCREENSHOTS}/05-after-session-switch.png`, fullPage: true });
});

/**
 * E2E-META
 * Purpose: Per-run Markdown output lists anchor to the run that wrote them
 *   without a duplicate global preview.
 * Steps:
 *   1. Register the real model, project, and session over the API.
 *   2. Run two file-writing rounds and one plain-answer round.
 *   3. Assert exactly one output list per writing round, anchored in order.
 * Environment: Running stack at E2E_API_URL / E2E_BASE_URL with the default bearer
 *   token; E2E_SCREENSHOTS for output.
 * Type: real
 * LLM: Real chat completions via E2E_LLM_BASE_URL; output and timing vary.
 * WebSearch: None.
 * PaperSources: None.
 * MCP: None required by the test.
 * OtherExternal: Local ScienceDiscovery API, gateway, browser UI, and runner-executed Python.
 * Credentials: E2E_LLM_BASE_URL, E2E_LLM_MODEL, E2E_LLM_TOKEN; optional E2E_API_TOKEN.
 * CostSideEffects: Billable tokens, model rate limits, local models/projects/sessions/files, screenshots.
 */
test("markdown outputs anchor to their producing runs without duplicates", { tag: "@real" }, async ({ page }, testInfo) => {
  test.setTimeout(900_000);
  requireRealEnv(testInfo, "E2E_LLM_BASE_URL", "E2E_LLM_MODEL", "E2E_LLM_TOKEN");
  await requireRealStack(testInfo, API);

  const { selectInlineCardsSession } = await setupSession(page, { alwaysAllow: true });

  async function submit(prompt: string) {
    await page.locator(".composer textarea").fill(prompt);
    await page.getByRole("button", { name: "Run analysis" }).click();
    await waitRunIdle(page);
  }

  // Three rounds: round 1 and 2 each write a different markdown file, round 3
  // pushes round 2's group into its replayed conversation block.
  await submit("请调用 run_shell 工具在工作区根目录写入文件 findings-a.md（一段简短 markdown 即可），显式声明为 artifact，然后用一句话汇报。");
  await expect(page.locator(".conversation-artifact-list", { hasText: "findings-a.md" })).toBeVisible({ timeout: 120_000 });
  await submit("请调用 run_shell 工具在工作区根目录写入文件 findings-b.md（一段简短 markdown 即可），显式声明为 artifact，然后用一句话汇报。");
  await expect(page.locator(".conversation-artifact-list", { hasText: "findings-b.md" })).toBeVisible({ timeout: 120_000 });
  await submit("第三轮：直接回答 1+1 等于几，不要写任何文件。");
  await expect(page.locator(".messages > article.message.user")).toHaveCount(3, { timeout: 60_000 });

  // Exactly two output lists: one per round, never a global bottom duplicate.
  await expect(page.locator(".conversation-artifact-list")).toHaveCount(2, { timeout: 60_000 });
  const order = await flowOrder(page);
  const outputPositions = order.flatMap((entry, index) => entry === "artifact-outputs" ? [index] : []);
  expect(outputPositions.length, `two output lists in ${order.join()}`).toBe(2);
  const userPositions = order.flatMap((entry, index) => entry === "user-message" ? [index] : []);
  const secondUser = userPositions[1]!;
  const thirdUser = userPositions[2]!;
  expect(outputPositions[0]!, `first output must sit in round 1 of ${order.join()}`).toBeLessThan(secondUser);
  expect(outputPositions[1]!, `second output must sit in round 2 of ${order.join()}`).toBeGreaterThan(secondUser);
  expect(outputPositions[1]!, `second output must precede round 3 in ${order.join()}`).toBeLessThan(thirdUser);

  const firstOutput = page.locator(".conversation-artifact-list", { hasText: "findings-a.md" });
  const secondOutput = page.locator(".conversation-artifact-list", { hasText: "findings-b.md" });
  await expect(firstOutput.getByRole("button", { name: /findings-a\.md/ })).toBeVisible();
  await expect(secondOutput.getByRole("button", { name: /findings-b\.md/ })).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOTS}/06-artifacts-anchored.png`, fullPage: true });

  // Opening a run output reads its fixed Artifact version.
  await firstOutput.getByRole("button", { name: /findings-a\.md/ }).click();
  await expect(page.locator(".artifact-modal-panel")).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SCREENSHOTS}/07-artifact-expanded.png`, fullPage: true });
  await page.getByRole("button", { name: "Close artifact viewer" }).click();

  // Reload: same two cards in the same positions.
  await page.reload();
  await selectInlineCardsSession();
  await expect(page.locator(".conversation-artifact-list")).toHaveCount(2, { timeout: 60_000 });
  const orderAfterReload = await flowOrder(page);
  expect(orderAfterReload).toEqual(order);
  await page.screenshot({ path: `${SCREENSHOTS}/08-artifacts-after-reload.png`, fullPage: true });
});

});
