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

import { isKnownClientInputError } from "./error-classification.js";

test("keeps known validation failures at 400 without hiding internal faults", () => {
  for (const message of [
    "Project name is required",
    "modelId must reference an existing model profile",
    "enabledSkillIds contains an unknown value",
    "The LLM base URL must use http or https",
    "Session deletion confirmation does not match the target",
    "Model is referenced by runtime settings and cannot be deleted",
    "Unsafe skill package path: ../escape.txt",
    "Upload filename must be a plain basename without path separators or traversal",
  ]) {
    assert.equal(isKnownClientInputError(new Error(message)), true, message);
  }
  assert.equal(isKnownClientInputError(new SyntaxError("Malformed JSON")), true);
  assert.equal(isKnownClientInputError(new Error("Database invariant failed")), false);
});
