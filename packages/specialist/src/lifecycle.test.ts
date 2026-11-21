// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { classifySubagentFailure, subagentCapableParentRunTimeoutMs } from "./lifecycle.js";

const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});

test("specialist lifecycle leaves margin after the maximum child timeout", () => {
  assert.equal(subagentCapableParentRunTimeoutMs(120), 180_000);
});

test("specialist lifecycle distinguishes timeout, cancellation and ordinary failure", () => {
  assert.deepEqual(classifySubagentFailure(new Error("gateway timeout"), { maxTurns: 4, maxTurnsExceeded: false, parentAborted: false }), {
    error: "gateway timeout", status: "timed_out",
  });
  assert.deepEqual(classifySubagentFailure(new Error("cancelled by user"), { maxTurns: 4, maxTurnsExceeded: false, parentAborted: false }), {
    error: "cancelled by user", status: "cancelled",
  });
  assert.deepEqual(classifySubagentFailure(new Error("bad tool"), { maxTurns: 4, maxTurnsExceeded: true, parentAborted: false }), {
    error: "Subagent exceeded maxTurns=4", status: "timed_out",
  });
  assert.deepEqual(classifySubagentFailure("broken", { maxTurns: 4, maxTurnsExceeded: false, parentAborted: false }), {
    error: "Subagent failed", status: "failed",
  });
});
