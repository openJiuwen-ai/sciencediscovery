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

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import { setTimeout as delay } from "node:timers/promises";
import type { streamModelTurn } from "@sciencediscovery/model";

import type { AgentEvent } from "@sciencediscovery/orchestration";
import { Type } from "typebox";

import { DurableContextStore } from "@sciencediscovery/context";
import { subagentCapableParentRunTimeoutMs } from "@sciencediscovery/specialist";

import { createToolRegistry, startPluginScope, type NativeAgentOptions } from "../native-agent/index.js";
import {
  createJiuwenSwarmAgentFactory,
  jiuwenSwarmSessionKey,
  jiuwenSwarmConfigFromEnv,
} from "./jiuwenswarm-agent.js";

/** A fake adapter: records the request and lets each test script the reply. */
async function fakeAdapter(
  script: (request: { body: any; headers: IncomingMessage["headers"] }, response: ServerResponse) => Promise<void> | void,
): Promise<{ url: string; requests: any[]; close(): Promise<void>; aborted: () => boolean }> {
  const requests: any[] = [];
  let aborted = false;
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({ body, headers: request.headers });
    response.on("close", () => { if (!response.writableEnded) aborted = true; });
    await script({ body, headers: request.headers }, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    aborted: () => aborted,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

const line = (value: unknown) => JSON.stringify(value) + "\n";

test("platform tool failure before reaching the bridge remains visible to users", async () => {
  const adapter = await fakeAdapter((_request, response) => {
    response.writeHead(200);
    response.write(line({ event: { type: "tool.started", trace: {
      id: "transport-failed-call", name: "echo", args: { word: "probe" }, status: "running",
    } } }));
    const failure = line({ event: { type: "tool.completed", trace: {
      id: "transport-failed-call", name: "echo", status: "failed",
      output: "Platform MCP transport failed; inspect tool state before retrying",
    } } });
    response.write(failure);
    response.write(failure); // A replayed completion must not duplicate UI/history.
    response.end(line({ done: { status: "completed", finalText: "Tool failed; no result available." } }));
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options());
    const events = collect(agent);
    await agent.execute("go");
    const failures = events.filter((event) => event.type === "tool_execution_end"
      && event.toolCallId === "transport-failed-call");
    assert.equal(failures.length, 1, "A pre-bridge error must be emitted once, not dropped");
    assert.equal(events.filter(event => event.type === "tool_execution_start"
      && event.toolCallId === "transport-failed-call").length, 1);
    assert.equal((failures[0] as any).isError, true);
    assert.match(JSON.stringify(failures[0]), /Platform MCP transport failed/);
  } finally { await adapter.close(); }
});

test("a bridge caller cancelled while waiting for announcement never starts a tool", async () => {
  let executions = 0;
  const probe = { label: "Probe", name: "probe", description: "Must not run after cancellation.", parameters: Type.Object({}),
    execute: async () => { executions += 1; return { content: [{ type: "text" as const, text: "unexpected" }] }; } };
  const adapter = await fakeAdapter(async ({ body }, response) => {
    response.writeHead(200);
    const controller = new AbortController();
    const request = fetch(body.bridge.url, {
      method: "POST", headers: { authorization: `Bearer ${body.bridge.token}` },
      body: JSON.stringify({ name: "probe", arguments: {} }), signal: controller.signal,
    }).catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 30));
    controller.abort();
    await request;
    await new Promise(resolve => setTimeout(resolve, 150));
    response.end(line({ done: { status: "completed", finalText: "cancelled probe" } }));
  });
  try {
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url, toolAnnouncementTimeoutMs: 100 })(
      options({ extraTools: [probe as never] })).execute("go");
    assert.equal(executions, 0);
  } finally { await adapter.close(); }
});

for (const failed of [false, true]) {
  test(`bridge ${failed ? "failure" : "success"} followed by Swarm completion is reported exactly once`, async () => {
    const tool = {
      label: "Probe", name: "probe", description: "Controlled event correlation probe.", parameters: Type.Object({}),
      execute: async () => {
        if (failed) throw new Error("controlled bridge failure");
        return { content: [{ type: "text" as const, text: "controlled bridge result" }] };
      },
    };
    const adapter = await fakeAdapter(async ({ body }, response) => {
      response.writeHead(200);
      response.write(line({ event: { type: "tool.started", trace: { id: "bridged-call", name: "probe", args: {}, status: "running" } } }));
      const reply = await fetch(body.bridge.url, {
        method: "POST", headers: { authorization: `Bearer ${body.bridge.token}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "probe", arguments: {} }),
      });
      const result = await reply.json() as { text: string; isError: boolean };
      response.write(line({ event: { type: "tool.completed", trace: {
        id: "bridged-call", name: "probe", status: result.isError ? "failed" : "completed", output: result.text,
      } } }));
      response.end(line({ done: { status: "completed", finalText: "continued" } }));
    });
    try {
      const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ extraTools: [tool as never] }));
      const events = collect(agent);
      await agent.execute("go");
      const starts = events.filter(event => event.type === "tool_execution_start" && event.toolCallId === "bridged-call");
      const ends = events.filter(event => event.type === "tool_execution_end" && event.toolCallId === "bridged-call");
      assert.equal(starts.length, 1);
      assert.equal(ends.length, 1, "A fallback reporter must not duplicate an already reported bridge result");
      assert.equal((ends[0] as any).isError, failed);
    } finally { await adapter.close(); }
  });
}

for (const [name, makeReply, message] of [
  ["EOF without done", () => "", /without a terminal result/],
  ["cancelled terminal", () => line({ done: { finalText: "partial", cancelled: true } }), /cancelled/],
  ["failed status without event", () => line({ done: { finalText: "", status: "failed" } }), /failed without an error event/],
  ["invalid terminal status", () => line({ done: { finalText: "", status: "unknown" } }), /invalid terminal status/],
  ["duplicate terminal", () => line({ done: { finalText: "ok" } }).repeat(2), /after its terminal result/],
] as const) {
  test(`Swarm run contract rejects ${name}`, async () => {
    const reply = makeReply();
    const adapter = await fakeAdapter((_request, response) => { response.writeHead(200); response.end(reply); });
    try {
      const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options());
      await assert.rejects(agent.execute("go"), message);
    } finally { await adapter.close(); }
  });
}

function options(extra: Partial<NativeAgentOptions> = {}): NativeAgentOptions {
  const echo = {
    label: "Echo", name: "echo", description: "Echo a word.",
    parameters: Type.Object({ word: Type.String() }),
    execute: async (_id: string, params: { word: string }) => ({ content: [{ type: "text" as const, text: `echo:${params.word}` }] }),
  };
  return {
    config: { baseUrl: "http://llm.test/v1", dataDir: "/data", model: "gpt-x", apiToken: "sk-test", apiProtocol: "openai-chat-completions" },
    enabledConnectorIds: [],
    executePython: async () => { throw new Error("not called"); },
    executeShell: async () => { throw new Error("not called"); },
    extraTools: [echo as never],
    sessionId: "session-1",
    workspaceRoot: "/workspace",
    ...extra,
  } as NativeAgentOptions;
}

function collect(agent: { subscribe(l: (e: AgentEvent) => void): () => void }): AgentEvent[] {
  const events: AgentEvent[] = [];
  agent.subscribe((event) => events.push(event));
  return events;
}

test("sends the prompt, model and the run's tools to the adapter and returns the final text", async () => {
  const adapter = await fakeAdapter((_request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.end(line({ event: { type: "agent.phase", phase: "thinking", turn: 1 } }) + line({ done: { finalText: "hi there" } }));
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url, adapterToken: "secret" })(options());
    const result = await agent.execute("hello");
    assert.deepEqual(result.finalMessages, [{ role: "user", content: "hello" }, { role: "assistant", content: "hi there" }]);
    const { body, headers } = adapter.requests[0];
    assert.equal(headers.authorization, "Bearer secret");
    assert.equal(body.sessionId, "session-1");
    assert.equal(body.prompt, "hello");
    assert.equal(body.cwd, "/workspace");
    assert.equal(typeof body.systemPrompt, "string");
    assert.ok(body.systemPrompt.length > 200, "the run gets the workspace system prompt, not an empty one");
    assert.equal(body.model.model, "gpt-x");
    assert.match(body.model.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/, "the adapter is pointed at the run's loopback model gateway, not the provider");
    assert.notEqual(body.model.apiKey, "sk-test", "the provider's key never leaves this process");
    assert.equal(body.model.provider, "OpenAI");
    const echo = body.tools.find((tool: { name: string }) => tool.name === "echo");
    assert.equal(echo.description, "Echo a word.");
    assert.deepEqual(echo.inputSchema.required, ["word"]);
    assert.match(body.bridge.url, /^http:\/\/127\.0\.0\.1:\d+\/bridge$/);
  } finally {
    await adapter.close();
  }
});

test("translates the adapter's run events into agent events", async () => {
  const adapter = await fakeAdapter((_request, response) => {
    response.writeHead(200);
    response.write(line({ event: { type: "agent.phase", phase: "thinking", turn: 1 } }));
    response.write(line({ event: { type: "assistant.response.started", responseId: "r1", turn: 1 } }));
    response.write(line({ event: { type: "assistant.thinking.delta", delta: "hmm", responseId: "r1", turn: 1 } }));
    response.write(line({ event: { type: "assistant.delta", delta: "hel", responseId: "r1" } }));
    response.write(line({ event: { type: "assistant.delta", delta: "lo", responseId: "r1" } }));
    response.write(line({ event: { type: "assistant.response.settled", responseId: "r1", turn: 1 } }));
    response.write(line({ event: { type: "assistant.response.started", responseId: "r2", turn: 2 } }));
    response.write(line({ event: { type: "assistant.response.settled", responseId: "r2", turn: 2 } }));
    response.end(line({ done: { finalText: "hello" } }));
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options());
    const events = collect(agent);
    await agent.execute("go");
    assert.deepEqual(events.map((event) => event.type), [
      "response_start", "message_update", "message_update", "message_update", "response_settled",
      "response_start", "response_settled",
    ]);
    const text = events.flatMap((event) => event.type === "message_update" && event.assistantMessageEvent.type === "text_delta"
      ? [event.assistantMessageEvent.delta] : []);
    assert.equal(text.join(""), "hello");
    const second = events.filter((event) => event.type === "response_start");
    assert.deepEqual(second.map((event) => (event as { turn: number }).turn), [1, 2]);
  } finally {
    await adapter.close();
  }
});

test("plugin-contributed tools (update_plan) are offered to the adapter and run here", async () => {
  const updates: unknown[] = [];
  const planStore = {
    latest: async () => undefined,
    update: async (input: unknown) => { updates.push(input); return { id: "p1", steps: [] } as never; },
  };
  let offered: string[] = [];
  let reply: any;
  const adapter = await fakeAdapter(async ({ body }, response) => {
    offered = body.tools.map((tool: { name: string }) => tool.name);
    response.writeHead(200);
    response.write(line({ event: { type: "tool.started", trace: { id: "call-plan", name: "update_plan", args: { plan: [{ step: "Do it", status: "in_progress" }] }, status: "running" } } }));
    const call = await fetch(body.bridge.url, {
      method: "POST", headers: { authorization: `Bearer ${body.bridge.token}` },
      body: JSON.stringify({ name: "update_plan", arguments: { plan: [{ step: "Do it", status: "in_progress" }] } }),
    });
    reply = await call.json();
    response.end(line({ done: { finalText: "planned" } }));
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url, planning: "update_plan" })(options({ planStore: planStore as never }));
    const events = collect(agent);
    await agent.execute("plan it");
    assert.ok(offered.includes("update_plan"), `offered: ${offered.join(", ")}`);
    assert.ok(offered.includes("echo"), "the workspace tools are still offered");
    assert.equal(events.filter((event) => event.type === "tool_execution_end").length, 1);
    assert.equal(reply.isError, false, reply.text);
    assert.deepEqual(updates, [{ plan: [{ status: "in_progress", step: "Do it" }] }]);
  } finally {
    await adapter.close();
  }
});

test("reported token usage becomes model_usage events and one summed usage event at the end", async () => {
  const adapter = await fakeAdapter((_request, response) => {
    response.writeHead(200);
    response.write(line({ event: { type: "model.usage", usage: { inputTokens: 700, outputTokens: 80, totalTokens: 780, cacheReadTokens: 0, cacheWriteTokens: null }, reasoningTokens: 71 } }));
    response.write(line({ event: { type: "model.usage", usage: { inputTokens: 31, outputTokens: 7, totalTokens: 38, cacheReadTokens: 10, cacheWriteTokens: null } } }));
    response.end(line({ done: { finalText: "" } }));
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options());
    const events = collect(agent);
    await agent.execute("go");
    assert.deepEqual(events.map((event) => event.type), ["model_usage", "model_usage", "usage"]);
    assert.deepEqual(events[0], {
      type: "model_usage", usageReported: true,
      usage: { inputTokens: 700, outputTokens: 80, totalTokens: 780, cacheReadTokens: 0, cacheWriteTokens: null },
    });
    const summary = (events[2] as { usage: unknown }).usage;
    assert.deepEqual(summary, { cacheReadTokens: 10, cacheWriteTokens: null, inputTokens: 731, outputTokens: 87, totalTokens: 818 });
    // The same key order the native agent's summary has: it is serialised into subagent results.
    assert.deepEqual(Object.keys(summary as object), ["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens"]);
  } finally {
    await adapter.close();
  }
});

test("a run that reported no usage emits no usage summary", async () => {
  const adapter = await fakeAdapter((_request, response) => { response.writeHead(200); response.end(line({ done: { finalText: "x" } })); });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options());
    const events = collect(agent);
    await agent.execute("go");
    assert.equal(events.some((event) => event.type === "usage"), false);
  } finally {
    await adapter.close();
  }
});

test("a tool call from the adapter runs the real tool here and is reported as tool events", async () => {
  let bridgeStatus = 0;
  let bridgeReply: any;
  const adapter = await fakeAdapter(async ({ body }, response) => {
    // As the real adapter does: report the model's call, then JiuwenSwarm calls the tool over MCP.
    response.writeHead(200);
    response.write(line({ event: { type: "tool.started", trace: { id: "call-echo-1", name: "echo", args: { word: "ping" }, status: "running" } } }));
    const call = await fetch(body.bridge.url, {
      method: "POST",
      headers: { authorization: `Bearer ${body.bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "echo", arguments: { word: "ping" } }),
    });
    bridgeStatus = call.status;
    bridgeReply = await call.json();
    response.end(line({ done: { finalText: "ok" } }));
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options());
    const events = collect(agent);
    await agent.execute("go");
    assert.equal(bridgeStatus, 200);
    assert.deepEqual(bridgeReply, { text: "echo:ping", isError: false });
    const start = events.find((event) => event.type === "tool_execution_start") as any;
    const end = events.find((event) => event.type === "tool_execution_end") as any;
    assert.equal(start.toolName, "echo");
    assert.deepEqual(start.args, { word: "ping" });
    assert.equal(start.toolCallId, "call-echo-1", "the tool runs under the id the model gave it");
    assert.equal(end.toolCallId, start.toolCallId);
    assert.equal(end.isError, false);
    assert.equal(end.result.content[0].text, "echo:ping");
  } finally {
    await adapter.close();
  }
});

test("a call JiuwenSwarm turned away before it reached the bridge (denied) is still reported, as a failed tool", async () => {
  const adapter = await fakeAdapter((_request, response) => {
    response.writeHead(200);
    response.write(line({ event: { type: "tool.started", trace: { id: "call-denied", name: "echo", args: { word: "no" }, status: "running" } } }));
    response.write(line({ event: { type: "tool.output", toolCallId: "call-denied", chunk: "Denied by the user." } }));
    response.write(line({ event: { type: "tool.completed", trace: { id: "call-denied", name: "echo", status: "failed", output: "Denied by the user." } } }));
    response.end(line({ done: { finalText: "not done" } }));
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options());
    const events = collect(agent);
    const result = await agent.execute("go");
    const start = events.find((event) => event.type === "tool_execution_start") as any;
    const end = events.find((event) => event.type === "tool_execution_end") as any;
    assert.ok(start && end, `events: ${events.map((event) => event.type).join(", ")}`);
    assert.equal(start.toolCallId, "call-denied");
    assert.deepEqual(start.args, { word: "no" });
    assert.equal(end.isError, true);
    assert.equal(end.result.content[0].text, "Denied by the user.");
    assert.ok(result.finalMessages.some((message: any) => message.role === "tool" && message.tool_call_id === "call-denied"),
      "the model-facing transcript keeps the denied call's result");
  } finally {
    await adapter.close();
  }
});

test("a call the bridge ran is reported once: the adapter's own completion of it adds nothing", async () => {
  const adapter = await fakeAdapter(async ({ body }, response) => {
    response.writeHead(200);
    response.write(line({ event: { type: "tool.started", trace: { id: "call-echo-2", name: "echo", args: { word: "ping" }, status: "running" } } }));
    await fetch(body.bridge.url, {
      method: "POST", headers: { authorization: `Bearer ${body.bridge.token}` },
      body: JSON.stringify({ name: "echo", arguments: { word: "ping" } }),
    });
    response.write(line({ event: { type: "tool.completed", trace: { id: "call-echo-2", name: "echo", status: "completed", output: "echo:ping" } } }));
    response.end(line({ done: { finalText: "ok" } }));
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options());
    const events = collect(agent);
    await agent.execute("go");
    assert.equal(events.filter((event) => event.type === "tool_execution_start").length, 1);
    assert.equal(events.filter((event) => event.type === "tool_execution_end").length, 1);
  } finally {
    await adapter.close();
  }
});

test("a throwing tool is a tool error, not a failed run", async () => {
  const failing = {
    label: "Boom", name: "boom", description: "Always fails.", parameters: Type.Object({}),
    execute: async () => { throw new Error("disk on fire"); },
  };
  let reply: any;
  const adapter = await fakeAdapter(async ({ body }, response) => {
    response.writeHead(200);
    response.write(line({ event: { type: "tool.started", trace: { id: "call-boom", name: "boom", args: {}, status: "running" } } }));
    const call = await fetch(body.bridge.url, {
      method: "POST", headers: { authorization: `Bearer ${body.bridge.token}` },
      body: JSON.stringify({ name: "boom", arguments: {} }),
    });
    reply = await call.json();
    response.end(line({ done: { finalText: "carried on" } }));
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ extraTools: [failing as never] }));
    const events = collect(agent);
    const result = await agent.execute("go");
    // The standard error shape the native registry produces, so the model sees the same JSON either way.
    assert.equal(reply.isError, true);
    assert.deepEqual(JSON.parse(reply.text), {
      ok: false, error: { attempts: 1, code: "TOOL_EXECUTION_FAILED", message: "disk on fire", retryable: false },
    });
    assert.equal((events.find((event) => event.type === "tool_execution_end") as any).isError, true);
    assert.equal(result.finalMessages.at(-1)!.content, "carried on");
  } finally {
    await adapter.close();
  }
});

