// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { RuntimeMessage } from "@sciencediscovery/runtime-core";

import {
  buildSummaryPrompt,
  isSummaryCheckpointMessage,
  planCompaction,
  planTokenCompaction,
  summaryCheckpointMessage,
  validateSummaryCheckpoint,
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
  /** Additional attempts after a non-shrinking summary. Defaults to one. */
  summaryRetries?: number;
  /** Bytes retained across the head and tail of a compacted stored tool result. */
  toolPreviewBytes?: number;
}

export interface HistoryCompactionStatistics {
  afterTokens?: number;
  beforeTokens?: number;
  prunedToolResults: number;
  reason: CompactionReason;
  summarizedMessages: number;
  summaryAttempts?: number;
  summaryCheckpointTokens?: number;
  summaryInputCharacters?: number;
  summaryOutputCharacters?: number;
  summaryRejected?: number;
  summarySourceTokens?: number;
  summaryValidationWarnings?: string[];
  toolOutputRefs?: string[];
}

export interface HistoryCompactionResult<TMessage extends RuntimeMessage> {
  history: TMessage[];
  statistics: HistoryCompactionStatistics;
}

const PRUNED_TOOL_RESULT = "[tool result compacted; original retained in the session tool-output store]";

function tokenCount<TMessage extends RuntimeMessage>(history: readonly TMessage[], estimator: TokenEstimator<TMessage>): number {
  return history.reduce((total, message) => total + estimator.estimateMessage(message), 0);
}

function toolReference(message: RuntimeMessage): string | undefined {
  const additional = message.additional_kwargs;
  if (typeof additional === "object" && additional !== null && !Array.isArray(additional)) {
    const output = (additional as Record<string, unknown>).tool_output;
    if (typeof output === "object" && output !== null && !Array.isArray(output)) {
      const ref = (output as Record<string, unknown>).ref;
      if (typeof ref === "string" && /^tool-output-[0-9a-f]+$/u.test(ref)) return ref;
    }
  }
  if (typeof message.content !== "string") return undefined;
  return /\bref "(tool-output-[0-9a-f]+)"/u.exec(message.content)?.[1];
}

function compactToolResult(content: unknown, reference: string, previewBytes: number): string {
  const instruction = `ref=${reference}; use read_tool_output only for a specific missing fact.`;
  if (typeof content !== "string" || !content) return `${PRUNED_TOOL_RESULT}\n${instruction}`;
  const budget = Math.max(256, previewBytes);
  const slice = (value: string, maxBytes: number, fromEnd: boolean): string => {
    const characters = [...value];
    if (fromEnd) characters.reverse();
    const picked: string[] = [];
    let bytes = 0;
    for (const character of characters) {
      const size = Buffer.byteLength(character, "utf8");
      if (bytes + size > maxBytes) break;
      picked.push(character);
      bytes += size;
    }
    if (fromEnd) picked.reverse();
    return picked.join("");
  };
  const headBytes = Math.floor(budget * 0.65);
  return [
    PRUNED_TOOL_RESULT,
    instruction,
    "[head preview]",
    slice(content, headBytes, false),
    "[tail preview]",
    slice(content, budget - headBytes, true),
  ].join("\n");
}

