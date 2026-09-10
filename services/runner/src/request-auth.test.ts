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
import { describe, test } from "node:test";

import {
  createExecutionSignature,
  DEFAULT_EXECUTION_SIGNATURE_MAX_AGE_MS,
  EXECUTION_SIGNATURE_MAX_AGE_MS,
  executionSignatureMaxAgeMs,
  verifyExecutionSignature,
} from "./request-auth.js";

describe("execution signature freshness window", () => {
  test("stays at 30s unless an operator widens it by name", () => {
    // The window is the replay window. A drifting clock on one machine is an
    // operations problem there; it must not quietly widen it for every Runner.
    assert.equal(DEFAULT_EXECUTION_SIGNATURE_MAX_AGE_MS, 30_000);
    assert.equal(executionSignatureMaxAgeMs({}), 30_000);
    assert.equal(EXECUTION_SIGNATURE_MAX_AGE_MS, 30_000);
  });

  test("widens only for an explicit variable", () => {
    assert.equal(
      executionSignatureMaxAgeMs({ SCIENCE_AGENT_EXECUTION_SIGNATURE_MAX_AGE_MS: "600000" }),
      600_000,
    );
  });

  test("fails closed on a value that is not a positive whole number of milliseconds", () => {
    // Falling back to the default would leave an operator believing a window
    // they configured is in force.
    for (const value of ["0", "-1", "abc", "1.5"]) {
      assert.throws(
        () => executionSignatureMaxAgeMs({ SCIENCE_AGENT_EXECUTION_SIGNATURE_MAX_AGE_MS: value }),
        /positive integer number of milliseconds/u,
        value,
      );
    }
  });

  test("a signature outside the default window is refused, inside it is accepted", () => {
    const token = "runner-test-token";
    const now = 1_800_000_000_000;
    const signed = (at: number) => {
      const timestamp = String(at);
      return verifyExecutionSignature(
        token, timestamp, "{}", createExecutionSignature(token, timestamp, "{}"), now,
      );
    };
    assert.equal(signed(now - 29_000), true);
    assert.equal(signed(now - 31_000), false);
    // Clock skew in either direction is bounded the same way.
    assert.equal(signed(now + 31_000), false);
  });
});
