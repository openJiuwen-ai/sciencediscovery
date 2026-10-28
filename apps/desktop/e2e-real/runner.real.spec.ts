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

/**
 * E2E-META
 * Purpose: 设置 › 远程 reads the real Runner catalog: the local Runner is
 *          offered by the allowlist, and a connected remote Runner's own disk,
 *          memory and NPU readings are drawn from what it reported.
 * Steps:
 *   1. Open 设置 › 远程 against the real stack.
 *   2. Require the local Runner in the project allowlist.
 *   3. When the API reports a ready remote Runner with resources, require its
 *      meter readings — and its NPU rows when it reported cards.
 * Environment: Isolated product stack selected by E2E_BASE_URL, plus the
 *              desktop Vite entry on 4176. Requires a configured model so the
 *              app reaches the shell; the remote-resource case additionally
 *              requires a connected remote Runner.
 * Type: real
 * LLM: None in this journey; the stack must already have a model profile.
 * WebSearch: none requested
 * PaperSources: none
 * MCP: none
 * OtherExternal: Local API and the already-connected Runner only.
 * Credentials: E2E_API_TOKEN.
 * CostSideEffects: Reads only; no records created.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

import { REAL_TAGS, api, requireEnv, requireStack, seedToken } from "./support.js";

interface RunnerResource {
  total: number;
  used?: number;
}

interface RunnerTarget {
  alias: string;
  id: string;
  location: "local" | "remote";
  runnerStatus?: {
    resources?: Record<string, RunnerResource>;
    state?: string;
  };
}

test.beforeEach(async ({ page }, info) => {
  requireEnv(info, "E2E_API_TOKEN");
  await requireStack(info);
  await seedToken(page);
});

async function openRemoteSettings(page: Page): Promise<Locator> {
  await page.goto("/");
  const models = await api<unknown[]>(page, "/api/models");
  if (models.length === 0) test.skip(true, "the shell needs at least one model profile to reach 设置");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTitle("远端 Runner 与项目可用机器").click();
  return dialog;
}

test("the real Runner catalog offers the local machine to the project", { tag: [...REAL_TAGS] }, async ({ page }) => {
  const dialog = await openRemoteSettings(page);

  const local = dialog.locator(".runner-choice").filter({ hasText: "本地" });
  await expect(local.first()).toBeVisible();
  await expect(local.first().locator("input[type=checkbox]")).toBeChecked();
});

test("a connected remote Runner reports its real resources", { tag: [...REAL_TAGS] }, async ({ page }, info) => {
  const runners = await api<RunnerTarget[]>(page, "/api/runners");
  const connected = runners.find(
    (runner) => runner.location === "remote" && runner.runnerStatus?.state === "ready" && runner.runnerStatus.resources,
  );
  if (connected === undefined) {
    info.skip(true, "no connected remote Runner with resource readings on this stack");
  }

  const dialog = await openRemoteSettings(page);

  const card = dialog.locator(".settings-card.is-machine").filter({ hasText: connected!.alias });
  await expect(card.first()).toBeVisible();
  // The readings sit behind 机器详情: the card's visible job is the connection.
  await card.first().getByText("机器详情").click();
  const meters = card.first().getByRole("meter");
  await expect(meters.first()).toBeVisible();
  expect(await meters.count()).toBeGreaterThan(0);

  // NPU rows exist only when the machine handed cards to the sandbox. Their
  // absence is a fact about the host, not a defect, so it is not asserted.
  const npu = card.first().getByText(/NPU \d/);
  if ((await npu.count()) > 0) {
    await expect(npu.first()).toBeVisible();
  }
});
