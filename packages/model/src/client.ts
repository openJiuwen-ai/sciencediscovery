// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
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
 * Streaming chat-model clients for the Node-native agent loop.
 *
 * Explicit protocol families share one normalized result. Provider-specific
 * reasoning payloads stay on the wire-format history so later tool calls and
 * user turns can replay them without converting between incompatible shapes.
 */

import { randomUUID } from "node:crypto";
import { Agent as UndiciAgent, ProxyAgent, request, type Dispatcher } from "undici";

import type { RuntimeMessage as AgentHistoryMessage } from "@sciencediscovery/runtime-core";
import {
  DEFAULT_MODEL_API_VARIANT,
  type ModelApiProtocol,
  type ModelApiVariant,
  type ModelThinkingEffort,
  type ModelThinkingMode,
  type ResolvedProxy,
} from "@sciencediscovery/schema";

import type { ModelUsage as AgentModelUsage } from "./types.js";

export interface ModelEndpoint {
  apiToken?: string;
  apiProtocol?: ModelApiProtocol;
  apiVariant?: ModelApiVariant;
  baseUrl: string;
  model: string;
  proxy?: ResolvedProxy;
  thinkingEffort?: ModelThinkingEffort;
  thinkingMode?: ModelThinkingMode;
}

export interface WireToolSpec {
  description: string;
  name: string;
  parameters: unknown;
}

export interface NormalizedToolCall {
  args: Record<string, unknown>;
  argsParseError?: string;
  id: string;
  name: string;
}

export interface ModelTurn {
  /** Wire-format assistant message appended verbatim to history. */
  assistantMessage: AgentHistoryMessage;
  toolCalls: NormalizedToolCall[];
  usage?: AgentModelUsage;
}

export interface ModelStreamCallbacks {
  onProgress?: () => void;
  onTextDelta?: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
}

export interface ModelClientPolicy {
  maxRetries: number;
  maxTokens: number;
  requestTimeoutMs: number;
}

export const DEFAULT_MODEL_MAX_TOKENS = 16_384;

export function resolveModelClientPolicy(env: NodeJS.ProcessEnv = process.env): ModelClientPolicy {
  // Mirrors the reserved minimal LLM config surface: request timeout and retry
  // budget for outbound model calls.
  const timeoutRaw = env.SCIENCE_AGENT_LLM_TIMEOUT_SECONDS?.trim();
  const retriesRaw = env.SCIENCE_AGENT_LLM_MAX_RETRIES?.trim();
  const timeoutSeconds = timeoutRaw ? Number(timeoutRaw) : 600;
  const maxRetries = retriesRaw ? Number(retriesRaw) : 2;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("SCIENCE_AGENT_LLM_TIMEOUT_SECONDS must be positive");
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error("SCIENCE_AGENT_LLM_MAX_RETRIES must be a non-negative integer");
  }
  return { maxRetries, maxTokens: DEFAULT_MODEL_MAX_TOKENS, requestTimeoutMs: timeoutSeconds * 1_000 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Dispatcher honouring the profile's resolved proxy. "environment" keeps the
 *  process default dispatcher; "direct" pins a plain agent; "url" pins one proxy. */
export function proxyDispatcher(proxy: ResolvedProxy | undefined): Dispatcher | undefined {
  if (!proxy || proxy.mode === "environment") return undefined;
  if (proxy.mode === "url") {
    if (!proxy.url) throw new Error("Model proxy mode 'url' requires a proxy URL");
    return new ProxyAgent(proxy.url);
  }
  return new UndiciAgent();
}

function numberField(value: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  }
  return undefined;
}

/** Normalize provider usage payloads (OpenAI and Anthropic spellings). */
export function normalizeUsage(raw: unknown): AgentModelUsage | undefined {
  if (!isRecord(raw)) return undefined;
  let inputTokens = numberField(raw, ["input_tokens", "prompt_tokens"]);
  let outputTokens = numberField(raw, ["output_tokens", "completion_tokens"]);
  let totalTokens = numberField(raw, ["total_tokens"]);
  let cacheReadTokens = numberField(raw, ["cache_read_input_tokens", "cache_read_tokens", "cached_tokens", "prompt_cache_hit_tokens"]);
  const cacheWriteTokens = numberField(raw, ["cache_creation_input_tokens", "cache_write_tokens", "prompt_cache_miss_tokens"]);
  const promptDetails = raw.prompt_tokens_details;
  if (cacheReadTokens === undefined && isRecord(promptDetails)) {
    cacheReadTokens = numberField(promptDetails, ["cached_tokens", "cache_read_tokens"]);
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
  if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) return undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens: cacheReadTokens ?? null,
    cacheWriteTokens: cacheWriteTokens ?? null,
  };
}