test("the bridge refuses a wrong token, an unknown tool and a malformed body", async () => {
  const statuses: number[] = [];
  const adapter = await fakeAdapter(async ({ body }, response) => {
    const post = async (headers: Record<string, string>, payload: string) => (await fetch(body.bridge.url, { method: "POST", headers, body: payload })).status;
    const good = { authorization: `Bearer ${body.bridge.token}` };
    statuses.push(await post({ authorization: "Bearer wrong" }, JSON.stringify({ name: "echo", arguments: {} })));
    statuses.push(await post(good, JSON.stringify({ name: "nope", arguments: {} })));
    statuses.push(await post(good, "{not json"));
    response.writeHead(200);
    response.end(line({ done: { finalText: "" } }));
  });
  try {
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options()).execute("go");
    assert.deepEqual(statuses, [401, 404, 400]);
  } finally {
    await adapter.close();
  }
});

test("a failed run throws the provider's text so the run can classify it", async () => {
  const adapter = await fakeAdapter((_request, response) => {
    response.writeHead(200);
    response.end(
      line({ event: { type: "run.failed", error: "429 rate limit exceeded", errorCode: "rate-limited" } })
      + line({ done: { finalText: "" } }),
    );
  });
  try {
    await assert.rejects(
      createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options()).execute("go"),
      /429 rate limit exceeded/,
    );
  } finally {
    await adapter.close();
  }
});

test("an adapter that refuses the run is reported with its status", async () => {
  const adapter = await fakeAdapter((_request, response) => {
    response.writeHead(401);
    response.end("unauthorized");
  });
  try {
    await assert.rejects(
      createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options()).execute("go"),
      /adapter refused the run: HTTP 401 unauthorized/,
    );
  } finally {
    await adapter.close();
  }
});

test("abort cancels the run and drops the connection so the adapter stops it", { timeout: 5_000 }, async () => {
  const adapter = await fakeAdapter((_request, response) => {
    response.writeHead(200);
    response.write(line({ event: { type: "agent.phase", phase: "thinking", turn: 1 } }));
    // never ends
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options());
    const running = agent.execute("go");
    while (!adapter.requests.length) await new Promise((resolve) => setTimeout(resolve, 10));
    agent.abort();
    await assert.rejects(running, /Agent run cancelled/);
    for (let i = 0; i < 50 && !adapter.aborted(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(adapter.aborted(), true);
  } finally {
    await adapter.close();
  }
});

test("the run timeout aborts a stuck run and says it timed out, as the built-in loop does", async () => {
  const adapter = await fakeAdapter((_request, response) => { response.writeHead(200); response.write(""); });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ runTimeoutMs: 50 }));
    await assert.rejects(agent.execute("go"), /Agent run timeout: gateway turn exceeded 50 ms/);
  } finally {
    await adapter.close();
  }
});

test("a run with no progress for its idle timeout stops with the idle timeout's message", async (context) => {
  const adapter = await fakeAdapter((_request, response) => { response.writeHead(200); response.write(""); });
  const diagnostics: string[] = [];
  context.mock.method(console, "info", (line: string) => { if (line.startsWith("[gateway-progress]")) diagnostics.push(line); });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ runIdleTimeoutMs: 60 } as never));
    await assert.rejects(agent.execute("go"), /Agent run stalled: no gateway progress for 60 ms/);
    const expired = diagnostics.map((line) => JSON.parse(line.slice("[gateway-progress] ".length)))
      .find((entry) => entry.phase === "idle_deadline_expired");
    assert.equal(expired?.lastProgressSource, "run_started");
    assert.deepEqual(expired?.activeModelRequests, []);
  } finally {
    await adapter.close();
  }
});

test("the idle timeout stalls a run with no gateway progress, with the wording services/api/src/timeouts classifies", async () => {
  const adapter = await fakeAdapter((_request, response) => {
    response.writeHead(200);
    response.write(line({ event: { type: "agent.phase", phase: "thinking", turn: 1 } }));
    // No further line, ever: the adapter/JiuwenSwarm went quiet mid-run.
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ runIdleTimeoutMs: 50 }));
    await assert.rejects(agent.execute("go"), /Agent run stalled: no gateway progress for 50 ms/);
  } finally {
    await adapter.close();
  }
});

