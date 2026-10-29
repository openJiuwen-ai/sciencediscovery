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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { protocolProvider } from "../../../test/helpers/protocol-provider.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";


import type { ModelConnectivityTestResult, ModelProfile } from "@sciencediscovery/schema";

import { ModelConnectivityTestCoordinator, testModelConnectivity } from "./model-connectivity.js";

function profile(baseUrl: string): ModelProfile {
  return {
    baseUrl,
    createdAt: "2026-08-26T00:00:00.000Z",
    hasApiToken: true,
    id: "model-1",
    model: "provider-model",
    name: "Provider model",
    proxyPolicy: "none",
    updatedAt: "2026-08-26T00:00:00.000Z",
    vision: false,
  };
}

async function readRequest(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += chunk.toString();
  return body;
}

async function withProvider<T>(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  run: (origin: string) => Promise<T>,
): Promise<T> {
  const server = createServer((request, response) => void handler(request, response));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const directProxy = () => ({ mode: "direct" } as const);

test("CFG-R02: every compatibility dispatch has a final destination guard, including the tool-result round trip", async () => {
  const provider = await protocolProvider("all"); let checks = 0;
  try {
    const tested = await testModelConnectivity({ apiToken: "synthetic", profile: profile(provider.baseUrl), resolveProxy: directProxy, compatibility: true,
      beforeDispatch: destination => { checks++; assert.ok(destination.apiProtocol); } });
    assert.ok(tested.ok); assert.equal(checks, 12); assert.equal(provider.requests.length, 12);
  } finally { await provider.close(); }
  const denied = await protocolProvider("all"); let denials = 0;
  try {
    const tested = await testModelConnectivity({ apiToken: "must-not-send", profile: profile(denied.baseUrl), resolveProxy: directProxy, compatibility: true,
      beforeDispatch: () => { denials++; throw new Error("Destination changed"); } });
    assert.equal(tested.ok, false); assert.equal(denied.requests.length, 0); assert.equal(denials, 9);
  } finally { await denied.close(); }
});

test("connectivity probe uses the saved endpoint, model, and API token", async () => {
  await withProvider(async (request, response) => {
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer saved-secret");
    const body = JSON.parse(await readRequest(request)) as Record<string, unknown>;
    assert.equal(body.model, "provider-model");
    assert.equal(body.stream, false);
    assert.equal(body.max_tokens, 8);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
  }, async (origin) => {
    const tested = await testModelConnectivity({
      apiToken: "saved-secret",
      profile: profile(`${origin}/v1/`),
      resolveProxy: directProxy,
    });
    assert.equal(tested.ok, true);
    assert.equal(tested.category, "ok");
    assert.equal(tested.providerStatus, 200);
  });
});

test("missing model token fails locally without resolving a proxy or calling a provider", async () => {
  let proxyResolved = false;
  const tested = await testModelConnectivity({
    profile: profile("http://127.0.0.1:1/v1"),
    resolveProxy: () => {
      proxyResolved = true;
      return { mode: "direct" };
    },
  });
  assert.equal(tested.category, "missing_token");
  assert.equal(tested.ok, false);
  assert.equal(proxyResolved, false);
});

test("token-optional provider can be probed without an authorization header", async () => {
  await withProvider(async (request, response) => {
    assert.equal(request.headers.authorization, undefined);
    await readRequest(request);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
  }, async (origin) => {
    const tested = await testModelConnectivity({
      allowMissingToken: true,
      profile: profile(`${origin}/v1`),
      resolveProxy: directProxy,
    });
    assert.equal(tested.category, "ok");
  });
});

test("provider HTTP failures have stable connectivity categories", async () => {
  const categories = new Map<number, ModelConnectivityTestResult["category"]>([
    [401, "authorization"],
    [403, "authorization"],
    [404, "not_found"],
    [429, "rate_limited"],
    [500, "provider_error"],
  ]);
  await withProvider((request, response) => {
    const status = Number(request.url?.split("/")[1]);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "sensitive provider detail" } }));
  }, async (origin) => {
    for (const [status, category] of categories) {
      const tested = await testModelConnectivity({
        apiToken: "secret",
        profile: profile(`${origin}/${status}`),
        resolveProxy: directProxy,
      });
      assert.equal(tested.category, category);
      assert.equal(tested.providerStatus, status);
      assert.doesNotMatch(tested.message, /sensitive provider detail/);
    }
  });
});

