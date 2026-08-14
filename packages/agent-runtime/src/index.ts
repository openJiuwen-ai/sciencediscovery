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

export {
  ENVIRONMENT_TOOL_NAMES,
  normalizeLegacyEnvironmentToolName,
} from "./environment-tool-names.js";
export {
  buildWorkspaceSystemPrompt,
  DEFAULT_MAX_CONCURRENT_SUBAGENTS,
  DEFAULT_MAX_TOTAL_SUBAGENTS,
  WORKSPACE_SYSTEM_PROMPT,
  WORKSPACE_SYSTEM_PROMPT_VERSION,
  type RuntimeSkill,
  type WorkspaceAgentOptions,
} from "./runtime.js";
export {
  DEFAULT_SUBAGENT_MAX_TURNS,
  DEFAULT_SUBAGENT_TIMEOUT_SECONDS,
  GENERAL_PURPOSE_SUBAGENT,
  listSubagentPresets,
  MAX_SUBAGENT_MAX_TURNS,
  MAX_SUBAGENT_TIMEOUT_SECONDS,
  resolveSubagentConfig,
  type ResolvedSubagentConfig,
  type SubagentPreset,
} from "./subagents.js";
export {
  createMainAgentProfile,
  createSubagentProfile,
  type AgentHistoryMessage,
  type AgentHistoryPolicy,
  type AgentKind,
  type AgentProfile,
  type AgentProfileResources,
  type AgentResourceRef,
  type AgentRunBudget,
  type AgentRunInput,
  type AgentRunPurpose,
  type AgentRunResult,
  type AgentToolPolicy,
  type MainAgentProfile,
  type MainAgentProfileInput,
  type RequestExecutionIdentity,
  type SubagentProfile,
  type SubagentProfileInput,
} from "./run-profile.js";
export type {
  Agent,
  AgentConfig,
  AgentEvent,
  AgentModelUsage,
  AgentTool,
  AgentToolResult,
  AssistantMessageEvent,
} from "./types.js";
export {
  createWorkspaceTools,
  filterTools,
  normalizeWorkspaceRelativePath,
  resolveWorkspaceFile,
  scanWorkspace,
  type ToolFilterPolicy,
  type WorkspaceFileInfo,
  type WorkspaceToolOptions,
} from "./workspace.js";
