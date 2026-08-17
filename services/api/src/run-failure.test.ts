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

import { classifyRunFailure, runFailureMessage } from "./run-failure.js";

test("run failures classify into stable codes", () => {
  const cases: Array<[Error, string]> = [
    [new Error("Agent run timeout: gateway turn exceeded 1000 ms"), "timeout"],
    [new Error("Agent run stalled: no gateway progress for 240000 ms"), "timeout"],
    [new Error("Model request failed with status 401: invalid api key"), "unauthorized"],
    [new Error("Model request failed with status 403: forbidden"), "unauthorized"],
    [new Error("Model request failed with status 429: rate limit reached"), "rate-limited"],
    [new Error("Model request failed with status 503: service unavailable"), "server-error"],
    [new Error("Model endpoint is unavailable: connect ECONNREFUSED 127.0.0.1:9099"), "transport-error"],
    [new Error("assistant produced an unusable payload"), "semantic-error"],
  ];
  for (const [error, expected] of cases) {
    assert.equal(classifyRunFailure(error), expected, error.message);
  }
});

test("classification never discards the provider's own text", () => {
  // The old gateway replaced provider detail with a fixed sentence, which made
  // a failing endpoint undiagnosable. The code is additive: the original text
  // must survive verbatim so the user can see what actually came back.
  const detail = 'Model request failed with status 401: {"error":{"message":"key rejected by org-42"}}';
  const error = new Error(detail);
  assert.equal(classifyRunFailure(error), "unauthorized");
  assert.equal(runFailureMessage(error), detail);
});

test("non-Error failures still yield a message and a code", () => {
  assert.equal(runFailureMessage("boom"), "boom");
  assert.equal(runFailureMessage(undefined), "Agent run failed");
  assert.equal(runFailureMessage(new Error("")), "Agent run failed");
  assert.equal(classifyRunFailure(undefined), "semantic-error");
});
