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
 * Two provider dialects, one normalized result:
 *   - OpenAI-compatible `/chat/completions` (the default; also serves Gemini
 *     behind OpenAI gateways — raw tool-call fields such as
 *     `thought_signature` are preserved verbatim on the assistant message and
 *     replayed on later requests because the loop keeps wire-format history).
 *   - Anthropic Messages (model profiles whose base URL points at the
 *     internal `/api/plan` endpoint), translated to and from the same
 *     OpenAI-format history the rest of the system stores.
 */

import { randomUUID } from "node:crypto";
import { Agent as UndiciAgent, ProxyAgent, request, type Dispatcher } from "undici";

import type { RuntimeMessage as AgentHistoryMessage } from "@sciencediscovery/runtime-core";
import type { ResolvedProxy } from "@sciencediscovery/schema";

import type { ModelUsage as AgentModelUsage } from "./types.js";

export interface ModelEndpoint {
  apiToken?: string;
  baseUrl: string;
  model: string;
  proxy?: ResolvedProxy;
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

export function isAnthropicEndpoint(baseUrl: string): boolean {
  return baseUrl.includes("/api/plan");
}

// ── OpenAI-compatible dialect ──

interface OpenAiToolCallFragment {
  function?: { arguments?: string; name?: string };
  id?: string;
  index?: number;
  type?: string;
  [key: string]: unknown;
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
  const { body } = await requestWithRetry({
    url: `${trimBase(endpoint.baseUrl)}/chat/completions`,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${endpoint.apiToken || "dummy"}`,
    },
    body: JSON.stringify({
      model: endpoint.model,
      messages: [{ role: "system", content: systemPrompt }, ...history],
      ...(tools.length
        ? {
            tools: tools.map((tool) => ({
              type: "function",
              function: { name: tool.name, description: tool.description, parameters: tool.parameters },
            })),
          }
        : {}),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: policy.maxTokens,
    }),
    policy,
    proxy: endpoint.proxy,
    signal,
  });

  let text = "";
  const fragments = new Map<number, OpenAiToolCallFragment>();
  let usage: AgentModelUsage | undefined;

  for await (const payload of sseData(body, callbacks.onProgress)) {
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue; // tolerate malformed keepalive frames
    }
    const chunkUsage = normalizeUsage(chunk.usage);
    if (chunkUsage) usage = chunkUsage;
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const delta = choices.length && isRecord(choices[0]) && isRecord((choices[0] as Record<string, unknown>).delta)
      ? (choices[0] as { delta: Record<string, unknown> }).delta
      : undefined;
    if (!delta) continue;
    const reasoning = delta.reasoning_content;
    if (typeof reasoning === "string" && reasoning) callbacks.onThinkingDelta?.(reasoning);
    const content = delta.content;
    if (typeof content === "string" && content) {
      text += content;
      callbacks.onTextDelta?.(content);
    }
    const toolCalls = delta.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const fragment of toolCalls) {
        if (!isRecord(fragment)) continue;
        const index = typeof fragment.index === "number" ? fragment.index : fragments.size;
        const existing = fragments.get(index) ?? { function: { arguments: "", name: "" } };
        // Merge unknown provider fields (e.g. Gemini thought_signature) so the
        // stored assistant message replays them verbatim on later requests.
        for (const [key, value] of Object.entries(fragment)) {
          if (key === "index" || key === "function") continue;
          if (value !== undefined && value !== null) existing[key] = value;
        }
        if (isRecord(fragment.function)) {
          const fn = existing.function ?? { arguments: "", name: "" };
          if (typeof fragment.function.name === "string" && fragment.function.name) fn.name = fragment.function.name;
          if (typeof fragment.function.arguments === "string") fn.arguments = (fn.arguments ?? "") + fragment.function.arguments;
          existing.function = fn;
        }
        fragments.set(index, existing);
      }
    }
  }

  const orderedFragments = [...fragments.entries()].sort((a, b) => a[0] - b[0]).map(([, fragment]) => fragment);
  const wireToolCalls = orderedFragments.map((fragment) => ({
    ...fragment,
    id: typeof fragment.id === "string" && fragment.id ? fragment.id : `call_${randomUUID()}`,
    type: typeof fragment.type === "string" && fragment.type ? fragment.type : "function",
    function: {
      name: fragment.function?.name ?? "",
      arguments: fragment.function?.arguments ?? "",
    },
  }));
  const toolCalls: NormalizedToolCall[] = wireToolCalls
    .filter((call) => call.function.name)
    .map((call) => {
      const { args, error } = parseToolCallArgs(call.function.arguments);
      return { args, id: call.id, name: call.function.name, ...(error ? { argsParseError: error } : {}) };
    });

  const assistantMessage: AgentHistoryMessage = {
    role: "assistant",
    content: text,
    ...(wireToolCalls.length ? { tool_calls: wireToolCalls } : {}),
  };
  return { assistantMessage, toolCalls, ...(usage ? { usage } : {}) };
}

// ── Anthropic Messages dialect (internal /api/plan endpoint) ──

type AnthropicBlock = Record<string, unknown>;

function anthropicContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : ""))
      .join("");
  }
  return "";
}

/** Translate OpenAI-format history into Anthropic messages. */
export function toAnthropicMessages(history: AgentHistoryMessage[]): Array<{ content: AnthropicBlock[]; role: "assistant" | "user" }> {
  const messages: Array<{ content: AnthropicBlock[]; role: "assistant" | "user" }> = [];
  const push = (role: "assistant" | "user", blocks: AnthropicBlock[]) => {
    const previous = messages[messages.length - 1];
    if (previous && previous.role === role) previous.content.push(...blocks);
    else messages.push({ content: blocks, role });
  };
  for (const message of history) {
    const role = message.role;
    if (role === "system") continue;
    if (role === "user") {
      push("user", [{ type: "text", text: anthropicContentText(message.content) }]);
      continue;
    }
    if (role === "assistant") {
      const blocks: AnthropicBlock[] = [];
      const text = anthropicContentText(message.content);
      if (text) blocks.push({ type: "text", text });
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const call of toolCalls) {
        if (!isRecord(call) || !isRecord(call.function)) continue;
        const { args } = parseToolCallArgs(typeof call.function.arguments === "string" ? call.function.arguments : "");
        blocks.push({
          type: "tool_use",
          id: typeof call.id === "string" ? call.id : `call_${randomUUID()}`,
          name: typeof call.function.name === "string" ? call.function.name : "",
          input: args,
        });
      }
      if (blocks.length) push("assistant", blocks);
      continue;
    }
    if (role === "tool") {
      push("user", [{
        type: "tool_result",
        tool_use_id: typeof message.tool_call_id === "string" ? message.tool_call_id : "",
        content: anthropicContentText(message.content),
      }]);
    }
  }
  return messages;
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
    url: `${trimBase(endpoint.baseUrl)}/v1/messages`,
    headers: {
      "content-type": "application/json",
      "x-api-key": endpoint.apiToken || "dummy",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: endpoint.model,
      system: systemPrompt,
      messages: toAnthropicMessages(history),
      ...(tools.length
        ? { tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) }
        : {}),
      stream: true,
      max_tokens: policy.maxTokens,
    }),
    policy,
    proxy: endpoint.proxy,
    signal,
  });

  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens: number | null = null;
  let cacheWriteTokens: number | null = null;
  interface ToolUseState { id: string; json: string; name: string }
  const toolUses = new Map<number, ToolUseState>();

  for await (const payload of sseData(body, callbacks.onProgress)) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = event.type;
    if (type === "message_start" && isRecord(event.message) && isRecord(event.message.usage)) {
      inputTokens = numberField(event.message.usage, ["input_tokens"]) ?? 0;
      cacheReadTokens = numberField(event.message.usage, ["cache_read_input_tokens"]) ?? null;
      cacheWriteTokens = numberField(event.message.usage, ["cache_creation_input_tokens"]) ?? null;
    } else if (type === "content_block_start" && typeof event.index === "number" && isRecord(event.content_block)) {
      if (event.content_block.type === "tool_use") {
        toolUses.set(event.index, {
          id: typeof event.content_block.id === "string" ? event.content_block.id : `call_${randomUUID()}`,
          json: "",
          name: typeof event.content_block.name === "string" ? event.content_block.name : "",
        });
      }
    } else if (type === "content_block_delta" && typeof event.index === "number" && isRecord(event.delta)) {
      if (event.delta.type === "text_delta" && typeof event.delta.text === "string") {
        text += event.delta.text;
        callbacks.onTextDelta?.(event.delta.text);
      } else if (event.delta.type === "thinking_delta" && typeof event.delta.thinking === "string") {
        callbacks.onThinkingDelta?.(event.delta.thinking);
      } else if (event.delta.type === "input_json_delta" && typeof event.delta.partial_json === "string") {
        const state = toolUses.get(event.index);
        if (state) state.json += event.delta.partial_json;
      }
    } else if (type === "message_delta" && isRecord(event.usage)) {
      outputTokens = numberField(event.usage, ["output_tokens"]) ?? outputTokens;
    }
  }

  const orderedToolUses = [...toolUses.entries()].sort((a, b) => a[0] - b[0]).map(([, state]) => state);
  const wireToolCalls = orderedToolUses.map((state) => ({
    id: state.id,
    type: "function",
    function: { name: state.name, arguments: state.json || "{}" },
  }));
  const toolCalls: NormalizedToolCall[] = orderedToolUses.map((state) => {
    const { args, error } = parseToolCallArgs(state.json);
    return { args, id: state.id, name: state.name, ...(error ? { argsParseError: error } : {}) };
  });
  const usage: AgentModelUsage = {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
  return {
    assistantMessage: {
      role: "assistant",
      content: text,
      ...(wireToolCalls.length ? { tool_calls: wireToolCalls } : {}),
    },
    toolCalls,
    usage,
  };
}

/** Stream one model turn using the dialect implied by the endpoint. */
export async function streamModelTurn(
  endpoint: ModelEndpoint,
  systemPrompt: string,
  history: AgentHistoryMessage[],
  tools: WireToolSpec[],
  policy: ModelClientPolicy,
  signal: AbortSignal,
  callbacks: ModelStreamCallbacks = {},
): Promise<ModelTurn> {
  if (isAnthropicEndpoint(endpoint.baseUrl)) {
    return streamAnthropicTurn(endpoint, systemPrompt, history, tools, policy, signal, callbacks);
  }
  return streamOpenAiTurn(endpoint, systemPrompt, history, tools, policy, signal, callbacks);
}
