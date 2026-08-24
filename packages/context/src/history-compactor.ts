// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { RuntimeMessage } from "@sciencediscovery/runtime-core";

import { buildSummaryPrompt, planCompaction, summaryCheckpointMessage } from "./compaction.js";

export type SummaryGenerator = (prompt: string, signal: AbortSignal, onProgress: () => void) => Promise<string>;

/** Context policy adapter; summary failures are non-fatal, cancellation is not. */
export class HistoryCompactor<TMessage extends RuntimeMessage> {
  constructor(private readonly summarize: SummaryGenerator) {}

  async compact(history: readonly TMessage[], signal: AbortSignal, onProgress: () => void): Promise<TMessage[]> {
    const copy = structuredClone([...history]);
    const plan = planCompaction(copy);
    if (!plan) return copy;
    let summaryText: string;
    try {
      summaryText = await this.summarize(buildSummaryPrompt(plan), signal, onProgress);
    } catch (error) {
      if (signal.aborted) throw error;
      return copy;
    }
    const checkpoint = summaryCheckpointMessage(summaryText);
    return checkpoint ? [checkpoint as TMessage, ...plan.preserved as TMessage[]] : copy;
  }
}
