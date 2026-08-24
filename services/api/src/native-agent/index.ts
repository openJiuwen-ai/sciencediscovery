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
 * One `execute()` composes the domain-neutral Runtime Core with the context,
 * model, tool, and workspace capability packages. Runtime Core drives model
 * turns and tool scheduling; this service adapter owns request-scoped timeout,
 * event translation, and the concrete port wiring.
 *
 * History is kept in OpenAI wire format and returned as `finalMessages` for
 * the explicit RequestExecution handoff, exactly like the previous engine.
 * Because assistant messages are stored verbatim (including raw tool-call
 * fields such as Gemini `thought_signature`), provider quirks replay without
 * a patch layer. Deferred tools and keyword auto-promotion come from
 * `packages/tools`; history compaction comes from `packages/context`.
 */

import { randomUUID } from "node:crypto";

import {
  ContextContributorRegistry,
  ContextSectionContributor,
  createDurableDomainContributors,
  createContextTraceWriter,
  DefaultContextAssembler,
  DurableContextStore,
  DurableSkillStateContributor,
  DurableTaskStateContributor,
  DynamicContextAssembler,
  HistoryCompactor,
  resolveContextBudget,
  resolveContextAssemblyMode,
  registerContextContributorFactories,
  type AgentScope,
  type ContextAssemblyMode,
  type ContextContributorFactory,
} from "@sciencediscovery/context";
import {
  resolveModelClientPolicy,
  ProviderModelClient,
  streamModelTurn,
  type ModelInput,
  type ModelClientPolicy,
  type ModelEndpoint,
  type ModelUsage,
} from "@sciencediscovery/model";
import type { Agent, AgentEvent, AgentHistoryMessage } from "@sciencediscovery/orchestration";
import {
  ExternalWaitController,
  type RunEvent,
} from "@sciencediscovery/runtime-core";
import {
  type AgentTool,
  ToolRegistry,
} from "@sciencediscovery/tools";
import {
  buildSkillSystemSection,
  buildWorkspacePromptParts,
  buildWorkspaceSystemPrompt,
  createWorkspaceTools,
  normalizeLegacyEnvironmentToolName,
  type WorkspaceAgentOptions,
  type RuntimeSkill,
  type WorkspacePromptPart,
} from "@sciencediscovery/workspace";