test("reasoning response with an empty final body is still a valid completion", async () => {
  await withProvider(async (request, response) => {
    await readRequest(request);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: null, reasoning_content: "OK" } }] }));
  }, async (origin) => {
    const tested = await testModelConnectivity({
      apiToken: "secret",
      profile: profile(origin),
      resolveProxy: directProxy,
    });
    assert.equal(tested.category, "ok");
  });
});

test("malformed successful responses are classified as incompatible", async () => {
  await withProvider(async (request, response) => {
    await readRequest(request);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ result: "OK" }));
  }, async (origin) => {
    const tested = await testModelConnectivity({
      apiToken: "secret",
      profile: profile(origin),
      resolveProxy: directProxy,
    });
    assert.equal(tested.category, "invalid_response");
    assert.equal(tested.ok, false);
  });
});

test("connectivity probe has an independent short timeout", async () => {
  await withProvider(async (request) => {
    await readRequest(request);
  }, async (origin) => {
    const tested = await testModelConnectivity({
      apiToken: "secret",
      profile: profile(origin),
      resolveProxy: directProxy,
      timeoutMs: 25,
    });
    assert.equal(tested.category, "timeout");
  });
});

test("coordinator coalesces concurrent tests and allows a later retest", async () => {
  const coordinator = new ModelConnectivityTestCoordinator();
  const successful: ModelConnectivityTestResult = {
    category: "ok",
    latencyMs: 1,
    message: "Connection succeeded",
    ok: true,
    providerStatus: 200,
    testedAt: "2026-08-26T00:00:00.000Z",
  };
  let calls = 0;
  let release: (() => void) | undefined;
  const deferred = new Promise<void>((resolve) => { release = resolve; });
  const run = () => coordinator.run("model-1", async () => {
    calls += 1;
    await deferred;
    return successful;
  });
  const first = run();
  const second = run();
  assert.equal(first, second);
  assert.equal(calls, 1);
  release?.();
  await first;
  await coordinator.run("model-1", async () => {
    calls += 1;
    return successful;
  });
  assert.equal(calls, 2);
});

for (const protocol of ["openai-chat-completions", "openai-responses", "anthropic-messages"] as const) {
  test(`compatibility matrix independently verifies ${protocol} and leaves selection unchanged`, async () => {
    const { protocolProvider } = await import("../../../test/helpers/protocol-provider.js");
    const provider = await protocolProvider(protocol);
    try {
      const selected = { ...profile(provider.baseUrl), apiProtocol: protocol };
      const tested = await testModelConnectivity({ apiToken: "fixture-secret-388", profile: selected, resolveProxy: directProxy, compatibility: true, timeoutMs: 1000 });
      const matching = tested.protocols!.find(p => p.apiProtocol === protocol)!;
      assert.equal(tested.ok, true);
      assert.equal(matching.basic.ok, true);
      assert.equal(matching.streaming.ok, true);
      assert.equal(matching.tools.ok, true);
      assert.equal(matching.usage, "available");
      assert.equal(selected.apiProtocol, protocol);
      assert.equal(tested.protocols!.filter(p => p.basic.ok).length, 1);
      assert.equal(provider.requests.length, 10, "4 matching requests plus three attempts for each incompatible protocol");
      assert.doesNotMatch(JSON.stringify(tested), /fixture-secret-388|signature-required|encrypted-required/);
    } finally { await provider.close(); }
  });
}

for (const usage of ["missing", "malformed"] as const) test(`missing capability usage stays unknown: ${usage}`, async () => {
  const { protocolProvider } = await import("../../../test/helpers/protocol-provider.js");
  const provider = await protocolProvider("anthropic-messages", { usage });
  try {
    const tested = await testModelConnectivity({ apiToken: "fixture-secret-388", profile: { ...profile(provider.baseUrl), apiProtocol: "anthropic-messages" }, resolveProxy: directProxy, compatibility: true, timeoutMs: 1000 });
    const matching = tested.protocols!.find(p => p.apiProtocol === "anthropic-messages")!;
    assert.equal(matching.basic.ok, true); assert.equal(matching.tools.ok, true); assert.equal(matching.usage, "unknown");
  } finally { await provider.close(); }
});

test("one endpoint can support multiple protocols without changing the saved selection", async () => {
  const { protocolProvider } = await import("../../../test/helpers/protocol-provider.js");
  const provider = await protocolProvider("all");
  try {
    const selected = { ...profile(provider.baseUrl), apiProtocol: "openai-responses" as const };
    const tested = await testModelConnectivity({ apiToken: "fixture-secret-388", profile: selected, resolveProxy: directProxy, compatibility: true, timeoutMs: 1000 });
    assert.equal(tested.protocols!.length, 3);
    assert.ok(tested.protocols!.every(p => p.basic.ok && p.streaming.ok && p.tools.ok && p.usage === "available"));
    assert.equal(selected.apiProtocol, "openai-responses"); assert.equal(provider.requests.length, 12);
  } finally { await provider.close(); }
});

