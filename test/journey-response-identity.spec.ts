// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
// http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, type Page } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { cleanupJourney, createProjectAndSession, openProjectSession, sendUserMessage, waitForRunTerminal, type JourneyFixture } from "./helpers/journeys.ts";

function gate() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return { ready, release };
}

/** Gates wait for browser observations, not a race against the model's speed. */
async function controlledModel() {
  const thinking = gate();
  const suffix = gate();
  const finish = gate();
  const nextTool = gate();
  let invocation = 0;
  const errors: string[] = [];
  const model = "response-identity-stub";
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { tools?: unknown[] };
        const step = body.tools?.length ? invocation++ : -1;
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const write = (delta: Record<string, unknown>, finishReason: string | null = null) => response.write(`data: ${JSON.stringify({
          id: `response-fixture-${step}`, object: "chat.completion.chunk", created: 1, model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
          ...(finishReason ? { usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } } : {}),
        })}\n\n`);
        const tool = (name: string, args: Record<string, unknown>, text: string) => {
          write({ role: "assistant", content: text });
          write({ tool_calls: [{ index: 0, id: `call-${step}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
          write({}, "tool_calls");
        };
        if (step === 0) {
          write({ role: "assistant", reasoning_content: "先确认科研任务。" });
          await thinking.ready;
          write({ reasoning_content: "再整理可执行步骤。" });
          write({ content: "1. 数据处理\n2. 科学计算\n3. **" });
          await suffix.ready;
          write({ content: "科研脚本** — 完整回答。" });
          await finish.ready;
          write({}, "stop");
        } else if (step === 1) {
          tool("run_shell", { command: "printf FIRST_TOOL" }, "第一项检查。");
        } else if (step === 2) {
          await nextTool.ready;
          tool("run_shell", { command: "printf SECOND_TOOL" }, "第二项检查。");
        } else if (step === 3) {
          write({ role: "assistant", content: "两项检查完成。" });
          write({}, "stop");
        } else if (step === 4) {
          tool("query_graph", { query: "response identity" }, "查询前的说明。");
        } else if (step === 5) {
          write({ role: "assistant", content: "查询后的结论。" });
          write({}, "stop");
        } else if (step === -1) {
          // Session naming is a separate product call, not a scripted turn.
          write({ role: "assistant", content: "响应连续性" });
          write({}, "stop");
        } else {
          throw new Error(`Unexpected model invocation ${step}`);
        }
        response.end("data: [DONE]\n\n");
      } catch (error) {
        errors.push(String(error));
        response.destroy();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    apiToken: "local-response-fixture", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model,
    thinking, suffix, finish, nextTool, errors,
    async stop() {
      for (const item of [thinking, suffix, finish, nextTool]) item.release();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

type EventRecord = { event: { type: string; responseId?: string; delta?: string; trace?: { name: string; status: string }; approvalMode?: string } };
async function records(page: Page, sessionId: string, runId: string): Promise<EventRecord[]> {
  const response = await page.request.get(`${apiBaseUrl()}/api/sessions/${sessionId}/runs/${runId}/events`, { headers: authorizationHeader() });
  expect(response.ok()).toBe(true);
  return response.json();
}

/**
 * E2E-META
 * Purpose: A researcher changes approval during reasoning and Markdown output, then reads intact responses after reload and tool calls.
 * Steps:
 *   1. Start a response and change approval while its reasoning is streaming.
 *   2. Change approval at a split Markdown delimiter, finish the text and reload.
 *   3. Switch policy between two shell tools and approve the second operation.
 *   4. Read separate responses around a hidden graph tool and reopen the Session.
 * Environment: Isolated API/Web and Runner at E2E_BASE_URL; scientific environments and graph mirroring disabled.
 * Type: mocked
 * LLM: journey-owned local HTTP model with browser-controlled gates.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none; two local sandboxed printf commands; query_graph uses the disabled-graph response.
 * Credentials: E2E_API_TOKEN for the isolated local stack only.
 * CostSideEffects: temporary Project, Session and model removed in finally; no external cost.
 */
test("调整审批后继续阅读完整响应，刷新和工具间隔保持一致", { tag: "@mocked" }, async ({ page, journey }) => {
  journey.scenario({ goal: "在输出过程中切换审批，保留完整 Markdown、思考和审计记录，并区分工具前后的模型响应。",
    preconditions: ["独立 API/Runner 已启动", "模型只使用旅程内的本地受控桩"] });
  await page.addInitScript(() => localStorage.setItem("sciencediscovery-locale", "zh-CN"));
  const stub = await controlledModel();
  let fixture: JourneyFixture | undefined;
  let runId = "";
  const timeline = () => page.locator(".run-timeline").last();
  const answers = () => timeline().locator(".assistant-continuation");
  try {
    fixture = await createProjectAndSession(page, { approvalMode: "ask_for_dangerous",
      model: { ...stub, name: `响应测试 ${Date.now()}`, apiVariant: "deepseek" },
      projectName: `连续性项目 ${Date.now()}`, sessionTitle: "审批与回答" });
    await journey.step("思考中切换审批", "切换后仍是同一张正在输出的思考卡片。", async () => {
      await openProjectSession(page, fixture!);
      runId = (await sendUserMessage(page, fixture!.session.id, "整理三个科研步骤。")).id;
      await expect(timeline().locator(".thinking.running")).toContainText("先确认科研任务。");
      await page.locator(".approval-mode-toggle").click();
      await expect(timeline().locator(".boundary-note")).toHaveCount(1);
      await expect(timeline().locator(".thinking.running")).toHaveCount(1);
      stub.thinking.release();
      await expect(answers().locator("li").nth(2)).toHaveText("**");
      await expect(timeline().locator(".thinking")).toHaveCount(1);
      await expect(timeline().locator(".thinking")).toContainText("先确认科研任务。再整理可执行步骤。");
    });
    await journey.step("Markdown 中途切换并刷新", "提示在回答后，刷新仍保留这一条正文和流式光标。", async () => {
      await page.locator(".approval-mode-toggle").click();
      await expect(timeline().locator(".boundary-note")).toHaveCount(2);
      await expect(answers()).toHaveCount(1);
      await expect(answers().locator(".cursor")).toHaveCount(1);
      await page.reload();
      await expect(answers().locator("li").nth(2)).toHaveText("**");
      await expect(answers().locator(".cursor")).toHaveCount(1);
      await expect(timeline().locator(".boundary-note")).toHaveCount(2);
      stub.suffix.release();
      await expect(answers().locator("strong")).toHaveText("科研脚本");
      await expect(answers()).toHaveCount(1);
      const order = await timeline().evaluate((node) => {
        const answer = node.querySelector(".assistant-continuation")!;
        const notice = node.querySelectorAll(".boundary-note")[1]!;
        return Boolean(answer.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING);
      });
      expect(order).toBe(true);
      await expect(answers().locator(".cursor")).toHaveCount(1);
    });
    await journey.step("完成后重开完整回答", "加粗和列表完整，提示仍在，完成后光标消失。", async () => {
      stub.finish.release();
      expect((await waitForRunTerminal(page, fixture!.session.id, runId)).status).toBe("completed");
      await openProjectSession(page, fixture!);
      await expect(answers()).toHaveCount(1);
      await expect(answers().locator("li")).toHaveCount(3);
      await expect(answers().locator("strong")).toHaveText("科研脚本");
      await expect(answers().locator(".cursor")).toHaveCount(0);
      await expect(timeline().locator(".boundary-note")).toHaveCount(2);
      const text = (await records(page, fixture!.session.id, runId)).filter(({ event }) => event.type === "assistant.delta");
      expect(text.every(({ event }) => Boolean(event.responseId))).toBe(true);
      expect(new Set(text.map(({ event }) => event.responseId)).size).toBe(1);
    });
    await journey.step("两次工具之间收紧审批", "第二次命令需要审批，提示位于两个工具之间，等待工具时没有正文光标。", async () => {
      await page.locator(".approval-mode-toggle").click(); // allow first tool
      runId = (await sendUserMessage(page, fixture!.session.id, "依次运行两项本地检查。")).id;
      await expect.poll(async () => (await records(page, fixture!.session.id, runId))
        .some(({ event }) => event.type === "tool.completed")).toBe(true);
      await page.locator(".approval-mode-toggle").click();
      await expect(timeline().locator(".boundary-note")).toHaveCount(1);
      stub.nextTool.release();
      await expect(timeline().locator(".permission-card.pending")).toBeVisible();
      await expect(answers().locator(".cursor")).toHaveCount(0);
      await timeline().getByRole("button", { name: "仅允许一次", exact: true }).click();
      expect((await waitForRunTerminal(page, fixture!.session.id, runId)).status).toBe("completed");
      await page.reload();
      await expect(timeline().locator(".tool")).toHaveCount(2);
      await expect(timeline().locator(".boundary-note")).toHaveCount(1);
      expect(await timeline().evaluate((node) => {
        const tools = node.querySelectorAll(".tool");
        const notice = node.querySelector(".boundary-note")!;
        return Boolean(tools[0]!.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING)
          && Boolean(notice.compareDocumentPosition(tools[1]!) & Node.DOCUMENT_POSITION_FOLLOWING);
      })).toBe(true);
      await expect(answers()).toHaveCount(3);
    });
    await journey.step("隐藏工具前后保留不同响应", "无需显示内部工具卡片，前后的说明仍是两条独立正文，重开后也不合并。", async () => {
      runId = (await sendUserMessage(page, fixture!.session.id, "查询已有科研记录，然后给出结论。")).id;
      expect((await waitForRunTerminal(page, fixture!.session.id, runId)).status).toBe("completed");
      await openProjectSession(page, fixture!);
      await expect(answers()).toHaveCount(2);
      await expect(answers().nth(0)).toContainText("查询前的说明。");
      await expect(answers().nth(1)).toContainText("查询后的结论。");
      await expect(timeline().locator(".tool")).toHaveCount(0);
      const events = await records(page, fixture!.session.id, runId);
      expect(events.some(({ event }) => event.type === "tool.completed" && event.trace?.name === "query_graph" && event.trace.status === "completed")).toBe(true);
      expect(new Set(events.filter(({ event }) => event.type === "assistant.delta").map(({ event }) => event.responseId)).size).toBe(2);
    });
    expect(stub.errors).toEqual([]);
  } finally {
    await stub.stop();
    if (fixture) {
      await page.request.post(`${apiBaseUrl()}/api/sessions/${fixture.session.id}/runs/current/cancel`, { headers: authorizationHeader(), data: {} }).catch(() => undefined);
      await cleanupJourney(page, fixture);
    }
  }
});
