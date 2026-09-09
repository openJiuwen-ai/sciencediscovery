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
  IdeaTreeArtifactVersionSnapshot, IdeaTreeCheckpoint, IdeaTreeExecution,
  IdeaTreeExecutorDescriptor, IdeaTreeLeafExecutionRequest, IdeaTreeNode,
  IdeaTreeState, IdeaTreeVerifiedResult, IdeaTreeSettings,
} from "@sciencediscovery/schema";
import { ideaTreeExecutorFingerprintPayload } from "./contract.js";
import type { IdeaTreePersistence } from "./persistence.js";

type MetaValue = boolean | number | string | null;
export class IdeaTreeRuntimeError extends Error {
  readonly invocation;
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "IdeaTreeRuntimeError";
    this.invocation = { error: { code, retryable: ["TREE_BUSY", "REVISION_CONFLICT", "PERSISTENCE_UNAVAILABLE"].includes(code) } };
  }
}
export interface IdeaTreeRuntimeOptions {
  runId?: string;
  expectedExecutorFingerprint?: string;
  settings?: IdeaTreeSettings;
  validateArtifactRef?: (artifactRef: string) => boolean | Promise<boolean>;
}
export interface CreateIdeaTreeInput {
  executor: IdeaTreeExecutorDescriptor;
  idempotencyKey: string;
  maxDepth: number;
  maxNodes: number;
  maxSearchRounds: number;
  objective: string;
  rootHypothesis: string;
}

export interface RevisionMutationInput {
  expectedRevision: number;
  idempotencyKey: string;
  treeId: string;
}

export interface IssueVerifiedResultInput {
  artifactRefs: string[];
  attempt: number;
  authority: {
    key: string;
    requestId: string;
    version: string;
  };
  executionId: string;
  insight: string;
  requestHash: string;
  scoreArtifactRef?: string;
  scoreValue: number;
  treeId: string;
}


function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => [k,stable(v)]));
  return value;
}
export function createExecutorDescriptor(input: Omit<IdeaTreeExecutorDescriptor, "fingerprint">): IdeaTreeExecutorDescriptor {
  const { fingerprint: _previous, ...descriptor } = input as IdeaTreeExecutorDescriptor;
  return { ...structuredClone(descriptor), fingerprint: `sha256:${createHash("sha256").update(JSON.stringify(stable(ideaTreeExecutorFingerprintPayload(descriptor)))).digest("hex")}` };
}

/** Agent-facing transport only. Every tree transition executes in Python. */
export class IdeaTreeRuntime {
  constructor(readonly persistence: IdeaTreePersistence, private readonly options: IdeaTreeRuntimeOptions = {}) {}

  private async call<T>(operation: string, params: object): Promise<T> {
    if (operation === "issueVerifiedResult" && this.options.validateArtifactRef) {
      for (const ref of (params as IssueVerifiedResultInput).artifactRefs) {
        if (!await this.options.validateArtifactRef(ref)) throw new IdeaTreeRuntimeError("RESULT_ARTIFACT_INVALID", `Unknown Artifact: ${ref}`);
      }
    }
    const { validateArtifactRef: _validate, ...context } = this.options;
    return this.persistence.call<T>(operation, params, context);
  }

  async recordSubagent(subagentId: string): Promise<void> {
    return this.call("recordSubagent", { subagentId });
  }

  async resumeSettings(workflowSkillId: string): Promise<IdeaTreeSettings | null> {
    return this.call("resumeSettings", { workflowSkillId });
  }
  async recover(): Promise<{ recoveredExecutions: number; trees: number }> {
    return this.call("recover", {});
  }

  async list(): Promise<{
    currentTreeId: string | null;
    trees: Array<{
      executorKey: string;
      preflightStatus: IdeaTreeState["context"]["preflightStatus"];
      nodes: number;
      objective: string;
      pendingPropagationNodeId: string | null;
      revision: number;
      runningNodeId: string | null;
      searchRound: number;
      treeId: string;
      updatedAt: string;
    }>;
  }> {
    return this.call("list", {});
  }

  async activeExecution(): Promise<{
    executionId: string;
    executor: IdeaTreeExecutorDescriptor;
    nodeId: string;
    ownerRunId: string;
    treeId: string;
  } | null> {
    return this.call("activeExecution", {});
  }

  async activeExecutor(): Promise<IdeaTreeExecutorDescriptor | null> {
    return this.call("activeExecutor", {});
  }

  async renewOwnedExecutionLease(): Promise<boolean> {
    return this.call("renewOwnedExecutionLease", {});
  }