function parseToolCallArgs(rawArguments: string): { args: Record<string, unknown>; error?: string } {
  if (!rawArguments.trim()) return { args: {} };
  try {
    const parsed = JSON.parse(rawArguments) as unknown;
    if (isRecord(parsed)) return { args: parsed };
    return { args: {}, error: "tool arguments must be a JSON object" };
  } catch (error) {
    return { args: {}, error: error instanceof Error ? error.message : String(error) };
  }
}

async function* sseData(body: AsyncIterable<Uint8Array>, onProgress?: () => void): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    onProgress?.();
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (payload && payload !== "[DONE]") yield payload;
      }
      newline = buffer.indexOf("\n");
    }
  }
}

interface RequestOptions {
  body: string;
  headers: Record<string, string>;
  policy: ModelClientPolicy;
  proxy?: ResolvedProxy;
  signal: AbortSignal;
  url: string;
}

/** POST with a bounded retry budget for pre-stream failures (connect errors,
 *  429, 5xx). Once the stream starts flowing, errors surface to the caller. */
async function requestWithRetry(options: RequestOptions): Promise<{ body: AsyncIterable<Uint8Array> & { dump(): Promise<void> } }> {
  const dispatcher = proxyDispatcher(options.proxy);
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= options.policy.maxRetries; attempt += 1) {
    if (options.signal.aborted) throw new Error("aborted");
    let statusCode: number;
    let responseBody: AsyncIterable<Uint8Array> & { dump(): Promise<void> };
    let retryAfterMs: number | undefined;
    try {
      const response = await request(options.url, {
        method: "POST",
        headers: options.headers,
        body: options.body,
        signal: options.signal,
        bodyTimeout: 0,
        headersTimeout: options.policy.requestTimeoutMs,
        ...(dispatcher ? { dispatcher } : {}),
      });
      statusCode = response.statusCode;
      responseBody = response.body;
      const retryAfter = response.headers["retry-after"];
      if (typeof retryAfter === "string" && Number.isFinite(Number(retryAfter))) {
        retryAfterMs = Number(retryAfter) * 1_000;
      }
    } catch (error) {
      if (options.signal.aborted) throw new Error("aborted");
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < options.policy.maxRetries) {
        await backoff(attempt, undefined, options.signal);
        continue;
      }
      throw new Error(`Model endpoint is unavailable: ${lastError.message}`);
    }
    if (statusCode >= 200 && statusCode < 300) return { body: responseBody };
    const detail = (await collectBounded(responseBody, 2_000)).trim();
    const failure = new Error(`Model request failed with status ${statusCode}${detail ? `: ${detail}` : ""}`);
    if ((statusCode === 429 || statusCode >= 500) && attempt < options.policy.maxRetries) {
      lastError = failure;
      await backoff(attempt, retryAfterMs, options.signal);
      continue;
    }
    throw failure;
  }
  throw lastError ?? new Error("Model request failed");
}

async function collectBounded(body: AsyncIterable<Uint8Array>, cap: number): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  try {
    for await (const chunk of body) {
      text += decoder.decode(chunk, { stream: true });
      if (text.length >= cap) break;
    }
  } catch {
    // Best-effort error detail only.
  }
  return text.slice(0, cap);
}

async function backoff(attempt: number, retryAfterMs: number | undefined, signal: AbortSignal): Promise<void> {
  const delay = retryAfterMs ?? Math.min(4_000, 500 * 2 ** attempt);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delay);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }, { once: true });
  });
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export function endpointRoot(baseUrl: string): string {
  return trimBase(baseUrl).replace(/\/(?:chat\/completions|responses|messages)$/, "");
}

export function isAnthropicEndpoint(baseUrl: string): boolean {
  return baseUrl.includes("/api/plan");
}