test("a JiuwenSwarm approval question pauses the idle clock: a human answer slower than the idle timeout still completes the run", async () => {
  const adapter = await fakeAdapter(async ({ body }, response) => {
    if (body.decision) { response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); return; }
    response.writeHead(200);
    response.write(line({ event: { type: "permission.required", request: { id: "q1", resource: "run_shell: rm -rf out", summary: "run_shell", toolCallId: "q1" } } }));
    await new Promise((resolve) => setTimeout(resolve, 120));
    response.end(line({ done: { finalText: "ok" } }));
  });
  try {
    const requestApproval = async () => {
      await new Promise((resolve) => setTimeout(resolve, 120)); // longer than runIdleTimeoutMs below
      return "allow_matching" as const;
    };
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ requestApproval, runIdleTimeoutMs: 50 } as never));
    const result = await agent.execute("go");
    assert.equal(result.finalMessages.at(-1)?.content, "ok");
  } finally {
    await adapter.close();
  }
});

test("a handle runs once", async () => {
  const adapter = await fakeAdapter((_request, response) => { response.writeHead(200); response.end(line({ done: { finalText: "" } })); });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options());
    await agent.execute("a");
    await assert.rejects(agent.execute("b"), /already been executed/);
  } finally {
    await adapter.close();
  }
});

test("approval transport failure retries the same decision without stopping the run", async () => {
  let main: ServerResponse | undefined;
  let attempts = 0;
  const adapter = await fakeAdapter(({ body }, response) => {
    if (body.decision) {
      response.writeHead(200); response.end("{}");
      main!.end(line({ done: { finalText: "recovered" } }));
      return;
    }
    main = response;
    response.writeHead(200);
    response.write(line({ event: { type: "permission.required", request: { id: "q-retry", resource: "run_shell" } } }));
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url,
      fetch: async (input, init) => {
        if (String(input).includes("/agent/approvals/") && ++attempts === 1) throw new TypeError("fetch failed");
        return fetch(input, init);
      },
    })(options({ requestApproval: async () => "allow", runIdleTimeoutMs: 5_000 } as never));
    const result = await agent.execute("go");
    assert.equal(result.finalMessages.at(-1)?.content, "recovered");
    assert.equal(attempts, 2);
  } finally { await adapter.close(); }
});

test("approval delivery failure terminates with a concrete error instead of an idle timeout", async () => {
  const adapter = await fakeAdapter(({ body }, response) => {
    if (body.decision) { response.writeHead(502); response.end("{}"); return; }
    response.writeHead(200);
    response.write(line({ event: { type: "permission.required", request: { id: "q1", resource: "run_shell" } } }));
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({
      requestApproval: async () => "allow", runIdleTimeoutMs: 5_000,
    } as never));
    await assert.rejects(agent.execute("go"), /approval delivery failed/);
  } finally { await adapter.close(); }
});

test("approval HTTP delivery remains an external wait after the human has answered", async () => {
  let main: ServerResponse | undefined;
  const adapter = await fakeAdapter(async ({ body }, response) => {
    if (body.decision) {
      await new Promise((resolve) => setTimeout(resolve, 180));
      response.writeHead(200); response.end("{}");
      main!.end(line({ done: { finalText: "resumed" } }));
      return;
    }
    main = response;
    response.writeHead(200);
    response.write(line({ event: { type: "permission.required", request: { id: "q1", resource: "run_shell" } } }));
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({
      requestApproval: async () => "allow", runIdleTimeoutMs: 80,
    } as never));
    assert.equal((await agent.execute("go")).finalMessages.at(-1)?.content, "resumed");
  } finally { await adapter.close(); }
});

test("the executor is chosen by SCIENCE_AGENT_EXECUTOR and needs the adapter URL", () => {
  assert.equal(jiuwenSwarmConfigFromEnv({}), undefined);
  assert.equal(jiuwenSwarmConfigFromEnv({ SCIENCE_AGENT_EXECUTOR: "native" }), undefined);
  assert.throws(() => jiuwenSwarmConfigFromEnv({ SCIENCE_AGENT_EXECUTOR: "jiuwenswarm" }), /SCIENCE_AGENT_ADAPTER_URL/);
  assert.deepEqual(
    jiuwenSwarmConfigFromEnv({
      SCIENCE_AGENT_EXECUTOR: "jiuwenswarm", SCIENCE_AGENT_ADAPTER_URL: "http://127.0.0.1:4310/", SCIENCE_AGENT_ADAPTER_TOKEN: "t",
    }),
    { adapterUrl: "http://127.0.0.1:4310", adapterToken: "t", subagents: "task" },
  );
});

test("a tool is not run until the adapter has reported the model's call, so the response comes first", async () => {
  const order: string[] = [];
  const adapter = await fakeAdapter(async ({ body }, response) => {
    response.writeHead(200);
    // JiuwenSwarm's MCP call arrives *before* the adapter's report of the same call ...
    const call = fetch(body.bridge.url, {
      method: "POST", headers: { authorization: `Bearer ${body.bridge.token}` },
      body: JSON.stringify({ name: "echo", arguments: { word: "late" } }),
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    // ... which then reports the model call's (empty) response and the call itself.
    response.write(line({ event: { type: "agent.phase", phase: "thinking", turn: 1 } }));
    response.write(line({ event: { type: "assistant.response.started", responseId: "r1", turn: 1 } }));
    response.write(line({ event: { type: "assistant.response.settled", responseId: "r1", turn: 1 } }));
    response.write(line({ event: { type: "tool.started", trace: { id: "call-late", name: "echo", args: { word: "late" }, status: "running" } } }));
    await call;
    response.end(line({ done: { finalText: "" } }));
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options());
    agent.subscribe((event) => order.push(event.type));
    await agent.execute("go");
    assert.deepEqual(order, ["response_start", "response_settled", "tool_execution_start", "tool_execution_end"]);
  } finally {
    await adapter.close();
  }
});

test("closing one bridge request cancels its running tool instead of leaving an orphan", async () => {
  let toolStarted!: () => void;
  const started = new Promise<void>((resolve) => { toolStarted = resolve; });
  let toolAborted = false;
  const slow = {
    label: "Slow", name: "slow", description: "Wait until cancelled.", parameters: Type.Object({}),
    execute: async (_id: string, _params: unknown, signal: AbortSignal) => {
      toolStarted();
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => {
        toolAborted = true;
        reject(signal.reason);
      }, { once: true }));
      return { content: [{ type: "text" as const, text: "unreachable" }] };
    },
  };
  const adapter = await fakeAdapter(async ({ body }, response) => {
    response.writeHead(200);
    response.write(line({ event: { type: "tool.started", trace: { id: "call-slow", name: "slow", args: {}, status: "running" } } }));
    const controller = new AbortController();
    const call = fetch(body.bridge.url, {
      method: "POST", headers: { authorization: `Bearer ${body.bridge.token}` }, body: JSON.stringify({ name: "slow", arguments: {} }),
      signal: controller.signal,
    }).catch(() => undefined);
    await started;
    controller.abort();
    await call;
    for (let i = 0; i < 50 && !toolAborted; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    response.end(line({ done: { finalText: "continued" } }));
  });
  try {
    const result = await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ extraTools: [slow as never] })).execute("go");
    assert.equal(toolAborted, true);
    assert.equal(result.finalMessages.at(-1)?.content, "continued");
  } finally {
    await adapter.close();
  }
});

test("two calls to the same tool with different arguments are matched to their own model call ids", async () => {
  const started: Array<{ id: string; word: string }> = [];
  const adapter = await fakeAdapter(async ({ body }, response) => {
    response.writeHead(200);
    for (const [id, word] of [["call-a", "one"], ["call-b", "two"]]) {
      response.write(line({ event: { type: "tool.started", trace: { id, name: "echo", args: { word }, status: "running" } } }));
    }
    // JiuwenSwarm may call them in either order.
    await Promise.all(["two", "one"].map((word) => fetch(body.bridge.url, {
      method: "POST", headers: { authorization: `Bearer ${body.bridge.token}` },
      body: JSON.stringify({ name: "echo", arguments: { word } }),
    })));
    response.end(line({ done: { finalText: "" } }));
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options());
    agent.subscribe((event) => {
      if (event.type === "tool_execution_start") started.push({ id: event.toolCallId, word: String((event.args as { word: string }).word) });
    });
    await agent.execute("go");
    assert.deepEqual(started.sort((a, b) => a.word.localeCompare(b.word)), [{ id: "call-a", word: "one" }, { id: "call-b", word: "two" }]);
  } finally {
    await adapter.close();
  }
});

test("the run leaves the model-facing transcript of its tool round, as the native agent does", async () => {
  const adapter = await fakeAdapter(async ({ body }, response) => {
    response.writeHead(200);
    response.write(line({ event: { type: "assistant.response.started", responseId: "r1", turn: 1 } }));
    response.write(line({ event: { type: "assistant.response.settled", responseId: "r1", turn: 1 } }));
    response.write(line({ event: { type: "tool.started", trace: { id: "call-1", name: "echo", input: "{\"word\": \"hi\"}", args: { word: "hi" }, status: "running" } } }));
    await fetch(body.bridge.url, {
      method: "POST", headers: { authorization: `Bearer ${body.bridge.token}` },
      body: JSON.stringify({ name: "echo", arguments: { word: "hi" } }),
    });
    response.write(line({ event: { type: "assistant.response.started", responseId: "r2", turn: 2 } }));
    response.write(line({ event: { type: "assistant.delta", delta: "It said hi.", responseId: "r2" } }));
    response.write(line({ event: { type: "assistant.response.settled", responseId: "r2", turn: 2 } }));
    response.end(line({ done: { finalText: "It said hi." } }));
  });
  try {
    const result = await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options()).execute("say hi");
    assert.deepEqual(result.finalMessages, [
      { role: "user", content: "say hi" },
      { role: "assistant", content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "echo", arguments: "{\"word\":\"hi\"}" } }] },
      { role: "tool", tool_call_id: "call-1", name: "echo", content: "echo:hi" },
      { role: "assistant", content: "It said hi." },
    ]);
  } finally {
    await adapter.close();
  }
});

test("a tool nobody reported still runs (under a generated id) instead of hanging the run", async () => {
  const adapter = await fakeAdapter(async ({ body }, response) => {
    response.writeHead(200);
    const call = await fetch(body.bridge.url, {
      method: "POST", headers: { authorization: `Bearer ${body.bridge.token}` },
      body: JSON.stringify({ name: "echo", arguments: { word: "orphan" } }),
    });
    assert.equal(call.status, 200);
    response.end(line({ done: { finalText: "" } }));
  });
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url, toolAnnouncementTimeoutMs: 200 } as never)(options());
    const events = collect(agent);
    await agent.execute("go");
    assert.equal(events.some((event) => event.type === "tool_execution_end"), true);
  } finally {
    console.warn = warn;
    await adapter.close();
  }
});

