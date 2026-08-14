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

import { randomUUID } from "node:crypto";

import type {
  AgentHistoryMessage,
  AgentRunPurpose,
  AgentRunResult,
  MainAgentProfile,
  SubagentProfile,
} from "@science-agent/agent-runtime";

import {
  createAgentRun,
  type AgentRunBindings,
  type AgentRunHandle,
} from "./create-agent-run.js";

export interface RequestExecutionRunInput {
  history: AgentHistoryMessage[];
  prompt: string;
  purpose: AgentRunPurpose;
}

export interface MainRequestExecutionScope {
  beginExternalWait(): () => void;
  executeAgentRun(input: RequestExecutionRunInput): Promise<AgentRunResult>;
}

export function runMainRequestExecution(options: {
  bindings: AgentRunBindings;
  profile: MainAgentProfile;
  requestExecutionId: string;
}): MainRequestExecutionScope {
  let activeRun: AgentRunHandle | undefined;
  let originalUserPrompt: string | undefined;
  return {
    beginExternalWait() {
      if (!activeRun) throw new Error("No AgentRun is active");
      return activeRun.beginExternalWait();
    },
    async executeAgentRun(input) {
      if (activeRun) throw new Error("An AgentRun is already active");
      if (input.purpose === "initial" && originalUserPrompt === undefined) {
        originalUserPrompt = input.prompt;
      }
      activeRun = createAgentRun(options.profile, options.bindings, {
        ...input,
        agentRunId: randomUUID(),
        requestExecutionId: options.requestExecutionId,
        ...(originalUserPrompt ? { runContract: originalUserPrompt } : {}),
      });
      try {
        return await activeRun.execute();
      } finally {
        activeRun = undefined;
      }
    },
  };
}

export function runSubagentTask(options: {
  bindings: AgentRunBindings;
  history?: AgentHistoryMessage[];
  profile: SubagentProfile;
  prompt: string;
  requestExecutionId: string;
  runContract?: string;
}): AgentRunHandle {
  return createAgentRun(options.profile, options.bindings, {
    agentRunId: randomUUID(),
    history: options.history ?? [],
    prompt: options.prompt,
    purpose: "subagent_task",
    requestExecutionId: options.requestExecutionId,
    ...(options.runContract ? { runContract: options.runContract } : {}),
  });
}
