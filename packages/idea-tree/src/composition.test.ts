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

import type { Specialist } from "@sciencediscovery/schema";

import {
  assertSpecialistSnapshot,
  freezeIdeaTreeRunSelection,
  IDEA_TREE_TEAM_SKILL_ID,
  IdeaTreeCompositionError,
  isIdeaTreeExecutorSkill,
  scopeRuntimeSkills,
  specialistConfigHash,
  workflowExecutorDescriptor,
} from "./composition.js";
import { IDEA_TREE_TEAM_CONTRACT, matchesIdeaTreeTeamContract } from "./contract.js";
import type { IdeaTreeSkillSnapshot } from "./composition.js";

function skill(id: string, metadata: Record<string, string> = {}): IdeaTreeSkillSnapshot {
  return { hash: `${id}-hash`, id, metadata, revision: 1, version: "1.0.0" };
}

function specialist(id: string): Specialist {
  return {
    connectorIds: [],
    createdAt: "2026-08-25T00:00:00.000Z",
    description: id,
    enabledSkillIds: [],
    id,
    instructions: `${id} instructions`,
    name: id,
    updatedAt: "2026-08-25T00:00:00.000Z",
  };
}

function workflowSkill(): IdeaTreeSkillSnapshot {
  return skill(IDEA_TREE_TEAM_SKILL_ID);
}

const specialists = [specialist("literature"), specialist("creative")];

test("standard selection remains isolated from Idea Tree", () => {
  const selection = freezeIdeaTreeRunSelection({
    configuredSkillIds: ["ordinary"],
    ideaTreeEnabled: false,
  });
  assert.deepEqual(selection, { enabledSkillIds: ["ordinary"], ideaTreeEnabled: false });
  assert.deepEqual(scopeRuntimeSkills([
    skill("ordinary"),
    skill(IDEA_TREE_TEAM_SKILL_ID),
  ], "lead").map(({ id }) => id), ["ordinary", IDEA_TREE_TEAM_SKILL_ID]);
  assert.deepEqual(scopeRuntimeSkills([
    skill("ordinary"),
    skill(IDEA_TREE_TEAM_SKILL_ID),
  ], "subagent").map(({ id }) => id), ["ordinary"]);
});

test("queue selection freezes Markdown identity and the server-owned workflow contract", () => {
  const selected = freezeIdeaTreeRunSelection({
    configuredSkillIds: ["ordinary"],
    executorSkill: workflowSkill(),
    ideaTreeEnabled: true,
  });
  assert.deepEqual(selected.enabledSkillIds, ["ordinary", IDEA_TREE_TEAM_SKILL_ID]);
  assert.equal(selected.ideaTreeExecutor?.preflightRequired, undefined);
  assert.deepEqual(selected.ideaTreeExecutor?.preflightRoles, []);
  assert.deepEqual(selected.ideaTreeExecutor?.leafRoles, []);
  assert.deepEqual(selected.ideaTreeExecutor?.resultAuthority, IDEA_TREE_TEAM_CONTRACT.resultAuthority);
  assert.deepEqual(selected.ideaTreeExecutor?.scoreSpec, IDEA_TREE_TEAM_CONTRACT.scoreSpec);
  assert.match(selected.ideaTreeExecutor?.fingerprint ?? "", /^sha256:[a-f0-9]{64}$/u);
  assert.equal(matchesIdeaTreeTeamContract(selected.ideaTreeExecutor!), true);
  assert.equal(matchesIdeaTreeTeamContract({
    ...selected.ideaTreeExecutor!,
    scoreSpec: { ...selected.ideaTreeExecutor!.scoreSpec, maximum: 11 },
  }), false);
});

test("v5 Markdown revisions change Run provenance without changing the hard-contract fingerprint", () => {
  const first = workflowExecutorDescriptor(workflowSkill());
  const revised = workflowExecutorDescriptor({
    ...workflowSkill(),
    hash: "revised-markdown-hash",
    revision: 2,
    version: "2.0.0",
  });
  assert.notDeepEqual(first.workflowSkill, revised.workflowSkill);
  assert.equal(first.fingerprint, revised.fingerprint);
});

test("the one built-in workflow needs no metadata while legacy Specialist snapshots still detect drift", () => {
  assert.equal(isIdeaTreeExecutorSkill(workflowSkill()), true);
  assert.equal(isIdeaTreeExecutorSkill(skill("ordinary")), false);
  assert.throws(
    () => freezeIdeaTreeRunSelection({ configuredSkillIds: [], ideaTreeEnabled: true }),
    (error: unknown) => error instanceof IdeaTreeCompositionError && error.code === "EXECUTOR_NOT_SELECTED",
  );
  assert.throws(
    () => workflowExecutorDescriptor(skill("ordinary")),
    (error: unknown) => error instanceof IdeaTreeCompositionError && error.code === "EXECUTOR_SKILL_INVALID",
  );
  const legacyRole = {
    role: "creative",
    specialistConfigHash: specialistConfigHash(specialists[1]!),
    specialistId: specialists[1]!.id,
    specialistUpdatedAt: specialists[1]!.updatedAt,
  };
  assert.throws(
    () => assertSpecialistSnapshot(legacyRole, { ...specialists[1]!, instructions: "changed" }),
    (error: unknown) => error instanceof IdeaTreeCompositionError && error.code === "EXECUTOR_SPECIALIST_DRIFT",
  );
});
