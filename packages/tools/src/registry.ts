// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { randomUUID } from "node:crypto";

import type {
  RuntimeMessage,
  RuntimeToolCall,
  ToolDispatchResult,
  ToolDispatcher,
  ToolExecutionMode,
} from "@sciencediscovery/runtime-core";

import type { ToolOutputGuard, ToolOutputRecord } from "./bounded-output.js";
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
import { fenceUntrustedContent, neutralizeUntrustedTags, resolveUntrustedCategory } from "./sanitize.js";
import type { AgentTool } from "./types.js";

export interface ToolSpec {
  description: string;
  name: string;
  parameters: unknown;
}

export interface ToolRegistryOptions<TMessage extends RuntimeMessage> {
  createResultMessage(call: RuntimeToolCall, content: string, output?: ToolOutputRecord): TMessage;
  /** Optional run-scoped capability policy supplied by the application composition. */
  isAvailable?(tool: AgentTool): boolean;
  loopGuard?: ToolLoopGuard;
  /** Run-scoped observation hook. It cannot alter the result returned to Runtime Core. */
  onResult?(input: {
    call: RuntimeToolCall;
    content: string;
    isError: boolean;
    sequence: number;
  }): void;
  /**
   * Deterministic bound applied to every result before it becomes a canonical
   * history message. Wiring it here rather than in each tool is what stops a
   * newly added or MCP-provided tool from reaching the model unbounded.
   */
  outputGuard?: ToolOutputGuard;
  /** Durable raw observation hook; awaited before bounding, never silently dropped. */
  recordResult?(input: { call: RuntimeToolCall; content: string; isError: boolean; sequence: number }): Promise<void>;
  /**
   * Run-scoped nonce for untrusted-result fencing (see sanitize.ts). Defaults
   * to a random per-registry (per-run) value; injectable for tests.
   */
  untrustedFenceNonce?: string;
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
  private readonly untrustedFenceNonce: string;
  private nextExecutionSequence = 0;

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
    this.untrustedFenceNonce = options.untrustedFenceNonce ?? randomUUID().replaceAll("-", "").slice(0, 12);
  }

  promoteForRequest(text: string): string[] {
    return autoPromoteFromRouting(this.availableDeferredState(), this.availableTools(), text);
  }

  deferredNames(): ReadonlySet<string> {
    return this.availableDeferredState()?.catalog.names ?? new Set();
  }

  promptSections(): string[] {
    const tools = this.availableTools();
    const deferredState = this.availableDeferredState();
    return [
      deferredToolsPromptSection(deferredState),
      routingHintsPromptSection(tools, deferredState?.catalog.names ?? new Set()),
    ].filter(Boolean);
  }

  values(): readonly AgentTool[] {
    return this.orderedTools;
  }

  visibleSpecs(): ToolSpec[] {
    const deferredState = this.availableDeferredState();
    const hidden = hiddenDeferredNames(deferredState);
    const specs = this.availableTools()
      .filter((tool) => !hidden.has(tool.name))
      .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters as unknown }));
    if (deferredState) specs.push({ ...TOOL_SEARCH_SPEC });
    return specs;
  }

  executionMode(call: RuntimeToolCall): ToolExecutionMode {
    if (call.name === TOOL_SEARCH_NAME) return "parallel";
    const tool = this.tools.get(call.name);
    if (!tool?.isConcurrencySafe || !this.toolIsAvailable(call.name)) return "exclusive";
    try {
      return tool.isConcurrencySafe(call.args as never) === true ? "parallel" : "exclusive";
    } catch {
      return "exclusive";
    }
  }

  snapshot() {
    return {
      promoted: [...(this.deferredState?.promoted ?? [])].sort(),
      visibleSpecs: this.visibleSpecs(),
      availableNames: this.availableTools().map((tool) => tool.name),
      nextExecutionSequence: this.nextExecutionSequence,
      loopGuard: this.loopGuard.snapshot(),
    };
  }

  async execute(call: RuntimeToolCall, signal: AbortSignal): Promise<ToolDispatchResult<TMessage>> {
    // execute() is entered in model-declared order before concurrent handlers
    // yield, so this sequence remains deterministic even when completion order
    // differs.
    const sequence = this.nextExecutionSequence += 1;
    // Resolve the untrusted category up front: it drives BOTH the tag
    // neutralization of remote content (inside executeRegistered) and the
    // model-visible fence below. Synthetic results (tool_search) have no
    // registered tool and resolve by name only.
    const category = resolveUntrustedCategory(this.tools.get(call.name) ?? { name: call.name });
    let content: string;
    let isError: boolean;
    let selfBounded = false;
    // Framework-generated non-error results (the loop guard's warn) must
    // reach the model unfenced: the fence semantics tell the model to ignore
    // directives inside a fence, which would disarm the guard exactly on the
    // tools prone to looping.
    let frameworkGenerated = false;
    let outputRecord: ToolOutputRecord | undefined;
    if (call.argsParseError) {
      content = JSON.stringify({ ok: false, error: { attempts: 1, code: "INVALID_TOOL_ARGUMENTS", retryable: true,
        message: `Invalid tool arguments: ${call.argsParseError}`.slice(0, 1_000) } });
      isError = true;
    } else if (call.name === TOOL_SEARCH_NAME && this.availableDeferredState()) {
      content = runToolSearch(this.availableDeferredState()!, typeof call.args.query === "string" ? call.args.query : "");
      isError = false;
    } else if (!this.toolIsAvailable(call.name)) {
      content = `Error: Tool '${call.name}' is not available under the current run capability policy.`;
      isError = true;
    } else if (this.availableDeferredState() && hiddenDeferredNames(this.availableDeferredState()).has(call.name)) {
      content = blockedDeferredToolResult(call.name);
      isError = true;
    } else {
      ({ content, isError, selfBounded, frameworkGenerated } = await this.executeRegistered(call, signal, category));
    }
    if (this.options.recordResult) await this.options.recordResult({ call, content, isError, sequence });
    if (this.options.outputGuard) {
      const guarded = await this.options.outputGuard.applyDetailed(call.name, content, selfBounded);
      content = guarded.content;
      outputRecord = guarded.record;
    }
    try { this.options.onResult?.({ call, content, isError, sequence }); } catch { /* observer isolation */ }
    // Fence last: storage (recordResult), bounding (outputGuard) and observers
    // (onResult) all see the raw content; only the model-visible text (history
    // message + returned content) carries the unforgeable boundary markers.
    // (The run-layer audit ToolAction records the fenced form — the nonce is
    // embedded in the markers, so the model-visible text stays reconstructable.)
    // Error results and framework-generated non-error results (loop-guard
    // warn) are framework text — fencing them would mark framework guidance
    // as untrusted data the model should ignore, so both skip the fence.
    const fenced = isError || frameworkGenerated || !category
      ? content
      : fenceUntrustedContent(content, category, this.untrustedFenceNonce);
    return { content: fenced, isError, message: this.options.createResultMessage(call, fenced, outputRecord) };
  }

  private availableTools(): readonly AgentTool[] {
    return this.options.isAvailable
      ? this.orderedTools.filter((tool) => this.options.isAvailable!(tool))
      : this.orderedTools;
  }

  private toolIsAvailable(name: string): boolean {
    const tool = this.tools.get(name);
    return Boolean(tool) && (!this.options.isAvailable || this.options.isAvailable(tool!));
  }

  private availableDeferredState(): DeferredToolState | undefined {
    if (!this.deferredState) return undefined;
    const available = this.availableTools().filter((tool) => this.deferredState!.catalog.names.has(tool.name));
    if (!available.length) return undefined;
    const state = buildDeferredToolState(available);
    if (!state) return undefined;
    state.promoted = this.deferredState.promoted;
    return state;
  }

  private async executeRegistered(
    call: RuntimeToolCall,
    signal: AbortSignal,
    category: string | undefined,
  ): Promise<{ content: string; frameworkGenerated: boolean; isError: boolean; selfBounded: boolean }> {
    const decision = this.loopGuard.inspect(call.name, call.args);
    if (decision.action !== "allow") {
      return {
        content: decision.content,
        frameworkGenerated: true,
        isError: decision.action === "stop",
        selfBounded: false,
      };
    }
    const tool = this.tools.get(call.name);
    if (!tool) return { content: `Unknown tool: ${call.name}`, frameworkGenerated: false, isError: true, selfBounded: false };
    try {
      const result = await tool.execute(call.id || randomUUID(), call.args as never, signal);
      const text = result.content.map((item) => item.text).join("\n");
      return {
        // Tag neutralization is tied to the "remote" category (web tools via
        // the legacy name list, MCP connectors via the auto-mark): their
        // content is free-form attacker text where a forged framework block
        // must never survive. Corpus categories (knowledge-base, document)
        // keep fence-only handling so verbatim quotes stay byte-exact for
        // the provenance gate.
        content: category === "remote" ? neutralizeUntrustedTags(text) : text,
        frameworkGenerated: false,
        isError: false,
        selfBounded: result.bounded === true,
      };
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
      } }), frameworkGenerated: false, isError: true, selfBounded: true };
    }
  }
}
