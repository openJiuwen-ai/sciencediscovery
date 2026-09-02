// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { ModelInput, WireToolSpec } from "@sciencediscovery/model";
import type { ContextAssembler, ContextAssembly, RuntimeMessage } from "@sciencediscovery/runtime-core";

import { applyContextBudget, type ContextBudgetConfig } from "./budget.js";
import {
  ContextCollectionError,
  type AgentScope,
  type CollectedContext,
  type ContextCollectionReport,
  type ContextContributorRegistry,
} from "./contributor.js";
import type { HistoryCompactionStatistics, HistoryCompactor } from "./history-compactor.js";
import {
  AtomicHistoryWindowPolicy,
  type HistoryWindowPolicy,
  type HistoryWindowStatistics,
} from "./history-window.js";
import {
  DefaultContextMessageComposer,
  type ContextMessageComposer,
} from "./message-composer.js";
import type { ContextAssemblyMode } from "./mode.js";
import {
  DeterministicSystemPromptRenderer,
  type SystemPromptRenderer,
} from "./prompt-renderer.js";
import {
  ConservativeTokenEstimator,
  type TokenEstimator,
} from "./token-estimator.js";
import { ContextValidator } from "./validator.js";

export interface DynamicRenderedContext<TMessage extends RuntimeMessage = RuntimeMessage> {
  compaction: HistoryCompactionStatistics;
  diagnostics: CollectedContext<TMessage>["diagnostics"];
  history: TMessage[];
  sectionIds: string[];
  statistics: HistoryWindowStatistics;
  systemPrompt: string;
  tools: WireToolSpec[];
}

export interface DynamicContextTrace<TMessage extends RuntimeMessage = RuntimeMessage> {
  admitted?: CollectedContext<TMessage>;
  collection?: ContextCollectionReport<TMessage>;
  error?: string;
  modelInput?: ModelInput<TMessage>;
  mode: ContextAssemblyMode;
  recovery?: { attempt: 1; reason: "model-input-overflow" };
  rendered?: DynamicRenderedContext<TMessage>;
  turn: number;
  used: "dynamic" | "legacy";
}

export interface DynamicContextAssemblerOptions<TMessage extends RuntimeMessage> {
  budget: ContextBudgetConfig;
  compactor: HistoryCompactor<TMessage>;
  contextId: string;
  messageComposer?: ContextMessageComposer<TMessage>;
  mode: Exclude<ContextAssemblyMode, "legacy">;
  onTrace?(trace: DynamicContextTrace<TMessage>): void | Promise<void>;
  promptRenderer?: SystemPromptRenderer;
  registry: ContextContributorRegistry<TMessage>;
  scope: AgentScope;
  systemPrompt: string;
  tokenEstimator?: TokenEstimator<TMessage>;
  tools(): WireToolSpec[];
  validator?: ContextValidator<TMessage>;
  windowPolicy?: HistoryWindowPolicy<TMessage>;
}

