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
import type { AddressInfo } from "node:net";

import { test, expect, type Page } from "@playwright/test";

import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";

/**
 * AgentRun / RequestExecution 组件化(commit 63db651)用户场景 E2E。
 * 行为保持重构:验证主对话一轮、权限卡最外层、父取消级联、maxTurns 截断
 * 等用户可见契约与 subagent 对齐基线一致。
 *
 * 运行:E2E_BASE_URL=http://127.0.0.1:4410 npx playwright test agent-run-componentization
 */

const SCREENSHOTS = "screenshots/agent-run-componentization";
const { authorization: AUTH } = authorizationHeader();
const API_BASE = apiBaseUrl(process.env, "http://127.0.0.1:4410");
const SUBAGENT_PRESET_MARKER = "Applied subagent preset general-purpose";

async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: `${SCREENSHOTS}/${name}.png`, fullPage: false });
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

async function createTestModel(baseUrl: string, name: string) {
  const response = await apiRequest("/api/models", {
    method: "POST",
    body: JSON.stringify({ apiToken: "e2e-mock-token", baseUrl, model: "agent-run-e2e-model", name, vision: false }),
  });
  return (await response.json()) as { id: string; name: string };
}

async function deleteTestModel(modelId: string) {
  await apiRequest(`/api/models/${encodeURIComponent(modelId)}`, { method: "DELETE" });
}

async function createProject(name: string) {
  const response = await apiRequest("/api/projects", { method: "POST", body: JSON.stringify({ name }) });
  return (await response.json()) as { id: string; name: string };
}

async function deleteProject(projectId: string) {
  await apiRequest(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
    body: JSON.stringify({ confirmationId: projectId }),
  });
}

async function createSession(
  projectId: string,
  modelId: string,
  title: string,
  approvalMode: "always_allow" | "ask_for_dangerous" = "always_allow",
) {
  const response = await apiRequest(`/api/projects/${encodeURIComponent(projectId)}/sessions`, {
    method: "POST",
    body: JSON.stringify({ approvalMode, modelId, title }),
  });
  return (await response.json()) as { id: string; title: string };
}

async function createProjectAndSession(
  page: Page,
  modelId: string,
  prefix: string,
  approvalMode: "always_allow" | "ask_for_dangerous" = "always_allow",
) {
  const project = await createProject(`${prefix} ${Date.now()}`);
  const session = await createSession(project.id, modelId, `${prefix} session ${Date.now()}`, approvalMode);

  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(page).toHaveTitle("ScienceDiscovery");
  await expect(page.locator(".brand strong")).toHaveText("ScienceDiscovery");

  const projectButton = page.locator(".nav-item").filter({ hasText: project.name });
  await expect(projectButton).toBeVisible();
  await projectButton.click();
  const sessionButton = page.locator(".nav-item").filter({ hasText: session.title });
  await expect(sessionButton).toBeVisible();
  await sessionButton.click();
  await expect(page.locator("h1")).toContainText(session.title);

  return { project, session };
}

type ChatMessage = { content?: string; role?: string };
type ChatBody = { messages?: ChatMessage[] };

function sseChunk(id: string, model: string, delta: Record<string, unknown>, finishReason: string | null, usage?: unknown) {
  return {
    choices: [{ delta, finish_reason: finishReason, index: 0 }],
    created: 1,
    id,
    model,
    object: "chat.completion.chunk",
    ...(usage ? { usage } : {}),
  };
}

function textChunks(id: string, model: string, text: string) {
  return [
    sseChunk(id, model, { content: text, role: "assistant" }, null),
    sseChunk(id, model, {}, "stop", { completion_tokens: 8, prompt_tokens: 20, total_tokens: 28 }),
  ];
}

function toolCallChunks(id: string, model: string, toolCalls: Array<{ args: unknown; callId: string; name: string }>) {
  return [
    sseChunk(id, model, {
      role: "assistant",
      tool_calls: toolCalls.map((call, index) => ({
        function: { arguments: JSON.stringify(call.args), name: call.name },
        id: call.callId,
        index,
        type: "function",
      })),
    }, null),
    sseChunk(id, model, {}, "tool_calls", { completion_tokens: 10, prompt_tokens: 25, total_tokens: 35 }),
  ];
}

