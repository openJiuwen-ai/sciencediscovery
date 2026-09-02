// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { RuntimeMessage } from "@sciencediscovery/runtime-core";

import {
  buildSummaryPrompt,
  isSummaryCheckpointMessage,
  planCompaction,
  planTokenCompaction,
  summaryCheckpointMessage,
} from "./compaction.js";
import { flattenHistoryUnits, historyUnits } from "./history-units.js";
import type { TokenEstimator } from "./token-estimator.js";

export type SummaryGenerator = (prompt: string, signal: AbortSignal, onProgress: () => void) => Promise<string>;

export type CompactionReason = "forced" | "message-count" | "none" | "token-pressure";

export interface HistoryCompactionOptions<TMessage extends RuntimeMessage> {
  estimator?: TokenEstimator<TMessage>;
  /** Force one aggressive pass after a provider rejects the assembled input. */
  force?: boolean;
  /** Recent canonical-history suffix kept verbatim during summarization. */
  retainTokens?: number;
  /** Start deterministic pruning/summary when history exceeds this size. */
  pressureTokens?: number;
}

export interface HistoryCompactionStatistics {
  afterTokens?: number;
  beforeTokens?: number;
  prunedToolResults: number;
  reason: CompactionReason;
  summarizedMessages: number;
}

export interface HistoryCompactionResult<TMessage extends RuntimeMessage> {
  history: TMessage[];
  statistics: HistoryCompactionStatistics;
}

const PRUNED_TOOL_RESULT = "[tool result compacted; original retained in run record]";

function tokenCount<TMessage extends RuntimeMessage>(history: readonly TMessage[], estimator: TokenEstimator<TMessage>): number {
  return history.reduce((total, message) => total + estimator.estimateMessage(message), 0);
}

function toolReference(content: unknown): string | undefined {
  if (typeof content !== "string") return undefined;
  return /\bref "(tool-output-[0-9a-f]+)"/u.exec(content)?.[1];
}

function pruneOldToolResults<TMessage extends RuntimeMessage>(
  history: readonly TMessage[],
  estimator: TokenEstimator<TMessage>,
  retainTokens: number,
  targetTokens: number,
  force: boolean,
): { history: TMessage[]; pruned: number } {
  const units = historyUnits(history);
  const protectedUnits = new Set<number>();
  let recentTokens = 0;
  for (let index = units.length - 1; index >= 0 && recentTokens < Math.max(1, retainTokens); index -= 1) {
    protectedUnits.add(index);
    recentTokens += tokenCount(units[index]!.messages, estimator);
  }
  units.forEach((unit, index) => {
    if (!unit.closed) protectedUnits.add(index);
  });

  let pruned = 0;
  const outputUnits = units.map((unit) => ({ ...unit, messages: unit.messages.map((message) => structuredClone(message)) }));
  const candidates = outputUnits.flatMap((unit, unitIndex) => unit.messages.flatMap((message, messageIndex) => {
    if (!unit.closed || message.role !== "tool") return [];
    return [{ messageIndex, protected: protectedUnits.has(unitIndex), unitIndex }];
  })).sort((left, right) => {
    // Normal pressure consumes old results before touching the recent tail.
    // Forced recovery may start at the oldest result regardless of the tail.
    if (!force && left.protected !== right.protected) return left.protected ? 1 : -1;
    return left.unitIndex - right.unitIndex || left.messageIndex - right.messageIndex;
  });
  for (const candidate of candidates) {
    if (tokenCount(flattenHistoryUnits(outputUnits), estimator) <= targetTokens) break;
    const message = outputUnits[candidate.unitIndex]!.messages[candidate.messageIndex]!;
    const reference = toolReference(message.content);
    const marker = reference
      ? `${PRUNED_TOOL_RESULT}\nref=${reference}; use read_tool_output for details.`
      : PRUNED_TOOL_RESULT;
    if (typeof message.content === "string" && message.content === marker) continue;
    pruned += 1;
    outputUnits[candidate.unitIndex]!.messages[candidate.messageIndex] = {
      ...message,
      content: marker,
    } as TMessage;
  }
  return { history: flattenHistoryUnits(outputUnits), pruned };
}

