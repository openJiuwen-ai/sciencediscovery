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

export const IDEA_TREE_RESULT_CONTRACT = "leaf-workflow-result/v1" as const;

export const IDEA_TREE_PHASES = [
  "preflight_research",
  "building_tree",
  "executing_leaf",
  "aggregating_score",
  "propagating_insight",
] as const;
export type IdeaTreePhase = typeof IDEA_TREE_PHASES[number];

export const IDEA_TREE_NODE_STATUSES = ["pending", "running", "done", "needs_retry", "failed"] as const;
export type IdeaTreeNodeStatus = typeof IDEA_TREE_NODE_STATUSES[number];

/** Search eligibility is independent from whether a leaf produced a valid result. */
export const IDEA_TREE_SEARCH_STATUSES = ["active", "pruned"] as const;
export type IdeaTreeSearchStatus = typeof IDEA_TREE_SEARCH_STATUSES[number];

export const IDEA_TREE_EXECUTION_STATUSES = [
  "running",
  "done",
  "retryable_failure",
  "permanent_failure",
] as const;
export type IdeaTreeExecutionStatus = typeof IDEA_TREE_EXECUTION_STATUSES[number];

export interface IdeaTreeSkillRef {
  hash: string;
  id: string;
  revision: number;
  version: string;
}

export interface IdeaTreeScoreSpec {
  direction: "maximize" | "minimize";
  maximum: number;
  minimum: number;
  name: string;
  rubricVersion: string;
}

/** One opaque role declared by the selected Workflow Skill. */
export interface IdeaTreeWorkflowRoleSnapshot {
  role: string;
  specialistConfigHash: string;
  specialistId: string;
  specialistUpdatedAt: string;
}

export interface IdeaTreeResultAuthorityRef {
  key: string;
  version: string;
}

/** Frozen Workflow Skill executor for the lifetime of one tree. */
export interface IdeaTreeExecutorDescriptor {
  fingerprint: string;
  key: string;
  kind: "workflow_skill";
  /** Legacy role bindings are retained for persisted v4 trees; v5 orchestration lives in workflow.md. */
  leafRoles: IdeaTreeWorkflowRoleSnapshot[];
  /** Deprecated v5 snapshot field; Runtime no longer requires a preflight stage. */
  preflightRequired?: boolean;
  /** Legacy role bindings are retained for persisted v4 trees; v5 accepts verified workflow artifacts dynamically. */
  preflightRoles: IdeaTreeWorkflowRoleSnapshot[];
  resultAuthority: IdeaTreeResultAuthorityRef;
  resultContract: typeof IDEA_TREE_RESULT_CONTRACT;
  scoreSpec: IdeaTreeScoreSpec;
  version: string;
  workflowSkill: IdeaTreeSkillRef;
}

/** Immutable Artifact provenance used by context and reusable checkpoints. */
export interface IdeaTreeArtifactVersionSnapshot {
  artifactId: string;
  contentHash: string;
  producerExecutionId: string;
  producerSpecialistConfigHash: string;
  producerSpecialistId: string;
  role: string;
  versionId: string;
}

export interface IdeaTreeContext {
  artifactVersions: IdeaTreeArtifactVersionSnapshot[];
  completedAt: string | null;
  contextDigest: string | null;
  preflightStatus: "complete" | "running";
}

export interface IdeaTreeNode {
  subagentIds?: string[];
  activeExecutionId: string | null;
  artifactRefs: string[];
  attemptCount: number;
  childrenIds: string[];
  completedResultHandle: string | null;
  createdAt: string;
  depth: number;
  hypothesis: string;
  id: string;
  insight: string | null;
  lastExecutionId: string | null;
  parentId: string | null;
  priority: number;
  pruneReason: string | null;
  result: string | null;
  score: number | null;
  searchStatus: IdeaTreeSearchStatus;
  status: IdeaTreeNodeStatus;
  updatedAt: string;
}

export interface IdeaTreeCheckpoint {
  artifactRefs: string[];
  artifactVersions: IdeaTreeArtifactVersionSnapshot[];
  attempt: number;
  createdAt: string;
  inputDigest: string;
  payloadHash: string;
  stepKey: string;
}