test("the tool runs with the model's own arguments even though JiuwenSwarm added defaults and dropped empties", async () => {
  const seen: unknown[] = [];
  const probe = {
    label: "Probe", name: "probe", description: "Records what it was called with.",
    parameters: Type.Object({ word: Type.String(), extra: Type.Optional(Type.Number()), list: Type.Optional(Type.Array(Type.String())) }),
    execute: async (_id: string, params: unknown) => { seen.push(params); return { content: [{ type: "text" as const, text: "ok" }] }; },
  };
  const adapter = await fakeAdapter(async ({ body }, response) => {
    response.writeHead(200);
    // the model sent {word, list: []}; JiuwenSwarm calls the tool with {word, extra: 7200} (default added, empty list dropped)
    response.write(line({ event: { type: "tool.started", trace: { id: "call-p", name: "probe", args: { word: "w", list: [] }, status: "running" } } }));
    await fetch(body.bridge.url, {
      method: "POST", headers: { authorization: `Bearer ${body.bridge.token}` },
      body: JSON.stringify({ name: "probe", arguments: { word: "w", extra: 7200 } }),
    });
    response.end(line({ done: { finalText: "" } }));
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ extraTools: [probe as never] }));
    const events = collect(agent);
    await agent.execute("go");
    assert.deepEqual(seen, [{ word: "w", list: [] }]);
    const start = events.find((event) => event.type === "tool_execution_start") as { args: unknown; toolCallId: string };
    assert.deepEqual(start.args, { word: "w", list: [] });
    assert.equal(start.toolCallId, "call-p");
  } finally {
    await adapter.close();
  }
});

test("tool details in the run's events are sanitised and bounded like the native agent's", async () => {
  const leaky = {
    label: "Leaky", name: "leaky", description: "Returns details with a secret and a payload.", parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text" as const, text: "done" }], details: { apiKey: "sk-secret-value", stdout: "fine", note: "kept" } }),
  };
  const adapter = await fakeAdapter(async ({ body }, response) => {
    response.writeHead(200);
    response.write(line({ event: { type: "tool.started", trace: { id: "call-l", name: "leaky", args: {}, status: "running" } } }));
    await fetch(body.bridge.url, { method: "POST", headers: { authorization: `Bearer ${body.bridge.token}` }, body: JSON.stringify({ name: "leaky", arguments: {} }) });
    response.end(line({ done: { finalText: "" } }));
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ extraTools: [leaky as never] }));
    const events = collect(agent);
    await agent.execute("go");
    const end = events.find((event) => event.type === "tool_execution_end") as { result: { details: Record<string, unknown> } };
    assert.equal(end.result.details.apiKey, "[redacted]", "secrets are redacted before they reach a run event");
    assert.equal(end.result.details.stdout, "[omitted]", "payload fields are left out of run events");
    assert.equal((end.result.details.__detailsBoundary as { omittedPayloadFields: boolean }).omittedPayloadFields, true);
  } finally {
    await adapter.close();
  }
});

test("deferred tools (custom MCP) are callable at once, and tool_search is offered and answers", async () => {
  const bulky = {
    label: "Bulky", name: "mcp__custom-1__bulky", description: "A deferred MCP tool.", deferred: true,
    parameters: Type.Object({ text: Type.String() }),
    execute: async (_id: string, params: { text: string }) => ({ content: [{ type: "text" as const, text: `bulky:${params.text}` }] }),
  };
  let offered: string[] = [];
  let direct: any;
  let searched: any;
  const adapter = await fakeAdapter(async ({ body }, response) => {
    offered = body.tools.map((tool: { name: string }) => tool.name);
    response.writeHead(200);
    const call = (name: string, args: unknown) => fetch(body.bridge.url, {
      method: "POST", headers: { authorization: `Bearer ${body.bridge.token}` }, body: JSON.stringify({ name, arguments: args }),
    }).then((reply) => reply.json());
    response.write(line({ event: { type: "tool.started", trace: { id: "c-search", name: "tool_search", args: { query: "select:mcp__custom-1__bulky" }, status: "running" } } }));
    searched = await call("tool_search", { query: "select:mcp__custom-1__bulky" });
    response.write(line({ event: { type: "tool.started", trace: { id: "c-bulky", name: "mcp__custom-1__bulky", args: { text: "hi" }, status: "running" } } }));
    direct = await call("mcp__custom-1__bulky", { text: "hi" });
    response.end(line({ done: { finalText: "ok" } }));
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ extraTools: [bulky as never] }));
    await agent.execute("use it");
    assert.ok(offered.includes("mcp__custom-1__bulky"), `offered: ${offered.join(", ")}`);
    assert.ok(offered.includes("tool_search"));
    assert.equal(searched.isError, false, searched.text);
    assert.match(searched.text, /mcp__custom-1__bulky/);
    assert.deepEqual(direct, { text: "bulky:hi", isError: false });
  } finally {
    await adapter.close();
  }
});

test("a run with no deferred tools is not offered tool_search", async () => {
  let offered: string[] = [];
  const adapter = await fakeAdapter(async ({ body }, response) => {
    offered = body.tools.map((tool: { name: string }) => tool.name);
    response.writeHead(200);
    response.end(line({ done: { finalText: "ok" } }));
  });
  try {
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options()).execute("go");
    assert.ok(!offered.includes("tool_search"), offered.join(", "));
  } finally {
    await adapter.close();
  }
});

test("the tools offered are exactly the native registry's, every one with its own schema (plus tool_search when some are deferred)", async () => {
  const planStore = { latest: async () => undefined, update: async () => ({ id: "p", steps: [] }) as never };
  const deferredTool = {
    label: "D", name: "mcp__custom-2__d", description: "deferred", deferred: true,
    parameters: Type.Object({ q: Type.String() }), execute: async () => ({ content: [{ type: "text" as const, text: "" }] }),
  };
  const opts = options({ planStore: planStore as never, extraTools: [deferredTool as never] });
  const durable = new DurableContextStore({ history: [] });
  const plugins = await startPluginScope(opts, durable, new AbortController().signal);
  const registry = createToolRegistry(opts, plugins, durable);
  const expected = new Map(registry.values().map((tool) => [tool.name, tool]));
  await plugins.dispose();
  let offered: Array<{ name: string; inputSchema: unknown }> = [];
  const adapter = await fakeAdapter(async ({ body }, response) => {
    offered = body.tools;
    response.writeHead(200);
    response.end(line({ done: { finalText: "ok" } }));
  });
  try {
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url, planning: "update_plan" })(opts).execute("go");
    const names = offered.map((tool) => tool.name).sort();
    assert.deepEqual(names, [...expected.keys(), "tool_search"].sort());
    for (const tool of offered) {
      if (tool.name === "tool_search") continue;
      assert.deepEqual(tool.inputSchema, JSON.parse(JSON.stringify(expected.get(tool.name)!.parameters)), `schema of ${tool.name}`);
    }
    assert.ok(names.includes("update_plan"), "a plugin's tool is among them");
    assert.ok(names.includes("mcp__custom-2__d"), "and so is a deferred one");
  } finally {
    await adapter.close();
  }
});

/** Tools that log when they start and end, so overlap is visible. */
function timedTools(log: string[], concurrencySafe: boolean) {
  const make = (name: string, ms: number) => ({
    label: name, name, description: name, parameters: Type.Object({}),
    ...(concurrencySafe ? { isConcurrencySafe: () => true } : {}),
    execute: async () => {
      log.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      log.push(`${name}:end`);
      return { content: [{ type: "text" as const, text: name }] };
    },
  });
  return [make("slow_a", 60), make("fast_b", 5)];
}

/** One model response with two tool calls; JiuwenSwarm calls them side by side, the second one first. */
async function respondWithTwoCalls(names: [string, string], calls: Array<{ args?: unknown; name: string }>, script?: { reverse?: boolean }) {
  return await fakeAdapter(async ({ body }, response) => {
    response.writeHead(200);
    response.write(line({ event: { type: "assistant.response.started", responseId: "r1", turn: 1 } }));
    calls.forEach((call, index) => response.write(line({ event: { type: "tool.started", trace: { id: `c${index + 1}`, name: call.name, args: call.args ?? {}, status: "running" } } })));
    const send = (call: { args?: unknown; name: string }) => fetch(body.bridge.url, {
      method: "POST", headers: { authorization: `Bearer ${body.bridge.token}` }, body: JSON.stringify({ name: call.name, arguments: call.args ?? {} }),
    }).then((reply) => reply.json());
    await Promise.all((script?.reverse === false ? calls : [...calls].reverse()).map(send));
    response.end(line({ done: { finalText: "ok" } }));
  });
}

test("tools not declared concurrency-safe run one at a time, in the order the model called them", async () => {
  const log: string[] = [];
  const adapter = await respondWithTwoCalls(["slow_a", "fast_b"], [{ name: "slow_a" }, { name: "fast_b" }]);
  try {
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ extraTools: timedTools(log, false) as never })).execute("go");
    assert.deepEqual(log, ["slow_a:start", "slow_a:end", "fast_b:start", "fast_b:end"]);
  } finally {
    await adapter.close();
  }
});

test("tools declared concurrency-safe may overlap", async () => {
  const log: string[] = [];
  const adapter = await respondWithTwoCalls(["slow_a", "fast_b"], [{ name: "slow_a" }, { name: "fast_b" }]);
  try {
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ extraTools: timedTools(log, true) as never })).execute("go");
    assert.equal(log.indexOf("fast_b:end") < log.indexOf("slow_a:end"), true, log.join(" "));
  } finally {
    await adapter.close();
  }
});

test("two update_plan calls in one response: the earlier one is superseded, as in the native loop", async () => {
  const updates: unknown[] = [];
  const planStore = { latest: async () => undefined, update: async (input: unknown) => { updates.push(input); return { id: "p", steps: [] } as never; } };
  const first = { plan: [{ step: "first", status: "pending" }] };
  const second = { plan: [{ step: "second", status: "pending" }] };
  const adapter = await respondWithTwoCalls(["update_plan", "update_plan"], [{ name: "update_plan", args: first }, { name: "update_plan", args: second }]);
  try {
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url, planning: "update_plan" })(options({ planStore: planStore as never })).execute("plan");
    assert.deepEqual(updates, [{ plan: [{ status: "pending", step: "second" }] }]);
  } finally {
    await adapter.close();
  }
});

test("an earlier call that never reaches the bridge does not hold up the later one for ever", async () => {
  const log: string[] = [];
  const adapter = await fakeAdapter(async ({ body }, response) => {
    response.writeHead(200);
    response.write(line({ event: { type: "assistant.response.started", responseId: "r1", turn: 1 } }));
    response.write(line({ event: { type: "tool.started", trace: { id: "c1", name: "slow_a", args: {}, status: "running" } } }));
    response.write(line({ event: { type: "tool.started", trace: { id: "c2", name: "fast_b", args: {}, status: "running" } } }));
    await fetch(body.bridge.url, { method: "POST", headers: { authorization: `Bearer ${body.bridge.token}` }, body: JSON.stringify({ name: "fast_b", arguments: {} }) });
    response.end(line({ done: { finalText: "ok" } }));
  });
  try {
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url, toolAnnouncementTimeoutMs: 100 })(options({ extraTools: timedTools(log, false) as never })).execute("go");
    assert.deepEqual(log, ["fast_b:start", "fast_b:end"]);
  } finally {
    await adapter.close();
  }
});

test("the run's timeout is passed on as the longest a single tool call may take", async () => {
  let sent: any;
  const adapter = await fakeAdapter(async ({ body }, response) => {
    sent = body;
    response.writeHead(200);
    response.end(line({ done: { finalText: "ok" } }));
  });
  try {
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ runTimeoutMs: 90_000 })).execute("go");
    assert.equal(sent.toolTimeoutSeconds, 90);
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options()).execute("go");
    assert.equal("toolTimeoutSeconds" in sent, false);
  } finally {
    await adapter.close();
  }
});

test("a run names the JiuwenSwarm session that holds its agent's conversation", async () => {
  const sent: any[] = [];
  const adapter = await fakeAdapter(async ({ body }, response) => {
    sent.push(body);
    response.writeHead(200);
    response.end(line({ done: { finalText: "ok" } }));
  });
  try {
    const factory = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url });
    const base = options();
    await factory({ ...base, versioning: { agentId: "main:thread-1" } as never }).execute("a");
    await factory({ ...base, versioning: { agentId: "subagent:Sub Agent/7" } as never }).execute("b");
    assert.equal(sent[0].sessionKey, "session-1", "the main agent's conversation is the session's own");
    assert.equal(sent[1].sessionKey, "session-1--subagent-Sub-Agent-7");
  } finally {
    await adapter.close();
  }
});

