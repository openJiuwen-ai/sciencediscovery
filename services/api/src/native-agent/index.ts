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

/**
 * The Node-native agent loop.
 *
 * One `execute()` drives the whole model loop in this process: build the
 * workspace system prompt and tools, then repeatedly stream one model turn,
 * append the wire-format assistant message to history, execute any tool calls
 * through the SAME `createWorkspaceTools` handlers (permission gate, sandbox
 * runner, provenance — all in place), append the tool results, and call the
 * model again until a turn produces no tool calls.
 *
 * History is kept in OpenAI wire format and returned as `finalMessages` for
 * the explicit RequestExecution handoff, exactly like the previous engine.
 * Because assistant messages are stored verbatim (including raw tool-call
 * fields such as Gemini `thought_signature`), provider quirks replay without
 * a patch layer. Deferred tools, keyword auto-promotion, and history
 * compaction are provided by the sibling modules.
 */

import { createHash, randomUUID } from "node:crypto";

import {
  buildWorkspaceSystemPrompt,
  createWorkspaceTools,
  normalizeLegacyEnvironmentToolName,
  type Agent,
  type AgentEvent,
  type AgentHistoryMessage,
  type AgentModelUsage,
  type AgentTool,
  type WorkspaceAgentOptions,
} from "@science-agent/agent-runtime";

import {
  buildSummaryPrompt,
  planCompaction,
  summaryCheckpointMessage,
} from "./compaction.js";
import {
  TOOL_SEARCH_NAME,
  TOOL_SEARCH_SPEC,
  autoPromoteFromRouting,
  blockedDeferredToolResult,
  buildDeferredToolState,
  deferredToolsPromptSection,
  hiddenDeferredNames,
  routingHintsPromptSection,
  runToolSearch,
  type DeferredToolState,
} from "./deferred-tools.js";
import { isRemoteContentTool, neutralizeUntrustedTags } from "./sanitize.js";
import {
  resolveModelClientPolicy,
  streamModelTurn,
  type ModelClientPolicy,
  type ModelEndpoint,
  type ModelTurn,
  type NormalizedToolCall,
  type WireToolSpec,
} from "./model-client.js";

export const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 240_000;
export const DEFAULT_AGENT_TURN_TIMEOUT_MS = 0;

/** Hard safety net against a runaway model loop; time budgets remain the
 *  primary bound (`runTimeoutMs` / `runIdleTimeoutMs`). */
const MAX_MODEL_TURNS = 128;

const LOOP_DETECTION_WARN_COUNT = 10;
const LOOP_DETECTION_HARD_COUNT = 20;

export interface NativeAgentOptions extends WorkspaceAgentOptions {
  /** Stable identity for logging/tracing; use the session id. */
  sessionId: string;
  /** Hard deadline for one complete run, including streamed output. */
  runTimeoutMs?: number;
  /** Maximum time without model-stream progress (tool waits pause it via beginExternalWait). */
  runIdleTimeoutMs?: number;
  /** Canonical wire-format transcript handed off by a preceding AgentRun. */
  gatewayHistory?: AgentHistoryMessage[];
  /** Runtime-pinned request/task contract preserved outside compactable history. */
  runContract?: string;
}

export interface NativeAgentRunResult {
  finalMessages: AgentHistoryMessage[];
}

export interface NativeAgentHandle extends Agent {
  execute(text: string): Promise<NativeAgentRunResult>;
}

/** Test seam: replaces the model-turn transport without a live endpoint. */
export type ModelTurnStreamer = typeof streamModelTurn;
let modelTurnStreamer: ModelTurnStreamer = streamModelTurn;

export function setModelTurnStreamerForTest(streamer: ModelTurnStreamer): () => void {
  const previous = modelTurnStreamer;
  modelTurnStreamer = streamer;
  return () => {
    modelTurnStreamer = previous;
  };
}

type Listener = (event: AgentEvent) => void;
type WireMessage = AgentHistoryMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeHistoryMessage(message: WireMessage): WireMessage {
  const normalized = structuredClone(message);
  if (typeof normalized.name === "string") {
    normalized.name = normalizeLegacyEnvironmentToolName(normalized.name);
  }
  if (!Array.isArray(normalized.tool_calls)) return normalized;
  normalized.tool_calls = normalized.tool_calls.map((toolCall) => {
    if (!isRecord(toolCall)) return toolCall;
    const result = { ...toolCall };
    if (typeof result.name === "string") {
      result.name = normalizeLegacyEnvironmentToolName(result.name);
    }
    if (isRecord(result.function) && typeof result.function.name === "string") {
      result.function = {
        ...result.function,
        name: normalizeLegacyEnvironmentToolName(result.function.name),
      };
    }
    return result;
  });
  return normalized;
}

function stableJsonValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) return value.map((item) => stableJsonValue(item, seen));
  if (isRecord(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableJsonValue(value[key], seen)]),
    );
  }
  return value;
}

function toolLoopKey(name: string, args: Record<string, unknown>): string {
  return createHash("sha256")
    .update(`${name}\n${JSON.stringify(stableJsonValue(args))}`)
    .digest("hex");
}

function loopWarningContent(name: string, count: number): string {
  return JSON.stringify({
    ok: false,
    warning: {
      code: "REPEATED_TOOL_CALL",
      count,
      message: `Repeated ${name} call with identical arguments detected ${count} times. Reconsider your approach, use the previous result if available, or change arguments meaningfully before retrying.`,
      retryable: true,
    },
  });
}

function loopHardStopContent(name: string, count: number): string {
  return JSON.stringify({
    error: {
      attempts: count,
      code: "TOOL_LOOP_DETECTED",
      message: `Stopped repeated ${name} call with identical arguments after ${count} attempts. Do not call this same tool with the same arguments again; synthesize from existing results or choose a different action.`,
      retryable: false,
    },
    ok: false,
  });
}

function formatRunContract(contract: string): string {
  return [
    "<run_contract>",
    "Runtime-preserved request/task contract for this request execution.",
    "This contract is authoritative for scope and user constraints. It is not conversation history and must not be summarized away.",
    "For every step in this run, preserve the objective and constraints below. Do not broaden, narrow, replace, or forget them.",
    "",
    "Contract:",
    contract.trim(),
    "</run_contract>",
  ].join("\n");
}

interface ToolOutcome {
  content: string;
  isError: boolean;
}

class NativeAgent implements NativeAgentHandle {
  private readonly listeners = new Set<Listener>();
  private readonly tools = new Map<string, AgentTool>();
  private readonly repeatedToolCalls = new Map<string, number>();
  private readonly systemPrompt: string;
  private readonly endpoint: ModelEndpoint;
  private readonly policy: ModelClientPolicy;
  private readonly deferredState: DeferredToolState | undefined;
  private history: WireMessage[];
  private controller: AbortController | undefined;
  private externalWaitCount = 0;
  private pauseRunDeadline: (() => void) | undefined;
  private resumeRunDeadline: (() => void) | undefined;
  private abortRequested = false;
  private executed = false;

  constructor(private readonly options: NativeAgentOptions) {
    for (const tool of buildTools(options)) {
      if (this.tools.has(tool.name)) throw new Error(`Duplicate workspace tool name: ${tool.name}`);
      this.tools.set(tool.name, tool);
    }
    this.deferredState = buildDeferredToolState(this.tools.values());
    const promptSkills = this.tools.has("describe_skill") && this.tools.has("read_skill")
      ? options.skills
      : [];
    const baseSystemPrompt = buildWorkspaceSystemPrompt(
      promptSkills,
      Boolean(options.environments),
      {
        ...(options.approvalMode ? { approvalMode: options.approvalMode } : {}),
        ...(options.memoryGraphEnabled ? { memoryGraphEnabled: options.memoryGraphEnabled } : {}),
        ...(options.remoteHosts ? { remoteHosts: options.remoteHosts } : {}),
        ...(options.specialist ? { specialist: options.specialist } : {}),
        ...(options.specialists?.filter((specialist) => specialist.builtIn).length
          ? { builtinSpecialists: options.specialists!.filter((specialist) => specialist.builtIn).map((specialist) => ({ description: specialist.description, name: specialist.name })) }
          : {}),
        ...(options.subagent ? { subagent: options.subagent } : {}),
        ...(options.runSubagent && !options.subagent ? { subagentOrchestration: true } : {}),
      },
    );
    this.systemPrompt = [
      baseSystemPrompt,
      options.runContract ? formatRunContract(options.runContract) : "",
      deferredToolsPromptSection(this.deferredState),
      routingHintsPromptSection(this.tools.values(), this.deferredState?.catalog.names ?? new Set()),
    ].filter(Boolean).join("\n\n");
    this.history = options.gatewayHistory
      ? options.gatewayHistory.map(normalizeHistoryMessage)
      : (options.history ?? []).map((message) => ({ role: message.role, content: message.content }));
    this.endpoint = {
      baseUrl: options.config.baseUrl,
      ...(options.config.apiToken ? { apiToken: options.config.apiToken } : {}),
      model: options.config.model,
      ...(options.config.proxy ? { proxy: options.config.proxy } : {}),
    };
    this.policy = resolveModelClientPolicy();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  abort(): void {
    this.abortRequested = true;
    this.controller?.abort();
  }

  beginExternalWait(): () => void {
    this.externalWaitCount += 1;
    if (this.externalWaitCount === 1) this.pauseRunDeadline?.();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.externalWaitCount = Math.max(0, this.externalWaitCount - 1);
      if (this.externalWaitCount === 0) this.resumeRunDeadline?.();
    };
  }