/** Pure Node dynamic context assembly; canonical history remains authoritative. */
export class DynamicContextAssembler<TMessage extends RuntimeMessage>
implements ContextAssembler<TMessage, ModelInput<TMessage>> {
  private readonly messageComposer: ContextMessageComposer<TMessage>;
  private readonly promptRenderer: SystemPromptRenderer;
  private readonly tokenEstimator: TokenEstimator<TMessage>;
  private readonly validator: ContextValidator<TMessage>;
  private readonly windowPolicy: HistoryWindowPolicy<TMessage>;

  constructor(private readonly options: DynamicContextAssemblerOptions<TMessage>) {
    this.messageComposer = options.messageComposer ?? new DefaultContextMessageComposer<TMessage>();
    this.promptRenderer = options.promptRenderer ?? new DeterministicSystemPromptRenderer();
    this.tokenEstimator = options.tokenEstimator ?? new ConservativeTokenEstimator<TMessage>();
    this.validator = options.validator ?? new ContextValidator<TMessage>();
    this.windowPolicy = options.windowPolicy ?? new AtomicHistoryWindowPolicy<TMessage>();
  }

  async assemble(input: {
    history: readonly TMessage[];
    onProgress: () => void;
    recovery?: { attempt: 1; reason: "model-input-overflow" };
    signal: AbortSignal;
    turn: number;
  }): Promise<ContextAssembly<TMessage, ModelInput<TMessage>>> {
    const tools = this.options.tools().map((tool) => structuredClone(tool));
    const preliminary = await this.options.compactor.compactDetailed(
      input.history,
      input.signal,
      input.onProgress,
      { estimator: this.tokenEstimator },
    );
    let history = preliminary.history;
    let legacy: ContextAssembly<TMessage, ModelInput<TMessage>> = {
      history,
      modelInput: { history, systemPrompt: this.options.systemPrompt, tools },
    };
    let collection: ContextCollectionReport<TMessage> | undefined;
    let admitted: CollectedContext<TMessage> | undefined;
    let rendered: DynamicRenderedContext<TMessage> | undefined;
    try {
      const collect = async (visibleHistory: readonly TMessage[]) => {
        collection = await this.options.registry.collectDetailed({
          contextId: this.options.contextId,
          history: visibleHistory,
          scope: this.options.scope,
          signal: input.signal,
          turn: input.turn,
        });
        admitted = applyContextBudget(collection.collected, this.options.budget);
        return { admitted, prompt: this.promptRenderer.render(admitted.sections) };
      };
      let collected = await collect(history);
      let prompt = collected.prompt;
      let invocationContext = this.messageComposer.compose({
        attachments: collected.admitted.attachments,
        history: [],
        messages: collected.admitted.messages,
      });
      let reservedTokens = this.tokenEstimator.estimateSystemPrompt(prompt.systemPrompt)
        + this.tokenEstimator.estimateTools(tools);
      const invocationContextTokens = invocationContext.reduce(
        (total, message) => total + this.tokenEstimator.estimateMessage(message),
        0,
      );
      const modelInputLimit = this.options.budget.modelContextTokens !== undefined
        ? this.options.budget.modelContextTokens - (this.options.budget.outputReserveTokens ?? 0)
        : undefined;
      if (modelInputLimit !== undefined && modelInputLimit <= 0) {
        throw new Error("Context output reserve leaves no tokens for model input");
      }
      const configuredWindow = this.options.budget.windowTokens;
      const maxTokens = configuredWindow === undefined
        ? modelInputLimit
        : modelInputLimit === undefined ? configuredWindow : Math.min(configuredWindow, modelInputLimit);
      const pressureTokens = maxTokens === undefined ? undefined : Math.max(
        1,
        Math.floor(maxTokens * this.options.budget.compactionPressurePercent / 100)
          - reservedTokens - invocationContextTokens,
      );
      const retainTokens = maxTokens === undefined ? undefined : Math.max(
        1,
        Math.floor(maxTokens * this.options.budget.compactionRetainPercent / 100),
      );
      const compacted = await this.options.compactor.compactDetailed(
        history,
        input.signal,
        input.onProgress,
        {
          estimator: this.tokenEstimator,
          ...(input.recovery ? { force: true } : {}),
          ...(pressureTokens !== undefined ? { pressureTokens } : {}),
          ...(retainTokens !== undefined ? { retainTokens } : {}),
        },
      );
      history = compacted.history;
      if (compacted.statistics.prunedToolResults > 0 || compacted.statistics.summarizedMessages > 0) {
        // Contributor projections such as active Skill visibility depend on
        // the final model-visible history, not the pre-compaction transcript.
        collected = await collect(history);
        prompt = collected.prompt;
        invocationContext = this.messageComposer.compose({
          attachments: collected.admitted.attachments,
          history: [],
          messages: collected.admitted.messages,
        });
        reservedTokens = this.tokenEstimator.estimateSystemPrompt(prompt.systemPrompt)
          + this.tokenEstimator.estimateTools(tools);
      }
      const compaction: HistoryCompactionStatistics = {
        afterTokens: compacted.statistics.afterTokens ?? preliminary.statistics.afterTokens,
        beforeTokens: preliminary.statistics.beforeTokens,
        prunedToolResults: preliminary.statistics.prunedToolResults + compacted.statistics.prunedToolResults,
        reason: compacted.statistics.reason === "none" ? preliminary.statistics.reason : compacted.statistics.reason,
        summarizedMessages: preliminary.statistics.summarizedMessages + compacted.statistics.summarizedMessages,
      };
      legacy = { history, modelInput: { history, systemPrompt: this.options.systemPrompt, tools } };
      const invocationHistory = this.messageComposer.compose({
        attachments: collected.admitted.attachments,
        history,
        messages: collected.admitted.messages,
      });
      const window = this.windowPolicy.select(invocationHistory, {
        ...(this.options.budget.windowMessages !== undefined
          ? { maxMessages: this.options.budget.windowMessages }
          : {}),
        ...(this.options.budget.windowRounds !== undefined
          ? { maxRounds: this.options.budget.windowRounds }
          : {}),
        ...(maxTokens !== undefined
          ? { maxTokens }
          : {}),
        reservedTokens,
      }, this.tokenEstimator);
      if (maxTokens !== undefined && window.statistics.estimatedInputTokens > maxTokens) {
        throw new Error(
          `Required model input needs approximately ${window.statistics.estimatedInputTokens} tokens, exceeding the model-aware input budget ${maxTokens} after output reservation`,
        );
      }
      const modelInput: ModelInput<TMessage> = {
        history: window.history,
        systemPrompt: prompt.systemPrompt,
        tools,
      };
      this.validator.validate(
        modelInput,
        collected.admitted.sections.filter((section) => section.protected),
        tools,
      );
      rendered = {
        compaction,
        diagnostics: window.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          contributorId: "context.window",
        })),
        history: structuredClone(window.history),
        sectionIds: prompt.sectionIds,
        statistics: window.statistics,
        systemPrompt: prompt.systemPrompt,
        tools: structuredClone(tools),
      };
      if (this.options.mode === "shadow") {
        await this.options.onTrace?.({
          admitted, collection, mode: "shadow", modelInput: legacy.modelInput,
          recovery: input.recovery, rendered, turn: input.turn, used: "legacy",
        });
        return legacy;
      }
      await this.options.onTrace?.({
        admitted, collection, mode: "dynamic", modelInput,
        recovery: input.recovery, rendered, turn: input.turn, used: "dynamic",
      });
      return { history, modelInput };
    } catch (error) {
      if (error instanceof ContextCollectionError) collection = error.report;
      const message = error instanceof Error ? error.message : String(error);
      await this.options.onTrace?.({
        admitted, collection, error: message, mode: this.options.mode,
        modelInput: legacy.modelInput, recovery: input.recovery, rendered, turn: input.turn,
        used: this.options.mode === "shadow" ? "legacy" : "dynamic",
      });
      if (this.options.mode === "shadow") return legacy;
      throw error;
    }
  }
}
