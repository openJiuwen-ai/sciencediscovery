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