  /** Compatibility surface for Agent; production AgentRuns call execute(). */
  async prompt(text: string): Promise<void> {
    await this.execute(text);
  }

  /** Run the full model loop for one prompt and return the canonical transcript. */
  async execute(text: string): Promise<NativeAgentRunResult> {
    if (this.executed) throw new Error("Agent handle has already been executed");
    this.executed = true;
    this.controller = new AbortController();
    if (this.abortRequested) this.controller.abort();
    this.history.push({ role: "user", content: text });
    autoPromoteFromRouting(this.deferredState, this.tools.values(), text);

    const controller = this.controller;
    const runTimeoutMs = this.options.runTimeoutMs ?? DEFAULT_AGENT_TURN_TIMEOUT_MS;
    const runIdleTimeoutMs = this.options.runIdleTimeoutMs ?? DEFAULT_AGENT_IDLE_TIMEOUT_MS;
    let timeoutKind: "idle" | "turn" | undefined;
    let remainingRunMs = runTimeoutMs;
    let activeSince = Date.now();
    let turnTimeoutId: ReturnType<typeof setTimeout> | undefined;
    let idleTimeoutId: ReturnType<typeof setTimeout> | undefined;
    const abortForTimeout = (kind: "idle" | "turn") => {
      if (timeoutKind) return;
      timeoutKind = kind;
      controller.abort();
    };
    const armTurnDeadline = () => {
      if (runTimeoutMs <= 0 || remainingRunMs <= 0) return;
      activeSince = Date.now();
      turnTimeoutId = setTimeout(() => abortForTimeout("turn"), remainingRunMs);
    };
    const markProgress = () => {
      if (idleTimeoutId) clearTimeout(idleTimeoutId);
      idleTimeoutId = runIdleTimeoutMs > 0
        ? setTimeout(() => abortForTimeout("idle"), runIdleTimeoutMs)
        : undefined;
    };
    this.pauseRunDeadline = () => {
      if (turnTimeoutId) {
        clearTimeout(turnTimeoutId);
        turnTimeoutId = undefined;
        remainingRunMs = Math.max(1, remainingRunMs - (Date.now() - activeSince));
      }
      if (idleTimeoutId) {
        clearTimeout(idleTimeoutId);
        idleTimeoutId = undefined;
      }
    };
    this.resumeRunDeadline = () => {
      if (controller.signal.aborted) return;
      if (!turnTimeoutId) armTurnDeadline();
      markProgress();
    };
    armTurnDeadline();
    markProgress();

    // Keep "timeout" in these errors: classifySubagentFailure matches
    // /timeout/i to preserve the public Subagent timed_out status.
    const timeoutError = () => timeoutKind === "idle"
      ? new Error(`Agent run stalled: no gateway progress for ${runIdleTimeoutMs} ms`)
      : new Error(`Agent run timeout: gateway turn exceeded ${runTimeoutMs} ms`);
    const raiseForAbort = (error: unknown): never => {
      if (timeoutKind) throw timeoutError();
      if (controller.signal.aborted) throw new Error("Agent run cancelled");
      throw error instanceof Error ? error : new Error(String(error));
    };

    let usage: AgentModelUsage | undefined;
    try {
      for (let turn = 0; turn < MAX_MODEL_TURNS; turn += 1) {
        if (controller.signal.aborted) raiseForAbort(new Error("Agent run cancelled"));
        await this.maybeCompact(controller.signal, markProgress);
        if (controller.signal.aborted) raiseForAbort(new Error("Agent run cancelled"));

        this.emit({ type: "turn_start" });
        let modelTurn: ModelTurn;
        try {
          modelTurn = await modelTurnStreamer(
            this.endpoint,
            this.systemPrompt,
            this.history,
            this.visibleToolSpecs(),
            this.policy,
            controller.signal,
            {
              onProgress: markProgress,
              onTextDelta: (delta) => this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } }),
              onThinkingDelta: (delta) => this.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta } }),
            },
          );
        } catch (error) {
          raiseForAbort(error);
          throw error; // unreachable; narrows type
        }
        markProgress();
        if (modelTurn.usage) usage = modelTurn.usage;
        this.history.push(modelTurn.assistantMessage);
        if (!modelTurn.toolCalls.length) break;

        for (const call of modelTurn.toolCalls) {
          this.emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.args });
        }
        // Tool calls within one assistant turn run concurrently (matching the
        // previous engine's tool node); results append in call order.
        const outcomes = await Promise.all(modelTurn.toolCalls.map((call) => this.executeToolCall(call)));
        if (controller.signal.aborted) raiseForAbort(new Error("Agent run cancelled"));
        for (const [index, outcome] of outcomes.entries()) {
          const call = modelTurn.toolCalls[index];
          if (!call) continue;
          this.emit({
            type: "tool_execution_end",
            toolCallId: call.id,
            toolName: call.name,
            result: { content: [{ type: "text", text: outcome.content }], details: {} },
            isError: outcome.isError,
          });
          this.history.push({
            role: "tool",
            tool_call_id: call.id,
            name: call.name,
            content: outcome.content,
          });
          markProgress();
        }
      }

      this.emit({ type: "model_usage", ...(usage ? { usage, usageReported: true } : { usageReported: false }) });
      if (usage) this.emit({ type: "usage", usage });
      return { finalMessages: structuredClone(this.history.filter((message) => message.role !== "system")) };
    } finally {
      if (turnTimeoutId) clearTimeout(turnTimeoutId);
      if (idleTimeoutId) clearTimeout(idleTimeoutId);
      this.pauseRunDeadline = undefined;
      this.resumeRunDeadline = undefined;
      this.externalWaitCount = 0;
    }
  }

  /** Compact older history into a summary checkpoint when over the trigger. */
  private async maybeCompact(signal: AbortSignal, markProgress: () => void): Promise<void> {
    const plan = planCompaction(this.history);
    if (!plan) return;
    let summaryText: string;
    try {
      const summaryTurn = await modelTurnStreamer(
        this.endpoint,
        "You compact conversation history into dense, factual summaries.",
        [{ role: "user", content: buildSummaryPrompt(plan) }],
        [],
        this.policy,
        signal,
        { onProgress: markProgress },
      );
      summaryText = typeof summaryTurn.assistantMessage.content === "string" ? summaryTurn.assistantMessage.content : "";
    } catch (error) {
      if (signal.aborted) throw error;
      return; // Summary failure skips compaction for this turn; the run continues.
    }
    const checkpoint = summaryCheckpointMessage(summaryText);
    if (!checkpoint) return;
    this.history = [checkpoint, ...plan.preserved];
  }

  private visibleToolSpecs(): WireToolSpec[] {
    const hidden = hiddenDeferredNames(this.deferredState);
    const specs: WireToolSpec[] = [];
    for (const tool of this.tools.values()) {
      if (hidden.has(tool.name)) continue;
      specs.push({ name: tool.name, description: tool.description, parameters: tool.parameters as unknown });
    }
    if (this.deferredState) {
      specs.push({ name: TOOL_SEARCH_SPEC.name, description: TOOL_SEARCH_SPEC.description, parameters: TOOL_SEARCH_SPEC.parameters });
    }
    return specs;
  }

  private async executeToolCall(call: NormalizedToolCall): Promise<ToolOutcome> {
    if (call.argsParseError) {
      return {
        content: JSON.stringify({
          error: { attempts: 1, code: "INVALID_TOOL_ARGUMENTS", message: `Invalid tool arguments: ${call.argsParseError}`.slice(0, 1_000), retryable: true },
          ok: false,
        }),
        isError: true,
      };
    }
    if (call.name === TOOL_SEARCH_NAME && this.deferredState) {
      const query = typeof call.args.query === "string" ? call.args.query : "";
      return { content: runToolSearch(this.deferredState, query), isError: false };
    }
    if (this.deferredState && hiddenDeferredNames(this.deferredState).has(call.name)) {
      return { content: blockedDeferredToolResult(call.name), isError: true };
    }
    return this.executeTool(call.name, call.args, call.id);
  }

  private async executeTool(name: string, args: Record<string, unknown>, toolCallId: string): Promise<ToolOutcome> {
    const loopKey = toolLoopKey(name, args);
    const repeatedCount = (this.repeatedToolCalls.get(loopKey) ?? 0) + 1;
    this.repeatedToolCalls.set(loopKey, repeatedCount);
    if (repeatedCount >= LOOP_DETECTION_HARD_COUNT) {
      return { content: loopHardStopContent(name, repeatedCount), isError: true };
    }
    if (repeatedCount >= LOOP_DETECTION_WARN_COUNT) {
      return { content: loopWarningContent(name, repeatedCount), isError: false };
    }
    const tool = this.tools.get(name);
    if (!tool) return { content: `Unknown tool: ${name}`, isError: true };
    try {
      const result = await tool.execute(toolCallId ?? randomUUID(), args as never, this.controller?.signal);
      const text = result.content.map((item) => ("text" in item ? item.text : "")).join("\n");
      // Remote content is attacker-influenceable and enters the model context
      // verbatim: neutralize forged framework tags before it is stored or shown.
      return { content: isRemoteContentTool(name) ? neutralizeUntrustedTags(text) : text, isError: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const invocationError = error && typeof error === "object" && "invocation" in error
        ? (error as {
            invocation?: {
              attempts?: unknown[];
              error?: { code?: string; retryAfterMs?: number; retryable?: boolean };
            };
          }).invocation
        : undefined;
      return {
        content: JSON.stringify({
          error: {
            attempts: invocationError?.attempts?.length ?? 1,
            code: invocationError?.error?.code ?? "TOOL_EXECUTION_FAILED",
            message: message.slice(0, 1_000),
            ...(invocationError?.error?.retryAfterMs !== undefined ? { retryAfterMs: invocationError.error.retryAfterMs } : {}),
            retryable: invocationError?.error?.retryable ?? false,
          },
          ok: false,
        }),
        isError: true,
      };
    }
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** Build the same workspace tools as before, so handlers + governance are unchanged. */
function buildTools(options: NativeAgentOptions): AgentTool[] {
  return createWorkspaceTools(options.workspaceRoot, {
    enabledConnectorIds: options.enabledConnectorIds,
    ...(options.environments ? { environments: options.environments } : {}),
    ...(options.environmentManagement ? { environmentManagement: options.environmentManagement } : {}),
    ...(options.runSubagent ? { runSubagent: options.runSubagent } : {}),
    executePython: options.executePython,
    executeShell: options.executeShell,
    ...(options.executeScientific ? { executeScientific: options.executeScientific } : {}),
    ...(options.npuBroker ? { npuBroker: options.npuBroker } : {}),
    ...(options.artifactDownload ? { artifactDownload: options.artifactDownload } : {}),
    ...(options.declareArtifact ? { declareArtifact: options.declareArtifact } : {}),
    ...(options.listArtifacts ? { listArtifacts: options.listArtifacts } : {}),
    ...(options.readArtifact ? { readArtifact: options.readArtifact } : {}),
    ...(options.mcpTools ? { mcpTools: options.mcpTools } : {}),
    ...(options.paperExtractPdf ? { paperExtractPdf: options.paperExtractPdf } : {}),
    ...(options.readOnlyWorkspaceRoot ? { readOnlyWorkspaceRoot: options.readOnlyWorkspaceRoot } : {}),
    ...(options.webFetch ? { webFetch: options.webFetch } : {}),
    ...(options.webSearch ? { webSearch: options.webSearch } : {}),
    ...(options.proposePlan ? { proposePlan: options.proposePlan } : {}),
    ...(options.queryGraph ? { queryGraph: options.queryGraph } : {}),
    ...(options.declareEvidence ? { declareEvidence: options.declareEvidence } : {}),
    ...(options.declareClaim ? { declareClaim: options.declareClaim } : {}),
    ...(options.reviewCheckpoint ? { reviewCheckpoint: options.reviewCheckpoint } : {}),
    ...(options.proposeRemoteJob ? { proposeRemoteJob: options.proposeRemoteJob } : {}),
    remoteHosts: options.remoteHosts ?? [],
    skills: options.skills ?? [],
    specialists: options.specialists ?? [],
    toolPolicy: options.toolPolicy,
  });
}

export function createNativeAgent(options: NativeAgentOptions): NativeAgentHandle {
  return new NativeAgent(options);
}
