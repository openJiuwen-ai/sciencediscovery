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

import { test, expect, type Page } from "@playwright/test";

import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";

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
  await page.waitForLoadState("networkidle");
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
  test("用户可见 subagent 卡片：术语、观测、折叠展开与布局", async ({ page }) => {
    test.setTimeout(120000);

    const logs: string[] = [];
    page.on("console", (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
    page.on("pageerror", (err) => logs.push(`[pageerror] ${err.message}`));

    const { baseUrl, stop } = await startMockLlmServer();
    const model = await createTestModel(baseUrl, "Subagent E2E model");

    try {
      const { project, session } = await createProjectAndSession(page, model.id);
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
      const heading = section.locator(".subagent-list-heading");
      await expect(heading).toContainText("Subagents");
      await expect(heading).not.toContainText("Delegation tracks");
      await screenshot(page, "03-subagent-heading");

      const card = page.locator(".subagent-card").first();
      await expect(card).toBeVisible({ timeout: 20000 });
      await expect(card).toHaveClass(/running/);
      await expect(card).toContainText("Inspect workspace");
      await expect(card).toContainText("general-purpose");
      await screenshot(page, "04-subagent-running");

      // 4. 卡片展开后可见步骤与用量（运行中或结束后）
      const toggle = card.locator("> button");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      const details = card.locator(".subagent-details");
      await expect(details).toBeVisible();
      await expect(details.locator(".subagent-metadata")).toContainText(/turns/);
      await expect(details).toContainText("Prompt");
      await screenshot(page, "05-subagent-expanded");

      // 5. 手动折叠卡片
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(details).toBeHidden();
      await screenshot(page, "06-subagent-collapsed");

      // 6. 等待运行完成；刷新会话后手动折叠状态应保持
      await expect(page.getByRole("button", { name: "Run analysis" })).toBeVisible({ timeout: 60000 });
      await expect(card).toHaveClass(/completed/);
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await screenshot(page, "07-subagent-completed-collapsed-preserved");

      // 7. 再次展开，验证步骤、用量与结果文本可见
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(details.locator(".subagent-steps")).toContainText("Subagent inspected the workspace");
      await expect(details.locator(".subagent-metadata")).toContainText(/tokens/);
      await screenshot(page, "08-subagent-steps-and-usage");

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
      await page.waitForLoadState("networkidle");
      // Reload resets the active session; re-select the test project/session.
      await page.locator(".nav-item").filter({ hasText: project.name }).click();
      await page.locator(".nav-item").filter({ hasText: session.title }).click();
      await expect(page.locator("h1")).toContainText(session.title);
      await expect(page.locator(".subagent-card").first()).toHaveClass(/completed/);
      await expect(page.locator(".subagent-list-heading")).toContainText("Subagents");
      await screenshot(page, "11-reload-shows-completed");
    } finally {
      try {
        await deleteProject(project.id);
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

  test("subagent 超时路径：失败状态与可读提示", async ({ page }) => {
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

      const card = page.locator(".subagent-card").first();
      await expect(card).toBeVisible({ timeout: 20000 });
      await expect(card).toHaveClass(/running/);
      await expect(card.locator("> button")).toHaveAttribute("aria-expanded", "true");
      await screenshot(page, "12a-subagent-timeout-running-expanded");

      // 等待 subagent 超时完成
      await expect(page.getByRole("button", { name: "Run analysis" })).toBeVisible({ timeout: 60000 });
      await expect(card).toHaveClass(/timed_out/);
      await expect(card.locator("> button")).toHaveAttribute("aria-expanded", "true");
      const details = card.locator(".subagent-details");
      await expect(details).toContainText(/timeout|timed out|exceeded/i);
      await screenshot(page, "12b-subagent-timeout-feedback");
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
