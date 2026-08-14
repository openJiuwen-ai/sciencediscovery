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

import { normalizeSubagentBrief, validateSubagentOutputValue } from "./subagent-brief.js";

test("Brief v1 normalization enforces field limits and server-owned version", () => {
  const brief = normalizeSubagentBrief({
    collaborationRules: [" Work independently "],
    constraints: ["Use only selected inputs"],
    goal: "Summarize the evidence",
    outputRequirements: ["Return JSON"],
    version: 1001,
  }, { version: 1 });

  assert.equal(brief?.version, 1);
  assert.equal(brief?.goal, "Summarize the evidence");
  assert.throws(() => normalizeSubagentBrief({
    collaborationRules: ["x"],
    constraints: ["x".repeat(1_001)],
    goal: "x",
    outputRequirements: ["x"],
  }), /at most 1000 characters/);
  assert.throws(() => normalizeSubagentBrief({
    collaborationRules: ["x"],
    constraints: ["x"],
    goal: "x".repeat(2_001),
    outputRequirements: ["x"],
  }), /at most 2000 characters/);
});

test("Brief outputJsonSchema uses JSON Schema 2020-12 validation instead of a hand-rolled subset", () => {
  const schema = {
    additionalProperties: false,
    properties: {
      code: { const: "ok" },
      score: { minimum: 10, type: "number" },
    },
    required: ["score", "code"],
    type: "object",
  };

  assert.deepEqual(validateSubagentOutputValue({ code: "ok", score: 12 }, schema), []);
  assert.match(validateSubagentOutputValue({ code: "nope", score: 1 }, schema).join("\n"), /must be equal to constant|must be >= 10/);
  assert.throws(() => normalizeSubagentBrief({
    collaborationRules: ["x"],
    constraints: ["x"],
    goal: "x",
    outputJsonSchema: {
      properties: { score: { typoKeyword: true, type: "number" } },
      type: "object",
    },
    outputRequirements: ["x"],
  }), /invalid/);
});
