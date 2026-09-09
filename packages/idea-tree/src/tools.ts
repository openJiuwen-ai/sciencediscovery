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

import type {
  IdeaTreeArtifactVersionSnapshot,
  IdeaTreeExecutorDescriptor,
  IdeaTreePhase,
} from "@sciencediscovery/schema";
import type { AgentTool, AgentToolResult } from "@sciencediscovery/tools";
import { Type } from "typebox";

import { IdeaTreeRuntime, IdeaTreeRuntimeError } from "./runtime.js";

export interface CreateIdeaTreeToolsOptions {
  executor?: IdeaTreeExecutorDescriptor;
  onPhase?: (phase: IdeaTreePhase, detail?: { nodeId?: string; treeId?: string }) => Promise<void> | void;
  resolveArtifactSnapshot?: (
    identity: { artifactId: string; role: string; versionId: string },
  ) => Promise<IdeaTreeArtifactVersionSnapshot>;
  runtime: IdeaTreeRuntime;
}
function toolResult(value: unknown): AgentToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

const treeId = Type.String({ pattern: "^tree-[a-f0-9]{16}$" });
const optionalTreeId = Type.Optional(treeId);
const mutationFields = {
  expected_revision: Type.Integer({ minimum: 1 }),
  idempotency_key: Type.String({ maxLength: 160, minLength: 1 }),
  tree_id: treeId,
};
const artifactIdentity = Type.Object({
  artifact_id: Type.String({ minLength: 1 }),
  role: Type.String({ maxLength: 160, minLength: 1 }),
  version_id: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export function createIdeaTreeTools(options: CreateIdeaTreeToolsOptions): AgentTool[] {
  const createParameters = Type.Object({
    idempotency_key: Type.String({ maxLength: 160, minLength: 1 }),
    max_depth: Type.Integer({ maximum: 20, minimum: 1 }),
    max_nodes: Type.Integer({ maximum: 10_000, minimum: 2 }),
    max_search_rounds: Type.Integer({ maximum: 10_000, minimum: 1 }),
    objective: Type.String({ maxLength: 4_000, minLength: 1 }),
    root_hypothesis: Type.String({ maxLength: 4_000, minLength: 1 }),
  }, { additionalProperties: false });
  const treeCreate: AgentTool<typeof createParameters> = {
    description: "Create a bounded persisted Idea Tree. Explicit budget arguments override the settings defaults and are persisted as this tree's limits. The Runtime uses the user-selected Workflow Skill and its server-validated score contract frozen in this Run; the Agent cannot supply or alter executor/rubric fields.",
    execute: async (_toolCallId, params) => {
      if (!options.executor) {
        throw new IdeaTreeRuntimeError(
          "EXECUTOR_NOT_SELECTED",
          "Select an Idea Tree executor Workflow Skill before queueing this Run",
        );
      }
      const result = await options.runtime.create({
        executor: options.executor,
        idempotencyKey: params.idempotency_key,
        maxDepth: params.max_depth,
        maxNodes: params.max_nodes,
        maxSearchRounds: params.max_search_rounds,
        objective: params.objective,
        rootHypothesis: params.root_hypothesis,
      });
      await options.onPhase?.("building_tree", { treeId: result.treeId });
      return toolResult(result);
    },
    label: "Create Idea Tree",
    name: "tree_create",
    parameters: createParameters,
  };

  const attachContextParameters = Type.Object({
    ...mutationFields,
    artifacts: Type.Array(artifactIdentity, { maxItems: 50 }),
  }, { additionalProperties: false });
  const treeAttachContext: AgentTool<typeof attachContextParameters> = {
    description: "Optionally set exact Artifact versions as shared tree context before the first leaf execution. Pass an empty list to use no shared context. Workflow Markdown decides whether this step is needed.",
    execute: async (_toolCallId, params) => {
      if (!options.resolveArtifactSnapshot) {
        throw new IdeaTreeRuntimeError("ARTIFACT_RESOLVER_UNAVAILABLE", "Shared-context Artifact verification is unavailable");
      }
      const artifactVersions = await Promise.all(params.artifacts.map((artifact) => options.resolveArtifactSnapshot!({
        artifactId: artifact.artifact_id,
        role: artifact.role,
        versionId: artifact.version_id,
      })));
      const result = await options.runtime.attachContext({
        artifactVersions,
        expectedRevision: params.expected_revision,
        idempotencyKey: params.idempotency_key,
        treeId: params.tree_id,
      });
      await options.onPhase?.("building_tree", { treeId: result.treeId });
      return toolResult(result);
    },
    label: "Attach Idea Tree research context",
    name: "tree_attach_context",
    parameters: attachContextParameters,
  };

  const listParameters = Type.Object({});
  const treeList: AgentTool<typeof listParameters> = {
    description: "Discover persisted Idea Trees in this Session and identify the current running, propagation-pending, or most recently updated tree. Use this first when resuming without a tree id.",
    execute: async () => toolResult(await options.runtime.list()),
    label: "List Idea Trees",
    name: "tree_list",
    parameters: listParameters,
  };

  const viewParameters = Type.Object({
    format: Type.Optional(Type.Union([
      Type.Literal("compact"),
      Type.Literal("constraints"),
      Type.Literal("full"),
      Type.Literal("node"),
      Type.Literal("pending"),
    ])),
    node_id: Type.Optional(Type.String({ minLength: 1 })),
    tree_id: optionalTreeId,
  });
  const treeView: AgentTool<typeof viewParameters> = {
    description: "Read a persisted Idea Tree. tree_id is optional so a compacted or new Lead Run can rediscover the current tree. Node views include execution/checkpoint and propagation state.",
    execute: async (_toolCallId, params) => toolResult(await options.runtime.view(
      params.tree_id,
      params.format ?? "compact",
      params.node_id,
    )),
    label: "View Idea Tree",
    name: "tree_view",
    parameters: viewParameters,
  };

  const addParameters = Type.Object({
    ...mutationFields,
    hypothesis: Type.String({ maxLength: 4_000, minLength: 1 }),
    parent_id: Type.String({ minLength: 1 }),
    priority: Type.Optional(Type.Number({ maximum: 1_000, minimum: -1_000 })),
  });
  const treeAddNode: AgentTool<typeof addParameters> = {
    description: "Add one child hypothesis with a stable Arbor-style id. Enforces revision, depth, node-count, search-round, propagation, and running-execution constraints.",
    execute: async (_toolCallId, params) => {
      const result = await options.runtime.addNode({
        expectedRevision: params.expected_revision,
        hypothesis: params.hypothesis,
        idempotencyKey: params.idempotency_key,
        parentId: params.parent_id,
        ...(params.priority === undefined ? {} : { priority: params.priority }),
        treeId: params.tree_id,
      });
      await options.onPhase?.("building_tree", { treeId: result.treeId });
      return toolResult(result);
    },
    label: "Add Idea Tree node",
    name: "tree_add_node",
    parameters: addParameters,
  };

  const updateParameters = Type.Object({
    ...mutationFields,
    hypothesis: Type.Optional(Type.String({ maxLength: 4_000, minLength: 1 })),
    insight: Type.Optional(Type.String({ maxLength: 12_000, minLength: 1 })),
    node_id: Type.String({ minLength: 1 }),
    priority: Type.Optional(Type.Number({ maximum: 1_000, minimum: -1_000 })),
    propagation_child_digest: Type.Optional(Type.String({ pattern: "^sha256:[a-f0-9]{64}$" })),
  });
  const treeUpdateNode: AgentTool<typeof updateParameters> = {
    description: "Update an unexplored hypothesis/priority, or complete the one pending bottom-up propagation by submitting aggregate insight with the exact child digest returned by tree_view. It cannot change lifecycle, leaf insight, artifacts, or score.",
    execute: async (_toolCallId, params) => {
      const result = await options.runtime.updateNode({
        expectedRevision: params.expected_revision,
        ...(params.hypothesis === undefined ? {} : { hypothesis: params.hypothesis }),
        idempotencyKey: params.idempotency_key,
        ...(params.insight === undefined ? {} : { insight: params.insight }),
        nodeId: params.node_id,
        ...(params.priority === undefined ? {} : { priority: params.priority }),
        ...(params.propagation_child_digest === undefined
          ? {}
          : { propagationChildDigest: params.propagation_child_digest }),
        treeId: params.tree_id,
      });
      if (params.propagation_child_digest) {
        await options.onPhase?.(
          result.pendingPropagationNodeId ? "propagating_insight" : "building_tree",
          { nodeId: result.pendingPropagationNodeId ?? result.node.id, treeId: result.treeId },
        );
      }
      return toolResult(result);
    },
    label: "Update Idea Tree node",
    name: "tree_update_node",
    parameters: updateParameters,
  };

  const metaValue = Type.Union([Type.Boolean(), Type.Number(), Type.String({ maxLength: 4_000 }), Type.Null()]);
  const metaParameters = Type.Object({
    ...mutationFields,
    patch: Type.Record(Type.String({ pattern: "^[a-z][a-z0-9_.-]{0,79}$" }), metaValue, {
      maxProperties: 50,
      minProperties: 1,
    }),
  });
  const treeSetMeta: AgentTool<typeof metaParameters> = {
    description: "Persist non-authoritative Coordinator metadata. Server-owned executor, score, and result-contract fields are reserved.",
    execute: async (_toolCallId, params) => toolResult(await options.runtime.setMeta({
      expectedRevision: params.expected_revision,
      idempotencyKey: params.idempotency_key,
      patch: params.patch,
      treeId: params.tree_id,
    })),
    label: "Set Idea Tree metadata",
    name: "tree_set_meta",
    parameters: metaParameters,
  };

  const selectParameters = Type.Object({
    strategy: Type.Optional(Type.Union([Type.Literal("fifo"), Type.Literal("highest_priority")])),
    tree_id: optionalTreeId,
  });
  const treeSelect: AgentTool<typeof selectParameters> = {
    description: "Deterministically rank eligible terminal leaves without mutating state. Selection reports pending propagation when claim is temporarily blocked.",
    execute: async (_toolCallId, params) => toolResult(await options.runtime.select(
      params.tree_id,
      params.strategy ?? "highest_priority",
    )),
    label: "Select Idea Tree leaf",
    name: "tree_select",
    parameters: selectParameters,
  };

  const claimParameters = Type.Object({
    ...mutationFields,
    node_id: Type.String({ minLength: 1 }),
  });
  const treeClaim: AgentTool<typeof claimParameters> = {
    description: "Atomically claim one active pending max-depth terminal leaf across the whole Session. Returns a frozen Workflow Skill request and an owner/lease-bound execution.",
    execute: async (_toolCallId, params) => {
      const result = await options.runtime.claim({
        expectedRevision: params.expected_revision,
        idempotencyKey: params.idempotency_key,
        nodeId: params.node_id,
        treeId: params.tree_id,
      });
      await options.onPhase?.("executing_leaf", { nodeId: result.request.nodeId, treeId: result.treeId });
      return toolResult(result);
    },
    label: "Claim Idea Tree leaf",
    name: "tree_claim",
    parameters: claimParameters,
  };

  const checkpointParameters = Type.Object({
    ...mutationFields,
    artifacts: Type.Array(artifactIdentity, { maxItems: 100, minItems: 1 }),
    attempt: Type.Integer({ minimum: 1 }),
    execution_id: Type.String({ minLength: 16 }),
    input_digest: Type.String({ maxLength: 200, minLength: 1 }),
    request_hash: Type.String({ maxLength: 200, minLength: 1 }),
    step_key: Type.String({ maxLength: 160, minLength: 1 }),
  });
  const treeCheckpoint: AgentTool<typeof checkpointParameters> = {
    description: "Optionally persist exact output Artifact versions for a Workflow-defined step. The Runtime never requires a particular step or checkpoint sequence.",
    execute: async (_toolCallId, params) => {
      if (!options.resolveArtifactSnapshot) {
        throw new IdeaTreeRuntimeError("ARTIFACT_RESOLVER_UNAVAILABLE", "Checkpoint Artifact verification is unavailable");
      }
      const artifactVersions = await Promise.all(params.artifacts.map((artifact) => options.resolveArtifactSnapshot!({
        artifactId: artifact.artifact_id,
        role: artifact.role,
        versionId: artifact.version_id,
      })));
      return toolResult(await options.runtime.checkpoint({
        artifactVersions,
        attempt: params.attempt,
        executionId: params.execution_id,
        expectedRevision: params.expected_revision,
        idempotencyKey: params.idempotency_key,
        inputDigest: params.input_digest,
        requestHash: params.request_hash,
        stepKey: params.step_key,
        treeId: params.tree_id,
      }));
    },
    label: "Checkpoint Idea Tree execution",
    name: "tree_checkpoint",
    parameters: checkpointParameters,
  };

  const completeParameters = Type.Object({
    ...mutationFields,
    result_handle: Type.String({ pattern: "^result-[a-f0-9]{32}$" }),
  }, { additionalProperties: false });
  const treeComplete: AgentTool<typeof completeParameters> = {
    description: "Consume an execution-bound result handle issued by the generic Idea Tree finalizer.",
    execute: async (_toolCallId, params) => {
      const result = await options.runtime.complete({
        expectedRevision: params.expected_revision,
        idempotencyKey: params.idempotency_key,
        resultHandle: params.result_handle,
        treeId: params.tree_id,
      });
      if (result.pendingPropagationNodeId) {
        await options.onPhase?.("propagating_insight", {
          nodeId: result.pendingPropagationNodeId,
          treeId: result.treeId,
        });
      }
      return toolResult(result);
    },
    label: "Complete Idea Tree leaf",
    name: "tree_complete",
    parameters: completeParameters,
  };

  const failParameters = Type.Object({
    ...mutationFields,
    artifact_refs: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 100 })),
    attempt: Type.Integer({ minimum: 1 }),
    execution_id: Type.String({ minLength: 16 }),
    message: Type.String({ maxLength: 4_000, minLength: 1 }),
    reason_code: Type.String({ maxLength: 160, minLength: 1 }),
    request_hash: Type.String({ maxLength: 200, minLength: 1 }),
    retryable: Type.Boolean(),
  });
  const treeFail: AgentTool<typeof failParameters> = {
    description: "Record an operational Workflow failure without creating scientific score or insight. Retryable failures preserve checkpoints.",
    execute: async (_toolCallId, params) => toolResult(await options.runtime.fail({
      ...(params.artifact_refs ? { artifactRefs: params.artifact_refs } : {}),
      attempt: params.attempt,
      executionId: params.execution_id,
      expectedRevision: params.expected_revision,
      idempotencyKey: params.idempotency_key,
      message: params.message,
      reasonCode: params.reason_code,
      requestHash: params.request_hash,
      retryable: params.retryable,
      treeId: params.tree_id,
    })),
    label: "Fail Idea Tree execution",
    name: "tree_fail",
    parameters: failParameters,
  };

  const retryParameters = Type.Object({
    ...mutationFields,
    force: Type.Optional(Type.Boolean()),
    node_id: Type.String({ minLength: 1 }),
  });
  const treeRetry: AgentTool<typeof retryParameters> = {
    description: "Return needs_retry to pending while preserving its logical execution and checkpoints. Forced permanent retry requires explicit justification outside this tool.",
    execute: async (_toolCallId, params) => toolResult(await options.runtime.retry({
      expectedRevision: params.expected_revision,
      ...(params.force === undefined ? {} : { force: params.force }),
      idempotencyKey: params.idempotency_key,
      nodeId: params.node_id,
      treeId: params.tree_id,
    })),
    label: "Retry Idea Tree leaf",
    name: "tree_retry",
    parameters: retryParameters,
  };

  const pruneParameters = Type.Object({
    ...mutationFields,
    node_id: Type.String({ minLength: 1 }),
    reason: Type.String({ maxLength: 4_000, minLength: 1 }),
  });
  const treePrune: AgentTool<typeof pruneParameters> = {
    description: "Disable search for a direction and descendants while preserving completed leaf lifecycle, score, artifacts, and negative experience. Queues reliable parent propagation.",
    execute: async (_toolCallId, params) => toolResult(await options.runtime.prune({
      expectedRevision: params.expected_revision,
      idempotencyKey: params.idempotency_key,
      nodeId: params.node_id,
      reason: params.reason,
      treeId: params.tree_id,
    })),
    label: "Prune Idea Tree branch",
    name: "tree_prune",
    parameters: pruneParameters,
  };

  const finishParameters = Type.Object({
    ...mutationFields,
  }, { additionalProperties: false });
  const treeFinish: AgentTool<typeof finishParameters> = {
    description: "Finish the current search only when the Leader decides no more exploration is useful. Requires no running leaf or pending propagation, then marks every non-leaf node done without changing leaf outcomes, insights, scores, or Artifacts.",
    execute: async (_toolCallId, params) => toolResult(await options.runtime.finish({
      expectedRevision: params.expected_revision,
      idempotencyKey: params.idempotency_key,
      treeId: params.tree_id,
    })),
    label: "Finish Idea Tree",
    name: "tree_finish",
    parameters: finishParameters,
  };

  const checkParameters = Type.Object({ tree_id: optionalTreeId });
  const treeCheck: AgentTool<typeof checkParameters> = {
    description: "Audit tree, execution, propagation, verified-result, and Session-wide claim invariants without accepting Agent-authored repairs.",
    execute: async (_toolCallId, params) => toolResult(await options.runtime.check(params.tree_id)),
    label: "Check Idea Tree integrity",
    name: "tree_check",
    parameters: checkParameters,
  };

  return [
    treeCreate,
    treeList,
    treeView,
    treeAttachContext,
    treeAddNode,
    treeUpdateNode,
    treeSetMeta,
    treeSelect,
    treeClaim,
    treeCheckpoint,
    treeComplete,
    treeFail,
    treeRetry,
    treePrune,
    treeFinish,
    treeCheck,
  ];
}
