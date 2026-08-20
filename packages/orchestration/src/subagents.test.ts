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
  DEFAULT_SUBAGENT_TIMEOUT_SECONDS,
  GENERAL_PURPOSE_SUBAGENT,
  listSubagentPresets,
  MAX_SUBAGENT_MAX_TURNS,
  MAX_SUBAGENT_TIMEOUT_SECONDS,
  resolveSubagentConfig,
} from "./subagents.js";

test("general-purpose preset inherits tools, denies nesting, and matches the runtime guardrail scale", () => {
  const config = resolveSubagentConfig({ description: "Analyze results", prompt: "Analyze the results." });

  assert.equal(config.name, "general-purpose");
  assert.equal(config.tools, null);
  assert.deepEqual(config.disallowedTools, ["task", "propose_plan", "propose_remote_job"]);
  assert.equal(config.timeoutSeconds, DEFAULT_SUBAGENT_TIMEOUT_SECONDS);
  assert.equal(config.maxTurns, DEFAULT_SUBAGENT_MAX_TURNS);
  assert.deepEqual(listSubagentPresets(), [GENERAL_PURPOSE_SUBAGENT]);
});

test("subagent config accepts any requested type as a general-purpose delegation label", () => {
  assert.equal(
    resolveSubagentConfig({ description: "Alias", prompt: "Run.", subagentType: "general" }).name,
    "general-purpose",
  );
  assert.equal(
    resolveSubagentConfig({ description: "Method A", prompt: "Run.", subagentType: "method-a-worker" }).name,
    "general-purpose",
  );
  assert.equal(
    resolveSubagentConfig({ description: "Review", prompt: "Run.", subagentType: "user-reviewer" }).name,
    "general-purpose",
  );
  assert.equal(
    resolveSubagentConfig({ description: "Custom", prompt: "Run.", subagentType: "anything-the-user-created" }).name,
    "general-purpose",
  );
  assert.throws(
    () => resolveSubagentConfig({ description: "Too long", maxTurns: MAX_SUBAGENT_MAX_TURNS + 1, prompt: "Run." }),
    /maxTurns/,
  );
  assert.equal(
    resolveSubagentConfig({ description: "Short general test", prompt: "Run.", subagentType: "general-purpose", timeoutSeconds: 2 }).timeoutSeconds,
    2,
  );
  const roleConfig = resolveSubagentConfig({
    description: "Analyze data",
    maxTurns: 30,
    prompt: "Run.",
    subagentType: "code-engineer",
    timeoutSeconds: 600,
  });
  assert.equal(roleConfig.maxTurns, DEFAULT_SUBAGENT_MAX_TURNS);
  assert.equal(roleConfig.timeoutSeconds, DEFAULT_SUBAGENT_TIMEOUT_SECONDS);
  assert.equal(
    resolveSubagentConfig({ description: "Long manual test", maxTurns: 900, prompt: "Run.", timeoutSeconds: 12_000 }).maxTurns,
    900,
  );
  assert.equal(
    resolveSubagentConfig({ description: "Long manual test", maxTurns: 900, prompt: "Run.", timeoutSeconds: 12_000 }).timeoutSeconds,
    12_000,
  );
  assert.throws(
    () => resolveSubagentConfig({ description: "Too slow", prompt: "Run.", timeoutSeconds: MAX_SUBAGENT_TIMEOUT_SECONDS + 1 }),
    /timeoutSeconds/,
  );
});
