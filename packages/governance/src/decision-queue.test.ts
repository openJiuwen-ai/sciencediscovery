// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import test from "node:test";
import { PermissionDecisionQueue } from "./decision-queue.js";

test("decisions serialize within a Session and remain independent across Sessions", async () => {
  const queue = new PermissionDecisionQueue();
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = queue.run("s1", async () => { order.push("first:start"); await gate; order.push("first:end"); });
  const second = queue.run("s1", async () => { order.push("second"); });
  await queue.run("s2", async () => { order.push("other"); });
  assert.deepEqual(order, ["first:start", "other"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "other", "first:end", "second"]);
});
