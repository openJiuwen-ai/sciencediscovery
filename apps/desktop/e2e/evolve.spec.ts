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
 * Program evolution as a desktop surface: the card at the foot of the
 * transcript that keeps a search reachable, the 任务 tab of the right column
 * that reads one, and the two ways in — the create dialog and the command
 * typed into the composer.
 *
 * The searches are started by the conversation, not by a form, so the mock
 * serves a run that already exists and lets the specs read it as a reader
 * would: open it, pick a candidate, see why it was rejected, stop it.
 */
import { expect, test, type Page } from "@playwright/test";

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

/** 会话设置's first row is the way into a search: the header no longer
 *  carries an evolve capsule of its own. */
async function sendWithoutScope(page: Page): Promise<void> {
  await page.getByRole("dialog", { name: "确认演进设置" })
    .getByRole("button", { name: "开始演进" }).click();
}

async function openEvolve(page: Page): Promise<void> {
  await page.getByRole("button", { name: "会话设置" }).click();
  await page.getByRole("button", { name: "程序演进实验" }).click();
}

test("a search stays reachable after its turn and opens in the task tab", async ({ page }) => {
  const mock = await installMockApi(page, {
    evolveRunsBySession: { "session-1": [liveRun()] },
    evolveSources: {
      "sha256:a": "def fit(x):\n    cache = {}\n    return x\n",
      "sha256:root": "def fit(x):\n    return x\n",
    },
    // The card is the last block of the answer that started the search, so the
    // session has to have one: a conversation with no transcript shows the
    // landing view instead.
    sessions: [makeSession({
      messages: [
        { content: "让压缩比更高", createdAt: CREATED_AT, id: "message-user", role: "user" },
        {
          content: "评分装置能明确区分好坏候选，搜索已在后台启动。",
          createdAt: CREATED_AT,
          id: "message-assistant",
          role: "assistant",
        },
      ],
    })],
  });
  await page.goto("/");

  // The card lives in the transcript, so the search is reached the way its
  // answer is: by opening the session it belongs to.
  await page.locator(".side-session-name", { hasText: "晶体结构分析" }).click();
  await expect(page.locator(".evolve-run-card")).toBeVisible();
  await expect(page.locator(".evolve-run-title")).toHaveText("让压缩比更高");
  await page.locator(".evolve-run-card").first().click();

  // The detail is a mode of the right column, not a dialog over the page: the
  // conversation stays readable while the search is watched.
  const panel = page.locator(".workspace-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(panel.getByRole("tab", { name: "任务" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#evolve-panel-title")).toHaveText("让压缩比更高");
  await expect(page.locator(".evolve-overview-value").first()).toContainText("0.6100");
  await expect(page.locator(".evolve-chart-line")).toBeVisible();
  await expect(page.locator(".evolve-node-row")).toHaveCount(2);
  // The title row carries the stop control and no close button: leaving the
  // task is a tab change or the column's own collapse.
  await expect(page.locator(".evolve-task-head").getByRole("button")).toHaveCount(1);

  await page.locator(".evolve-node-row").filter({ hasText: "Node #1" }).click();
  await expect(page.locator(".evolve-drawer")).toContainText("缓存 fit 的结果");
  await expect(page.locator(".evolve-diff-row.is-added")).toContainText("cache");
  // The drawer sits over the column, as the handoff draws it, so it is closed
  // before the title row is used again.
  await page.locator(".evolve-drawer-close").first().click();
  await expect(page.locator(".evolve-drawer")).toHaveCount(0);

  // A node opens the same detail wherever it is drawn: the tree and the chart
  // name the same candidate as the list does, and pressing one is not a pan.
  await page.locator(".evolve-tree-node").filter({ hasText: "#1" }).click();
  await expect(page.locator(".evolve-drawer")).toContainText("缓存 fit 的结果");
  await page.locator(".evolve-drawer-close").first().click();

  await page.locator(".evolve-chart-hit[aria-label^='#1']").click();
  await expect(page.locator(".evolve-drawer")).toContainText("缓存 fit 的结果");
  await page.locator(".evolve-drawer-close").first().click();

  await page.locator(".evolve-task-stop").click();
  expect(
    mock.calls.some(
      (call) => call.method === "POST" && call.path === "/api/evolve/runs/evolve-1/stop",
    ),
  ).toBe(true);

  // Switching back to the artifacts is how the detail is left; Escape is not
  // a way out of a column.
  await panel.getByRole("tab", { name: "产物" }).click();
  await expect(page.locator(".evolve-detail")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(panel).toBeVisible();
  // The card remains in the transcript: leaving the task is not stopping the
  // search.
  await expect(page.locator(".evolve-run-card")).toBeVisible();
});

