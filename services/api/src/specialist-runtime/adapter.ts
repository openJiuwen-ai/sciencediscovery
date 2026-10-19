// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import type { AgentTool, AgentToolResult } from "@sciencediscovery/tools";
import type { SubagentUsage } from "@sciencediscovery/schema";

export interface SpecialistResult {
  summary: string;
  /** Only platform declare_artifact results, never unverified provider paths. */
  artifacts: unknown[];
  runtimeSessionId?: string;
  usage?: SubagentUsage;
}
export type SpecialistRuntimeEvent =
  | { type: "started"; runtimeSessionId?: string }
  | { type: "progress"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown>; result?: AgentToolResult }
  | { type: "fallback"; specialistId: "builtin-code-engineer" }
  | { type: "need_input"; runtime: "codex" | "claude-code" | "acp" }
  | { type: "failure"; reason: "unavailable" | "policy_or_task" | "cancelled" | "timeout" }
  | { type: "sandbox_probe"; ok: boolean; mode: "sandbox" | "direct" }
  | { type: "done"; result: SpecialistResult };
export type SpecialistEventSink = (event: SpecialistRuntimeEvent) => Promise<void>;
export interface SpecialistRuntimeRequest {
  prompt: string;
  model?: string;
  workspaceRoot?: string;
  execution?: "sandbox" | "direct";
  authorizeDirect?(): Promise<void>;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  signal: AbortSignal;
  maxTurns: number;
  tools: AgentTool[];
  /** Secret acquisition stays outside prompts and metadata. */
  credential(): Promise<string>;
}
export interface SpecialistRuntimeAdapter {
  invoke(request: SpecialistRuntimeRequest, sink: SpecialistEventSink): Promise<SpecialistResult>;
}
