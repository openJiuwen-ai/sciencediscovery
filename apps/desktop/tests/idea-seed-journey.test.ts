// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

test("a created Idea Tree command stays in the session that typed it", async () => {
  // App imports CSS through unrelated artifact views, so this runs in its own
  // process for the same reason app-model-setup-render does.
  const { stdout } = await run(process.execPath, [
    "--import", "tsx", fileURLToPath(new URL("./support/idea-seed-journey-render.ts", import.meta.url)),
  ], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    // Cold loading the App's TSX module graph can exceed 30 seconds on a WSL-mounted checkout.
    timeout: 120_000,
  });
  assert.equal(stdout.trim(), "Journey: the confirming session kept the token, the opened session stayed empty");
});