function endpointProtocol(endpoint: ModelEndpoint): ModelApiProtocol {
  return endpoint.apiProtocol ?? (isAnthropicEndpoint(endpoint.baseUrl)
    ? "anthropic-messages"
    : "openai-chat-completions");
}

function endpointVariant(endpoint: ModelEndpoint): ModelApiVariant {
  return endpoint.apiVariant ?? DEFAULT_MODEL_API_VARIANT[endpointProtocol(endpoint)];
}

function thinkingMode(endpoint: ModelEndpoint): ModelThinkingMode {
  return endpoint.thinkingMode ?? "auto";
}

function thinkingEffort(endpoint: ModelEndpoint): ModelThinkingEffort {
  return endpoint.thinkingEffort ?? "high";
}

function chatUrl(baseUrl: string): string {
  return `${endpointRoot(baseUrl)}/chat/completions`;
}

function responsesUrl(baseUrl: string): string {
  return `${endpointRoot(baseUrl)}/responses`;
}

function anthropicUrl(baseUrl: string): string {
  const base = endpointRoot(baseUrl);
  return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (isRecord(content)) {
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
    return contentText(content.content);
  }
  if (!Array.isArray(content)) return "";
  return content.map((item) => {
    if (!isRecord(item)) return "";
    if (typeof item.text === "string") return item.text;
    if (typeof item.content === "string") return item.content;
    return "";
  }).join("");
}

function reasoningText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(reasoningText).join("");
  if (!isRecord(value)) return "";
  for (const key of ["text", "content", "reasoning", "reasoning_content"]) {
    const text = reasoningText(value[key]);
    if (text) return text;
  }
  return "";
}

function splitInlineThinking(value: string): { text: string; thinking: string } {
  const thoughts: string[] = [];
  const text = value.replace(/<think>([\s\S]*?)<\/think>/gi, (_match, thought: string) => {
    if (thought.trim()) thoughts.push(thought);
    return "";
  });
  return { text: text.trimStart(), thinking: thoughts.join("\n") };
}

function chatThinkingFields(endpoint: ModelEndpoint): Record<string, unknown> {
  const mode = thinkingMode(endpoint);
  if (mode === "auto") return {};
  const enabled = mode === "enabled";
  switch (endpointVariant(endpoint)) {
    case "deepseek":
      return {
        thinking: { type: mode },
        ...(enabled ? { reasoning_effort: thinkingEffort(endpoint) } : {}),
      };
    case "qwen":
      return { chat_template_kwargs: { enable_thinking: enabled } };
    case "minimax":
      return { reasoning_split: enabled };
    default:
      return {};
  }
}

interface OpenAiToolCallFragment {
  function?: { arguments?: string; name?: string };
  id?: string;
  index?: number;
  type?: string;
  [key: string]: unknown;
}

function chatHistory(history: AgentHistoryMessage[], variant: ModelApiVariant): AgentHistoryMessage[] {
  return history.map((message) => {
    const result: AgentHistoryMessage = {
      role: message.role,
      content: message.content ?? "",
    };
    if (typeof message.name === "string") result.name = message.name;
    if (typeof message.tool_call_id === "string") result.tool_call_id = message.tool_call_id;
    if (message.role === "assistant") {
      if (variant === "deepseek" && typeof message.reasoning_content === "string" && message.reasoning_content) {
        result.reasoning_content = message.reasoning_content;
      }
      if (variant === "qwen" && message.reasoning !== undefined) result.reasoning = structuredClone(message.reasoning);
      if (Array.isArray(message.tool_calls)) {
        result.tool_calls = message.tool_calls.map((raw) => {
          if (!isRecord(raw)) return raw;
          const call: Record<string, unknown> = {
            id: raw.id,
            type: raw.type ?? "function",
            function: isRecord(raw.function) ? structuredClone(raw.function) : raw.function,
          };
          if (variant === "gemini") {
            if (raw.thought_signature !== undefined) call.thought_signature = raw.thought_signature;
            if (raw.thoughtSignature !== undefined) call.thoughtSignature = raw.thoughtSignature;
            // Current Gemini OpenAI-compat places the signature at
            // tool_calls[].extra_content.google.thought_signature and requires
            // it back verbatim in history, or multi-turn tool calls fail 400.
            if (raw.extra_content !== undefined) call.extra_content = structuredClone(raw.extra_content);
          }
          return call;
        });
      }
    }
    return result;
  });
}

