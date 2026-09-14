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

import { createServer, type Server } from "node:http";

import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { expect } from "@playwright/test";

import { test } from "./helpers/e2e.ts";
import {
  cleanupJourney,
  createProjectAndSession,
  openProjectSession,
  sendUserMessage,
  waitForRunTerminal,
  type JourneyFixture,
} from "./helpers/journeys.ts";

test.use({ locale: "zh-CN" });

interface FinishGateStub {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiToken: string;
  /** Decoded message contents per model request, for directive assertions. */
  readonly requests: string[];
  readonly stop: () => Promise<void>;
}

/**
 * Gate-aware stub: the generic scriptedModel resets its per-turn step index
 * on any text answer, which cannot express "finish attempt → gate directive
 * → continue within the same user turn". This stub scripts by raw model-call
 * count and records every request body.
 */
async function finishGateStub(): Promise<FinishGateStub> {
  const model = "journey-finish-gate-model";
  const apiToken = "journey-finish-gate-token";
  const requests: string[] = [];
  let calls = 0;
  let server: Server | undefined;
  await new Promise<void>((ready) => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        calls += 1;
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          messages?: Array<{ content?: unknown }>;
          tools?: unknown[];
        };
        requests.push(
          (body.messages ?? [])
            .map((message) => (typeof message.content === "string" ? message.content : ""))
            .join("\n"),
        );
        const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
          `data: ${JSON.stringify({
            choices: [{ delta, finish_reason: finishReason, index: 0 }],
            created: 1,
            id: `chatcmpl-finish-gate-${calls}`,
            model,
            object: "chat.completion.chunk",
          })}\n\n`;
        response.writeHead(200, { "cache-control": "no-cache", "content-type": "text/event-stream" });
        if (!body.tools?.length) {
          // Non-tool requests (session naming etc.) get a minimal answer.
          response.write(chunk({ content: "Finish gate journey", role: "assistant" }, null));
          response.write(chunk({}, "stop"));
        } else if (calls === 1) {
          // First model call of the run: a finish attempt — plain text, no tools.
          response.write(chunk({ content: "初步结论：三条候选路径里 B 最优。", role: "assistant" }, null));
          response.write(chunk({}, "stop"));
        } else if (calls === 2) {
          // The finish gate should have injected the audit directive; answer
          // with the required review_checkpoint call.
          response.write(chunk({
            role: "assistant",
            tool_calls: [{
              function: { arguments: JSON.stringify({ reason: "pre-finish audit: claims traced to trajectory" }), name: "review_checkpoint" },
              id: `call-finish-gate-${calls}`,
              index: 0,
              type: "function",
            }],
          }, null));
          response.write(chunk({}, "tool_calls"));
        } else {
          response.write(chunk({ content: "审计完成：结论 B 的每条依据均已对照轨迹核实，最终答案维持不变。", role: "assistant" }, null));
          response.write(chunk({}, "stop"));
        }
        response.end("data: [DONE]\n\n");
      });
    });
    server.listen(0, "127.0.0.1", () => ready());
  });
  const address = server!.address();
  if (typeof address !== "object" || address === null) throw new Error("finish-gate stub failed to bind");
  return {
    apiToken,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model,
    requests,
    stop: () => new Promise<void>((stopped) => server!.close(() => stopped())),
  };
}

/**
 * E2E-META
 * Purpose: A run whose session enables a pre-finish-audit skill (tree-search) must not complete on the model's first no-tool answer: the finish gate injects the audit directive, the model then calls review_checkpoint, and only the post-audit answer completes the run.
 * Steps:
 *   1. Register a journey-owned stub model; create a Project and Session with the tree-search skill selected (skillSelectionMode=selected, enabledSkillIds=[tree-search]).
 *   2. Send one prompt. The stub's first answer is plain text with no tool calls (a finish attempt).
 *   3. The finish gate injects the pre-finish directive as a user message; the stub observes it in the next request body and answers with a review_checkpoint tool call.
 *   4. With the review observation in history the gate stays silent; the stub's final text completes the run.
 *   5. Assert the run completed, the directive reached the model, and the persisted run events carry review_checkpoint + finish_gate(continue).
 * Environment: Isolated local stack at E2E_BASE_URL; zh-CN locale; no KB or external services needed.
 * Type: mocked
 * LLM: journey-owned OpenAI-compatible stub on 127.0.0.1 with gate-aware turn handling (plain finish attempt → review_checkpoint on directive → final answer).
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — non-local browser requests are aborted by the network guard.
 * Credentials: E2E_API_TOKEN for the isolated local API only; the stub token has no external access.
 * CostSideEffects: no external cost; project/session records are deleted in finally.
 */