export interface IdeaTreeExecution {
  artifactRefs: string[];
  attempt: number;
  checkpoints: IdeaTreeCheckpoint[];
  createdAt: string;
  executionId: string;
  failure?: { message: string; reasonCode: string };
  finishedAt: string | null;
  heartbeatAt: string;
  leaseExpiresAt: string;
  nodeId: string;
  ownerRunId: string;
  requestContext: {
    ancestorInsights: string[];
    constraints: string[];
    contextArtifactVersions: IdeaTreeArtifactVersionSnapshot[];
    contextDigest: string;
    hypothesis: string;
    objective: string;
  };
  requestHash: string;
  result?: { artifactRefs: string[]; insight: string; resultHandle: string; score: number };
  status: IdeaTreeExecutionStatus;
  updatedAt: string;
}

export interface IdeaTreeVerifiedResult {
  artifactRefs: string[];
  attempt: number;
  authority: { key: string; requestId: string; version: string };
  consumedAt: string | null;
  executionId: string;
  executorFingerprint: string;
  handle: string;
  insight: string;
  issuedAt: string;
  nodeId: string;
  requestHash: string;
  resultDigest: string;
  score: {
    /** Optional evidence Artifact supporting the score; workflows may finish without one. */
    artifactRef: string | null;
    direction: "maximize" | "minimize";
    name: string;
    rubricVersion: string;
    value: number;
  };
  treeId: string;
}

export interface IdeaTreePropagationEntry {
  childDigest: string;
  completedAt: string | null;
  createdAt: string;
  nodeId: string;
  sourceRevision: number;
  status: "complete" | "pending";
  triggeredByExecutionId: string;
}

export interface IdeaTreePropagationState {
  entries: Record<string, IdeaTreePropagationEntry>;
  /** Bottom-up queue; index 0 is the only node currently eligible to update. */
  pendingNodeIds: string[];
}

export interface IdeaTreeIdempotencyRecord {
  operation: string;
  requestHash: string;
  response: unknown;
}

export interface IdeaTreeState {
  context: IdeaTreeContext;
  createdAt: string;
  executor: IdeaTreeExecutorDescriptor;
  maxDepth: number;
  maxNodes: number;
  maxSearchRounds: number;
  meta: Record<string, boolean | number | string | null>;
  nodes: Record<string, IdeaTreeNode>;
  objective: string;
  propagation: IdeaTreePropagationState;
  revision: number;
  rootId: "ROOT";
  searchRound: number;
  treeId: string;
  updatedAt: string;
  version: 1;
  finished: boolean;
  settings: import("./runtime-settings.js").IdeaTreeSettings;
}

/** Database-neutral read model consumed by the Idea Tree frontend. */
export interface IdeaTreeGraphEdge {
  ordinal: number;
  source: string;
  target: string;
  type: "child";
}

/** Full IdeaTreeNode fields are preserved for direct node inspection. */
export interface IdeaTreeGraph {
  edges: IdeaTreeGraphEdge[];
  nodes: IdeaTreeNode[];
  objective: string;
  revision: number;
  treeId: string;
  updatedAt: string;
}

export interface IdeaTreeLeafExecutionRequest {
  ancestorInsights: string[];
  attempt: number;
  checkpoints: IdeaTreeCheckpoint[];
  constraints: string[];
  contextArtifactVersions: IdeaTreeArtifactVersionSnapshot[];
  contextDigest: string;
  executionId: string;
  executor: IdeaTreeExecutorDescriptor;
  hypothesis: string;
  nodeId: string;
  objective: string;
  requestHash: string;
  treeId: string;
}

/** Idea Tree fields frozen with every queued Session Run. */
export interface IdeaTreeRunSettingsSnapshot {
  ideaTreeSettings?: import("./runtime-settings.js").IdeaTreeSettings;
  ideaTreeExecutor?: IdeaTreeExecutorDescriptor;
  /** Whether idea-tree was triggered for this Run (via /idea-tree command). */
  ideaTreeEnabled?: boolean;
}

/** Autonomous Python research. These statuses are independent of chat runs. */
export interface IdeaResearchSettings {
  maxRounds: number;
  candidatesPerRound: number;
  maxSearchRounds: number;
  maxNodes: number;
  maxDepth: number;
  maxTokens?: number | null;
  maxTokensPerCall: number;
}
export interface IdeaResearchState {
  id: string;
  status: "running" | "pausing" | "paused" | "interrupted" | "completed" | "ended";
  objective: string;
  phase: string;
  round: number;
  batch: string[];
  batchCompleted: number;
  tokens: number;
  usageKnown: boolean;
  reason: string | null;
  modelId: string;
  currentNodeId: string | null;
  settings: IdeaResearchSettings;
}
export interface IdeaResearchView { research: IdeaResearchState; graph: IdeaTreeGraph }