test("session keys: a run without an agent id is the main agent", () => {
  assert.equal(jiuwenSwarmSessionKey({ sessionId: "s" } as never), "s");
});

function planRecorder() {
  const updates: Array<{ input: any; toolCallId: string }> = [];
  const store = { latest: async () => undefined, update: async (input: unknown, toolCallId: string) => { updates.push({ input, toolCallId }); return { id: "p", steps: [] } as never; } };
  return { store, updates };
}

test("by default the model plans with JiuwenSwarm's todo tools, not our update_plan", async () => {
  let sent: any;
  const adapter = await fakeAdapter(async ({ body }, response) => { sent = body; response.writeHead(200); response.end(line({ done: { finalText: "ok" } })); });
  try {
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ planStore: planRecorder().store as never })).execute("go");
    assert.deepEqual(sent.nativeTools, ["todo_create", "todo_modify", "todo_list", "todo_get"]);
    assert.equal(sent.tools.some((tool: { name: string }) => tool.name === "update_plan"), false);
    assert.equal(sent.hiddenJiuwenSwarmTools.includes("todo_create"), false);
  } finally {
    await adapter.close();
  }
});

test("planning can be switched back to our update_plan, and then JiuwenSwarm's todo tools are not offered", async () => {
  let sent: any;
  const adapter = await fakeAdapter(async ({ body }, response) => { sent = body; response.writeHead(200); response.end(line({ done: { finalText: "ok" } })); });
  try {
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url, planning: "update_plan" })(options({ planStore: planRecorder().store as never })).execute("go");
    assert.ok(sent.tools.some((tool: { name: string }) => tool.name === "update_plan"));
    assert.equal("nativeTools" in sent, false);
  } finally {
    await adapter.close();
  }
});

test("a run with no plan store offers no plan tool of either kind", async () => {
  let sent: any;
  const adapter = await fakeAdapter(async ({ body }, response) => { sent = body; response.writeHead(200); response.end(line({ done: { finalText: "ok" } })); });
  try {
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options()).execute("go");
    assert.equal("nativeTools" in sent, false);
    assert.equal(sent.tools.some((tool: { name: string }) => tool.name === "update_plan"), false);
    // Not merely unlisted: with all of JiuwenSwarm's tools offered, its todo tools are hidden (a Plan plugin switched off).
    assert.ok(["todo_create", "todo_modify", "todo_list", "todo_get"].every((name) => sent.hiddenJiuwenSwarmTools.includes(name)));
  } finally {
    await adapter.close();
  }
});

test("in todo planning JiuwenSwarm's todo tools replace update_plan, and its todo list is recorded as the plan", async () => {
  const { store, updates } = planRecorder();
  let sent: any;
  const adapter = await fakeAdapter(async ({ body }, response) => {
    sent = body;
    response.writeHead(200);
    // The adapter's report of a JiuwenSwarm-run tool: it starts, its list changes, it completes.
    response.write(line({ event: { type: "tool.started", trace: { id: "call-todo", name: "todo_create", args: { tasks: [{ id: "a", content: "Step A" }] }, status: "running" } } }));
    response.write(line({ event: { type: "plan.updated", items: [
      { id: "a", content: "Step A", status: "in_progress" }, { id: "b", content: "Step B", status: "pending" },
      { id: "c", content: "Dropped", status: "cancelled" }, { id: "d", content: "  ", status: "pending" }] } }));
    response.write(line({ event: { type: "tool.completed", trace: { id: "call-todo", name: "todo_create", args: {}, status: "completed", output: "created 2" } } }));
    response.end(line({ done: { finalText: "ok" } }));
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ planStore: store as never }));
    const events = collect(agent);
    const result = await agent.execute("plan it");
    assert.deepEqual(sent.nativeTools, ["todo_create", "todo_modify", "todo_list", "todo_get"]);
    assert.equal(sent.tools.some((tool: { name: string }) => tool.name === "update_plan"), false, "the model is not also given our tool");
    assert.deepEqual(updates, [{ input: { plan: [{ step: "Step A", status: "in_progress" }, { step: "Step B", status: "pending" }] }, toolCallId: "call-todo" }]);
    const start = events.find((event) => event.type === "tool_execution_start") as any;
    const end = events.find((event) => event.type === "tool_execution_end") as any;
    assert.equal(start.toolName, "todo_create");
    assert.equal(end.result.content[0].text, "created 2");
    // The tool round is in the run's saved transcript, as for any tool.
    const messages = result.finalMessages as any[];
    assert.equal(messages.some((message) => message.role === "assistant" && message.tool_calls?.[0]?.id === "call-todo"), true);
    assert.equal(messages.some((message) => message.role === "tool" && message.tool_call_id === "call-todo" && message.content === "created 2"), true);
  } finally {
    await adapter.close();
  }
});

test("a JiuwenSwarm-run tool does not hold up the calls behind it at the bridge", async () => {
  const log: string[] = [];
  const adapter = await fakeAdapter(async ({ body }, response) => {
    response.writeHead(200);
    response.write(line({ event: { type: "assistant.response.started", responseId: "r1", turn: 1 } }));
    response.write(line({ event: { type: "tool.started", trace: { id: "n1", name: "todo_create", args: {}, status: "running" } } }));
    response.write(line({ event: { type: "tool.started", trace: { id: "c1", name: "slow_a", args: {}, status: "running" } } }));
    await fetch(body.bridge.url, { method: "POST", headers: { authorization: `Bearer ${body.bridge.token}` }, body: JSON.stringify({ name: "slow_a", arguments: {} }) });
    response.end(line({ done: { finalText: "ok" } }));
  });
  try {
    const started = Date.now();
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url, planning: "todo", toolAnnouncementTimeoutMs: 2_000 })(
      options({ extraTools: timedTools(log, false) as never, planStore: planRecorder().store as never })).execute("go");
    assert.deepEqual(log, ["slow_a:start", "slow_a:end"]);
    assert.ok(Date.now() - started < 1_500, "no wait for a call that never comes to the bridge");
  } finally {
    await adapter.close();
  }
});

test("planning is JiuwenSwarm's todo unless SCIENCE_AGENT_JIUWENSWARM_PLANNING=update_plan", () => {
  const env = { SCIENCE_AGENT_EXECUTOR: "jiuwenswarm", SCIENCE_AGENT_ADAPTER_URL: "http://a" };
  assert.equal(jiuwenSwarmConfigFromEnv(env)?.planning, undefined, "unset means todo");
  assert.equal(jiuwenSwarmConfigFromEnv({ ...env, SCIENCE_AGENT_JIUWENSWARM_PLANNING: "todo" })?.planning, undefined);
  assert.equal(jiuwenSwarmConfigFromEnv({ ...env, SCIENCE_AGENT_JIUWENSWARM_PLANNING: "update_plan" })?.planning, "update_plan");
});

/** A `task`-capable run: options() plus a stub runSubagent, which is what gives the tool registry `task`. */
function withRunSubagent(extra: Partial<NativeAgentOptions> = {}): NativeAgentOptions {
  return options({ runSubagent: (async () => ({ id: "sub-1", status: "completed" })) as never, ...extra });
}

test("explicit jiuwenswarm mode delegates with native subagent tools, not our task", async () => {
  let sent: any;
  const adapter = await fakeAdapter(async ({ body }, response) => { sent = body; response.writeHead(200); response.end(line({ done: { finalText: "ok" } })); });
  try {
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url, subagents: "jiuwenswarm" })(withRunSubagent()).execute("go");
    assert.deepEqual(sent.nativeTools, ["subagent_spawn", "subagent_wait", "task_tool"]);
    assert.equal(sent.tools.some((tool: { name: string }) => tool.name === "task"), false);
    assert.equal(sent.hiddenJiuwenSwarmTools.includes("subagent_spawn"), false);
  } finally {
    await adapter.close();
  }
});

test("default delegation uses platform task and hides the Swarm-native lifecycle", async () => {
  let sent: any;
  const adapter = await fakeAdapter(async ({ body }, response) => { sent = body; response.writeHead(200); response.end(line({ done: { finalText: "ok" } })); });
  try {
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(withRunSubagent()).execute("go");
    assert.ok(sent.tools.some((tool: { name: string }) => tool.name === "task"));
    assert.match(sent.tools.find((tool: { name: string }) => tool.name === "task")?.description ?? "",
      /Do not also request the complete report or source package/);
    assert.equal(sent.toolTimeoutSeconds, subagentCapableParentRunTimeoutMs() / 1000);
    assert.equal("nativeTools" in sent, false);
    assert.equal(sent.jiuwenSwarmTools, "all");
    for (const name of ["subagent_spawn", "subagent_wait", "task_tool", "subagent_list", "subagent_send_input", "subagent_close", "subagent_resume"]) {
      assert.ok(sent.hiddenJiuwenSwarmTools.includes(name), `${name} must be hidden even with all native tools enabled`);
    }
    assert.match(sent.systemPrompt, /Delegation for this run uses only the platform task tool/);
  } finally {
    await adapter.close();
  }
});

test("with ScienceDiscovery's own tools, task stays even with explicit jiuwenswarm delegation", async () => {
  let sent: any;
  const adapter = await fakeAdapter(async ({ body }, response) => { sent = body; response.writeHead(200); response.end(line({ done: { finalText: "ok" } })); });
  try {
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url, tools: "ours", subagents: "jiuwenswarm" })(withRunSubagent()).execute("go");
    assert.ok(sent.tools.some((tool: { name: string }) => tool.name === "task"));
    assert.equal("nativeTools" in sent, false);
  } finally {
    await adapter.close();
  }
});

test("a run with no delegation capability offers no delegation tool of either kind", async () => {
  let sent: any;
  const adapter = await fakeAdapter(async ({ body }, response) => { sent = body; response.writeHead(200); response.end(line({ done: { finalText: "ok" } })); });
  try {
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options()).execute("go");
    assert.equal("nativeTools" in sent, false);
    assert.equal(sent.tools.some((tool: { name: string }) => tool.name === "task"), false);
    assert.ok(sent.hiddenJiuwenSwarmTools.includes("subagent_spawn"));
    assert.match(sent.systemPrompt, /Delegation is unavailable for this run/);
    assert.ok(["subagent_spawn", "subagent_wait", "task_tool"].every((name) => sent.hiddenJiuwenSwarmTools.includes(name)));
  } finally {
    await adapter.close();
  }
});

test("a subagent_spawn call is reported as a native tool call, not run through the bridge", async () => {
  const adapter = await fakeAdapter(async ({ body }, response) => {
    response.writeHead(200);
    response.write(line({ event: { type: "tool.started", trace: { id: "call-spawn", name: "subagent_spawn", args: { subagent_type: "general_agent", task_description: "do it" }, status: "running" } } }));
    response.write(line({ event: { type: "tool.completed", trace: { id: "call-spawn", name: "subagent_spawn", args: {}, status: "completed", output: "spawned sub_1" } } }));
    response.end(line({ done: { finalText: "ok" } }));
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url, subagents: "jiuwenswarm" })(withRunSubagent());
    const events = collect(agent);
    const result = await agent.execute("delegate it");
    const start = events.find((event) => event.type === "tool_execution_start") as any;
    const end = events.find((event) => event.type === "tool_execution_end") as any;
    assert.equal(start.toolName, "subagent_spawn");
    assert.equal(end.result.content[0].text, "spawned sub_1");
    const messages = result.finalMessages as any[];
    assert.equal(messages.some((message) => message.role === "assistant" && message.tool_calls?.[0]?.id === "call-spawn"), true);
    assert.equal(messages.some((message) => message.role === "tool" && message.tool_call_id === "call-spawn" && message.content === "spawned sub_1"), true);
  } finally {
    await adapter.close();
  }
});

