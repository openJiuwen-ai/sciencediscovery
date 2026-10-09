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
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { test } from "./helpers/e2e.ts";
import {
  cleanupJourney,
  createProjectAndSession,
  openProjectSession,
  scriptedModel,
  sendUserMessage,
  waitForRunTerminal,
  type JourneyFixture,
} from "./helpers/journeys.ts";

// Static suite metadata is inherited by each framework-expanded journey.
test.describe("issue-85-foreground-exec-inbox.spec", { tag: ["@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"] }, () => {

test.use({ locale: "zh-CN" });

interface SessionRunRecord {
  automaticWake?: boolean;
  id: string;
  notificationDelivery?: { agentId: string };
  status: string;
}

interface SubagentRecord {
  error?: string;
  finishedAt?: string;
  id: string;
  input: { description: string };
  status: string;
  turnCount: number;
}

const ACTIVITY_PANEL = /^(Executions and reminders|执行与提醒)$/;

async function apiGet<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.fetch(`${apiBaseUrl()}${path}`, { headers: authorizationHeader() });
  expect(response.ok(), `${path} should respond`).toBe(true);
  return await response.json() as T;
}

const runs = (page: Page, sessionId: string) => apiGet<SessionRunRecord[]>(page, `/api/sessions/${encodeURIComponent(sessionId)}/runs`);
const subagents = (page: Page, sessionId: string) => apiGet<SubagentRecord[]>(page, `/api/sessions/${encodeURIComponent(sessionId)}/subagents`);
const executions = (page: Page, sessionId: string) => apiGet<{ executions: Array<{ agentId: string; id: string; state: string }> }>(page, `/api/sessions/${encodeURIComponent(sessionId)}/agent-activity`);

/**
 * Prove a wake did not happen. The dispatcher looks at the inbox every 500 ms
 * once the Session is idle, so a Session sampled for a few seconds after its
 * run ended and its executions reached a terminal state has had every chance
 * to wake itself; the window is an observation, not a wait for a condition.
 */
async function expectNoAutomaticWake(page: Page, sessionId: string, windowMs = 4_000): Promise<void> {
  await expect.poll(async () => (await executions(page, sessionId)).executions.every((item) => !["queued", "running"].includes(item.state)),
    { message: "every execution should have reached a terminal state", timeout: 60_000 }).toBe(true);
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    const woken = (await runs(page, sessionId)).filter((run) => run.automaticWake);
    expect(woken, "an idle Session whose results were already delivered must not wake itself").toEqual([]);
    await page.waitForTimeout(250);
  }
}

async function closeWakeGateAndCleanup(page: Page, playwright: Parameters<Parameters<typeof test>[2]>[0]["playwright"], fixture: JourneyFixture | undefined) {
  const api = await playwright.request.newContext({ baseURL: apiBaseUrl(), extraHTTPHeaders: authorizationHeader() });
  try {
    if (fixture) {
      // Close the wake gate before deleting: a Session that can still start
      // runs on its own keeps its Project deletion waiting behind them.
      await api.post(`/api/sessions/${encodeURIComponent(fixture.session.id)}/runs/current/cancel`, { data: {} }).catch(() => undefined);
      await cleanupJourney(page, fixture);
      await expect.poll(async () => {
        const response = await api.get("/api/projects");
        if (!response.ok()) return true;
        return ((await response.json()) as Array<{ id: string }>).some((project) => project.id === fixture.project.id);
      }, { message: "the Project should be gone before the next journey starts", timeout: 30_000 }).toBe(false);
    }
  } finally { await api.dispose(); }
}

