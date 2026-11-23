// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { rewardProgress } from "../src/views/AccountPage.js";

test("a sign-in already in the ledger highlights the day it paid for", () => {
  // The report's account: four accumulated check-ins, today's among them.
  const progress = rewardProgress(4, true);
  assert.equal(progress.doneDays, 4);
  assert.equal(progress.todaySlot, 3);
  assert.equal(progress.remaining, 3);
  // The hint and the highlighted slot have to agree on the same week.
  assert.equal(progress.todaySlot + 1 + progress.remaining, 7);
});

test("before today's sign-in the next claimable day is the one to mark", () => {
  const progress = rewardProgress(4, false);
  assert.equal(progress.doneDays, 4);
  assert.equal(progress.todaySlot, 4);
  assert.equal(progress.remaining, 3);
});

test("a completed seventh day highlights the last slot, and the next cycle starts at one", () => {
  const paid = rewardProgress(7, true);
  assert.equal(paid.doneDays, 7);
  assert.equal(paid.todaySlot, 6);
  assert.equal(paid.remaining, 7);

  const fresh = rewardProgress(0, false);
  assert.equal(fresh.doneDays, 0);
  assert.equal(fresh.todaySlot, 0);
  assert.equal(fresh.remaining, 7);
});
