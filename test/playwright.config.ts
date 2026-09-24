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
import { validatePlan } from "../test/support/tagged/plan.mjs";
import { planGrep as plannedGrep } from "../test/support/tagged/playwright-selection.mjs";
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
const planned = process.env.SCIENCE_TAG_PLAN && !process.env.SCIENCE_TAG_PW_CATALOG
  ? validatePlan(JSON.parse(readFileSync(process.env.SCIENCE_TAG_PLAN, "utf8"))).entries.filter(e => e.runner === "playwright") : undefined;
// Playwright grep uses space-joined project/describe/test titles. Decode the
// same frozen identity the reporter produces, rather than maintaining a list.
const planGrep = planned && plannedGrep(planned);

export default defineConfig({
  // Fails the run immediately when E2E_API_TOKEN is missing, instead of letting
  // every scenario rediscover it as a 401. Skipped for `--list`.
  globalSetup: resolve(repoRoot, "test/global-setup.ts"),
  testDir: resolve(repoRoot, "test"),
  // Only real research is a manual/benchmark opt-in. The mocked Swarm journey
  // remains in the default mocked PR gate. Real LLMs also require E2E_REAL.
  // Discovery is static. Credentials and opt-in flags are execution preflight,
  // not a way of removing real tasks from the daily catalog.
  testIgnore: [],
  ...(planGrep ? { grep: planGrep } : {}),
  outputDir: resolve(envRoot, "test-results"),
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [
    ...(process.env.SCIENCE_TAG_PW_REPORT ? [[resolve(repoRoot, "test/support/tagged/playwright-reporter.mjs")] as [string]] : []),
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
      grep: planGrep ?? /@mocked/,
      // A run driving a frozen plan executes that plan and nothing else. The
      // shared selector takes only `status:reviewed`, so a quarantined journey
      // is deselected here rather than running and reporting a skip — which
      // Playwright exits 0 on and the plan would have to count as a journey
      // that did not execute. Collection (SCIENCE_TAG_PW_CATALOG) keeps seeing
      // it, so the migration ledger still knows it exists.
      ...(process.env.SCIENCE_TAG_PW_REPORT
        ? { grepInvert: /@status:(external|legacy|unreviewed)\b/ }
        : {}),
      use: { ...devices["Desktop Chrome"], serviceWorkers: "block" },
    },
    { name: "real", grep: planGrep ?? /@real/, use: { ...devices["Desktop Chrome"] } },
    { name: "legacy", grepInvert: /@(mocked|real)/, use: { ...devices["Desktop Chrome"] } },
  ],
  expect: {
    timeout: 10000,
  },
  timeout: 240000,
});
