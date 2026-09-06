// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import test from "node:test";
import { buildIdentity } from "./build-version.mjs";

const commit = "12345678".repeat(5);
test("clean and dirty builds carry their source commit, not a milestone marker", () => {
  for (const dirty of [false, true]) {
    const calls = [];
    const result = buildIdentity({ revision: undefined, git: args => {
      calls.push(args);
      return args[0] === "rev-parse" ? commit : dirty ? " M services/runner/src/executor.ts" : "";
    } });
    assert.deepEqual(result, { version: `12345678${dirty ? "-dirty" : ""}`, commit });
    assert.deepEqual(calls[1], ["status", "--porcelain", "--untracked-files=no"]);
  }
});
test("archive builds accept an explicit full revision without Git", () => {
  assert.deepEqual(buildIdentity({ revision: commit, git: () => { throw new Error("no git"); } }),
    { version: "12345678", commit });
  assert.throws(() => buildIdentity({ revision: "milestone-v1" }), /full Git commit/);
});
test("missing Git metadata is honestly unknown", () => {
  assert.deepEqual(buildIdentity({ revision: undefined, git: () => { throw new Error("no git"); } }),
    { version: "unknown", commit: null });
});
