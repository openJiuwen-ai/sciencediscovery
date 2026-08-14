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

import type { Static, TSchema } from "typebox";
import type { ResolvedProxy, SubagentUsage } from "@science-agent/schema";

/** Model endpoint settings for a run; sourced from the session's model profile. */
export interface AgentConfig {
  apiToken?: string;
  baseUrl: string;
  dataDir: string;
  model: string;
  /** Outbound proxy for the model endpoint, resolved from the profile's
   *  proxy policy against the global registry. */
  proxy?: ResolvedProxy;
}

export interface AgentToolResult {
  content: Array<{ text: string; type: "text" }>;
  details: unknown;
}

/**
 * A workspace tool: a TypeBox parameter schema plus the handler that runs with
 * the product's governance (permission gate, sandbox runner, provenance). The
 * schema serializes as plain JSON Schema for the agent-loop gateway.
 */
export interface AgentTool<S extends TSchema = TSchema> {
  deferred?: boolean;
  description: string;
  label: string;
  mcp?: {
    sourceId: string;
    toolId: string;
  };
  name: string;
  parameters: S;
  routing?: {
    keywords: string[];
    mode: "off" | "prefer";
    priority: number;
  };
  // Method syntax on purpose: keeps heterogeneous AgentTool[] assignable.
  execute(toolCallId: string, params: Static<S>, signal?: AbortSignal): Promise<AgentToolResult>;
}

export type AssistantMessageEvent =
  | { delta: string; type: "text_delta" }
  | { delta: string; type: "thinking_delta" };

export interface AgentModelUsage {
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Events an agent run emits; `streamAgentRun` translates them into the SSE contract. */
export type AgentEvent =
  | { type: "turn_start" }
  | { assistantMessageEvent: AssistantMessageEvent; type: "message_update" }
  | { type: "model_usage"; usage?: AgentModelUsage; usageReported: boolean }
  | { args: Record<string, unknown>; toolCallId: string; toolName: string; type: "tool_execution_start" }
  | { isError: boolean; result: AgentToolResult; toolCallId: string; toolName: string; type: "tool_execution_end" }
  | { type: "usage"; usage: SubagentUsage };

/** The agent surface the run handler drives. */
export interface Agent {
  abort(): void;
  /**
   * Pause the active-run deadline while a tool waits on an external decision
   * or transfer. The returned function releases one nested wait.
   */
  beginExternalWait(): () => void;
  prompt(text: string): Promise<void>;
  subscribe(listener: (event: AgentEvent) => void): () => void;
}
