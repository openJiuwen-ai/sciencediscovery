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
import { auditReviewContext, declaredDeliverablePath, declaredDeliverablePaths, reviewedRunIds, sessionRequiredDeliverables } from "./required-deliverables.js";

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
    scope: "session",
    // No run context at all: the caller only knows the Session, and says so.
    source: "session-fallback",
  });
});

test("declarations are scoped to the reviewed run and drop every stopped subagent", () => {
  const earlier = subagent(["output/cl3/predictions.npy"]);
  earlier.parentTurnId = "run-earlier";
  const failed = subagent(["output/cl9/predictions.npy"]);
  failed.status = "failed";
  const timedOut = subagent(["output/cl7/predictions.npy"]);
  timedOut.status = "timed_out";
  const cancelled = subagent(["output/cl8/predictions.npy"]);
  cancelled.status = "cancelled";
  const current = subagent(["output/cl5/predictions.npy"]);
  const store = { listSubagents: () => [earlier, failed, timedOut, cancelled, current] } as unknown as SessionStore;

  assert.deepEqual(sessionRequiredDeliverables(store, "session-1", ["run-1"]), {
    paths: ["output/cl5/predictions.npy"],
    scope: "run",
    source: "brief",
  });
  // A subagent that never finished ran no Brief to completion, so its declaration
  // is not an authoritative deliverable of the Session either.
  assert.deepEqual(sessionRequiredDeliverables(store, "session-1"), {
    paths: ["output/cl3/predictions.npy", "output/cl5/predictions.npy"],
    scope: "session",
    source: "session-fallback",
  });
});

test("a subagent's own Artifact is mapped back to the run that started it", () => {
  // Subagent products record the subagent's id as their turn (executionId == subagent.id),
  // never the root run id, so the run has to be recovered through the subagent record.
  const worker = subagent(["output/cl3/predictions.npy"]);
  worker.id = "subagent-abc";
  worker.parentTurnId = "run-1";
  const store = {
    getArtifactVersion: () => ({ createdAt: "2026-10-20T00:00:00.000Z", turnId: "subagent-abc" }),
    listSubagents: () => [worker],
  } as unknown as SessionStore;

  assert.deepEqual(reviewedRunIds(store, "session-1", ["subagent-report-v1"]), ["run-1"]);
  const context = auditReviewContext(store, {
    artifactVersionIds: ["subagent-report-v1"],
    sessionId: "session-1",
    toolCallId: "automatic-review:task-3",
  });
  assert.equal(context.parentRunId, "run-1");
  assert.deepEqual(context.requiredDeliverables, {
    paths: ["output/cl3/predictions.npy"],
    scope: "run",
    source: "brief",
  });
});

test("a run whose subagents stopped does not borrow another run's declarations", () => {
  // 69f2635c enforced a cancelled subagent's Brief; skipping it is right, but the
  // Session fallback must not then enforce a different run's deliverables instead.
  const stopped = subagent(["output/cl1/predictions.npy"]);
  stopped.parentTurnId = "run-1";
  stopped.status = "timed_out";
  const otherRun = subagent(["output/cl9/legacy.npy"]);
  otherRun.parentTurnId = "run-earlier";
  const store = { listSubagents: () => [stopped, otherRun] } as unknown as SessionStore;

  assert.equal(sessionRequiredDeliverables(store, "session-1", ["run-1"]), undefined);
});

test("a later run without Briefs falls back to the Session's live declarations", () => {
  const earlier = subagent(["output/cl3/predictions.npy"]);
  earlier.parentTurnId = "run-1";
  const store = { listSubagents: () => [earlier] } as unknown as SessionStore;
  // run-2 only rewrites the report; it must still be checked against the file the
  // earlier run declared instead of silently becoming unverified.
  assert.deepEqual(sessionRequiredDeliverables(store, "session-1", ["run-2"]), {
    paths: ["output/cl3/predictions.npy"],
    scope: "session",
    // Marked as a fallback: the Reviewer must not re-derive a reused verdict from it.
    source: "session-fallback",
  });
});

test("the reviewed runs are read from the Artifact versions, not the audit task id", () => {
  const versions: Record<string, { createdAt: string; turnId?: string }> = {
    v1: { createdAt: "2026-10-20T00:00:00.000Z", turnId: "run-1" },
    v2: { createdAt: "2026-10-20T01:00:00.000Z", turnId: "run-2" },
    v3: { createdAt: "2026-10-20T02:00:00.000Z" },
  };
  const store = {
    getArtifactVersion: (_sessionId: string, versionId: string) => versions[versionId],
    listSubagents: () => [],
  } as unknown as SessionStore;
  assert.deepEqual(reviewedRunIds(store, "session-1", ["v1"]), ["run-1"]);
  // The coordinator merges a new registration into the pending checkpoint, so one
  // audit can cover versions of several runs: every run is kept, newest first.
  assert.deepEqual(reviewedRunIds(store, "session-1", ["v1", "v2"]), ["run-2", "run-1"]);
  assert.deepEqual(reviewedRunIds(store, "session-1", ["v2", "v1"]), ["run-2", "run-1"]);
  assert.deepEqual(reviewedRunIds(store, "session-1", ["v1", "v2", "v3"]), ["run-2", "run-1"]);
  assert.deepEqual(reviewedRunIds(store, "session-1", ["missing"]), []);
  // The coordinator's synthetic id never matches a subagent's parentTurnId, which is
  // why the automatic path must derive the run from the versions it reviews.
  assert.deepEqual(reviewedRunIds(store, "session-1", []), []);
});

