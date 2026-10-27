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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import type { Subagent } from "@sciencediscovery/schema";

import type { SessionStore } from "../store.js";
import { declaredDeliverablePath, declaredDeliverablePaths, sessionRequiredDeliverables } from "./required-deliverables.js";

function subagent(outputRequirements: string[]): Subagent {
  return {
    createdAt: "2026-10-20T00:00:00.000Z",
    id: "subagent-1",
    input: { brief: {
      collaborationRules: [],
      constraints: [],
      goal: "Reproduce the paper",
      outputRequirements,
    }, description: "Reproduce", prompt: "Reproduce the paper" },
    maxTurns: 10,
    parentTurnId: "run-1",
    sessionId: "session-1",
    status: "completed",
    steps: [],
  } as unknown as Subagent;
}

test("deliverable declarations accept only explicit relative file paths", () => {
  const accepted = [
    "output/cl3/predictions.npy",
    "./outputs/predictions.csv",
    "outputs/model.fasta",
    "output\\cl3\\predictions.npy",
  ];
  for (const declaration of accepted) {
    assert.ok(declaredDeliverablePath(declaration), `${declaration} is a deliverable path`);
  }
  const rejected = [
    "Return JSON",
    "a short summary with details",
    "see the report above",
    "/home/witden/sciencediscovery/output/predictions.npy",
    "../outside/predictions.npy",
    "https://example.com/predictions.npy",
    "output/*.npy",
    "predictions",
    // A bare file name is satisfied by every instance's copy, so it is not a requirement.
    "REPRODUCTION_REPORT.md",
    // Climbing out of the declared directory is a notation, not the file.
    "output/../predictions.npy",
  ];
  for (const declaration of rejected) {
    assert.equal(declaredDeliverablePath(declaration), undefined, `${declaration} is not a deliverable path`);
  }
});

test("declared deliverable paths are de-duplicated across Briefs", () => {
  const paths = declaredDeliverablePaths([
    subagent(["output/cl3/predictions.npy", "a short summary"]),
    subagent(["./output/cl3/predictions.npy", "output/cl5/predictions.npy"]),
  ]);
  assert.deepEqual(paths, ["output/cl3/predictions.npy", "output/cl5/predictions.npy"]);
});

test("a Session without a structured deliverable declares none", () => {
  const store = { listSubagents: () => [subagent(["a short summary"])] } as unknown as SessionStore;
  assert.equal(sessionRequiredDeliverables(store, "session-1"), undefined);
  const withDeliverable = { listSubagents: () => [subagent(["output/cl3/predictions.npy"])] } as unknown as SessionStore;
  assert.deepEqual(sessionRequiredDeliverables(withDeliverable, "session-1"), {
    paths: ["output/cl3/predictions.npy"],
    source: "brief",
  });
});

test("declarations are scoped to the reviewed run and drop failed subagents", () => {
  const earlier = subagent(["output/cl3/predictions.npy"]);
  earlier.parentTurnId = "run-earlier";
  const failed = subagent(["output/cl9/predictions.npy"]);
  failed.status = "failed";
  const current = subagent(["output/cl5/predictions.npy"]);
  const store = { listSubagents: () => [earlier, failed, current] } as unknown as SessionStore;

  assert.deepEqual(sessionRequiredDeliverables(store, "session-1", "run-1"), {
    paths: ["output/cl5/predictions.npy"],
    source: "brief",
  });
  assert.deepEqual(sessionRequiredDeliverables(store, "session-1"), {
    paths: ["output/cl3/predictions.npy", "output/cl5/predictions.npy"],
    source: "brief",
  });
});
