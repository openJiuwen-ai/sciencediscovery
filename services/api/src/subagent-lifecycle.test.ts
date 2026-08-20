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
  DEFAULT_SUBAGENT_MAX_TURNS,
  MAX_SUBAGENT_TIMEOUT_SECONDS,
} from "@science-agent/orchestration";

import {
  classifySubagentFailure,
  SUBAGENT_PARENT_TIMEOUT_MARGIN_MS,
  subagentCapableParentRunTimeoutMs,
} from "@science-agent/specialist";
import { DEFAULT_AGENT_IDLE_TIMEOUT_MS as DEFAULT_GATEWAY_IDLE_TIMEOUT_MS } from "./native-agent/index.js";

test("parent gateway deadline exceeds the largest allowed subagent timeout", () => {
  assert.equal(SUBAGENT_PARENT_TIMEOUT_MARGIN_MS, 60_000);
  assert.equal(
    subagentCapableParentRunTimeoutMs(),
    MAX_SUBAGENT_TIMEOUT_SECONDS * 1_000 + SUBAGENT_PARENT_TIMEOUT_MARGIN_MS,
  );
  assert.ok(subagentCapableParentRunTimeoutMs() > DEFAULT_GATEWAY_IDLE_TIMEOUT_MS);
  assert.ok(subagentCapableParentRunTimeoutMs() > MAX_SUBAGENT_TIMEOUT_SECONDS * 1_000);
});

test("subagent lifecycle distinguishes timeout and max-turn caps", () => {
  assert.deepEqual(
    classifySubagentFailure(new Error("Agent run timeout: gateway turn exceeded 20 ms"), {
      maxTurns: DEFAULT_SUBAGENT_MAX_TURNS,
      maxTurnsExceeded: false,
      parentAborted: false,
    }),
    { error: "Agent run timeout: gateway turn exceeded 20 ms", status: "timed_out" },
  );
  assert.deepEqual(
    classifySubagentFailure(new Error("Agent run cancelled"), {
      maxTurns: 3,
      maxTurnsExceeded: true,
      parentAborted: false,
    }),
    { error: "Subagent exceeded maxTurns=3", status: "timed_out" },
  );
});

test("subagent lifecycle maps parent abort to cancelled and preserves other failures", () => {
  assert.equal(
    classifySubagentFailure(new Error("Agent run cancelled"), {
      maxTurns: DEFAULT_SUBAGENT_MAX_TURNS,
      maxTurnsExceeded: false,
      parentAborted: true,
    }).status,
    "cancelled",
  );
  assert.equal(
    classifySubagentFailure(new Error("Provider rejected request"), {
      maxTurns: DEFAULT_SUBAGENT_MAX_TURNS,
      maxTurnsExceeded: false,
      parentAborted: false,
    }).status,
    "failed",
  );
});
