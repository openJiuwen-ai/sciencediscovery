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

/**
 * Verification for inline run activity cards on the modularized layout:
 * plan / subagent cards must render at the run that
 * produced them, default to collapsed summaries, keep their expansion when
 * their group migrates from the tail to a conversation block, and keep their
 * positions across a page reload.
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
    Array.from(container.querySelectorAll(":scope > article.message, :scope > .run-timeline, .plan-card, .subagent-card, .result-preview")).map((element) => {
      if (element.classList.contains("plan-card")) return "plan-card";
      if (element.classList.contains("subagent-card")) return "subagent-card";
      if (element.classList.contains("result-preview")) return "artifact-preview";
      if (element.classList.contains("run-timeline")) return "run-timeline";
      return element.classList.contains("user") ? "user-message" : "assistant-message";
    }));
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
    await expect(page.locator(".topbar h1")).toHaveText("Inline cards", { timeout: 20_000 });
  }
  await selectInlineCardsSession();
  return { project, selectInlineCardsSession, session };
}

/**
 * E2E-META
 * Purpose: Plan / subagent cards render at the run that produced them, default
 *   to collapsed, keep expansion state when their group migrates into a
 *   conversation block, and keep positions across reload and session switch.
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
 * OtherExternal: Local science_agent API, gateway, browser UI, and runner.
 * Credentials: E2E_LLM_BASE_URL, E2E_LLM_MODEL, E2E_LLM_TOKEN; optional E2E_API_TOKEN.
 * CostSideEffects: Billable tokens, model rate limits, local projects/sessions/models, screenshots.
 */
