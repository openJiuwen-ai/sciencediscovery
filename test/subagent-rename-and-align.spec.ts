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

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, type Page } from "@playwright/test";

import { test } from "./helpers/e2e.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";

// Static suite metadata is inherited by each framework-expanded journey.
test.describe("subagent-rename-and-align.spec", { tag: ["@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@status:reviewed", "@model:mock", "@sandbox:bubblewrap"] }, () => {

const SCREENSHOTS = "screenshots";
const { authorization: AUTH } = authorizationHeader();
const API_BASE = apiBaseUrl();

async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: `${SCREENSHOTS}/${name}.png`, fullPage: false });
}

async function waitForToast(page: Page, text: string | RegExp, opts?: { timeout?: number }) {
  const toast = page.locator("[role='status']").filter({ hasText: text });
  await toast.waitFor({ timeout: opts?.timeout ?? 10000, state: "visible" });
  return toast;
}

async function apiRequest(path: string, init: RequestInit = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      authorization: AUTH,
      ...(init.body && !(init.body instanceof FormData) ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string };
    throw new Error(`${path} failed: ${body.error ?? response.statusText}`);
  }
  return response;
}

function startMockLlmServer(): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
  let subagentCallCount = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        messages?: Array<{ content?: string; role?: string }>;
      };
      const systemPrompt = body.messages?.find((m) => m.role === "system")?.content ?? "";
      const hasToolResult = body.messages?.some((m) => m.role === "tool") ?? false;
      const isSubagent = systemPrompt.includes("Applied subagent preset general-purpose");

      const sse = (chunks: unknown[]) => {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        for (const chunk of chunks) {
          response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        response.end("data: [DONE]\n\n");
      };

      if (isSubagent) {
        subagentCallCount += 1;
        // Keep the subagent in running state briefly so the UI can render it.
        await new Promise((resolve) => setTimeout(resolve, 1200));
        sse([
          {
            choices: [{
              delta: { content: "Subagent inspected the workspace ", role: "assistant" },
              finish_reason: null,
              index: 0,
            }],
            created: 1,
            id: `chatcmpl-subagent-${subagentCallCount}`,
            model: "subagent-e2e-model",
            object: "chat.completion.chunk",
          },
          {
            choices: [{
              delta: { content: "and returned a concise result." },
              finish_reason: null,
              index: 0,
            }],
            created: 1,
            id: `chatcmpl-subagent-${subagentCallCount}`,
            model: "subagent-e2e-model",
            object: "chat.completion.chunk",
          },
          {
            choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
            created: 1,
            id: `chatcmpl-subagent-${subagentCallCount}`,
            model: "subagent-e2e-model",
            object: "chat.completion.chunk",
            usage: { completion_tokens: 5, prompt_tokens: 20, total_tokens: 25 },
          },
        ]);
        return;
      }

      if (hasToolResult) {
        sse([{
          choices: [{
            delta: { content: "The subagent completed the delegated analysis.", role: "assistant" },
            finish_reason: null,
            index: 0,
          }],
          created: 1,
          id: "chatcmpl-parent-result",
          model: "subagent-e2e-model",
          object: "chat.completion.chunk",
        }, {
          choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
          created: 1,
          id: "chatcmpl-parent-result",
          model: "subagent-e2e-model",
          object: "chat.completion.chunk",
          usage: { completion_tokens: 8, prompt_tokens: 30, total_tokens: 38 },
        }]);
        return;
      }

      sse([{
        choices: [{
          delta: {
            role: "assistant",
            tool_calls: [{
              function: {
                arguments: JSON.stringify({
                  description: "Inspect workspace",
                  prompt: "List the files in the workspace and return a concise summary.",
                  subagent_type: "general-purpose",
                }),
                name: "task",
              },
              id: "call-task-1",
              index: 0,
              type: "function",
            }],
          },
          finish_reason: null,
          index: 0,
        }],
        created: 1,
        id: "chatcmpl-parent-task",
        model: "subagent-e2e-model",
        object: "chat.completion.chunk",
      }, {
        choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
        created: 1,
        id: "chatcmpl-parent-task",
        model: "subagent-e2e-model",
        object: "chat.completion.chunk",
        usage: { completion_tokens: 10, prompt_tokens: 25, total_tokens: 35 },
      }]);
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        stop: () => new Promise<void>((resolveStop) => server.close(() => resolveStop())),
      });
    });
    server.on("error", reject);
  });
}

