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
  AgentHistoryMessage,
  AgentProfile,
  AgentRunInput,
  AgentRunResult,
} from "@sciencediscovery/orchestration";
import type { ContextContributorFactory } from "@sciencediscovery/context";
import type { WorkspaceAgentOptions } from "@sciencediscovery/workspace";
import type { PlanStore } from "@sciencediscovery/plan";

import { createJiuwenSwarmAgentFactory, jiuwenSwarmConfigFromEnv } from "./jiuwenswarm-agent.js";
import {
  createNativeAgent,
  type NativeAgentHandle,
  type NativeAgentOptions,
} from "../native-agent/index.js";

export interface AgentRunBindings {
  pluginSettings?: import("@sciencediscovery/plugin-sdk").PluginSettingsMap;
  disabledPlugins?: readonly string[];
  abortSignal?: AbortSignal;
  createAgent?: (options: NativeAgentOptions) => NativeAgentHandle;
  contextContributorFactories?: readonly ContextContributorFactory<AgentHistoryMessage>[];
  observer?: (event: AgentEvent) => void;
  recordEvent?: (event: import("@sciencediscovery/schema").RunStreamEvent) => Promise<void>;
  planStore?: PlanStore;
  runIdleTimeoutMs?: number;
  readVersioningAuthorities?: () => Promise<unknown>;
  suspendAfterTurn?: () => boolean | Promise<boolean>;
  workspace: WorkspaceAgentOptions;
}

export interface AgentRunHandle {
  abort(): void;
  beginExternalWait(): () => void;
  execute(): Promise<AgentRunResult>;
  /** The turn bound the executor actually enforced, when it can name one. A
   *  native loop reports its composed bound; an external runtime cannot, so the
   *  caller keeps the configured value there (#1113 review). */
  readonly enforcedMaxModelTurns?: number;
}

/** The native loop, unless the deployment selected the JiuwenSwarm executor. */
function defaultAgentFactory(): (options: NativeAgentOptions) => NativeAgentHandle {
  const jiuwenswarm = jiuwenSwarmConfigFromEnv();
  return jiuwenswarm ? createJiuwenSwarmAgentFactory(jiuwenswarm) : createNativeAgent;
}

export function createAgentRun(
  profile: AgentProfile,
  bindings: AgentRunBindings,
  input: AgentRunInput,
): AgentRunHandle {
  const gatewayHistory = structuredClone(input.history);
  const agent = (bindings.createAgent ?? defaultAgentFactory())({
    ...bindings.workspace,
    ...(bindings.pluginSettings ? { pluginSettings: structuredClone(bindings.pluginSettings) } : {}),
    ...(bindings.disabledPlugins ? { disabledPlugins: bindings.disabledPlugins } : {}),
    versioning: {
      agentId: `${profile.kind}:${profile.gatewayThreadId}`,
      trajectoryId: input.agentRunId,
      requestExecutionId: input.requestExecutionId,
      ...(bindings.recordEvent ? { recordEvent: bindings.recordEvent } : {}),
      readAuthorities: async () => ({
        plan: await bindings.planStore?.latest() ?? null,
        resources: profile.resources,
        toolPolicy: profile.toolPolicy,
        budget: profile.budget,
        external: await bindings.readVersioningAuthorities?.() ?? null,
      }),
    },
    ...(bindings.planStore ? { planStore: bindings.planStore } : {}),
    ...(bindings.contextContributorFactories?.length
      ? { contextContributorFactories: bindings.contextContributorFactories }
      : {}),
    contextScope: profile.resources.presetId?.startsWith("reviewer-specialist-")
      ? "reviewer"
      : profile.kind,
    enabledConnectorIds: profile.resources.connectorIds as WorkspaceAgentOptions["enabledConnectorIds"],
    gatewayHistory,
    ...(bindings.runIdleTimeoutMs !== undefined
      ? { runIdleTimeoutMs: bindings.runIdleTimeoutMs }
      : {}),
    // The child's declared budget now reaches the loop; the engine clamps it to
    // its own ceiling and reports the effective bound (#1106).
    maxModelTurns: profile.budget.maxModelTurns,
    runTimeoutMs: profile.budget.runTimeoutMs,
    ...(input.runContract ? { runContract: input.runContract } : {}),
    ...(bindings.suspendAfterTurn ? { suspendAfterTurn: bindings.suspendAfterTurn } : {}),
    sessionId: profile.gatewayThreadId,
    toolPolicy: {
      ...(profile.toolPolicy.allowedToolNames
        ? { allowed: profile.toolPolicy.allowedToolNames }
        : {}),
      disallowed: profile.toolPolicy.deniedToolNames,
    },
    workspaceRoot: profile.workspaceRoot,
  });
  // Both backends report one `model_usage` per model turn and then one
  // whole-loop `usage` summary. A run observer sums every `model_usage` it
  // receives, so forwarding that summary as another `model_usage` counted each
  // turn twice (#1109). Forward it only when the backend reported no per-turn
  // figure at all, which keeps such a backend's total and nothing more.
  let sawTurnUsage = false;
  const unsubscribe = bindings.observer ? agent.subscribe((event) => {
    if (event.type === "model_usage") sawTurnUsage = true;
    if (event.type === "usage" && !sawTurnUsage) {
      bindings.observer!({ ...event, type: "model_usage", usageReported: true });
    }
    bindings.observer!(event);
  }) : () => undefined;
  const abort = () => agent.abort();
  bindings.abortSignal?.addEventListener("abort", abort, { once: true });
  if (bindings.abortSignal?.aborted) abort();
  let executed = false;

  return {
    abort,
    beginExternalWait: () => agent.beginExternalWait(),
    // Read the bound from the executor every time instead of snapshotting it
    // here: a specialist whose external runtime reports itself unavailable only
    // builds its native fallback inside `execute()`, so a value captured at this
    // point would be missing for exactly the path that enforces the ceiling
    // (#1113 review).
    get enforcedMaxModelTurns() {
      return (agent as NativeAgentHandle).enforcedMaxModelTurns;
    },
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
          ...(result.suspended ? { suspended: true } : {}),
        };
      } finally {
        bindings.abortSignal?.removeEventListener("abort", abort);
        unsubscribe();
      }
    },
  };
}
