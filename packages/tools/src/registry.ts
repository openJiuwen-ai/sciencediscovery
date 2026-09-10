// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { randomUUID } from "node:crypto";

import type {
  PreparedToolBatch,
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
  runToolSearchDetailed,
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
  batchPolicies?: readonly ToolBatchPolicy[];
  createResultMessage(call: RuntimeToolCall, content: string, output?: ToolOutputRecord): TMessage;
  /** Optional run-scoped capability policy supplied by the application composition. */
  isAvailable?(tool: AgentTool): boolean;
  loopGuard?: ToolLoopGuard;
  /** Run-scoped observation hook. It cannot alter the result returned to Runtime Core. */
  onResult?(input: {
    call: RuntimeToolCall;
    content: string;
    details?: unknown;
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
  recordResult?(input: { call: RuntimeToolCall; content: string; details?: unknown; isError: boolean; sequence: number }): Promise<void>;
}

export interface ToolBatchSupersedeDecision {
  byCallId: string;
  callId: string;
  kind: "supersede";
}

export interface ToolBatchPolicy {
  readonly id: string;
  decide(calls: readonly RuntimeToolCall[]): readonly ToolBatchSupersedeDecision[];
}

const MAX_DETAIL_DEPTH = 8;
const MAX_DETAIL_KEYS = 100;
const MAX_DETAIL_ARRAY_ITEMS = 100;
const MAX_DETAIL_STRING_CHARS = 4_096;
const MAX_DETAIL_TOTAL_CHARS = 64_000;
const REDACTED_DETAIL_KEY = /^(?:authorization|api[_-]?key|apikey|apiToken|authToken|accessToken|refreshToken|runnerToken|bearerToken|token|password|passphrase|clientSecret|secretKey|secret|credential|cookie|set-cookie|private[_-]?key|privateKey)$/iu;
const OMITTED_PAYLOAD_DETAIL_KEY = /^(?:stdout|stderr|raw[_-]?request|raw[_-]?response|raw[_-]?result|prompt|content|text|body|input|output|evaluatorSource)$/iu;

interface DetailSanitizeState {
  omitted: boolean;
  remainingChars: number;
  truncated: boolean;
  seen: WeakSet<object>;
}

function detailBoundary(state: DetailSanitizeState): Record<string, unknown> | undefined {
  if (!state.omitted && !state.truncated) return undefined;
  return {
    maxArrayItems: MAX_DETAIL_ARRAY_ITEMS,
    maxDepth: MAX_DETAIL_DEPTH,
    maxObjectKeys: MAX_DETAIL_KEYS,
    maxStringChars: MAX_DETAIL_STRING_CHARS,
    maxTotalStringChars: MAX_DETAIL_TOTAL_CHARS,
    omittedPayloadFields: state.omitted,
    truncated: state.truncated,
  };
}

function sanitizeStringDetail(value: string, state: DetailSanitizeState): string {
  if (state.remainingChars <= 0) {
    state.truncated = true;
    return "[truncated]";
  }
  const allowed = Math.min(value.length, MAX_DETAIL_STRING_CHARS, state.remainingChars);
  state.remainingChars -= allowed;
  if (allowed < value.length) {
    state.truncated = true;
    return `${value.slice(0, allowed)}[truncated]`;
  }
  return value;
}

function sanitizeDetailValue(value: unknown, state: DetailSanitizeState, depth: number, key?: string): unknown {
  if (key && REDACTED_DETAIL_KEY.test(key)) {
    state.omitted = true;
    return "[redacted]";
  }
  if (key && OMITTED_PAYLOAD_DETAIL_KEY.test(key)) {
    state.omitted = true;
    return "[omitted]";
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return sanitizeStringDetail(value, state);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol" || typeof value === "function" || value === undefined) return undefined;
  if (depth >= MAX_DETAIL_DEPTH) {
    state.truncated = true;
    return "[max-depth]";
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Error) {
    return {
      message: sanitizeStringDetail(value.message, state),
      name: value.name,
    };
  }
  if (state.seen.has(value)) {
    state.truncated = true;
    return "[circular]";
  }
  state.seen.add(value);
  if (ArrayBuffer.isView(value)) {
    state.seen.delete(value);
    state.omitted = true;
    return `[binary:${value.byteLength}]`;
  }
  if (value instanceof ArrayBuffer) {
    state.seen.delete(value);
    state.omitted = true;
    return `[binary:${value.byteLength}]`;
  }
  if (Array.isArray(value)) {
    const values = value.slice(0, MAX_DETAIL_ARRAY_ITEMS)
      .map((item) => sanitizeDetailValue(item, state, depth + 1))
      .filter((item) => item !== undefined);
    if (value.length > MAX_DETAIL_ARRAY_ITEMS) {
      state.truncated = true;
      values.push(`[${value.length - MAX_DETAIL_ARRAY_ITEMS} items omitted]`);
    }
    state.seen.delete(value);
    return values;
  }
  const result: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [entryKey, entryValue] of entries.slice(0, MAX_DETAIL_KEYS)) {
    const sanitized = sanitizeDetailValue(entryValue, state, depth + 1, entryKey);
    if (sanitized !== undefined) result[entryKey] = sanitized;
  }
  if (entries.length > MAX_DETAIL_KEYS) {
    state.truncated = true;
    result.__omittedKeys = entries.length - MAX_DETAIL_KEYS;
  }
  state.seen.delete(value);
  return result;
}

export function sanitizeToolDetails(details: unknown): unknown {
  const state: DetailSanitizeState = {
    omitted: false,
    remainingChars: MAX_DETAIL_TOTAL_CHARS,
    seen: new WeakSet<object>(),
    truncated: false,
  };
  const sanitized = sanitizeDetailValue(details, state, 0);
  const boundary = detailBoundary(state);
  if (!boundary) return sanitized;
  if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)) {
    return { ...(sanitized as Record<string, unknown>), __detailsBoundary: boundary };
  }
  return { __detailsBoundary: boundary, value: sanitized };
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

  prepareBatch(calls: readonly RuntimeToolCall[]): PreparedToolBatch<TMessage> {
    const callIds = new Set(calls.map((call) => call.id));
    if (callIds.size !== calls.length) throw new Error("Tool batch contains duplicate call ids");
    const superseded = new Map<string, { byCallId: string; owner: string }>();
    for (const policy of this.options.batchPolicies ?? []) {
      for (const decision of policy.decide(calls)) {
        if (!callIds.has(decision.callId)) {
          throw new Error(`Tool batch policy ${policy.id} selected unknown call ${decision.callId}`);
        }
        if (!callIds.has(decision.byCallId)) {
          throw new Error(`Tool batch policy ${policy.id} referenced unknown replacement ${decision.byCallId}`);
        }
        const existing = superseded.get(decision.callId);
        if (existing) {
          throw new Error(`Tool call ${decision.callId} is controlled by both ${existing.owner} and ${policy.id}`);
        }
        superseded.set(decision.callId, { byCallId: decision.byCallId, owner: policy.id });
      }
    }
    return {
      executionMode: (call) => superseded.has(call.id) ? "parallel" : this.executionMode(call),
      execute: (call, signal) => {
        const decision = superseded.get(call.id);
        return decision ? this.supersededResult(call, decision.byCallId) : this.execute(call, signal);
      },
    };
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
    let content: string;
    let details: unknown | undefined;
    let isError: boolean;
    let selfBounded = false;
    let outputRecord: ToolOutputRecord | undefined;
    const availableDeferred = this.availableDeferredState();
    if (call.argsParseError) {
      details = { ok: false, error: { attempts: 1, code: "INVALID_TOOL_ARGUMENTS", retryable: true,
        message: `Invalid tool arguments: ${call.argsParseError}`.slice(0, 1_000) } };
      content = JSON.stringify(details);
      isError = true;
    } else if (call.name === TOOL_SEARCH_NAME && availableDeferred) {
      const result = runToolSearchDetailed(availableDeferred, typeof call.args.query === "string" ? call.args.query : "");
      content = result.content;
      details = result.details;
      isError = false;
    } else if (!this.tools.has(call.name)) {
      content = `Unknown tool: ${call.name}`;
      details = { ok: false, error: { code: "UNKNOWN_TOOL", message: content, retryable: false } };
      isError = true;
    } else if (!this.toolIsAvailable(call.name)) {
      content = `Error: Tool '${call.name}' is not available under the current run capability policy.`;
      details = { ok: false, error: { code: "TOOL_UNAVAILABLE", message: content, retryable: true } };
      isError = true;
    } else if (availableDeferred && hiddenDeferredNames(availableDeferred).has(call.name)) {
      content = blockedDeferredToolResult(call.name);
      details = { ok: false, error: { code: "DEFERRED_TOOL_NOT_PROMOTED", message: content, retryable: true } };
      isError = true;
    } else {
      ({ content, details, isError, selfBounded } = await this.executeRegistered(call, signal));
    }
    const boundedDetails = details === undefined ? undefined : sanitizeToolDetails(details);
    if (this.options.recordResult) await this.options.recordResult({ call, content, ...(boundedDetails !== undefined ? { details: boundedDetails } : {}), isError, sequence });
    if (this.options.outputGuard) {
      const guarded = await this.options.outputGuard.applyDetailed(call.name, content, selfBounded);
      content = guarded.content;
      outputRecord = guarded.record;
    }
    try { this.options.onResult?.({ call, content, ...(boundedDetails !== undefined ? { details: boundedDetails } : {}), isError, sequence }); } catch { /* observer isolation */ }
    return {
      content,
      ...(boundedDetails !== undefined ? { details: boundedDetails } : {}),
      isError,
      message: this.options.createResultMessage(call, content, outputRecord),
    };
  }

  private async supersededResult(call: RuntimeToolCall, byCallId: string): Promise<ToolDispatchResult<TMessage>> {
    const sequence = this.nextExecutionSequence += 1;
    const details = { ok: true, superseded: true, supersededBy: byCallId };
    const content = JSON.stringify(details);
    if (this.options.recordResult) await this.options.recordResult({ call, content, details, isError: false, sequence });
    try { this.options.onResult?.({ call, content, details, isError: false, sequence }); } catch { /* observer isolation */ }
    return { content, details, isError: false, message: this.options.createResultMessage(call, content) };
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
  ): Promise<{ content: string; details?: unknown; isError: boolean; selfBounded: boolean }> {
    const decision = this.loopGuard.inspect(call.name, call.args);
    if (decision.action !== "allow") {
      return {
        content: decision.content,
        details: decision.details,
        isError: decision.action === "stop",
        selfBounded: false,
      };
    }
    const tool = this.tools.get(call.name)!;
    try {
      const result = await tool.execute(call.id || randomUUID(), call.args as never, signal);
      const text = result.content.map((item) => item.text).join("\n");
      return {
        content: isRemoteContentTool(call.name) ? neutralizeUntrustedTags(text) : text,
        ...(result.details !== undefined ? { details: result.details } : {}),
        isError: result.isError === true,
        selfBounded: result.bounded === true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const invocation = error && typeof error === "object" && "invocation" in error
        ? (error as { invocation?: { attempts?: unknown[]; error?: { code?: string; retryAfterMs?: number; retryable?: boolean } } }).invocation
        : undefined;
      const details = { ok: false, error: {
        attempts: invocation?.attempts?.length ?? 1,
        code: invocation?.error?.code ?? "TOOL_EXECUTION_FAILED",
        message: message.slice(0, 1_000),
        ...(invocation?.error?.retryAfterMs !== undefined ? { retryAfterMs: invocation.error.retryAfterMs } : {}),
        retryable: invocation?.error?.retryable ?? false,
      } };
      return { content: JSON.stringify(details), details, isError: true, selfBounded: true };
    }
  }
}
