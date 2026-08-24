// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { randomUUID } from "node:crypto";

import type { RuntimeMessage, RuntimeToolCall, ToolDispatchResult, ToolDispatcher } from "@sciencediscovery/runtime-core";

import {
  autoPromoteFromRouting,
  blockedDeferredToolResult,
  buildDeferredToolState,
  deferredToolsPromptSection,
  hiddenDeferredNames,
  routingHintsPromptSection,
  runToolSearch,
  TOOL_SEARCH_NAME,
  TOOL_SEARCH_SPEC,
  type DeferredToolState,
} from "./deferred-tools.js";
import { ToolLoopGuard } from "./loop-guard.js";
import { isRemoteContentTool, neutralizeUntrustedTags } from "./sanitize.js";
import type { AgentTool } from "./types.js";

export interface ToolSpec {
  description: string;
  name: string;
  parameters: unknown;
}

export interface ToolRegistryOptions<TMessage extends RuntimeMessage> {
  createResultMessage(call: RuntimeToolCall, content: string): TMessage;
  loopGuard?: ToolLoopGuard;
}

/**
 * Frozen run-scoped tool registry plus product tool policies. The runtime core
 * sees only ToolDispatcher; discovery, sanitization, and loop protection stay
 * in this capability package.
 */
export class ToolRegistry<TMessage extends RuntimeMessage> implements ToolDispatcher<TMessage> {
  private readonly tools: ReadonlyMap<string, AgentTool>;
  private readonly orderedTools: readonly AgentTool[];
  private readonly deferredState: DeferredToolState | undefined;
  private readonly loopGuard: ToolLoopGuard;

  constructor(tools: Iterable<AgentTool>, private readonly options: ToolRegistryOptions<TMessage>) {
    const ordered = [...tools].map((tool) => Object.freeze({ ...tool }));
    const registry = new Map<string, AgentTool>();
    for (const tool of ordered) {
      if (registry.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
      registry.set(tool.name, tool);
    }
    this.orderedTools = Object.freeze(ordered);
    this.tools = registry;
    this.deferredState = buildDeferredToolState(ordered);
    this.loopGuard = options.loopGuard ?? new ToolLoopGuard();
  }

  promoteForRequest(text: string): string[] {
    return autoPromoteFromRouting(this.deferredState, this.orderedTools, text);
  }

  deferredNames(): ReadonlySet<string> {
    return this.deferredState?.catalog.names ?? new Set();
  }

  promptSections(): string[] {
    return [
      deferredToolsPromptSection(this.deferredState),
      routingHintsPromptSection(this.orderedTools, this.deferredNames()),
    ].filter(Boolean);
  }

  values(): readonly AgentTool[] {
    return this.orderedTools;
  }

  visibleSpecs(): ToolSpec[] {
    const hidden = hiddenDeferredNames(this.deferredState);
    const specs = this.orderedTools
      .filter((tool) => !hidden.has(tool.name))
      .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters as unknown }));
    if (this.deferredState) specs.push({ ...TOOL_SEARCH_SPEC });
    return specs;
  }

  async execute(call: RuntimeToolCall, signal: AbortSignal): Promise<ToolDispatchResult<TMessage>> {
    let content: string;
    let isError: boolean;
    if (call.argsParseError) {
      content = JSON.stringify({ ok: false, error: { attempts: 1, code: "INVALID_TOOL_ARGUMENTS", retryable: true,
        message: `Invalid tool arguments: ${call.argsParseError}`.slice(0, 1_000) } });
      isError = true;
    } else if (call.name === TOOL_SEARCH_NAME && this.deferredState) {
      content = runToolSearch(this.deferredState, typeof call.args.query === "string" ? call.args.query : "");
      isError = false;
    } else if (this.deferredState && hiddenDeferredNames(this.deferredState).has(call.name)) {
      content = blockedDeferredToolResult(call.name);
      isError = true;
    } else {
      ({ content, isError } = await this.executeRegistered(call, signal));
    }
    return { content, isError, message: this.options.createResultMessage(call, content) };
  }

  private async executeRegistered(call: RuntimeToolCall, signal: AbortSignal): Promise<{ content: string; isError: boolean }> {
    const decision = this.loopGuard.inspect(call.name, call.args);
    if (decision.action !== "allow") return { content: decision.content, isError: decision.action === "stop" };
    const tool = this.tools.get(call.name);
    if (!tool) return { content: `Unknown tool: ${call.name}`, isError: true };
    try {
      const result = await tool.execute(call.id || randomUUID(), call.args as never, signal);
      const text = result.content.map((item) => item.text).join("\n");
      return { content: isRemoteContentTool(call.name) ? neutralizeUntrustedTags(text) : text, isError: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const invocation = error && typeof error === "object" && "invocation" in error
        ? (error as { invocation?: { attempts?: unknown[]; error?: { code?: string; retryAfterMs?: number; retryable?: boolean } } }).invocation
        : undefined;
      return { content: JSON.stringify({ ok: false, error: {
        attempts: invocation?.attempts?.length ?? 1,
        code: invocation?.error?.code ?? "TOOL_EXECUTION_FAILED",
        message: message.slice(0, 1_000),
        ...(invocation?.error?.retryAfterMs !== undefined ? { retryAfterMs: invocation.error.retryAfterMs } : {}),
        retryable: invocation?.error?.retryable ?? false,
      } }), isError: true };
    }
  }
}
