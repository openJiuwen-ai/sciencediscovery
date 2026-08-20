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
  AgentEvent,
  AgentProfile,
  AgentRunInput,
  AgentRunResult,
} from "@science-agent/orchestration";
import type { WorkspaceAgentOptions } from "@science-agent/context";

import {
  createNativeAgent,
  type NativeAgentHandle,
  type NativeAgentOptions,
} from "../native-agent/index.js";

export interface AgentRunBindings {
  abortSignal?: AbortSignal;
  createAgent?: (options: NativeAgentOptions) => NativeAgentHandle;
  observer?: (event: AgentEvent) => void;
  runIdleTimeoutMs?: number;
  workspace: WorkspaceAgentOptions;
}

export interface AgentRunHandle {
  abort(): void;
  beginExternalWait(): () => void;
  execute(): Promise<AgentRunResult>;
}

export function createAgentRun(
  profile: AgentProfile,
  bindings: AgentRunBindings,
  input: AgentRunInput,
): AgentRunHandle {
  const gatewayHistory = structuredClone(input.history);
  const agent = (bindings.createAgent ?? createNativeAgent)({
    ...bindings.workspace,
    enabledConnectorIds: profile.resources.connectorIds as WorkspaceAgentOptions["enabledConnectorIds"],
    gatewayHistory,
    ...(bindings.runIdleTimeoutMs !== undefined
      ? { runIdleTimeoutMs: bindings.runIdleTimeoutMs }
      : {}),
    runTimeoutMs: profile.budget.runTimeoutMs,
    ...(input.runContract ? { runContract: input.runContract } : {}),
    sessionId: profile.gatewayThreadId,
    toolPolicy: {
      ...(profile.toolPolicy.allowedToolNames
        ? { allowed: profile.toolPolicy.allowedToolNames }
        : {}),
      disallowed: profile.toolPolicy.deniedToolNames,
    },
    workspaceRoot: profile.workspaceRoot,
  });
  const unsubscribe = bindings.observer ? agent.subscribe(bindings.observer) : () => undefined;
  const abort = () => agent.abort();
  bindings.abortSignal?.addEventListener("abort", abort, { once: true });
  if (bindings.abortSignal?.aborted) abort();
  let executed = false;

  return {
    abort,
    beginExternalWait: () => agent.beginExternalWait(),
    async execute() {
      if (executed) throw new Error(`AgentRun ${input.agentRunId} has already been executed`);
      executed = true;
      try {
        const result = await agent.execute(input.prompt);
        return {
          agentRunId: input.agentRunId,
          finalMessages: result.finalMessages,
          purpose: input.purpose,
          requestExecutionId: input.requestExecutionId,
        };
      } finally {
        bindings.abortSignal?.removeEventListener("abort", abort);
        unsubscribe();
      }
    },
  };
}
