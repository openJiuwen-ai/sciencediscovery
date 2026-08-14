// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import assert from "node:assert/strict";
import test from "node:test";

import {
  clampWorkspaceWidth,
  fallbackSidebarWidth,
  MIN_WORKSPACE_WIDTH,
  workspaceMaxWidth,
} from "../src/workspaceWidth.js";

test("workspace maximum grows with desktop viewport instead of stopping at 560px", () => {
  assert.equal(workspaceMaxWidth(1440, 280), 780);
  assert.equal(workspaceMaxWidth(1920, 280), 1260);
  assert.ok(workspaceMaxWidth(1440, 280) > 560);
});

test("workspace maximum preserves the minimum conversation width and panel width", () => {
  assert.equal(workspaceMaxWidth(1000, 240), 380);
  assert.equal(workspaceMaxWidth(900, 240), MIN_WORKSPACE_WIDTH);
  assert.equal(fallbackSidebarWidth(1180), 240);
  assert.equal(fallbackSidebarWidth(1181), 280);
});

test("workspace width clamps stored, pointer, and keyboard values to current bounds", () => {
  assert.equal(clampWorkspaceWidth(200, 780), MIN_WORKSPACE_WIDTH);
  assert.equal(clampWorkspaceWidth(640, 780), 640);
  assert.equal(clampWorkspaceWidth(900, 780), 780);
  assert.equal(clampWorkspaceWidth(Number.POSITIVE_INFINITY, 780), 780);
});
