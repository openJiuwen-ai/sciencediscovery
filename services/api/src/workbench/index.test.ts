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


import type { Project, ScientificArtifact, Session } from "@sciencediscovery/schema";

import type { SessionStore } from "../store.js";
import { searchWorkbench } from "./index.js";

const project: Project = {
  createdAt: "2026-01-01T00:00:00.000Z",
  id: "project-1",
  name: "Mixed catalog",
  remoteRunnerHostIds: [],
  settingsOverrides: {},
};

function session(index: number): Session {
  const id = `session-${index}`;
  return {
    approvalMode: "ask_for_dangerous",
    createdAt: "2026-01-01T00:00:00.000Z",
    enabledConnectorIds: [],
    enabledSkillIds: [],
    id,
    permissionEpochId: `epoch-${index}`,
    projectId: project.id,
    reviewCriteria: [],
    reviewMode: "manual",
    reviewerAutomaticReviewEnabled: true,
    reviewerSpecialistLevel: "quick",
    semanticReviewEnabled: false,
    settingsOverrides: {},
    title: `Analysis session ${index}`,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function artifact(index: number): ScientificArtifact {
  const target = index === 149;
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    createdInSessionId: "session-0",
    createdInSessionTitle: "Analysis session 0",
    currentVersion: 1,
    id: `artifact-${index}`,
    kind: "dataset",
    logicalName: target ? "target-after-250.csv" : `result-${index}.csv`,
    name: target ? "target-after-250.csv" : `result-${index}.csv`,
    origin: "user_upload",
    projectId: project.id,
    sessionId: "session-0",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("server-side query reaches matching mixed-catalog records beyond the first 250", async () => {
  const sessions = Array.from({ length: 150 }, (_, index) => session(index));
  const artifacts = Array.from({ length: 150 }, (_, index) => artifact(index));
  const store = {
    listProjectArtifacts: () => artifacts,
    listProjects: () => [project],
    listSessions: () => sessions,
  } as unknown as SessionStore;

  const firstPage = await searchWorkbench(store, "", { limit: 250 });
  assert.equal(firstPage.total, 301);
  assert.equal(firstPage.results.length, 250);
  assert.equal(firstPage.hasMore, true);
  assert.equal(firstPage.results.some((result) => result.label === "target-after-250.csv"), false);

  const secondPage = await searchWorkbench(store, "", { limit: 250, offset: 250 });
  assert.equal(secondPage.results.length, 51);
  assert.equal(secondPage.hasMore, false);
  assert.equal(secondPage.results.some((result) => result.label === "target-after-250.csv"), true);

  const targeted = await searchWorkbench(store, "target-after-250");
  assert.deepEqual(targeted.results.map((result) => result.label), ["target-after-250.csv"]);
  assert.deepEqual({ hasMore: targeted.hasMore, total: targeted.total }, { hasMore: false, total: 1 });
});

test("results carry the parts of their English detail, so a client can show them in its own language", async () => {
  const archived = { ...session(1), archivedAt: "2026-01-02T00:00:00.000Z" };
  const orphan = { ...artifact(2), createdInSessionId: "session-gone", name: "orphan.csv" };
  const store = {
    listProjectArtifacts: () => [artifact(1), orphan],
    listProjects: () => [project],
    listSessions: () => [session(0), archived],
  } as unknown as SessionStore;

  const byId = new Map((await searchWorkbench(store, "")).results.map((result) => [result.id, result]));
  assert.deepEqual(byId.get("project:project-1"), {
    detail: "Project", id: "project:project-1", kind: "project", label: "Mixed catalog", projectId: "project-1", projectName: "Mixed catalog",
  });
  assert.equal(byId.get("session:session-0")?.archived, undefined);
  assert.equal(byId.get("session:session-1")?.archived, true);
  assert.equal(byId.get("session:session-1")?.detail, "Mixed catalog · Archived");
  const kept = byId.get("artifact:artifact-1")!;
  assert.deepEqual([kept.projectName, kept.sessionTitle, kept.origin], ["Mixed catalog", "Analysis session 0", "user_upload"]);
  const deleted = byId.get("artifact:artifact-2")!;
  assert.equal(deleted.sessionTitle, undefined);
  assert.equal(deleted.detail, "Mixed catalog / Deleted Session · user_upload");
});
