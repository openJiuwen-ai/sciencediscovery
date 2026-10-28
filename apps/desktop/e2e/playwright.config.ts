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
 * A standalone browser entry for `apps/desktop`.
 *
 * The repository-wide `.e2e` config drives `apps/web` against a real backend.
 * It cannot be reused here: a desktop journey has to start with no token, no
 * project and no model, and those are exactly the states a shared stack
 * fixture has already left behind. This config serves the desktop Vite app on
 * its own port and answers `/api/**` from `fixtures.ts`, so each spec owns a
 * clean workspace and nothing needs the Python control plane.
 *
 * Run from the repository root:
 *
 *   PLAYWRIGHT_BROWSERS_PATH=.e2e/browsers \
 *     apps/desktop/e2e/node_modules/.bin/playwright test \
 *     --config apps/desktop/e2e/playwright.config.ts
 */
import { defineConfig, devices } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: here,
  testMatch: "*.spec.ts",
  // The mock is per page, so specs are independent; two at a time keeps the
  // Vite server from becoming the bottleneck without hiding races.
  fullyParallel: true,
  workers: 2,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  outputDir: resolve(here, "test-results"),
  use: {
    baseURL: "http://127.0.0.1:4175",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "./node_modules/.bin/vite --port 4175 --strictPort",
    cwd: resolve(here, ".."),
    url: "http://127.0.0.1:4175",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
