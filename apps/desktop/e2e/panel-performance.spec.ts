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
 * What it costs to open a subagent's record.
 *
 * A long record used to freeze the page for seconds: every tool result was
 * parsed and laid out before the panel appeared. This spec keeps that record
 * openable, and prints the two numbers the fix is about — click to visible, and
 * the longest main-thread task — so a reviewer can read them from any run
 * instead of taking a headline on trust.
 *
 * The record is deliberately larger than a real one: 137 tool results of
 * 15 KB each, about 2 MB of terminal text.
 */
import { expect, test } from "@playwright/test";

import {
  CREATED_AT,
  TOKEN,
  TOKEN_STORAGE_KEY,
  installMockApi,
  makeSession,
  type JsonRecord,
  type MockOptions,
} from "./fixtures.js";

const SESSION = "session-1";
const RUN = "run-1";
const CHILD = "child-1";
const DESCRIPTION = "排序候选结构";
const ANSWER = "前三个结构的排名是稳定的。";
const STEPS = 137;
const STEP_BYTES = 15 * 1024;
/** A task longer than 50 ms is the browser's own definition of one that can be
 *  felt; the ceiling here is generous enough for a loaded runner and still
 *  catches a return to rendering the whole record up front. */
const MAX_LONG_TASK_MS = 1500;

/** The run and catalog of one Session whose child left a long record. */
function longRecord(): MockOptions {
  const snapshot = {
    createdAt: CREATED_AT,
    id: CHILD,
    input: { description: DESCRIPTION, prompt: "按能量排序。", subagentType: "general-purpose" },
    maxTurns: 12,
    parentTurnId: "turn-1",
    sessionId: SESSION,
    status: "completed",
    steps: [],
    timeoutSeconds: 600,
    turnCount: 3,
  };
  const answer = "我把候选结构交给了一个子任务。";
  const run = {
    assistantMessageId: "message-assistant",
    createdAt: CREATED_AT,
    finishedAt: CREATED_AT,
    id: RUN,
    prompt: "分析晶体结构",
    queueOrder: 0,
    sessionId: SESSION,
    status: "completed",
    userMessageId: "message-user",
  };
  const body = "x".repeat(STEP_BYTES);
  const steps: JsonRecord[] = Array.from({ length: STEPS }, (_, index) => ({
    content: `result-${index} ${body}`,
    createdAt: CREATED_AT,
    id: `tool-${index}`,
    input: `{"path":"file-${index}.txt"}`,
    kind: "tool",
    status: "completed",
    toolName: "read_file",
  }));
  // The child's answer, which is what the panel shows first. It sits after the
  // record, as it does on the wire.
  steps.push({
    content: ANSWER,
    createdAt: CREATED_AT,
    id: "step-final",
    kind: "assistant",
    status: "completed",
  });
  return {
    runsBySession: {
      [SESSION]: [{
        events: [
          { model: { name: "Qwen Max" }, runId: RUN, settings: {}, type: "run.started" },
          { responseId: "response-1", turn: 1, type: "assistant.response.started" },
          { delta: answer, responseId: "response-1", turn: 1, type: "assistant.delta" },
          { subagent: snapshot, type: "subagent.updated" },
          {
            files: [],
            message: { content: answer, createdAt: CREATED_AT, id: "message-assistant", role: "assistant" },
            type: "run.completed",
          },
          { run, status: "completed", type: "run.status" },
        ],
        run,
      }],
    },
    sessions: [makeSession({
      messages: [
        { content: "分析晶体结构", createdAt: CREATED_AT, id: "message-user", role: "user" },
        { content: "存下来的回答。", createdAt: CREATED_AT, id: "message-assistant", role: "assistant" },
      ],
    })],
    subagentsBySession: { [SESSION]: [{ ...snapshot, steps }] },
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [TOKEN_STORAGE_KEY, TOKEN] as const,
  );
});

test("a 2 MB record opens with no long task on the main thread", async ({ page }) => {
  // Long tasks are the felt half of a freeze: a task that holds the main thread
  // for hundreds of milliseconds is what makes a click look ignored.
  await page.addInitScript(() => {
    const record = { count: 0, max: 0, total: 0 };
    (window as unknown as { __longTasks: typeof record }).__longTasks = record;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        record.count += 1;
        record.total += entry.duration;
        record.max = Math.max(record.max, entry.duration);
      }
    }).observe({ type: "longtask", buffered: true });
  });

  await installMockApi(page, longRecord());
  await page.goto("/");
  await page.locator(".run-fold summary").click();
  const line = page.getByRole("button", { name: `Subagent ${DESCRIPTION}` });
  await expect(line).toBeVisible();

  // Boot is not what this measures; only the click that opens the record.
  await page.evaluate(() => {
    const record = (window as unknown as { __longTasks: { count: number; max: number; total: number } }).__longTasks;
    record.count = 0;
    record.max = 0;
    record.total = 0;
  });

  const start = Date.now();
  await line.click();
  const panel = page.locator(".workspace-panel");
  await expect(panel).toBeVisible({ timeout: 15_000 });
  // A long task is reported when it ends, so give the frame after the render a
  // chance to close before reading the record.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
  const openMs = Date.now() - start;

  const longTasks = await page.evaluate(() => (
    window as unknown as { __longTasks: { count: number; max: number; total: number } }
  ).__longTasks);
  const measurement = { openMs, ...longTasks };
  console.log(`subagent panel opened in ${openMs} ms; longest main-thread task ${longTasks.max} ms over ${longTasks.count} long task(s)`);
  await test.info().attach("panel-open-timing", {
    body: JSON.stringify(measurement, null, 2),
    contentType: "application/json",
  });

  // The panel is drawn, and the record is still there to read.
  await expect(panel.getByText(ANSWER)).toBeVisible();
  await expect(panel.locator(".subagent-step")).toHaveCount(0);
  expect(longTasks.max).toBeLessThan(MAX_LONG_TASK_MS);
});
