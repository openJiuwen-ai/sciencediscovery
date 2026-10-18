// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { completeChatRequest, createModelRequest, streamModelTurn } from "./index.js";
import { protocolProvider } from "../../../test/helpers/protocol-provider.js";
const protocols = ["openai-chat-completions", "openai-responses", "anthropic-messages"] as const;
const policy = { maxRetries: 0, maxTokens: 128, requestTimeoutMs: 1000 };
const tools = [{ name: "compatibility_echo", description: "echo", parameters: { type: "object" } }];
for (const apiProtocol of protocols) {
  for (const usage of ["valid", "missing", "malformed"] as const) test(`${apiProtocol} non-stream and streamed parallel tool round trips with ${usage} usage`, async () => {
    const provider = await protocolProvider(apiProtocol, { parallel: true, usage });
    const endpoint = { apiProtocol, baseUrl: provider.baseUrl, model: "synthetic", apiToken: "synthetic", proxy: { mode: "direct" as const } };
    try {
      const history = [{ role: "user", content: "synthetic" }];
      const deltas: string[] = [];
      const first = await streamModelTurn(endpoint, "synthetic system", history, tools, policy, AbortSignal.timeout(2000), { onToolCallDelta: d => deltas.push(d.arguments) });
      assert.deepEqual(first.toolCalls.map(c => c.id), ["call-0", "call-1"]);
      assert.deepEqual(first.toolCalls.map(c => c.args), [{ value: "OK" }, { value: "OK" }]);
      assert.equal(first.completionObserved, true);
      assert.equal(Boolean(first.usage), usage === "valid");
      assert.ok(deltas.join("").includes('{"value":"OK"}'));
      const nextHistory = [...history, first.assistantMessage, ...first.toolCalls.map(c => ({ role: "tool", content: "OK", tool_call_id: c.id }))];
      const final = await streamModelTurn(endpoint, "synthetic system", nextHistory, tools, policy, AbortSignal.timeout(2000));
      assert.equal(final.assistantMessage.content, "OK");
      const response = await completeChatRequest(endpoint, { messages: [{ role: "system", content: "synthetic system" }, ...history], tools: tools.map(t => ({ type: "function", function: t })) }, AbortSignal.timeout(2000));
      const native = await response.json() as any;
      assert.equal(native.choices[0].finish_reason, "tool_calls");
      const follow = await completeChatRequest(endpoint, { messages: [...history, native.choices[0].message, ...native.choices[0].message.tool_calls.map((c: { id: string }) => ({ role: "tool", content: "OK", tool_call_id: c.id }))] }, AbortSignal.timeout(2000));
      assert.equal((await follow.json() as any).choices[0].message.content, "OK");
      assert.ok(provider.requests.every(r => r.path.startsWith("/custom/v1/")));
    } finally { await provider.close(); }
  });
  test(`${apiProtocol} preserves truncation, malformed tool args, provider and stream errors, cancellation`, async () => {
    for (const options of [{ truncated: true }, { invalidArgs: true }, { status: 403 }, { streamError: true }, { hang: true }] as const) {
      const provider = await protocolProvider(apiProtocol, options);
      const endpoint = { apiProtocol, baseUrl: provider.baseUrl, model: "synthetic", proxy: { mode: "direct" as const } };
      try {
        const invoke = () => streamModelTurn(endpoint, "s", [{ role: "user", content: "s" }], tools, policy, AbortSignal.timeout("hang" in options ? 30 : 2000));
        if ("status" in options || "streamError" in options) await assert.rejects(invoke(), /original fixture/);
        else if ("hang" in options) await assert.rejects(invoke());
        else {
          const turn = await invoke();
          if ("truncated" in options) assert.equal(turn.truncated, true);
          else assert.ok(turn.toolCalls[0]?.argsParseError);
        }
      } finally { await provider.close(); }
    }
  });
  test(`${apiProtocol} translates multimodal input and preserves selected protocol`, async () => {
    const request = createModelRequest({ apiProtocol, baseUrl: "http://fixture.test/prefix/v1", model: "s" }, "s", [{ role: "user", content: [{ type: "text", text: "describe" }, { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=", detail: "high" } }] }], [], policy, false);
    const body = JSON.parse(request.body);
    assert.ok(JSON.stringify(body).includes(apiProtocol === "openai-responses" ? "input_image" : apiProtocol === "anthropic-messages" ? "media_type" : "image_url"));
  });
}

test("non-stream boundary rejects unsupported controls, malformed/oversized responses and retains original errors", async () => {
  const endpoint = { baseUrl: "http://fixture.test/v1", model: "s", proxy: { mode: "direct" as const } };
  const body = { messages: [{ role: "user", content: "synthetic" }] };
  for (const extra of [{ stream: true }, { thinking: { type: "unknown" } }, { max_tokens: -1 }, { top_p: 1 }, { tools: [{ type: "unknown", function: { name: "x" } }] }]) await assert.rejects(completeChatRequest(endpoint, { ...body, ...extra }, AbortSignal.timeout(1000)));
  await assert.rejects(completeChatRequest(endpoint, { messages: [{ role: "invalid", content: "x" }] }, AbortSignal.timeout(1000)));
  for (const payload of ['{}', '[]', 'not json']) await assert.rejects(completeChatRequest(endpoint, body, AbortSignal.timeout(1000), async () => new Response(payload)));
  await assert.rejects(completeChatRequest(endpoint, body, AbortSignal.timeout(1000), async () => new Response('x'.repeat(200)), 100), /byte limit/);
  const failed = await completeChatRequest(endpoint, body, AbortSignal.timeout(1000), async () => new Response('{"error":"original"}', { status: 429 }));
  assert.equal(failed.status, 429); assert.match(await failed.text(), /original/);
});

test("Messages rejects malformed canonical tool arguments and missing history IDs instead of dropping them", async () => {
  const { toAnthropicMessages } = await import("./client.js");
  for (const call of [{ id: "c", function: { name: "echo", arguments: "[]" } }, { function: { name: "echo", arguments: "{}" } }]) assert.throws(() => toAnthropicMessages([{ role: "assistant", content: "", tool_calls: [call] }]), /tool|history/i);
});

for (const protocol of protocols) test(`${protocol} refuses a missing provider tool ID and cancels unary requests`, async () => {
  const provider = await protocolProvider(protocol, { hang: true });
  try {
    await assert.rejects(completeChatRequest({ apiProtocol: protocol, baseUrl: provider.baseUrl, model: "s", proxy: { mode: "direct" } }, { messages: [{ role: "user", content: "s" }] }, AbortSignal.timeout(30)));
  } finally { await provider.close(); }
  const { createServer } = await import("node:http");
  const frame = protocol === "openai-chat-completions" ? { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "echo", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }
    : protocol === "openai-responses" ? { type: "response.output_item.done", output_index: 0, item: { type: "function_call", name: "echo", arguments: "{}" } }
    : { type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "echo", input: {} } };
  const server = createServer(async (req, res) => { for await (const _chunk of req) {} res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`data: ${JSON.stringify(frame)}\n\n`); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  try { await assert.rejects(streamModelTurn({ apiProtocol: protocol, baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, model: "s", proxy: { mode: "direct" } }, "s", [], [], policy, AbortSignal.timeout(1000)), /omitted a tool call ID/); }
  finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

test("Responses replays observed text when native text-item snapshots are absent", async () => {
  const provider = await protocolProvider("openai-responses");
  try {
    const endpoint = { apiProtocol: "openai-responses" as const, baseUrl: provider.baseUrl, model: "synthetic", proxy: { mode: "direct" as const } };
    const turn = await streamModelTurn(endpoint, "s", [{ role: "user", content: "synthetic" }], [], policy, AbortSignal.timeout(2000));
    await streamModelTurn(endpoint, "s", [turn.assistantMessage, { role: "user", content: "continue" }], [], policy, AbortSignal.timeout(2000));
    assert.match(JSON.stringify(provider.requests[1]!.body.input), /encrypted-required/);
    assert.match(JSON.stringify(provider.requests[1]!.body.input), /output_text.*OK/);
  } finally { await provider.close(); }
});

test("Messages streams initial text and thinking exactly once", async () => {
  const { createServer } = await import("node:http");
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {}
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "initial thought", signature: "sig" } }, { type: "content_block_start", index: 1, content_block: { type: "text", text: "O" } }, { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "K" } }, { type: "message_delta", delta: { stop_reason: "end_turn" } }]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  try {
    let text = "", thought = "";
    const turn = await streamModelTurn({ apiProtocol: "anthropic-messages", baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, model: "s", proxy: { mode: "direct" } }, "s", [], [], policy, AbortSignal.timeout(2000), { onTextDelta: d => { text += d; }, onThinkingDelta: d => { thought += d; } });
    assert.equal(text, "OK"); assert.equal(thought, "initial thought"); assert.equal(turn.assistantMessage.content, "OK");
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

for (const apiProtocol of protocols) test(`${apiProtocol} streaming response byte ceiling terminates an oversized stream`, async () => {
  const provider = await protocolProvider(apiProtocol);
  try { await assert.rejects(streamModelTurn({ apiProtocol, baseUrl: provider.baseUrl, model: "s", proxy: { mode: "direct" } }, "s", [], [], { ...policy, maxResponseBytes: 8 }, AbortSignal.timeout(1000)), /byte limit/); }
  finally { await provider.close(); }
});
