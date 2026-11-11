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
import { execFileSync } from "node:child_process";
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

/**
 * The block itself has to keep working, not merely parse: a `case` whose
 * subject was empty, or a message with the value dropped out of it, passes
 * `bash -n` and any regex over the file, and then refuses every launch (#1105
 * review). So run the committed lines and check what they do.
 */
test("the shell budget block continues on a valid value and refuses a bad one", async () => {
  const shell = await read("scripts/start-stack.sh");
  const start = shell.indexOf('api_heap_budget_mb="${SCIENCE_AGENT_API_MAX_OLD_SPACE_MB');
  assert.ok(start > 0, "the budget block must exist in start-stack.sh");
  const rangeCheck = shell.indexOf("if (( api_heap_budget_mb < ", start);
  assert.ok(rangeCheck > start, "the range check must follow the variable");
  const end = shell.indexOf("\nfi\n", rangeCheck);
  assert.ok(end > rangeCheck, "the range check must be closed");
  const block = shell.slice(start, end + 4);

  const run = (value) => execFileSync("bash", ["-c", `${block}\necho CONTINUED`], {
    encoding: "utf8",
    env: { ...process.env, SCIENCE_AGENT_API_MAX_OLD_SPACE_MB: value },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const fails = (value) => {
    try {
      run(value);
      return false;
    } catch (error) {
      return error.status === 2;
    }
  };

  assert.match(run("3072"), /CONTINUED/, "the default value must not stop the launch");
  assert.match(run("4096"), /CONTINUED/, "a valid override must not stop the launch");
  assert.equal(fails("abc"), true, "a non-numeric override must exit 2");
  // An empty override is not a refusal: `${VAR:-default}` treats it as unset, so it\n  // must fall through to the default. What must never pass is a case subject that\n  // is not the variable at all, which the mutation below covers.\n  assert.match(run(""), /CONTINUED budget=3072/, "an empty override must fall back to the default");
  assert.equal(fails("1"), true, "an out-of-range override must exit 2");
  assert.throws(() => run("abc"), /got 'abc'/, "the message must name the value it refused");
});

