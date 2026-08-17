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

import { test } from "./helpers/e2e.ts";
import {
  cleanupJourney,
  createProjectAndSession,
  currentEnvironmentRevision,
  environmentSetup,
  expandToolStep,
  openEnvironmentPage,
  openProjectSession,
  scriptedModel,
  sendUserMessage,
  waitForRunTerminal,
  type JourneyFixture,
} from "./helpers/journeys.ts";

/**
 * E2E-META
 * Purpose: A user can create a named Python environment in settings, use its immutable revision in an Agent request, inspect provenance, and delete it.
 * Steps:
 *   1. Verify the isolated stack already has a ready managed Python base, then open Environments through the UI.
 *   2. Inspect separate pip/conda sources and the read-only base; create a named Python environment through the UI.
 *   3. Confirm package installation controls exist without invoking them, then read the created environment's current revision through REST for stub injection only.
 *   4. Tell the Agent the environment name and verify marked Python output plus environment provenance.
 *   5. Return to settings and delete the named environment through the UI.
 * Environment: Isolated local stack at E2E_BASE_URL with managed Python setup already ready; no package installation is performed.
 * Type: mocked
 * LLM: journey-owned OpenAI-compatible HTTP stub on 127.0.0.1; deterministic run_python call using the UI-created revision.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — no package-channel access; Python executes in the offline local sandbox and non-local browser requests are aborted.
 * Credentials: E2E_API_TOKEN for the isolated local API only; the stub token has no external access.
 * CostSideEffects: no external cost; creates and deletes one local named environment plus temporary model/Project records.
 */
