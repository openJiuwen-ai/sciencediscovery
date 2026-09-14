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

import type {
  IdeaTreeArtifactVersionSnapshot,
  IdeaTreeExecutorDescriptor,
} from "@sciencediscovery/schema";
import type { AgentTool } from "@sciencediscovery/tools";
import { Type } from "typebox";

import { IDEA_TREE_TEAM_CONTRACT, matchesIdeaTreeTeamContract } from "./contract.js";
import type { IdeaTreeAuthorityRuntime } from "./ports.js";
import { IdeaTreeRuntimeError } from "./runtime.js";

export interface IdeaTreeResultToolOptions {
  resolveArtifact: (identity: {
    artifactId: string;
    role: string;
    versionId: string;
  }) => Promise<IdeaTreeArtifactVersionSnapshot>;
}

/**
 * Workflow-neutral completion boundary.
 *
 * The Runtime still binds the result to one claimed execution and validates
 * the score range. Workflow Markdown decides which Agent stages run and which
 * exact Artifact versions, if any, are worth retaining with the result.
 */
export function createIdeaTreeResultTool(
  runtime: IdeaTreeAuthorityRuntime,
  executor: IdeaTreeExecutorDescriptor,
  options: IdeaTreeResultToolOptions,
): AgentTool | undefined {
  if (!matchesIdeaTreeTeamContract(executor)) return undefined;
  const artifactIdentity = Type.Object({
    artifact_id: Type.String({ minLength: 1 }),
    role: Type.String({ maxLength: 160, minLength: 1 }),
    version_id: Type.String({ minLength: 1 }),
  }, { additionalProperties: false });
  const parameters = Type.Object({
    artifacts: Type.Optional(Type.Array(artifactIdentity, { maxItems: 50 })),
    attempt: Type.Integer({ minimum: 1 }),
    execution_id: Type.String({ minLength: 16 }),
    insight: Type.String({ maxLength: 12_000, minLength: 1 }),
    request_hash: Type.String({ minLength: 1 }),
    score: Type.Number({ maximum: executor.scoreSpec.maximum, minimum: executor.scoreSpec.minimum }),
    tree_id: Type.String({ pattern: "^tree-[a-f0-9]{16}$" }),
  }, { additionalProperties: false });
  const tool: AgentTool<typeof parameters> = {
    description: "Finalize the currently claimed Idea Tree leaf with a score and insight. Workflow stages, checkpoints, and Artifacts are optional; when artifacts are supplied, the server verifies their exact Session-bound versions and provenance. Returns an opaque result handle for tree_complete.",
    execute: async (_toolCallId, params) => {
      const identities = params.artifacts ?? [];
      if (new Set(identities.map((identity) => identity.version_id)).size !== identities.length
        || new Set(identities.map((identity) => identity.artifact_id)).size !== identities.length) {
        throw new IdeaTreeRuntimeError("RESULT_ARTIFACT_INVALID", "Result Artifacts must be distinct exact versions");
      }
      const artifactVersions = await Promise.all(identities.map((identity) => options.resolveArtifact({
        artifactId: identity.artifact_id,
        role: identity.role,
        versionId: identity.version_id,
      })));
      const authorityRequestId = createHash("sha256").update(JSON.stringify({
        artifactVersionIds: artifactVersions.map(({ versionId }) => versionId),
        attempt: params.attempt,
        executionId: params.execution_id,
        insight: params.insight,
        requestHash: params.request_hash,
        score: params.score,
        treeId: params.tree_id,
      })).digest("hex");
      const verified = await runtime.issueVerifiedResult({
        artifactRefs: artifactVersions.map(({ artifactId }) => artifactId),
        attempt: params.attempt,
        authority: {
          key: IDEA_TREE_TEAM_CONTRACT.resultAuthority.key,
          requestId: authorityRequestId,
          version: IDEA_TREE_TEAM_CONTRACT.resultAuthority.version,
        },
        executionId: params.execution_id,
        insight: params.insight,
        requestHash: params.request_hash,
        scoreValue: params.score,
        treeId: params.tree_id,
      });
      const result = {
        artifact_refs: verified.artifactRefs,
        result_handle: verified.handle,
        rubric_version: verified.score.rubricVersion,
        score: verified.score.value,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
    label: "Finalize Idea Tree leaf",
    name: "idea_tree_finalize",
    parameters,
  };
  return tool;
}
