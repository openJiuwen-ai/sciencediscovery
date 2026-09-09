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

import {
  IDEA_TREE_RESULT_CONTRACT,
  type IdeaTreeExecutorDescriptor,
  type IdeaTreeScoreSpec,
} from "@sciencediscovery/schema";

/**
 * Server-owned invariants for the one built-in Idea Tree workflow.
 *
 * Agent orchestration belongs in skills/idea-tree-team/references/workflow.md.
 * Changing that Markdown changes model behavior without changing this
 * contract. Only persisted-result semantics belong here.
 */
export const IDEA_TREE_TEAM_CONTRACT = {
  executorKey: "idea-tree-team",
  executorVersion: "5.0.0",
  // Generic 1-10 result boundary; the Skill defines the participating stages.
  resultAuthority: {
    key: "idea-tree-result",
    version: "3.0.0",
  },
  resultContract: IDEA_TREE_RESULT_CONTRACT,
  scoreSpec: {
    direction: "maximize",
    maximum: 10,
    minimum: 1,
    name: "research-score",
    rubricVersion: "IDEA-TREE-1.0",
  } satisfies IdeaTreeScoreSpec,
} as const;

/**
 * v5 freezes only the server-enforced result protocol. The current Markdown
 * Skill is selected for each Run, so editing workflow.md changes orchestration
 * without invalidating an unfinished tree. SessionRun snapshots still retain
 * the exact Skill revision used by each individual Run for provenance.
 *
 * Legacy descriptors keep their original full-snapshot fingerprint so v4
 * recovery semantics remain unchanged.
 */
export function ideaTreeExecutorFingerprintPayload(
  executor: Omit<IdeaTreeExecutorDescriptor, "fingerprint">,
): unknown {
  if (executor.key !== IDEA_TREE_TEAM_CONTRACT.executorKey
    || executor.version !== IDEA_TREE_TEAM_CONTRACT.executorVersion) return executor;
  const { preflightRequired: _legacyPreflightRequired, ...contract } = executor;
  return {
    ...contract,
    // Keep the v5 fingerprint compatible with descriptors created before
    // preflight became a workflow choice instead of a Runtime requirement.
    preflightRequired: true,
    workflowSkill: { id: executor.workflowSkill.id },
  };
}

/** Exact server contract accepted by the built-in Result Authority. */
export function matchesIdeaTreeTeamContract(executor: IdeaTreeExecutorDescriptor): boolean {
  const score = executor.scoreSpec;
  const supportedVersion = executor.version === IDEA_TREE_TEAM_CONTRACT.executorVersion
    || executor.version === "4.0.0";
  const v5Shape = executor.version !== IDEA_TREE_TEAM_CONTRACT.executorVersion
    || ((executor.preflightRequired === undefined || executor.preflightRequired === true)
      && executor.preflightRoles.length === 0
      && executor.leafRoles.length === 0);
  return supportedVersion
    && v5Shape
    && executor.key === IDEA_TREE_TEAM_CONTRACT.executorKey
    && executor.workflowSkill.id === IDEA_TREE_TEAM_CONTRACT.executorKey
    && executor.resultAuthority.key === IDEA_TREE_TEAM_CONTRACT.resultAuthority.key
    && executor.resultAuthority.version === IDEA_TREE_TEAM_CONTRACT.resultAuthority.version
    && executor.resultContract === IDEA_TREE_TEAM_CONTRACT.resultContract
    && (score.direction === "maximize" || score.direction === "minimize")
    && score.maximum === IDEA_TREE_TEAM_CONTRACT.scoreSpec.maximum
    && score.minimum === IDEA_TREE_TEAM_CONTRACT.scoreSpec.minimum
    && score.name === IDEA_TREE_TEAM_CONTRACT.scoreSpec.name
    && score.rubricVersion === IDEA_TREE_TEAM_CONTRACT.scoreSpec.rubricVersion;
}
