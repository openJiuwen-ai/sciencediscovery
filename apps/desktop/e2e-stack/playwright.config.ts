// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import desktop from "../e2e-real/playwright.config.ts";

const here = dirname(fileURLToPath(import.meta.url));

export default {
  ...desktop,
  testDir: here,
  testMatch: "*.spec.ts",
  timeout: 180_000,
  outputDir: resolve(here, "../../../.e2e/desktop-stack-results"),
  reporter: [
    ["list"],
    ["json", { outputFile: resolve(here, "../../../.e2e/desktop-stack-results/results.json") }],
  ],
  use: { ...desktop.use, serviceWorkers: "block" },
  projects: desktop.projects?.map((project) => ({ ...project, name: "desktop-stack-chromium" })),
};
