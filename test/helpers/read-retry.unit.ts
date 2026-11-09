// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createTest } from "../support/tagged/compat.mjs";
import { retryRead } from "./read-retry.ts";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

test("read recovers from a socket reset with a shrinking timeout budget", async () => {
  const timeouts: number[] = [];
  const result = await retryRead("GET /runs", async timeout => {
    timeouts.push(timeout);
    if (timeouts.length === 1) throw new Error("apiRequestContext.fetch: socket hang up");
    return ["run"];
  });
  assert.deepEqual(result, ["run"]);
  assert.equal(timeouts.length, 2);
  assert.ok(timeouts[1]! < timeouts[0]!);
});

test("persistent connection errors stop after three attempts and preserve the error", async () => {
  let calls = 0;
  const error = new Error("ECONNRESET");
  await assert.rejects(retryRead("GET /runs", async () => { calls++; throw error; }), e => e === error);
  assert.equal(calls, 3);
});

test("HTTP and programming errors are never retried", async () => {
  for (const message of ["GET /runs -> 401: denied", "GET /runs -> 503: unavailable", "GET /runs -> 502: ECONNRESET", "Unexpected token"]) {
    let calls = 0;
    await assert.rejects(retryRead("GET /runs", async () => { calls++; throw new Error(message); }));
    assert.equal(calls, 1);
  }
});

test("expired read budget prevents another attempt", async () => {
  let calls = 0;
  await assert.rejects(retryRead("GET /runs", async () => { calls++; throw new Error("socket hang up"); }, 1));
  assert.equal(calls, 1);
});