test("empty native and Chat successful payloads do not certify a basic capability", async () => {
  for (const [apiProtocol, payload] of [
    ["openai-chat-completions", { choices: [{ message: { content: "" } }] }],
    ["openai-responses", { object: "response", status: "completed", output: [] }],
    ["anthropic-messages", { type: "message", content: [] }],
  ] as const) await withProvider(async (request, response) => {
    await readRequest(request); response.end(JSON.stringify(payload));
  }, async origin => {
    const result = await testModelConnectivity({ apiToken: "fixture-secret-388", profile: { ...profile(origin), apiProtocol }, resolveProxy: directProxy });
    assert.equal(result.category, "invalid_response"); assert.equal(result.ok, false);
  });
});

test("network errors are distinct from successful but malformed responses", async () => {
  const tested = await testModelConnectivity({ apiToken: "fixture-secret-388", profile: profile("http://127.0.0.1:1"), resolveProxy: directProxy });
  assert.equal(tested.category, "network");
});

test("malformed native blocks cannot certify a basic capability", async () => {
  for (const [apiProtocol, payload] of [
    ["openai-chat-completions", { choices: [{ message: { tool_calls: [null] } }] }],
    ["openai-responses", { object: "response", output: [{ type: "not-a-model-item" }] }],
    ["openai-responses", { object: "response", output: [{ type: "message", content: [{ type: "output_text", text: {} }] }] }],
    ["anthropic-messages", { type: "message", content: [{ type: "not-a-model-block" }] }],
    ["anthropic-messages", { type: "message", content: [{ type: "text", text: {} }] }],
  ] as const) await withProvider(async (request, response) => { await readRequest(request); response.end(JSON.stringify(payload)); }, async origin => {
    assert.equal((await testModelConnectivity({ apiToken: "fixture-secret-388", profile: { ...profile(origin), apiProtocol }, resolveProxy: directProxy })).category, "invalid_response");
  });
});

