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
import { expect } from "@playwright/test";

import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { test } from "./helpers/e2e.ts";
import { cleanupJourney, createProjectAndSession, openProjectSession, sendUserMessage, waitForRunTerminal, type JourneyFixture } from "./helpers/journeys.ts";

/** A real local endpoint can reject a request, pause it while the user switches
 * Sessions, and recover. No provider or public network is involved. */
async function recoverableModel() {
  let mode: "reject" | "wait" | "accept" = "reject";
  let waiting = false;
  let release = () => {};
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const reject = () => {
        waiting = false;
        release = () => {};
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "COPY_TEST_PROVIDER_DETAIL <invalid credential>" } }));
      };
      if (mode === "wait") {
        waiting = true;
        release = reject;
      } else if (mode === "reject") reject();
      else {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          { choices: [{ delta: { content: "COPY_TEST_RECOVERY_OK" }, finish_reason: null, index: 0 }] },
          { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
        ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    setMode: (value: typeof mode) => { mode = value; },
    isWaiting: () => waiting,
    releaseFailure: () => release(),
    stop: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }),
  };
}

for (const locale of ["zh-CN", "en"] as const) {
  for (const classified of [true, false]) {
    /**
     * E2E-META
     * Purpose: Read localized actionable Run failures, inspect optional diagnostics, and continue after recovery, including a background Session failure.
     * Steps:
     *   1. Submit a task to a rejecting local model and read recovery guidance without raw diagnostics.
     *   2. Inspect technical details at 390px, then retry successfully after the model recovers.
     *   3. Switch Sessions while a request is pending and read the failed Session's localized notification.
     *   4. Inspect the background failure at 960px and continue the current Session successfully.
     * Environment: Isolated built API/Web at E2E_BASE_URL; no Runner or sidecars needed for text-only requests.
     * Type: mocked
     * LLM: journey-owned loopback endpoint returning deterministic 401 or successful SSE text.
     * WebSearch: none
     * PaperSources: none
     * MCP: none
     * OtherExternal: none; the unclassified variant removes only errorCode from the browser's run.failed SSE frame to simulate older producers.
     * Credentials: E2E_API_TOKEN for the isolated API; synthetic model credential with no external access.
     * CostSideEffects: Journey-owned model, Project and Sessions removed in finally; no external requests or cost.
     */
    test(`Run failure ${locale} ${classified ? "classified" : "unclassified"} guidance and recovery`, {
      tag: ["@mocked", "@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:none"],
    }, async ({ page, journey }) => {
      test.setTimeout(90_000);
      const zh = locale === "zh-CN";
      const title = zh ? "运行失败" : "Run failed";
      const detailsLabel = zh ? "技术详情" : "Technical details";
      const guidance = classified
        ? (zh ? "模型服务拒绝了当前凭据，请检查模型注册表中的 API Key 后重试。" : "The model service rejected the credentials. Check the API key in the model registry and retry.")
        : (zh ? "任务未能完成，运行已停止。请重试任务；若再次失败，可展开技术详情以排查原因。" : "The task stopped before it could finish. Retry the task; if it fails again, open the technical details to help diagnose the problem.");
      const model = await recoverableModel();
      let fixture: JourneyFixture | undefined;
      let otherSessionId: string;
      journey.scenario({ goal: "运行失败时先读懂原因和恢复办法，需要时展开技术详情；切换会话后仍能理解后台失败并继续工作。", preconditions: [`界面语言 ${locale}`, classified ? "服务返回稳定失败分类" : "模拟旧生产者未提供失败分类", "独立 API/Web，仅调用本地模型桩"] });
      await page.addInitScript(value => localStorage.setItem("sciencediscovery-locale", value), locale);
      if (!classified) {
        await page.route("**/api/sessions/*/messages", async route => {
          const response = await route.fetch();
          const body = (await response.text()).split("\n").map(line => {
            if (!line.startsWith("data: ")) return line;
            const event = JSON.parse(line.slice(6));
            if (event.type === "run.failed") delete event.errorCode;
            return `data: ${JSON.stringify(event)}`;
          }).join("\n");
          await route.fulfill({ response, body });
        });
      }
      const toast = page.locator(".toast.error");
      try {
        fixture = await createProjectAndSession(page, { projectName: `Failure copy ${locale} ${Date.now()}`, sessionTitle: "Failure copy session", model: { baseUrl: model.baseUrl, apiToken: "copy-test-local-only", model: "copy-test", name: `Failure copy ${Date.now()}`, apiVariant: "openai" } });
        // Populate both Sessions before opening the navigation snapshot.
        const response = await page.request.post(`${apiBaseUrl()}/api/projects/${fixture.project.id}/sessions`, { headers: authorizationHeader(), data: { title: "Other copy session", modelId: fixture.model!.id } });
        expect(response.ok()).toBe(true);
        otherSessionId = (await response.json()).id;
        await openProjectSession(page, fixture);
        await journey.step("提交任务并理解失败", "失败通知使用当前语言说明原因和恢复办法，底层错误默认折叠。", async () => {
          const run = await sendUserMessage(page, fixture!.session.id, "Check failure feedback");
          expect((await waitForRunTerminal(page, fixture!.session.id, run.id)).status).toBe("failed");
          await expect(toast.locator("strong")).toHaveText(title);
          await expect(toast.locator("small")).toHaveText(guidance);
          await expect(toast.locator("pre")).toBeHidden();
          await expect(toast.locator("small")).not.toContainText("COPY_TEST_PROVIDER_DETAIL");
        });
        await journey.step("在窄屏查看技术详情", "390 像素宽度下，恢复说明完整显示，展开后可读取原始诊断。", async () => {
          await page.setViewportSize({ width: 390, height: 844 });
          await toast.getByText(detailsLabel, { exact: true }).click();
          await expect(toast.locator("pre")).toContainText("COPY_TEST_PROVIDER_DETAIL <invalid credential>");
          await expect(toast.locator("pre")).toBeVisible();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          const copy = toast.locator("small");
          expect(await copy.evaluate(node => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
        });
        await journey.step("恢复服务后重试", "相同会话可再次提交并收到完成结果。", async () => {
          await toast.locator("button").click();
          await page.setViewportSize({ width: 1440, height: 900 });
          model.setMode("accept");
          const run = await sendUserMessage(page, fixture!.session.id, "Retry after recovery");
          expect((await waitForRunTerminal(page, fixture!.session.id, run.id)).status).toBe("completed");
          await expect(page.getByText("COPY_TEST_RECOVERY_OK", { exact: true }).first()).toBeVisible();
        });
        await journey.step("切换会话后查看后台失败", "通知以当前语言标明失败会话，保留当前会话与草稿。", async () => {
          model.setMode("wait");
          await sendUserMessage(page, fixture!.session.id, "Fail while in another session");
          await expect.poll(model.isWaiting).toBe(true);
          await page.locator("#sessions-panel-content button.nav-item").filter({ hasText: "Other copy session" }).click();
          await expect(page.getByRole("heading", { name: "Other copy session", exact: true })).toBeVisible();
          await page.locator("form.composer").getByRole("textbox").fill("Keep this draft");
          model.releaseFailure();
          await expect(toast.locator("strong")).toHaveText(`${title} · Failure copy session`);
          await expect(toast.locator("small")).toHaveText(guidance);
          await expect(toast.locator("pre")).toBeHidden();
          await expect(page.locator("form.composer").getByRole("textbox")).toHaveValue("Keep this draft");
        });
        await journey.step("查看后台错误详情", "960 像素宽度下可展开技术详情并关闭通知。", async () => {
          await page.setViewportSize({ width: 960, height: 600 });
          await toast.getByText(detailsLabel, { exact: true }).click();
          await expect(toast.locator("pre")).toContainText("COPY_TEST_PROVIDER_DETAIL");
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        });
        await journey.step("继续当前会话", "关闭通知后当前会话可提交新任务并完成。", async () => {
          await toast.locator("button").click();
          model.setMode("accept");
          const run = await sendUserMessage(page, otherSessionId, "Continue current session");
          expect((await waitForRunTerminal(page, otherSessionId, run.id)).status).toBe("completed");
          await expect(page.getByText("COPY_TEST_RECOVERY_OK", { exact: true }).first()).toBeVisible();
        });
      } finally {
        model.releaseFailure();
        try { if (fixture) await cleanupJourney(page, fixture); }
        finally { await model.stop(); }
      }
    });
  }
}
