// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { completeChatRequest, createModelRequest, streamModelTurn } from "./index.js";
import { protocolProvider } from "../../../test/helpers/protocol-provider.js";
const protocols = ["openai-chat-completions", "openai-responses", "anthropic-messages"] as const;
const policy = { maxRetries: 0, maxTokens: 128, requestTimeoutMs: 1000, topP: .8 };
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
      const response = await completeChatRequest(endpoint, { messages: [{ role: "system", content: "synthetic system" }, ...history], tools: tools.map(t => ({ type: "function", function: t })), top_p: .8 }, AbortSignal.timeout(2000));
      const native = await response.json() as any;
      assert.equal(native.choices[0].finish_reason, "tool_calls");
      const follow = await completeChatRequest(endpoint, { messages: [...history, native.choices[0].message, ...native.choices[0].message.tool_calls.map((c: { id: string }) => ({ role: "tool", content: "OK", tool_call_id: c.id }))], top_p: .8 }, AbortSignal.timeout(2000));
      assert.equal((await follow.json() as any).choices[0].message.content, "OK");
      assert.ok(provider.requests.every(r => r.path.startsWith("/custom/v1/")));
      assert.ok(provider.requests.every(r => r.body.top_p === .8));
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
  let dispatches = 0;
  for (const extra of [{ stream: true }, { thinking: { type: "unknown" } }, { max_tokens: -1 }, { top_p: 1.1 }, { tools: [{ type: "unknown", function: { name: "x" } }] }]) await assert.rejects(completeChatRequest(endpoint, { ...body, ...extra }, AbortSignal.timeout(1000), async () => { dispatches++; throw new Error("Unexpected dispatch"); }));
  assert.equal(dispatches, 0);
  for (const top_p of [0, 1]) {
    await completeChatRequest(endpoint, { ...body, top_p }, AbortSignal.timeout(1000), async (_url, init) => {
      dispatches++; assert.equal(JSON.parse(String(init?.body)).top_p, top_p);
      return Response.json({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] });
    });
  }
  assert.equal(dispatches, 2);
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

for (const apiProtocol of protocols) test(`${apiProtocol} stream errors retain cause and redact echoed token`, async () => {
  const apiToken = "synthetic-echoed-credential";
  const provider = await protocolProvider(apiProtocol, { streamError: true, errorMessage: `original cause ${apiToken} ` + "x".repeat(4000) });
  try {
    await assert.rejects(streamModelTurn({ apiProtocol, baseUrl: provider.baseUrl, model: "synthetic", apiToken, proxy: { mode: "direct" } }, "s", [{ role: "user", content: "s" }], [], policy, AbortSignal.timeout(2000)), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /original cause/);
      assert.ok(!error.message.includes(apiToken));
      assert.ok(error.message.length < 2100);
      return true;
    });
  } finally { await provider.close(); }
});