test("a search started in this window opens its task tab by itself", async ({ page }) => {
  await installMockApi(page, { sessions: [makeSession()] });
  // The run appears only once this window has sent the command, which is the
  // case the auto-open is for: a run already on record must not steal the
  // column when its Session is merely opened.
  let started = false;
  const fixture = liveRun();
  await page.route(
    (url) => url.pathname === "/api/evolve/runs",
    async (route) => {
      const sessionId = new URL(route.request().url()).searchParams.get("sessionId");
      const now = new Date().toISOString();
      const runs = started && sessionId === "session-1"
        ? [{ ...fixture.run, createdAt: now, startedAt: now }]
        : [];
      await route.fulfill({
        body: JSON.stringify(runs),
        contentType: "application/json",
        status: 200,
      });
    },
  );
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  started = true;
  await page.locator("#composer-textarea").fill("/evolve-design 让压缩比更高");
  await page.locator("#composer-textarea").press("Enter");
  await sendWithoutScope(page);

  await expect(page.locator(".evolve-detail")).toBeVisible({ timeout: 10_000 });
  await expect(
    page.locator(".workspace-panel").getByRole("tab", { name: "任务" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#evolve-panel-title")).toHaveText("让压缩比更高");
});

test("the create dialog hands the goal to the conversation as the command", async ({ page }) => {
  const mock = await installMockApi(page, { sessions: [makeSession()] });
  await page.goto("/");

  await openEvolve(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("新建程序演进实验");
  await expect(dialog.getByRole("switch", { name: "自定义 JSON 与修改范围" })).toHaveCount(0);
  const originalWidth = await dialog.evaluate((element) => getComputedStyle(element).width);

  await dialog.getByRole("button", { name: "开始设计" }).click();

  // The command is placed in the composer as a token, and nothing is sent yet:
  // the goal is the sentence the user writes after it.
  await expect(dialog).toBeHidden();
  await expect(page.locator(".composer-command")).toHaveText("/evolve-design --algorithm puct");
  await expect(page.locator("#composer-textarea")).toHaveValue("");
  expect(posts(mock)).toHaveLength(0);

  await page.locator("#composer-textarea").fill("让压缩比更高，且完全无损");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "确认演进设置" });
  await expect(settings).toBeVisible();
  expect(await settings.evaluate((element) => getComputedStyle(element).width)).toBe(originalWidth);
  const pause = settings.getByRole("switch", { name: /检查点需要人工确认/ });
  await expect(pause).toBeChecked();
  await pause.uncheck();
  expect(posts(mock)).toHaveLength(0);
  await settings.getByRole("radio", { name: /OpenEvolve/ }).click();
  await expect(settings.getByLabel("上传 JSON")).toBeHidden();
  await settings.getByRole("switch", { name: "自定义 JSON 与修改范围" }).check();
  await expect(settings.getByRole("button", { name: "开始演进" })).toBeDisabled();
  await settings.getByLabel("上传 JSON").setInputFiles({
    name: "compression.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"window":8,"capacity":32}'),
  });
  await settings.getByRole("checkbox", { name: "允许修改 window" }).check();
  await settings.getByRole("button", { name: "开始演进" }).click();
  await expect.poll(() =>
    mock.calls.some(
      (call) =>
        call.method === "POST" &&
        call.path === "/api/sessions/session-1/messages" &&
        call.body?.includes("/evolve-design --algorithm openevolve --no-confirm 让压缩比更高，且完全无损") === true
        && call.body?.includes("evolve-input") === true
        && call.body?.includes("window") === true,
    ),
  ).toBe(true);
  // The token belonged to that message, not to the composer.
  await expect(page.locator(".composer-command")).toHaveCount(0);
});

test("the create dialog can send a design that does not pause at checkpoints", async ({ page }) => {
  const mock = await installMockApi(page, { sessions: [makeSession()] });
  await page.goto("/");

  await openEvolve(page);
  const dialog = page.getByRole("dialog");

  // Pausing is the default, so a user who never touches the switch keeps the
  // pace every run had before it existed.
  const pause = dialog.getByRole("switch", { name: /检查点需要人工确认/ });
  await expect(pause).toBeChecked();
  await pause.click();
  await expect(pause).not.toBeChecked();

  await dialog.getByRole("button", { name: "开始设计" }).click();
  await expect(page.locator(".composer-command")).toHaveText("/evolve-design --algorithm puct --no-confirm");
  await expect(page.locator("#composer-textarea")).toHaveValue("");
  // The token survives being completed, and it is joined to the sentence on
  // the way out — the pace the switch chose is still the command's flag.
  await page.locator("#composer-textarea").fill("让压缩比更高，并且要快");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await sendWithoutScope(page);
  await expect.poll(() =>
    mock.calls.some(
      (call) =>
        call.method === "POST" &&
        call.path === "/api/sessions/session-1/messages" &&
        call.body?.includes("/evolve-design --algorithm puct --no-confirm 让压缩比更高，并且要快") === true,
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

  await openEvolve(page);
  const dialog = page.getByRole("dialog");
  // The risk is stated before anything is chosen, not hidden behind a switch.
  await expect(dialog.getByRole("note")).toContainText("没有沙箱的情况下运行候选代码");

  // Starting asks first, and a dismissed alert sends nothing.
  await dialog.getByRole("button", { name: "开始设计" }).click();
  const alert = page.getByRole("alertdialog");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("没有沙箱、没有CPU/内存限制");
  await alert.getByRole("button", { name: "取消", exact: true }).click();
  await expect(alert).toBeHidden();
  await expect(dialog).toBeVisible();
  expect(posts(mock)).toHaveLength(0);

  await dialog.getByRole("button", { name: "开始设计" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "仍然继续" }).click();
  // The answer became the command's flag, and the token carries it into the
  // message the user finally sends.
  await expect(page.locator(".composer-command")).toHaveText("/evolve-design --algorithm puct --allow-direct");
  await expect(page.locator("#composer-textarea")).toHaveValue("");
  expect(posts(mock)).toHaveLength(0);

  await page.locator("#composer-textarea").fill("让压缩比更高");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await sendWithoutScope(page);
  await expect.poll(() =>
    mock.calls.some(
      (call) =>
        call.method === "POST" &&
        call.path === "/api/sessions/session-1/messages" &&
        call.body?.includes("/evolve-design --algorithm puct --allow-direct 让压缩比更高") === true,
    ),
  ).toBe(true);
});

test("a typed design command on a host with no sandbox detours through the confirmation", async ({ page }) => {
  const mock = await installMockApi(page, {
    evolveStatus: { canInitialize: true, sandbox: "direct", state: "ready" },
    sessions: [makeSession()],
  });
  await page.goto("/");

  // The dialog is the only place this installation can collect the consent,
  // so a command typed straight into the composer does not skip it — the goal
  // is carried over rather than sent to an agent that would design a run the
  // server then refuses.
  // The landing page is remounted when the boot finishes opening the session,
  // which clears a draft typed before that; wait for the reads to settle.
  await page.waitForLoadState("networkidle");
  await page.locator("#composer-textarea").fill("/evolve-design --algorithm openevolve 让压缩比更高");
  await page.locator("#composer-textarea").press("Enter");

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // The goal is not collected a second time: it travels back to the composer
  // with the token when the dialog closes.
  await expect(dialog.getByLabel("优化目标")).toHaveCount(0);
  // The search the command named is selected, not the dialog's own default.
  await expect(dialog.getByRole("radio", { name: /OpenEvolve/ })).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByRole("note")).toContainText("没有沙箱的情况下运行候选代码");
  expect(posts(mock)).toHaveLength(0);

  await dialog.getByRole("button", { name: "开始设计" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "仍然继续" }).click();
  await expect(page.locator(".composer-command")).toHaveText(
    "/evolve-design --algorithm openevolve --allow-direct",
  );
  await expect(page.locator("#composer-textarea")).toHaveValue("让压缩比更高");
  expect(posts(mock)).toHaveLength(0);

  await page.getByRole("button", { name: "发送", exact: true }).click();
  await sendWithoutScope(page);
  await expect.poll(() =>
    mock.calls.some(
      (call) =>
        call.method === "POST" &&
        call.path === "/api/sessions/session-1/messages" &&
        call.body?.includes("/evolve-design --algorithm openevolve --allow-direct 让压缩比更高") === true,
    ),
  ).toBe(true);
});

test("a pasted --allow-direct does not answer the warning in the user's place", async ({ page }) => {
  const mock = await installMockApi(page, {
    evolveStatus: { canInitialize: true, sandbox: "direct", state: "ready" },
    sessions: [makeSession()],
  });
  await page.goto("/");

  // A pasted flag is a word typed without the warning on screen. The dialog
  // still asks, and the flag leaves only after the answer is given here.
  await page.waitForLoadState("networkidle");
  await page.locator("#composer-textarea").fill("/evolve-design --allow-direct 让压缩比更高");
  await page.locator("#composer-textarea").press("Enter");

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("优化目标")).toHaveCount(0);
  expect(posts(mock)).toHaveLength(0);

  await dialog.getByRole("button", { name: "开始设计" }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  expect(posts(mock)).toHaveLength(0);

  await page.getByRole("alertdialog").getByRole("button", { name: "仍然继续" }).click();
  await expect(page.locator(".composer-command")).toHaveText("/evolve-design --algorithm puct --allow-direct");
  expect(posts(mock)).toHaveLength(0);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await sendWithoutScope(page);
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

  // The landing page is remounted when the boot finishes opening the session,
  // which clears a draft typed before that; wait for the reads to settle.
  await page.waitForLoadState("networkidle");
  await page.locator("#composer-textarea").fill("/evolve");
  const row = page.locator(".composer-skills .expert-row").first();
  await expect(row).toContainText("程序演进设计");
  await row.click();

  // The pick opens the dialog that collects the command's two flags: which
  // search, and whether it pauses at checkpoints.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("新建程序演进实验");
  await expect(dialog.getByRole("radiogroup", { name: "选择搜索算法" })).toBeVisible();
  await expect(dialog.getByRole("radio", { name: /PUCT算法/ })).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByRole("switch", { name: /检查点需要人工确认/ })).toBeChecked();
  // The command was not merely written into the draft: the composer is empty
  // and the slash was never sent.
  await expect(page.locator("#composer-textarea")).toHaveValue("");
  expect(posts(mock)).toHaveLength(0);
});

test("a missing runtime greys out the start and is installed from the details", async ({
  page,
}) => {
  const mock = await installMockApi(page, {
    evolveStatus: { canInitialize: true, state: "not_initialized" },
    sessions: [makeSession()],
  });
  await page.goto("/");

  await openEvolve(page);
  const dialog = page.getByRole("dialog", { name: "新建程序演进实验" });
  // The form is not replaced by a setup pane: the search cards keep their
  // place and only the button that cannot work is disabled.
  await expect(dialog.getByRole("radiogroup", { name: "选择搜索算法" })).toBeVisible();
  await expect(dialog.getByRole("note").filter({ hasText: "优化进程不可用" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "开始设计" })).toBeDisabled();

  // 查看详情 explains where to look on this machine and offers the install.
  await dialog.getByRole("button", { name: "查看详情" }).click();
  const details = page.getByRole("dialog", { name: "演化运行时不可用" });
  await expect(details).toBeVisible();
  await expect(details).toContainText("api.log");
  await expect(details).toContainText("shell.log");

  await details.getByRole("button", { name: "准备运行时" }).click();
  expect(
    mock.calls.some((call) => call.method === "POST" && call.path === "/api/evolve/init"),
  ).toBe(true);

  // A ready runtime retires the explanation and unblocks the form.
  await expect(details).toBeHidden();
  await expect(dialog.getByRole("note")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "开始设计" })).toBeEnabled();
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

  await page.waitForLoadState("networkidle");
  await page.locator("#composer-textarea").fill("/evolve-design 让压缩比更高");
  await page.locator("#composer-textarea").press("Enter");
  await sendWithoutScope(page);

  const card = page.locator(".evolve-checkpoint");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-step", "1");
  // The band names the state and carries the step counter at its right end.
  // Four steps, three checkpoints: the last step never asks.
  await expect(card).toContainText("检查点等待确认");
  await expect(card).toContainText("1/3");
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
        // The reply names the step: six identical "继续" left the model unable
        // to tell which checkpoint it was answering. It counts the checkpoints
        // the reader answers, not the steps: this card has four steps and its
        // last one is the record, so the band above says 1/3 and so does this.
        call.body?.includes("确认检查点 1/3，继续。") === true,
    ),
  ).toBe(true);
});

