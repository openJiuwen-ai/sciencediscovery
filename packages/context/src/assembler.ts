// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { ModelInput, WireToolSpec } from "@science-agent/model";
import type { ContextAssembler, ContextAssembly, RuntimeMessage } from "@science-agent/runtime-core";

import type { HistoryCompactor } from "./history-compactor.js";

export interface ContextAssemblerOptions<TMessage extends RuntimeMessage> {
  compactor: HistoryCompactor<TMessage>;
  systemPrompt: string;
  tools(): WireToolSpec[];
}

/** Default context port implementation; dynamic contributors belong in #144. */
export class DefaultContextAssembler<TMessage extends RuntimeMessage>
implements ContextAssembler<TMessage, ModelInput<TMessage>> {
  constructor(private readonly options: ContextAssemblerOptions<TMessage>) {}

  async assemble(input: {
    history: readonly TMessage[];
    onProgress: () => void;
    signal: AbortSignal;
    turn: number;
  }): Promise<ContextAssembly<TMessage, ModelInput<TMessage>>> {
    const history = await this.options.compactor.compact(input.history, input.signal, input.onProgress);
    return {
      history,
      modelInput: {
        history,
        systemPrompt: this.options.systemPrompt,
        tools: this.options.tools(),
      },
    };
  }
}
