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

interface KbScopeStub {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiToken: string;
  /** Raw request bodies per model call, for system-prompt + observation assertions. */
  readonly requests: string[];
  readonly stop: () => Promise<void>;
}

/**
 * Two-call stub: the first model call probes the tool-layer scope enforcement
 * with an out-of-scope kbId on kb_search; the second call sees the rejection
 * observation and answers with plain text. Every request body is recorded so
 * the executed system prompt (scope disclosure) can be asserted verbatim.
 */
async function kbScopeStub(): Promise<KbScopeStub> {
  const model = "journey-kb-scope-model";
  const apiToken = "journey-kb-scope-token";
  const requests: string[] = [];
  let calls = 0;
  let server: Server | undefined;
  await new Promise<void>((ready) => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        calls += 1;
        const raw = Buffer.concat(chunks).toString("utf8");
        requests.push(raw);
        const body = JSON.parse(raw) as { tools?: unknown[] };
        const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
          `data: ${JSON.stringify({
            choices: [{ delta, finish_reason: finishReason, index: 0 }],
            created: 1,
            id: `chatcmpl-kb-scope-${calls}`,
            model,
            object: "chat.completion.chunk",
          })}\n\n`;
        response.writeHead(200, { "cache-control": "no-cache", "content-type": "text/event-stream" });
        if (!body.tools?.length) {
          // Non-tool requests (session naming etc.) get a minimal answer.
          response.write(chunk({ content: "KB scope journey", role: "assistant" }, null));
          response.write(chunk({}, "stop"));
        } else if (calls === 1) {
          // Probe the scope enforcement: an explicit out-of-scope kbId must be
          // rejected by the tool layer before any knowledge-engine work.
          response.write(chunk({
            role: "assistant",
            tool_calls: [{
              function: { arguments: JSON.stringify({ kbId: "kb-out-of-scope", query: "scope probe" }), name: "kb_search" },
              id: `call-kb-scope-${calls}`,
              index: 0,
              type: "function",
            }],
          }, null));
          response.write(chunk({}, "tool_calls"));
        } else {
          response.write(chunk({ content: "范围验证完成：越界知识库被工具层拒绝，绑定库可正常检索。", role: "assistant" }, null));
          response.write(chunk({}, "stop"));
        }
        response.end("data: [DONE]\n\n");
      });
    });
    server.listen(0, "127.0.0.1", () => ready());
  });
  const address = server!.address();
  if (typeof address !== "object" || address === null) throw new Error("kb-scope stub failed to bind");
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
 * Purpose: Binding a knowledge base from the conversation composer (kb-scope picker) must be visible in the UI (badge count), persisted in the session settings overrides (kbScopeKbIds + kbScopeWebSearch), disclosed to the executed system prompt (bound KB + web ban + self-management guidance + context clock), and enforced at the tool layer (an out-of-scope kbId on kb_search is rejected).
 * Steps:
 *   1. Register a journey-owned stub model; create a Project, a Session, and one knowledge base (POST /api/knowledge-engine/kbs).
 *   2. Open the session; in the composer kb-scope picker check the KB and the "knowledge bases only" toggle. Assert the trigger badge shows 1 and the session settings overrides carry kbScopeKbIds=[kb] and kbScopeWebSearch=false.
 *   3. Send one prompt. The stub's first model call probes kb_search with an out-of-scope kbId; the second call sees the rejection observation and finishes.
 *   4. Assert the run completed, the first model request's system prompt contains the bound-KB disclosure, the web ban, the context self-management guidance and the context clock line, and the second request carries the out-of-scope rejection text.
 * Environment: Isolated local stack at E2E_BASE_URL; zh-CN locale; knowledge-engine routes available with an empty KB (no documents needed).
 * Type: mocked
 * LLM: journey-owned OpenAI-compatible stub on 127.0.0.1 with two-call scripting (out-of-scope kb_search probe → final text).
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — non-local browser requests are aborted by the network guard.
 * Credentials: E2E_API_TOKEN for the isolated local API only; the stub token has no external access.
 * CostSideEffects: no external cost; project/session records are deleted in finally; the KB lives in the journey stack's data directory which is discarded with the stack.
 */