test("an automatic checkpoint is shown but asks for nothing, and the flow carries on", async ({ page }) => {
  const mock = await installMockApi(page, {
    assistantAnswer: checkpointAnswer({ pace: "auto", step: 3 }),
    sessions: [makeSession()],
  });
  await page.goto("/");

  await page.waitForLoadState("networkidle");
  await page.locator("#composer-textarea").fill("/evolve-design --no-confirm 让压缩比更高");
  await page.locator("#composer-textarea").press("Enter");
  await sendWithoutScope(page);

  const card = page.locator(".evolve-checkpoint").first();
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-pace", "auto");
  // A card nobody approves is a step, not a checkpoint, and carries no badge.
  await expect(card).toContainText("步骤");
  // A record is not a checkpoint: no counter, and nothing to press.
  await expect(card.locator(".evolve-checkpoint-count")).toHaveCount(0);
  await expect(card).not.toContainText("自动");
  await expect(card.getByRole("button")).toHaveCount(0);

  // Nobody is going to press anything, so the client starts the next turn: a
  // design that ends its turn on an auto card would otherwise stop at step 3.
  await expect.poll(() =>
    mock.calls.filter(
      (call) => call.method === "POST" && call.body?.includes("继续步骤 3/4。") === true,
    ).length,
  ).toBe(1);
  // Once. The mock answers the continuation with the same card, and a second
  // carry-forward would be a loop.
  await expect(page.locator(".evolve-checkpoint").nth(1)).toBeVisible();
  expect(
    mock.calls.filter((call) => call.body?.includes("继续步骤 3/4。") === true),
  ).toHaveLength(1);
});

