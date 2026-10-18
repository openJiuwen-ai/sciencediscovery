// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { RuntimeMessage } from "@sciencediscovery/runtime-core";
import { createModelRequest, normalizeUsage, proxyDispatcher, type ModelEndpoint } from "./client.js";
import { request } from "undici";
import { Readable } from "node:stream";

export interface ChatCompletionRequest {
  messages: RuntimeMessage[];
  max_tokens?: number;
  temperature?: number;
  thinking?: { type: string };
  tools?: Array<{ type: string; function: { name: string; description?: string; parameters?: unknown } }>;
  stream?: boolean;
}

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Non-streaming compatibility at the existing model boundary. No protocol probing or fallback. */
export async function completeChatRequest(
  endpoint: ModelEndpoint, body: ChatCompletionRequest, signal: AbortSignal,
  fetchImpl?: typeof fetch,
  maxResponseBytes = 4 * 1024 * 1024,
): Promise<Response> {
  const unsupported = Object.keys(body).filter(k => !["messages", "model", "max_tokens", "temperature", "thinking", "tools", "stream"].includes(k));
  if (unsupported.length) throw new Error(`Unsupported model parameters: ${unsupported.join(", ")}`);
  if (body.stream) throw new Error("Use the shared model gateway for streaming Chat requests");
  if (!Array.isArray(body.messages) || body.messages.some(m => !["user", "assistant", "system", "tool"].includes(m.role ?? ""))) throw new Error("Invalid model message history");
  if (body.thinking && !["enabled", "disabled"].includes(body.thinking.type)) throw new Error("Unsupported thinking control");
  if (body.max_tokens !== undefined && (!Number.isInteger(body.max_tokens) || body.max_tokens <= 0)) throw new Error("max_tokens must be a positive integer");
  const selected = { ...endpoint, ...(body.thinking ? { thinkingMode: body.thinking.type as "enabled" | "disabled" } : {}) };
  const systemPrompt = body.messages.filter(m => m.role === "system").map(m => String(m.content ?? "")).join("\n\n");
  const tools = (body.tools ?? []).map(t => {
    if (t.type !== "function" || !t.function?.name) throw new Error("Unsupported model tool");
    return { name: t.function.name, description: t.function.description ?? "", parameters: t.function.parameters ?? { type: "object" } };
  });
  const probe = createModelRequest(selected, systemPrompt, body.messages.filter(m => m.role !== "system"), tools,
    { maxTokens: body.max_tokens ?? 16_384, maxRetries: 0, requestTimeoutMs: 90_000, temperature: body.temperature, thinking: body.thinking }, false);
  const dispatcher = proxyDispatcher(endpoint.proxy);
  try {
    let response: Response;
    if (fetchImpl) response = await fetchImpl(probe.url, { method: "POST", headers: probe.headers, body: probe.body, signal,
      ...(dispatcher ? { dispatcher } : {}) } as RequestInit);
    else {
      const incoming = await request(probe.url, { method: "POST", headers: probe.headers, body: probe.body, signal,
        bodyTimeout: 0, headersTimeout: 20 * 60_000, ...(dispatcher ? { dispatcher } : {}) });
      response = new Response([204, 205, 304].includes(incoming.statusCode) ? null : Readable.toWeb(incoming.body) as ReadableStream<Uint8Array>, { status: incoming.statusCode });
    }
    // Read errors as well as successes under the same hard byte and time limits.
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxResponseBytes) throw new Error("Model response exceeds the byte limit");
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const raw = Buffer.concat(chunks).toString("utf8");
    const redacted = endpoint.apiToken ? raw.split(endpoint.apiToken).join("[redacted]") : raw;
    if (!response.ok) return new Response(redacted, { status: response.status, headers: { "content-type": "application/json" } });
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch { throw new Error("Model returned malformed JSON"); }
    if (!record(payload)) throw new Error("Invalid model completion response");
    const protocol = endpoint.apiProtocol ?? (endpoint.baseUrl.includes("/api/plan") ? "anthropic-messages" : "openai-chat-completions");
    if (protocol === "openai-chat-completions") {
      const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
      if (!record(choice) || !record(choice.message) || !(typeof choice.message.content === "string" || typeof choice.message.reasoning_content === "string" || Array.isArray(choice.message.tool_calls))) throw new Error("Invalid Chat completion response");
      return new Response(raw, { headers: { "content-type": "application/json" } });
    }
    let message: Record<string, unknown>;
    let finish: string | undefined;
    if (protocol === "anthropic-messages") {
      if (payload.type !== "message" || !Array.isArray(payload.content)) throw new Error("Invalid Messages completion response");
      const blocks = payload.content.filter(record);
      const calls = blocks.filter(b => b.type === "tool_use").map(b => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } }));
      message = { role: "assistant", content: blocks.filter(b => b.type === "text").map(b => b.text).join(""), anthropic_content: blocks,
        ...(calls.length ? { tool_calls: calls } : {}) };
      finish = payload.stop_reason === "max_tokens" ? "length" : calls.length ? "tool_calls" : typeof payload.stop_reason === "string" ? "stop" : undefined;
    } else {
      if (payload.object !== "response" || !Array.isArray(payload.output)) throw new Error("Invalid Responses completion response");
      if (payload.status === "failed" || payload.error) throw new Error(`Responses API failed: ${JSON.stringify(payload.error)}`);
      const items = payload.output.filter(record);
      const calls = items.filter(i => i.type === "function_call").map(i => ({ id: i.call_id, type: "function", function: { name: i.name, arguments: i.arguments } }));
      message = { role: "assistant", content: items.filter(i => i.type === "message").flatMap(i => Array.isArray(i.content) ? i.content.filter(record) : []).filter(p => p.type === "output_text").map(p => p.text).join(""), response_items: items,
        ...(calls.length ? { tool_calls: calls } : {}) };
      finish = payload.status === "incomplete" ? "length" : calls.length ? "tool_calls" : payload.status === "completed" ? "stop" : undefined;
    }
    const usage = normalizeUsage(payload.usage, protocol);
    return Response.json({ choices: [{ message, finish_reason: finish }], ...(usage ? { usage: { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.totalTokens,
      cache_read_input_tokens: usage.cacheReadTokens, cache_creation_input_tokens: usage.cacheWriteTokens } } : {}) });
  } finally { await dispatcher?.close(); }
}
