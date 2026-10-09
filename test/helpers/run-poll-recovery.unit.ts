// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createTest } from "../support/tagged/compat.mjs";
import { RunPollRecovery } from "./run-poll-recovery.ts";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

test("run polling tolerates three transient errors, resets after success, and then fails closed", () => {
  const budget = new RunPollRecovery();
  const error = new Error("GET /runs -> 502: ReadError");
  assert.equal(budget.failed(error), 1);
  budget.succeeded();
  assert.equal(budget.failed(error), 1);
  assert.equal(budget.failed(new Error("ECONNRESET")), 2);
  assert.equal(budget.failed(new Error("GET /runs -> 504: timeout")), 3);
  assert.throws(() => budget.failed(error), /ReadError/);
});

test("run polling does not hide auth, missing runs, or programming errors", () => {
  for (const text of ["GET /runs -> 401: denied", "GET /runs -> 404: missing", "Unexpected token"])
    assert.throws(() => new RunPollRecovery().failed(new Error(text)));
});
