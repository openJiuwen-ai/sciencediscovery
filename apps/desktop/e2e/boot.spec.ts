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
 * The four states the app can be in before the shell exists, and the writes
 * that get it out of them. These are the only screens a first-time user can
 * reach, and each one is chosen by a different server answer — so the test is
 * the answer, not a prop.
 */
import { expect, test } from "@playwright/test";

import {
  DEFAULT_PROJECT,
  TOKEN,
  TOKEN_STORAGE_KEY,
  installMockApi,
  makeSession,
} from "./fixtures.js";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [TOKEN_STORAGE_KEY, TOKEN] as const,
  );
});

test.describe("entering the workspace", () => {
  test("with no credential asks for one, then opens the shell", async ({ page }) => {
    await page.addInitScript(
      ([key]) => localStorage.removeItem(key),
      [TOKEN_STORAGE_KEY] as const,
    );
    await installMockApi(page, { sessions: [makeSession()] });

    await page.goto("/");

    await expect(page.getByRole("heading", { name: "需要访问凭据" })).toBeVisible();
    const submit = page.getByRole("button", { name: "进入" });
    await expect(submit).toBeDisabled();

    await page.getByLabel("访问凭据").fill(TOKEN);
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect(page.locator(".app-shell")).toBeVisible();
    await expect(page.locator(".side-session-name", { hasText: "晶体结构分析" })).toBeVisible();
  });

  test("with a stored credential resumes the most recent session", async ({ page }) => {
    await installMockApi(page, {
      sessions: [
        makeSession({ id: "session-old", title: "旧会话", updatedAt: "2026-10-01T09:00:00.000Z" }),
        makeSession({ id: "session-new", title: "最近的会话", updatedAt: "2026-10-02T09:00:00.000Z" }),
      ],
    });

    await page.goto("/");

    await expect(page.locator(".app-shell")).toBeVisible();
    // The newest Session is the one the composer is already writing into.
    await expect(page.locator(".task-head-title")).toHaveText("最近的会话");
    await expect(page.locator(".side-session-name", { hasText: "最近的会话" })).toBeVisible();
    await expect(page.getByText("ScienceDiscovery", { exact: true })).toBeVisible();
  });

  test("with an empty workspace asks for the inbox and shows the welcome page", async ({
    page,
  }) => {
    const mock = await installMockApi(page, { projects: [], sessions: [] });

    await page.goto("/");

    await expect(page.locator(".app-shell")).toBeVisible();
    // A fresh install opens with no Projects at all: the first conversation
    // lands in the inbox instead, which the app asks for rather than invents
    // a Project the user never made.
    await expect
      .poll(() => mock.calls.filter((call) => call.method === "POST" && call.path === "/api/inbox"))
      .toHaveLength(1);
    expect(mock.calls.some((call) => call.method === "POST" && call.path === "/api/projects")).toBe(false);
    await expect(page.getByText("还没有项目", { exact: true })).toBeVisible();
    await expect(page.getByText("还没有最近会话", { exact: true })).toBeVisible();
    // No Session yet: the composer stands on the welcome page rather than an
    // empty transcript.
    await expect(page.getByRole("heading", { name: "ScienceDiscovery" })).toBeVisible();
  });
});

test.describe("when boot cannot finish", () => {
  test("an unreachable service shows the offline screen and retries", async ({ page }) => {
    await installMockApi(page, { healthStatus: 503 });

    await page.goto("/");

    await expect(page.getByRole("heading", { name: "连不上本地服务" })).toBeVisible();
    await expect(page.getByText("没有收到本地服务的响应", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "重试" })).toBeVisible();
    await expect(page.locator(".app-shell")).toHaveCount(0);
  });

  test("a refused credential forgets it and asks again", async ({ page }) => {
    await installMockApi(page, { modelsStatus: 401 });

    await page.goto("/");

    await expect(page.getByRole("heading", { name: "凭据未被接受" })).toBeVisible();
    // The rejected token must not be retried on the next reload.
    await expect
      .poll(() => page.evaluate((key) => localStorage.getItem(key), TOKEN_STORAGE_KEY))
      .toBeNull();
    await expect(page.locator(".app-shell")).toHaveCount(0);
  });

  test("a health probe ahead of the token gate does not need a credential", async ({ page }) => {
    const mock = await installMockApi(page, { sessions: [makeSession()] });

    await page.goto("/");

    await expect.poll(() => mock.calls.some((call) => call.path === "/api/health")).toBe(true);
    // The Project the fixture started with was adopted, not replaced.
    await expect(page.getByText(DEFAULT_PROJECT.name, { exact: true }).first()).toBeVisible();
  });
});