test('canonical Chat assistant parallel history maps to Responses without losing content, IDs or args', () => {
  const calls = ['a', 'b'].map(id => ({ id, type: 'function', function: { name: 'echo', arguments: JSON.stringify({ id }) } }));
  const endpoint = { apiProtocol: 'openai-responses' as const, model: 'synthetic', baseUrl: 'http://fixture/v1' };
  const wire = JSON.parse(createModelRequest(endpoint, 'system', [{ role: 'assistant', content: 'retained text', tool_calls: calls }, ...calls.map(c => ({ role: 'tool', tool_call_id: c.id, content: 'result' }))], [], policy, false).body);
  assert.ok(JSON.stringify(wire).includes('retained text'));
  assert.deepEqual(wire.input.filter((v: any) => v.type === 'function_call').map((v: any) => [v.call_id, v.arguments]), calls.map(c => [c.id, c.function.arguments]));
  assert.deepEqual(wire.input.filter((v: any) => v.type === 'function_call_output').map((v: any) => v.call_id), ['a', 'b']);
  assert.throws(() => createModelRequest(endpoint, '', [{ role: 'assistant', content: '', tool_calls: [null] }], [], policy, false), /Invalid tool call history/);
});
test('Responses failed terminal errors keep native cause and redact token, including absent cause', async () => {
  for (const error of [{ message: 'original native cause synthetic-key' }, undefined]) {
    const server = createServer(async (req, res) => { for await (const _ of req) {} res.setHeader('content-type', 'text/event-stream'); res.end(`data: ${JSON.stringify({ type: 'response.failed', response: { error } })}\n\n`); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    try { await assert.rejects(streamModelTurn({ apiProtocol: 'openai-responses', baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, apiToken: 'synthetic-key', model: 's', proxy: { mode: 'direct' } }, '', [], [], policy, AbortSignal.timeout(2000)), (e: Error) => { assert.match(e.message, /Responses API failed/); if (error) assert.match(e.message, /original native cause/); assert.ok(!e.message.includes('synthetic-key')); return true; }); }
    finally { await new Promise<void>(r => { server.close(() => r()); server.closeAllConnections(); }); }
  }
});

for (const apiProtocol of protocols) test(`${apiProtocol} validates top_p before dispatch`, () => {
  const endpoint = { apiProtocol, baseUrl: "http://fixture/v1", model: "synthetic" };
  for (const topP of [-1, 1.1, NaN]) assert.throws(() => createModelRequest(endpoint, "s", [], [], { ...policy, topP }, false), /top_p/);
  for (const topP of [0, 1]) assert.equal(JSON.parse(createModelRequest(endpoint, "s", [], [], { ...policy, topP }, false).body).top_p, topP);
});

test("Chat auxiliary images stay in the first user message when no system instruction was supplied", () => {
  const endpoint = { baseUrl: "http://fixture/v1", model: "synthetic" };
  const history = [{ role: "user", content: [{ type: "text", text: "synthetic" }, { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } }] }];
  const without = JSON.parse(createModelRequest(endpoint, "", history, [], policy, false).body);
  assert.equal(without.messages.length, 1); assert.equal(without.messages[0].role, "user"); assert.equal(without.messages[0].content.length, 2);
  const withSystem = JSON.parse(createModelRequest(endpoint, "actual system instruction", history, [], policy, false).body);
  assert.deepEqual(withSystem.messages[0], { role: "system", content: "actual system instruction" }); assert.equal(withSystem.messages[1].content.length, 2);
});

test("only an explicitly truncated Chat null reply retains usage and is not a successful basic answer", async () => {
  const endpoint = { baseUrl: 'http://synthetic.invalid/v1', model: 'synthetic' };
  for (const finish_reason of ['length', 'stop', undefined]) {
    const invoke = () => completeChatRequest(endpoint, { messages: [{ role: 'user', content: 'synthetic' }] }, AbortSignal.timeout(1000), async () => Response.json({ choices: [{ message: { content: null }, finish_reason }], usage: { prompt_tokens: 6, completion_tokens: 8, total_tokens: 14 } }));
    if (finish_reason === 'length') { const body = await (await invoke()).json() as any; assert.equal(body.choices[0].message.content, null); assert.equal(body.usage.total_tokens, 14); }
    else await assert.rejects(invoke(), /Invalid Chat completion response/);
  }
});

for (const apiProtocol of protocols) test(`${apiProtocol} preserves header-only stream timeout and honors caller cancellation`, async () => {
  const frames = apiProtocol === 'anthropic-messages' ? [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'OK' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  ] : apiProtocol === 'openai-responses' ? [
    { type: 'response.output_text.delta', delta: 'OK' }, { type: 'response.completed', response: { status: 'completed' } },
  ] : [{ choices: [{ delta: { content: 'OK' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }];
  const server = createServer(async (req, res) => {
    for await (const _ of req) {}
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify(frames[0])}\n\n`);
    const heartbeat = setInterval(() => res.write(': generating\n\n'), 20);
    const end = setTimeout(() => res.end(`data: ${JSON.stringify(frames[1])}\n\n`), 250);
    res.on('close', () => { clearInterval(heartbeat); clearTimeout(end); });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const endpoint = { apiProtocol, baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, model: 'synthetic', proxy: { mode: 'direct' as const } };
    const invoke = (signal: AbortSignal) => streamModelTurn(endpoint, '', [], [], { ...policy, requestTimeoutMs: 100 }, signal);
    const result = await invoke(AbortSignal.timeout(2000));
    assert.equal(result.assistantMessage.content, 'OK'); assert.equal(result.completionObserved, true);
    await assert.rejects(invoke(AbortSignal.timeout(50)));
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

test('explicit Responses provider errors retain cause, classification and conservative unknown-code behavior', async () => {
  const endpoint = { apiProtocol: 'openai-responses' as const, baseUrl: 'http://fixture.test/v1', model: 's', apiToken: 'secret-native-388', proxy: { mode: 'direct' as const } };
  for (const [error, status] of [
    [{ code: 'server_error' }, 502], [{ type: 'server_error' }, 502],
    [{ code: 'rate_limit_exceeded' }, 429], [{ code: 'invalid_api_key' }, 401],
    [{ code: 'invalid_request_error' }, 400], [{ code: 'unrecognized' }, 422], [{}, 422],
  ] as const) {
    const result = await completeChatRequest(endpoint, { messages: [{ role: 'user', content: 'synthetic' }] }, AbortSignal.timeout(1000), async () => Response.json({ object: 'response', status: 'failed', output: [], error: { ...error, message: 'original native cause secret-native-388' } }));
    assert.equal(result.status, status);
    const text = await result.text(); assert.match(text, /original native cause/); assert.ok(!text.includes(endpoint.apiToken));
    assert.deepEqual(JSON.parse(text).error, { ...error, message: 'original native cause [redacted]' });
  }
  await assert.rejects(completeChatRequest(endpoint, { messages: [{ role: 'user', content: 'synthetic' }] }, AbortSignal.timeout(1000), async () => Response.json({})), /Invalid Responses completion/);
});
