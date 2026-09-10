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

test("Idea Tree commands cannot start a legacy Agent run", async (context) => {
  const { dataDir, persistence, calls, session, skillCatalog, skillLibraryCatalog, store } = await fixture();
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  for (const content of ["/idea-tree", "/idea-tree-team research", "/idea-tree research"]) {
    await assert.rejects(createQueuedRun(store, skillCatalog, skillLibraryCatalog,
      createIdeaTreeAuthorityRegistry(), session.id, { content }, persistence), /research panel/);
  }
  assert.deepEqual(await store.listSessionRuns(session.id), []);
  assert.deepEqual(calls, []);
});

test("ordinary follow-ups never recover the old tree executor", async (context) => {
  const { dataDir, persistence, calls, session, skillCatalog, skillLibraryCatalog, store } = await fixture();
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const first = await createQueuedRun(store, skillCatalog, skillLibraryCatalog,
    createIdeaTreeAuthorityRegistry(), session.id, { content: "ordinary task" }, persistence);
  await store.updateSessionRun(session.id, first.id, {
    settingsSnapshot: { ...first.settingsSnapshot, ideaTreeEnabled: true },
  });
  const followup = await createQueuedRun(store, skillCatalog, skillLibraryCatalog,
    createIdeaTreeAuthorityRegistry(), session.id, { content: "请继续" }, persistence);
  assert.equal(followup.settingsSnapshot.ideaTreeEnabled, false);
  assert.deepEqual(calls, []);
});
