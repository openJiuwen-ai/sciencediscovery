// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import test from "node:test";
import { schedulerPlugin } from "./plugin.js";
test("default scheduling contribution preserves the task tool and policy", () => {
  const runSubagent = async () => { throw new Error("not invoked"); };
  assert.equal(schedulerPlugin({ runSubagent }).create().contribution.tools[0]?.name, "task");
  assert.equal(schedulerPlugin({ runSubagent, toolPolicy: { disallowed: ["task"] } }).create().contribution.tools.length, 0);
  assert.equal(schedulerPlugin({}).create().contribution.tools.length, 0);
});
