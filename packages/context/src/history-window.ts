// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { RuntimeMessage } from "@sciencediscovery/runtime-core";

import type { ContextDiagnostic } from "./contributor.js";
import type { TokenEstimator } from "./token-estimator.js";

export interface HistoryWindowConfig {
  maxMessages?: number;
  maxRounds?: number;
  maxTokens?: number;
  reservedTokens: number;
}

export interface HistoryWindowStatistics {
  estimatedInputTokens: number;
  inputMessages: number;
  outputMessages: number;
  removedMessages: number;
}

export interface HistoryWindowResult<TMessage extends RuntimeMessage> {
  diagnostics: ContextDiagnostic[];
  history: TMessage[];
  statistics: HistoryWindowStatistics;
}

export interface HistoryWindowPolicy<TMessage extends RuntimeMessage> {
  select(
    history: readonly TMessage[],
    config: HistoryWindowConfig,
    estimator: TokenEstimator<TMessage>,
  ): HistoryWindowResult<TMessage>;
}

function isSummaryCheckpoint(message: RuntimeMessage): boolean {
  const additional = message.additional_kwargs;
  return message.name === "summary"
    && typeof additional === "object"
    && additional !== null
    && !Array.isArray(additional)
    && (
      (additional as Record<string, unknown>).sciencediscovery_summary_checkpoint === true
      || (additional as Record<string, unknown>).science_agent_summary_checkpoint === true
    );
}

function isInvocationContext(message: RuntimeMessage): boolean {
  const additional = message.additional_kwargs;
  if (typeof additional !== "object" || additional === null || Array.isArray(additional)) return false;
  const values = additional as Record<string, unknown>;
  return typeof values.context_attachment_id === "string" || values.context_contributor_message === true;
}

function rounds<TMessage extends RuntimeMessage>(history: readonly TMessage[]): TMessage[][] {
  const output: TMessage[][] = [];
  for (const message of history) {
    if (message.role === "user" && !isSummaryCheckpoint(message) && !isInvocationContext(message)) output.push([]);
    if (!output.length) output.push([]);
    output.at(-1)!.push(structuredClone(message));
  }
  return output.filter((round) => round.length > 0);
}

function toolCallIds(message: RuntimeMessage): string[] {
  if (!Array.isArray(message.tool_calls)) return [];
  return message.tool_calls.flatMap((call) => {
    if (typeof call !== "object" || call === null || Array.isArray(call)) return [];
    const id = (call as Record<string, unknown>).id;
    return typeof id === "string" && id ? [id] : [];
  });
}

function atomicUnits<TMessage extends RuntimeMessage>(messages: readonly TMessage[]): TMessage[][] {
  const units: TMessage[][] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    const unit = [structuredClone(message)];
    const calls = new Set(toolCallIds(message));
    while (calls.size && index + 1 < messages.length) {
      const next = messages[index + 1]!;
      const resultId = typeof next.tool_call_id === "string" ? next.tool_call_id : undefined;
      if (next.role !== "tool" || !resultId || !calls.has(resultId)) break;
      unit.push(structuredClone(next));
      index += 1;
    }
    units.push(unit);
  }
  return units;
}

function flatten<TMessage>(groups: readonly TMessage[][]): TMessage[] {
  return groups.flatMap((group) => group);
}

function tokens<TMessage extends RuntimeMessage>(messages: readonly TMessage[], estimator: TokenEstimator<TMessage>): number {
  return messages.reduce((total, message) => total + estimator.estimateMessage(message), 0);
}

/** Recent-window selector that never splits an assistant tool call from its results. */
export class AtomicHistoryWindowPolicy<TMessage extends RuntimeMessage>
implements HistoryWindowPolicy<TMessage> {
  select(
    history: readonly TMessage[],
    config: HistoryWindowConfig,
    estimator: TokenEstimator<TMessage>,
  ): HistoryWindowResult<TMessage> {
    const diagnostic: ContextDiagnostic[] = [];
    const checkpoint = history.find(isSummaryCheckpoint);
    let selected: TMessage[];
    if (config.maxRounds !== undefined) {
      selected = flatten(rounds(history).slice(-config.maxRounds));
    } else if (config.maxMessages !== undefined) {
      const historyRounds = rounds(history);
      const kept: TMessage[][] = historyRounds.length ? [historyRounds.at(-1)!] : [];
      let count = kept[0]?.length ?? 0;
      for (const round of historyRounds.slice(0, -1).toReversed()) {
        if (count + round.length > config.maxMessages) break;
        kept.unshift(round);
        count += round.length;
      }
      selected = flatten(kept);
    } else {
      selected = structuredClone([...history]);
    }

    if (checkpoint && !selected.some(isSummaryCheckpoint)) selected.unshift(structuredClone(checkpoint));

    if (config.maxTokens !== undefined) {
      const units = atomicUnits(selected);
      const minimumUnits = new Set<TMessage[]>();
      const latestUserIndex = units.findLastIndex((unit) => unit.some((message) =>
        message.role === "user" && !isSummaryCheckpoint(message) && !isInvocationContext(message)));
      if (latestUserIndex >= 0) {
        for (const unit of units.slice(latestUserIndex)) minimumUnits.add(unit);
      }
      const checkpointUnit = units.find((unit) => unit.some(isSummaryCheckpoint));
      if (checkpointUnit) minimumUnits.add(checkpointUnit);
      while (config.reservedTokens + tokens(flatten(units), estimator) > config.maxTokens) {
        const removable = units.findIndex((unit) => !minimumUnits.has(unit));
        if (removable < 0) break;
        units.splice(removable, 1);
      }
      selected = flatten(units);
      const estimated = config.reservedTokens + tokens(selected, estimator);
      if (estimated > config.maxTokens) {
        diagnostic.push({
          code: "CONTEXT_WINDOW_BUDGET_EXCEEDED",
          message: `Required recent context uses approximately ${estimated} tokens, exceeding configured limit ${config.maxTokens}`,
          severity: "warning",
        });
      }
    }

    if (selected.length !== history.length) {
      diagnostic.push({
        code: "CONTEXT_HISTORY_WINDOWED",
        message: `Kept ${selected.length} of ${history.length} invocation messages`,
        severity: "info",
      });
    }
    const estimatedInputTokens = config.reservedTokens + tokens(selected, estimator);
    return {
      diagnostics: diagnostic,
      history: selected,
      statistics: {
        estimatedInputTokens,
        inputMessages: history.length,
        outputMessages: selected.length,
        removedMessages: history.length - selected.length,
      },
    };
  }
}