async function streamOpenAiTurn(
  endpoint: ModelEndpoint,
  systemPrompt: string,
  history: AgentHistoryMessage[],
  tools: WireToolSpec[],
  policy: ModelClientPolicy,
  signal: AbortSignal,
  callbacks: ModelStreamCallbacks,
): Promise<ModelTurn> {
  const variant = endpointVariant(endpoint);
  const { body } = await requestWithRetry({
    url: chatUrl(endpoint.baseUrl),
    headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.apiToken || "dummy"}` },
    body: JSON.stringify({
      model: endpoint.model,
      messages: [{ role: "system", content: systemPrompt }, ...chatHistory(history, variant)],
      ...(tools.length ? { tools: tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      })) } : {}),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: policy.maxTokens,
      ...chatThinkingFields(endpoint),
    }),
    policy,
    proxy: endpoint.proxy,
    signal,
  });

  let text = "";
  let deepseekReasoning = "";
  let qwenReasoning: unknown;
  const minimaxReasoning: unknown[] = [];
  const fragments = new Map<number, OpenAiToolCallFragment>();
  let usage: AgentModelUsage | undefined;
  const buffersInlineThinking = variant === "minimax" || variant === "ollama";

  for await (const payload of sseData(body, callbacks.onProgress)) {
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const chunkUsage = normalizeUsage(chunk.usage);
    if (chunkUsage) usage = chunkUsage;
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const delta = choices.length && isRecord(choices[0]) && isRecord(choices[0].delta)
      ? choices[0].delta
      : undefined;
    if (!delta) continue;

    if (variant === "deepseek" && typeof delta.reasoning_content === "string") {
      deepseekReasoning += delta.reasoning_content;
      callbacks.onThinkingDelta?.(delta.reasoning_content);
    } else if (variant === "qwen" && delta.reasoning !== undefined) {
      if (typeof delta.reasoning === "string") {
        qwenReasoning = `${typeof qwenReasoning === "string" ? qwenReasoning : ""}${delta.reasoning}`;
      } else {
        qwenReasoning = structuredClone(delta.reasoning);
      }
      const thought = reasoningText(delta.reasoning);
      if (thought) callbacks.onThinkingDelta?.(thought);
    } else if (variant === "minimax" && Array.isArray(delta.reasoning_details)) {
      minimaxReasoning.push(...structuredClone(delta.reasoning_details));
      const thought = reasoningText(delta.reasoning_details);
      if (thought) callbacks.onThinkingDelta?.(thought);
    }

    if (typeof delta.content === "string" && delta.content) {
      text += delta.content;
      if (!buffersInlineThinking) callbacks.onTextDelta?.(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const raw of delta.tool_calls) {
        if (!isRecord(raw)) continue;
        const index = typeof raw.index === "number" ? raw.index : fragments.size;
        const existing = fragments.get(index) ?? { function: { arguments: "", name: "" } };
        for (const [key, value] of Object.entries(raw)) {
          if (key === "index" || key === "function") continue;
          if (value !== undefined && value !== null) existing[key] = value;
        }
        if (isRecord(raw.function)) {
          const fn = existing.function ?? { arguments: "", name: "" };
          if (typeof raw.function.name === "string" && raw.function.name) fn.name = raw.function.name;
          if (typeof raw.function.arguments === "string") fn.arguments = (fn.arguments ?? "") + raw.function.arguments;
          existing.function = fn;
        }
        fragments.set(index, existing);
      }
    }
  }

  if (buffersInlineThinking) {
    const split = splitInlineThinking(text);
    text = split.text;
    if (split.thinking && !reasoningText(minimaxReasoning).includes(split.thinking)) {
      callbacks.onThinkingDelta?.(split.thinking);
    }
    if (text) callbacks.onTextDelta?.(text);
  }
  const orderedFragments = [...fragments.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value);
  const wireToolCalls = orderedFragments.map((fragment) => ({
    ...fragment,
    id: typeof fragment.id === "string" && fragment.id ? fragment.id : `call_${randomUUID()}`,
    type: typeof fragment.type === "string" && fragment.type ? fragment.type : "function",
    function: { name: fragment.function?.name ?? "", arguments: fragment.function?.arguments ?? "" },
  }));
  const toolCalls = wireToolCalls.filter((call) => call.function.name).map((call): NormalizedToolCall => {
    const parsed = parseToolCallArgs(call.function.arguments);
    return { args: parsed.args, id: call.id, name: call.function.name, ...(parsed.error ? { argsParseError: parsed.error } : {}) };
  });
  const assistantMessage: AgentHistoryMessage = {
    role: "assistant",
    content: text,
    ...(wireToolCalls.length ? { tool_calls: wireToolCalls } : {}),
    ...(variant === "deepseek" && deepseekReasoning ? { reasoning_content: deepseekReasoning } : {}),
    ...(variant === "qwen" && qwenReasoning !== undefined ? { reasoning: qwenReasoning } : {}),
    ...(variant === "minimax" && minimaxReasoning.length ? { reasoning_details: minimaxReasoning } : {}),
  };
  return { assistantMessage, toolCalls, ...(usage ? { usage } : {}) };
}

function responsesInput(history: AgentHistoryMessage[]): unknown[] {
  const input: unknown[] = [];
  for (const message of history) {
    if (message.role === "assistant" && Array.isArray(message.response_items)) {
      input.push(...structuredClone(message.response_items));
    } else if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: typeof message.tool_call_id === "string" ? message.tool_call_id : "",
        output: contentText(message.content),
      });
    } else if (message.role === "user" || message.role === "assistant") {
      input.push({
        type: "message",
        role: message.role,
        content: [{ type: message.role === "assistant" ? "output_text" : "input_text", text: contentText(message.content) }],
      });
    }
  }
  return input;
}

function responsesReasoning(endpoint: ModelEndpoint): Record<string, unknown> {
  const mode = thinkingMode(endpoint);
  if (mode === "auto") return {};
  if (mode === "disabled") return { reasoning: { effort: "none" } };
  // Responses names its tier above `high` as `xhigh`; the product's `max`
  // choice is translated instead of sending an invalid provider enum.
  const effort = thinkingEffort(endpoint) === "max" ? "xhigh" : "high";
  return { reasoning: { effort, summary: "auto" } };
}

async function streamResponsesTurn(
  endpoint: ModelEndpoint,
  systemPrompt: string,
  history: AgentHistoryMessage[],
  tools: WireToolSpec[],
  policy: ModelClientPolicy,
  signal: AbortSignal,
  callbacks: ModelStreamCallbacks,
): Promise<ModelTurn> {
  const { body } = await requestWithRetry({
    url: responsesUrl(endpoint.baseUrl),
    headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.apiToken || "dummy"}` },
    body: JSON.stringify({
      model: endpoint.model,
      instructions: systemPrompt,
      input: responsesInput(history),
      ...(tools.length ? { tools: tools.map((tool) => ({
        type: "function", name: tool.name, description: tool.description, parameters: tool.parameters,
      })) } : {}),
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
      max_output_tokens: policy.maxTokens,
      ...responsesReasoning(endpoint),
    }),
    policy,
    proxy: endpoint.proxy,
    signal,
  });

  let text = "";
  let usage: AgentModelUsage | undefined;
  const items = new Map<number, Record<string, unknown>>();
  for await (const payload of sseData(body, callbacks.onProgress)) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      text += event.delta;
      callbacks.onTextDelta?.(event.delta);
    } else if ((event.type === "response.reasoning_text.delta" || event.type === "response.reasoning_summary_text.delta")
      && typeof event.delta === "string") {
      callbacks.onThinkingDelta?.(event.delta);
    } else if (event.type === "response.output_item.done" && isRecord(event.item)) {
      const index = typeof event.output_index === "number" ? event.output_index : items.size;
      items.set(index, structuredClone(event.item));
    } else if (event.type === "response.completed" && isRecord(event.response)) {
      usage = normalizeUsage(event.response.usage) ?? usage;
    } else if (event.type === "response.failed") {
      throw new Error(`Responses API failed${isRecord(event.response) && isRecord(event.response.error) && typeof event.response.error.message === "string" ? `: ${event.response.error.message}` : ""}`);
    }
  }
  const responseItems = [...items.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
  if (!text) {
    text = responseItems.filter((item) => item.type === "message")
      .map((item) => contentText(item.content)).join("");
    if (text) callbacks.onTextDelta?.(text);
  }
  const functionCalls = responseItems.filter((item) => item.type === "function_call");
  const wireToolCalls = functionCalls.map((item) => ({
    id: typeof item.call_id === "string" ? item.call_id : `call_${randomUUID()}`,
    type: "function",
    response_item_id: item.id,
    function: {
      name: typeof item.name === "string" ? item.name : "",
      arguments: typeof item.arguments === "string" ? item.arguments : "{}",
    },
  }));
  const toolCalls = wireToolCalls.filter((call) => call.function.name).map((call): NormalizedToolCall => {
    const parsed = parseToolCallArgs(call.function.arguments);
    return { args: parsed.args, id: call.id, name: call.function.name, ...(parsed.error ? { argsParseError: parsed.error } : {}) };
  });
  return {
    assistantMessage: {
      role: "assistant",
      content: text,
      response_items: responseItems,
      ...(wireToolCalls.length ? { tool_calls: wireToolCalls } : {}),
    },
    toolCalls,
    ...(usage ? { usage } : {}),
  };
}

