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
 * The `tier:l3` desktop entry: no request mocking, a real API and a real model.
 *
 * It is separate from `../e2e` because the two entries answer different
 * questions. `../e2e` proves the UI contract against an in-browser control
 * plane and runs on every PR (L2). This one proves the same UI against the
 * service and model it actually talks to, costs money, and therefore runs at
 * the merge gate (L3). Sharing one config would either make the mock suite
 * need credentials or let a mocked test be counted as real.
 *
 * The Vite server points at `E2E_BASE_URL` (the stack's origin), not the
 * product's own 4310 default, so a run cannot create records in an instance a
 * person left running for themselves.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");

/** The one origin both the browser proxy and the REST fixtures address. */
const apiOrigin = (process.env.E2E_BASE_URL ?? process.env.E2E_API_URL ?? "http://127.0.0.1:4410")
  .replace(/\/+$/, "");

// `test/e2e-auth.ts` reads the same variable, so the fixtures and the proxy
// cannot end up on different stacks.
process.env.E2E_BASE_URL = apiOrigin;

const desktopOrigin = "http://127.0.0.1:4176";

export default defineConfig({
  testDir: here,
  testMatch: "**/*.real.spec.ts",
  // Real runs are serial: one model call at a time keeps a failure attributable
  // and keeps the temporary Project/Session cleanup predictable.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  outputDir: resolve(here, "test-results"),
  use: {
    baseURL: desktopOrigin,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: "./node_modules/.bin/vite --port 4176 --strictPort",
    cwd: desktopRoot,
    env: { SCIENCE_AGENT_API_URL: apiOrigin },
    url: desktopOrigin,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    { name: "desktop-real-chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
