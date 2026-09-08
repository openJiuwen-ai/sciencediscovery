// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { test } from "node:test";
import { EnvironmentAccess } from "./environment-access.js";

const deferred = () => Promise.withResolvers<void>();

test("environment update waits for readers and blocks later readers, without blocking other environments", async () => {
  const access = new EnvironmentAccess();
  const first = deferred();
  const second = deferred();
  const entered = deferred();
  const order: string[] = [];
  const a = access.run("env", false, async () => { order.push("read-a"); await first.promise; });
  const b = access.run("env", false, async () => { order.push("read-b"); await second.promise; });
  const write = access.run("env", true, async () => { order.push("write"); });
  const late = access.run("env", false, async () => { order.push("read-c"); });
  await access.run("other", true, async () => { entered.resolve(); });
  await entered.promise;
  assert.deepEqual(order, ["read-a", "read-b"]);
  first.resolve(); await a;
  assert.deepEqual(order, ["read-a", "read-b"]);
  second.resolve();
  await Promise.all([b, write, late]);
  assert.deepEqual(order, ["read-a", "read-b", "write", "read-c"]);
});

test("failed readers and updates release their leases", async () => {
  const access = new EnvironmentAccess();
  for (const write of [false, true]) {
    await assert.rejects(access.run("env", write, async () => { throw new Error("failed"); }), /failed/);
    assert.equal(await access.run("env", !write, async () => "ok"), "ok");
  }
});