test("delegation defaults to platform task and accepts only an explicit Swarm-native override", () => {
  const env = { SCIENCE_AGENT_EXECUTOR: "jiuwenswarm", SCIENCE_AGENT_ADAPTER_URL: "http://a" };
  for (const value of [undefined, "", "   ", "task", " task "]) {
    assert.equal(jiuwenSwarmConfigFromEnv({ ...env, SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS: value })?.subagents, "task");
  }
  assert.equal(jiuwenSwarmConfigFromEnv({ ...env, SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS: " jiuwenswarm " })?.subagents, "jiuwenswarm");
  assert.throws(() => jiuwenSwarmConfigFromEnv({ ...env, SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS: "native" }), /must be task or jiuwenswarm/);
  assert.equal(jiuwenSwarmConfigFromEnv({ SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS: "bad" }), undefined);
});

/** The adapter side of a run that asks the model once, through the run's gateway, as JiuwenSwarm does. */
function askTheModel(turn: unknown) {
  const streamer = (async () => turn) as never;
  const adapter = fakeAdapter(async ({ body }, response) => {
    response.writeHead(200);
    await fetch(`${body.model.baseUrl}/chat/completions`, {
      method: "POST", headers: { authorization: `Bearer ${body.model.apiKey}` },
      body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "go" }] }),
    }).then((reply) => reply.text());
    response.end(line({ done: { finalText: "" } }));
  });
  return { adapter, streamer };
}

for (const truncated of [false, true]) {
  test(`invalid model arguments use recovery only when truncated (truncated=${truncated})`, async () => {
    const adapter = await fakeAdapter(async ({ body }, response) => {
      response.writeHead(200);
      await fetch(`${body.model.baseUrl}/chat/completions`, {
        method: "POST", headers: { authorization: `Bearer ${body.model.apiKey}` },
        body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "go" }] }),
      }).then(reply => reply.text());
      response.end(line({ done: { finalText: "", status: "failed" } }));
    });
    try {
      const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url, modelStreamer: async () => ({
        assistantMessage: { role: "assistant", content: "" }, truncated,
        toolCalls: [{ id: "bad-call", name: "run_shell", args: {}, argsParseError: "private-payload" }],
      }) })(options());
      await assert.rejects(agent.execute("go"), (error: Error) => {
        if (truncated) {
          assert.match(error.message, /output_recovery_exhausted/);
          assert.match(error.message, /tool_arguments/);
          assert.match(error.message, /"currentTurnToolsExecuted":false/);
          assert.equal(error.message.includes("private-payload"), false);
          return true;
        }
        assert.match(error.message, /invalid tool arguments/);
        assert.match(error.message, /tools: run_shell/);
        assert.match(error.message, /gateway request chatcmpl-[\w-]+/);
        assert.equal(error.message.includes("max_tokens"), truncated);
        assert.equal(error.message.includes("private-payload"), false);
        return true;
      });
    } finally { await adapter.close(); }
  });
}

// Regression boundary: real run -> HTTP model gateway -> fake upstream model.
// The adapter deliberately emits NO progress events while awaiting the model.
// These are not browser/Python Swarm E2E tests. Keep the healthy-run assertions
// enabled: they expose the missing gateway-to-RunDeadlines progress connection.
const MODEL_IDLE_MS = 500;
const MODEL_PULSE_MS = 40;
const MODEL_ACTIVE_MS = MODEL_IDLE_MS * 3;

test("subagent turn observer stops a second model request before upstream despite misleading display events", { timeout: 5_000 }, async () => {
  let upstreamCalls = 0;
  const adapter = await fakeAdapter(async ({ body }, response) => {
    response.writeHead(200);
    response.flushHeaders();
    for (let i = 0; i < 2; i++) {
      // A late/misnumbered UI event must not consume model budget.
      response.write(line({ event: { type: "assistant.response.started", responseId: `r${i}`, turn: 0 } }));
      await fetch(`${body.model.baseUrl}/chat/completions`, {
        method: "POST", headers: { authorization: `Bearer ${body.model.apiKey}` },
        body: JSON.stringify({ messages: [{ role: "user", content: "go" }] }),
      }).then(r => r.text()).catch(() => undefined);
    }
    if (!response.destroyed) response.end(line({ done: { status: "completed", finalText: "must not be accepted" } }));
  });
  const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url, modelStreamer: async () => {
    upstreamCalls++;
    return { assistantMessage: { role: "assistant", content: "first" }, toolCalls: [] };
  } })(options());
  let admitted = 0;
  let exceeded = false;
  agent.subscribe(event => {
    if (event.type !== "turn_start") return;
    if (admitted >= 1) { exceeded = true; agent.abort(); }
    else admitted++;
  });
  try {
    await assert.rejects(agent.execute("go"), /cancelled/);
    assert.equal(exceeded, true);
    assert.equal(upstreamCalls, 1);
    assert.equal(admitted, 1);
  } finally { agent.abort(); await adapter.close(); }
});