for (const apiProtocol of ["openai-chat-completions", "openai-responses", "anthropic-messages"] as const) test(`${apiProtocol} basic truncation at the probe's own limit still proves the endpoint answers`, async () => {
  await withProvider(async (request, response) => {
    const body = JSON.parse(await readRequest(request));
    response.setHeader("content-type", "application/json");
    if (body.stream) { response.writeHead(403); response.end(JSON.stringify({ error: { message: "synthetic stream rejection" } })); return; }
    response.end(JSON.stringify(apiProtocol === "openai-chat-completions"
      ? { choices: [{ finish_reason: "length", message: { content: "partial" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
      : apiProtocol === "openai-responses" ? { object: "response", status: "incomplete", output: [{ type: "message", content: [{ type: "output_text", text: "partial" }] }], usage: { input_tokens: 1, output_tokens: 1 } }
      : { type: "message", stop_reason: "max_tokens", content: [{ type: "text", text: "partial" }], usage: { input_tokens: 1, output_tokens: 1 } }));
  }, async origin => {
    const result = await testModelConnectivity({ apiToken: "synthetic", profile: { ...profile(origin), apiProtocol }, resolveProxy: directProxy, compatibility: true, timeoutMs: 1000 });
    const selected = result.protocols?.find(p => p.apiProtocol === apiProtocol); assert.ok(selected);
    // A reasoning model answers this probe with `finish_reason: "length"` and
    // no final text; the endpoint is reachable and speaks the protocol, so the
    // truncated reply is a pass rather than a verdict of "incompatible".
    assert.equal(selected.basic.ok, true); assert.equal(selected.basic.category, "ok");
    assert.equal(selected.basic.inconclusiveReason, undefined);
    assert.match(selected.basic.message, /cut at the probe's output limit/);
    assert.equal(selected.streaming.category, "authorization"); assert.match(selected.streaming.message, /API key is invalid or is not authorized/); assert.equal(selected.tools.category, "authorization"); assert.equal(selected.usage, "available");
  });
});

test('compatibility outer deadlines still stop healthy partial streams independently of normal header timeouts', async () => {
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': healthy but no terminal result\n\n');
      const heartbeat = setInterval(() => res.write(': generating\n\n'), 10);
      res.on('close', () => clearInterval(heartbeat)); return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(req.url?.endsWith('/messages')
      ? { type: 'message', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' }
      : req.url?.endsWith('/responses') ? { object: 'response', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }], status: 'completed' }
      : { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    // Give immediate basic controls the ordinary success budget; these streams
    // intentionally never terminate, so their outer-timeout result is deterministic.
    const result = await testModelConnectivity({ apiToken: 'synthetic', profile: profile(`http://127.0.0.1:${(server.address() as any).port}/v1`), resolveProxy: directProxy, compatibility: true, timeoutMs: 1000 });
    assert.equal(result.protocols?.length, 3);
    for (const protocol of result.protocols!) { assert.equal(protocol.basic.ok, true); assert.equal(protocol.streaming.category, 'timeout'); assert.equal(protocol.tools.category, 'timeout'); }
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

test('Responses basic uses the documented16-token probe minimum while runtime explicit budgets remain untouched', async () => {
  const provider = await protocolProvider('openai-responses');
  try {
    const tested = await testModelConnectivity({ apiToken: 'synthetic', profile: { ...profile(provider.baseUrl), apiProtocol: 'openai-responses' }, resolveProxy: directProxy });
    assert.equal(tested.ok, true); assert.equal(provider.requests.length, 1); assert.equal(provider.requests[0]!.body.max_output_tokens, 16);
  } finally { await provider.close(); }
});
for (const acknowledgement of ['OK.', ' ok! ', 'unexpected answer']) test(`tool acknowledgement ${acknowledgement} retains identity/history checks without exact punctuation matching`, async () => {
  const provider = await protocolProvider('all', { acknowledgement });
  try {
    const tested = await testModelConnectivity({ apiToken: 'synthetic', profile: profile(provider.baseUrl), resolveProxy: directProxy, compatibility: true });
    assert.equal(provider.requests.length, 12); assert.ok(tested.protocols!.every(p => p.tools.ok === (acknowledgement !== 'unexpected answer')));
  } finally { await provider.close(); }
});

test("declared protocols on arbitrary gateways and complete endpoint URLs match the real client", async () => {
  let calls = 0;
  await withProvider(async (request, response) => {
    calls++; const body = JSON.parse(await readRequest(request)) as Record<string, unknown>;
    assert.equal(body.model, "provider-model"); assert.equal(body.stream, false);
    if (request.url === "/gateway/v1/messages") {
      assert.equal(request.headers["x-api-key"], "protocol-secret"); assert.equal(request.headers.authorization, undefined);
      assert.equal(body.max_tokens, 8); assert.ok(Array.isArray(body.messages));
      response.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "OK" }] }));
    } else if (request.url === "/gateway/v1/responses") {
      assert.equal(request.headers.authorization, "Bearer protocol-secret"); assert.equal(body.max_output_tokens, 16);
      assert.equal(body.store, false); assert.ok(Array.isArray(body.input)); assert.equal(body.messages, undefined);
      response.end(JSON.stringify({ object: "response", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] }));
    } else {
      assert.equal(request.url, "/api/plan/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer protocol-secret"); assert.equal(request.headers["x-api-key"], undefined);
      assert.deepEqual(body.thinking, { type: "disabled" });
      response.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
    }
  }, async origin => {
    for (const endpoint of [
      { apiProtocol: "anthropic-messages" as const, apiVariant: "anthropic-legacy" as const, baseUrl: `${origin}/gateway/v1/messages` },
      { apiProtocol: "openai-responses" as const, apiVariant: "responses" as const, baseUrl: `${origin}/gateway/v1/responses/` },
      // Explicit chat overrides the old /api/plan heuristic.
      { apiProtocol: "openai-chat-completions" as const, apiVariant: "deepseek" as const, baseUrl: `${origin}/api/plan/v1/chat/completions` },
    ]) {
      assert.equal((await testModelConnectivity({ apiToken: "protocol-secret", profile: { ...profile(endpoint.baseUrl), ...endpoint }, resolveProxy: directProxy })).category, "ok");
    }
  });
  assert.equal(calls, 3);
});

test("legacy profiles retain the plan endpoint fallback without duplicating /v1", async () => {
  await withProvider(async (request, response) => {
    assert.equal(request.url, "/api/plan/v1/messages"); assert.equal(request.headers["x-api-key"], "secret");
    await readRequest(request); response.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "OK" }] }));
  }, async origin => {
    assert.equal((await testModelConnectivity({ apiToken: "secret", profile: profile(`${origin}/api/plan/v1`), resolveProxy: directProxy })).category, "ok");
  });
});

