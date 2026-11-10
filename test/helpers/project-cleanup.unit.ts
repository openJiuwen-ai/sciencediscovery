// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createTest } from "../support/tagged/compat.mjs";
import { deleteOwnedProject } from "./project-cleanup.ts";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
const failure = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

test("a successful or already absent owned project needs no confirmation or replay", async () => {
  for (const error of [undefined, failure(404)]) {
    let writes = 0;
    await deleteOwnedProject({ remove: async () => { writes++; if (error) throw error; },
      exists: async () => { assert.fail("unexpected read"); } });
    assert.equal(writes, 1);
  }
});

test("lost deletion acknowledgement is confirmed absent without another DELETE", async () => {
  const calls: string[] = [];
  await deleteOwnedProject({ remove: async () => { calls.push("DELETE"); throw failure(502); },
    exists: async () => { calls.push("GET"); return false; } });
  assert.deepEqual(calls, ["DELETE", "GET"]);
});

test("a confirmed surviving fixture grants only one additional DELETE", async () => {
  for (const outcome of [undefined, failure(404), failure(502)]) {
    const calls: string[] = [];
    const operation = deleteOwnedProject({ remove: async () => {
      calls.push("DELETE"); if (calls.length === 1) throw failure(502); if (outcome) throw outcome;
    }, exists: async () => { calls.push("GET"); return true; } });
    if (outcome?.status === 502) await assert.rejects(operation, /HTTP 502/);
    else await operation;
    assert.deepEqual(calls, ["DELETE", "GET", "DELETE"]);
  }
});

test("inconclusive reads, authorization, conflicts and transport errors never replay deletion", async () => {
  for (const first of [failure(502), failure(401), failure(409), new Error("connection reset")]) {
    let writes = 0;
    await assert.rejects(deleteOwnedProject({ remove: async () => { writes++; throw first; },
      exists: async () => { throw failure(503); } }));
    assert.equal(writes, 1);
  }
});