test("plan and subagent cards anchor to their run, collapse by default, and survive reload", { tag: "@real" }, async ({ page }, testInfo) => {
  test.setTimeout(900_000);
  requireRealEnv(testInfo, "E2E_LLM_BASE_URL", "E2E_LLM_MODEL", "E2E_LLM_TOKEN");
  await requireRealStack(testInfo, API);

  const { selectInlineCardsSession } = await setupSession(page);

  // Round 1: ask for a plan and a subagent to exercise both inline card types.
  await page.locator(".composer textarea").fill(
    "请严格按顺序执行三步：第一步，先调用 propose_plan 工具提交一个只含两步的小计划；第二步，调用 task 工具启动一个 subagent，让它回答 2+2 等于几；第三步，用一句话简单汇报。",
  );
  await page.getByRole("button", { name: "Run analysis" }).click();
  await expect(page.locator(".plan-card").first()).toBeVisible({ timeout: 420_000 });
  await expect(page.locator(".subagent-card").first()).toBeVisible({ timeout: 420_000 });
  await waitRunIdle(page);

  // Cards default to collapsed summaries.
  await expect(page.locator(".plan-card button").first()).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".subagent-card > button").first()).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".plan-card").first()).toContainText("Saved plan");
  await expect(page.locator(".plan-card").first()).toContainText("not live progress");
  await expect(page.locator(".plan-card").first()).not.toContainText("recorded mode");
  await page.screenshot({ path: `${SCREENSHOTS}/01-collapsed.png`, fullPage: true });

  // Expanding a card while its run is still the tail group must survive the
  // group migrating to its conversation block once the next run starts.
  await page.locator(".plan-card button").first().click();
  await expect(page.locator(".plan-card button").first()).toHaveAttribute("aria-expanded", "true");

  // Round 2: a plain follow-up in the same session exercises timeline replay.
  await page.locator(".composer textarea").fill("第二轮：直接回答 1+1 等于几。不要调用 propose_plan，也不要启动 subagent。");
  await page.getByRole("button", { name: "Run analysis" }).click();
  await waitRunIdle(page);
  await expect(page.locator(".messages > article.message.user")).toHaveCount(2, { timeout: 60_000 });
  // Round 1's replayed timeline block plus round 2's active timeline.
  await expect(page.locator(".messages > .run-timeline")).toHaveCount(2, { timeout: 60_000 });

  const order = await flowOrder(page);
  const firstTimeline = order.indexOf("run-timeline");
  const planAt = order.indexOf("plan-card");
  const subagentAt = order.indexOf("subagent-card");
  const secondUser = order.indexOf("user-message", 1);
  expect(firstTimeline, `round 1 timeline block missing in ${order.join()}`).toBeGreaterThanOrEqual(0);
  expect(planAt, `plan card order in ${order.join()}`).toBeGreaterThan(firstTimeline);
  expect(subagentAt, `subagent card order in ${order.join()}`).toBeGreaterThan(firstTimeline);
  expect(planAt, `plan card must precede round 2 in ${order.join()}`).toBeLessThan(secondUser);
  expect(subagentAt, `subagent card must precede round 2 in ${order.join()}`).toBeLessThan(secondUser);
  // The expansion survived the tail-to-block migration (App-lifted state).
  await expect(page.locator(".plan-card button").first()).toHaveAttribute("aria-expanded", "true");
  await page.screenshot({ path: `${SCREENSHOTS}/02-anchored-after-migration.png`, fullPage: true });

  // Expanding the subagent card shows its content too.
  await page.locator(".subagent-card > button").first().click();
  await expect(page.locator(".subagent-card > button").first()).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".plan-card ol li").first()).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOTS}/03-expanded.png`, fullPage: true });

  // Reload: same anchors, same order, collapsed again by default.
  await page.reload();
  await selectInlineCardsSession();
  await expect(page.locator(".plan-card").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".subagent-card").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".messages > .run-timeline")).toHaveCount(2, { timeout: 60_000 });
  const orderAfterReload = await flowOrder(page);
  expect(orderAfterReload).toEqual(order);
  await expect(page.locator(".plan-card button").first()).toHaveAttribute("aria-expanded", "false");
  await page.screenshot({ path: `${SCREENSHOTS}/04-after-reload.png`, fullPage: true });

  // Switch away and back: positions stay put.
  await page.getByRole("button", { name: "Add session" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Session name").fill("Detour");
  await dialog.getByRole("button", { name: "Create Session" }).click();
  await expect(page.locator(".topbar h1")).toHaveText("Detour", { timeout: 20_000 });
  await selectInlineCardsSession();
  await expect(page.locator(".plan-card").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".messages > .run-timeline")).toHaveCount(2, { timeout: 60_000 });
  const orderAfterSwitch = await flowOrder(page);
  expect(orderAfterSwitch).toEqual(order);
  await page.screenshot({ path: `${SCREENSHOTS}/05-after-session-switch.png`, fullPage: true });
});

/**
 * E2E-META
 * Purpose: Markdown artifact previews anchor to the run that wrote them and
 *   never duplicate as a global bottom preview.
 * Steps:
 *   1. Register the real model, project, and session over the API.
 *   2. Run two file-writing rounds and one plain-answer round.
 *   3. Assert exactly one preview per writing round, anchored in order.
 * Environment: Running stack at E2E_API_URL / E2E_BASE_URL with the default bearer
 *   token; E2E_SCREENSHOTS for output.
 * Type: real
 * LLM: Real chat completions via E2E_LLM_BASE_URL; output and timing vary.
 * WebSearch: None.
 * PaperSources: None.
 * MCP: None required by the test.
 * OtherExternal: Local science_agent API, gateway, browser UI, and runner-executed Python.
 * Credentials: E2E_LLM_BASE_URL, E2E_LLM_MODEL, E2E_LLM_TOKEN; optional E2E_API_TOKEN.
 * CostSideEffects: Billable tokens, model rate limits, local models/projects/sessions/files, screenshots.
 */
test("markdown previews anchor to the run that wrote them instead of pinning to the bottom", { tag: "@real" }, async ({ page }, testInfo) => {
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
  await submit("请调用 run_python 工具在工作区根目录写入文件 findings-a.md（一段简短 markdown 即可），然后用一句话汇报。");
  await expect(page.locator(".result-preview", { hasText: "findings-a.md" })).toBeVisible({ timeout: 120_000 });
  await submit("请调用 run_python 工具在工作区根目录写入文件 findings-b.md（一段简短 markdown 即可），然后用一句话汇报。");
  await expect(page.locator(".result-preview", { hasText: "findings-b.md" })).toBeVisible({ timeout: 120_000 });
  await submit("第三轮：直接回答 1+1 等于几，不要写任何文件。");
  await expect(page.locator(".messages > article.message.user")).toHaveCount(3, { timeout: 60_000 });

  // Exactly two preview cards: one per round, never a global bottom duplicate.
  await expect(page.locator(".result-preview")).toHaveCount(2, { timeout: 60_000 });
  const order = await flowOrder(page);
  const previewPositions = order.flatMap((entry, index) => entry === "artifact-preview" ? [index] : []);
  expect(previewPositions.length, `two previews in ${order.join()}`).toBe(2);
  const userPositions = order.flatMap((entry, index) => entry === "user-message" ? [index] : []);
  const secondUser = userPositions[1]!;
  const thirdUser = userPositions[2]!;
  expect(previewPositions[0]!, `first preview must sit in round 1 of ${order.join()}`).toBeLessThan(secondUser);
  expect(previewPositions[1]!, `second preview must sit in round 2 of ${order.join()}`).toBeGreaterThan(secondUser);
  expect(previewPositions[1]!, `second preview must precede round 3 in ${order.join()}`).toBeLessThan(thirdUser);

  const firstPreview = page.locator(".result-preview", { hasText: "findings-a.md" });
  const secondPreview = page.locator(".result-preview", { hasText: "findings-b.md" });
  // Both default to collapsed summaries naming their file.
  await expect(firstPreview).not.toHaveAttribute("open", "");
  await expect(secondPreview).not.toHaveAttribute("open", "");
  await page.screenshot({ path: `${SCREENSHOTS}/06-artifacts-anchored.png`, fullPage: true });

  // Expanding the round-1 card renders its markdown.
  await firstPreview.locator("summary").click();
  await expect(firstPreview).toHaveAttribute("open", "");
  await expect(firstPreview.locator(".paper-preview")).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SCREENSHOTS}/07-artifact-expanded.png`, fullPage: true });

  // Reload: same two cards in the same positions.
  await page.reload();
  await selectInlineCardsSession();
  await expect(page.locator(".result-preview")).toHaveCount(2, { timeout: 60_000 });
  const orderAfterReload = await flowOrder(page);
  expect(orderAfterReload).toEqual(order);
  await page.screenshot({ path: `${SCREENSHOTS}/08-artifacts-after-reload.png`, fullPage: true });
});
