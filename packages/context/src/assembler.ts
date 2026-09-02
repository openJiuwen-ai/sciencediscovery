// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { ModelInput, WireToolSpec } from "@sciencediscovery/model";
import type { ContextAssembler, ContextAssembly, RuntimeMessage } from "@sciencediscovery/runtime-core";

import type { HistoryCompactor } from "./history-compactor.js";
import type { ContextBudgetConfig } from "./budget.js";
import { ConservativeTokenEstimator, type TokenEstimator } from "./token-estimator.js";

export interface ContextAssemblerOptions<TMessage extends RuntimeMessage> {
  budget?: ContextBudgetConfig;
  compactor: HistoryCompactor<TMessage>;
  onAssembled?(assembly: ContextAssembly<TMessage, ModelInput<TMessage>>, turn: number): void | Promise<void>;
  systemPrompt: string;
  tokenEstimator?: TokenEstimator<TMessage>;
  tools(): WireToolSpec[];
}

/** Default context port implementation; dynamic contributors belong in #144. */
export class DefaultContextAssembler<TMessage extends RuntimeMessage>
implements ContextAssembler<TMessage, ModelInput<TMessage>> {
  private readonly tokenEstimator: TokenEstimator<TMessage>;

  constructor(private readonly options: ContextAssemblerOptions<TMessage>) {
    this.tokenEstimator = options.tokenEstimator ?? new ConservativeTokenEstimator<TMessage>();
  }

  async assemble(input: {
    history: readonly TMessage[];
    onProgress: () => void;
    recovery?: { attempt: 1; reason: "model-input-overflow" };
    signal: AbortSignal;
    turn: number;
  }): Promise<ContextAssembly<TMessage, ModelInput<TMessage>>> {
    const tools = this.options.tools();
    const maxTokens = this.options.budget?.modelContextTokens === undefined
      ? undefined
      : this.options.budget.modelContextTokens - (this.options.budget.outputReserveTokens ?? 0);
    const reservedTokens = this.tokenEstimator.estimateSystemPrompt(this.options.systemPrompt)
      + this.tokenEstimator.estimateTools(tools);
    const history = await this.options.compactor.compact(input.history, input.signal, input.onProgress, {
      estimator: this.tokenEstimator,
      ...(input.recovery ? { force: true } : {}),
      ...(maxTokens !== undefined ? {
        pressureTokens: Math.max(1, Math.floor(maxTokens * this.options.budget!.compactionPressurePercent / 100) - reservedTokens),
        retainTokens: Math.max(1, Math.floor(maxTokens * this.options.budget!.compactionRetainPercent / 100)),
      } : {}),
    });
    const assembly = {
      history,
      modelInput: {
        history,
        systemPrompt: this.options.systemPrompt,
        tools,
      },
    };
    await this.options.onAssembled?.(assembly, input.turn);
    return assembly;
  }
}
