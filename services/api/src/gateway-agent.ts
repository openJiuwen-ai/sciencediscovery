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

import { createHash, randomUUID } from "node:crypto";
import { request } from "undici";

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

/**
 * The agent engine: drives one loop turn on the gateway sidecar
 * (services/gateway) and translates its NDJSON stream into `AgentEvent`s for
 * `streamAgentRun` (server.ts).
 *
 * Each run sends the gateway everything it needs:
 *   - the workspace system prompt (skills, governance)
 *   - the session's live tool set as specs (name/description/JSON schema)
 *   - the session's model profile (base_url / api_key / model)
 *   - the full conversation history in OpenAI message format
 * The gateway is stateless: each execution returns `final_messages`; the
 * RequestExecution orchestrator explicitly hands that transcript to a later
 * AgentRun (for example Reviewer correction), with Node as system of record.
 *
 * Every tool the loop calls round-trips back here over HTTP: the gateway's
 * proxy tools POST to the Node `/internal/tool-exec` endpoint, which resolves
 * this run via `toolCallbackRegistry` and executes the SAME
 * `createWorkspaceTools` handlers — keeping the bubblewrap runner, permission
 * gate, and provenance exactly where they already are.
 */

export interface ToolCallbackResult {
  content: string;
  isError: boolean;
}

export type ToolCallbackHandler = (
  name: string,
  args: Record<string, unknown>,
  toolCallId: string | null,
) => Promise<ToolCallbackResult>;

/** callback_token -> the run's tool executor. Read by the tool-exec route. */
export const toolCallbackRegistry = new Map<string, ToolCallbackHandler>();

export interface GatewayAgentOptions extends WorkspaceAgentOptions {
  /** Stable thread id for gateway-side logging/tracing; use the session id. */
  sessionId: string;
  /** Base URL of the gateway sidecar, e.g. http://127.0.0.1:4312 */
  gatewayUrl: string;
  /** URL the gateway's proxy tools call back into (this API's tool-exec route). */
  callbackUrl: string;
  /** Hard deadline for one complete gateway /run, including streamed output. */
  runTimeoutMs?: number;
  /** Maximum time without receiving any gateway response bytes. */
  runIdleTimeoutMs?: number;
  /** Canonical gateway transcript handed off by a preceding AgentRun. */
  gatewayHistory?: AgentHistoryMessage[];
  /** Runtime-pinned request/task contract preserved outside compactable history. */
  runContract?: string;
}

type Listener = (event: AgentEvent) => void;

/** OpenAI-format chat message, kept opaque: the gateway produces and consumes it. */
type WireMessage = AgentHistoryMessage;
type GatewayRunBody = AsyncIterable<Uint8Array> & { dump: () => Promise<void> };
export type GatewayRunRequest = typeof request;
let gatewayRunRequest: GatewayRunRequest = request;

const LOOP_DETECTION_WARN_COUNT = 10;
const LOOP_DETECTION_HARD_COUNT = 20;

export function setGatewayRunRequestForTest(requestImpl: GatewayRunRequest): () => void {
  const previous = gatewayRunRequest;
  gatewayRunRequest = requestImpl;
  return () => {
    gatewayRunRequest = previous;
  };
}

export interface GatewayAgentRunResult {
  finalMessages: AgentHistoryMessage[];
}

export interface GatewayAgentHandle extends Agent {
  execute(text: string): Promise<GatewayAgentRunResult>;
}