type AnthropicBlock = Record<string, unknown>;

/** Translate canonical history into Anthropic Messages while preserving raw
 * thinking/redacted-thinking blocks from earlier assistant turns verbatim. */
export function toAnthropicMessages(history: AgentHistoryMessage[]): Array<{ content: AnthropicBlock[]; role: "assistant" | "user" }> {
  const messages: Array<{ content: AnthropicBlock[]; role: "assistant" | "user" }> = [];
  const push = (role: "assistant" | "user", blocks: AnthropicBlock[]) => {
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const message of history) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      push("user", [{ type: "text", text: contentText(message.content) }]);
    } else if (message.role === "assistant") {
      if (Array.isArray(message.anthropic_content)) {
        push("assistant", structuredClone(message.anthropic_content).filter(isRecord));
        continue;
      }
      const blocks: AnthropicBlock[] = [];
      const text = contentText(message.content);
      if (text) blocks.push({ type: "text", text });
      for (const raw of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        if (!isRecord(raw) || !isRecord(raw.function)) continue;
        const parsed = parseToolCallArgs(typeof raw.function.arguments === "string" ? raw.function.arguments : "");
        blocks.push({
          type: "tool_use",
          id: typeof raw.id === "string" ? raw.id : `call_${randomUUID()}`,
          name: typeof raw.function.name === "string" ? raw.function.name : "",
          input: parsed.args,
        });
      }
      if (blocks.length) push("assistant", blocks);
    } else if (message.role === "tool") {
      push("user", [{
        type: "tool_result",
        tool_use_id: typeof message.tool_call_id === "string" ? message.tool_call_id : "",
        content: contentText(message.content) || " ",
      }]);
    }
  }
  return messages;
}

