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
  type Mock,
  type RecordedCall,
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

test("a host with no sandbox asks for the no-isolation confirmation before sending", async ({ page }) => {
  const mock = await installMockApi(page, {
    // What a Windows installation reports: no bubblewrap, no Seatbelt.
    evolveStatus: { canInitialize: true, sandbox: "direct", state: "ready" },
    sessions: [makeSession()],
  });
  await page.goto("/");

  await page.getByRole("button", { name: "程序演进" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("优化目标").fill("让压缩比更高");

  // Off by default: the switch cannot give consent on the user's behalf.
  const consent = dialog.getByRole("switch", { name: /允许无隔离直接运行候选代码/ });
  await expect(consent).toBeVisible();
  await expect(consent).not.toBeChecked();

  await consent.click();
  await dialog.getByRole("button", { name: "开始设计" }).click();
  await expect.poll(() =>
    mock.calls.some(
      (call) =>
        call.method === "POST" &&
        call.path === "/api/sessions/session-1/messages" &&
        call.body?.includes("/evolve-design --algorithm puct --allow-direct 让压缩比更高") === true,
    ),
  ).toBe(true);
});

test("a typed design command on a host with no sandbox detours through the consent switch", async ({ page }) => {
  const mock = await installMockApi(page, {
    evolveStatus: { canInitialize: true, sandbox: "direct", state: "ready" },
    sessions: [makeSession()],
  });
  await page.goto("/");

  // The dialog is the only place this installation can collect the consent,
  // so a command typed straight into the composer does not skip it — the goal
  // is carried over rather than sent to an agent that would design a run the
  // server then refuses.
  await page.locator("#composer-textarea").fill("/evolve-design 让压缩比更高");
  await page.locator("#composer-textarea").press("Enter");

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("优化目标")).toHaveValue("让压缩比更高");
  const consent = dialog.getByRole("switch", { name: /允许无隔离直接运行候选代码/ });
  await expect(consent).not.toBeChecked();
  expect(posts(mock)).toHaveLength(0);

  await consent.click();
  await dialog.getByRole("button", { name: "开始设计" }).click();
  await expect.poll(() =>
    mock.calls.some(
      (call) =>
        call.method === "POST" &&
        call.path === "/api/sessions/session-1/messages" &&
        call.body?.includes("/evolve-design --algorithm puct --allow-direct 让压缩比更高") === true,
    ),
  ).toBe(true);
});

test("picking the evolve skill from the slash palette opens the setup dialog", async ({ page }) => {
  const mock = await installMockApi(page, {
    sessions: [makeSession()],
    skills: [
      {
        currentRevision: 1,
        declaredVersion: "1.3.0",
        description: "设计评分卡并启动一次程序演进",
        diagnostics: [],
        hash: "hash-evolve",
        id: "evolve-design",
        name: "程序演进设计",
        readOnly: true,
        resourceSummary: { bytes: 2, files: 1, kinds: {} },
        source: "built-in",
      },
    ],
  });
  await page.goto("/");

  await page.locator("#composer-textarea").fill("/evolve");
  const row = page.locator(".composer-skills .expert-row").first();
  await expect(row).toContainText("程序演进设计");
  await row.click();

  // The pick opens the dialog that collects the command's two flags: which
  // search, and whether it pauses at checkpoints.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("新建程序演进实验");
  await expect(dialog.getByLabel("优化目标")).toBeVisible();
  await expect(dialog.getByRole("radiogroup", { name: "搜索算法" })).toBeVisible();
  await expect(dialog.getByRole("switch", { name: /检查点需要人工确认/ })).toBeChecked();
  // The command was not merely written into the draft: the composer is empty
  // and the slash was never sent.
  await expect(page.locator("#composer-textarea")).toHaveValue("");
  expect(posts(mock)).toHaveLength(0);
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

/** The answer the design skill writes at a checkpoint: one line of prose, then
 *  the fenced block the desktop turns into a card. */
function checkpointAnswer(over: Record<string, string | number> = {}): string {
  const fields = {
    pace: "confirm",
    step: 1,
    title: "什么算“更好”",
    total: 4,
    ...over,
  };
  return [
    "评分卡已经定好，先停在这里。",
    "",
    "```evolve-checkpoint",
    ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`),
    "---",
    "**度量：** 压缩比",
    "",
    "**冻结：** 不许使用现成压缩库",
    "```",
  ].join("\n");
}

test("a checkpoint arrives as a card and its confirmation is sent as the reply", async ({ page }) => {
  const mock = await installMockApi(page, {
    assistantAnswer: checkpointAnswer(),
    sessions: [makeSession()],
  });
  await page.goto("/");

  await page.locator("#composer-textarea").fill("/evolve-design 让压缩比更高");
  await page.locator("#composer-textarea").press("Enter");

  const card = page.locator(".evolve-checkpoint");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-step", "1");
  await expect(card).toContainText("检查点 1/4");
  await expect(card).toContainText("等待确认");
  await expect(card).toContainText("什么算“更好”");
  await expect(card).toContainText("压缩比");
  // The fence is the card, not a code block printed above it.
  await expect(page.locator("pre", { hasText: "evolve-checkpoint" })).toHaveCount(0);

  await card.getByRole("button", { name: "确认，继续" }).click();
  await expect.poll(() =>
    mock.calls.some(
      (call) =>
        call.method === "POST" &&
        call.path === "/api/sessions/session-1/messages" &&
        call.body?.includes("确认，继续。") === true,
    ),
  ).toBe(true);
});

test("an automatic checkpoint is shown but asks for nothing", async ({ page }) => {
  await installMockApi(page, {
    assistantAnswer: checkpointAnswer({ pace: "auto", step: 3 }),
    sessions: [makeSession()],
  });
  await page.goto("/");

  await page.locator("#composer-textarea").fill("/evolve-design --no-confirm 让压缩比更高");
  await page.locator("#composer-textarea").press("Enter");

  const card = page.locator(".evolve-checkpoint");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-pace", "auto");
  await expect(card).toContainText("检查点 3/4");
  await expect(card).toContainText("自动");
  await expect(card.getByRole("button")).toHaveCount(0);
});

test("a checkpoint's change button writes the note in the card and sends it from there", async ({ page }) => {
  const mock = await installMockApi(page, {
    assistantAnswer: checkpointAnswer({ step: 2 }),
    sessions: [makeSession()],
  });
  await page.goto("/");

  await page.locator("#composer-textarea").fill("/evolve-design 让压缩比更高");
  await page.locator("#composer-textarea").press("Enter");

  const card = page.locator(".evolve-checkpoint");
  await expect(card).toBeVisible();
  // The buttons are live only once the reply that carries the card has ended.
  const adjust = card.getByRole("button", { name: "需要调整" });
  await expect(adjust).toBeEnabled();
  await adjust.click();

  // The note is written where the step is, not in the composer.
  const note = card.getByRole("textbox");
  await expect(note).toBeVisible();
  await expect(page.locator("#composer-textarea")).toHaveValue("");
  // Nothing is sent until the reader has said what should change.
  expect(posts(mock)).toHaveLength(1);
  await note.fill("字数少一点，别动结构");
  await card.getByRole("button", { name: "发送" }).click();

  await expect.poll(() => posts(mock).length).toBe(2);
  const sent = posts(mock)[1]!.body ?? "";
  expect(sent).toContain("我想调整这一步：字数少一点，别动结构");
  // The composer stayed out of it: the sentence was never seeded there.
  await expect(page.locator("#composer-textarea")).toHaveValue("");
});

function posts(mock: Mock): RecordedCall[] {
  return mock.calls.filter(
    (call) => call.method === "POST" && call.path === "/api/sessions/session-1/messages",
  );
}
