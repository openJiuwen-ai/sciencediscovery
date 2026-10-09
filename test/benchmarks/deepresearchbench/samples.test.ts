// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createTest } from "../../support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import { drbSamples, selectedDrbSamples } from "./samples.ts";

test("preserves the original five sampled IDs and workload labels", () => {
  assert.deepEqual(drbSamples.map(c => c.id), [59, 64, 58, 62, 75]);
  assert.deepEqual(drbSamples.map(c => c.difficulty), ["easy", "medium", "medium-hard", "hard", "very-hard"]);
  assert.ok(drbSamples.every(c => c.question.length > 100));
});

test("selects only requested cases in the requested order", () => {
  assert.deepEqual(selectedDrbSamples("75, 59").map(c => c.id), [75, 59]);
});

test("rejects empty, unknown, malformed and duplicate selections", () => {
  for (const value of ["", " ", "999", "59,59", "59,", "nope", "59.5"]) {
    assert.throws(() => selectedDrbSamples(value), /E2E_DRB_CASE_IDS/);
  }
});