async function quietModelAdapter() {
  return fakeAdapter(async ({ body }, response) => {
    response.writeHead(200);
    response.flushHeaders();
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    response.on("close", disconnect);
    try {
      const reply = await fetch(`${body.model.baseUrl}/chat/completions`, {
        method: "POST", signal: controller.signal,
        headers: { authorization: `Bearer ${body.model.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ stream: true, messages: [{ role: "user", content: body.prompt }] }),
      });
      const wire = await reply.text();
      if (!reply.ok || !wire.includes("[DONE]")) throw new Error("Model stream did not complete");
      if (!response.destroyed) response.end(line({ done: { status: "completed", finalText: "model finished" } }));
    } catch (error) {
      // Cancellation is expected in stall tests; never leave an unhandled
      // rejection in the HTTP server or turn it into a successful adapter reply.
      if (!response.destroyed) response.destroy(error instanceof Error ? error : undefined);
    } finally {
      response.off("close", disconnect);
    }
  });
}

for (const channel of ["transport", "thinking", "text", "tool arguments"] as const) {
  test(`model ${channel} progress keeps a quiet Swarm run alive beyond its idle deadline`, { timeout: 10_000 }, async () => {
    const adapter = await quietModelAdapter();
    let pulses = 0;
    const streamer: typeof streamModelTurn = async (_e, _p, _h, _t, _policy, signal, callbacks) => {
      const started = Date.now();
      while (Date.now() - started < MODEL_ACTIVE_MS) {
        signal?.throwIfAborted();
        pulses++;
        if (channel === "transport") callbacks?.onProgress?.();
        if (channel === "thinking") callbacks?.onThinkingDelta?.("thinking");
        if (channel === "text") callbacks?.onTextDelta?.("working");
        if (channel === "tool arguments") callbacks?.onToolCallDelta?.({ index: 0, arguments: " " });
        await delay(MODEL_PULSE_MS, undefined, { signal });
      }
      return { assistantMessage: { role: "assistant", content: "done" }, toolCalls: [] };
    };
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url, modelStreamer: streamer })(
      options({ runIdleTimeoutMs: MODEL_IDLE_MS, runTimeoutMs: 8_000 }));
    try {
      const result = await agent.execute("active");
      assert.ok(pulses >= 3, "The upstream model must actually emit repeated progress");
      assert.match(JSON.stringify(result.finalMessages), /model finished/);
    } finally { agent.abort(); await adapter.close(); }
  });
}

test("model silence after real progress still expires the run and aborts upstream", { timeout: 10_000 }, async () => {
  const adapter = await quietModelAdapter();
  let lastProgress = 0;
  let upstreamAborted = false;
  const streamer: typeof streamModelTurn = async (_e, _p, _h, _t, _policy, signal, callbacks) => {
    try {
      for (let i = 0; i < 5; i++) {
        callbacks?.onProgress?.();
        lastProgress = Date.now();
        await delay(MODEL_PULSE_MS, undefined, { signal });
      }
      await delay(8_000, undefined, { signal });
      throw new Error("Silent model was not aborted");
    } finally { upstreamAborted = signal?.aborted === true; }
  };
  const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url, modelStreamer: streamer })(
    options({ runIdleTimeoutMs: MODEL_IDLE_MS, runTimeoutMs: 8_000 }));
  try {
    await assert.rejects(agent.execute("stall"), /Agent run stalled: no gateway progress for 500 ms/);
    assert.ok(lastProgress > 0, "The model request must have started");
    assert.ok(Date.now() - lastProgress >= MODEL_IDLE_MS - 30, "Idle time starts at the LAST model progress, not run creation");
    assert.equal(upstreamAborted, true);
  } finally { agent.abort(); await adapter.close(); }
});

test("continuous model progress cannot extend the whole-run deadline", { timeout: 5_000 }, async () => {
  const adapter = await quietModelAdapter();
  let upstreamAborted = false;
  const streamer: typeof streamModelTurn = async (_e, _p, _h, _t, _policy, signal, callbacks) => {
    try {
      for (;;) {
        callbacks?.onProgress?.();
        await delay(MODEL_PULSE_MS, undefined, { signal });
      }
    } finally { upstreamAborted = signal?.aborted === true; }
  };
  const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url, modelStreamer: streamer })(
    options({ runIdleTimeoutMs: MODEL_IDLE_MS, runTimeoutMs: 350 }));
  try {
    await assert.rejects(agent.execute("active"), /Agent run timeout: gateway turn exceeded 350 ms/);
    assert.equal(upstreamAborted, true);
  } finally { agent.abort(); await adapter.close(); }
});

test("one child run's model progress cannot keep a silent sibling alive", { timeout: 10_000 }, async () => {
  const adapter = await quietModelAdapter();
  const started = new Set<string>();
  let stalledAborted = false;
  let healthyFinished = false;
  const streamer: typeof streamModelTurn = async (_e, _p, history, _t, _policy, signal, callbacks) => {
    const stalled = JSON.stringify(history).includes("silent-child");
    started.add(stalled ? "silent" : "healthy");
    // Start both model requests before producing healthy traffic.
    while (started.size < 2) await delay(5, undefined, { signal });
    if (stalled) {
      try { await delay(8_000, undefined, { signal }); }
      finally { stalledAborted = signal?.aborted === true; }
      throw new Error("Silent sibling was not aborted");
    }
    const began = Date.now();
    while (Date.now() - began < MODEL_ACTIVE_MS) {
      callbacks?.onProgress?.();
      await delay(MODEL_PULSE_MS, undefined, { signal });
    }
    healthyFinished = true;
    return { assistantMessage: { role: "assistant", content: "done" }, toolCalls: [] };
  };
  const factory = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url, modelStreamer: streamer });
  const healthy = factory(options({ sessionId: "healthy-child", runIdleTimeoutMs: MODEL_IDLE_MS, runTimeoutMs: 8_000 }));
  const silent = factory(options({ sessionId: "silent-child", runIdleTimeoutMs: MODEL_IDLE_MS, runTimeoutMs: 8_000 }));
  try {
    const results = await Promise.allSettled([
      healthy.execute("healthy-child"),
      silent.execute("silent-child").catch(error => {
        assert.equal(healthyFinished, false, "The silent child must time out while its sibling is still streaming");
        throw error;
      }),
    ]);
    assert.equal(started.size, 2);
    assert.equal(results[0].status, "fulfilled", "Healthy sibling must finish, not be misclassified as idle");
    assert.equal(results[1].status, "rejected");
    if (results[1].status === "rejected") assert.match(String(results[1].reason), /Agent run stalled: no gateway progress for 500 ms/);
    assert.equal(stalledAborted, true);
    assert.equal(healthyFinished, true);
  } finally { healthy.abort(); silent.abort(); await adapter.close(); }
});

test("an unrecovered reasoning-only output limit fails with actionable diagnostics", async () => {
  const { adapter: pending, streamer } = askTheModel({ assistantMessage: { role: "assistant", content: "" }, toolCalls: [], truncated: true });
  const adapter = await pending;
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url, modelStreamer: streamer })(options());
    const events = collect(agent);
    await assert.rejects(agent.execute("go"), /output_recovery_exhausted.*reasoning_only/);
    assert.equal(events.some((event) => event.type === "turn_truncated"), true);
  } finally {
    await adapter.close();
  }
});

test("an unrecovered partial answer must not complete the run", async () => {
  const { adapter: pending, streamer } = askTheModel({ assistantMessage: { role: "assistant", content: "Here is the start" }, toolCalls: [], truncated: true });
  const adapter = await pending;
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url, modelStreamer: streamer })(options());
    const events = collect(agent);
    await assert.rejects(agent.execute("go"), /output_recovery_exhausted.*partial_answer/);
    assert.equal(events.some((event) => event.type === "turn_truncated"), true);
  } finally {
    await adapter.close();
  }
});

test("a turn that ended normally reports nothing", async () => {
  const { adapter: pending, streamer } = askTheModel({ assistantMessage: { role: "assistant", content: "done" }, toolCalls: [] });
  const adapter = await pending;
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url, modelStreamer: streamer })(options());
    const events = collect(agent);
    await agent.execute("go");
    assert.equal(events.some((event) => event.type === "turn_truncated"), false);
  } finally {
    await adapter.close();
  }
});

test("no part of the conversation is sent to the adapter: JiuwenSwarm holds the context", async () => {
  let sent: any;
  const adapter = await fakeAdapter(async ({ body }, response) => { sent = body; response.writeHead(200); response.end(line({ done: { finalText: "ok" } })); });
  try {
    const history = [{ role: "user", content: "earlier question" }, { role: "assistant", content: "earlier answer" }];
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ gatewayHistory: history as never })).execute("next");
    assert.equal("history" in sent, false);
    assert.equal(sent.prompt, "next");
    assert.equal(JSON.stringify(sent).includes("earlier answer"), false);
  } finally {
    await adapter.close();
  }
});

test("JiuwenSwarm's own prompt is kept with ours before it by default, and replaced only when asked", async () => {
  const sent: any[] = [];
  const adapter = await fakeAdapter(async ({ body }, response) => { sent.push(body); response.writeHead(200); response.end(line({ done: { finalText: "ok" } })); });
  try {
    const { store } = planRecorder();
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url, subagents: "jiuwenswarm" })(withRunSubagent({ planStore: store as never })).execute("a");
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url, subagents: "jiuwenswarm", prompt: "replace" })(withRunSubagent({ planStore: store as never })).execute("b");
    assert.equal(sent[0].systemPromptMode, "prepend");
    assert.equal(sent[1].systemPromptMode, "replace");
    assert.equal(sent[0].systemPrompt.includes("## Planning"), false, "JiuwenSwarm's own todo section does the teaching");
    assert.match(sent[1].systemPrompt, /## Planning[\s\S]*todo_create/, "its prompt is gone, so the model is told here");
    assert.equal(sent[0].systemPrompt.includes("## Delegation"), false, "JiuwenSwarm's own prompt already documents subagent_spawn");
    assert.match(sent[1].systemPrompt, /## Delegation[\s\S]*subagent_spawn/, "its prompt is gone, so the model is told here");
  } finally {
    await adapter.close();
  }
});

test("the prompt mode is chosen by SCIENCE_AGENT_JIUWENSWARM_PROMPT", () => {
  const env = { SCIENCE_AGENT_EXECUTOR: "jiuwenswarm", SCIENCE_AGENT_ADAPTER_URL: "http://a" };
  assert.equal(jiuwenSwarmConfigFromEnv(env)?.prompt, undefined, "unset means append");
  assert.equal(jiuwenSwarmConfigFromEnv({ ...env, SCIENCE_AGENT_JIUWENSWARM_PROMPT: "replace" })?.prompt, "replace");
});

test("by default the model gets JiuwenSwarm's own tools but not those acting on the host, and a call to one is reported from the event stream", async () => {
  let sent: any;
  const adapter = await fakeAdapter(async ({ body }, response) => {
    sent = body;
    response.writeHead(200);
    response.write(line({ event: { type: "tool.started", trace: { id: "b1", name: "memory_search", args: { query: "x" }, status: "running", native: true } } }));
    response.write(line({ event: { type: "tool.completed", trace: { id: "b1", name: "memory_search", args: {}, status: "completed", output: "a note", native: true } } }));
    response.end(line({ done: { finalText: "ok" } }));
  });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options());
    const events = collect(agent);
    await agent.execute("go");
    assert.equal(sent.jiuwenSwarmTools, "all");
    assert.equal(sent.systemPrompt.includes("Use only the registered workspace tools"), false);
    // Commands and file writes stay in ScienceDiscovery's sandbox: JiuwenSwarm's host tools are hidden, and the prompt says so.
    assert.deepEqual(sent.hiddenJiuwenSwarmTools, ["bash", "read_file", "write_file", "edit_file", "glob", "list_files", "grep", "read_pdf",
      "todo_create", "todo_modify", "todo_list", "todo_get",
      "subagent_spawn", "subagent_wait", "task_tool", "subagent_list", "subagent_send_input", "subagent_close", "subagent_resume"]);
    assert.match(sent.systemPrompt, /run in the sandbox through run_shell/);
    assert.match(sent.systemPrompt, /skill_index may show absolute host paths[\s\S]*never pass them to read_file/);
    assert.match(sent.systemPrompt, /skill_tool\(skill_name=<name>, relative_file_path="SKILL\.md"\)/);
    assert.match(sent.systemPrompt, /If skill_tool fails, including a filesystem lock error, immediately load that Skill with read_skill\(skillId=<ScienceDiscovery skill id>\)/);
    assert.match(sent.systemPrompt, /Do not try to recover a failed skill_tool call by reading its host path with run_shell/);
    const start = events.find((event) => event.type === "tool_execution_start") as any;
    const end = events.find((event) => event.type === "tool_execution_end") as any;
    assert.equal(start.toolName, "memory_search");
    assert.equal(end.result.content[0].text, "a note");
  } finally {
    await adapter.close();
  }
});

test("SCIENCE_AGENT_JIUWENSWARM_TOOLS=ours keeps the model to ScienceDiscovery's tools", async () => {
  let sent: any;
  const adapter = await fakeAdapter(async ({ body }, response) => { sent = body; response.writeHead(200); response.end(line({ done: { finalText: "ok" } })); });
  try {
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url, tools: "ours" })(options()).execute("go");
    assert.equal(sent.jiuwenSwarmTools, "listed");
    const env = { SCIENCE_AGENT_EXECUTOR: "jiuwenswarm", SCIENCE_AGENT_ADAPTER_URL: "http://a" };
    assert.equal(jiuwenSwarmConfigFromEnv(env)?.tools, undefined);
    assert.equal(jiuwenSwarmConfigFromEnv({ ...env, SCIENCE_AGENT_JIUWENSWARM_TOOLS: "ours" })?.tools, "ours");
  } finally {
    await adapter.close();
  }
});

test("the run contract is sent apart, to go after JiuwenSwarm's prompt, and is not in ours", async () => {
  let sent: any;
  const adapter = await fakeAdapter(async ({ body }, response) => { sent = body; response.writeHead(200); response.end(line({ done: { finalText: "ok" } })); });
  try {
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ runContract: "Find the number." })).execute("go");
    assert.match(sent.systemPromptTail, /<run_contract>[\s\S]*Find the number\.[\s\S]*<\/run_contract>/);
    assert.equal(sent.systemPrompt.includes("<run_contract>"), false);
  } finally {
    await adapter.close();
  }
});

test("with JiuwenSwarm's tools, web search and fetching are JiuwenSwarm's, in the tools and in the prompt", async () => {
  const sent: any[] = [];
  const adapter = await fakeAdapter(async ({ body }, response) => { sent.push(body); response.writeHead(200); response.end(line({ done: { finalText: "ok" } })); });
  const opts = () => options({ webSearch: (async () => []) as never, webFetch: (async () => ({})) as never });
  try {
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(opts()).execute("a");
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url, tools: "ours" })(opts()).execute("b");
    const names = (body: any) => body.tools.map((tool: { name: string }) => tool.name);
    assert.equal(names(sent[0]).includes("web_search") || names(sent[0]).includes("web_fetch"), false);
    assert.equal(/\bweb_search\b|\bweb_fetch\b/.test(sent[0].systemPrompt), false, "the prompt names JiuwenSwarm's tools");
    assert.ok(names(sent[1]).includes("web_search") && names(sent[1]).includes("web_fetch"), "ours with SCIENCE_AGENT_JIUWENSWARM_TOOLS=ours");
  } finally {
    await adapter.close();
  }
});

test("a finished JiuwenSwarm search is recorded through the run's web recorder", async () => {
  const recorded: any[] = [];
  const adapter = await fakeAdapter(async (_request, response) => {
    response.writeHead(200);
    response.write(line({ event: { type: "tool.started", trace: { id: "s1", name: "free_search", args: { query: "q" }, status: "running", native: true } } }));
    response.write(line({ event: { type: "tool.completed", trace: { id: "s1", name: "free_search", args: {}, status: "completed", native: true,
      output: "Free search results (Bing) for: q\n1. T\n   URL: https://t.example" } } }));
    response.end(line({ done: { finalText: "ok" } }));
  });
  try {
    const recordWebResult = async (id: string, result: unknown) => { recorded.push({ id, result }); };
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ recordWebResult } as never)).execute("go");
    assert.deepEqual(recorded, [{ id: "s1", result: { kind: "search", toolName: "free_search", rows: [{ url: "https://t.example", title: "T" }] } }]);
  } finally {
    await adapter.close();
  }
});

function skill(id: string, description = `${id} things`) {
  return {
    content: `---\nname: ${id}\ndescription: ${description}\n---\nFollow the steps.`, description, hash: `hash-${id}`, id,
    packagePath: `$SCIENCEDISCOVERY_SKILLS_DIR/${id}`, readResource: () => { throw new Error("no resources"); },
    resources: [], revision: 1, version: "1.0.0",
  };
}

const skillOptions = (extra: Record<string, unknown> = {}) => options({
  skills: [skill("evolve-design"), skill("skill-creator")], skillPackagesRoot: "/data/skill-snapshots/abc", ...extra,
} as never);

test("the run's skills are installed in JiuwenSwarm with our read_skill retained as a fallback", async () => {
  const adapter = await fakeAdapter(async ({ body }, response) => {
    if (body.skills) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ skills: { "evolve-design": { name: "evolve-design" }, "skill-creator": { name: "sciencediscovery-skill-creator" } } }));
      return;
    }
    response.writeHead(200);
    response.end(line({ done: { finalText: "ok" } }));
  });
  try {
    const created: unknown[] = [];
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(skillOptions({
      createSkill: async (draft: unknown) => { created.push(draft); return { id: "d1" }; },
      skills: [
        { ...skill("evolve-design"), resources: [{ hash: "hash-reference", kind: "reference", path: "references/custom-script.md", size: 24 }] },
        skill("skill-creator"),
      ],
    })).execute("go");
    const [install, run] = adapter.requests.map((request) => request.body);
    assert.deepEqual(install.skills, [
      { hash: "hash-evolve-design", id: "evolve-design", path: "/data/skill-snapshots/abc/evolve-design" },
      { hash: "hash-skill-creator", id: "skill-creator", path: "/data/skill-snapshots/abc/skill-creator" },
    ]);
    const names = run.tools.map((tool: { name: string }) => tool.name);
    assert.ok(names.includes("read_skill") && names.includes("read_skill_resource"));
    assert.equal(/<available_skills>/.test(run.systemPrompt), false, "JiuwenSwarm's prompt lists the skills, ours does not duplicate them");
    assert.match(run.systemPrompt, /If skill_tool fails, including a filesystem lock error, immediately load that Skill with read_skill/);
    const createSkill = run.tools.find((tool: { name: string }) => tool.name === "create_skill");
    assert.match(createSkill.description, /load the sciencediscovery-skill-creator skill with skill_tool/);
  } finally {
    await adapter.close();
  }
});

test("loading skill-creator with JiuwenSwarm's skill_tool lets create_skill run, as read_skill did", async () => {
  let reply: any;
  const adapter = await fakeAdapter(async ({ body }, response) => {
    if (body.skills) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ skills: { "evolve-design": { name: "evolve-design" }, "skill-creator": { name: "sciencediscovery-skill-creator" } } }));
      return;
    }
    response.writeHead(200);
    response.write(line({ event: { type: "tool.started", trace: { id: "k1", name: "skill_tool", args: { skill_name: "sciencediscovery-skill-creator" }, status: "running", native: true } } }));
    response.write(line({ event: { type: "tool.completed", trace: { id: "k1", name: "skill_tool", args: {}, status: "completed", output: "# skill-creator", native: true } } }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const args = { name: "my-skill", description: "Does a thing.", instructions: "Do the thing." };
    response.write(line({ event: { type: "tool.started", trace: { id: "c1", name: "create_skill", args, status: "running" } } }));
    const call = await fetch(body.bridge.url, {
      method: "POST",
      headers: { authorization: `Bearer ${body.bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "create_skill", arguments: args }),
    });
    reply = await call.json();
    response.end(line({ done: { finalText: "ok" } }));
  });
  try {
    const created: any[] = [];
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(skillOptions({ createSkill: async (draft: unknown) => { created.push(draft); return { id: "d1" }; } })).execute("go");
    assert.equal(reply.isError, false, reply.text);
    assert.equal(created[0].name, "my-skill");
  } finally {
    await adapter.close();
  }
});

