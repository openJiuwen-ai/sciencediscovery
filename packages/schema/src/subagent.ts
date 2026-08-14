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

import type { ModelRunInfo } from "./model-usage.js";

export type JsonSchema = Record<string, unknown>;

export interface SubagentBrief {
  collaborationRules: string[];
  constraints: string[];
  goal: string;
  outputJsonSchema?: JsonSchema;
  outputRequirements: string[];
  version?: number;
}

export interface SubagentResultValidation {
  errors: string[];
  schema?: JsonSchema;
  status: "failed" | "passed" | "skipped";
  validatedAt: string;
}

export interface UpdateSubagentBriefRequest {
  brief: SubagentBrief;
}

export interface SubagentInput {
  brief?: SubagentBrief;
  description: string;
  inputPaths?: string[];
  maxTurns?: number;
  prompt: string;
  specialistId?: string;
  subagentType?: string;
  timeoutSeconds?: number;
  tools?: string[] | null;
}

export interface SubagentHandoff {
  inputPaths: string[];
  manifestPath: string;
  privateWorkspacePath: string;
  skippedInputPaths?: Array<{
    path: string;
    reason: string;
    size?: number;
  }>;
}

export interface SubagentUsage {
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface SubagentStep {
  content: string;
  createdAt: string;
  id: string;
  /** Raw tool input retained when a completed tool step replaces its running snapshot. */
  input?: string;
  kind: "assistant" | "system" | "thinking" | "tool";
  status?: "completed" | "failed" | "running";
  toolCallId?: string;
  toolName?: string;
}

export interface Subagent {
  createdAt: string;
  error?: string;
  finishedAt?: string;
  handoff?: SubagentHandoff;
  id: string;
  input: SubagentInput;
  maxTurns: number;
  model?: ModelRunInfo;
  parentTurnId: string;
  resultValidation?: SubagentResultValidation;
  rawStructuredResult?: string;
  structuredResult?: unknown;
  sessionId: string;
  specialistId?: string;
  status: "cancelled" | "completed" | "failed" | "running" | "timed_out";
  steps: SubagentStep[];
  timeoutSeconds: number;
  turnCount: number;
  usage?: SubagentUsage;
}
