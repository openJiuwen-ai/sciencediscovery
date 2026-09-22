// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { schedulerPlugin } from "./plugin.js";
test("default scheduling contribution preserves the task tool and policy", () => {
  const runSubagent = async () => { throw new Error("not invoked"); };
  assert.equal(schedulerPlugin({ runSubagent }).create().contribution.tools[0]?.name, "task");
  assert.equal(schedulerPlugin({ runSubagent, toolPolicy: { disallowed: ["task"] } }).create().contribution.tools.length, 0);
  assert.equal(schedulerPlugin({}).create().contribution.tools.length, 0);
});