test("J-FG1 finish-gate 拦截未审计的收尾", { tag: "@mocked" }, async ({ journey, page, playwright }) => {
  test.setTimeout(240_000);
  journey.scenario({
    goal: "会话启用了声明 pre-finish-audit 的技能（tree-search）时，"
      + "模型第一次无工具调用的回答不能直接进入完成态：finish-gate 注入审计指令，"
      + "模型补做 review_checkpoint 之后才允许收尾。",
    preconditions: [
      "隔离栈已启动，浏览器已持有本实例的访问 token",
      "tree-search 为内置技能且已声明 metadata.pre-finish-audit",
      "会话模型由旅程自带的 gate 感知 stub 驱动，不访问任何外部服务",
    ],
  });
  await page.addInitScript(() => window.localStorage.setItem("sciencediscovery-locale", "zh-CN"));

  const stub = await finishGateStub();
  let fixture: JourneyFixture | undefined;
  try {
    fixture = await createProjectAndSession(page, {
      approvalMode: "always_allow",
      model: { apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: `J-FG1 ${stub.model}` },
      projectName: `J-FG1 finish-gate ${Date.now()}`,
      sessionTitle: "finish-gate 验证",
    });
    // Select exactly one skill for this session: tree-search (declares the audit).
    const patched = await page.request.fetch(
      `${apiBaseUrl()}/api/sessions/${encodeURIComponent(fixture.session.id)}`,
      {
        data: { enabledSkillIds: ["tree-search"], skillSelectionMode: "selected" },
        headers: authorizationHeader(),
        method: "PATCH",
      },
    );
    expect(patched.ok(), `session skill selection: ${await patched.text()}`).toBeTruthy();

    await journey.step(
      "发送提示并等待运行收尾",
      "stub 第一次回答为纯文本（无工具调用=收尾尝试）；finish-gate 应注入审计指令让运行继续。",
      async () => {
        await openProjectSession(page, fixture!);
        const run = await sendUserMessage(page, fixture!.session.id, "比较三条候选路径并给出结论。");
        const terminal = await waitForRunTerminal(page, fixture!.session.id, run.id);
        expect(terminal.status).toBe("completed");
      },
    );

    await journey.step(
      "验证拦截与审计轨迹",
      "stub 侧应看到三次模型调用：收尾尝试 →（收到注入指令）→ review_checkpoint → 最终答案；运行事件流含 review_checkpoint 与 finish_gate 记录。",
      async () => {
        expect(stub.requests.length).toBeGreaterThanOrEqual(3);
        expect(stub.requests[1]).toContain("Pre-finish verification required by skill tree-search");
        // review_checkpoint renders no timeline card without linked artifact
        // reviews, so assert on the persisted run events instead of UI chrome.
        const runs = await (await page.request.fetch(
          `${apiBaseUrl()}/api/sessions/${encodeURIComponent(fixture!.session.id)}/runs`,
          { headers: authorizationHeader() },
        )).json() as Array<{ id: string }>;
        const eventsResponse = await page.request.fetch(
          `${apiBaseUrl()}/api/sessions/${encodeURIComponent(fixture!.session.id)}/runs/${encodeURIComponent(runs.at(-1)!.id)}/events`,
          { headers: authorizationHeader() },
        );
        const records = await eventsResponse.json() as Array<{ event: { type: string; trace?: { name?: string }; action?: string } }>;
        const events = records.map((record) => record.event);
        expect(events.some((event) => event.type === "tool.started" && event.trace?.name === "review_checkpoint")).toBeTruthy();
        expect(events.some((event) => event.type === "finish_gate" && event.action === "continue")).toBeTruthy();
        await expect(page.locator(".message.assistant").last()).toContainText("审计完成");
      },
    );
  } finally {
    if (fixture) await cleanupJourney(page, fixture).catch(() => undefined);
    await stub.stop();
  }
});
