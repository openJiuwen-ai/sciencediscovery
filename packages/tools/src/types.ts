// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { Static, TSchema } from "typebox";

export interface AgentToolResult {
  /** A completed tool invocation may report a domain failure without throwing. */
  isError?: boolean;
  /**
   * Set by tools that already bound their own model-facing output (pagination,
   * an explicit preview). The registry then leaves the formatting alone unless
   * the result still exceeds the hard bound.
   */
  bounded?: boolean;
  content: Array<{ text: string; type: "text" }>;
  details?: unknown;
  /**
   * Dynamic result trust, used when one tool reads records produced by other
   * tools. The registry still combines `content` verbatim for persistence and
   * observers, but puts `frameworkPrefix` outside the model-facing fence.
   */
  frameworkPrefix?: string;
  /** Override the registered tool's category for this particular result. */
  untrustedCategory?: string;
  /** Whether authority tags must be neutralized for this particular result. */
  neutralizeTags?: boolean;
}

export interface AgentTool<S extends TSchema = TSchema> {
  deferred?: boolean;
  description: string;
  label: string;
  mcp?: { sourceId: string; toolId: string };
  name: string;
  parameters: S;
  /**
   * The arguments a call cannot run without.
   *
   * A call that omits one is rejected before the tool runs, and the model is
   * asked to re-issue it. The tool's schema states the same requirement; this
   * list is what the run enforces, so a tool does not have to fail deep
   * inside to say that an argument never arrived.
   */
  requiredArguments?: readonly string[];
  routing?: { keywords: string[]; mode: "off" | "prefer"; priority: number };
  /**
   * Untrusted-content category for result fencing (see sanitize.ts). Set when
   * this tool's result is attacker-influenceable DATA (fetched pages, ingested
   * corpus text, connector payloads) rather than framework-generated text. An
   * explicit value wins over the legacy name list and the `mcp` auto-mark;
   * omitted means unfenced unless one of those applies.
   */
  untrustedCategory?: string;
  execute(toolCallId: string, params: Static<S>, signal?: AbortSignal, onProgress?: (chunk: string) => void): Promise<AgentToolResult>;
  /** Only an exact true permits overlap; omitted or throwing classifiers are exclusive. */
  isConcurrencySafe?(params: Static<S>): boolean;
}