/** Context policy adapter; summary failures are non-fatal, cancellation is not. */
export class HistoryCompactor<TMessage extends RuntimeMessage> {
  constructor(private readonly summarize: SummaryGenerator) {}

  async compact(
    history: readonly TMessage[],
    signal: AbortSignal,
    onProgress: () => void,
    options: HistoryCompactionOptions<TMessage> = {},
  ): Promise<TMessage[]> {
    return (await this.compactDetailed(history, signal, onProgress, options)).history;
  }

  async compactDetailed(
    history: readonly TMessage[],
    signal: AbortSignal,
    onProgress: () => void,
    options: HistoryCompactionOptions<TMessage> = {},
  ): Promise<HistoryCompactionResult<TMessage>> {
    let copy = structuredClone([...history]);
    const beforeTokens = options.estimator ? tokenCount(copy, options.estimator) : undefined;
    const tokenPressure = beforeTokens !== undefined && options.pressureTokens !== undefined
      && beforeTokens > options.pressureTokens;
    const messagePressure = copy.length >= 50;
    const reason: CompactionReason = options.force ? "forced"
      : tokenPressure ? "token-pressure"
        : messagePressure ? "message-count" : "none";
    if (reason === "none") {
      return { history: copy, statistics: { beforeTokens, afterTokens: beforeTokens, prunedToolResults: 0, reason, summarizedMessages: 0 } };
    }

    let prunedToolResults = 0;
    if (options.estimator && options.retainTokens !== undefined) {
      const pruningTarget = options.force
        ? options.retainTokens
        : options.pressureTokens ?? options.retainTokens;
      const pruned = pruneOldToolResults(
        copy,
        options.estimator,
        options.retainTokens,
        pruningTarget,
        options.force === true,
      );
      copy = pruned.history;
      prunedToolResults = pruned.pruned;
      const prunedTokens = tokenCount(copy, options.estimator);
      if (!options.force && tokenPressure && !messagePressure && options.pressureTokens !== undefined
        && prunedTokens <= options.pressureTokens) {
        return { history: copy, statistics: {
          afterTokens: prunedTokens, beforeTokens, prunedToolResults, reason, summarizedMessages: 0,
        } };
      }
    }

    const plan = (tokenPressure || options.force) && options.estimator && options.retainTokens !== undefined
      ? planTokenCompaction(copy, { estimator: options.estimator, retainTokens: options.retainTokens })
      : planCompaction(copy);
    if (!plan) {
      const afterTokens = options.estimator ? tokenCount(copy, options.estimator) : undefined;
      return { history: copy, statistics: { afterTokens, beforeTokens, prunedToolResults, reason, summarizedMessages: 0 } };
    }
    let summaryText: string;
    try {
      summaryText = await this.summarize(buildSummaryPrompt(plan), signal, onProgress);
    } catch (error) {
      if (signal.aborted) throw error;
      const afterTokens = options.estimator ? tokenCount(copy, options.estimator) : undefined;
      return { history: copy, statistics: { afterTokens, beforeTokens, prunedToolResults, reason, summarizedMessages: 0 } };
    }
    const checkpoint = summaryCheckpointMessage(summaryText);
    const compacted = checkpoint
      ? [checkpoint as TMessage, ...plan.preserved as TMessage[]]
      : copy;
    // Defensive invariant: there is exactly one standing checkpoint.
    const normalized = compacted.filter((message, index) =>
      !isSummaryCheckpointMessage(message) || index === compacted.findIndex(isSummaryCheckpointMessage));
    return { history: normalized, statistics: {
      afterTokens: options.estimator ? tokenCount(normalized, options.estimator) : undefined,
      beforeTokens,
      prunedToolResults,
      reason,
      summarizedMessages: checkpoint ? plan.toSummarize.length : 0,
    } };
  }
}
