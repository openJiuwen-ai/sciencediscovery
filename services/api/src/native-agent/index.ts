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

import {
  buildWorkspaceSystemPrompt,
  DefaultContextAssembler,
  HistoryCompactor,
  type WorkspaceAgentOptions,
} from "@science-agent/context";
import {
  resolveModelClientPolicy,
  ProviderModelClient,
  streamModelTurn,
  type ModelInput,
  type ModelClientPolicy,
  type ModelEndpoint,
  type ModelUsage,
} from "@science-agent/model";
import type { Agent, AgentEvent, AgentHistoryMessage } from "@science-agent/orchestration";
import {
  ExternalWaitController,
  type RunEvent,
} from "@science-agent/runtime-core";
import {
  type AgentTool,
  ToolRegistry,
} from "@science-agent/tools";
import { createWorkspaceTools, normalizeLegacyEnvironmentToolName } from "@science-agent/workspace";

import { composeRuntime } from "../bootstrap/runtime.js";

export const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 240_000;
export const DEFAULT_AGENT_TURN_TIMEOUT_MS = 0;

/** Hard safety net against a runaway model loop; time budgets remain the
 *  primary bound (`runTimeoutMs` / `runIdleTimeoutMs`). */
const MAX_MODEL_TURNS = 128;

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

class NativeAgent implements NativeAgentHandle {
  private readonly listeners = new Set<Listener>();
  private readonly toolRegistry: ToolRegistry<WireMessage>;
  private readonly systemPrompt: string;
  private readonly endpoint: ModelEndpoint;
  private readonly policy: ModelClientPolicy;
  private readonly waitController = new ExternalWaitController();
  private history: WireMessage[];
  private controller: AbortController | undefined;
  private externalWaitCount = 0;
  private pauseRunDeadline: (() => void) | undefined;
  private resumeRunDeadline: (() => void) | undefined;
  private abortRequested = false;
  private executed = false;

  constructor(private readonly options: NativeAgentOptions) {
    this.toolRegistry = new ToolRegistry(buildTools(options), {
      createResultMessage: (call, content) => ({
        role: "tool", tool_call_id: call.id, name: call.name, content,
      }),
    });
    const toolNames = new Set(this.toolRegistry.values().map((tool) => tool.name));
    const promptSkills = toolNames.has("describe_skill") && toolNames.has("read_skill")
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
      ...this.toolRegistry.promptSections(),
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
    const wait = this.waitController.begin("agent-run");
    this.externalWaitCount += 1;
    if (this.externalWaitCount === 1) this.pauseRunDeadline?.();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      wait.release();
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
    this.toolRegistry.promoteForRequest(text);

    const controller = this.controller;
    const runTimeoutMs = this.options.runTimeoutMs ?? DEFAULT_AGENT_TURN_TIMEOUT_MS;
    const runIdleTimeoutMs = this.options.runIdleTimeoutMs ?? DEFAULT_AGENT_IDLE_TIMEOUT_MS;
    const startedWithExternalWait = this.externalWaitCount > 0;
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
      if (startedWithExternalWait && this.externalWaitCount > 0) {
        idleTimeoutId = undefined;
        return;
      }
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
    if (startedWithExternalWait) this.pauseRunDeadline();
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

    try {
      const compactor = new HistoryCompactor<WireMessage>(async (prompt, signal, onProgress) => {
        const summaryTurn = await modelTurnStreamer(
          this.endpoint,
          "You compact conversation history into dense, factual summaries.",
          [{ role: "user", content: prompt }],
          [],
          this.policy,
          signal,
          { onProgress },
        );
        return typeof summaryTurn.assistantMessage.content === "string" ? summaryTurn.assistantMessage.content : "";
      });
      const contextAssembler = new DefaultContextAssembler<WireMessage>({
        compactor,
        systemPrompt: this.systemPrompt,
        tools: () => this.toolRegistry.visibleSpecs(),
      });
      const modelClient = new ProviderModelClient<WireMessage>(this.endpoint, this.policy, modelTurnStreamer);
      const loop = composeRuntime<WireMessage, ModelInput<WireMessage>, ModelUsage>({
        maxModelTurns: MAX_MODEL_TURNS,
        contextAssembler,
        modelClient,
        toolDispatcher: this.toolRegistry,
        eventSink: (event) => this.emitRuntimeEvent(event),
        waitController: this.waitController,
      });
      const result = await loop.run(this.history, controller.signal, markProgress)
        .catch((error: unknown) => raiseForAbort(error));
      this.history = result.history;
      const usage = result.usage;
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

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private emitRuntimeEvent(event: RunEvent<ModelUsage>): void {
    switch (event.type) {
      case "turn_start":
        this.emit({ type: "turn_start" });
        break;
      case "model_delta":
        this.emit({
          type: "message_update",
          assistantMessageEvent: event.kind === "text"
            ? { type: "text_delta", delta: event.delta }
            : { type: "thinking_delta", delta: event.delta },
        });
        break;
      case "tool_execution_start":
        this.emit({
          type: "tool_execution_start",
          toolCallId: event.call.id,
          toolName: event.call.name,
          args: event.call.args,
        });
        break;
      case "tool_execution_end":
        this.emit({
          type: "tool_execution_end",
          toolCallId: event.call.id,
          toolName: event.call.name,
          result: { content: [{ type: "text", text: event.content }], details: {} },
          isError: event.isError,
        });
        break;
      case "completed":
      case "state_changed":
        break;
    }
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