function startMockLlm(
  handler: (body: ChatBody, ctx: { hasToolResult: boolean; isSubagent: boolean }) => Promise<unknown[]> | unknown[],
): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatBody;
      const systemPrompt = body.messages?.find((m) => m.role === "system")?.content ?? "";
      const ctx = {
        hasToolResult: body.messages?.some((m) => m.role === "tool") ?? false,
        isSubagent: systemPrompt.includes(SUBAGENT_PRESET_MARKER),
      };
      const payload = await handler(body, ctx);
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const chunk of payload) {
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      response.end("data: [DONE]\n\n");
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = (server.address() as AddressInfo);
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        stop: () => new Promise<void>((resolveStop) => {
          server.closeAllConnections?.();
          server.close(() => resolveStop());
        }),
      });
    });
    server.on("error", reject);
  });
}

function attachLogCollector(page: Page, logs: string[]) {
  page.on("console", (msg) => {
    const source = msg.location().url;
    if (msg.type() === "error" || msg.type() === "warning") {
      logs.push(`[${msg.type()}] ${msg.text()}${source ? ` @ ${source}` : ""}`);
    }
  });
  page.on("pageerror", (err) => logs.push(`[pageerror] ${err.message}`));
}

test.describe("AgentRun/RequestExecution 组件化用户场景 E2E", () => {
  test("S1 主对话正常一轮:发送→进行中反馈→流式完成→可复用", async ({ page }) => {
    test.setTimeout(120000);
    const logs: string[] = [];
    attachLogCollector(page, logs);

    const { baseUrl, stop } = await startMockLlm((_body, _ctx) =>
      textChunks("chatcmpl-main-round", "agent-run-e2e-model", "Main conversation round completed."));
    const model = await createTestModel(baseUrl, "AgentRun main-round model");
    let projectId: string | undefined;

    try {
      const { project } = await createProjectAndSession(page, model.id, "AgentRun main round");
      projectId = project.id;
      await screenshot(page, "s1-01-session-landing");

      const composer = page.locator(".composer textarea");
      await composer.fill("Give me a one-line confirmation that the main conversation works.");
      const runButton = page.getByRole("button", { name: "Run analysis" });
      await expect(runButton).toBeEnabled();

      const [messageResponse] = await Promise.all([
        page.waitForResponse((response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname.match(/\/api\/sessions\/[^/]+\/messages$/) !== null),
        runButton.click(),
      ]);
      expect(messageResponse.status(), "message run should start successfully").toBe(200);

      // 进行中反馈:主按钮切换为可点的 Stop,用户随时可中止本会话的 run
      const sendButton = page.getByRole("button", { name: "Stop the current run" });
      await expect(sendButton).toBeVisible({ timeout: 20000 });
      await expect(sendButton).toBeEnabled();
      await screenshot(page, "s1-02-running-feedback");

      // 完成反馈:助手消息可见、按钮恢复、输入框可继续用
      const assistantMessage = page.locator(".message.assistant").last();
      await expect(assistantMessage).toContainText("Main conversation round completed.", { timeout: 60000 });
      await expect(assistantMessage.locator(".message-role")).toContainText("ScienceDiscovery");
      await expect(page.getByRole("button", { name: "Run analysis" })).toBeVisible({ timeout: 60000 });
      await expect(composer).toBeEnabled();
      await screenshot(page, "s1-03-completed-desktop");

      // 移动端视口布局抽检
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(assistantMessage).toContainText("Main conversation round completed.");
      await screenshot(page, "s1-04-completed-mobile");

      const consoleErrors = logs.filter((line) => line.startsWith("[error]") || line.startsWith("[pageerror]"));
      expect(consoleErrors, `no console/page errors expected, got: ${consoleErrors.join("; ")}`).toEqual([]);
    } finally {
      if (projectId) await deleteProject(projectId).catch(() => undefined);
      await deleteTestModel(model.id).catch(() => undefined);
      await stop();
      if (logs.length) console.log(`--- CONSOLE LOGS ---\n${logs.join("\n")}\n--- END CONSOLE LOGS ---`);
    }
  });

  test("S2 权限卡出现在主对话最外层,批准 Once 后运行继续完成", async ({ page }) => {
    test.setTimeout(180000);
    const logs: string[] = [];
    attachLogCollector(page, logs);

    const { baseUrl, stop } = await startMockLlm((_body, ctx) => {
      if (ctx.hasToolResult) {
        return textChunks("chatcmpl-permission-final", "agent-run-e2e-model", "Code executed successfully after approval.");
      }
      return toolCallChunks("chatcmpl-permission-code", "agent-run-e2e-model", [{
        args: { code: "print('hello from sandbox')" },
        callId: "call-run-python-1",
        name: "run_python",
      }]);
    });
    const model = await createTestModel(baseUrl, "AgentRun permission model");
    let projectId: string | undefined;

    try {
      const { project } = await createProjectAndSession(page, model.id, "AgentRun permission");
      projectId = project.id;

      const composer = page.locator(".composer textarea");
      await composer.fill("Run a short Python snippet in the workspace sandbox.");
      await page.getByRole("button", { name: "Run analysis" }).click();

      // 权限卡出现在主对话层(非嵌套 subagent 卡片内)
      const permissionSection = page.locator("section[aria-label='Permission cards']");
      await expect(permissionSection).toBeVisible({ timeout: 30000 });
      await expect(permissionSection).toContainText("Permission required");
      await expect(permissionSection).toContainText(/Run python code/i);
      // 运行仍在等待用户决策
      await expect(page.getByRole("button", { name: "Stop the current run" })).toBeVisible();
      await expect(page.locator(".subagent-card .permission-card")).toHaveCount(0);
      await permissionSection.scrollIntoViewIfNeeded();
      await screenshot(page, "s2-01-permission-card-outermost");

      // 默认 Once 范围,点击 Allow
      await permissionSection.getByRole("button", { name: "Allow" }).click();

      // 批准后运行继续并最终完成;权限卡消失
      const assistantMessage = page.locator(".message.assistant").last();
      await expect(assistantMessage).toContainText("Code executed successfully after approval.", { timeout: 120000 });
      await expect(page.getByRole("button", { name: "Run analysis" })).toBeVisible({ timeout: 120000 });
      await expect(permissionSection).toBeHidden();
      await screenshot(page, "s2-02-completed-after-approval");

      const consoleErrors = logs.filter((line) => line.startsWith("[error]") || line.startsWith("[pageerror]"));
      expect(consoleErrors, `no console/page errors expected, got: ${consoleErrors.join("; ")}`).toEqual([]);
    } finally {
      if (projectId) await deleteProject(projectId).catch(() => undefined);
      await deleteTestModel(model.id).catch(() => undefined);
      await stop();
      if (logs.length) console.log(`--- CONSOLE LOGS ---\n${logs.join("\n")}\n--- END CONSOLE LOGS ---`);
    }
  });

  test("S2b subagent 首个受控工具的权限卡也出现在主对话最外层", async ({ page }) => {
    test.setTimeout(180000);
    const logs: string[] = [];
    attachLogCollector(page, logs);

    const { baseUrl, stop } = await startMockLlm((_body, ctx) => {
      if (ctx.isSubagent) {
        if (ctx.hasToolResult) {
          return textChunks("chatcmpl-subagent-perm-final", "agent-run-e2e-model", "Subagent ran the approved code.");
        }
        return toolCallChunks("chatcmpl-subagent-perm-code", "agent-run-e2e-model", [{
          args: { code: "print('subagent sandbox')" },
          callId: "call-subagent-run-python",
          name: "run_python",
        }]);
      }
      if (ctx.hasToolResult) {
        return textChunks("chatcmpl-parent-perm-final", "agent-run-e2e-model", "Parent received the subagent result.");
      }
      return toolCallChunks("chatcmpl-parent-perm-task", "agent-run-e2e-model", [{
        args: {
          description: "Run code in subagent",
          prompt: "Execute a short Python snippet and report the output.",
          subagent_type: "general-purpose",
        },
        callId: "call-task-perm",
        name: "task",
      }]);
    });
    const model = await createTestModel(baseUrl, "AgentRun subagent-permission model");
    let projectId: string | undefined;

    try {
      const { project } = await createProjectAndSession(page, model.id, "AgentRun subagent permission");
      projectId = project.id;

      await page.locator(".composer textarea").fill("Delegate a task that needs sandbox code execution.");
      await page.getByRole("button", { name: "Run analysis" }).click();

      const card = page.locator(".subagent-card").first();
      await expect(card).toBeVisible({ timeout: 30000 });
      await expect(card).toHaveClass(/running/);

      // 子 Agent 触发的权限请求同样浮到主对话最外层,且不嵌在 subagent 卡片里
      const permissionSection = page.locator("section[aria-label='Permission cards']");
      await expect(permissionSection).toBeVisible({ timeout: 30000 });
      await expect(permissionSection).toContainText(/Run python code/i);
      await expect(page.locator(".subagent-card .permission-card")).toHaveCount(0);
      await permissionSection.scrollIntoViewIfNeeded();
      await screenshot(page, "s2b-01-subagent-permission-outermost");

      await permissionSection.getByRole("button", { name: "Allow" }).click();

      // 批准后 subagent 继续并完成,父运行正常收尾
      await expect(card).toHaveClass(/completed/, { timeout: 120000 });
      const assistantMessage = page.locator(".message.assistant").last();
      await expect(assistantMessage).toContainText("Parent received the subagent result.", { timeout: 120000 });
      await expect(page.getByRole("button", { name: "Run analysis" })).toBeVisible({ timeout: 120000 });
      await expect(permissionSection).toBeHidden();
      await screenshot(page, "s2b-02-subagent-permission-completed");

      const consoleErrors = logs.filter((line) => line.startsWith("[error]") || line.startsWith("[pageerror]"));
      expect(consoleErrors, `no console/page errors expected, got: ${consoleErrors.join("; ")}`).toEqual([]);
    } finally {
      if (projectId) await deleteProject(projectId).catch(() => undefined);
      await deleteTestModel(model.id).catch(() => undefined);
      await stop();
      if (logs.length) console.log(`--- CONSOLE LOGS ---\n${logs.join("\n")}\n--- END CONSOLE LOGS ---`);
    }
  });

  test("S3 检视缺口①:同轮并发两个 run_python,同键 once 权限的用户可见行为", async ({ page }) => {
    test.setTimeout(240000);
    const logs: string[] = [];
    attachLogCollector(page, logs);

    const { baseUrl, stop } = await startMockLlm((_body, ctx) => {
      if (ctx.hasToolResult) {
        return textChunks("chatcmpl-concurrent-final", "agent-run-e2e-model", "Both concurrent code executions finished.");
      }
      return toolCallChunks("chatcmpl-concurrent-code", "agent-run-e2e-model", [
        { args: { code: "print('first')" }, callId: "call-run-python-a", name: "run_python" },
        { args: { code: "print('second')" }, callId: "call-run-python-b", name: "run_python" },
      ]);
    });
    const model = await createTestModel(baseUrl, "AgentRun concurrent-permission model");
    let projectId: string | undefined;

    try {
      const { project, session } = await createProjectAndSession(
        page,
        model.id,
        "AgentRun concurrent permission",
        "ask_for_dangerous",
      );
      projectId = project.id;

      await page.locator(".composer textarea").fill("Run two independent Python snippets concurrently.");
      await page.getByRole("button", { name: "Run analysis" }).click();

      const timeline = page.getByRole("region", { name: "Agent activity" });
      const pendingCards = timeline.locator(".timeline-permission.pending");
      await expect(pendingCards).toHaveCount(2, { timeout: 30000 });
      await pendingCards.first().scrollIntoViewIfNeeded();
      await screenshot(page, "s3-01-concurrent-pending-cards");

      // Allow once 只授权点选请求；仍有活跃 waiter 的同键 sibling 保持可独立决策。
      await pendingCards.first().getByRole("button", { name: "Allow once" }).click();
      await expect(timeline.locator(".timeline-permission.allowed")).toHaveCount(1);
      await expect(timeline.locator(".timeline-permission.pending")).toHaveCount(1);
      await expect(timeline.locator(".timeline-permission.cancelled")).toHaveCount(0);
      await expect(timeline.getByRole("button", { name: "Allow once" })).toHaveCount(1);
      const liveRequestsResponse = await apiRequest(`/api/permission-requests?sessionId=${encodeURIComponent(session.id)}`);
      const liveRequests = (await liveRequestsResponse.json()) as Array<{
        decidedAt?: string;
        id: string;
        permissionAuthorizationId?: string;
        state: string;
        summary: string;
      }>;
      expect(liveRequests.filter((r) => r.state === "allowed")).toHaveLength(1);
      expect(liveRequests.filter((r) => r.state === "pending"), "live sibling remains pending").toHaveLength(1);
      expect(liveRequests.filter((r) => r.state === "cancelled")).toHaveLength(0);
      await screenshot(page, "s3-02-once-keeps-live-sibling-pending");

      // waiter 仍在时 pending 是正常状态；用户终止 run 后，teardown 才取消该 request。
      await page.getByRole("button", { name: "Stop the current run" }).click();
      await expect(page.getByRole("button", { name: "Run analysis" })).toBeVisible({ timeout: 30000 });
      await expect(timeline.locator(".timeline-permission.pending")).toHaveCount(0);
      await expect(timeline.locator(".timeline-permission.allowed")).toHaveCount(1);
      await expect(timeline.locator(".timeline-permission.cancelled")).toHaveCount(1);
      await expect(timeline.getByRole("button", { name: "Allow once" })).toHaveCount(0);
      const requestsResponse = await apiRequest(`/api/permission-requests?sessionId=${encodeURIComponent(session.id)}`);
      const requests = (await requestsResponse.json()) as typeof liveRequests;
      console.log(`S3 permission requests: ${JSON.stringify(requests.map((r) => ({ state: r.state, summary: r.summary })))}`);
      expect(requests.filter((r) => r.state === "allowed")).toHaveLength(1);
      expect(requests.filter((r) => r.state === "pending"), "run teardown leaves no orphan pending").toHaveLength(0);
      expect(requests.filter((r) => r.state === "cancelled")).toHaveLength(1);
      const cancelled = requests.find((r) => r.state === "cancelled");
      expect(cancelled?.decidedAt).toBeTruthy();
      expect(cancelled?.permissionAuthorizationId, "teardown cancellation creates no authorization").toBeUndefined();
      const dismissNotifications = page.getByRole("button", { name: "Dismiss notification" });
      while (await dismissNotifications.count()) await dismissNotifications.first().click();
      await timeline.locator(".timeline-permission.cancelled").scrollIntoViewIfNeeded();
      await screenshot(page, "s3-03-stop-cancels-abandoned-pending-card");

      const unexpectedErrors = logs.filter((line) =>
        (line.startsWith("[error]") || line.startsWith("[pageerror]"))
        && !line.includes("/api/environments"));
      expect(
        unexpectedErrors,
        `no permission-flow console/page errors expected, got: ${unexpectedErrors.join("; ")}`,
      ).toEqual([]);
    } finally {
      if (projectId) await deleteProject(projectId).catch(() => undefined);
      await deleteTestModel(model.id).catch(() => undefined);
      await stop();
      if (logs.length) console.log(`--- CONSOLE LOGS ---\n${logs.join("\n")}\n--- END CONSOLE LOGS ---`);
    }
  });

  test("S4 检视缺口②:中断主对话连接后 subagent 级联取消,重进会话状态可读", async ({ page, context }) => {
    test.setTimeout(180000);
    const logs: string[] = [];
    attachLogCollector(page, logs);

    const { baseUrl, stop } = await startMockLlm(async (_body, ctx) => {
      if (ctx.isSubagent) {
        // 保持 subagent 长时间运行,以便父取消发生在其运行中
        await new Promise((resolve) => setTimeout(resolve, 60000));
        return textChunks("chatcmpl-subagent-late", "agent-run-e2e-model", "Subagent finished too late.");
      }
      if (ctx.hasToolResult) {
        return textChunks("chatcmpl-cancel-final", "agent-run-e2e-model", "Parent continued after subagent.");
      }
      return toolCallChunks("chatcmpl-cancel-task", "agent-run-e2e-model", [{
        args: {
          description: "Long running inspection",
          prompt: "Inspect the workspace slowly.",
          subagent_type: "general-purpose",
          timeout_seconds: 120,
        },
        callId: "call-task-cancel",
        name: "task",
      }]);
    });
    const model = await createTestModel(baseUrl, "AgentRun cancel model");
    let projectId: string | undefined;

    try {
      const { project, session } = await createProjectAndSession(page, model.id, "AgentRun cancel");
      projectId = project.id;

      await page.locator(".composer textarea").fill("Start a long subagent task that I will abandon.");
      await page.getByRole("button", { name: "Run analysis" }).click();

      const card = page.locator(".subagent-card").first();
      await expect(card).toBeVisible({ timeout: 30000 });
      await expect(card).toHaveClass(/running/);
      await screenshot(page, "s4-01-subagent-running-before-abort");

      // 用户级取消方式:关闭页面,浏览器中断 SSE 连接,服务端应中止运行并级联取消 subagent
      await page.close();
      await page.waitForTimeout(3000).catch(() => undefined);

      // 重新打开会话:卡片必须进入可读的终态(cancelled),不能停留在 running
      const page2 = await context.newPage();
      attachLogCollector(page2, logs);
      await page2.goto("/");
      await page2.waitForLoadState("networkidle");
      await page2.locator(".nav-item").filter({ hasText: project.name }).click();
      await page2.locator(".nav-item").filter({ hasText: session.title }).click();
      await expect(page2.locator("h1")).toContainText(session.title);

      const cardAfter = page2.locator(".subagent-card").first();
      await expect(cardAfter).toBeVisible({ timeout: 20000 });
      await expect(cardAfter).toHaveClass(/cancelled/, { timeout: 30000 });
      await expect(cardAfter).not.toHaveClass(/running/);
      await expect(page2.locator(".subagent-list-heading")).toContainText("0 running");
      // 展开卡片,错误/状态信息可读
      await cardAfter.locator("> button").click();
      await expect(cardAfter.locator(".subagent-details")).toBeVisible();
      await screenshot(page2, "s4-02-subagent-cancelled-after-reopen");
      await page2.close();
    } finally {
      if (projectId) await deleteProject(projectId).catch(() => undefined);
      await deleteTestModel(model.id).catch(() => undefined);
      await stop();
      if (logs.length) console.log(`--- CONSOLE LOGS ---\n${logs.join("\n")}\n--- END CONSOLE LOGS ---`);
    }
  });

  test("S5 检视缺口④:subagent 超过 maxTurns 被截断,卡片终态与原因可读", async ({ page }) => {
    test.setTimeout(180000);
    const logs: string[] = [];
    attachLogCollector(page, logs);

    const { baseUrl, stop } = await startMockLlm((_body, ctx) => {
      if (ctx.isSubagent) {
        // subagent 永远只调 list_files,必然撞 maxTurns
        return toolCallChunks("chatcmpl-subagent-loop", "agent-run-e2e-model", [{
          args: {},
          callId: `call-list-files-${Math.random().toString(36).slice(2)}`,
          name: "list_files",
        }]);
      }
      if (ctx.hasToolResult) {
        return textChunks("chatcmpl-maxturns-final", "agent-run-e2e-model", "The subagent was stopped by its turn limit.");
      }
      return toolCallChunks("chatcmpl-maxturns-task", "agent-run-e2e-model", [{
        args: {
          description: "Looping inspection",
          max_turns: 2,
          prompt: "Keep listing files forever.",
          subagent_type: "general-purpose",
        },
        callId: "call-task-maxturns",
        name: "task",
      }]);
    });
    const model = await createTestModel(baseUrl, "AgentRun maxTurns model");
    let projectId: string | undefined;

    try {
      const { project } = await createProjectAndSession(page, model.id, "AgentRun maxTurns");
      projectId = project.id;

      await page.locator(".composer textarea").fill("Delegate a task with a very small turn limit.");
      await page.getByRole("button", { name: "Run analysis" }).click();

      const card = page.locator(".subagent-card").first();
      await expect(card).toBeVisible({ timeout: 30000 });

      // 截断终态:卡片进入 timed_out 且给出 maxTurns 原因
      await expect(card).toHaveClass(/timed_out/, { timeout: 90000 });
      await expect(page.getByRole("button", { name: "Run analysis" })).toBeVisible({ timeout: 90000 });
      const toggle = card.locator("> button");
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
      const details = card.locator(".subagent-details");
      await expect(details).toContainText(/maxTurns/i);
      await screenshot(page, "s5-01-maxturns-truncated-card");

      // 父运行收到截断结果后正常收尾
      const assistantMessage = page.locator(".message.assistant").last();
      await expect(assistantMessage).toContainText("The subagent was stopped by its turn limit.");
      await screenshot(page, "s5-02-parent-recovered");

      const consoleErrors = logs.filter((line) => line.startsWith("[error]") || line.startsWith("[pageerror]"));
      expect(consoleErrors, `no console/page errors expected, got: ${consoleErrors.join("; ")}`).toEqual([]);
    } finally {
      if (projectId) await deleteProject(projectId).catch(() => undefined);
      await deleteTestModel(model.id).catch(() => undefined);
      await stop();
      if (logs.length) console.log(`--- CONSOLE LOGS ---\n${logs.join("\n")}\n--- END CONSOLE LOGS ---`);
    }
  });
});