async function createTestModel(baseUrl: string, name: string) {
  const response = await apiRequest("/api/models", {
    method: "POST",
    body: JSON.stringify({
      apiToken: "e2e-mock-token",
      baseUrl,
      model: "subagent-e2e-model",
      name,
      vision: false,
    }),
  });
  return (await response.json()) as { id: string; name: string };
}

async function deleteTestModel(modelId: string) {
  await apiRequest(`/api/models/${encodeURIComponent(modelId)}`, { method: "DELETE" });
}

async function deleteProject(projectId: string) {
  await apiRequest(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
    body: JSON.stringify({ confirmationId: projectId }),
  });
}

async function createProject(name: string) {
  const response = await apiRequest("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  return (await response.json()) as { id: string; name: string };
}

async function createSession(projectId: string, modelId: string, title: string) {
  const response = await apiRequest(`/api/projects/${encodeURIComponent(projectId)}/sessions`, {
    method: "POST",
    body: JSON.stringify({ approvalMode: "always_allow", modelId, title }),
  });
  return (await response.json()) as { id: string; title: string };
}

async function createProjectAndSession(page: Page, modelId: string) {
  const project = await createProject(`Subagent E2E ${Date.now()}`);
  const session = await createSession(project.id, modelId, `Subagent session ${Date.now()}`);

  await page.goto("/");
  await expect(page.getByText("ScienceDiscovery").first()).toBeVisible();

  // Select the newly created project and session from the sidebar.
  const projectButton = page.locator(".nav-item").filter({ hasText: project.name });
  await expect(projectButton).toBeVisible();
  await projectButton.click();
  const sessionButton = page.locator(".nav-item").filter({ hasText: session.title });
  await expect(sessionButton).toBeVisible();
  await sessionButton.click();
  await expect(page.locator("h1")).toContainText(session.title);

  return { project, session };
}

test.describe("Subagent rename and align user scenario E2E", () => {
  /**
   * E2E-META
   * Purpose: subagent 卡片的术语、实时记录、折叠历史、详情页与刷新后的持久化都保持一致且可读。
   * Steps:
   *   1. mock LLM 触发 task 工具，创建会话并发送消息。
   *   2. 断言 Stop 与 Subagent activity 区域出现，术语中不出现 "Delegation tracks"，卡片 running 并显示任务描述。
   *   3. 打开运行中的 live 记录与 SubAgent 页面，核对提示、回合并返回主 Agent。
   *   4. 运行完成后断言记录默认折叠，摘要含 completed。
   *   5. 展开并进入详情页，核对步骤结果与 tokens。
   *   6. 断言 composer 与 Run 可用、主对话回复可见。
   *   7. 刷新并重新进入会话，断言历史记录仍为 completed 且折叠。
   * Environment: 隔离本地栈；模型与 subagent 流程由本 spec 的 loopback SSE 服务提供。
   * Type: mocked
   * LLM: 本地确定性 SSE fixture；不调用真实或付费模型。
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none — 浏览器与 API 请求均指向 127.0.0.1。
   * Credentials: 隔离实例的 E2E_API_TOKEN 与桩模型令牌。
   * CostSideEffects: none；项目与模型在 finally 中尽力清理。
   */
  test("用户可见 subagent 卡片：术语、观测、折叠展开与布局", { tag: "@mocked" }, async ({ page }) => {
    test.setTimeout(120000);

    const logs: string[] = [];
    page.on("console", (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
    page.on("pageerror", (err) => logs.push(`[pageerror] ${err.message}`));

    const { baseUrl, stop } = await startMockLlmServer();
    const model = await createTestModel(baseUrl, "Subagent E2E model");
    let projectId: string | undefined;

    try {
      const { project, session } = await createProjectAndSession(page, model.id);
      projectId = project.id;
      await screenshot(page, "01-subagent-session-landing");

      // 1. 发送会触发 task 工具的消息
      const composer = page.locator(".composer textarea");
      await composer.fill("Please delegate a workspace inspection using the task tool.");
      await screenshot(page, "02-message-typed");

      const runButton = page.getByRole("button", { name: "Run analysis" });
      await expect(runButton).toBeEnabled();
      const [messageResponse] = await Promise.all([
        page.waitForResponse((response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname.match(/\/api\/sessions\/[^/]+\/messages$/) !== null),
        runButton.click(),
      ]);
      expect(messageResponse.status(), "message run should start successfully").toBe(200);

      // 3. 运行中反馈与嵌套卡片出现；同时验证术语可理解
      await expect(page.getByRole("button", { name: "Stop the current run" })).toBeVisible({ timeout: 20000 });
      const section = page.locator("section[aria-label='Subagent activity']");
      await expect(section).toBeVisible({ timeout: 20000 });
      // 分组标题只在有 subagent 运行时出现，术语契约以区域可访问名称为准
      await expect(section).toHaveAttribute("aria-label", "Subagent activity");
      await expect(section).not.toContainText("Delegation tracks");
      await screenshot(page, "03-subagent-heading");

      const card = page.locator(".subagent-card").first();
      await expect(card).toBeVisible({ timeout: 20000 });
      await expect(card).toHaveClass(/running/);
      await expect(card).toContainText("Inspect workspace");
      // 卡片只保留研究者可读的描述与状态（类型名不再出现在卡片上）
      await expect(card).toContainText(/running/i);
      await screenshot(page, "04-subagent-running");

      // 4. 运行中的记录是常开的 live 区；卡片按钮打开 SubAgent 页面查看提示、回合与用量
      const liveRecord = section.locator("details.process-live");
      await expect(liveRecord).toHaveCount(1);
      await expect(liveRecord).toHaveJSProperty("open", true);
      await card.getByRole("button", { name: "Open SubAgent: Inspect workspace" }).click();
      const subagentPage = page.getByRole("region", { name: "SubAgent: Inspect workspace" });
      await expect(subagentPage).toBeVisible();
      await expect(subagentPage.locator(".subagent-page-meta")).toContainText(/turns/);
      await expect(subagentPage.locator(".subagent-prompt-message")).toContainText("List the files in the workspace");
      await screenshot(page, "05-subagent-page-running");
      await subagentPage.getByRole("button", { name: "Back to main Agent" }).click();
      await expect(page.locator("h1")).toContainText(session.title);

      // 5. 运行结束:记录从 live 区转为默认折叠的历史记录
      await expect(page.getByRole("button", { name: "Run analysis" })).toBeVisible({ timeout: 60000 });
      const completedRecord = section.locator("details.process-record.process-agent-record.completed");
      await expect(completedRecord).toHaveCount(1);
      await expect(completedRecord).toHaveJSProperty("open", false);
      await expect(completedRecord.locator(":scope > summary")).toContainText("Inspect workspace");
      await expect(completedRecord.locator(":scope > summary")).toContainText(/completed/i);
      await screenshot(page, "06-subagent-completed-collapsed");

      // 6. 手动展开后卡片可见，进入页面验证步骤结果与用量
      await completedRecord.locator(":scope > summary").click();
      await expect(completedRecord).toHaveJSProperty("open", true);
      const completedCard = completedRecord.locator(".subagent-card");
      await expect(completedCard).toHaveClass(/completed/);
      await completedCard.getByRole("button", { name: "Open SubAgent: Inspect workspace" }).click();
      await expect(subagentPage).toBeVisible();
      await expect(subagentPage.locator(".subagent-messages")).toContainText("Subagent inspected the workspace");
      await expect(subagentPage.locator(".subagent-page-meta")).toContainText(/tokens/);
      await screenshot(page, "07-subagent-steps-and-usage");
      await subagentPage.getByRole("button", { name: "Back to main Agent" }).click();
      await expect(page.locator("h1")).toContainText(session.title);

      // 8. 布局：展开卡片时关键操作（composer / Run analysis）仍可用且不严重遮挡
      await expect(composer).toBeVisible();
      await expect(composer).toBeEnabled();
      await expect(page.getByRole("button", { name: "Run analysis" })).toBeInViewport();
      await screenshot(page, "09-layout-composer-visible");

      // 9. 主对话可见完成反馈
      const assistantMessage = page.locator(".message.assistant").last();
      await expect(assistantMessage).toContainText("The subagent completed the delegated analysis.");
      await screenshot(page, "10-assistant-final-response");

      // 10. 验证持久化后从列表重新进入会话，subagent 卡片仍展示为 completed
      await page.reload();
      await expect(page.locator(".app-shell")).toBeVisible();
      // Reload resets the active session; re-select the test project/session.
      await page.locator(".nav-item").filter({ hasText: project.name }).click();
      await page.locator(".nav-item").filter({ hasText: session.title }).click();
      await expect(page.locator("h1")).toContainText(session.title);
      const reloadedRecord = page.locator("details.process-record.process-agent-record.completed");
      await expect(reloadedRecord).toHaveCount(1);
      await expect(reloadedRecord).toHaveJSProperty("open", false);
      await expect(reloadedRecord.locator(".subagent-card")).toHaveClass(/completed/);
      await screenshot(page, "11-reload-shows-completed");
    } finally {
      try {
        if (projectId) await deleteProject(projectId);
      } catch {
        // Best-effort cleanup: project may already be gone or locked by a run.
      }
      try {
        await deleteTestModel(model.id);
      } catch {
        // Best-effort cleanup: model may still be referenced by runtime settings.
      }
      await stop();
      if (logs.length) {
        console.log("--- CONSOLE LOGS ---");
        console.log(logs.join("\n"));
        console.log("--- END CONSOLE LOGS ---");
      }
    }
  });

  /**
   * E2E-META
   * Purpose: subagent 超时后记录转为 timed_out，摘要与详情页都给出可读的超时原因。
   * Steps:
   *   1. mock LLM 让 subagent 延迟 6 秒、父 agent 设置 5 秒超时。
   *   2. 发起运行，断言 live 卡片为 running。
   *   3. 等待完成后断言记录为 timed_out，摘要含任务名与 timeout 原因。
   *   4. 展开并进入 SubAgent 页面，断言错误提示含 timeout。
   *   5. 清理项目、模型与本地服务。
   * Environment: 隔离本地栈；超时路径由本 spec 的 loopback SSE 服务提供。
   * Type: mocked
   * LLM: 本地确定性 SSE fixture；不调用真实或付费模型。
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none — 浏览器与 API 请求均指向 127.0.0.1。
   * Credentials: 隔离实例的 E2E_API_TOKEN 与桩模型令牌。
   * CostSideEffects: none；项目与模型在 finally 中尽力清理。
   */
  test("subagent 超时路径：失败状态与可读提示", { tag: "@mocked" }, async ({ page }) => {
    test.setTimeout(120000);

    const logs: string[] = [];
    page.on("console", (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
    page.on("pageerror", (err) => logs.push(`[pageerror] ${err.message}`));

    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", async () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          messages?: Array<{ content?: string; role?: string }>;
        };
        const systemPrompt = body.messages?.find((m) => m.role === "system")?.content ?? "";
        const isSubagent = systemPrompt.includes("Applied subagent preset general-purpose");
        const hasToolResult = body.messages?.some((m) => m.role === "tool") ?? false;

        response.writeHead(200, { "content-type": "text/event-stream" });
        if (isSubagent) {
          // Delay longer than the 5-second subagent timeout to force a timeout
          // while the card is already expanded in the running state.
          await new Promise((resolve) => setTimeout(resolve, 6_000));
          response.write(`data: ${JSON.stringify({
            choices: [{
              delta: { content: "This response arrives too late.", role: "assistant" },
              finish_reason: null,
              index: 0,
            }],
            created: 1,
            id: "chatcmpl-subagent-late",
            model: "subagent-timeout-model",
            object: "chat.completion.chunk",
          })}\n\n`);
          response.write(`data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
            created: 1,
            id: "chatcmpl-subagent-late",
            model: "subagent-timeout-model",
            object: "chat.completion.chunk",
            usage: { completion_tokens: 5, prompt_tokens: 10, total_tokens: 15 },
          })}\n\n`);
        } else if (hasToolResult) {
          response.write(`data: ${JSON.stringify({
            choices: [{
              delta: { content: "The subagent timed out before completing.", role: "assistant" },
              finish_reason: null,
              index: 0,
            }],
            created: 1,
            id: "chatcmpl-parent-timeout-result",
            model: "subagent-timeout-model",
            object: "chat.completion.chunk",
          })}\n\n`);
          response.write(`data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
            created: 1,
            id: "chatcmpl-parent-timeout-result",
            model: "subagent-timeout-model",
            object: "chat.completion.chunk",
            usage: { completion_tokens: 7, prompt_tokens: 20, total_tokens: 27 },
          })}\n\n`);
        } else {
          // 父 agent 调用 task，设置 1 秒超时
          response.write(`data: ${JSON.stringify({
            choices: [{
              delta: {
                role: "assistant",
                tool_calls: [{
                  function: {
                    arguments: JSON.stringify({
                      description: "Slow workspace inspection",
                      prompt: "List files, but take too long.",
                      subagent_type: "general-purpose",
                      timeout_seconds: 5,
                    }),
                    name: "task",
                  },
                  id: "call-task-timeout",
                  index: 0,
                  type: "function",
                }],
              },
              finish_reason: null,
              index: 0,
            }],
            created: 1,
            id: "chatcmpl-parent-task-timeout",
            model: "subagent-timeout-model",
            object: "chat.completion.chunk",
          })}\n\n`);
          response.write(`data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
            created: 1,
            id: "chatcmpl-parent-task-timeout",
            model: "subagent-timeout-model",
            object: "chat.completion.chunk",
            usage: { completion_tokens: 10, prompt_tokens: 25, total_tokens: 35 },
          })}\n\n`);
        }
        response.end("data: [DONE]\n\n");
      });
    });

    const { port } = await new Promise<{ port: number }>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        resolve({ port: (server.address() as AddressInfo).port });
      });
      server.on("error", reject);
    });
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const model = await createTestModel(baseUrl, "Subagent timeout E2E model");
    let projectId: string | undefined;

    try {
      const { project } = await createProjectAndSession(page, model.id);
      projectId = project.id;
      const composer = page.locator(".composer textarea");
      await composer.fill("Run a workspace inspection that will time out.");
      await page.getByRole("button", { name: "Run analysis" }).click();

      const section = page.locator("section[aria-label='Subagent activity']");
      const card = page.locator(".subagent-card").first();
      await expect(card).toBeVisible({ timeout: 20000 });
      await expect(card).toHaveClass(/running/);
      // 运行中的记录是常开的 live 区，卡片直接可见
      await expect(section.locator("details.process-live .subagent-card.running")).toHaveCount(1);
      await screenshot(page, "12a-subagent-timeout-running");

      // 等待 subagent 超时完成:记录转为 timed out，摘要里给出可读原因
      await expect(page.getByRole("button", { name: "Run analysis" })).toBeVisible({ timeout: 60000 });
      const record = section.locator("details.process-record.process-agent-record.timed_out");
      await expect(record).toHaveCount(1);
      await expect(record.locator(":scope > summary")).toContainText("Slow workspace inspection");
      await expect(record.locator(":scope > summary")).toContainText(/timed out/i);
      await expect(record.locator(":scope > summary")).toContainText(/timeout|exceeded/i);
      await screenshot(page, "12b-subagent-timeout-feedback");

      // 展开记录并进入 SubAgent 页面，提示详情同样可读
      await record.locator(":scope > summary").click();
      await record.getByRole("button", { name: "Open SubAgent: Slow workspace inspection" }).click();
      const subagentPage = page.getByRole("region", { name: "SubAgent: Slow workspace inspection" });
      await expect(subagentPage.locator(".subagent-page-error")).toContainText(/timeout|timed out|exceeded/i);
      await screenshot(page, "12c-subagent-timeout-page");
    } finally {
      if (projectId) {
        try {
          await deleteProject(projectId);
        } catch {
          // Best-effort cleanup.
        }
      }
      try {
        await deleteTestModel(model.id);
      } catch {
        // Best-effort cleanup.
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (logs.length) {
        console.log("--- CONSOLE LOGS ---");
        console.log(logs.join("\n"));
        console.log("--- END CONSOLE LOGS ---");
      }
    }
  });
});

});
