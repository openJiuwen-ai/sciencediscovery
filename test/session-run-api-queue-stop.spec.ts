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

import { expect } from "@playwright/test";
import type { SessionRunEvent } from "@sciencediscovery/schema";

import { test } from "./helpers/e2e.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { HANG_MODEL_ID, installStubModels, type StubModels } from "./support/stub-models.js";

// Static suite metadata is inherited by each framework-expanded journey.
test.describe("session-run-api-queue-stop.spec", { tag: ["@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@status:reviewed", "@model:mock", "@sandbox:bubblewrap"] }, () => {

const API_BASE = apiBaseUrl();
const AUTH = authorizationHeader();
const JSON_HEADERS = { ...AUTH, "content-type": "application/json" };

async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? JSON_HEADERS : AUTH),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
    throw new Error(`${path} failed (${response.status}): ${body.error ?? response.statusText}`);
  }
  return await response.json() as T;
}

async function maybeDeleteProject(projectId: string | undefined) {
  if (!projectId) return;
  await fetch(`${API_BASE}/api/projects/${encodeURIComponent(projectId)}`, {
    body: JSON.stringify({ confirmationId: projectId }),
    headers: JSON_HEADERS,
    method: "DELETE",
  }).catch(() => undefined);
}

async function waitForRunEvent(
  sessionId: string,
  runId: string,
  predicate: (event: SessionRunEvent["event"]) => boolean,
  after = 0,
) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const records = await apiJson<SessionRunEvent[]>(
      `/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/events?after=${after}`,
    );
    const match = records.find((record) => predicate(record.event));
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for run event on ${runId}`);
}

let stubs: StubModels | undefined;

test.beforeAll(async () => {
  stubs = await installStubModels();
});

test.afterAll(async () => {
  await stubs?.dispose();
});

/**
 * E2E-META
 * Purpose: 通过 REST API 验证运行队列：第二个 run 排队、事件序列可重放、取消当前 run 后队列继续、再次取消幂等。
 * Steps:
 *   1. 注册桩模型并创建项目与会话。
 *   2. POST 第一个 run，等待 running 事件。
 *   3. POST 第二个 run 断言 queued，并核对事件序列单调且可重放。
 *   4. 取消当前 run，断言 cancelled=true 且第一个 run 进入 cancelled。
 *   5. 断言第二个 run 开始，再次取消并断言其进入 cancelled。
 *   6. finally 删除项目。
 * Environment: 隔离本地栈；不启动浏览器；本 spec 自行注册 127.0.0.1 上的 hang-model 桩模型。
 * Type: mocked
 * LLM: 本地桩模型，接受流式请求后永不响应；不调用真实或付费模型。
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — 所有请求均指向 127.0.0.1。
 * Credentials: 隔离实例的 E2E_API_TOKEN 与桩模型令牌。
 * CostSideEffects: none；项目与桩模型在 finally/afterAll 中清理。
 */
test("runs API queues a follow-up while preserving current cancel and replay sequence", { tag: "@mocked" }, async () => {
  let projectId: string | undefined;
  try {
    const models = await apiJson<Array<{ id: string; model: string; name: string }>>("/api/models");
    const hangingModel = models.find((model) => model.model === HANG_MODEL_ID);
    expect(hangingModel, "the suite's hanging stub model is required").toBeTruthy();

    const project = await apiJson<{ id: string }>("/api/projects", {
      body: JSON.stringify({ name: `Queue Stop API E2E ${Date.now()}` }),
      method: "POST",
    });
    projectId = project.id;
    const session = await apiJson<{ id: string }>(`/api/projects/${encodeURIComponent(project.id)}/sessions`, {
      body: JSON.stringify({ modelId: hangingModel!.id, title: "Queue and stop API" }),
      method: "POST",
    });

    const first = await apiJson<{ id: string; status: string }>(`/api/sessions/${encodeURIComponent(session.id)}/runs`, {
      body: JSON.stringify({ content: "first prompt" }),
      method: "POST",
    });
    expect(first.status).toBe("queued");
    const firstStarted = await waitForRunEvent(session.id, first.id, (event) => event.type === "run.status" && event.status === "running");
    expect(firstStarted.sequence).toBeGreaterThan(0);

    const second = await apiJson<{ id: string; status: string }>(`/api/sessions/${encodeURIComponent(session.id)}/runs`, {
      body: JSON.stringify({ content: "second prompt" }),
      method: "POST",
    });
    expect(second.status).toBe("queued");

    const replay = await apiJson<SessionRunEvent[]>(
      `/api/sessions/${encodeURIComponent(session.id)}/runs/${encodeURIComponent(first.id)}/events?after=0`,
    );
    expect(replay.map((event) => event.sequence)).toEqual(replay.map((event) => event.sequence).sort((a, b) => a - b));
    expect(replay.some((event) => event.sequence === firstStarted.sequence)).toBe(true);

    const cancelled = await apiJson<{ cancelled: boolean; sessionId: string }>(
      `/api/sessions/${encodeURIComponent(session.id)}/runs/current/cancel`,
      { method: "POST" },
    );
    expect(cancelled).toMatchObject({ cancelled: true, sessionId: session.id });
    await waitForRunEvent(session.id, first.id, (event) => event.type === "run.status" && event.status === "cancelled");

    const secondStarted = await waitForRunEvent(session.id, second.id, (event) => event.type === "run.status" && event.status === "running");
    expect(secondStarted.sequence).toBeGreaterThan(0);
    await apiJson(`/api/sessions/${encodeURIComponent(session.id)}/runs/current/cancel`, { method: "POST" });
    await waitForRunEvent(session.id, second.id, (event) => event.type === "run.status" && event.status === "cancelled");
  } finally {
    await maybeDeleteProject(projectId);
  }
});

});
