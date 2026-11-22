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

import { retainedOutputNotice, type ToolOutputGuard, type ToolOutputRecord } from "./bounded-output.js";
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
import { retiredToolGuidance } from "./retired-tools.js";
import type { McpError } from "@sciencediscovery/schema";
import type { AgentTool } from "./types.js";

export interface ToolSpec {
  description: string;
  name: string;
  parameters: unknown;
}

export interface ToolRegistryOptions<TMessage extends RuntimeMessage> {
  batchPolicies?: readonly ToolBatchPolicy[];
  createResultMessage(call: RuntimeToolCall, content: string, output?: ToolOutputRecord): TMessage;
  /**
   * One run-segment reminder after the same registered tool fails twice without
   * succeeding. Other tools do not clear its streak. No cause is inferred;
   * configuration calls and aborted executions do not trigger the reminder.
   */
  errorGuidance?: string;
  /** Optional run-scoped capability policy supplied by the application composition. */
  isAvailable?(tool: AgentTool): boolean;
  loopGuard?: ToolLoopGuard;
  /** Run-scoped observation hook. It cannot alter the result returned to Runtime Core. */
  onProgress?(call: RuntimeToolCall, chunk: string): void;
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
  /** Required bounded-state reduction. Failure stops the turn; observers remain best-effort. */
  commitResult?(input: { call: RuntimeToolCall; content: string; details?: unknown; isError: boolean; sequence: number }): Promise<void>;
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
// Audit metadata can be deeper than the interactive view, but must remain
// safe to traverse and serialize even when a provider returns pathological nesting.
const MAX_AUDIT_DETAIL_DEPTH = 128;
const MAX_DETAIL_KEYS = 100;
const MAX_DETAIL_ARRAY_ITEMS = 100;
const MAX_DETAIL_STRING_CHARS = 4_096;
const MAX_DETAIL_TOTAL_CHARS = 64_000;
// The audit copy keeps whole strings and whole containers that the interactive
// view cuts, so its budget has to be larger than 64 000 characters - but it
// has to exist: a *wide* result (an MCP records array of many small records)
// is otherwise written whole into the durable trajectory and the version
// recorder. Four times the interactive bound keeps ordinary metadata complete
// and still caps what one tool result adds to the durable record. Like the
// interactive budget it counts characters, so the serialized record can exceed
// it: three times in UTF-8 bytes for non-ASCII text, and six times for a payload
// of JSON-escaped control characters. What it guarantees is that the record no
// longer grows with the provider result.
const MAX_AUDIT_DETAIL_TOTAL_CHARS = 4 * MAX_DETAIL_TOTAL_CHARS;
// Charged per object entry and array item: punctuation, quoting and the key.
// Without it a wide container of short values would grow the audit copy while
// charging the budget almost nothing.
const DETAIL_ENTRY_COST = 8;
// Kept back from an entry that still has siblings after it, per sibling, so one
// wide payload cannot spend the whole budget and drop the metadata that follows
// it (`ok`, `error.code`, counts). It comes out of the same budget rather than
// on top of it, and at most a quarter of what is left is ever held back.
const DETAIL_TRAILING_ENTRY_RESERVE = 256;
// Names what the recorder cut, so a reader of a trajectory can tell it apart
// from what the tool returned.
const AUDIT_DETAILS_TRUNCATED = "[audit-details truncated]";
const REDACTED_DETAIL_KEY = /^(?:authorization|api[_-]?key|apikey|apiToken|authToken|accessToken|refreshToken|runnerToken|bearerToken|token|password|passphrase|clientSecret|secretKey|secret|credential|cookie|set-cookie|private[_-]?key|privateKey)$/iu;
const OMITTED_PAYLOAD_DETAIL_KEY = /^(?:stdout|stderr|raw[_-]?request|raw[_-]?response|raw[_-]?result|prompt|content|text|body|input|output|evaluatorSource)$/iu;

interface DetailSanitizeState {
  bounded: boolean;
  omitted: boolean;
  remainingChars: number;
  truncated: boolean;
  seen: WeakSet<object>;
}

// Reported only when the recorder itself cut content: a redacted or omitted
// payload field already says so where it stood, and the boundary's job is to
// stop a reader mistaking a cut record for the tool's own output.
function auditBoundary(state: DetailSanitizeState): Record<string, unknown> | undefined {
  if (!state.truncated) return undefined;
  return {
    marker: AUDIT_DETAILS_TRUNCATED,
    maxDepth: MAX_AUDIT_DETAIL_DEPTH,
    maxTotalChars: MAX_AUDIT_DETAIL_TOTAL_CHARS,
    omittedPayloadFields: state.omitted,
    truncated: state.truncated,
  };
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

function detailTruncationMarker(state: DetailSanitizeState): string {
  return state.bounded ? "[truncated]" : AUDIT_DETAILS_TRUNCATED;
}

function sanitizeStringDetail(value: string, state: DetailSanitizeState): string {
  const marker = detailTruncationMarker(state);
  if (state.remainingChars <= 0) {
    state.truncated = true;
    return marker;
  }
  const allowed = Math.min(value.length, state.bounded ? MAX_DETAIL_STRING_CHARS : value.length, state.remainingChars);
  state.remainingChars -= allowed;
  if (allowed < value.length) {
    state.truncated = true;
    return `${value.slice(0, allowed)}${marker}`;
  }
  return value;
}

/** Charge one object entry or array item. False means the budget is spent, so
 * the walk stops instead of relabelling every remaining leaf: the point of the
 * budget is a bounded record, not a shorter in-memory one. */
function chargeDetailEntry(state: DetailSanitizeState, keyLength: number): boolean {
  state.remainingChars -= DETAIL_ENTRY_COST + keyLength;
  return state.remainingChars > 0;
}

/** Sanitize one audit entry or array item while holding back headroom for the
 * `following` siblings, so a cut drops the payload rather than whatever came
 * after it. The headroom is returned to the budget afterwards: it decides which
 * entries survive a cut, never how large the record is. */
function sanitizeAuditChild(
  state: DetailSanitizeState,
  value: unknown,
  depth: number,
  key: string | undefined,
  following: number,
): unknown {
  if (state.bounded) return sanitizeDetailValue(value, state, depth + 1, key);
  const before = state.remainingChars;
  const reserve = Math.min(
    Math.ceil(before / 4),
    following * (DETAIL_ENTRY_COST + DETAIL_TRAILING_ENTRY_RESERVE),
  );
  const cap = Math.max(1, before - reserve);
  state.remainingChars = cap;
  const sanitized = sanitizeDetailValue(value, state, depth + 1, key);
  state.remainingChars += before - cap;
  return sanitized;
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
  if (typeof value === "bigint") return state.bounded ? value.toString() : sanitizeStringDetail(value.toString(), state);
  if (typeof value === "symbol" || typeof value === "function" || value === undefined) return undefined;
  if (depth >= (state.bounded ? MAX_DETAIL_DEPTH : MAX_AUDIT_DETAIL_DEPTH)) {
    state.truncated = true;
    return "[max-depth]";
  }
  // CAS references are atomic metadata. Truncating their individual strings
  // produces a reference-shaped object with an invalid pool/digest, which
  // cannot be recorded in a trajectory. Keep the whole reference or omit the
  // whole value; the authoritative object remains in its original store.
  if (typeof value === "object" && value !== null) {
    const ref = value as Record<string, unknown>;
    if ((ref.pool === "data" || ref.pool === "agent-state")
      && typeof ref.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(ref.digest)
      && typeof ref.size === "number" && Number.isSafeInteger(ref.size) && ref.size >= 0
      && typeof ref.mediaType === "string" && ref.mediaType.length > 0
      && Object.keys(ref).length === 4) {
      const chars = ref.pool.length + ref.digest.length + ref.mediaType.length;
      if (chars > state.remainingChars
        || (state.bounded && ref.mediaType.length > MAX_DETAIL_STRING_CHARS)) {
        state.truncated = true;
        return "[reference omitted: detail budget]";
      }
      state.remainingChars -= chars;
      return { pool: ref.pool, digest: ref.digest, size: ref.size, mediaType: ref.mediaType };
    }
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const iso = value.toISOString();
    // A date serializes as a 24-character string, so the audit budget has to
    // charge it like one; otherwise a list of dates writes itself whole.
    return state.bounded ? iso : sanitizeStringDetail(iso, state);
  }
  if (value instanceof Error) {
    return {
      message: sanitizeStringDetail(value.message, state),
      name: state.bounded ? value.name : sanitizeStringDetail(value.name, state),
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
    const values: unknown[] = [];
    const limit = state.bounded ? Math.min(value.length, MAX_DETAIL_ARRAY_ITEMS) : value.length;
    let processed = 0;
    for (; processed < limit; processed += 1) {
      if (!state.bounded && !chargeDetailEntry(state, 0)) break;
      const sanitized = sanitizeAuditChild(state, value[processed], depth, undefined, limit - processed - 1);
      if (sanitized !== undefined) values.push(sanitized);
    }
    if (processed < value.length) {
      state.truncated = true;
      values.push(state.bounded
        ? `[${value.length - processed} items omitted]`
        : `[${value.length - processed} items omitted: ${AUDIT_DETAILS_TRUNCATED}]`);
    }
    state.seen.delete(value);
    return values;
  }
  const result: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  const limit = state.bounded ? Math.min(entries.length, MAX_DETAIL_KEYS) : entries.length;
  let processed = 0;
  for (; processed < limit; processed += 1) {
    const [entryKey, entryValue] = entries[processed]!;
    if (!state.bounded && !chargeDetailEntry(state, entryKey.length)) break;
    const sanitized = sanitizeAuditChild(state, entryValue, depth, entryKey, limit - processed - 1);
    if (sanitized !== undefined) result[entryKey] = sanitized;
  }
  if (processed < entries.length) {
    state.truncated = true;
    result.__omittedKeys = entries.length - processed;
  }
  state.seen.delete(value);
  return result;
}

/** Persist safe metadata without the interactive per-field and per-container
 * size limits, retaining a defensive depth limit and a total budget. Raw
 * payload fields remain omitted; full results belong in their governed source
 * stores. A cut adds `__auditBoundary` and the `[audit-details truncated]`
 * marker, so a reader can tell the recorder's cut from the tool's own output. */
export function redactToolDetails(details: unknown): unknown {
  const state: DetailSanitizeState = {
    bounded: false,
    omitted: false,
    remainingChars: MAX_AUDIT_DETAIL_TOTAL_CHARS,
    seen: new WeakSet<object>(),
    truncated: false,
  };
  const sanitized = sanitizeDetailValue(details, state, 0);
  const boundary = auditBoundary(state);
  if (!boundary) return sanitized;
  if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)) {
    return { ...(sanitized as Record<string, unknown>), __auditBoundary: boundary };
  }
  return { __auditBoundary: boundary, value: sanitized };
}

export function sanitizeToolDetails(details: unknown): unknown {
  const state: DetailSanitizeState = {
    bounded: true,
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
  private readonly failureStreaks = new Map<string, number>();
  private errorGuidanceShown = false;

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
    let retainedContent: string | undefined;
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
      const retired = retiredToolGuidance(call.name);
      if (retired) {
        content = retired;
        details = { ok: false, error: { code: "RETIRED_TOOL", message: retired, retryable: true } };
      } else {
        content = `Unknown tool: ${call.name}`;
        details = { ok: false, error: { code: "UNKNOWN_TOOL", message: content, retryable: false } };
      }
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
      ({ content, details, isError, selfBounded, retainedContent } = await this.executeRegistered(call, signal));
    }
    if (this.options.errorGuidance && !this.errorGuidanceShown && !signal.aborted
      && call.name !== "configuration" && this.tools.has(call.name)) {
      if (!isError) this.failureStreaks.delete(call.name);
      else {
        const failures = (this.failureStreaks.get(call.name) ?? 0) + 1;
        this.failureStreaks.set(call.name, failures);
        if (failures >= 2) {
          content = `${content}\n${this.options.errorGuidance}`;
          this.errorGuidanceShown = true;
          this.failureStreaks.clear();
          // A thrown error can mark its original payload self-bounded. Adding
          // application guidance must still pass through the output guard.
          selfBounded = false;
        }
      }
    }
    // Audit records retain complete safe metadata, but must not persist raw
    // credentials or payload fields. Interactive results also apply size limits.
    if (this.options.recordResult) {
      const auditDetails = details === undefined ? undefined : redactToolDetails(details);
      await this.options.recordResult({ call, content, ...(auditDetails !== undefined ? { details: auditDetails } : {}), isError, sequence });
    }
    const boundedDetails = details === undefined ? undefined : sanitizeToolDetails(details);
    if (this.options.outputGuard) {
      const guarded = await this.options.outputGuard.applyDetailed(call.name, content, selfBounded, retainedContent);
      content = guarded.content;
      outputRecord = guarded.record;
    } else if (retainedContent !== undefined) {
      content = retainedOutputNotice(content);
    }
    await this.options.commitResult?.({ call, content, ...(boundedDetails !== undefined ? { details: boundedDetails } : {}), isError, sequence });
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
    await this.options.commitResult?.({ call, content, details, isError: false, sequence });
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
  ): Promise<{ content: string; details?: unknown; isError: boolean; selfBounded: boolean; retainedContent?: string }> {
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
    let active = true;
    try {
      const result = await tool.execute(call.id || randomUUID(), call.args as never, signal, (chunk) => {
        if (!active || signal.aborted || !chunk) return;
        try { this.options.onProgress?.(call, isRemoteContentTool(call.name) ? neutralizeUntrustedTags(chunk) : chunk); } catch { /* Observers cannot fail tools. */ }
      });
      const text = result.content.map((item) => item.text).join("\n");
      return {
        content: (tool.mcp || isRemoteContentTool(call.name)) ? neutralizeUntrustedTags(text) : text,
        ...(result.details !== undefined ? { details: result.details } : {}),
        isError: result.isError === true,
        selfBounded: result.bounded === true,
        ...(result.retainedContent !== undefined ? { retainedContent: neutralizeUntrustedTags(result.retainedContent) } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The model gets only the bounded sentence below; whoever debugs the turn
      // gets the name and the stack here. Without this line an unexpected
      // TypeError arrived as a one-line TOOL_EXECUTION_FAILED with nothing in
      // any log to locate it (#1318).
      console.error(
        `[tool] ${call.name} threw ${error instanceof Error ? error.name : typeof error}: ${message}`
        + (error instanceof Error && error.stack ? `\n${error.stack}` : ""),
      );
      const invocation = error && typeof error === "object" && "invocation" in error
        ? (error as { invocation?: { attempts?: unknown[]; error?: McpError } }).invocation
        : undefined;
      const details = { ok: false, error: {
        attempts: invocation?.attempts?.length ?? 1,
        code: invocation?.error?.code ?? "TOOL_EXECUTION_FAILED",
        message: message.slice(0, 1_000),
        ...(invocation?.error?.retryAfterMs !== undefined ? { retryAfterMs: invocation.error.retryAfterMs } : {}),
        ...(invocation?.error?.sourceHealth ? { sourceHealth: invocation.error.sourceHealth } : {}),
        ...(invocation?.error?.fallbackSourceIds ? { fallbackSourceIds: invocation.error.fallbackSourceIds } : {}),
        ...(invocation?.error?.guidance ? { guidance: invocation.error.guidance } : {}),
        retryable: invocation?.error?.retryable ?? false,
      } };
      return { content: JSON.stringify(details), details, isError: true, selfBounded: true };
    } finally {
      active = false;
    }
  }
}