/**
 * E2E-META
 * Purpose: A Session whose shell work all ran in the foreground is not woken again for results its Agents already reported, and a running SubAgent card shows progress instead of "starting".
 * Steps:
 *   1. Ask for work that delegates two foreground shell commands to a SubAgent and runs one more in the main Agent; watch the SubAgent card while it runs.
 *   2. After the run ends, sample the idle Session: no automatic wake run appears, no runtime notice is inserted, the SubAgent stays completed.
 *   3. Reload and confirm the persisted conversation shows the same.
 * Environment: Isolated production API/Web at E2E_BASE_URL; Project/Session created over API; zh-CN browser locale; local sandbox Runner.
 * Type: mocked
 * LLM: journey-owned OpenAI-compatible HTTP stub on 127.0.0.1; one main turn plus one general-purpose SubAgent turn, all foreground run_shell.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — the shell runs inside the local sandbox.
 * Credentials: E2E_API_TOKEN for the isolated stack.
 * CostSideEffects: local Project/Session records, cleaned in finally; no cost.
 */
test("全部前台执行的会话空闲后不会被已交付的结果再次唤醒", { tag: "@mocked" }, async ({ journey, page, playwright }) => {
  test.setTimeout(240_000);
  journey.scenario({
    goal: "研究员让助手分工跑几条命令，全部在前台等到了结果。回答结束后会话应当安静下来，而不是被同一批结果再叫醒一轮、把已完成的助手复活。",
    preconditions: ["隔离 Web/API 已启动", "模型由本旅程自带的 HTTP 桩驱动：主脚本委派一个 general-purpose 子任务再跑一条命令，子脚本跑两条前台命令"],
  });
  const marker = `FG-${Date.now()}`;
  const stub = await scriptedModel([
    [
      {
        arguments: {
          description: "Run the foreground checks",
          prompt: "Run two shell commands in the foreground and report their output.",
          subagent_type: "general-purpose",
          timeout_seconds: 120,
        },
        tool: "task",
      },
      { arguments: { command: `printf '%s' '${marker}-main' > main.txt && cat main.txt` }, tool: "run_shell" },
      { text: `主任务和子任务都已在前台完成，标记 ${marker}。` },
    ],
  ], [
    { arguments: { command: `printf '%s' '${marker}-child-1'` }, delayMs: 4_000, tool: "run_shell" },
    { arguments: { command: `printf '%s' '${marker}-child-2'` }, delayMs: 3_000, tool: "run_shell" },
    { text: `两条命令都跑完了，标记 ${marker}。` },
  ]);
  let fixture: JourneyFixture | undefined;
  try {
    fixture = await createProjectAndSession(page, {
      approvalMode: "always_allow",
      model: { apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: `Foreground inbox model ${Date.now()}` },
      projectName: `Foreground inbox ${Date.now()}`,
      sessionTitle: "Quiet after foreground work",
    });

    await journey.step("发起分工请求并看着助手干活", "助手卡片在运行期间显示当前进行到哪一步，而不是一直「正在启动…」。", async () => {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await openProjectSession(page, fixture!);
      const run = await sendUserMessage(page, fixture!.session.id, "把两条检查命令交给助手在前台跑完，再跑一条主命令，然后总结。");
      const card = page.locator("section[aria-label='Subagent 活动'] article.subagent-card.running").first();
      await expect(card).toBeVisible({ timeout: 60_000 });
      await expect(card.locator("small")).toContainText(/当前：/, { timeout: 10_000 });
      await expect(card.locator("small")).not.toContainText("正在启动");
      expect((await waitForRunTerminal(page, fixture!.session.id, run.id)).status).toBe("completed");
    });

    await journey.step("回答结束后会话保持安静", "几秒内没有运行时自己发起的唤醒轮，对话里没有「运行时提示」，助手仍是完成态。", async () => {
      await expectNoAutomaticWake(page, fixture!.session.id);
      await expect(page.getByLabel("运行时提示")).toHaveCount(0);
      await expect(page.locator("article.subagent-card.running")).toHaveCount(0);
      // A finished child folds into a one-line record; the line itself says completed.
      const record = page.locator("section[aria-label='Subagent 活动'] details.process-agent-record").first();
      await expect(record).toBeVisible();
      await expect(record).toHaveClass(/completed/);
      await expect(page.locator(".message.assistant").last()).toContainText(marker);
      const children = await subagents(page, fixture!.session.id);
      expect(children.map((child) => child.status)).toEqual(["completed"]);
      expect(children[0]!.finishedAt).toBeTruthy();
      const finished = (await executions(page, fixture!.session.id)).executions;
      expect(finished.map((item) => item.state)).toEqual(["completed", "completed", "completed"]);
    });

    await journey.step("刷新后的对话也一样", "持久化的对话正文没有运行时提示，也没有复活助手的回复。", async () => {
      await page.reload();
      await expect(page.getByRole("heading", { exact: true, name: "Quiet after foreground work" })).toBeVisible();
      await expect(page.locator(".message.assistant").last()).toContainText(marker);
      await expect(page.getByLabel("运行时提示")).toHaveCount(0);
      await expect(page.getByText(/^Subagent Run the foreground checks:/)).toHaveCount(0);
      const record = page.locator("section[aria-label='Subagent 活动'] details.process-agent-record").first();
      await expect(record).toBeVisible();
      await expect(record).toHaveClass(/completed/);
      await expect(page.locator("article.subagent-card.running")).toHaveCount(0);
      expect((await runs(page, fixture!.session.id)).filter((run) => run.automaticWake)).toEqual([]);
    });
  } finally {
    await closeWakeGateAndCleanup(page, playwright, fixture);
    await stub.stop();
  }
});

