// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { ModelUsage } from "@sciencediscovery/model";
import type { SubagentUsage } from "@sciencediscovery/schema";
import type { AgentToolResult } from "@sciencediscovery/tools";

export type AssistantMessageEvent =
  | { delta: string; type: "text_delta" }
  | { delta: string; type: "thinking_delta" };

export type AgentEvent =
  | { type: "turn_start" }
  | { assistantMessageEvent: AssistantMessageEvent; type: "message_update" }
  | { type: "model_usage"; usage?: ModelUsage; usageReported: boolean }
  | { args: Record<string, unknown>; toolCallId: string; toolName: string; type: "tool_execution_start" }
  | { isError: boolean; result: AgentToolResult; toolCallId: string; toolName: string; type: "tool_execution_end" }
  | { type: "usage"; usage: SubagentUsage };

export interface Agent {
  abort(): void;
  beginExternalWait(): () => void;
  prompt(text: string): Promise<void>;
  subscribe(listener: (event: AgentEvent) => void): () => void;
}
