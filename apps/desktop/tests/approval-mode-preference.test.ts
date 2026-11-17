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

import {
  inheritedApprovalMode,
  newSessionRequest,
  rememberApprovalMode,
  resetApprovalModePreference,
} from "../src/app/approval-mode-preference.js";

test("a new conversation is created in the mode the reader selected last", () => {
  resetApprovalModePreference();
  assert.deepEqual(newSessionRequest(), {}, "with no choice yet the service default applies");
  rememberApprovalMode("always_allow");
  assert.equal(inheritedApprovalMode(), "always_allow");
  assert.deepEqual(newSessionRequest("model-2"), { modelId: "model-2", approvalMode: "always_allow" });
  rememberApprovalMode("ask_for_dangerous");
  assert.deepEqual(newSessionRequest(), { approvalMode: "ask_for_dangerous" }, "the later choice wins");
  resetApprovalModePreference();
  assert.deepEqual(newSessionRequest(), {}, "a fresh instance starts with no inherited choice");
});

test("the inherited mode travels only in a creation body", () => {
  resetApprovalModePreference();
  rememberApprovalMode("always_allow");
  const body = newSessionRequest();
  // The preference must not arrive as a settings override or a title: those are the
  // fields that can be written onto a session after it exists.
  assert.deepEqual(Object.keys(body), ["approvalMode"]);
  resetApprovalModePreference();
});
