// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "os:windows", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { creditTotals, rewardProgress } from "../src/views/AccountPage.js";

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

test("the credit summary adds up: available + spent = earned, to the milli-credit", () => {
  // The 0.4.0 report's account: a fractional balance and a longer spent history.
  const totals = creditTotals(598_891, 1_000_999);
  assert.equal(totals.available, 598.891);
  assert.equal(totals.earned, 1_000.999);
  assert.equal(totals.spent, 402.108);
  assert.equal(
    Math.round((totals.available + totals.spent) * 1000) / 1000,
    totals.earned,
  );

  // An in-flight hold subtracts from the balance without a ledger row; the
  // summary still adds up because the spend is derived from the same pair.
  const held = creditTotals(590_000, 1_000_000);
  assert.equal(held.available + held.spent, held.earned);

  // No grant, no spend: the initial account.
  assert.deepEqual(creditTotals(0, 0), { available: 0, earned: 0, spent: 0 });
});