test("redirect responses never forward credentials or replay the paid probe", async () => {
  let sent = 0; let redirected = 0;
  await withProvider(async (request, response) => {
    redirected++; await readRequest(request); response.end(JSON.stringify({ choices: [{ message: { content: "should not be reached" } }] }));
  }, async destination => {
    await withProvider(async (request, response) => {
      sent++; await readRequest(request); response.writeHead(307, { location: `${destination}/stolen` }); response.end();
    }, async origin => {
      const tested = await testModelConnectivity({ apiToken: "secret", profile: profile(origin), resolveProxy: directProxy });
      assert.equal(tested.category, "provider_error"); assert.equal(tested.providerStatus, 307);
    });
  });
  assert.equal(sent, 1); assert.equal(redirected, 0);
});

test("64 KiB byte budget aborts an oversized response without draining the provider stream", async () => {
  let calls = 0; let closed = false;
  let signalClosed!: () => void;
  const responseClosed = new Promise<void>(resolve => { signalClosed = resolve; });
  await withProvider(async (request, response) => {
    calls++; await readRequest(request); response.writeHead(200, { "content-type": "application/json" });
    response.on("close", () => { closed = true; signalClosed(); });
    // Multibyte UTF-8 must be counted as bytes, and the stream never terminates.
    response.write(JSON.stringify({ choices: [{ message: { content: "测".repeat(24_000) } }] }));
  }, async origin => {
    const tested = await testModelConnectivity({ apiToken: "secret", profile: profile(origin), resolveProxy: directProxy, timeoutMs: 5000 });
    assert.equal(tested.category, "invalid_response"); assert.match(tested.message, /limit/);
    // Observe real asynchronous socket cancellation well before the 5s probe
    // deadline, so the timeout cannot accidentally satisfy this assertion.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("The oversized response socket did not close after cancellation")), 1000);
      responseClosed.then(() => { clearTimeout(timeout); resolve(); }, reject);
    });
  });
  assert.equal(calls, 1); assert.equal(closed, true);
});

test("401 and 429 remain one non-retried operation and exclude raw provider data", async () => {
  let calls = 0;
  await withProvider(async (request, response) => {
    calls++; await readRequest(request); response.writeHead(calls === 1 ? 401 : 429, { "retry-after": "0" });
    response.end(JSON.stringify({ error: { message: "echoed-credential" } }));
  }, async origin => {
    for (const category of ["authorization", "rate_limited"]) {
      const tested = await testModelConnectivity({ apiToken: "echoed-credential", profile: profile(origin), resolveProxy: directProxy });
      assert.equal(tested.category, category); assert.equal(JSON.stringify(tested).includes("echoed-credential"), false);
    }
  });
  assert.equal(calls, 2);
});

test("invalid protocol and variant pairs fail before contacting a provider", async () => {
  let calls = 0;
  await withProvider((_, response) => { calls++; response.end(); }, async origin => {
    const tested = await testModelConnectivity({ apiToken: "secret", profile: { ...profile(origin), apiProtocol: "openai-responses", apiVariant: "deepseek" }, resolveProxy: directProxy });
    assert.equal(tested.category, "invalid_response");
  });
  assert.equal(calls, 0);

});

for (const phase of ["all", "tool_result"] as const) {
  test(`review 307 compatibility never forwards synthetic credentials: ${phase}`, async () => {
    const received: Array<{ headers: IncomingMessage["headers"]; body: string }> = [];
    await withProvider(async (request, response) => {
      received.push({ headers: request.headers, body: await readRequest(request) }); response.end("unexpected");
    }, async destination => {
      const provider = await protocolProvider("all", { redirect: ({ body }) => phase === "all" || /tool_call_id|function_call_output|tool_result/.test(JSON.stringify(body.messages ?? body.input)) ? `${destination}/must-not-receive` : undefined });
      try {
        const tested = await testModelConnectivity({ apiToken: "review-307-synthetic-token", profile: profile(provider.baseUrl), resolveProxy: directProxy, compatibility: true, timeoutMs: 1000 });
        assert.equal(tested.protocols?.length, 3);
        for (const result of tested.protocols ?? []) {
          assert.equal(result.basic.ok, phase === "tool_result");
          assert.equal(result.streaming.ok, phase === "tool_result");
          assert.equal(result.tools.ok, false); assert.equal(result.tools.providerStatus, 307);
          if (phase === "all") { assert.equal(result.basic.providerStatus, 307); assert.equal(result.streaming.providerStatus, 307); }
        }
        assert.equal(provider.requests.length, phase === "all" ? 9 : 12);
        assert.deepEqual(received, [], "307 destination must receive zero requests, headers and bodies");
        assert.doesNotMatch(JSON.stringify(tested), /review-307-synthetic-token/);
      } finally { await provider.close(); }
    });
  });
}
