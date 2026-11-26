// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const scenarios = ["empty-catalog", "sign-in-unconfigured", "last-model", "new-session", "new-project", "sidebar-collapsed"];

for (const language of ["zh-CN", "en"]) {
  for (const scenario of scenarios) {
    test(`App renders ${scenario} in ${language}`, async () => {
      // App imports CSS through unrelated artifact views. Keep the CSS loader,
      // classic-JSX React global, and browser globals out of the shared UT process.
      const { stdout } = await run(process.execPath, [
        "--import", "tsx", fileURLToPath(new URL("./support/app-model-setup-render.ts", import.meta.url)),
        language, scenario,
      ], {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        // Cold loading the App's TSX module graph can exceed 30 seconds on a WSL-mounted checkout.
        timeout: 90_000,
      });
      assert.equal(stdout.trim(), `Rendered ${scenario} in ${language}`);
    });
  }
}
