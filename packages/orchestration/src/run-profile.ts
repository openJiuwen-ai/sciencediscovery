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

import type { RuntimeMessage } from "@science-agent/runtime-core";

export type AgentKind = "main" | "subagent";
export type AgentRunPurpose = "initial" | "reviewer_correction" | "subagent_task";

export interface RequestExecutionIdentity {
  executionId: string;
  ownerSessionId: string;
  parentExecutionId?: string;
}

export type AgentHistoryPolicy =
  | { inputPolicy: "outer-session"; kind: "session" }
  | { inputPolicy: "orchestrator-only"; kind: "isolated" };

export interface AgentResourceRef {
  id: string;
  revision?: number;
  version?: string;
}

export interface AgentProfileResources {
  connectorIds: string[];
  presetId?: string;
  skills: AgentResourceRef[];
  specialistId?: string;
}

export interface AgentToolPolicy {
  allowedToolNames?: string[];
  deniedToolNames: string[];
}

export interface AgentRunBudget {
  maxModelTurns?: number;
  runTimeoutMs: number;
}

interface AgentBaseProfile {
  budget: AgentRunBudget;
  gatewayThreadId: string;
  historyPolicy: AgentHistoryPolicy;
  kind: AgentKind;
  resources: AgentProfileResources;
  toolPolicy: AgentToolPolicy;
  workspaceRoot: string;
}

export interface MainAgentProfile extends AgentBaseProfile {
  historyPolicy: { inputPolicy: "outer-session"; kind: "session" };
  kind: "main";
}

export interface SubagentProfile extends AgentBaseProfile {
  budget: AgentRunBudget & { maxModelTurns: number };
  historyPolicy: { inputPolicy: "orchestrator-only"; kind: "isolated" };
  kind: "subagent";
}

export type AgentProfile = MainAgentProfile | SubagentProfile;

/** Opaque gateway history. The Node API owns and passes this transcript between AgentRuns. */
export type AgentHistoryMessage = RuntimeMessage;

export interface AgentRunInput {
  agentRunId: string;
  history: AgentHistoryMessage[];
  prompt: string;
  purpose: AgentRunPurpose;
  requestExecutionId: string;
  /** Runtime-pinned request/task contract preserved outside compactable history. */
  runContract?: string;
}

export interface AgentRunResult {
  agentRunId: string;
  finalMessages: AgentHistoryMessage[];
  purpose: AgentRunPurpose;
  requestExecutionId: string;
}

export interface MainAgentProfileInput {
  connectorIds: readonly string[];
  gatewayThreadId: string;
  runTimeoutMs: number;
  skills?: readonly AgentResourceRef[];
  specialistId?: string;
  workspaceRoot: string;
}

export interface SubagentProfileInput {
  allowedToolNames?: readonly string[];
  connectorIds: readonly string[];
  deniedToolNames: readonly string[];
  gatewayThreadId: string;
  maxModelTurns: number;
  presetId: string;
  runTimeoutMs: number;
  skills?: readonly AgentResourceRef[];
  specialistId?: string;
  workspaceRoot: string;
}

export function createMainAgentProfile(input: MainAgentProfileInput): MainAgentProfile {
  return {
    budget: { runTimeoutMs: input.runTimeoutMs },
    gatewayThreadId: input.gatewayThreadId,
    historyPolicy: { inputPolicy: "outer-session", kind: "session" },
    kind: "main",
    resources: {
      connectorIds: [...input.connectorIds],
      skills: (input.skills ?? []).map((skill) => ({ ...skill })),
      ...(input.specialistId ? { specialistId: input.specialistId } : {}),
    },
    toolPolicy: { deniedToolNames: [] },
    workspaceRoot: input.workspaceRoot,
  };
}

export function createSubagentProfile(input: SubagentProfileInput): SubagentProfile {
  return {
    budget: {
      maxModelTurns: input.maxModelTurns,
      runTimeoutMs: input.runTimeoutMs,
    },
    gatewayThreadId: input.gatewayThreadId,
    historyPolicy: { inputPolicy: "orchestrator-only", kind: "isolated" },
    kind: "subagent",
    resources: {
      connectorIds: [...input.connectorIds],
      presetId: input.presetId,
      skills: (input.skills ?? []).map((skill) => ({ ...skill })),
      ...(input.specialistId ? { specialistId: input.specialistId } : {}),
    },
    toolPolicy: {
      ...(input.allowedToolNames ? { allowedToolNames: [...input.allowedToolNames] } : {}),
      deniedToolNames: [...input.deniedToolNames],
    },
    workspaceRoot: input.workspaceRoot,
  };
}
