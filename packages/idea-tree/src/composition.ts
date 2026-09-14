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

import { createHash } from "node:crypto";

import {
  type IdeaTreeExecutorDescriptor,
  type IdeaTreeWorkflowRoleSnapshot,
  type Specialist,
} from "@sciencediscovery/schema";

import { IDEA_TREE_TEAM_CONTRACT, ideaTreeExecutorFingerprintPayload } from "./contract.js";

export const IDEA_TREE_TEAM_SKILL_ID = "idea-tree-team";

export interface IdeaTreeSkillSnapshot {
  hash: string;
  id: string;
  metadata: Record<string, string>;
  revision: number;
  version: string;
}

export class IdeaTreeCompositionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "IdeaTreeCompositionError";
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stableValue(item)]));
}

export function ideaTreeFingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
}

/** Hash only executable Specialist configuration; updatedAt is frozen separately. */
export function specialistConfigHash(specialist: Specialist): string {
  return ideaTreeFingerprint({
    builtIn: specialist.builtIn === true,
    connectorIds: [...specialist.connectorIds].toSorted(),
    description: specialist.description,
    enabled: specialist.enabled !== false,
    enabledSkillIds: [...specialist.enabledSkillIds].toSorted(),
    id: specialist.id,
    instructions: specialist.instructions,
    name: specialist.name,
  });
}

export function runtimeSkillScope(skill: Pick<IdeaTreeSkillSnapshot, "id" | "metadata">): "both" | "lead" | "subagent" {
  if (skill.id === IDEA_TREE_TEAM_SKILL_ID) return "lead";
  const scope = skill.metadata["runtime-scope"];
  return scope === "lead" || scope === "subagent" ? scope : "both";
}

export function scopeRuntimeSkills<T extends Pick<IdeaTreeSkillSnapshot, "id" | "metadata">>(
  skills: readonly T[],
  role: "lead" | "subagent",
): T[] {
  return skills.filter((skill) => {
    const scope = runtimeSkillScope(skill);
    if (role === "lead" && scope === "subagent") return false;
    if (role === "subagent" && scope === "lead") return false;
    return true;
  });
}

export function ideaTreeSkillIds(
  configuredSkillIds: readonly string[],
  executorWorkflowSkillId?: string,
): string[] {
  const ids = new Set(configuredSkillIds);
  ids.add(IDEA_TREE_TEAM_SKILL_ID);
  if (executorWorkflowSkillId) ids.add(executorWorkflowSkillId);
  return [...ids];
}

export function isIdeaTreeExecutorSkill(skill: { id: string }): boolean {
  return skill.id === IDEA_TREE_TEAM_SKILL_ID;
}

export function workflowExecutorDescriptor(
  skill: IdeaTreeSkillSnapshot,
): IdeaTreeExecutorDescriptor {
  if (skill.id !== IDEA_TREE_TEAM_SKILL_ID) {
    throw new IdeaTreeCompositionError(
      "EXECUTOR_SKILL_INVALID",
      `Unsupported Idea Tree Workflow Skill: ${skill.id}`,
    );
  }
  const unsigned = {
    key: IDEA_TREE_TEAM_CONTRACT.executorKey,
    kind: "workflow_skill" as const,
    leafRoles: [],
    preflightRoles: [],
    resultAuthority: { ...IDEA_TREE_TEAM_CONTRACT.resultAuthority },
    resultContract: IDEA_TREE_TEAM_CONTRACT.resultContract,
    scoreSpec: { ...IDEA_TREE_TEAM_CONTRACT.scoreSpec },
    version: IDEA_TREE_TEAM_CONTRACT.executorVersion,
    workflowSkill: { hash: skill.hash, id: skill.id, revision: skill.revision, version: skill.version },
  };
  return {
    ...unsigned,
    fingerprint: ideaTreeFingerprint(ideaTreeExecutorFingerprintPayload(unsigned)),
  };
}

export function freezeIdeaTreeRunSelection(input: {
  configuredSkillIds: readonly string[];
  executorSkill?: IdeaTreeSkillSnapshot;
  ideaTreeEnabled: boolean;
}): {
  enabledSkillIds: string[];
  ideaTreeExecutor?: IdeaTreeExecutorDescriptor;
  ideaTreeEnabled: boolean;
} {
  if (!input.ideaTreeEnabled) {
    return { enabledSkillIds: [...new Set(input.configuredSkillIds)], ideaTreeEnabled: false };
  }
  if (!input.executorSkill) {
    throw new IdeaTreeCompositionError("EXECUTOR_NOT_SELECTED", "Select an Idea Tree executor Workflow Skill before queueing a Run");
  }
  return {
    enabledSkillIds: ideaTreeSkillIds(input.configuredSkillIds, input.executorSkill.id),
    ideaTreeExecutor: workflowExecutorDescriptor(input.executorSkill),
    ideaTreeEnabled: true,
  };
}

export function executorRoleForSpecialist(
  executor: IdeaTreeExecutorDescriptor,
  stage: "leaf" | "preflight",
  specialistId: string | undefined,
): IdeaTreeWorkflowRoleSnapshot | undefined {
  if (!specialistId) return undefined;
  const roles = stage === "leaf" ? executor.leafRoles : executor.preflightRoles;
  return roles.find((role) => role.specialistId === specialistId);
}

export function assertSpecialistSnapshot(
  role: IdeaTreeWorkflowRoleSnapshot,
  specialist: Specialist | undefined,
): Specialist {
  if (!specialist || specialist.enabled === false) {
    throw new IdeaTreeCompositionError(
      "EXECUTOR_SPECIALIST_UNAVAILABLE",
      `Frozen Workflow role ${role.role} Specialist ${role.specialistId} is unavailable`,
    );
  }
  if (specialist.updatedAt !== role.specialistUpdatedAt || specialistConfigHash(specialist) !== role.specialistConfigHash) {
    throw new IdeaTreeCompositionError(
      "EXECUTOR_SPECIALIST_DRIFT",
      `Specialist ${role.specialistId} changed after this Run froze its Workflow role`,
    );
  }
  return specialist;
}

export function executorSnapshotMatches(
  executor: IdeaTreeExecutorDescriptor,
  selected: IdeaTreeExecutorDescriptor | undefined,
): boolean {
  return Boolean(selected && selected.fingerprint === executor.fingerprint);
}
