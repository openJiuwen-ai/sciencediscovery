// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { WireToolSpec } from "@sciencediscovery/model";
import type { RuntimeMessage } from "@sciencediscovery/runtime-core";

export interface TokenEstimator<TMessage extends RuntimeMessage = RuntimeMessage> {
  estimateMessage(message: TMessage): number;
  estimateSystemPrompt(systemPrompt: string): number;
  estimateTools(tools: readonly WireToolSpec[]): number;
}

function conservativeTokens(value: unknown): number {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  // A deliberately conservative provider-neutral approximation for mixed
  // Chinese/English scientific text. Providers may inject an exact tokenizer.
  return Math.max(1, Math.ceil((serialized?.length ?? 0) / 2));
}

export class ConservativeTokenEstimator<TMessage extends RuntimeMessage = RuntimeMessage>
implements TokenEstimator<TMessage> {
  estimateMessage(message: TMessage): number {
    return conservativeTokens(message) + 8;
  }

  estimateSystemPrompt(systemPrompt: string): number {
    return conservativeTokens(systemPrompt);
  }

  estimateTools(tools: readonly WireToolSpec[]): number {
    return tools.length ? conservativeTokens(tools) : 0;
  }
}
