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

import { createHash, randomUUID } from "node:crypto";

import {
  ContextContributorRegistry,
  captureStateView,
  canonicalState,
  ContextSectionContributor,
  createDurableDomainContributors,
  createContextTraceWriter,
  DefaultContextAssembler,
  DurableContextStore,
  DynamicContextAssembler,
  HistoryCompactor,
  resolveContextBudget,
  resolveContextAssemblyMode,
  registerContextContributorFactories,
  type AgentScope,
  type ContextAssemblyMode,
  type ContextContributorFactory,
  type StateView,
  type StateProvider,
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
import type { PlanStore } from "@sciencediscovery/plan";
import type { EvolveToolRuntime } from "@sciencediscovery/evolve";
import {
  DEFAULT_MAX_PARALLEL_TOOL_CALLS,
  ExternalWaitController,
  resolveMaxParallelToolCalls,
  type RunEvent,
} from "@sciencediscovery/runtime-core";
import {
  createToolOutputTools,
  resolveToolOutputSettings,
  ToolOutputGuard,
  ToolOutputReadTracker,
  toolOutputStoreRoot,
  ToolOutputStore,
  ToolRegistry,
  type AgentTool,
} from "@sciencediscovery/tools";
import {
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
import { AgentVersionRecorder, jsonValue, type AgentVersioningOptions } from "./versioning.js";
import { createRuntimePluginScope } from "../plugins/runtime.js";

export const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 240_000;
export const DEFAULT_AGENT_TURN_TIMEOUT_MS = 0;

/** Hard safety net against a runaway model loop; time budgets remain the
 *  primary bound (`runTimeoutMs` / `runIdleTimeoutMs`). */
const MAX_MODEL_TURNS = 128;

export function configuredMaxParallelToolCalls(
  raw = process.env.SCIENCE_AGENT_MAX_PARALLEL_TOOL_CALLS,
): number {
  const value = raw?.trim();
  if (!value) return DEFAULT_MAX_PARALLEL_TOOL_CALLS;
  try {
    return resolveMaxParallelToolCalls(Number(value));
  } catch {
    throw new Error("SCIENCE_AGENT_MAX_PARALLEL_TOOL_CALLS must be a positive integer");
  }
}

export interface NativeAgentOptions extends WorkspaceAgentOptions {
  versioning?: AgentVersioningOptions;
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
  stateProviders?: readonly StateProvider[];
  disabledPlugins?: readonly string[];
  pluginSettings?: import("@sciencediscovery/plugin-sdk").PluginSettingsMap;
  /** Run-scoped Plan snapshot projection; when present, registers update_plan and context injection. */
  /** The `/evolve-design` capability for this turn, or absent when the deployment has
   *  none. One object instead of two forwarded callbacks and a deps bundle
   *  threaded through three run-loop entry points. */
  evolve?: EvolveToolRuntime;
  planStore?: PlanStore;
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

/** The model endpoint a run talks to; shared by every executor so a model is reached the same way. */
export function modelEndpointFor(options: Pick<NativeAgentOptions, "config">): ModelEndpoint {
  const thinking = process.env.SCIENCE_AGENT_AGENT_THINKING?.trim();
  return {
    ...(options.config.apiProtocol ? { apiProtocol: options.config.apiProtocol } : {}),
    ...(options.config.apiVariant ? { apiVariant: options.config.apiVariant } : {}),
    baseUrl: options.config.baseUrl,
    ...(options.config.apiToken ? { apiToken: options.config.apiToken } : {}),
    model: options.config.model,
    ...(options.config.thinkingEffort ? { thinkingEffort: options.config.thinkingEffort } : {}),
    ...(options.config.thinkingMode ? { thinkingMode: options.config.thinkingMode } : {}),
    ...(options.config.proxy ? { proxy: options.config.proxy } : {}),
    ...(thinking === "disabled" || thinking === "enabled" ? { thinking } : {}),
  } as ModelEndpoint;
}

export function formatRunContract(contract: string): string {
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

/**
 * Start the plugin scope for a run: the plugin-contributed tools (plan, subagent
 * dispatch, evolve, ...) live here, not in buildTools. Shared by every executor.
 * `runSubagent` lets the caller observe delegated children.
 */
export async function startPluginScope(
  options: NativeAgentOptions,
  durable: DurableContextStore,
  signal: AbortSignal,
  runSubagent?: WorkspaceAgentOptions["runSubagent"],
) {
  const plugins = await createRuntimePluginScope<WireMessage>({
    scope: options.contextScope ?? (options.subagent?.name === "Reviewer Specialist" ? "reviewer" : options.subagent ? "subagent" : "main"),
    planStore: options.planStore,
    evolve: options.evolve,
    workspace: { ...options, ...(runSubagent ?? options.runSubagent ? { runSubagent: runSubagent ?? options.runSubagent } : {}) },
    durable,
  }, options.disabledPlugins, options.pluginSettings);
  await plugins.start(signal);
  return plugins;
}

/** Every execution tool one run gets: the workspace tools plus what plugins contribute. */
export function pluginTools(plugins: Awaited<ReturnType<typeof startPluginScope>>): AgentTool[] {
  return plugins.contributions.flatMap((item) => item.tools);
}

/**
 * The registry every run dispatches tool calls through: the workspace and plugin tools plus the
 * tool-output reader, with the output guard (size bounds, references for oversized results),
 * detail sanitisation, neutralisation of untrusted remote content and loop protection. Shared by
 * every executor so a tool behaves the same wherever the model loop runs.
 */
export function createToolRegistry(
  options: NativeAgentOptions,
  plugins: Awaited<ReturnType<typeof startPluginScope>>,
  durable: DurableContextStore,
  hooks: { recordResult?: (input: Parameters<NonNullable<ConstructorParameters<typeof ToolRegistry<WireMessage>>[1]["recordResult"]>>[0]) => Promise<void> } = {},
): ToolRegistry<WireMessage> {
  const executionTools = buildTools(options);
  // Retained per Session, not per AgentRun: a bounded result stays in the
  // replayed history of later runs, so its ref has to keep resolving for as
  // long as that history does. Session deletion removes this directory.
  const toolOutputStore = new ToolOutputStore({
    root: toolOutputStoreRoot(options.config.dataDir, options.sessionId),
  });
  const toolOutputSettings = resolveToolOutputSettings();
  return new ToolRegistry([
    ...executionTools, ...plugins.contributions.flatMap((item) => item.tools),
    ...createToolOutputTools(toolOutputStore, {
      tracker: new ToolOutputReadTracker(toolOutputSettings.readPolicy),
    }),
  ], {
    batchPolicies: plugins.contributions.flatMap((item) => item.batchPolicies),
    createResultMessage: (call, content, output) => ({
      role: "tool", tool_call_id: call.id, name: call.name, content,
      ...(output ? { additional_kwargs: { tool_output: output } } : {}),
    }),
    commitResult: async ({ call, content, isError, sequence }) => {
      durable.observe(call, { content, isError }, sequence);
      for (const contribution of plugins.contributions) {
        await contribution.commitResult?.({ call, content, isError, sequence });
      }
    },
    recordResult: hooks.recordResult,
    outputGuard: new ToolOutputGuard({
      maxBytes: toolOutputSettings.maxBytes,
      maxLines: toolOutputSettings.maxLines,
      retentionBytes: toolOutputSettings.retentionBytes,
      sink: toolOutputStore,
    }),
  });
}

/**
 * The system prompt an agent for these options gets, and its parts. Shared by every
 * executor so the model is told the same thing wherever the loop runs.
 */
export function composeSystemPrompt(
  options: NativeAgentOptions,
  toolNames: ReadonlySet<string>,
  promptSkills: RuntimeSkill[],
  toolPromptSections: readonly string[] = [],
): { parts: WorkspacePromptPart[]; systemPrompt: string } {
  const governance = {
    localRunnerAllowed: options.localRunnerAllowed,
    ...(options.approvalMode ? { approvalMode: options.approvalMode } : {}),
    ...(options.memoryGraphEnabled ? { memoryGraphEnabled: options.memoryGraphEnabled } : {}),
    ...(options.remoteRunners?.length ? { remoteRunners: options.remoteRunners.map((runner) => `${runner.runnerId}: ${runner.description || runner.hostAlias}`) } : {}),
    ...(options.specialist ? { specialist: options.specialist } : {}),
    ...(options.workflowInstructions ? { workflowInstructions: options.workflowInstructions } : {}),
    ...(options.specialists?.filter((specialist) => specialist.builtIn).length
      ? { builtinSpecialists: options.specialists!.filter((specialist) => specialist.builtIn).map((specialist) => ({ description: specialist.description, name: specialist.name })) }
      : {}),
    ...(options.subagent ? { subagent: options.subagent } : {}),
    ...(toolNames.has("task") && !options.subagent ? { subagentOrchestration: true } : {}),
  };
  const baseSystemPrompt = buildWorkspaceSystemPrompt(promptSkills, Boolean(options.environments), governance);
  return {
    parts: buildWorkspacePromptParts(promptSkills, Boolean(options.environments), governance),
    systemPrompt: [
      baseSystemPrompt,
      options.runContract ? formatRunContract(options.runContract) : "",
      ...toolPromptSections,
    ].filter(Boolean).join("\n\n"),
  };
}

class NativeAgent implements NativeAgentHandle {
  private readonly listeners = new Set<Listener>();
  private toolRegistry!: ToolRegistry<WireMessage>;
  private systemPrompt!: string;
  private promptParts!: WorkspacePromptPart[];
  private promptSkills!: RuntimeSkill[];
  private endpoint!: ModelEndpoint;
  private policy!: ModelClientPolicy;
  private readonly waitController = new ExternalWaitController();
  private readonly durableContext: DurableContextStore;
  private history: WireMessage[] = [];
  private controller: AbortController | undefined;
  private externalWaitCount = 0;
  private pauseRunDeadline: (() => void) | undefined;
  private resumeRunDeadline: (() => void) | undefined;
  private abortRequested = false;
  private executed = false;
  private readonly contextId: string;
  private requestText: string | undefined;
  private versionRecorder?: AgentVersionRecorder<WireMessage, ModelInput<WireMessage>, ModelUsage>;
  private inputState?: StateView;
  private inputStateTurn?: number;
  private plugins?: Awaited<ReturnType<typeof createRuntimePluginScope<WireMessage>>>;

  constructor(private readonly options: NativeAgentOptions) {
    this.contextId = `${options.sessionId}:${randomUUID()}`;
    this.durableContext = new DurableContextStore({
      history: options.gatewayHistory,
      ...(options.runContract ? { runContract: options.runContract } : {}),
    });
  }

  private async initialize(signal: AbortSignal): Promise<void> {
    const options = this.options;
    this.plugins = await startPluginScope(options, this.durableContext, signal, options.runSubagent ? async (...args) => {
      const result = await options.runSubagent!(...args);
      this.versionRecorder?.childCompleted(`subagent:${result.id}`);
      return result;
    } : undefined);
    this.toolRegistry = createToolRegistry(options, this.plugins, this.durableContext, {
      recordResult: options.versioning ? async (input) => { await this.versionRecorder?.recordObservation(input); } : undefined,
    });
    const toolNames = new Set(this.toolRegistry.values().map((tool) => tool.name));
    this.promptSkills = toolNames.has("read_skill")
      ? (options.skills ?? [])
      : [];
    const composed = composeSystemPrompt(options, toolNames, this.promptSkills, this.toolRegistry.promptSections());
    this.promptParts = composed.parts;
    this.systemPrompt = composed.systemPrompt;
    this.history = (options.gatewayHistory ?? options.history ?? []).map(normalizeHistoryMessage);
    // Reasoning models bill hidden thought against the same `max_tokens` as
    // the answer, and on some endpoints the agent loop spends a whole turn on
    // it — tens of thousands of characters, no visible text, no tool call.
    // Raising the token ceiling only buys a longer spiral, so the lever is the
    // toggle itself. Left unset by default: for most models the loop's own
    // reasoning is what makes it work. This belongs on the model profile
    // eventually; until then it is one switch for the deployment.
    this.endpoint = modelEndpointFor(options);
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
    try {
      await this.initialize(this.controller.signal);
    } catch (error) {
      await this.plugins?.dispose();
      if (this.controller.signal.aborted) throw new Error("Agent run cancelled");
      throw error;
    }
    this.requestText = text;
    this.history.push({ role: "user", content: text });
    this.toolRegistry.promoteForRequest(text);

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
      if (this.externalWaitCount > 0) {
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
    if (this.externalWaitCount > 0) this.pauseRunDeadline();
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
      if (this.options.versioning) {
        this.versionRecorder = new AgentVersionRecorder(this.options.config.dataDir, this.options.workspaceRoot,
          this.options.versioning, () => this.runtimeState());
        await this.versionRecorder.initialize({
          plugins: this.plugins?.manifests ?? [],
          pluginSettings: this.options.pluginSettings ?? {},
          pluginStatuses: this.plugins?.status ?? [],
          model: { model: this.endpoint.model, apiProtocol: this.endpoint.apiProtocol,
            apiVariant: this.endpoint.apiVariant, policy: this.policy,
            thinkingMode: this.endpoint.thinkingMode, thinkingEffort: this.endpoint.thinkingEffort,
            provider: (() => { const url = new URL(this.endpoint.baseUrl); return `${url.origin}${url.pathname}`; })() },
          contextAssembler: {
            entrypoint: "NativeAgent.createContextRegistry",
            contributors: this.options.contextContributorFactories?.map((factory) => ({ id: factory.id, implementation: factory.create.toString() })) ?? [],
          },
          tools: this.toolRegistry.values().map((tool) => ({ name: tool.name, description: tool.description,
            parameters: tool.parameters, implementation: tool.execute.toString(),
            deferred: tool.deferred, routing: tool.routing, mcp: tool.mcp })),
          skills: this.promptSkills.map(({ id, hash, revision, version }) => ({ id, hash, revision, version })),
          toolBindings: this.options.mcpTools?.map((tool) => ({ sourceId: tool.sourceId, toolId: tool.toolId, implementation: tool.execute.toString() })) ?? [],
          specialist: this.options.specialist ?? null,
          subagent: this.options.subagent ?? null,
        }, this.history);
      }
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
      const contextBudget = resolveContextBudget(process.env, {
        ...(this.options.config.contextWindow ? { modelContextTokens: this.options.config.contextWindow } : {}),
        outputReserveTokens: this.policy.maxTokens,
      });
      const traceWriter = createContextTraceWriter(this.options.config.dataDir);
      const writeTrace = async (turn: number, record: Record<string, unknown>) => {
        this.versionRecorder?.trace(record);
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
          budget: contextBudget,
          compactor,
          onAssembled: async (assembly, turn) => writeTrace(turn, {
            contextConfig: { budget: contextBudget, mode: contextMode, scope: contextScope },
            llmInput: assembly.modelInput,
            selectedPath: "legacy",
          }),
          systemPrompt: this.systemPrompt,
          tools: () => this.inputState!.read<{ specs: ReturnType<ToolRegistry<WireMessage>["visibleSpecs"]> }>("tools").specs,
        })
        : new DynamicContextAssembler<WireMessage>({
          stateView: () => {
            if (!this.inputState) throw new Error("Agent input state is not captured");
            return this.inputState;
          },
          budget: contextBudget,
          compactor,
          contextId: this.contextId,
          mode: contextMode,
          onTrace: async (trace) => {
            const planProgress = trace.admitted?.diagnostics
              .find((diagnostic) => diagnostic.code === "PLAN_PROGRESS_OBSERVATION")?.details;
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
              ...(planProgress ? { planProgress } : {}),
              ...(trace.rendered ? {
                compactionAfterTokens: trace.rendered.compaction.afterTokens,
                compactionBeforeTokens: trace.rendered.compaction.beforeTokens,
                compactionReason: trace.rendered.compaction.reason,
                prunedToolResults: trace.rendered.compaction.prunedToolResults,
                summarizedMessages: trace.rendered.compaction.summarizedMessages,
                summaryAttempts: trace.rendered.compaction.summaryAttempts,
                summaryCheckpointTokens: trace.rendered.compaction.summaryCheckpointTokens,
                summaryRejected: trace.rendered.compaction.summaryRejected,
                summarySourceTokens: trace.rendered.compaction.summarySourceTokens,
                summaryValidationWarningCount: trace.rendered.compaction.summaryValidationWarnings?.length ?? 0,
                toolOutputRefCount: trace.rendered.compaction.toolOutputRefs?.length ?? 0,
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
              ...(planProgress ? { planProgress } : {}),
              renderedContext: trace.rendered,
              ...(trace.recovery ? { recovery: trace.recovery } : {}),
              selectedPath: trace.used,
            });
          },
          registry: this.createContextRegistry(contextScope),
          scope: contextScope,
          systemPrompt: this.systemPrompt,
          tools: () => this.inputState!.read<{ specs: ReturnType<ToolRegistry<WireMessage>["visibleSpecs"]> }>("tools").specs,
        });
      const modelClient = new ProviderModelClient<WireMessage>(this.endpoint, this.policy, modelTurnStreamer);
      let reportedModelUsage = false;
      const loop = composeRuntime<WireMessage, ModelInput<WireMessage>, ModelUsage>({
        maxModelTurns: MAX_MODEL_TURNS,
        maxParallelToolCalls: configuredMaxParallelToolCalls(),
        contextAssembler: {
          assemble: async (input) => {
            // Overflow retries change the history window, not the underlying facts.
            if (!input.recovery || this.inputStateTurn !== input.turn || !this.inputState) {
              const provider = (id: string, read: () => unknown | Promise<unknown>, fidelity: "captured" | "reference-only" = "captured"): StateProvider => ({
                id,
                capture: async () => {
                  const value = jsonValue(await read());
                  return { id, schemaVersion: 1, revision: createHash("sha256").update(canonicalState(value)).digest("hex"), value, fidelity };
                },
              });
              this.inputState = await captureStateView({
                id: `${this.contextId}:${input.turn}`,
                scope: this.options.sessionId,
                signal: input.signal,
                providers: [
                  provider("context.durable", () => this.durableContext.snapshot()),
                  provider("tools", () => ({ snapshot: this.toolRegistry.snapshot(), promptSections: this.toolRegistry.promptSections(), specs: this.toolRegistry.visibleSpecs() })),
                  provider("runtime", () => this.runtimeState()),
                  provider("authorities", async () => await this.options.versioning?.readAuthorities?.() ?? null, "reference-only"),
                  ...(this.versionRecorder ? [this.versionRecorder.workspaceStateProvider()] : []),
                  ...(this.plugins?.contributions.flatMap((item) => item.stateProviders) ?? []),
                  ...(this.options.stateProviders ?? []),
                ],
              });
              this.inputStateTurn = input.turn;
            }
            await this.versionRecorder?.captureInputState(this.inputState, input.turn, [...input.history]);
            return contextAssembler.assemble(input);
          },
        },
        modelClient: {
          isInputTooLargeError: error => modelClient.isInputTooLargeError(error),
          invoke: async (input, signal, observer) => {
            const result = await modelClient.invoke(input, signal, observer);
            await this.versionRecorder?.modelCompleted(result);
            return result;
          },
        },
        toolDispatcher: this.toolRegistry,
        eventSink: (event) => {
          this.emitRuntimeEvent(event, this.versionRecorder?.event(event));
          if (event.type === "model_usage") reportedModelUsage = true;
        },
        turnLifecycle: this.versionRecorder,
        waitController: this.waitController,
      });
      const result = await loop.run(this.history, controller.signal, markProgress)
        .catch((error: unknown) => raiseForAbort(error));
      this.history = result.history;
      const usage = result.usage;
      if (!reportedModelUsage) this.emit({ type: "model_usage", ...(usage ? { usage, usageReported: true } : { usageReported: false }) });
      if (usage) this.emit({ type: "usage", usage });
      return { finalMessages: structuredClone(this.history.filter((message) => message.role !== "system")) };
    } finally {
      await this.versionRecorder?.flushEvents().catch((error: unknown) => console.error("Trajectory event flush failed", error instanceof Error ? error.message : "unknown error"));
      this.versionRecorder?.close();
      if (turnTimeoutId) clearTimeout(turnTimeoutId);
      if (idleTimeoutId) clearTimeout(idleTimeoutId);
      this.pauseRunDeadline = undefined;
      this.resumeRunDeadline = undefined;
      this.externalWaitCount = 0;
      await this.plugins?.dispose();
    }
  }

  private runtimeState() {
    return {
            toolState: this.toolRegistry.snapshot(),
            runContract: this.options.runContract ?? null,
            contextProjection: this.durableContext.snapshot(),
            contextInputs: { systemPrompt: this.systemPrompt, promptParts: this.promptParts,
              scope: this.options.contextScope ?? (this.options.subagent ? "subagent" : "main") },
            environments: this.options.environments ?? [],
            approvalMode: this.options.approvalMode ?? null,
            contextMode: this.options.contextAssemblyMode ?? resolveContextAssemblyMode(),

    };
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
    registry.register(new ContextSectionContributor<WireMessage>({
      id: "tools.capabilities",
      stateReads: ["tools"],
      scopes: [scope],
      contribute: async ({ stateView }) => {
        const content = (stateView ? stateView.read<{ promptSections: string[] }>("tools").promptSections : this.toolRegistry.promptSections()).filter(Boolean).join("\n\n");
        return content ? { systemSections: [{ content, id: "tools.capabilities", order: 100, slot: "capabilities" }] } : {};
      },
    }));
    for (const contributor of createDurableDomainContributors<WireMessage>(this.durableContext, [scope])) {
      registry.register(contributor);
    }
    registerContextContributorFactories(
      registry,
      [
        ...(this.plugins?.contributions.flatMap((item) => item.contextFactories) ?? []),
        ...(this.options.contextContributorFactories ?? []),
      ],
      { contextId: this.contextId, scope },
    );
    return registry.freeze();
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private emitRuntimeEvent(event: RunEvent<ModelUsage>, evidence?: import("@sciencediscovery/schema").AgentEventEvidence): void {
    const emit = (value: AgentEvent) => this.emit({ ...value, ...(evidence ? { evidence } : {}) });
    switch (event.type) {
      case "turn_start":
        emit({ type: "turn_start" });
        break;
      case "response_start":
        emit({ responseId: event.responseId, turn: event.turn, type: "response_start" });
        break;
      case "model_delta":
        emit({
          type: "message_update",
          assistantMessageEvent: event.kind === "text"
            ? { type: "text_delta", delta: event.delta, responseId: event.responseId }
            : { type: "thinking_delta", delta: event.delta, responseId: event.responseId },
        });
        break;
      case "response_settled":
        emit({ responseId: event.responseId, turn: event.turn, type: "response_settled" });
        break;
      case "tool_execution_start":
        emit({
          type: "tool_execution_start",
          toolCallId: event.call.id,
          toolName: event.call.name,
          args: event.call.args,
        });
        break;
      case "tool_execution_end":
        emit({
          type: "tool_execution_end",
          toolCallId: event.call.id,
          toolName: event.call.name,
          result: {
            content: [{ type: "text", text: event.content }],
            ...(event.details !== undefined ? { details: event.details } : {}),
          },
          isError: event.isError,
        });
        break;
      case "model_usage":
        emit({ type: "model_usage", usage: event.usage, usageReported: true });
        break;
      case "completed":
        if (event.truncated) emit({ type: "turn_truncated" });
        break;
      case "context_recovery":
      case "state_changed":
        break;
    }
  }
}

/** Build the same workspace tools as before, so handlers + governance are unchanged.
 *
 *  Exported for tests: every option here is forwarded by hand, so an option
 *  added at both ends but missed in the middle leaves its tool absent from the
 *  model's list with nothing failing anywhere. */
/** The execution tools one run gets; also what another executor must expose. */
export function buildTools(options: NativeAgentOptions): AgentTool[] {
  return createWorkspaceTools(options.workspaceRoot, {
    enabledConnectorIds: options.enabledConnectorIds,
    ...(options.extraTools?.length ? { extraTools: options.extraTools } : {}),
    ...(options.environments ? { environments: options.environments } : {}),
    ...(options.environmentManagement ? { environmentManagement: options.environmentManagement } : {}),
    executePython: options.executePython,
    executeShell: options.executeShell,
    ...(options.executeScientific ? { executeScientific: options.executeScientific } : {}),
    ...(options.npuBroker ? { npuBroker: options.npuBroker } : {}),
    ...(options.artifactDownload ? { artifactDownload: options.artifactDownload } : {}),
    ...(options.materializeArtifact ? { materializeArtifact: options.materializeArtifact } : {}),
    ...(options.declareArtifact ? { declareArtifact: options.declareArtifact } : {}),
    ...(options.getFileProvenance ? { getFileProvenance: options.getFileProvenance } : {}),
    ...(options.listArtifacts ? { listArtifacts: options.listArtifacts } : {}),
    ...(options.readArtifact ? { readArtifact: options.readArtifact } : {}),
    ...(options.paperExtractPdf ? { paperExtractPdf: options.paperExtractPdf } : {}),
    ...(options.readOnlyWorkspaceRoot ? { readOnlyWorkspaceRoot: options.readOnlyWorkspaceRoot } : {}),
    ...(options.skillPackagesRoot ? { skillPackagesRoot: options.skillPackagesRoot } : {}),
    ...(options.webFetch ? { webFetch: options.webFetch } : {}),
    ...(options.webSearch ? { webSearch: options.webSearch } : {}),
    ...(options.queryGraph ? { queryGraph: options.queryGraph } : {}),
    ...(options.declareEvidence ? { declareEvidence: options.declareEvidence } : {}),
    ...(options.declareClaim ? { declareClaim: options.declareClaim } : {}),
    ...(options.reviewCheckpoint ? { reviewCheckpoint: options.reviewCheckpoint } : {}),
    localRunnerAllowed: options.localRunnerAllowed,
    ...(options.remoteRunners ? { remoteRunners: options.remoteRunners } : {}),
    ...(options.workspaceTransfers ? { workspaceTransfers: options.workspaceTransfers } : {}),
    ...(options.shellExecutions ? { shellExecutions: options.shellExecutions } : {}),
    ...(options.timers ? { timers: options.timers } : {}),
    specialists: options.specialists ?? [],
    toolPolicy: options.toolPolicy,
  });
}

export function createNativeAgent(options: NativeAgentOptions): NativeAgentHandle {
  return new NativeAgent(options);
}