  async abandonOwnedExecution(reason: {
    message: string;
    reasonCode: string;
  }): Promise<boolean> {
    return this.call("abandonOwnedExecution", reason);
  }

  async resumeExecutor(workflowSkillId: string): Promise<IdeaTreeExecutorDescriptor | null> {
    return this.call("resumeExecutor", { workflowSkillId });
  }

  async create(input: CreateIdeaTreeInput): Promise<{ revision: number; root: IdeaTreeNode; treeId: string }> {
    return this.call("create", input);
  }

  async attachContext(input: RevisionMutationInput & {
    artifactVersions: IdeaTreeArtifactVersionSnapshot[];
  }): Promise<{
    context: IdeaTreeState["context"];
    revision: number;
    treeId: string;
  }> {
    return this.call("attachContext", input);
  }

  async view(
    treeId: string | undefined,
    format: "compact" | "constraints" | "full" | "node" | "pending" = "compact",
    nodeId?: string,
  ): Promise<unknown> {
    return this.call("view", { treeId, format, nodeId });
  }

  async addNode(input: RevisionMutationInput & {
    hypothesis: string;
    parentId: string;
    priority?: number;
  }): Promise<{ node: IdeaTreeNode; revision: number; treeId: string }> {
    return this.call("addNode", input);
  }

  async updateNode(input: RevisionMutationInput & {
    hypothesis?: string;
    insight?: string;
    nodeId: string;
    priority?: number;
    propagationChildDigest?: string;
  }): Promise<{
    node: IdeaTreeNode;
    pendingPropagationNodeId: string | null;
    revision: number;
    treeId: string;
  }> {
    return this.call("updateNode", input);
  }

  async setMeta(input: RevisionMutationInput & { patch: Record<string, MetaValue> }): Promise<{
    meta: Record<string, MetaValue>;
    revision: number;
    treeId: string;
  }> {
    return this.call("setMeta", input);
  }

  async select(treeId: string | undefined, strategy: "fifo" | "highest_priority" = "highest_priority"): Promise<{
    candidates: IdeaTreeNode[];
    pendingPropagationNodeId: string | null;
    revision: number;
    selected: IdeaTreeNode | null;
    treeId: string;
  }> {
    return this.call("select", { treeId, strategy });
  }

  async claim(input: RevisionMutationInput & { nodeId: string }): Promise<{
    request: IdeaTreeLeafExecutionRequest;
    revision: number;
    treeId: string;
  }> {
    return this.call("claim", input);
  }

  async checkpoint(input: RevisionMutationInput & {
    artifactVersions: IdeaTreeArtifactVersionSnapshot[];
    attempt: number;
    executionId: string;
    inputDigest: string;
    requestHash: string;
    stepKey: string;
  }): Promise<{ checkpoint: IdeaTreeCheckpoint; revision: number; treeId: string }> {
    return this.call("checkpoint", input);
  }

  async issueVerifiedResult(input: IssueVerifiedResultInput): Promise<IdeaTreeVerifiedResult> {
    return this.call("issueVerifiedResult", input);
  }

  async complete(input: RevisionMutationInput & {
    resultHandle: string;
  }): Promise<{
    node: IdeaTreeNode;
    pendingPropagationNodeId: string | null;
    revision: number;
    treeId: string;
  }> {
    return this.call("complete", input);
  }

  async fail(input: RevisionMutationInput & {
    artifactRefs?: string[];
    attempt: number;
    executionId: string;
    message: string;
    reasonCode: string;
    requestHash: string;
    retryable: boolean;
  }): Promise<{ node: IdeaTreeNode; revision: number; treeId: string }> {
    return this.call("fail", input);
  }

  async retry(input: RevisionMutationInput & { force?: boolean; nodeId: string }): Promise<{
    node: IdeaTreeNode;
    revision: number;
    treeId: string;
  }> {
    return this.call("retry", input);
  }

  async prune(input: RevisionMutationInput & { nodeId: string; reason: string }): Promise<{
    pendingPropagationNodeId: string | null;
    prunedNodeIds: string[];
    revision: number;
    treeId: string;
  }> {
    return this.call("prune", input);
  }

  async finish(input: RevisionMutationInput): Promise<{
    completedNodeIds: string[];
    revision: number;
    treeId: string;
  }> {
    return this.call("finish", input);
  }

  async check(treeId?: string): Promise<{
    errors: string[];
    ok: boolean;
    revision: number;
    treeId: string;
  }> {
    return this.call("check", { treeId });
  }
}