interface GatewayEvent {
  type: "messages-tuple" | "end" | "error";
  data: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeGatewayHistoryMessage(message: WireMessage): WireMessage {
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

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const raw = value[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
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

export function parseGatewayUsage(data: Record<string, unknown>): { usage?: AgentModelUsage; usageReported: boolean } {
  const usage = isRecord(data.usage) ? data.usage : undefined;
  const inputTokens = usage ? numberField(usage, "input_tokens") : undefined;
  const outputTokens = usage ? numberField(usage, "output_tokens") : undefined;
  const totalTokens = usage
    ? numberField(usage, "total_tokens") ?? (
        inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined
      )
    : undefined;
  const cacheReadTokens = usage ? numberField(usage, "cache_read_tokens") : undefined;
  const cacheWriteTokens = usage ? numberField(usage, "cache_write_tokens") : undefined;
  const legacyReported = usage !== undefined && (inputTokens !== undefined || outputTokens !== undefined || totalTokens !== undefined);
  const usageReported = data.usage_reported === true || legacyReported;
  if (!usageReported || inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) {
    return { usageReported: false };
  }
  return {
    usage: {
      inputTokens,
      outputTokens,
      totalTokens,
      ...(cacheReadTokens !== undefined ? { cacheReadTokens } : { cacheReadTokens: null }),
      ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : { cacheWriteTokens: null }),
    },
    usageReported: true,
  };
}

export const DEFAULT_GATEWAY_IDLE_TIMEOUT_MS = 240_000;
export const DEFAULT_GATEWAY_TURN_TIMEOUT_MS = 0;

export function isGatewayToolError(content: string, status?: string): boolean {
  return status === "error" || /^(?:Tool error|Tool callback transport error):/i.test(content.trim());
}

class GatewayAgent implements GatewayAgentHandle {
  private readonly listeners = new Set<Listener>();
  private readonly tools = new Map<string, AgentTool>();
  private readonly repeatedToolCalls = new Map<string, number>();
  private readonly callbackToken = randomUUID();
  private readonly systemPrompt: string;
  private history: WireMessage[];
  private controller: AbortController | undefined;
  private startedToolCalls = new Set<string>();
  private seenTurnIds = new Set<string>();
  private turnText = "";
  private turnFinalMessages: WireMessage[] | undefined;
  private externalWaitCount = 0;
  private pauseRunDeadline: (() => void) | undefined;
  private resumeRunDeadline: (() => void) | undefined;
  private abortRequested = false;
  private executed = false;
  private readonly gatewaySkills: NonNullable<GatewayAgentOptions["skills"]>;

  constructor(private readonly options: GatewayAgentOptions) {
    for (const tool of buildTools(options)) {
      if (this.tools.has(tool.name)) throw new Error(`Duplicate workspace tool name: ${tool.name}`);
      this.tools.set(tool.name, tool);
    }
    const promptSkills = this.tools.has("describe_skill") && this.tools.has("read_skill")
      ? options.skills
      : [];
    this.gatewaySkills = promptSkills ?? [];
    // Same prompt assembly as createWorkspaceAgent (runtime.ts).
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
    ].filter(Boolean).join("\n\n");
    // Same seeding as pi's convertHistory: prior turns replay as plain text.
    this.history = options.gatewayHistory
      ? options.gatewayHistory.map(normalizeGatewayHistoryMessage)
      : (options.history ?? []).map((message) => ({ role: message.role, content: message.content }));
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

  /** Execute one gateway /run and return its canonical transcript for an explicit handoff. */
  async execute(text: string): Promise<GatewayAgentRunResult> {
    if (this.executed) throw new Error("Gateway agent handle has already been executed");
    this.executed = true;
    this.controller = new AbortController();
    if (this.abortRequested) this.controller.abort();
    this.startedToolCalls = new Set();
    this.seenTurnIds = new Set();
    this.turnText = "";
    this.turnFinalMessages = undefined;
    this.history.push({ role: "user", content: text });

    const controller = this.controller;
    const runTimeoutMs = this.options.runTimeoutMs ?? DEFAULT_GATEWAY_TURN_TIMEOUT_MS;
    const runIdleTimeoutMs = this.options.runIdleTimeoutMs ?? DEFAULT_GATEWAY_IDLE_TIMEOUT_MS;
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
    const markGatewayProgress = () => {
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
      markGatewayProgress();
    };
    armTurnDeadline();
    markGatewayProgress();

    const timeoutError = () => timeoutKind === "idle"
      ? new Error(`Agent run stalled: no gateway progress for ${runIdleTimeoutMs} ms`)
      : new Error(`Agent run timeout: gateway turn exceeded ${runTimeoutMs} ms`);

    try {
      let responseBody: GatewayRunBody;
      let statusCode: number;
      try {
        const response = await gatewayRunRequest(`${this.options.gatewayUrl}/run`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            thread_id: this.options.sessionId,
            messages: this.history,
            system_prompt: this.systemPrompt,
            tools: [...this.tools.values()].filter((tool) => tool.name !== "describe_skill").map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters as unknown,
              ...(tool.deferred ? { deferred: true } : {}),
              ...(tool.mcp ? { source_id: tool.mcp.sourceId, tool_id: tool.mcp.toolId } : {}),
              ...(tool.routing ? { routing: tool.routing } : {}),
            })),
            skills: this.gatewaySkills.map((skill) => ({
              description: skill.description,
              hash: skill.hash,
              id: skill.id,
              resources: skill.resources,
              revision: skill.revision,
              version: skill.version,
            })),
            model: {
              base_url: this.options.config.baseUrl,
              api_key: this.options.config.apiToken,
              model: this.options.config.model,
              // Mirrors the pi model spec (model.ts maxTokens).
              max_tokens: 16_384,
              ...(this.options.config.proxy ? { proxy: this.options.config.proxy } : {}),
            },
            callback_url: this.options.callbackUrl,
            callback_token: this.callbackToken,
          }),
          bodyTimeout: 0,
          signal: controller.signal,
        });
        statusCode = response.statusCode;
        responseBody = response.body;
      } catch (error) {
        if (timeoutKind) throw timeoutError();
        if (controller.signal.aborted) throw new Error("Agent run cancelled");
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Gateway is unavailable: ${message}`);
      }
      if (statusCode < 200 || statusCode >= 300) {
        await responseBody.dump();
        throw new Error(`Gateway run failed with status ${statusCode}`);
      }
      markGatewayProgress();

      // The registry is live only while a turn runs, so tool callbacks resolve to
      // this run and nothing leaks between turns or after completion.
      toolCallbackRegistry.set(this.callbackToken, this.executeTool);
      try {
        for await (const event of readNdjson(responseBody, markGatewayProgress)) {
          this.handleGatewayEvent(event);
        }
      } catch (error) {
        // Keep "timeout" in this error: classifySubagentFailure uses /timeout/i
        // to preserve the public Subagent timed_out status.
        if (timeoutKind) throw timeoutError();
        if (controller.signal.aborted) throw new Error("Agent run cancelled");
        throw error;
      } finally {
        toolCallbackRegistry.delete(this.callbackToken);
      }

      // Adopt the gateway's canonical transcript (history + this run's tool
      // calls/results) for explicit handoff to a later AgentRun. Fall back to
      // text-only accumulation if the run ended without a final snapshot.
      // Read through a method: TS narrows
      // the field to `undefined` here because it cannot see the mutation inside
      // handleGatewayEvent.
      const finalMessages = this.takeFinalMessages();
      if (finalMessages) {
        this.history = finalMessages.filter((message) => message.role !== "system");
      } else if (this.turnText) {
        this.history.push({ role: "assistant", content: this.turnText });
      }
      return { finalMessages: structuredClone(this.history) };
    } finally {
      if (turnTimeoutId) clearTimeout(turnTimeoutId);
      if (idleTimeoutId) clearTimeout(idleTimeoutId);
      this.pauseRunDeadline = undefined;
      this.resumeRunDeadline = undefined;
      this.externalWaitCount = 0;
    }
  }

  private takeFinalMessages(): WireMessage[] | undefined {
    return this.turnFinalMessages;
  }

  private handleGatewayEvent(event: GatewayEvent): void {
    if (event.type === "error") {
      throw new Error(String((event.data as { message?: string }).message ?? "Gateway run failed"));
    }
    if (event.type === "end") {
      const end = event.data as {
        final_messages?: WireMessage[];
        usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
      };
      const finalMessages = end.final_messages;
      if (Array.isArray(finalMessages)) this.turnFinalMessages = finalMessages;
      const modelUsage = parseGatewayUsage(event.data);
      this.emit({ type: "model_usage", ...modelUsage });
      if (modelUsage.usage) {
        this.emit({
          type: "usage",
          usage: modelUsage.usage,
        });
      }
      return;
    }
    if (event.type !== "messages-tuple") return;
    const data = event.data as {
      type?: string;
      content?: string;
      thinking?: string;
      id?: string;
      tool_calls?: Array<{ name?: string; args?: Record<string, unknown>; id?: string | null }>;
      tool_call_id?: string;
      name?: string;
      status?: string;
    };

    if (data.type === "ai") {
      // Each distinct assistant message id is one model turn of the loop.
      if (data.id && !this.seenTurnIds.has(data.id)) {
        this.seenTurnIds.add(data.id);
        this.emit({ type: "turn_start" });
      }
      if (data.tool_calls?.length) {
        for (const call of data.tool_calls) {
          if (call.id && call.name && !this.startedToolCalls.has(call.id)) {
            this.startedToolCalls.add(call.id);
            this.emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.args ?? {} });
          }
        }
        return;
      }
      if (data.thinking) {
        this.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: data.thinking } });
        return;
      }
      if (data.content) {
        this.turnText += data.content;
        this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: data.content } });
      }
      return;
    }

    if (data.type === "tool" && data.tool_call_id) {
      const content = data.content ?? "";
      this.emit({
        type: "tool_execution_end",
        toolCallId: data.tool_call_id,
        toolName: data.name ?? "",
        result: { content: [{ type: "text", text: content }], details: {} },
        isError: isGatewayToolError(content, data.status),
      });
    }
  }

  private executeTool: ToolCallbackHandler = async (name, args, toolCallId) => {
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
      return { content: text, isError: false };
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
  };

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** Build the same workspace tools pi would, so their handlers + governance run on callback. */
function buildTools(options: GatewayAgentOptions): AgentTool[] {
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

/** Parse a response body stream of newline-delimited JSON into GatewayEvents. */
async function* readNdjson(
  body: AsyncIterable<Uint8Array>,
  onProgress: () => void,
): AsyncGenerator<GatewayEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const value of body) {
    onProgress();
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line) as GatewayEvent;
      newline = buffer.indexOf("\n");
    }
  }
  const tail = buffer.trim();
  if (tail) yield JSON.parse(tail) as GatewayEvent;
}

export function createGatewayAgent(options: GatewayAgentOptions): GatewayAgentHandle {
  return new GatewayAgent(options);
}
