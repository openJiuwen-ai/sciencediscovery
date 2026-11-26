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
  /** Present for autonomous research; absent on legacy trees. */
  kind?: "direction" | "candidate";
  stages?: Record<string, { text: string; score?: number }>;
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
  /** A serialisation of `stages`, for direct node inspection. A live frame omits
   *  it (see `IdeaTreeFrameNode`), so a view built from a stream has none until an
   *  explicit `get` answer replaces it. */
  result?: string | null;
  score: number | null;
  searchStatus: IdeaTreeSearchStatus;
  status: IdeaTreeNodeStatus;
  /** The direction a `maxDepth` trim removed; absent when every step fit. */
  trimmedDirection?: string;
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
  maxActiveDirections: number;
  pruneMinAssessments: number;
  pruneScoreGap: number;
  maxTokens?: number | null;
}
export interface IdeaResearchActivity {
  role: string;
  nodeId: string | null;
  round: number;
  status: "running" | "completed" | "stopped" | "failed";
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}
export interface IdeaResearchTemplate {
  id: string;
  label: string;
  assessors: Array<{ id: string; label: string }>;
}
export interface IdeaResearchState {
  activities?: IdeaResearchActivity[];
  id: string;
  status: "running" | "pausing" | "paused" | "interrupted" | "completed" | "ended" | "budget_exhausted";
  objective: string;
  phase: string;
  round: number;
  batch: string[];
  batchCompleted: number;
  tokens: number;
  usageKnown: boolean;
  /** Conservative admission reserve for unreported calls, never billed usage. */
  unreportedBudgetEstimate?: number;
  reason: string | null;
  modelId: string;
  currentNodeId: string | null;
  settings: IdeaResearchSettings;
  /** Frozen template metadata for rendering the assessment stages of this research. */
  template?: IdeaResearchTemplate;
}
export interface IdeaResearchView { research: IdeaResearchState; graph: IdeaTreeGraph }

/**
 * The graph part of one live frame of a research's SSE stream.
 *
 * A frame is not a whole view. `nodes` and `edges` are the changes since the
 * revision the frame was computed from (`since`), and `full` marks the frames
 * that carry the whole tree: the first frame of a stream, which is what a fresh
 * connection and a reconnect both start from. `since` is absent on a full frame.
 *
 * The nodes are also lean: `result` (a serialisation of `stages`) and
 * `insightRecords` (the engine's learning log) are left out because the tree
 * view never draws them. They are the two fields that grow with the research
 * rather than with what changed, and they stay available on an explicit `get`.
 */
/**
 * A node as a live frame carries it: the full node without `result`.
 *
 * The tree the panel draws needs the hypothesis, the status, the score and the
 * stages; `result` duplicates the stages as JSON and is the field that grows with
 * the research, so it is only on an explicit `get` answer.
 */
export type IdeaTreeFrameNode = Omit<IdeaTreeNode, "result">

export interface IdeaTreeGraphFrame {
  edges: IdeaTreeGraphEdge[];
  full: boolean;
  nodes: IdeaTreeFrameNode[];
  objective: string;
  /** Ids the tree no longer holds, so a merged view can drop them. */
  removed: string[];
  revision: number;
  since?: number;
  treeId: string;
  updatedAt: string;
}

/** One SSE frame of a live research: the whole state, and only the graph changes. */
export interface IdeaResearchFrame {
  research: IdeaResearchState;
  graph: IdeaTreeGraphFrame;
}

function edgeKey(edge: IdeaTreeGraphEdge): string {
  return `${edge.source}->${edge.target}`;
}

/**
 * Fold one frame into the view a consumer already holds.
 *
 * Returns `undefined` when the frame cannot be applied: a delta whose `since`
 * is newer than the held revision means frames were lost (a dropped or torn
 * frame), and the only honest recovery is a whole view. A consumer that gets
 * `undefined` refetches the research with `get` and keeps merging the same
 * stream: the frames that follow carry whole nodes, not patches, so a base at
 * a revision at least as new as `since` is enough.
 *
 * A frame older than what the caller already holds is ignored rather than
 * applied: a whole read (see `reconcileIdeaResearchFrame`) and a reconnect can
 * leave the held view ahead of frames still queued behind the gap, and one of
 * those must not roll a finished research back to `running` or re-apply its old
 * nodes. `previous` is returned unchanged, not `undefined`, because refetching
 * would only fetch the same newer state again.
 *
 * `result` and `insightRecords` do not come back through a frame; a node a
 * frame replaces loses them, which is why they are only read from an explicit
 * `get` response.
 */
export function applyIdeaResearchFrame(
  previous: IdeaResearchView | undefined,
  frame: IdeaResearchFrame,
): IdeaResearchView | undefined {
  const graph = frame.graph;
  const base = previous !== undefined && previous.graph.treeId === graph.treeId ? previous.graph : undefined;
  // A frame from before the held revision describes a state the caller has
  // already moved past. Full frames are no exception: an older stream's whole
  // tree is just as stale as an older delta.
  if (base !== undefined && graph.revision < base.revision) return previous;
  if (!graph.full) {
    if (base === undefined) return undefined;
    if (graph.since !== undefined && base.revision < graph.since) return undefined;
  }
  const nodes = new Map<string, IdeaTreeNode>();
  const edges = new Map<string, IdeaTreeGraphEdge>();
  if (!graph.full && base !== undefined) {
    for (const node of base.nodes) nodes.set(node.id, node);
    for (const edge of base.edges) edges.set(edgeKey(edge), edge);
  }
  // A frame's node replaces the whole node, so the `result` a previous `get`
  // answer carried goes with it: frames are what the panel renders from, and a
  // half-merged node would claim a `result` that no longer matches its stages.
  for (const node of graph.nodes) nodes.set(node.id, node);
  // An engine older than this frame shape answers with whole views and no
  // `removed`: merging them is still correct, because such a frame's nodes are the
  // whole tree and an engine that never removes a node has nothing to drop.
  for (const id of graph.removed ?? []) nodes.delete(id);
  for (const edge of graph.edges) edges.set(edgeKey(edge), edge);
  // An edge to a node the merged tree does not hold describes nothing.
  for (const edge of [...edges.values()]) if (!nodes.has(edge.target) || !nodes.has(edge.source)) edges.delete(edgeKey(edge));
  return {
    research: frame.research,
    graph: {
      edges: [...edges.values()],
      nodes: [...nodes.values()],
      objective: graph.objective,
      revision: graph.revision,
      treeId: graph.treeId,
      updatedAt: graph.updatedAt,
    },
  };
}

/**
 * The view to keep after a whole read was made to fill a lost-frame gap.
 *
 * Refetching answers the gap, but the frame that exposed it is older than the
 * answer: a research that paused at revision 7 while that frame still says
 * `running` at revision 5 must not be shown as running again, and its nodes must
 * not overwrite the newer ones the read just returned. So a read at least as new
 * as the frame wins outright; only a read older than the frame is merged with it.
 * The returned revision is never older than the read, so the frames that follow
 * are still applied rather than refetching on every one.
 *
 * `undefined` means neither could be used: different trees, or a frame from the
 * future. The caller steps over that frame.
 */
export function reconcileIdeaResearchFrame(
  restored: IdeaResearchView,
  frame: IdeaResearchFrame,
): IdeaResearchView | undefined {
  if (restored.graph.treeId === frame.graph.treeId && restored.graph.revision >= frame.graph.revision) return restored;
  return applyIdeaResearchFrame(restored, frame);
}