test("a skill JiuwenSwarm could not install stays ours: read_skill and our catalog offer just that one", async () => {
  const adapter = await fakeAdapter(async ({ body }, response) => {
    if (body.skills) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ skills: { "evolve-design": { name: "evolve-design" }, "skill-creator": { error: "refused" } } }));
      return;
    }
    response.writeHead(200);
    response.end(line({ done: { finalText: "ok" } }));
  });
  try {
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(skillOptions()).execute("go");
    const run = adapter.requests[1].body;
    assert.ok(run.tools.some((tool: { name: string }) => tool.name === "read_skill"));
    assert.match(run.systemPrompt, /<name>skill-creator<\/name>/);
    assert.doesNotMatch(run.systemPrompt, /<name>evolve-design<\/name>/);
  } finally {
    await adapter.close();
  }
});

test("with SCIENCE_AGENT_JIUWENSWARM_SKILLS=ours nothing is installed and the skills are offered our way", async () => {
  const adapter = await fakeAdapter(async (_request, response) => { response.writeHead(200); response.end(line({ done: { finalText: "ok" } })); });
  try {
    const config = { ...jiuwenSwarmConfigFromEnv({ SCIENCE_AGENT_EXECUTOR: "jiuwenswarm", SCIENCE_AGENT_ADAPTER_URL: adapter.url, SCIENCE_AGENT_JIUWENSWARM_SKILLS: "ours" })! };
    await createJiuwenSwarmAgentFactory(config)(skillOptions()).execute("go");
    assert.equal(adapter.requests.length, 1, "no skill import");
    assert.ok(adapter.requests[0].body.tools.some((tool: { name: string }) => tool.name === "read_skill"));
    assert.match(adapter.requests[0].body.systemPrompt, /<available_skills>/);
  } finally {
    await adapter.close();
  }
});

test("each tool carries what JiuwenSwarm's permission engine does before a call: ask for what executes, allow the rest", async () => {
  const adapter = await fakeAdapter(async (_request, response) => { response.writeHead(200); response.end(line({ done: { finalText: "ok" } })); });
  try {
    const connector = { label: "Search", name: "mcp__pubmed__search", description: "Search.", parameters: Type.Object({}), execute: async () => ({ content: [] }) };
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ extraTools: [connector as never] })).execute("go");
    const levels = Object.fromEntries(adapter.requests[0].body.tools.map((tool: { name: string; approval: string }) => [tool.name, tool.approval]));
    assert.equal(levels.run_shell, "ask");
    assert.equal(levels.mcp__pubmed__search, "ask");
    assert.equal(levels.read_file, "allow");
  } finally {
    await adapter.close();
  }
});

test("a JiuwenSwarm approval question is put to the user as ours and the answer goes back to the adapter", async () => {
  let answered: any;
  const adapter = await fakeAdapter(async ({ body }, response) => {
    if (body.decision) {
      answered = body;
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    response.writeHead(200);
    response.write(line({ event: { type: "permission.required", request: { id: "q1", resource: "run_shell: rm -rf out", summary: "run_shell: rm -rf out", toolCallId: "q1" } } }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    response.end(line({ done: { finalText: "ok" } }));
  });
  try {
    const asked: unknown[] = [];
    const requestApproval = async (request: unknown) => { asked.push(request); return "allow_matching" as const; };
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ requestApproval } as never)).execute("go");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(asked, [{ resource: "run_shell: rm -rf out", summary: "run_shell: rm -rf out", toolCallId: "q1" }]);
    assert.deepEqual(answered, { decision: "allow_matching" });
    assert.equal(adapter.requests.at(-1).body.decision, "allow_matching");
  } finally {
    await adapter.close();
  }
});

test("an approval question names run_shell's stable resource, so a standing grant made outside the run still applies to it", async () => {
  let asked: any;
  const adapter = await fakeAdapter(async ({ body }, response) => {
    if (body.decision) { response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); return; }
    response.writeHead(200);
    response.write(line({ event: { type: "permission.required", request: { id: "q1", resource: "run_shell: rm -rf out", summary: "run_shell: rm -rf out", toolName: "run_shell", toolCallId: "q1" } } }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    response.end(line({ done: { finalText: "ok" } }));
  });
  try {
    const requestApproval = async (request: unknown) => { asked = request; return "allow_once" as const; };
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ requestApproval } as never)).execute("go");
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The resource ScienceDiscovery's own run_shell privilege check always uses (workspace-bindings.ts), not
    // the per-call "run_shell: rm -rf out" text, which a standing/session grant would never match.
    assert.equal(asked.resource, "workspace-code");
    assert.equal(asked.summary, "run_shell: rm -rf out");
  } finally {
    await adapter.close();
  }
});

test("an approval question for another tool is named by the tool, not by JiuwenSwarm's own question text", async () => {
  let asked: any;
  const question = "mcp_sci_mcp__custom-1__to_kelvin（当前模式默认需确认） > 选择「会话内记住」可在本会话内自动放行 ``mcp_sci_mcp__custom-1__to_kelvin`` 类工具的调用";
  const adapter = await fakeAdapter(async ({ body }, response) => {
    if (body.decision) { response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); return; }
    response.writeHead(200);
    response.write(line({ event: { type: "permission.required", request: {
      id: "q1", resource: question, summary: 'mcp__custom-1__to_kelvin: {"celsius": -40}', toolName: "mcp__custom-1__to_kelvin", toolCallId: "q1",
    } } }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    response.end(line({ done: { finalText: "ok" } }));
  });
  try {
    const requestApproval = async (request: unknown) => { asked = request; return "allow_once" as const; };
    await createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ requestApproval } as never)).execute("go");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(asked.resource, "mcp__custom-1__to_kelvin");
    assert.equal(asked.summary, 'mcp__custom-1__to_kelvin: {"celsius": -40}');
  } finally {
    await adapter.close();
  }
});

test("the run's trajectory is recorded from the model calls JiuwenSwarm makes, and the run's events carry its evidence", async () => {
  const { mkdtemp, rm: remove } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dataDir = await mkdtemp(join(tmpdir(), "jw-trajectory-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "jw-workspace-"));
  const turn = { assistantMessage: { role: "assistant", content: "Answer." }, toolCalls: [] };
  const streamer = (async () => turn) as never;
  const adapter = await fakeAdapter(async ({ body }, response) => {
    response.writeHead(200);
    // Housekeeping is explicitly marked by the adapter's default-model route.
    for (const tools of [[{ type: "function", function: { name: "echo", description: "e", parameters: { type: "object" } } }], []]) {
      await fetch(`${body.model.baseUrl}/chat/completions`, {
        method: "POST", headers: { authorization: `Bearer ${body.model.apiKey}`,
          ...(!tools.length ? { "x-sciencediscovery-model-purpose": "housekeeping" } : {}) },
        body: JSON.stringify({ stream: false, tools, messages: [{ role: "system", content: "sys" }, { role: "user", content: "go" }] }),
      }).then((reply) => reply.text());
    }
    response.write(line({ event: { type: "assistant.response.started", responseId: "r1", turn: 1 } }));
    response.write(line({ event: { type: "assistant.delta", responseId: "r1", delta: "Answer.", turn: 1 } }));
    response.end(line({ done: { finalText: "Answer." } }));
  });
  try {
    const records: any[] = [];
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url, modelStreamer: streamer })(options({
      config: { baseUrl: "http://llm.test/v1", dataDir, model: "gpt-x", apiToken: "sk-test", apiProtocol: "openai-chat-completions" },
      workspaceRoot,
      versioning: { agentId: "main:session-1", trajectoryId: "run-1", requestExecutionId: "run-1", recordEvent: async (event: unknown) => { records.push(event); } },
    } as never));
    const events = collect(agent);
    await agent.execute("go");
    const names = records.map((record) => record.name);
    assert.deepEqual(names.filter((name) => name !== "context_recovery"), ["context.captured", "model.completed", "state.committed"], "one turn: the title call is not one");
    assert.ok(records[0].evidence.contextRef?.digest, "the captured context is in the version store");
    const started = events.find((event) => event.type === "response_start") as any;
    assert.equal(started.evidence?.contextRef?.digest, records[0].evidence.contextRef.digest, "the response is tied to the model input it answered");
  } finally {
    await adapter.close();
    await remove(dataDir, { recursive: true, force: true });
    await remove(workspaceRoot, { recursive: true, force: true });
  }
});


test("idle cancellation does not wait for the trajectory finish queue", { timeout: 3000 }, async (t) => {
  const { JiuwenSwarmTrajectory } = await import("./jiuwenswarm-trajectory.js");
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const finish = t.mock.method(JiuwenSwarmTrajectory.prototype, "finish", () => blocked);
  const adapter = await fakeAdapter((_request, response) => { response.writeHead(200); response.write(""); });
  try {
    const agent = createJiuwenSwarmAgentFactory({ adapterUrl: adapter.url })(options({ runIdleTimeoutMs: 60 }));
    await assert.rejects(agent.execute("go"), /Agent run stalled/);
    assert.equal(finish.mock.callCount(), 1);
  } finally { release(); await adapter.close(); }
});