function anthropicThinkingFields(endpoint: ModelEndpoint, maxTokens: number): Record<string, unknown> {
  const mode = thinkingMode(endpoint);
  if (mode === "auto") return {};
  if (mode === "disabled") return { thinking: { type: "disabled" } };
  if (endpointVariant(endpoint) === "anthropic-legacy") {
    if (maxTokens <= 1_024) {
      throw new Error("Anthropic legacy thinking requires max_tokens greater than 1024");
    }
    const requested = thinkingEffort(endpoint) === "max" ? 15_360 : 8_192;
    return { thinking: { type: "enabled", budget_tokens: Math.min(requested, maxTokens - 1) } };
  }
  return {
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: thinkingEffort(endpoint) },
  };
}

async function streamAnthropicTurn(
  endpoint: ModelEndpoint,
  systemPrompt: string,
  history: AgentHistoryMessage[],
  tools: WireToolSpec[],
  policy: ModelClientPolicy,
  signal: AbortSignal,
  callbacks: ModelStreamCallbacks,
): Promise<ModelTurn> {
  const { body } = await requestWithRetry({
    url: anthropicUrl(endpoint.baseUrl),
    headers: { "content-type": "application/json", "x-api-key": endpoint.apiToken || "dummy", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: endpoint.model,
      system: systemPrompt,
      messages: toAnthropicMessages(history),
      ...(tools.length ? { tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) } : {}),
      stream: true,
      max_tokens: policy.maxTokens,
      ...anthropicThinkingFields(endpoint, policy.maxTokens),
    }),
    policy,
    proxy: endpoint.proxy,
    signal,
  });

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens: number | null = null;
  let cacheWriteTokens: number | null = null;
  const blocks = new Map<number, AnthropicBlock>();
  const toolJson = new Map<number, string>();
  for await (const payload of sseData(body, callbacks.onProgress)) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "message_start" && isRecord(event.message) && isRecord(event.message.usage)) {
      inputTokens = numberField(event.message.usage, ["input_tokens"]) ?? 0;
      cacheReadTokens = numberField(event.message.usage, ["cache_read_input_tokens"]) ?? null;
      cacheWriteTokens = numberField(event.message.usage, ["cache_creation_input_tokens"]) ?? null;
    } else if (event.type === "content_block_start" && typeof event.index === "number" && isRecord(event.content_block)) {
      blocks.set(event.index, structuredClone(event.content_block));
      if (event.content_block.type === "tool_use") toolJson.set(event.index, "");
    } else if (event.type === "content_block_delta" && typeof event.index === "number" && isRecord(event.delta)) {
      const block = blocks.get(event.index);
      if (!block) continue;
      if (event.delta.type === "text_delta" && typeof event.delta.text === "string") {
        block.text = `${typeof block.text === "string" ? block.text : ""}${event.delta.text}`;
        callbacks.onTextDelta?.(event.delta.text);
      } else if (event.delta.type === "thinking_delta" && typeof event.delta.thinking === "string") {
        block.thinking = `${typeof block.thinking === "string" ? block.thinking : ""}${event.delta.thinking}`;
        callbacks.onThinkingDelta?.(event.delta.thinking);
      } else if (event.delta.type === "signature_delta" && typeof event.delta.signature === "string") {
        block.signature = `${typeof block.signature === "string" ? block.signature : ""}${event.delta.signature}`;
      } else if (event.delta.type === "input_json_delta" && typeof event.delta.partial_json === "string") {
        toolJson.set(event.index, `${toolJson.get(event.index) ?? ""}${event.delta.partial_json}`);
      }
    } else if (event.type === "content_block_stop" && typeof event.index === "number") {
      const block = blocks.get(event.index);
      const json = toolJson.get(event.index);
      if (block?.type === "tool_use" && json !== undefined) block.input = parseToolCallArgs(json).args;
    } else if (event.type === "message_delta" && isRecord(event.usage)) {
      outputTokens = numberField(event.usage, ["output_tokens"]) ?? outputTokens;
    }
  }

  const anthropicContent = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block);
  const text = anthropicContent.filter((block) => block.type === "text").map((block) => contentText(block)).join("");
  const toolBlocks = anthropicContent.filter((block) => block.type === "tool_use");
  const wireToolCalls = toolBlocks.map((block) => ({
    id: typeof block.id === "string" ? block.id : `call_${randomUUID()}`,
    type: "function",
    function: {
      name: typeof block.name === "string" ? block.name : "",
      arguments: JSON.stringify(isRecord(block.input) ? block.input : {}),
    },
  }));
  const toolCalls = wireToolCalls.map((call): NormalizedToolCall => {
    const parsed = parseToolCallArgs(call.function.arguments);
    return { args: parsed.args, id: call.id, name: call.function.name, ...(parsed.error ? { argsParseError: parsed.error } : {}) };
  });
  return {
    assistantMessage: {
      role: "assistant",
      content: text,
      anthropic_content: anthropicContent,
      ...(wireToolCalls.length ? { tool_calls: wireToolCalls } : {}),
    },
    toolCalls,
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cacheReadTokens, cacheWriteTokens },
  };
}

/** Stream one model turn using the explicitly configured protocol family. */
export async function streamModelTurn(
  endpoint: ModelEndpoint,
  systemPrompt: string,
  history: AgentHistoryMessage[],
  tools: WireToolSpec[],
  policy: ModelClientPolicy,
  signal: AbortSignal,
  callbacks: ModelStreamCallbacks = {},
): Promise<ModelTurn> {
  switch (endpointProtocol(endpoint)) {
    case "anthropic-messages":
      return streamAnthropicTurn(endpoint, systemPrompt, history, tools, policy, signal, callbacks);
    case "openai-responses":
      return streamResponsesTurn(endpoint, systemPrompt, history, tools, policy, signal, callbacks);
    default:
      return streamOpenAiTurn(endpoint, systemPrompt, history, tools, policy, signal, callbacks);
  }
}
