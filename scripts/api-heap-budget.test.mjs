// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
//
// Every path that starts the API process must pass an explicit old-space
// budget: V8's default is what the run in #1011 died of, and a budget that only
// some launch paths set is worse than none, because the process cannot then
// tell which limit it is running under. Each path carries the same default
// because they cannot share a runtime constant — bash, a workspace package and
// the packaged launcher have no common import — so this test is the thing that
// keeps them equal.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createTest } from "../test/support/tagged/compat.mjs";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "arch:amd64", "arch:arm64"] });

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const ENV_NAME = "SCIENCE_AGENT_API_MAX_OLD_SPACE_MB";
const read = (path) => readFile(join(repositoryRoot, path), "utf8");

// Paths that read the environment variable and carry the default themselves.
const envPaths = {
  "services/api/src/heap-budget.ts": "services/api/src/heap-budget.ts",
  "scripts/lib/stack-platform.mjs": "scripts/lib/stack-platform.mjs",
  "scripts/start-stack.sh": "scripts/start-stack.sh",
  "services/launcher/src/serve.ts": "services/launcher/src/serve.ts",
};

function defaultValue(text) {
  const match = text.match(/DEFAULT_API_(?:MAX_OLD_SPACE|HEAP_BUDGET)_MB\s*=\s*(\d+)/)
    ?? text.match(/SCIENCE_AGENT_API_MAX_OLD_SPACE_MB:-(\d+)/);
  return match ? Number(match[1]) : undefined;
}

test("every launch path takes the heap budget from the same variable and the same default", async () => {
  const entries = await Promise.all(Object.entries(envPaths).map(async ([name, path]) => ({ name, text: await read(path) })));
  for (const { name, text } of entries) {
    assert.ok(text.includes(ENV_NAME), `${name} must name ${ENV_NAME}`);
  }
  const defaults = entries.map(({ name, text }) => ({ name, value: defaultValue(text) }));
  for (const { name, value } of defaults) {
    assert.equal(typeof value, "number", `${name} must carry the default explicitly instead of inheriting it`);
  }
  assert.deepEqual(
    [...new Set(defaults.map(({ value }) => value))],
    [defaults[0].value],
    `launch paths disagree: ${defaults.map(({ name, value }) => `${name}=${value}`).join(", ")}`,
  );

  // The two package scripts cannot read a variable portably, so they carry the
  // number instead; it has to be the same number.
  const api = JSON.parse(await read("services/api/package.json"));
  for (const script of ["start", "dev"]) {
    const flag = api.scripts[script].match(/--max-old-space-size=(\d+)/);
    assert.ok(flag, `the "${script}" package script must pass the budget`);
    assert.equal(Number(flag[1]), defaults[0].value, `the "${script}" script carries ${flag[1]}, the default is ${defaults[0].value}`);
  }
});

test("no start path launches the API without the flag", async () => {
  const stackScript = await read("scripts/start-stack.mjs");
  assert.match(stackScript, /--max-old-space-size=\$\{apiHeapBudgetMb\(\)\}/, "start-stack.mjs must pass the computed budget");

  const shellLines = (await read("scripts/start-stack.sh")).match(/api_command=\(node --max-old-space-size="?\$\{?api_heap_budget_mb\}?"?/g) ?? [];
  assert.equal(shellLines.length, 3, "each of the three shell launch modes must pass the budget");

  assert.match(
    await read("services/launcher/src/serve.ts"),
    /--max-old-space-size=\$\{apiHeapBudgetMb\(baseEnv\)\}/,
    "the packaged launcher must pass the budget",
  );
});