test("auditReviewContext turns an automatic task id back into the reviewed run", () => {
  const subagentForRun = subagent(["output/cl3/predictions.npy"]);
  subagentForRun.parentTurnId = "run-1";
  const store = {
    getArtifactVersion: (_sessionId: string, versionId: string) => versionId === "report-v2"
      ? { createdAt: "2026-10-20T00:00:00.000Z", turnId: "run-1" }
      : undefined,
    listSubagents: () => [subagentForRun],
  } as unknown as SessionStore;

  const automatic = auditReviewContext(store, {
    artifactVersionIds: ["report-v2"],
    sessionId: "session-1",
    toolCallId: "automatic-review:task-1",
  });
  assert.equal(automatic.parentRunId, "run-1");
  assert.deepEqual(automatic.parentRunIds, ["run-1"]);
  assert.deepEqual(automatic.requiredDeliverables, { paths: ["output/cl3/predictions.npy"], scope: "run", source: "brief" });
  assert.equal(typeof automatic.requiredDeliverablesFor, "function");
  // Manual re-review differs only by its synthetic id, which is not a run id either.
  const manual = auditReviewContext(store, {
    artifactVersionIds: ["report-v2"],
    sessionId: "session-1",
    toolCallId: "manual-review:message-1",
  });
  assert.equal(manual.parentRunId, automatic.parentRunId);
  assert.deepEqual(manual.requiredDeliverables, automatic.requiredDeliverables);
  assert.equal(typeof manual.requiredDeliverablesFor, "function");
});

test("an audit task whose versions carry no run falls back to the Session scope", () => {
  const subagentForRun = subagent(["output/cl3/predictions.npy"]);
  subagentForRun.parentTurnId = "run-1";
  const store = {
    getArtifactVersion: () => ({ createdAt: "2026-10-20T02:00:00.000Z" }),
    listSubagents: () => [subagentForRun],
  } as unknown as SessionStore;

  const fallbackContext = auditReviewContext(store, {
    artifactVersionIds: ["report-v3"],
    sessionId: "session-1",
    toolCallId: "manual-review:message-1",
  });
  assert.equal(fallbackContext.parentRunId, "manual-review:message-1");
  assert.deepEqual(fallbackContext.parentRunIds, []);
  assert.deepEqual(fallbackContext.requiredDeliverables, {
    paths: ["output/cl3/predictions.npy"],
    scope: "session",
    source: "session-fallback",
  });
});

test("an audit covering two runs keeps both runs' declarations", () => {
  // The coordinator merges a newly registered version into the pending checkpoint,
  // so one audit can review a run-A report and a run-B version together. Judging
  // them with only one run's Brief would drop a real requirement (or invent one).
  const runA = subagent(["output/a/predictions.npy"]);
  runA.parentTurnId = "run-A";
  const runB = subagent(["output/b/results.json"]);
  runB.parentTurnId = "run-B";
  const versions: Record<string, { createdAt: string; turnId: string }> = {
    "report-a": { createdAt: "2026-10-20T00:00:00.000Z", turnId: "run-A" },
    "report-b": { createdAt: "2026-10-20T00:05:00.000Z", turnId: "run-B" },
  };
  const store = {
    getArtifactVersion: (_sessionId: string, versionId: string) => versions[versionId],
    listSubagents: () => [runA, runB],
  } as unknown as SessionStore;

  const context = auditReviewContext(store, {
    artifactVersionIds: ["report-a", "report-b"],
    sessionId: "session-1",
    toolCallId: "automatic-review:task-2",
  });
  assert.deepEqual(context.parentRunIds, ["run-B", "run-A"]);
  assert.equal(context.parentRunId, "run-B", "one-run APIs still get the newest run");
  assert.deepEqual(context.requiredDeliverables, {
    paths: ["output/a/predictions.npy", "output/b/results.json"],
    scope: "run",
    source: "brief",
  });
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

  const parentRunIds = reviewedRunIds(store, "session-1", ["report-v2"]);
  assert.deepEqual(parentRunIds, ["run-1"]);
  assert.deepEqual(sessionRequiredDeliverables(store, "session-1", parentRunIds), {
    paths: ["output/cl3/predictions.npy"],
    scope: "run",
    source: "brief",
  });
  // A version without a turn id must fall back to the Session's declarations,
  // never to "no requirements".
  const fallbackRunIds = reviewedRunIds(store, "session-1", ["report-v3"]);
  assert.deepEqual(fallbackRunIds, []);
  assert.deepEqual(sessionRequiredDeliverables(store, "session-1", fallbackRunIds), {
    paths: ["output/cl3/predictions.npy"],
    scope: "session",
    source: "session-fallback",
  });
});
