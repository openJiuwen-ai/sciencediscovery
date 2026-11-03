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
 * Program evolution as a desktop surface: the shelf that keeps a search
 * reachable, the cockpit that reads one, and the two ways in — the create
 * dialog and the command typed into the composer.
 *
 * The searches are started by the conversation, not by a form, so the mock
 * serves a run that already exists and lets the specs read it as a reader
 * would: open it, pick a candidate, see why it was rejected, stop it.
 */
import { expect, test } from "@playwright/test";

import {
  CREATED_AT,
  TOKEN,
  TOKEN_STORAGE_KEY,
  installMockApi,
  makeSession,
  type EvolveFixture,
} from "./fixtures.js";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [TOKEN_STORAGE_KEY, TOKEN] as const,
  );
});

/** One live search that has produced one accepted candidate. */
function liveRun(): EvolveFixture {
  return {
    events: [
      { algorithm: "puct", scorecardHash: "sha256:card", type: "search_started" },
      { baselineScore: 0.41, codeHash: "sha256:root", nodeIndex: 0, type: "seeded" },
      { ancestorVisits: [{ nodeIndex: 0, visits: 1 }], nodeIndex: 1, type: "selected" },
      {
        changeSummary: "缓存 fit 的结果",
        codeHash: "sha256:a",
        depth: 1,
        nodeIndex: 1,
        parentIndex: 0,
        score: 0.58,
        valid: true,
        type: "expanded",
      },
      { gateScore: 0.61, nodeIndex: 1, rolloutScore: 0.58, type: "evaluated" },
      { accepted: true, nodeIndex: 1, type: "merged" },
    ],
    run: {
      algorithm: "puct",
      candidates: 2,
      costCents: 12,
      createdAt: CREATED_AT,
      goal: {
        algorithm: "puct",
        budget: {
          candidateTimeoutSeconds: 120,
          expansions: 20,
          maxCostCents: 200,
          maxSeconds: 900,
          maxTokens: 100_000,
          workers: 1,
        },
        scorecard: { hash: "sha256:card" },
        statement: "让压缩比更高",
      },
      id: "evolve-1",
      lastSeq: 6,
      sessionId: "session-1",
      startedAt: CREATED_AT,
      status: "running",
      tokens: 5_000,
    },
  };
}

test("a search stays reachable after its turn and opens as a cockpit", async ({ page }) => {
  const mock = await installMockApi(page, {
    evolveRunsBySession: { "session-1": [liveRun()] },
    evolveSources: {
      "sha256:a": "def fit(x):\n    cache = {}\n    return x\n",
      "sha256:root": "def fit(x):\n    return x\n",
    },
    sessions: [makeSession()],
  });
  await page.goto("/");

  await expect(page.locator(".evolve-shelf")).toBeVisible();
  await expect(page.locator(".evolve-chip-title")).toHaveText("让压缩比更高");
  await page.locator(".evolve-chip").first().click();

  const panel = page.getByRole("dialog");
  await expect(panel).toBeVisible();
  await expect(page.locator("#evolve-panel-title")).toHaveText("让压缩比更高");
  await expect(page.locator(".evolve-hero-value")).toHaveText("0.6100");
  await expect(page.locator(".evolve-chart-line")).toBeVisible();
  await expect(page.locator("tr.evolve-row")).toHaveCount(2);

  await page.locator("tr.evolve-row").filter({
    has: page.locator(".evolve-cell-node", { hasText: /^#1$/ }),
  }).click();
  await expect(page.locator(".evolve-inspector")).toContainText("缓存 fit 的结果");
  await expect(page.locator(".evolve-diff-row.is-added")).toContainText("cache");

  await page.getByRole("button", { name: "停止", exact: true }).click();
  expect(
    mock.calls.some(
      (call) => call.method === "POST" && call.path === "/api/evolve/runs/evolve-1/stop",
    ),
  ).toBe(true);

  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  // The shelf remains: closing the panel is not stopping the search.
  await expect(page.locator(".evolve-shelf")).toBeVisible();
});

test("the create dialog hands the goal to the conversation as the command", async ({ page }) => {
  const mock = await installMockApi(page, { sessions: [makeSession()] });
  await page.goto("/");

  await page.getByRole("button", { name: "程序演进" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("新建程序演进实验");

  await dialog.getByLabel("优化目标").fill("让压缩比更高，且完全无损");
  await dialog.getByRole("button", { name: "开始设计" }).click();

  await expect(dialog).toBeHidden();
  await expect.poll(() =>
    mock.calls.some(
      (call) =>
        call.method === "POST" &&
        call.path === "/api/sessions/session-1/messages" &&
        call.body?.includes("/evolve-design --algorithm puct 让压缩比更高，且完全无损") === true,
    ),
  ).toBe(true);
});

test("the create dialog can send a design that does not pause at checkpoints", async ({ page }) => {
  const mock = await installMockApi(page, { sessions: [makeSession()] });
  await page.goto("/");

  await page.getByRole("button", { name: "程序演进" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("优化目标").fill("让压缩比更高");

  // Pausing is the default, so a user who never touches the switch keeps the
  // pace every run had before it existed.
  const pause = dialog.getByRole("switch", { name: /检查点需要人工确认/ });
  await expect(pause).toBeChecked();
  await pause.click();
  await expect(pause).not.toBeChecked();

  await dialog.getByRole("button", { name: "开始设计" }).click();
  await expect.poll(() =>
    mock.calls.some(
      (call) =>
        call.method === "POST" &&
        call.path === "/api/sessions/session-1/messages" &&
        call.body?.includes("/evolve-design --algorithm puct --no-confirm 让压缩比更高") === true,
    ),
  ).toBe(true);
});

test("a missing runtime is installed from the dialog before the form appears", async ({
  page,
}) => {
  const mock = await installMockApi(page, {
    evolveStatus: { canInitialize: true, state: "not_initialized" },
    sessions: [makeSession()],
  });
  await page.goto("/");

  await page.getByRole("button", { name: "程序演进" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("需要准备演化运行时");

  await dialog.getByRole("button", { name: "准备运行时" }).click();
  await expect(dialog.getByLabel("优化目标")).toBeVisible();
  expect(
    mock.calls.some((call) => call.method === "POST" && call.path === "/api/evolve/init"),
  ).toBe(true);
});
