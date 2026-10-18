// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { ModelApiProtocol } from "@sciencediscovery/schema";
import type { ModelUsage } from "./types.js";

/** Retain the conflicting counts for callers that need to diagnose a gateway. */
export interface UsageAliasConflict {
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
}

export interface NormalizedUsage extends ModelUsage {
  aliasConflict?: UsageAliasConflict;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function count(value: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "number" && Number.isSafeInteger(Math.floor(raw)) && raw >= 0) return Math.floor(raw);
  }
  return undefined;
}

/** Normalize counts using the request's dialect, never by adding aliases. */
export function normalizeUsage(raw: unknown, protocol?: ModelApiProtocol): NormalizedUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const prompt = count(raw, ["prompt_tokens", "prompt_token_count"]);
  const completion = count(raw, ["completion_tokens", "completion_token_count"]);
  const input = count(raw, ["input_tokens", "input_token_count"]);
  const output = count(raw, ["output_tokens", "output_token_count"]);
  let totalTokens = count(raw, ["total_tokens", "total_token_count"]);
  const conflicts = (prompt !== undefined && input !== undefined && prompt !== input)
    || (completion !== undefined && output !== undefined && completion !== output);

  let inputTokens = protocol === "openai-chat-completions" ? prompt ?? input : input ?? prompt;
  let outputTokens = protocol === "openai-chat-completions" ? completion ?? output : output ?? completion;
  if (protocol === undefined && conflicts) {
    // With no request context, prefer a complete dialect pair that agrees
    // with total. Never "repair" a reported count by subtracting from total.
    const matches = (a: number | undefined, b: number | undefined) =>
      a !== undefined && b !== undefined && totalTokens !== undefined && a + b === totalTokens;
    if (!matches(input, output)) {
      if (matches(prompt, completion)) {
        inputTokens = prompt;
        outputTokens = completion;
      } else {
        // Only use the zero-fill heuristic when neither complete pair matches
        // total. A matching pair's explicit zeros must remain authoritative.
        if (inputTokens === 0) inputTokens = input || prompt || 0;
        if (outputTokens === 0) outputTokens = output || completion || 0;
      }
    }
  }

  let cacheReadTokens = count(raw, ["cache_read_input_tokens", "cache_read_tokens", "cached_tokens", "prompt_cache_hit_tokens"]);
  let cacheWriteTokens = count(raw, ["cache_creation_input_tokens", "cache_write_tokens", "prompt_cache_miss_tokens"]);
  const promptDetails = raw.prompt_tokens_details;
  if (isRecord(promptDetails)) {
    cacheReadTokens ??= count(promptDetails, ["cached_tokens", "cache_read_tokens", "cache_tokens"]);
    cacheWriteTokens ??= count(promptDetails, ["cache_write_tokens", "cache_creation_tokens"]);
  }
  const inputDetails = raw.input_token_details;
  if (isRecord(inputDetails)) {
    cacheReadTokens ??= count(inputDetails, ["cache_read", "cached_tokens", "cache_read_tokens"]);
  }

  if (totalTokens === undefined && inputTokens !== undefined && outputTokens !== undefined) {
    totalTokens = inputTokens + outputTokens;
  }
  if (inputTokens === undefined && totalTokens !== undefined && outputTokens !== undefined) {
    inputTokens = Math.max(totalTokens - outputTokens, 0);
  }
  if (outputTokens === undefined && totalTokens !== undefined && inputTokens !== undefined) {
    outputTokens = Math.max(totalTokens - inputTokens, 0);
  }
  if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined || !Number.isSafeInteger(totalTokens)) return undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens: cacheReadTokens ?? null,
    cacheWriteTokens: cacheWriteTokens ?? null,
    ...(protocol === undefined && conflicts ? { aliasConflict: {
      ...(prompt === undefined ? {} : { prompt_tokens: prompt }),
      ...(completion === undefined ? {} : { completion_tokens: completion }),
      ...(input === undefined ? {} : { input_tokens: input }),
      ...(output === undefined ? {} : { output_tokens: output }),
    } } : {}),
  };
}
