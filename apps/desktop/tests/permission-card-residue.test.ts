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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import type { PermissionRequest, RunStreamEvent, SessionRun, SessionRunEvent } from "../src/api/types.js";
import { pendingPermissions, reconcilePermissions } from "../src/run-stream/permission.js";
import { foldRunRecords, replayRun } from "../src/run-stream/replay.js";

/** The run and request of the reported residue, as they appear in the log. */
const RUN_ID = "27e45b93-bfb6-4efd-a580-dc48151ff175";
const REQUEST_ID = "3c3fde16-e0ef-4466-874a-8b798c78e288";

function record(sequence: number, event: RunStreamEvent): SessionRunEvent {
  return { createdAt: "2026-11-07T06:46:44.346Z", event, runId: RUN_ID, sequence, sessionId: "session-1" };
}

/** The request exactly as `main.jsonl` line 227 holds it: a pending snapshot,
 *  carrying the run id as its execution id, with no `permission.resolved`
 *  anywhere after it to close it out. */
const residue: PermissionRequest = {
  action: "artifact_download",
  createdAt: "2026-11-07T06:46:44.346Z",
  executionId: RUN_ID,
  id: REQUEST_ID,
  resource:
    "artifact:biorxiv:biorxiv:10.1101/2025.04.16.649149:v2:pdf:workspace:papers/edgar2025_pediatric_liver_atlas.pdf",
  state: "pending",
  summary:
    "Download biorxiv-10.1101_2025.04.16.649149-v2.pdf to workspace path papers/edgar2025_pediatric_liver_atlas.pdf",
};

function finishedRun(): SessionRun {
  return {
    annotationIds: [],
    assistantMessageId: "answer-1",
    createdAt: "2026-11-07T06:40:00.000Z",
    finishedAt: "2026-11-07T07:19:00.000Z",
    id: RUN_ID,
    prompt: "search biorxiv",
    queueOrder: 2,
    references: [],
    sessionId: "session-1",
    status: "completed",
    userMessageId: "question-1",
  } as SessionRun;
}

/** The tail of the reported run's log: a turn, then the snapshot that was never
 *  resolved. Rewind to a reload: the reducer rebuilds the same state. */
function reportedLog(): SessionRunEvent[] {
  return [
    record(1, { responseId: "r1", turn: 1, type: "assistant.response.started" }),
    record(2, { delta: "Downloading the paper.", responseId: "r1", type: "assistant.delta" }),
    record(3, { request: residue, type: "permission.required" }),
    record(4, { run: finishedRun(), status: "completed", type: "run.status" }),
  ];
}

function revisited(log: SessionRunEvent[]) {
  const rebuilt = replayRun(finishedRun(), foldRunRecords(log));
  assert.ok(rebuilt, "the reported log must still rebuild into a run");
  return rebuilt;
}

test("the reported log rebuilds the stuck card the bug showed", () => {
  const rebuilt = revisited(reportedLog());

  assert.equal(rebuilt.state.terminal, true, "a finished run disables the buttons");
  assert.deepEqual(
    pendingPermissions(rebuilt.state.permissions).map((request) => request.id),
    [REQUEST_ID],
    "the pending snapshot is exactly what the transcript rendered",
  );
});

test("the catalog's answer clears that card on reload", () => {
  const rebuilt = revisited(reportedLog());
  const decided: PermissionRequest = {
    ...residue,
    decidedAt: "2026-11-07T06:47:02.000Z",
    decision: "allowed",
    state: "allowed",
  };

  const permissions = reconcilePermissions(rebuilt.state.permissions, [decided]);

  assert.deepEqual(pendingPermissions(permissions), [], "no card is left for a decided request");
  assert.equal(permissions[0]!.request.state, "allowed");
});

test("a request the catalog still calls pending keeps its card", () => {
  // The negative control: a runtime that died between asking and answering
  // must still show the question rather than silently dropping it.
  const rebuilt = revisited(reportedLog());

  const permissions = reconcilePermissions(rebuilt.state.permissions, [residue]);

  assert.equal(pendingPermissions(permissions).length, 1);
});

test("once the server logs the resolution, reload needs no catalog read", () => {
  // The backend half of the fix: the same request, now followed by its answer,
  // rebuilds as decided on its own — so the frontend never sees a pending card
  // to reconcile in the first place.
  const log = reportedLog();
  log.splice(3, 0, record(3.5, {
    request: { ...residue, decidedAt: "2026-11-07T06:47:02.000Z", decision: "allowed", state: "allowed" },
    type: "permission.resolved",
  }));

  const rebuilt = revisited(log);

  assert.deepEqual(pendingPermissions(rebuilt.state.permissions), []);
  assert.equal(rebuilt.state.permissions[0]!.request.state, "allowed");
});
