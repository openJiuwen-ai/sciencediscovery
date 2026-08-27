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
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { SessionStore, SessionStoreHttpError } from "./store.js";

test("Artifact logical deletion persists without removing source files or history", async (context) => {
  const dataDir = await mkdtemp(resolve(tmpdir(), "sciencediscovery-artifact-lifecycle-"));
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  store.setAvailableSkillIds([]);
  await store.load();
  const project = await store.createProject("Lifecycle project");
  const otherProject = await store.createProject("Other project");
  const session = await store.createSession(project.id, "Lifecycle session", {}, {}, { allowUnconfiguredModel: true });
  const workspace = store.workspacePath(session.id);
  await mkdir(workspace, { recursive: true });
  await writeFile(resolve(workspace, "result.csv"), "value\n1\n", "utf8");

  const first = await store.createArtifactVersion({
    content: { hash: "a".repeat(64), size: 8 },
    kind: "dataset",
    logicalName: "result.csv",
    mediaType: "text/csv",
    origin: "user_upload",
    sessionId: session.id,
    sourcePath: "result.csv",
  });
  const reloaded = new SessionStore(dataDir);
  reloaded.setAvailableSkillIds([]);
  await reloaded.load();
  await assert.rejects(
    reloaded.deleteArtifact(otherProject.id, first.artifact.id),
    (reason) => reason instanceof SessionStoreHttpError && reason.statusCode === 404,
  );

  const deleted = await reloaded.deleteArtifact(project.id, first.artifact.id);
  assert.equal(typeof deleted.deletedAt, "string");
  assert.deepEqual(reloaded.listProjectArtifacts(project.id), []);
  assert.equal(reloaded.getArtifactByName(session.id, "result.csv"), undefined);
  assert.equal(reloaded.getProjectArtifact(project.id, first.artifact.id)?.deletedAt, deleted.deletedAt);
  assert.deepEqual(
    reloaded.listProjectArtifactVersions(project.id, first.artifact.id).map((version) => version.id),
    [first.version.id],
  );
  assert.equal(await readFile(resolve(workspace, "result.csv"), "utf8"), "value\n1\n");
  assert.equal((await reloaded.deleteArtifact(project.id, first.artifact.id)).deletedAt, deleted.deletedAt);

  const replacement = await reloaded.createArtifactVersion({
    content: { hash: "b".repeat(64), size: 8 },
    kind: "dataset",
    logicalName: "result.csv",
    mediaType: "text/csv",
    origin: "user_upload",
    sessionId: session.id,
    sourcePath: "result.csv",
  });
  assert.notEqual(replacement.artifact.id, first.artifact.id);
  assert.equal(replacement.version.version, 1);

  const finalReload = new SessionStore(dataDir);
  finalReload.setAvailableSkillIds([]);
  await finalReload.load();
  assert.deepEqual(finalReload.listProjectArtifacts(project.id).map((artifact) => ({
    id: artifact.id,
    name: artifact.name,
  })), [{ id: replacement.artifact.id, name: "result.csv" }]);
  assert.equal(finalReload.getProjectArtifact(project.id, first.artifact.id)?.deletedAt, deleted.deletedAt);
  assert.equal(finalReload.listProjectArtifactVersions(project.id, first.artifact.id).length, 1);
});
