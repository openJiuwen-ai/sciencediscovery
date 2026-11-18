// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { test } from "node:test";
import assert from "node:assert/strict";

import { taskTabKept } from "../src/idea/task-tab.js";

test("任务 keeps its tab for a selected research even when the session has no search", () => {
  // The bug this pins: the tab was kept only for Evolve runs, so a card that set
  // it was bounced to 产物 on the same render and the panel never appeared.
  assert.equal(taskTabKept(0, true), true);
  assert.equal(taskTabKept(0, false), false);
});

test("任务 stays for a run, and for a run beside a research", () => {
  assert.equal(taskTabKept(1, false), true);
  assert.equal(taskTabKept(3, true), true);
});