import { composeRuntime } from "../bootstrap/runtime.js";
import { runLog } from "../logging.js";

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
  /** Internal composition seam; production defaults to SCIENCE_AGENT_CONTEXT_MODE. */
  contextAssemblyMode?: ContextAssemblyMode;
  /** Explicit role used to select scoped contributors. */
  contextScope?: AgentScope;
  /** Capability-package extension seam; factories are instantiated and frozen per AgentRun. */
  contextContributorFactories?: readonly ContextContributorFactory<WireMessage>[];
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
  private readonly promptParts: WorkspacePromptPart[];
  private readonly promptSkills: RuntimeSkill[];
  private readonly endpoint: ModelEndpoint;
  private readonly policy: ModelClientPolicy;
  private readonly waitController = new ExternalWaitController();
  private readonly durableContext: DurableContextStore;
  private history: WireMessage[];
  private controller: AbortController | undefined;
  private externalWaitCount = 0;
  private pauseRunDeadline: (() => void) | undefined;
  private resumeRunDeadline: (() => void) | undefined;
  private abortRequested = false;
  private executed = false;
  private readonly contextId: string;

  constructor(private readonly options: NativeAgentOptions) {
    this.contextId = `${options.sessionId}:${randomUUID()}`;
    this.durableContext = new DurableContextStore({
      history: options.gatewayHistory,
      ...(options.runContract ? { runContract: options.runContract } : {}),
    });
    this.toolRegistry = new ToolRegistry(buildTools(options), {
      createResultMessage: (call, content) => ({
        role: "tool", tool_call_id: call.id, name: call.name, content,
      }),
      onResult: ({ call, content, isError, sequence }) => {
        this.durableContext.observe(call, { content, isError }, sequence);
        if (call.name !== "read_skill" || isError || typeof call.args.skillId !== "string") return;
        const skill = options.skills?.find((item) => item.id === call.args.skillId);
        if (skill) this.durableContext.registerSkill({
          description: skill.description,
          hash: skill.hash,
          id: skill.id,
          revision: skill.revision,
          version: skill.version,
        });
      },
    });
    const toolNames = new Set(this.toolRegistry.values().map((tool) => tool.name));
    this.promptSkills = toolNames.has("describe_skill") && toolNames.has("read_skill")
      ? (options.skills ?? [])
      : [];
    const hydratedSkillIds = new Set(this.durableContext.snapshot().skills.map((skill) => skill.id));
    for (const skill of this.promptSkills.filter((item) => hydratedSkillIds.has(item.id))) {
      this.durableContext.registerSkill({
        description: skill.description,
        hash: skill.hash,
        id: skill.id,
        revision: skill.revision,
        version: skill.version,
      });
    }
    const governance = {
      ...(options.approvalMode ? { approvalMode: options.approvalMode } : {}),
      ...(options.memoryGraphEnabled ? { memoryGraphEnabled: options.memoryGraphEnabled } : {}),
      ...(options.remoteHosts ? { remoteHosts: options.remoteHosts } : {}),
      ...(options.specialist ? { specialist: options.specialist } : {}),
      ...(options.specialists?.filter((specialist) => specialist.builtIn).length
        ? { builtinSpecialists: options.specialists!.filter((specialist) => specialist.builtIn).map((specialist) => ({ description: specialist.description, name: specialist.name })) }
        : {}),
      ...(options.subagent ? { subagent: options.subagent } : {}),
      ...(options.runSubagent && !options.subagent ? { subagentOrchestration: true } : {}),
    };
    const baseSystemPrompt = buildWorkspaceSystemPrompt(
      this.promptSkills,
      Boolean(options.environments),
      governance,
    );
    this.promptParts = buildWorkspacePromptParts(this.promptSkills, Boolean(options.environments), governance);
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
      const contextMode = this.options.contextAssemblyMode ?? resolveContextAssemblyMode();
      const contextScope = this.options.contextScope
        ?? (this.options.subagent?.name === "Reviewer Specialist"
          ? "reviewer"
          : this.options.subagent ? "subagent" : "main");
      const contextBudget = resolveContextBudget(process.env, { outputReserveTokens: this.policy.maxTokens });
      const traceWriter = createContextTraceWriter(this.options.config.dataDir);
      const writeTrace = async (turn: number, record: Record<string, unknown>) => {
        if (!traceWriter) return;
        await traceWriter.write(this.contextId, turn, record).catch((error: unknown) => {
          runLog.warn("context.trace_write_failed", {
            contextId: this.contextId,
            errorMessage: error instanceof Error ? error.message : String(error),
            turn,
          });
        });
      };
      const contextAssembler = contextMode === "legacy"
        ? new DefaultContextAssembler<WireMessage>({
          compactor,
          onAssembled: async (assembly, turn) => writeTrace(turn, {
            contextConfig: { budget: contextBudget, mode: contextMode, scope: contextScope },
            llmInput: assembly.modelInput,
            selectedPath: "legacy",
          }),
          systemPrompt: this.systemPrompt,
          tools: () => this.toolRegistry.visibleSpecs(),
        })
        : new DynamicContextAssembler<WireMessage>({
          budget: contextBudget,
          compactor,
          contextId: this.contextId,
          mode: contextMode,
          onTrace: async (trace) => {
            runLog.info("context.assembled", {
              attachmentCount: trace.admitted?.attachments.length ?? 0,
              contextId: this.contextId,
              contributorCount: trace.collection?.contributors.length ?? 0,
              diagnosticCount: trace.admitted?.diagnostics.length
                ?? trace.collection?.collected.diagnostics.length
                ?? 0,
              ...(trace.error ? { errorMessage: trace.error } : {}),
              mode: trace.mode,
              sectionCount: trace.admitted?.sections.length ?? 0,
              turn: trace.turn,
              used: trace.used,
              ...(trace.rendered ? {
                estimatedInputTokens: trace.rendered.statistics.estimatedInputTokens,
                outputMessages: trace.rendered.statistics.outputMessages,
              } : {}),
            });
            await writeTrace(trace.turn, {
              admitted: trace.admitted,
              collection: trace.collection,
              contextConfig: { budget: contextBudget, mode: trace.mode, scope: contextScope },
              ...(trace.error ? { error: trace.error } : {}),
              llmInput: trace.modelInput,
              renderedContext: trace.rendered,
              selectedPath: trace.used,
            });
          },
          registry: this.createContextRegistry(contextScope),
          scope: contextScope,
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

  private createContextRegistry(scope: AgentScope): ContextContributorRegistry<WireMessage> {
    const registry = new ContextContributorRegistry<WireMessage>();
    for (const [order, part] of this.promptParts.filter((item) => item.kind !== "skills").entries()) {
      const slot = part.kind === "identity" ? "identity"
        : part.kind === "governance" ? "governance" : "capabilities";
      registry.register(new ContextSectionContributor<WireMessage>({
        id: part.id,
        scopes: [scope],
        async contribute() {
          return { systemSections: [{
            content: part.content,
            id: part.id,
            order,
            protected: part.protected,
            slot,
          }] };
        },
      }));
    }
    if (this.options.runContract) {
      const runContract = formatRunContract(this.options.runContract);
      registry.register(new ContextSectionContributor<WireMessage>({
        id: "run.contract",
        scopes: [scope],
        async contribute() {
          return { systemSections: [{
            content: runContract,
            id: "run.contract",
            protected: true,
            slot: "run_contract",
          }] };
        },
      }));
    }
    if (this.promptSkills.length) {
      registry.register(new ContextSectionContributor<WireMessage>({
        id: "skills.catalog",
        scopes: [scope],
        contribute: async () => {
          return { systemSections: [{
            // Keep the capability catalog stable for provider prefix caching.
            // Per-turn activation lives in the lower-authority durable data channel.
            content: buildSkillSystemSection(this.promptSkills),
            id: "skills.catalog",
            order: 50,
            slot: "capabilities",
          }] };
        },
      }));
      registry.register(new DurableSkillStateContributor<WireMessage>(this.durableContext, [scope]));
    }
    registry.register(new ContextSectionContributor<WireMessage>({
      id: "tools.capabilities",
      scopes: [scope],
      contribute: async () => {
        const content = this.toolRegistry.promptSections().filter(Boolean).join("\n\n");
        return content ? { systemSections: [{ content, id: "tools.capabilities", order: 100, slot: "capabilities" }] } : {};
      },
    }));
    registry.register(new DurableTaskStateContributor<WireMessage>(this.durableContext, [scope]));
    for (const contributor of createDurableDomainContributors<WireMessage>(this.durableContext, [scope])) {
      registry.register(contributor);
    }
    registerContextContributorFactories(
      registry,
      this.options.contextContributorFactories ?? [],
      { contextId: this.contextId, scope },
    );
    return registry.freeze();
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
