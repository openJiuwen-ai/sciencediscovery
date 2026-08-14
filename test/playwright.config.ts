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

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

import { apiBaseUrl, browserStorageState } from "./e2e-auth.js";

/** Local e2e environment root (this directory). Specs live in ../test. */
const envRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(envRoot, "..");

// Same resolution the API fixtures and the storage-state origin use, so the
// browser and the REST calls can never address different services.
const baseURL = apiBaseUrl();

export default defineConfig({
  // Fails the run immediately when E2E_API_TOKEN is missing, instead of letting
  // every scenario rediscover it as a 401. Skipped for `--list`.
  globalSetup: resolve(envRoot, "global-setup.ts"),
  testDir: resolve(repoRoot, "test"),
  outputDir: resolve(envRoot, "test-results"),
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: resolve(envRoot, "playwright-report") }],
    ["json", { outputFile: resolve(envRoot, "test-results/results.json") }],
  ],
  use: {
    baseURL,
    // The product ships no default credential, so the browser starts with the
    // token this installation printed — the state a user reaches by pasting it
    // into Connection settings. Specs that exercise the rejected-token path
    // clear the key in an init script.
    storageState: browserStorageState(),
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
    viewport: { width: 1440, height: 900 },
    launchOptions: {
      slowMo: 50,
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  expect: {
    timeout: 10000,
  },
  timeout: 240000,
});
