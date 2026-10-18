// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ModelApiProtocol } from "../../packages/schema/src/index.js";

/** Loopback only, synthetic data. Native protocol state is required on the tool-result turn. */
export async function protocolProvider(selection: ModelApiProtocol | "all", options: {
  usage?: "valid" | "missing" | "malformed";
  parallel?: boolean;
  truncated?: boolean;
  invalidArgs?: boolean;
  status?: number;
  hang?: boolean;
  malformed?: boolean;
  streamError?: boolean;
  errorMessage?: string;
} = {}) {
  const requests: Array<{ path: string; body: Record<string, any> }> = [];
  const calls = Array.from({ length: options.parallel ? 2 : 1 }, (_, i) => ({ id: `call-${i}`, name: "compatibility_echo", arguments: options.invalidArgs ? '{"value":' : '{"value":"OK"}' }));
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url?.endsWith("/models")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "synthetic", object: "model" }] })); return; }
    const protocol = selection === "all" ? req.url?.endsWith("/responses") ? "openai-responses" : req.url?.endsWith("/messages") ? "anthropic-messages" : "openai-chat-completions" : selection;
  const usage = options.usage === "missing" ? undefined : options.usage === "malformed" ? { input_tokens: "bad", output_tokens: -1 } : protocol === "openai-chat-completions" ? { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } : { input_tokens: 3, output_tokens: 2, total_tokens: 5 };
  const nativeState = protocol === "anthropic-messages" ? { type: "thinking", thinking: "synthetic reasoning", signature: "signature-required" } : { type: "reasoning", id: "reason-1", encrypted_content: "encrypted-required", summary: [{ type: "summary_text", text: "synthetic summary" }] };
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    requests.push({ path: req.url!, body });
    const expected = protocol === "openai-responses" ? "/responses" : protocol === "anthropic-messages" ? "/messages" : "/chat/completions";
    if (!req.url?.endsWith(expected) || options.status) { res.writeHead(options.status ?? 404); res.end(JSON.stringify({ error: { message: "original fixture error" } })); return; }
    if (options.hang) return;
    if (options.malformed) { res.end('{"result":"not a completion"}'); return; }
    const history = body.input ?? body.messages;
    const hasResult = JSON.stringify(history).includes(protocol === "openai-responses" ? "function_call_output" : protocol === "anthropic-messages" ? "tool_result" : "tool_call_id");
    if (hasResult && protocol !== "openai-chat-completions" && !JSON.stringify(history).includes(protocol === "anthropic-messages" ? "signature-required" : "encrypted-required")) {
      res.writeHead(400); res.end('{"error":{"message":"native state missing"}}'); return;
    }
    const tool = (body.tools ?? []).some((t: any) => (t.name ?? t.function?.name) === "compatibility_echo") && !hasResult;
    const text = tool ? "" : "OK";
    const items = [nativeState, ...(tool ? calls.map((c, index) => protocol === "anthropic-messages" ? { type: "tool_use", id: c.id, name: c.name, input: { value: "OK" } } : { type: "function_call", id: `item-${index}`, call_id: c.id, name: c.name, arguments: c.arguments }) : protocol === "anthropic-messages" ? [{ type: "text", text }] : [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }])];
    if (!body.stream) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(protocol === "openai-chat-completions" ? { choices: [{ finish_reason: options.truncated ? "length" : tool ? "tool_calls" : "stop", message: { role: "assistant", content: text, ...(tool ? { tool_calls: calls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) } : {}) } }], usage }
        : protocol === "anthropic-messages" ? { type: "message", content: items, usage, stop_reason: options.truncated ? "max_tokens" : tool ? "tool_use" : "end_turn" }
        : { object: "response", status: options.truncated ? "incomplete" : "completed", output: items, usage })); return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (options.streamError) { send({ type: "error", error: { message: options.errorMessage ?? "original fixture stream error" }, message: options.errorMessage ?? "original fixture stream error" }); res.end(); return; }
    if (protocol === "openai-chat-completions") {
      if (tool) for (const [index, c] of calls.entries()) {
        send({ choices: [{ delta: { tool_calls: [{ index, id: c.id, function: { name: c.name, arguments: c.arguments.slice(0, 5) } }] } }] });
        send({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: c.arguments.slice(5) } }] } }] });
      }
      else { send({ choices: [{ delta: { content: "O" } }] }); send({ choices: [{ delta: { content: "K" } }] }); }
      send({ choices: [{ delta: {}, finish_reason: options.truncated ? "length" : tool ? "tool_calls" : "stop" }], usage });
    } else if (protocol === "openai-responses") {
      send({ type: "response.output_item.done", output_index: 0, item: nativeState });
      if (tool) for (const [index, c] of calls.entries()) {
        const item = { type: "function_call", id: `item-${index}`, call_id: c.id, name: c.name, arguments: "" };
        send({ type: "response.output_item.added", output_index: index + 1, item });
        for (const delta of [c.arguments.slice(0, 5), c.arguments.slice(5)]) send({ type: "response.function_call_arguments.delta", output_index: index + 1, delta });
        if (!options.truncated) send({ type: "response.output_item.done", output_index: index + 1, item: { ...item, arguments: c.arguments } });
      }
      else for (const delta of ["O", "K"]) send({ type: "response.output_text.delta", delta });
      send({ type: options.truncated ? "response.incomplete" : "response.completed", response: { usage, ...(options.truncated ? { incomplete_details: { reason: "max_output_tokens" } } : {}) } });
    } else {
      send({ type: "message_start", message: { usage: usage === undefined ? undefined : { ...usage, output_tokens: 0 } } });
      send({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
      send({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "synthetic reasoning" } });
      send({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signature-required" } });
      send({ type: "content_block_stop", index: 0 });
      if (tool) for (const [index, c] of calls.entries()) {
        send({ type: "content_block_start", index: index + 1, content_block: { type: "tool_use", id: c.id, name: c.name, input: {} } });
        for (const partial_json of [c.arguments.slice(0, 5), c.arguments.slice(5)]) send({ type: "content_block_delta", index: index + 1, delta: { type: "input_json_delta", partial_json } });
        send({ type: "content_block_stop", index: index + 1 });
      }
      else {
        send({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
        for (const text of ["O", "K"]) send({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text } });
        send({ type: "content_block_stop", index: 1 });
      }
      send({ type: "message_delta", delta: { stop_reason: options.truncated ? "max_tokens" : tool ? "tool_use" : "end_turn" }, usage: usage === undefined ? undefined : { output_tokens: usage.output_tokens } });
      send({ type: "message_stop" });
    }
    res.end();
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/custom/v1`, requests,
    close: () => new Promise<void>(r => { server.close(() => r()); server.closeAllConnections(); }) };
}