test("a second no-confirm design is pushed although the first one started a search", async ({ page }) => {
  // The run list is per Session, so the first design's search is still in it,
  // created after that design's own command. The second design's command is
  // still only pending when its first turn ends — the transcript is written
  // when the turn settles — so "does this design have a search" has to answer
  // for the design being sent, not the one already in the transcript.
  const first = liveRun();
  const mock = await installMockApi(page, {
    assistantAnswer: "我又核对了一遍评测器。",
    evolveRunsBySession: {
      "session-1": [{ ...first, run: { ...first.run, createdAt: "2026-10-01T07:30:00.000Z" } }],
    },
    sessions: [makeSession({
      messages: [
        {
          content: "/evolve-design --no-confirm 第一个目标",
          createdAt: "2026-10-01T07:00:00.000Z",
          id: "message-design-1",
          role: "user",
        },
        {
          content: "第一个设计已经启动搜索。",
          createdAt: "2026-10-01T07:05:00.000Z",
          id: "message-assistant-1",
          role: "assistant",
        },
      ],
    })],
  });
  await page.goto("/");
  await page.locator(".side-session-name", { hasText: "晶体结构分析" }).click();

  await page.locator("#composer-textarea").fill("/evolve-design --no-confirm 第二个目标");
  await page.locator("#composer-textarea").press("Enter");
  await sendWithoutScope(page);

  // The turn ended with prose, no card and no search: the client sends the one
  // sentence that names what the turn owed.
  await expect.poll(() =>
    mock.calls.filter(
      (call) => call.method === "POST" && call.body?.includes("create_evolve_run") === true,
    ).length,
  ).toBe(1);
  // Once. The mock answers the push with the same prose, and a second carry
  // forward would be a paid turn that changes nothing.
  await page.waitForTimeout(500);
  expect(
    mock.calls.filter(
      (call) => call.method === "POST" && call.body?.includes("create_evolve_run") === true,
    ),
  ).toHaveLength(1);
});

test("a checkpoint's change button writes the note in the card and sends it from there", async ({ page }) => {
  const mock = await installMockApi(page, {
    assistantAnswer: checkpointAnswer({ step: 2 }),
    sessions: [makeSession()],
  });
  await page.goto("/");

  await page.waitForLoadState("networkidle");
  await page.locator("#composer-textarea").fill("/evolve-design 让压缩比更高");
  await page.locator("#composer-textarea").press("Enter");
  await sendWithoutScope(page);

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
  // One answer while the note is open, as the card draws it: confirming is
  // what sends the change.
  await card.getByRole("button", { name: "确认，继续" }).click();

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
