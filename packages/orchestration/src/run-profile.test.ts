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

import { createMainAgentProfile, createSubagentProfile } from "./run-profile.js";
import {
  DEFAULT_SUBAGENT_MAX_TURNS,
  DEFAULT_SUBAGENT_TIMEOUT_SECONDS,
} from "./subagents.js";

test("main and subagent profiles encode policy symmetrically without live runtime state", () => {
  const shared = {
    connectorIds: ["pubmed"],
    gatewayThreadId: "thread-1",
    runTimeoutMs: 30_000,
    skills: [{ id: "evidence", revision: 2, version: "1.0.0" }],
    specialistId: "specialist-1",
    workspaceRoot: "/workspace",
  };
  const main = createMainAgentProfile(shared);
  const subagent = createSubagentProfile({
    ...shared,
    allowedToolNames: ["read_file"],
    deniedToolNames: ["task", "propose_plan"],
    maxModelTurns: DEFAULT_SUBAGENT_MAX_TURNS,
    presetId: "general-purpose",
  });

  assert.equal(main.kind, "main");
  assert.deepEqual(main.historyPolicy, { inputPolicy: "outer-session", kind: "session" });
  assert.equal(subagent.kind, "subagent");
  assert.deepEqual(subagent.historyPolicy, { inputPolicy: "orchestrator-only", kind: "isolated" });
  assert.deepEqual(subagent.budget, { maxModelTurns: DEFAULT_SUBAGENT_MAX_TURNS, runTimeoutMs: 30_000 });
  assert.deepEqual(subagent.toolPolicy, {
    allowedToolNames: ["read_file"],
    deniedToolNames: ["task", "propose_plan"],
  });

  for (const profile of [main, subagent]) {
    assert.deepEqual(
      Object.keys(profile).toSorted(),
      ["budget", "gatewayThreadId", "historyPolicy", "kind", "resources", "toolPolicy", "workspaceRoot"],
    );
    assert.equal("prompt" in profile, false);
    assert.equal("permission" in profile, false);
    assert.equal("abortSignal" in profile, false);
  }
});

test("profile builders detach mutable resource and policy arrays", () => {
  const connectorIds = ["pubmed"];
  const skills = [{ id: "evidence" }];
  const deniedToolNames = ["task"];
  const profile = createSubagentProfile({
    connectorIds,
    deniedToolNames,
    gatewayThreadId: "subagent-1",
    maxModelTurns: DEFAULT_SUBAGENT_MAX_TURNS,
    presetId: "general-purpose",
    runTimeoutMs: DEFAULT_SUBAGENT_TIMEOUT_SECONDS * 1_000,
    skills,
    workspaceRoot: "/workspace",
  });
  connectorIds.push("arxiv");
  deniedToolNames.push("propose_plan");
  skills[0]!.id = "changed";

  assert.deepEqual(profile.resources.connectorIds, ["pubmed"]);
  assert.deepEqual(profile.resources.skills, [{ id: "evidence" }]);
  assert.deepEqual(profile.toolPolicy.deniedToolNames, ["task"]);
});
