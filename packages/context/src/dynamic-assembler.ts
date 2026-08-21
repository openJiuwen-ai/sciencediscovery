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
import type { HistoryCompactor } from "./history-compactor.js";
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
    signal: AbortSignal;
    turn: number;
  }): Promise<ContextAssembly<TMessage, ModelInput<TMessage>>> {
    const history = await this.options.compactor.compact(input.history, input.signal, input.onProgress);
    const tools = this.options.tools().map((tool) => structuredClone(tool));
    const legacy: ContextAssembly<TMessage, ModelInput<TMessage>> = {
      history,
      modelInput: { history, systemPrompt: this.options.systemPrompt, tools },
    };
    let collection: ContextCollectionReport<TMessage> | undefined;
    let admitted: CollectedContext<TMessage> | undefined;
    let rendered: DynamicRenderedContext<TMessage> | undefined;
    try {
      collection = await this.options.registry.collectDetailed({
        contextId: this.options.contextId,
        history,
        scope: this.options.scope,
        signal: input.signal,
        turn: input.turn,
      });
      admitted = applyContextBudget(collection.collected, this.options.budget);
      const prompt = this.promptRenderer.render(admitted.sections);
      const invocationHistory = this.messageComposer.compose({
        attachments: admitted.attachments,
        history,
        messages: admitted.messages,
      });
      const reservedTokens = this.tokenEstimator.estimateSystemPrompt(prompt.systemPrompt)
        + this.tokenEstimator.estimateTools(tools);
      const window = this.windowPolicy.select(invocationHistory, {
        ...(this.options.budget.windowMessages !== undefined
          ? { maxMessages: this.options.budget.windowMessages }
          : {}),
        ...(this.options.budget.windowRounds !== undefined
          ? { maxRounds: this.options.budget.windowRounds }
          : {}),
        ...(this.options.budget.windowTokens !== undefined
          ? { maxTokens: this.options.budget.windowTokens }
          : {}),
        reservedTokens,
      }, this.tokenEstimator);
      const modelInput: ModelInput<TMessage> = {
        history: window.history,
        systemPrompt: prompt.systemPrompt,
        tools,
      };
      this.validator.validate(
        modelInput,
        admitted.sections.filter((section) => section.protected),
        tools,
      );
      rendered = {
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
          rendered, turn: input.turn, used: "legacy",
        });
        return legacy;
      }
      await this.options.onTrace?.({
        admitted, collection, mode: "dynamic", modelInput,
        rendered, turn: input.turn, used: "dynamic",
      });
      return { history, modelInput };
    } catch (error) {
      if (error instanceof ContextCollectionError) collection = error.report;
      const message = error instanceof Error ? error.message : String(error);
      await this.options.onTrace?.({
        admitted, collection, error: message, mode: this.options.mode,
        modelInput: legacy.modelInput, rendered, turn: input.turn, used: "legacy",
      });
      if (this.options.mode === "shadow") return legacy;
      throw error;
    }
  }
}
