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

import { expect, test } from "@playwright/test";

import { authorizationHeader } from "./e2e-auth.js";

const authorization = authorizationHeader();

/** Remove leftover toasts so screenshots show a stable, caption-consistent final state. */
async function dismissAllToasts(page: import("@playwright/test").Page): Promise<void> {
  const dismiss = page.getByRole("button", { name: "Dismiss notification" });
  while ((await dismiss.count()) > 0) {
    await dismiss.first().click();
  }
  await expect(page.locator("[role='status']")).toHaveCount(0);
}

test("用户可配置无限超时、查看运行状态并在会话中追溯超时原因", async ({ page, request }) => {
  test.setTimeout(60_000);
  const projectName = `E2E Runtime ${Date.now()}`;
  const sessionName = `Timeout Session ${Date.now()}`;
  const modelServer = createServer(async (incoming) => {
    for await (const _chunk of incoming) {
      // Consume the model request, then deliberately remain silent.
    }
  });
  await new Promise<void>((resolveListen) => modelServer.listen(0, "127.0.0.1", resolveListen));
  const modelOrigin = `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1`;

  const originalTimeouts = await (await request.get("/api/timeout-settings", { headers: authorization })).json();
  let projectId: string | undefined;
  let modelId: string | undefined;
  try {
    const modelResponse = await request.post("/api/models", {
      data: {
        apiToken: "e2e-silent-model-token",
        baseUrl: modelOrigin,
        model: "silent-e2e-model",
        name: `Silent E2E ${Date.now()}`,
      },
      headers: authorization,
    });
    expect(modelResponse.ok()).toBe(true);
    modelId = (await modelResponse.json()).id;

    const projectResponse = await request.post("/api/projects", {
      data: { name: projectName },
      headers: authorization,
    });
    expect(projectResponse.ok()).toBe(true);
    projectId = (await projectResponse.json()).id;

    const sessionResponse = await request.post(`/api/projects/${projectId}/sessions`, {
      data: {
        settingsOverrides: {
          modelId,
          reviewModelId: modelId,
          semanticReviewEnabled: false,
        },
        title: sessionName,
      },
      headers: authorization,
    });
    expect(sessionResponse.ok()).toBe(true);
    const sessionId = (await sessionResponse.json()).id as string;

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: "System configuration" }).click();
    const configuration = page.getByRole("dialog", { name: "System configuration" });
    await configuration.getByRole("button", { name: "Timeouts" }).click();
    await expect(configuration.getByRole("heading", { name: "Timeouts" })).toBeVisible();
    for (const label of ["Agent turn", "Runner execution", "Kernel idle", "Permission wait"]) {
      await configuration.locator("fieldset").filter({ hasText: label }).getByLabel("Unlimited").check();
    }
    await configuration.getByLabel("Agent idle timeout in seconds").fill("5");
    await configuration.getByRole("button", { name: "Save timeouts" }).click();
    await expect(page.locator("[role='status']").filter({ hasText: "Timeout settings saved" })).toBeVisible();
    await configuration.locator(".settings-group-detail").evaluate((element) => { element.scrollTop = 0; });
    await page.screenshot({ path: "screenshots/timeouts-settings.png" });

    await configuration.getByRole("button", { name: "Runtime status" }).click();
    await expect(configuration.getByRole("heading", { name: "Runtime status" })).toBeVisible();
    await expect(configuration.getByText("Runner is healthy; no execution is active.")).toBeVisible();
    await configuration.getByRole("button", { name: "Done" }).click();

    await page.getByRole("button", { name: projectName, exact: true }).click();
    await page.getByRole("button", { name: sessionName, exact: true }).click();
    await expect(page.getByRole("heading", { name: sessionName })).toBeVisible();

    await page.locator(".composer textarea").fill("Start a run that I will stop.");
    await page.getByRole("button", { name: "Run analysis" }).click();
    const stopRun = page.getByRole("button", { name: "Stop the current run" });
    await expect(stopRun).toBeVisible();
    await dismissAllToasts(page);
    await page.screenshot({ path: "screenshots/run-stop-control.png" });
    await stopRun.click();
    await expect(page.locator("[role='status']").filter({ hasText: "Run stopped" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Run analysis" })).toBeVisible();

    await page.locator(".composer textarea").fill("Wait for the deliberately silent model.");
    await page.getByRole("button", { name: "Run analysis" }).click();
    await expect(page.getByRole("button", { name: "Stop the current run" })).toBeVisible();

    await page.getByRole("button", { name: "System configuration" }).click();
    await configuration.getByRole("button", { name: "Runtime status" }).click();
    await expect(configuration.getByText(sessionName, { exact: true })).toBeVisible();
    await dismissAllToasts(page);
    await page.screenshot({ path: "screenshots/runtime-status-running.png" });
    await configuration.getByRole("button", { name: "Done" }).click();

    const notice = page.locator(".message.assistant.timeout-notice");
    await expect(notice).toContainText("Agent idle timeout was reached after 5 seconds", { timeout: 15_000 });
    await expect(page.locator("[role='status']").filter({ hasText: "Request error" })).toBeVisible();
    await dismissAllToasts(page);
    await page.screenshot({ path: "screenshots/timeout-conversation-notice.png" });

    const detailResponse = await request.get(`/api/sessions/${sessionId}`, { headers: authorization });
    expect(detailResponse.ok()).toBe(true);
    const detail = await detailResponse.json();
    expect(detail.messages.at(-1).kind).toBe("timeout_notice");
    expect(detail.messages.at(-1).timeout).toMatchObject({ kind: "gateway_idle", timeoutMs: 5_000 });
  } finally {
    await request.put("/api/timeout-settings", { data: originalTimeouts, headers: authorization });
    if (projectId) {
      await request.delete(`/api/projects/${projectId}`, {
        data: { confirmationId: projectId },
        headers: authorization,
      });
    }
    if (modelId) await request.delete(`/api/models/${modelId}`, { headers: authorization });
    modelServer.closeAllConnections();
    await new Promise<void>((resolveClose) => modelServer.close(() => resolveClose()));
  }
});
