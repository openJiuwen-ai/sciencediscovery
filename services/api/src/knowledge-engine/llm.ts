// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * Pipeline LLM calls for the knowledge engine (extraction, community naming,
 * entity-resolution judging). These are non-agent calls: one system prompt,
 * one user message, no tools, text out. Endpoint resolution follows the
 * established non-agent precedent (evolution/llm-proxy, session-naming):
 * the caller resolves a ModelEndpoint via store.getModel + getModelApiToken.
 */

import {
  streamModelTurn,
  type ModelClientPolicy,
  type ModelEndpoint,
} from "@sciencediscovery/model";
import { salvageJson, stripThinkingProcess } from "@sciencediscovery/knowledge-engine";

/** Injectable seam for tests — defaults to the real streaming transport. */
export type PipelineInvoke = (
  endpoint: ModelEndpoint,
  systemPrompt: string,
  userPrompt: string,
  signal: AbortSignal,
) => Promise<string>;

export interface PipelineLlmOptions {
  readonly endpoint: ModelEndpoint;
  readonly maxTokens?: number;
  readonly requestTimeoutMs?: number;
  readonly maxRetries?: number;
  readonly invoke?: PipelineInvoke;
}

const DEFAULT_POLICY: ModelClientPolicy = {
  maxRetries: 2,
  maxTokens: 16_384,
  requestTimeoutMs: 300_000,
};

/** The model spent the whole output budget before finishing its answer. */
export class PipelineLlmTruncatedError extends Error {
  constructor(readonly maxTokens: number) {
    super(`pipeline LLM turn truncated at max_tokens=${maxTokens} (increase maxTokens or shrink the input)`);
    this.name = "PipelineLlmTruncatedError";
  }
}

async function defaultInvoke(
  endpoint: ModelEndpoint,
  systemPrompt: string,
  userPrompt: string,
  signal: AbortSignal,
  policy: ModelClientPolicy,
): Promise<string> {
  const turn = await streamModelTurn(
    endpoint,
    systemPrompt,
    [{ role: "user", content: userPrompt }],
    [],
    policy,
    signal,
  );
  if (turn.truncated) {
    // Surface truncation explicitly — otherwise a reasoning model that spent
    // the whole budget on hidden thought reports back as "no JSON returned"
    // and sends the reader looking for a bug in the wrong place. Typed so
    // callers (extraction) can escalate budget/input instead of dying blind.
    throw new PipelineLlmTruncatedError(policy.maxTokens);
  }
  return extractAssistantText(turn.assistantMessage);
}

/** Extract visible text from a wire assistant message (string or block array). */
export function extractAssistantText(message: Record<string, unknown>): string {
  const content = message["content"];
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((block): block is Record<string, unknown> => typeof block === "object" && block !== null)
      .filter((block) => block["type"] === "text" && typeof block["text"] === "string")
      .map((block) => block["text"] as string)
      .join("");
  }
  return "";
}

/** One text-in/text-out pipeline call with thinking stripped. */
export async function callPipelineLlm(
  options: PipelineLlmOptions,
  systemPrompt: string,
  userPrompt: string,
  signal: AbortSignal,
): Promise<string> {
  const invoke = options.invoke
    ?? ((endpoint, system, user, sig) => defaultInvoke(endpoint, system, user, sig, policyFrom(options)));
  const raw = await invoke(options.endpoint, systemPrompt, userPrompt, signal);
  return stripThinkingProcess(raw).trim();
}

/** Pipeline call expecting a JSON payload back; throws when unsalvageable. */
export async function callPipelineLlmJson<T>(
  options: PipelineLlmOptions,
  systemPrompt: string,
  userPrompt: string,
  signal: AbortSignal,
): Promise<T> {
  const text = await callPipelineLlm(options, systemPrompt, userPrompt, signal);
  const salvaged = salvageJson(text);
  if (salvaged === null) {
    throw new Error(`pipeline LLM returned no JSON (first 200 chars: ${text.slice(0, 200)})`);
  }
  return JSON.parse(salvaged) as T;
}

function policyFrom(options: PipelineLlmOptions): ModelClientPolicy {
  return {
    maxRetries: options.maxRetries ?? DEFAULT_POLICY.maxRetries,
    maxTokens: options.maxTokens ?? DEFAULT_POLICY.maxTokens,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_POLICY.requestTimeoutMs,
  };
}
