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
  | { type: "file_change"; toolCallId: string; details: unknown }
  | { type: "need_input"; runtime: "codex" }
  | { type: "done"; result: SpecialistResult };
export type SpecialistEventSink = (event: SpecialistRuntimeEvent) => Promise<void>;
export interface SpecialistRuntimeRequest {
  prompt: string;
  model?: string;
  signal: AbortSignal;
  maxTurns: number;
  tools: AgentTool[];
  /** Secret acquisition stays outside prompts and metadata. */
  credential(): Promise<string>;
}
export interface SpecialistRuntimeAdapter {
  invoke(request: SpecialistRuntimeRequest, sink: SpecialistEventSink): Promise<SpecialistResult>;
}