function pruneOldToolResults<TMessage extends RuntimeMessage>(
  history: readonly TMessage[],
  estimator: TokenEstimator<TMessage>,
  retainTokens: number,
  targetTokens: number,
  force: boolean,
  previewBytes: number,
): { history: TMessage[]; pruned: number; refs: string[] } {
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
  const refs: string[] = [];
  const outputUnits = units.map((unit) => ({ ...unit, messages: unit.messages.map((message) => structuredClone(message)) }));
  const candidates = outputUnits.flatMap((unit, unitIndex) => unit.messages.flatMap((message, messageIndex) => {
    if (!unit.closed || message.role !== "tool" || !toolReference(message)) return [];
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
    const reference = toolReference(message)!;
    const marker = compactToolResult(message.content, reference, previewBytes);
    if (typeof message.content === "string" && message.content === marker) continue;
    pruned += 1;
    refs.push(reference);
    outputUnits[candidate.unitIndex]!.messages[candidate.messageIndex] = {
      ...message,
      content: marker,
    } as TMessage;
  }
  return { history: flattenHistoryUnits(outputUnits), pruned, refs };
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
      return { history: copy, statistics: {
        beforeTokens, afterTokens: beforeTokens, prunedToolResults: 0, reason,
        summarizedMessages: 0, summaryAttempts: 0, summaryRejected: 0, toolOutputRefs: [],
      } };
    }

    let prunedToolResults = 0;
    let toolOutputRefs: string[] = [];
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
        options.toolPreviewBytes ?? 2 * 1_024,
      );
      copy = pruned.history;
      prunedToolResults = pruned.pruned;
      toolOutputRefs = pruned.refs;
      const prunedTokens = tokenCount(copy, options.estimator);
      if (!options.force && tokenPressure && !messagePressure && options.pressureTokens !== undefined
        && prunedTokens <= options.pressureTokens) {
        return { history: copy, statistics: {
          afterTokens: prunedTokens, beforeTokens, prunedToolResults, reason, summarizedMessages: 0,
          summaryAttempts: 0, summaryRejected: 0, toolOutputRefs,
        } };
      }
    }

    const plan = (tokenPressure || options.force) && options.estimator && options.retainTokens !== undefined
      ? planTokenCompaction(copy, { estimator: options.estimator, retainTokens: options.retainTokens })
      : planCompaction(copy);
    if (!plan) {
      const afterTokens = options.estimator ? tokenCount(copy, options.estimator) : undefined;
      return { history: copy, statistics: {
        afterTokens, beforeTokens, prunedToolResults, reason, summarizedMessages: 0,
        summaryAttempts: 0, summaryRejected: 0, toolOutputRefs,
      } };
    }
    let checkpoint: RuntimeMessage | undefined;
    let summaryAttempts = 0;
    let summaryRejected = 0;
    let summaryCheckpointTokens: number | undefined;
    let summaryOutputCharacters: number | undefined;
    let summaryValidationWarnings: string[] = [];
    const summaryPrompt = buildSummaryPrompt(plan);
    const summaryInputCharacters = summaryPrompt.length;
    const previousCheckpoint = summaryCheckpointMessage(plan.previousSummary);
    const sourceCost = options.estimator
      ? tokenCount([
        ...(previousCheckpoint ? [previousCheckpoint as TMessage] : []),
        ...plan.toSummarize as TMessage[],
      ], options.estimator)
      : JSON.stringify(plan.toSummarize).length + String(previousCheckpoint?.content ?? "").length;
    const summarySourceTokens = options.estimator ? sourceCost : undefined;
    const knownToolOutputRefs = new Set(
      `${plan.previousSummary}\n${JSON.stringify(plan.toSummarize)}`.match(/tool-output-[0-9a-f]+/gu) ?? [],
    );
    const retries = Math.max(0, Math.trunc(options.summaryRetries ?? 1));
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        summaryAttempts += 1;
        const correction = attempt === 0 ? ""
          : "\n\nYour previous checkpoint did not reduce the context. Be substantially more concise while retaining all required fields.";
        const summaryText = await this.summarize(`${summaryPrompt}${correction}`, signal, onProgress);
        summaryOutputCharacters = summaryText.length;
        const validation = validateSummaryCheckpoint(summaryText, knownToolOutputRefs);
        summaryValidationWarnings = validation.warnings;
        const candidate = summaryCheckpointMessage(validation.normalized);
        if (!candidate) {
          summaryRejected += 1;
          continue;
        }
        const candidateCost = options.estimator
          ? tokenCount([candidate as TMessage], options.estimator)
          : String(candidate.content ?? "").length;
        if (candidateCost >= sourceCost) {
          summaryRejected += 1;
          continue;
        }
        checkpoint = candidate;
        summaryCheckpointTokens = options.estimator ? candidateCost : undefined;
        break;
      } catch (error) {
        if (signal.aborted) throw error;
        break;
      }
    }
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
      summaryAttempts,
      summaryCheckpointTokens,
      summaryInputCharacters,
      summaryOutputCharacters,
      summaryRejected,
      summarySourceTokens,
      summaryValidationWarnings,
      toolOutputRefs,
    } };
  }
}
