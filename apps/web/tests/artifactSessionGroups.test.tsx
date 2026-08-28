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

import type { ScientificArtifact, Session } from "@sciencediscovery/schema";

import { groupArtifactsBySession, upsertArtifactSession } from "../src/artifact-session-groups.js";

function session(id: string, title: string): Session {
  return {
    approvalMode: "ask_for_dangerous",
    createdAt: "2026-08-01T00:00:00.000Z",
    enabledConnectorIds: [],
    enabledSkillIds: [],
    id,
    permissionEpochId: "epoch-1",
    projectId: "project-1",
    reviewCriteria: [],
    reviewMode: "manual",
    semanticReviewEnabled: false,
    settingsOverrides: {},
    title,
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function artifact(createdInSessionId = "session-1", contributingSessionIds?: string[]): ScientificArtifact {
  return {
    ...(contributingSessionIds ? { contributingSessionIds } : {}),
    createdAt: "2026-08-01T00:00:00.000Z",
    createdInSessionId,
    createdInSessionTitle: "Captured title",
    currentVersion: 1,
    id: "artifact-1",
    kind: "dataset",
    logicalName: "result.csv",
    name: "result.csv",
    origin: "llm_declared",
    projectId: "project-1",
    sessionId: createdInSessionId,
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

test("a shared Artifact appears in every Session that contributed a version", () => {
  const shared = artifact("session-1", ["session-1", "session-2"]);
  const groups = groupArtifactsBySession({
    artifacts: [shared],
    catalogProjectId: "project-1",
    deletedSessionLabel: "Deleted Session",
    projectId: "project-1",
    sessions: [
      session("session-1", "Analysis A"),
      session("session-2", "Analysis B"),
      session("session-3", "Unrelated"),
    ],
  });

  assert.deepEqual(groups.map((group) => ({
    artifactIds: group.items.map((item) => item.id),
    id: group.id,
    sourceSessionId: group.sourceSessionId,
  })), [
    { artifactIds: [shared.id], id: "session-1", sourceSessionId: "session-1" },
    { artifactIds: [shared.id], id: "session-2", sourceSessionId: "session-2" },
  ]);
});

test("artifact groups wait for the complete Session catalog before declaring deletion", () => {
  const pending = groupArtifactsBySession({
    artifacts: [artifact()],
    catalogProjectId: undefined,
    deletedSessionLabel: "Deleted Session",
    projectId: "project-1",
    sessions: [],
  });
  assert.deepEqual(pending.map(({ id, label }) => ({ id, label })), [
    { id: "session-1", label: "Captured title" },
  ]);

  const loaded = groupArtifactsBySession({
    artifacts: [artifact()],
    catalogProjectId: "project-1",
    deletedSessionLabel: "Deleted Session",
    projectId: "project-1",
    sessions: [session("session-1", "Current title")],
  });
  assert.equal(loaded[0]?.label, "Current title");
});

test("created and renamed Sessions update artifact groups from the live catalog", () => {
  const created = upsertArtifactSession([], session("session-1", "Untitled session"));
  const renamed = upsertArtifactSession(created, session("session-1", "Renamed analysis"));
  const another = upsertArtifactSession(renamed, session("session-2", "New Session"));

  assert.deepEqual(another.map(({ id, title }) => ({ id, title })), [
    { id: "session-2", title: "New Session" },
    { id: "session-1", title: "Renamed analysis" },
  ]);
  assert.equal(groupArtifactsBySession({
    artifacts: [artifact()],
    catalogProjectId: "project-1",
    deletedSessionLabel: "Deleted Session",
    projectId: "project-1",
    sessions: another,
  })[0]?.label, "Renamed analysis");
});

test("only a loaded catalog with a missing source uses the deleted Session group", () => {
  const groups = groupArtifactsBySession({
    artifacts: [artifact()],
    catalogProjectId: "project-1",
    deletedSessionLabel: "Deleted Session",
    projectId: "project-1",
    sessions: [],
  });

  assert.deepEqual(groups.map(({ id, label }) => ({ id, label })), [
    { id: "deleted", label: "Deleted Session" },
  ]);
});