/**
 * E2E-META
 * Purpose: A background execution still wakes its owner once, and the resulting runtime notice is a readable summary with a way to reach the execution record, never the model prompt.
 * Steps:
 *   1. Run one shell command with background: true and let the runtime wake the Agent on its own.
 *   2. Read the persisted conversation: the notice names the execution and its outcome and contains no model-facing text.
 *   3. Open the record from the notice and land on it in the activity panel.
 * Environment: Isolated production API/Web at E2E_BASE_URL; Project/Session created over API; zh-CN browser locale; local sandbox Runner.
 * Type: mocked
 * LLM: journey-owned OpenAI-compatible HTTP stub on 127.0.0.1; one deterministic user turn plus the runtime's own wake turn.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — the shell runs inside the local sandbox.
 * Credentials: E2E_API_TOKEN for the isolated stack.
 * CostSideEffects: local Project/Session records, cleaned in finally; no cost.
 */
test("后台执行仍会唤醒一次，运行时提示是可读摘要并能跳到执行记录", { tag: "@mocked" }, async ({ journey, page, playwright }) => {
  test.setTimeout(240_000);
  journey.scenario({
    goal: "研究员提交了一个后台任务就结束了本轮。任务完成后运行时应当叫醒助手一次，而对话里留下的痕迹要说人话：完成了什么、结果如何、点一下能看到记录。",
    preconditions: ["隔离 Web/API 已启动", "模型由本旅程自带的 HTTP 桩驱动"],
  });
  const marker = `BG-${Date.now()}`;
  const stub = await scriptedModel([
    [
      { arguments: { background: true, command: `printf '%s' '${marker}' > wake.txt` }, tool: "run_shell" },
      { text: `后台任务已提交，标记为 ${marker}。` },
    ],
  ]);
  let fixture: JourneyFixture | undefined;
  try {
    fixture = await createProjectAndSession(page, {
      approvalMode: "always_allow",
      model: { apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: `Background inbox model ${Date.now()}` },
      projectName: `Background inbox ${Date.now()}`,
      sessionTitle: "Woken by background work",
    });

    await journey.step("提交后台任务并等运行时自己唤醒", "结果没有交付给模型，所以完成后运行时发起且只发起一轮唤醒。", async () => {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await openProjectSession(page, fixture!);
      const run = await sendUserMessage(page, fixture!.session.id, "提交一个后台任务，然后结束本轮。");
      await waitForRunTerminal(page, fixture!.session.id, run.id);
      await expect.poll(async () => (await runs(page, fixture!.session.id))
        .filter((candidate) => candidate.automaticWake && candidate.status === "completed").length,
      { message: "the runtime should wake itself once the Execution completes", timeout: 60_000 }).toBe(1);
      await expectNoAutomaticWakeBeyond(page, fixture!.session.id, 1);
    });

    await journey.step("对话里的运行时提示说人话", "提示写明同步了几项结果、完成几项，列出是哪台 Runner 上哪个 Agent 的执行；看不到模型提示词和内部 JSON。", async () => {
      await page.reload();
      await expect(page.getByRole("heading", { exact: true, name: "Woken by background work" })).toBeVisible();
      const notice = page.getByLabel("运行时提示");
      await expect(notice).toBeVisible();
      await expect(notice).toContainText("已同步 1 项后台执行结果");
      await expect(notice).toContainText("1 项完成");
      await expect(notice).toContainText("local 上的执行 · 主 Agent");
      await expect(notice.getByRole("button", { name: "查看执行记录" })).toBeVisible();
      await expect(page.locator(".message.user")).toHaveCount(1);
      await expect(page.locator("body")).not.toContainText("[Execution notifications]");
      await expect(page.locator("body")).not.toContainText("Do not replay the command");
      const [execution] = (await executions(page, fixture!.session.id)).executions;
      await expect(page.locator(".messages")).not.toContainText(execution!.id);
    });

    await journey.step("从提示跳到执行记录", "点击后右侧工作区打开到「执行与提醒」，对应的执行记录展开可读。", async () => {
      await page.getByLabel("运行时提示").getByRole("button", { name: "查看执行记录" }).click();
      const panel = page.getByLabel(ACTIVITY_PANEL);
      await expect(panel).toBeVisible();
      const [execution] = (await executions(page, fixture!.session.id)).executions;
      const record = panel.locator("details.process-record[open]").filter({ hasText: execution!.id });
      await expect(record).toHaveCount(1);
      await expect(record).toContainText("completed");
    });
  } finally {
    await closeWakeGateAndCleanup(page, playwright, fixture);
    await stub.stop();
  }
});

