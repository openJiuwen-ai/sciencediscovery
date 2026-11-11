// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import {
  API_MAX_OLD_SPACE_ENV,
  DEFAULT_API_MAX_OLD_SPACE_MB,
  MAX_API_MAX_OLD_SPACE_MB,
  MIN_API_MAX_OLD_SPACE_MB,
  apiMaxOldSpaceMb,
  explicitOldSpaceMb,
  heapBudget,
  heapBudgetWarning,
} from "./heap-budget.js";

test("an unset override leaves the default to the launcher", () => {
  assert.equal(apiMaxOldSpaceMb({}), undefined);
  assert.equal(apiMaxOldSpaceMb({ [API_MAX_OLD_SPACE_ENV]: "   " }), undefined);
  assert.equal(apiMaxOldSpaceMb({ [API_MAX_OLD_SPACE_ENV]: "4096" }), 4096);
});

test("an override outside the accepted range is refused rather than silently clamped", () => {
  for (const raw of ["0", "1.5", "abc", String(MIN_API_MAX_OLD_SPACE_MB - 1), String(MAX_API_MAX_OLD_SPACE_MB + 1)]) {
    assert.throws(() => apiMaxOldSpaceMb({ [API_MAX_OLD_SPACE_ENV]: raw }), /SCIENCE_AGENT_API_MAX_OLD_SPACE_MB/, raw);
  }
});

test("the flag a process really received is read from its arguments, then NODE_OPTIONS", () => {
  assert.equal(explicitOldSpaceMb([], ""), undefined);
  assert.equal(explicitOldSpaceMb(["--max-old-space-size=3072"], ""), 3072);
  assert.equal(explicitOldSpaceMb(["--enable-source-maps"], "--max-old-space-size=2048 --enable-source-maps"), 2048);
  // The command line wins over the environment, which is also what Node itself does.
  assert.equal(explicitOldSpaceMb(["--max-old-space-size=4096"], "--max-old-space-size=2048"), 4096);
  assert.equal(explicitOldSpaceMb(["--max-old-space-size=not-a-number"], ""), undefined);
});

test("the reported budget is the flag if there is one, otherwise the override, otherwise the default", () => {
  const limit = 3264 * 1024 * 1024;
  const implicit = heapBudget({ env: {}, execArgv: [], heapLimitBytes: limit });
  assert.equal(implicit.budgetMb, DEFAULT_API_MAX_OLD_SPACE_MB);
  assert.equal(implicit.explicitMb, undefined);
  assert.equal(implicit.effectiveLimitMb, 3264);

  const fromEnvOnly = heapBudget({ env: { [API_MAX_OLD_SPACE_ENV]: "4096" }, execArgv: [], heapLimitBytes: limit });
  assert.equal(fromEnvOnly.budgetMb, 4096);
  assert.equal(fromEnvOnly.explicitMb, undefined);

  const applied = heapBudget({ env: {}, execArgv: ["--max-old-space-size=3072"], heapLimitBytes: limit });
  assert.equal(applied.budgetMb, 3072);
  assert.equal(applied.explicitMb, 3072);
});

test("a budget the launcher did not apply, or two that disagree, is reported instead of assumed", () => {
  const limit = 4288 * 1024 * 1024;
  const implicit = heapBudget({ env: {}, execArgv: [], heapLimitBytes: limit });
  assert.match(String(heapBudgetWarning(implicit)), /No --max-old-space-size reached this process/);

  const envIgnored = heapBudget({ env: { [API_MAX_OLD_SPACE_ENV]: "4096" }, execArgv: ["--max-old-space-size=3072"], heapLimitBytes: limit });
  assert.match(String(heapBudgetWarning(envIgnored)), /was ignored/);

  const consistent = heapBudget({ env: { [API_MAX_OLD_SPACE_ENV]: "3072" }, execArgv: ["--max-old-space-size=3072"], heapLimitBytes: limit });
  assert.equal(heapBudgetWarning(consistent), undefined);
});