test("J3 准备命名环境后让 Agent 使用并留下溯源", { tag: "@mocked" }, async ({ journey, page }, testInfo) => {
  test.setTimeout(240_000);
  journey.scenario({
    goal: "一位研究员不想在共享的基础环境里乱动东西，要给自己的分析准备一个独立的命名计算环境，"
      + "让后续计算真的跑在上面，事后还能核对「刚才那次计算用的就是我建的环境」，用完再删掉。",
    preconditions: [
      "隔离栈已启动，且托管 Python base 已经就绪（未就绪时本旅程记为 BLOCKED，不记通过）",
      "本旅程只做创建 / 查看 / 选用 / 删除，不执行任何联网的软件包安装",
      "模型由旅程自带的本地 stub 驱动，替用户说出环境名并传入该环境的当前修订",
    ],
  });

  const environmentName = `j3-python-${Date.now()}`;
  let manager!: Awaited<ReturnType<typeof openEnvironmentPage>>;
  let revision!: Awaited<ReturnType<typeof currentEnvironmentRevision>>["revision"];

  await journey.step(
    "确认托管 Python 已就绪，并打开环境设置页",
    "系统设置里的「环境」页显示托管 Python 已经 Ready；base 没就绪时这条旅程应当被判为前置未满足。",
    async () => {
      const setup = await environmentSetup(page);
      testInfo.skip(
        setup.state !== "ready",
        `BLOCKED: managed Python base is not ready (${setup.state}: ${setup.message})`,
      );
      await page.goto("/");
      manager = await openEnvironmentPage(page);
      await expect(manager.locator(".environment-setup-state")).toContainText("Ready");
    },
  );

  await journey.step(
    "查看软件源与只读的基础环境",
    "pip 与 conda 各有独立的来源选择器，Huawei Cloud 只出现在 pip；基础环境标为只读，也没有删除入口。",
    async () => {
      const pipSources = manager.getByLabel("Global pip source");
      const condaSources = manager.getByLabel("Global conda source");
      await expect(pipSources.getByRole("option", { name: "Huawei Cloud" })).toHaveCount(1);
      await expect(condaSources.getByRole("option", { name: "Huawei Cloud" })).toHaveCount(0);

      const base = manager.locator(".environment-catalog article").filter({ hasText: /PYTHON · base/i });
      await expect(base).toBeVisible();
      await expect(base).toContainText("Read-only");
      await expect(base.getByRole("button", { name: "Delete" })).toHaveCount(0);
    },
  );

  await journey.step(
    "在界面上创建一个自己的命名 Python 环境",
    "填名字、选 Python、点创建之后，这个环境作为「named」出现在环境目录里。",
    async () => {
      await manager.getByLabel("Environment language").selectOption("python");
      await manager.getByLabel("Environment name").fill(environmentName);
      const createResponsePromise = page.waitForResponse((response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === "/api/environments", {
        timeout: 120_000,
      });
      await manager.getByRole("button", { name: "Create", exact: true }).click();
      await createResponsePromise;

      const environmentCard = manager.locator(".environment-catalog article").filter({ hasText: environmentName });
      await expect(environmentCard).toBeVisible({ timeout: 60_000 });
      await expect(environmentCard).toContainText("PYTHON · named");
    },
  );

  await journey.step(
    "确认这个环境提供了装包入口（本轮不点它）",
    "命名环境上有包管理器选择、包名输入和「Install packages」按钮；本旅程只确认入口存在，不触发联网安装。",
    async () => {
      const environmentCard = manager.locator(".environment-catalog article").filter({ hasText: environmentName });
      await expect(environmentCard.getByLabel(`Package manager for ${environmentName}`)).toBeVisible();
      await expect(environmentCard.getByLabel(`Packages for ${environmentName}`)).toBeVisible();
      await expect(environmentCard.getByRole("button", { name: "Install packages" })).toBeVisible();

      revision = (await currentEnvironmentRevision(page, environmentName)).revision;
      await page.getByRole("dialog", { name: "System configuration" })
        .getByRole("button", { name: "Cancel and close" })
        .first()
        .click();
    },
  );

  const marker = `J3-ENV-${Date.now()}`;
  const stub = await scriptedModel([
    {
      arguments: {
        code: `print('${marker}')`,
        environmentRevisionId: revision.id,
        kernelMode: "ephemeral",
      },
      delayMs: 500,
      tool: "run_python",
    },
    { text: `The calculation completed in ${environmentName}; output marker ${marker}.` },
  ]);
  let fixture: JourneyFixture | undefined;

  try {
    await journey.step(
      "回到会话，让 Agent 在这个环境里做一次计算",
      "用自然语言说出环境名后运行完成，展开代码执行步骤能看到本轮的输出标记。",
      async () => {
        fixture = await createProjectAndSession(page, {
          approvalMode: "always_allow",
          model: {
            apiToken: stub.apiToken,
            baseUrl: stub.baseUrl,
            model: stub.model,
            name: `J3 local model ${Date.now()}`,
          },
          projectName: `J3 prepare environment ${Date.now()}`,
          sessionTitle: `J3 environment session ${Date.now()}`,
        });
        await openProjectSession(page, fixture);
        const run = await sendUserMessage(
          page,
          fixture.session.id,
          `Use the named environment ${environmentName} to run a small Python calculation and report its output.`,
        );
        expect((await waitForRunTerminal(page, fixture.session.id, run.id)).status).toBe("completed");
        await expect(await expandToolStep(page, { contains: marker })).toContainText(marker);
      },
    );

    await journey.step(
      "事后核对这次计算用的就是我建的环境",
      "溯源记录里显示的环境名正是刚创建的那个命名环境，并带上它当时的不可变修订。",
      async () => {
        const provenance = page.locator("details[aria-label='Provenance record']");
        if (await provenance.getAttribute("open") === null) await provenance.locator(":scope > summary").click();
        await expect(provenance).toContainText(environmentName);
        await expect(provenance).toContainText(revision.id.slice(0, 12));
      },
    );

    await journey.step(
      "用完之后把这个命名环境删掉",
      "回到环境设置页确认删除后，它从环境目录里消失；共享的基础环境全程没有被改动。",
      async () => {
        const reopenedManager = await openEnvironmentPage(page);
        const reopenedCard = reopenedManager.locator(".environment-catalog article")
          .filter({ hasText: environmentName });
        await expect(reopenedCard).toBeVisible();
        page.once("dialog", (dialog) => dialog.accept());
        const deleteResponsePromise = page.waitForResponse((response) =>
          response.request().method() === "DELETE"
          && new URL(response.url()).pathname
            .includes(`/api/environments/${encodeURIComponent(revision.environmentId)}`), {
          timeout: 120_000,
        });
        await reopenedCard.getByRole("button", { name: "Delete" }).click();
        await deleteResponsePromise;
        await expect(reopenedManager.locator(".environment-catalog article").filter({ hasText: environmentName }))
          .toHaveCount(0);
      },
    );
  } finally {
    if (fixture) await cleanupJourney(page, fixture);
    await stub.stop();
  }
});
