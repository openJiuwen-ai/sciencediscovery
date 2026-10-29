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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { jwReadyFromBridge } from "../src/app/shell-bridge.js";

// These pin the gate's core semantics: a `?? true` default would let messages
// through into semantic-errors while the cluster is still booting, so
// "shell present, no verdict yet" must stay gated.
test("no shell at all (plain browser) is never gated", () => {
  assert.equal(jwReadyFromBridge(false, null), true);
  assert.equal(jwReadyFromBridge(false, { ready: false }), true);
});

test("shell present with no verdict yet is NOT ready", () => {
  assert.equal(jwReadyFromBridge(true, null), false);
});

test("the shell's last verdict decides", () => {
  assert.equal(jwReadyFromBridge(true, { ready: true }), true);
  assert.equal(jwReadyFromBridge(true, { ready: false, message: "启动中" }), false);
  assert.equal(jwReadyFromBridge(true, { ready: true, elapsed: 42, attempt: 3 }), true);
});
