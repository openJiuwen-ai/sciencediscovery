// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { Static, TSchema } from "typebox";

export interface AgentToolResult {
  /**
   * Set by tools that already bound their own model-facing output (pagination,
   * an explicit preview). The registry then leaves the formatting alone unless
   * the result still exceeds the hard bound.
   */
  bounded?: boolean;
  content: Array<{ text: string; type: "text" }>;
  details: unknown;
}

export interface AgentTool<S extends TSchema = TSchema> {
  deferred?: boolean;
  description: string;
  label: string;
  mcp?: { sourceId: string; toolId: string };
  name: string;
  parameters: S;
  routing?: { keywords: string[]; mode: "off" | "prefer"; priority: number };
  execute(toolCallId: string, params: Static<S>, signal?: AbortSignal): Promise<AgentToolResult>;
  /** Only an exact true permits overlap; omitted or throwing classifiers are exclusive. */
  isConcurrencySafe?(params: Static<S>): boolean;
}
