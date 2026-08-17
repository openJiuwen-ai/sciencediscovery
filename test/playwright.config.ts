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

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

import { apiBaseUrl, browserStorageState } from "../test/e2e-auth.js";

/** Local e2e environment root (this directory). Specs live in ../test. */
const envRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(envRoot, "..");
const sourceConfig = resolve(repoRoot, "test/playwright.config.ts");
const loadedConfig = fileURLToPath(import.meta.url);

// A copied config must exactly match the committed source. This second layer
// also blocks direct Playwright invocations that bypass package scripts.
if (envRoot !== resolve(repoRoot, "test") && !readFileSync(sourceConfig).equals(readFileSync(loadedConfig))) {
  throw new Error("BLOCKED: stale .e2e/playwright.config.ts; run node test/sync-e2e.mjs --write");
}

// Imported by the automatic network fixture. An older config that lacks this
// marker fails during spec collection before any mocked test can run.
process.env.SCIENCE_AGENT_E2E_CONFIG_CONTRACT = "mocked-egress-v2";

// Same resolution the API fixtures and the storage-state origin use, so the
// browser and the REST calls can never address different services.
const baseURL = apiBaseUrl();

export default defineConfig({
  // Fails the run immediately when E2E_API_TOKEN is missing, instead of letting
  // every scenario rediscover it as a 401. Skipped for `--list`.
  globalSetup: resolve(repoRoot, "test/global-setup.ts"),
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
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    viewport: { width: 1440, height: 900 },
    launchOptions: {
      slowMo: 50,
    },
  },
  projects: [
    // Only explicitly tagged, fully stubbed specs run by default. Untagged
    // legacy specs stay quarantined because their external behavior has not
    // yet been audited against the E2E-META contract.
    {
      name: "mocked",
      grep: /@mocked/,
      use: { ...devices["Desktop Chrome"], serviceWorkers: "block" },
    },
    // Specs tagged @real call live LLMs / external services and may cost
    // money. The project only exists when E2E_REAL=1, so the default command
    // cannot reach them; without the variable, --project=real fails with
    // "Project(s) 'real' not found" — that run is BLOCKED, not passed.
    ...(process.env.E2E_REAL === "1"
      ? [
          {
            name: "real",
            grep: /@real/,
            use: { ...devices["Desktop Chrome"] },
          },
        ]
      : []),
    // Compatibility-only quarantine. This group may contain unaudited live
    // behavior and is never present unless the caller explicitly opts in.
    ...(process.env.E2E_LEGACY === "1"
      ? [
          {
            name: "legacy",
            grepInvert: /@(mocked|real)/,
            use: { ...devices["Desktop Chrome"] },
          },
        ]
      : []),
  ],
  expect: {
    timeout: 10000,
  },
  timeout: 240000,
});