/**
 * E2E-META
 * Purpose: A completed SubAgent is still woken by a background result it never read, in its own context rather than the main Agent's, and the wake leaves its completed history intact.
 * Steps:
 *   1. Delegate a task whose SubAgent submits one background shell command and reports before it finishes.
 *   2. Let the runtime wake the SubAgent; confirm the wake targets the SubAgent and its reply is filed under it.
 *   3. Confirm the SubAgent record is still completed with its finish time after the wake.
 * Environment: Isolated production API/Web at E2E_BASE_URL; Project/Session created over API; zh-CN browser locale; local sandbox Runner.
 * Type: mocked
 * LLM: journey-owned OpenAI-compatible HTTP stub on 127.0.0.1; one main turn, one SubAgent turn, plus the runtime's wake turn for the SubAgent.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — the shell runs inside the local sandbox.
 * Credentials: E2E_API_TOKEN for the isolated stack.
 * CostSideEffects: local Project/Session records, cleaned in finally; no cost.
 */
test("已完成的助手仍会被它没看过的后台结果唤醒，且不改道给主 Agent", { tag: "@mocked" }, async ({ journey, page, playwright }) => {
  test.setTimeout(240_000);
  journey.scenario({
    goal: "助手把一条命令放到后台就交了差。命令完成后应当由这位助手自己接着处理，而不是把结果塞给主 Agent，也不能把助手的完成记录抹掉。",
    preconditions: ["隔离 Web/API 已启动", "模型由本旅程自带的 HTTP 桩驱动：子脚本用 background: true 提交一条命令"],
  });
  const marker = `CHILD-BG-${Date.now()}`;
  const stub = await scriptedModel([
    [
      {
        arguments: {
          description: "Submit background work",
          prompt: "Submit one shell command in the background and report immediately.",
          subagent_type: "general-purpose",
          timeout_seconds: 120,
        },
        tool: "task",
      },
      { text: `助手已提交后台任务，标记 ${marker}。` },
    ],
  ], [
    { arguments: { background: true, command: `sleep 2 && printf '%s' '${marker}' > child.txt` }, tool: "run_shell" },
    { text: `后台命令已提交，标记 ${marker}。` },
  ]);
  let fixture: JourneyFixture | undefined;
  try {
    fixture = await createProjectAndSession(page, {
      approvalMode: "always_allow",
      model: { apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: `Child inbox model ${Date.now()}` },
      projectName: `Child inbox ${Date.now()}`,
      sessionTitle: "SubAgent woken by its own result",
    });

    let wake: SessionRunRecord | undefined;
    await journey.step("助手提交后台命令后本轮结束", "主回答结束时助手的委派轮已经跑完，后台命令还在跑或刚跑完。", async () => {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await openProjectSession(page, fixture!);
      const run = await sendUserMessage(page, fixture!.session.id, "让助手把一条命令放到后台跑，然后直接汇报。");
      expect((await waitForRunTerminal(page, fixture!.session.id, run.id)).status).toBe("completed");
      // The wake this journey is about reopens the child (reopenSubagentForContinuation
      // puts it back to "running"), and the dispatcher fires it as soon as the Session is
      // idle — measured at 0.3 s after the parent run went terminal, i.e. inside the gap
      // between these two lines. The instantaneous status is therefore a race with the
      // very wake the next step waits for; what belongs to *this* step is that the
      // delegated turn ended, which the finish time and the absent error record. The last
      // step asserts the child is completed again once the wake has closed.
      const children = await subagents(page, fixture!.session.id);
      expect(children).toHaveLength(1);
      expect(children[0]!.finishedAt, "the delegated turn should have ended").toBeTruthy();
      expect(children[0]!.error).toBeUndefined();
    });

    await journey.step("唤醒送到助手自己而不是主 Agent", "运行时为助手发起一轮唤醒，回复以助手名义记入对话。", async () => {
      await expect.poll(async () => {
        wake = (await runs(page, fixture!.session.id)).find((candidate) => candidate.automaticWake && candidate.status === "completed");
        return wake?.notificationDelivery?.agentId ?? "";
      }, { message: "the wake should be delivered to the SubAgent", timeout: 60_000 }).toMatch(/^subagent:/);
      await expectNoAutomaticWakeBeyond(page, fixture!.session.id, 1);
      await page.reload();
      await expect(page.getByLabel("运行时提示")).toContainText("local 上的执行 · Submit background work");
      await expect(page.getByLabel("运行时提示")).not.toContainText("subagent:");
      await expect(page.locator(".message.assistant").last()).toContainText("Subagent Submit background work:");
      await expect(page.locator("body")).not.toContainText("[Execution notifications]");
    });

    await journey.step("助手的完成记录没有被抹掉", "唤醒轮结束后助手仍是完成态，并保留结束时间。", async () => {
      const [child] = await subagents(page, fixture!.session.id);
      expect(child!.status).toBe("completed");
      expect(child!.finishedAt).toBeTruthy();
      expect(child!.error).toBeUndefined();
      await expect(page.locator("article.subagent-card.running")).toHaveCount(0);
    });
  } finally {
    await closeWakeGateAndCleanup(page, playwright, fixture);
    await stub.stop();
  }
});

/** After one legitimate wake, the Session must settle: sample that no further wake appears. */
async function expectNoAutomaticWakeBeyond(page: Page, sessionId: string, allowed: number, windowMs = 4_000): Promise<void> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    const woken = (await runs(page, sessionId)).filter((run) => run.automaticWake);
    expect(woken.length, "a delivered result must not wake the Session a second time").toBeLessThanOrEqual(allowed);
    await page.waitForTimeout(250);
  }
}

});