test("J-KBS1 对话内绑定知识库：徽章+持久化+提示词披露+工具层强制", { tag: "@mocked" }, async ({ journey, page }) => {
  test.setTimeout(240_000);
  journey.scenario({
    goal: "用户在对话 composer 中选择知识库后，绑定在 UI 上可见、写入会话 settings、"
      + "进入下一次运行的执行提示词（披露行+自管理指引），并被工具层强制（越界 kbId 拒绝）。",
    preconditions: [
      "隔离栈已启动，浏览器已持有本实例的访问 token",
      "知识引擎 REST 可用（旅程自建一个空 KB）",
      "会话模型由旅程自带两段式 stub 驱动，不访问任何外部服务",
    ],
  });
  await page.addInitScript(() => window.localStorage.setItem("sciencediscovery-locale", "zh-CN"));

  const stub = await kbScopeStub();
  let fixture: JourneyFixture | undefined;
  try {
    fixture = await createProjectAndSession(page, {
      approvalMode: "always_allow",
      model: { apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: `J-KBS1 ${stub.model}` },
      projectName: `J-KBS1 kb-scope ${Date.now()}`,
      sessionTitle: "kb-scope 绑定验证",
    });
    const kbName = `J-KBS1 绑定库 ${Date.now()}`;
    const kbResponse = await page.request.fetch(`${apiBaseUrl()}/api/knowledge-engine/kbs`, {
      data: { description: "J-KBS1 journey binding target", name: kbName },
      headers: authorizationHeader(),
      method: "POST",
    });
    expect(kbResponse.ok(), `create KB: ${await kbResponse.text()}`).toBeTruthy();
    const kb = await kbResponse.json() as { id: string };

    await journey.step(
      "在 composer 选择器中绑定知识库并打开仅知识库作答",
      "勾选 KB 与「仅知识库作答」后：触发按钮徽章计数=1，会话 settings overrides 写入 kbScopeKbIds 与 kbScopeWebSearch=false。",
      async () => {
        await openProjectSession(page, fixture!);
        await page.locator("[data-testid=kb-scope-trigger]").click();
        const kbCheckbox = page.locator(`[data-testid=kb-scope-kb-${kb.id}]`);
        await expect(kbCheckbox).toBeVisible({ timeout: 20_000 });
        await kbCheckbox.click();
        await expect(page.locator("[data-testid=kb-scope-trigger] .connector-picker-count")).toHaveText("1");
        await expect.poll(async () => {
          const settings = await (await page.request.fetch(
            `${apiBaseUrl()}/api/sessions/${encodeURIComponent(fixture!.session.id)}/settings`,
            { headers: authorizationHeader() },
          )).json() as { overrides?: { kbScopeKbIds?: string[] } };
          return settings.overrides?.kbScopeKbIds;
        }, { message: "picker write should persist kbScopeKbIds on the session layer" }).toEqual([kb.id]);

        await page.locator("[data-testid=kb-scope-web-only]").click();
        await expect.poll(async () => {
          const settings = await (await page.request.fetch(
            `${apiBaseUrl()}/api/sessions/${encodeURIComponent(fixture!.session.id)}/settings`,
            { headers: authorizationHeader() },
          )).json() as { overrides?: { kbScopeWebSearch?: boolean } };
          return settings.overrides?.kbScopeWebSearch;
        }, { message: "web-only toggle should persist kbScopeWebSearch=false" }).toBe(false);
      },
    );

    await journey.step(
      "发起运行并验证披露与工具层强制",
      "stub 第一次调用用越界 kbId 试探 kb_search（应被拒）；第二次看到拒绝观察后收尾。首个模型请求的系统提示词应含绑定披露、web 禁令、自管理指引与日期行。",
      async () => {
        const run = await sendUserMessage(page, fixture!.session.id, "检索绑定库并回答范围问题。");
        const terminal = await waitForRunTerminal(page, fixture!.session.id, run.id);
        expect(terminal.status).toBe("completed");

        const systemPrompt = stub.requests[0] ?? "";
        expect(systemPrompt).toContain("Knowledge-base scope: this conversation is bound to");
        expect(systemPrompt).toContain(kbName);
        expect(systemPrompt).toContain("Web search and fetch tools are DISABLED");
        expect(systemPrompt).toContain("Context self-management (guidance, not hard rules)");
        expect(systemPrompt).toMatch(/Context clock: today is \d{4}-\d{2}-\d{2} \(UTC\)/);
        // The rejection observation reached the model on the second call.
        expect(stub.requests[1] ?? "").toContain("outside this session's bound knowledge-base scope");
      },
    );
  } finally {
    if (fixture) await cleanupJourney(page, fixture).catch(() => undefined);
    await stub.stop();
  }
});
