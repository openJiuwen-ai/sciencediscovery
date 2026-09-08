// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
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
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import type { ContextContributor } from "@sciencediscovery/context";

import { createKeResidentSummaryFactory, KE_RESIDENT_SUMMARY_CONTRIBUTOR_ID } from "./contributor.js";
import { KnowledgeEngineStore } from "./store.js";
import { createKnowledgeEngineTools } from "./tools.js";

function tempRoot(name: string): string {
  return resolve(process.cwd(), ".tmp", `${name}-${Date.now()}-${process.pid}`);
}

test("resident-summary contributor: empty fleet → no section; graphed KB → working_context section", async (context) => {
  const root = tempRoot("ke-contributor");
  context.after(() => rm(root, { force: true, recursive: true }));
  const store = KnowledgeEngineStore.open(root);
  context.after(() => store.close());
  const tools = createKnowledgeEngineTools(store);
  const factory = createKeResidentSummaryFactory(tools);

  const emptyCreated = factory.create({ contextId: "s1", scope: "main" });
  assert.equal(Array.isArray(emptyCreated), false);
  const emptyContributor = emptyCreated as ContextContributor;
  const empty = await emptyContributor.contribute({
    contextId: "s1",
    history: [],
    latestUserInput: "",
    scope: "main",
    signal: new AbortController().signal,
    turn: 1,
  });
  assert.deepEqual(empty, {});

  const kb = store.createKnowledgeBase({ name: "Ebola" });
  const mab = store.upsertEntity({ kbId: kb.id, name: "mAb114", type: "antibody" });
  const gp = store.upsertEntity({ kbId: kb.id, name: "GP", type: "protein" });
  store.upsertEdge({ kbId: kb.id, srcId: mab.id, dstId: gp.id, type: "binds" });

  const created = factory.create({ contextId: "s1", scope: "main" });
  assert.equal(Array.isArray(created), false);
  const contributor = created as ContextContributor;
  const contribution = await contributor.contribute({
    contextId: "s1",
    history: [],
    latestUserInput: "",
    scope: "main",
    signal: new AbortController().signal,
    turn: 1,
  });
  assert.equal(contributor.id, KE_RESIDENT_SUMMARY_CONTRIBUTOR_ID);
  const section = contribution.systemSections?.[0];
  assert.ok(section);
  assert.equal(section.slot, "working_context");
  assert.match(section.content, /<knowledge_engine>/);
  assert.match(section.content, /knowledge_base id=/);
  assert.match(section.content, /mAb114/);
  assert.match(section.content, /concept_explore/); // tool signposting
});
