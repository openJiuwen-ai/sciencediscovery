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
import { declaredDeliverablePath, declaredDeliverablePaths, reviewedRunId, sessionRequiredDeliverables } from "./required-deliverables.js";

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
    // A root-level deliverable of the lead Agent has no directory; it is matched exactly.
    "REPRODUCTION_REPORT.md",
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

test("declarations are scoped to the reviewed run and drop stopped subagents", () => {
  const earlier = subagent(["output/cl3/predictions.npy"]);
  earlier.parentTurnId = "run-earlier";
  const failed = subagent(["output/cl9/predictions.npy"]);
  failed.status = "failed";
  const timedOut = subagent(["output/cl7/predictions.npy"]);
  timedOut.status = "timed_out";
  const current = subagent(["output/cl5/predictions.npy"]);
  const store = { listSubagents: () => [earlier, failed, timedOut, current] } as unknown as SessionStore;

  assert.deepEqual(sessionRequiredDeliverables(store, "session-1", "run-1"), {
    paths: ["output/cl5/predictions.npy"],
    source: "brief",
  });
  assert.deepEqual(sessionRequiredDeliverables(store, "session-1"), {
    paths: ["output/cl3/predictions.npy", "output/cl5/predictions.npy"],
    source: "brief",
  });
});

test("a later run without Briefs falls back to the Session's live declarations", () => {
  const earlier = subagent(["output/cl3/predictions.npy"]);
  earlier.parentTurnId = "run-1";
  const store = { listSubagents: () => [earlier] } as unknown as SessionStore;
  // run-2 only rewrites the report; it must still be checked against the file the
  // earlier run declared instead of silently becoming unverified.
  assert.deepEqual(sessionRequiredDeliverables(store, "session-1", "run-2"), {
    paths: ["output/cl3/predictions.npy"],
    source: "brief",
  });
});

test("the reviewed run is read from the Artifact versions, not the audit task id", () => {
  const store = {
    getArtifactVersion: (_sessionId: string, versionId: string) => versionId === "v1" ? { turnId: "run-1" } : undefined,
  } as unknown as SessionStore;
  assert.equal(reviewedRunId(store, "session-1", ["v1"]), "run-1");
  assert.equal(reviewedRunId(store, "session-1", ["missing"]), undefined);
  // The coordinator's synthetic id never matches a subagent's parentTurnId, which is
  // why the automatic path must derive the run from the versions it reviews.
  assert.equal(reviewedRunId(store, "session-1", []), undefined);
});

test("both audit paths reach the declarations of the run they review", () => {
  // The automatic audit is enqueued on an Artifact version; the manual one on a
  // message. Both hand the runner a synthetic tool-call id, so the run has to be
  // read from the reviewed version — this is the regression that turned the gate
  // off on the real paths while the function itself was correct.
  const subagentForRun = subagent(["output/cl3/predictions.npy"]);
  subagentForRun.parentTurnId = "run-1";
  const versions: Record<string, { turnId?: string }> = {
    "report-v2": { turnId: "run-1" },
    "report-v3": {},
  };
  const store = {
    getArtifactVersion: (_sessionId: string, versionId: string) => versions[versionId],
    listSubagents: () => [subagentForRun],
  } as unknown as SessionStore;

  const parentRunId = reviewedRunId(store, "session-1", ["report-v2"]);
  assert.equal(parentRunId, "run-1");
  assert.deepEqual(sessionRequiredDeliverables(store, "session-1", parentRunId), {
    paths: ["output/cl3/predictions.npy"],
    source: "brief",
  });
  // A version without a turn id must fall back to the Session's declarations,
  // never to "no requirements".
  assert.deepEqual(sessionRequiredDeliverables(store, "session-1", reviewedRunId(store, "session-1", ["report-v3"])), {
    paths: ["output/cl3/predictions.npy"],
    source: "brief",
  });
});
