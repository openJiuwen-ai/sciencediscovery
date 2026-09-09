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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SkillCatalog } from "@sciencediscovery/specialist";
import {
  createIdeaTreeAuthorityRegistry,
  type IdeaTreePersistence,
} from "@sciencediscovery/idea-tree";

import { createQueuedRun } from "../runs/index.js";
import { SkillLibraryCatalog } from "../skill-library-catalog.js";
import { SessionStore } from "../store.js";
import { ideaTreeSkillDeletionReferences } from "./deletion-impact.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "sciencediscovery-idea-tree-queue-"));
  const skillCatalog = new SkillCatalog(dataDir, repositoryRoot);
  await skillCatalog.load();
  const skillLibraryCatalog = new SkillLibraryCatalog(dataDir);
  await skillLibraryCatalog.load();
  const store = new SessionStore(dataDir);
  store.setAvailableSkillIds(skillCatalog.ids());
  await store.load();
  const project = await store.createProject("Idea Tree queue");
  const session = await store.createSession(project.id, "Queue", {}, {}, { allowUnconfiguredModel: true });
  let resumedExecutor: import("@sciencediscovery/schema").SessionRun["settingsSnapshot"]["ideaTreeExecutor"];
  const calls: string[] = [];
  const unexpected = async (): Promise<never> => { throw new Error("Queueing must not read or mutate tree state"); };
  const persistence: IdeaTreePersistence = {
    key: "queue-test",
    async call<T>(operation: string): Promise<T> {
      calls.push(operation);
      if (operation === "resumeExecutor") return (resumedExecutor ?? null) as T;
      if (operation === "resumeSettings") return null as T;
      return unexpected();
    },
    deleteAll: unexpected,
    listTreeIds: unexpected,
    readTree: unexpected,
    readGraph: unexpected,
  };
  const setResumedExecutor = (executor: typeof resumedExecutor) => { resumedExecutor = executor; };
  return { dataDir, persistence, calls, setResumedExecutor, session, skillCatalog, skillLibraryCatalog, store };
}

test("standard queued runs freeze standard mode without creating Idea Tree state", async (context) => {
  const { dataDir, persistence, calls, session, skillCatalog, skillLibraryCatalog, store } = await fixture();
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const run = await createQueuedRun(
    store,
    skillCatalog,
    skillLibraryCatalog,
    createIdeaTreeAuthorityRegistry(),
    session.id,
    { content: "ordinary task" },
    persistence,
  );
  assert.equal(run.settingsSnapshot.ideaTreeEnabled, false);
  assert.equal(run.settingsSnapshot.ideaTreeExecutor, undefined);
  assert.deepEqual(calls, [], "ordinary queueing does not contact the tree service");
});

test("idea_tree queued runs freeze the exact Markdown Skill and server-owned contract", async (context) => {
  const { dataDir, persistence, calls, session, skillCatalog, skillLibraryCatalog, store } = await fixture();
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  await store.updateSession(session.id, {});
  const run = await createQueuedRun(
    store,
    skillCatalog,
    skillLibraryCatalog,
    createIdeaTreeAuthorityRegistry(),
    session.id,
    { content: "/idea-tree fixture tree task" },
    persistence,
  );
  assert.equal(run.settingsSnapshot.ideaTreeEnabled, true);
  assert.equal(run.settingsSnapshot.ideaTreeExecutor?.workflowSkill.id, "idea-tree-team");
  assert.equal(run.settingsSnapshot.ideaTreeExecutor?.workflowSkill.version, "4.0.0");
  assert.equal(run.settingsSnapshot.ideaTreeExecutor?.version, "5.0.0");
  assert.equal(run.settingsSnapshot.ideaTreeExecutor?.preflightRequired, undefined);
  assert.deepEqual(run.settingsSnapshot.ideaTreeExecutor?.preflightRoles, []);
  assert.deepEqual(run.settingsSnapshot.ideaTreeExecutor?.leafRoles, []);
  assert.match(run.settingsSnapshot.ideaTreeExecutor?.fingerprint ?? "", /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(calls, ["resumeExecutor", "resumeSettings"]);

  await store.updateSession(session.id, {});
  const reopened = new SessionStore(dataDir);
  reopened.setAvailableSkillIds(skillCatalog.ids());
  await reopened.load();
  assert.equal(reopened.getSession(session.id)?.title, "Queue");
  assert.equal((await reopened.getSessionRun(session.id, run.id))?.settingsSnapshot.ideaTreeEnabled, true);
  assert.deepEqual(await ideaTreeSkillDeletionReferences(reopened, "idea-tree-team"), [{
    id: session.id,
    label: "Queue (Idea Tree workflow)",
    scope: "session",
  }]);
});

test("queued follow-ups retain an unfinished tree executor and return to standard mode after completion", async (context) => {
  const { dataDir, persistence, setResumedExecutor, session, skillCatalog, skillLibraryCatalog, store } = await fixture();
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const authorities = createIdeaTreeAuthorityRegistry();
  await store.updateSession(session.id, {});
  const first = await createQueuedRun(
    store,
    skillCatalog,
    skillLibraryCatalog,
    authorities,
    session.id,
    { content: "/idea-tree freeze tree" },
    persistence,
  );
  const executor = first.settingsSnapshot.ideaTreeExecutor;
  assert.ok(executor);
  setResumedExecutor(executor);
  await store.updateSpecialist("builtin-creative-material-design", { enabled: false });
  await store.updateSpecialist("builtin-creative-material-design", { enabled: true });
  const resumed = await createQueuedRun(
    store,
    skillCatalog,
    skillLibraryCatalog,
    authorities,
    session.id,
    { content: "请继续，探索多节点" },
    persistence,
  );
  assert.equal(resumed.settingsSnapshot.ideaTreeEnabled, true);
  assert.equal(resumed.settingsSnapshot.ideaTreeExecutor?.fingerprint, executor.fingerprint);
  setResumedExecutor(undefined);
  const ordinary = await createQueuedRun(
    store, skillCatalog, skillLibraryCatalog, authorities, session.id,
    { content: "Explain a different topic" }, persistence,
  );
  assert.equal(ordinary.settingsSnapshot.ideaTreeEnabled, false);
});
