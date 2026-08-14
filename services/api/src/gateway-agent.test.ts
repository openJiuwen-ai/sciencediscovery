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
import test, { type TestContext } from "node:test";

import type {
  Environment,
  EnvironmentRevision,
  PythonExecutionResult,
  SubagentUsage,
} from "@science-agent/schema";

import {
	  createGatewayAgent,
	  type GatewayRunRequest,
	  isGatewayToolError,
	  setGatewayRunRequestForTest,
	  type ToolCallbackHandler,
	  toolCallbackRegistry,
	} from "./gateway-agent.js";

type GatewayRequestOptions = NonNullable<Parameters<GatewayRunRequest>[1]>;
type MockGatewayRunBody = AsyncIterable<Uint8Array> & { dump: () => Promise<void> };

function bodyFromStream(stream: ReadableStream<Uint8Array>): MockGatewayRunBody {
  return Object.assign(stream, {
    dump: async () => {
      for await (const _chunk of stream as AsyncIterable<Uint8Array>) {
        // Drain the mocked response body.
      }
    },
  });
}

function bodyFromText(text: string): MockGatewayRunBody {
  return bodyFromStream(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  }));
}

function mockGatewayRequest(
  t: TestContext,
  handler: (options: GatewayRequestOptions) => { body: MockGatewayRunBody; statusCode?: number },
): void {
  const restore = setGatewayRunRequestForTest((async (_url, options) => {
    const requestOptions = options as GatewayRequestOptions;
    assert.equal(requestOptions.bodyTimeout, 0);
    const response = handler(requestOptions);
    return {
      body: response.body,
      context: {},
      headers: {},
      opaque: null,
      statusCode: response.statusCode ?? 200,
      statusText: "OK",
      trailers: {},
    } as Awaited<ReturnType<GatewayRunRequest>>;
  }) as GatewayRunRequest);
  t.after(restore);
}

async function waitForToolCallback(): Promise<ToolCallbackHandler> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const callback = [...toolCallbackRegistry.values()][0];
    if (callback) return callback;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  throw new Error("Timed out waiting for registered tool callback");
}

function successfulPythonResult(): PythonExecutionResult {
  const now = new Date().toISOString();
  return {
    cgroupMode: "none",
    createdFiles: [],
    environmentRevisionId: "test-python",
    environmentVariables: { HOME: "/tmp", PATH: "/usr/bin" },
    executionId: "execution",
    exitCode: 0,
    finishedAt: now,
    kernelId: "ephemeral:execution",
    kernelMode: "ephemeral",
    language: "python",
    modifiedFiles: [],
    networkPolicy: "none",
    runnerVersion: "test",
    sandbox: "bubblewrap",
    startedAt: now,
    workingDirectory: "/workspace",
    stderr: "",
    stdout: "ok\n",
  };
}

test("gateway prompt assembly injects orchestration only for lead agents", async (t) => {
  const requests: Array<{ model?: { proxy?: { mode: string } }; system_prompt?: string }> = [];
  mockGatewayRequest(t, (options) => {
    requests.push(JSON.parse(String(options.body)) as { model?: { proxy?: { mode: string } }; system_prompt?: string });
    return { body: bodyFromText(`${JSON.stringify({
      data: { final_messages: [{ content: "done", role: "assistant" }] },
      type: "end",
    })}\n`) };
  });

  const unavailable = async () => {
    throw new Error("execution is not expected in this test");
  };
  const runSubagent = async () => {
    throw new Error("subagent execution is not expected in this test");
  };
  const baseOptions = {
    callbackUrl: "http://127.0.0.1:1/internal/tool-exec",
    config: { baseUrl: "http://127.0.0.1:1", dataDir: ".", model: "test", proxy: { mode: "direct" as const } },
    enabledConnectorIds: [],
    executePython: unavailable,
    executeShell: unavailable,
    gatewayUrl: "http://127.0.0.1:1",
    runIdleTimeoutMs: 0,
    runTimeoutMs: 0,
    runSubagent,
    sessionId: "prompt-assembly-test",
    workspaceRoot: ".",
  };

  await createGatewayAgent(baseOptions).prompt("lead prompt");
  await createGatewayAgent({
    ...baseOptions,
    subagent: {
      instructions: "Complete the delegated task autonomously.",
      name: "general-purpose",
    },
  }).prompt("subagent prompt");

  const leadPrompt = requests[0]?.system_prompt ?? "";
  assert.match(leadPrompt, /<subagent_system>/);
  assert.match(leadPrompt, /SUBAGENT MODE ACTIVE - DECOMPOSE, DELEGATE, SYNTHESIZE/);
  assert.match(leadPrompt, /Maximum 10 task calls in a single model response/);
  assert.match(leadPrompt, /Maximum 50 task calls for the current user request\/run/);
  assert.doesNotMatch(leadPrompt, /If a selected skill defines a required subagent workflow/);
  assert.doesNotMatch(leadPrompt, /Applied subagent preset general-purpose/);

  const subagentPrompt = requests[1]?.system_prompt ?? "";
  assert.match(subagentPrompt, /Applied subagent preset general-purpose/);
  assert.doesNotMatch(subagentPrompt, /<subagent_system>/);
  assert.doesNotMatch(subagentPrompt, /SUBAGENT MODE ACTIVE/);
  assert.deepEqual(requests.map((request) => request.model?.proxy), [{ mode: "direct" }, { mode: "direct" }]);
});

test("gateway tool errors remain failed traces after the callback round trip", () => {
  assert.equal(isGatewayToolError("Tool error: pubmed connector failed with HTTP 503"), true);
  assert.equal(isGatewayToolError("Tool callback transport error: connection refused"), true);
  assert.equal(isGatewayToolError("provider returned a record", "error"), true);
  assert.equal(isGatewayToolError("provider returned a record"), false);
});

test("gateway request sends skill metadata for native describe_skill", async (t) => {
  const requests: Array<{ skills?: Array<{ content?: string; id: string }>; system_prompt?: string; tools?: Array<{ name: string }> }> = [];
  mockGatewayRequest(t, (options) => {
    requests.push(JSON.parse(String(options.body)) as { skills?: Array<{ content?: string; id: string }>; system_prompt?: string; tools?: Array<{ name: string }> });
    return { body: bodyFromText(`${JSON.stringify({
      data: { final_messages: [{ content: "done", role: "assistant" }] },
      type: "end",
    })}\n`) };
  });

  const unavailable = async () => {
    throw new Error("execution is not expected in this test");
  };
  await createGatewayAgent({
    callbackUrl: "http://127.0.0.1:1/internal/tool-exec",
    config: { baseUrl: "http://127.0.0.1:1", dataDir: ".", model: "test" },
    enabledConnectorIds: [],
    executePython: unavailable,
    executeShell: unavailable,
    gatewayUrl: "http://127.0.0.1:1",
    runIdleTimeoutMs: 0,
    runTimeoutMs: 0,
    sessionId: "skill-metadata-test",
    skills: [{
      content: "Full frozen instructions stay in Node for read_skill.",
      description: "Progressive loading test skill.",
      hash: "b".repeat(64),
      id: "selected-skill",
      readResource: () => { throw new Error("not used"); },
      resources: [{ hash: "a".repeat(64), kind: "reference", path: "references/guide.md", size: 24 }],
      revision: 3,
      version: "1.0.0",
    }],
    workspaceRoot: ".",
  }).prompt("use a skill");

  const request = requests[0];
  assert.ok(request);
  assert.match(request.system_prompt ?? "", /<skill_system>/);
  assert.deepEqual(request.tools?.some((tool) => tool.name === "describe_skill"), false);
  assert.equal(request.tools?.some((tool) => tool.name === "read_skill"), true);
  assert.equal(request.skills?.[0]?.id, "selected-skill");
  assert.equal(request.skills?.[0]?.content, undefined);
});

test("gateway sends fixed provider-safe environment names and routes every callback", async (t) => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let payload: { tools?: Array<{ name: string }> } = {};
  mockGatewayRequest(t, (options) => {
    payload = JSON.parse(String(options.body)) as typeof payload;
    return { body: bodyFromStream(new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
    })) };
  });
  const now = new Date().toISOString();
  const environment: Environment = {
    createdAt: now,
    currentRevisionId: "revision-1",
    id: "environment-1",
    kind: "task",
    language: "python",
    name: "Analysis",
    updatedAt: now,
  };
  const revision: EnvironmentRevision = {
    channels: ["conda-forge"],
    createdAt: now,
    environmentId: environment.id,
    id: "revision-2",
    language: "python",
    languageVersion: "3.12",
    packages: [],
    packageSpecHash: "hash",
    platform: "linux-x64",
    provisioner: "micromamba",
    runnerVersion: "test",
    snapshot: { hash: "a".repeat(64), size: 1 },
  };
  const calls: string[] = [];
  const unavailable = async () => { throw new Error("execution is not expected in this test"); };
  const agent = createGatewayAgent({
    callbackUrl: "http://127.0.0.1:1/internal/tool-exec",
    config: { baseUrl: "http://127.0.0.1:1", dataDir: ".", model: "test" },
    enabledConnectorIds: [],
    environmentManagement: {
      create: async (input) => {
        calls.push(`create:${input.name}:${input.language}`);
        return environment;
      },
      delete: async (environmentId) => { calls.push(`delete:${environmentId}`); },
      install: async (environmentId) => {
        calls.push(`install:${environmentId}`);
        return revision;
      },
      list: async () => {
        calls.push("list");
        return [environment];
      },
      uninstall: async (environmentId) => {
        calls.push(`uninstall:${environmentId}`);
        return revision;
      },
    },
    environments: [environment],
    executePython: unavailable,
    executeScientific: unavailable,
    executeShell: unavailable,
    gatewayUrl: "http://127.0.0.1:1",
    runIdleTimeoutMs: 0,
    runTimeoutMs: 0,
    sessionId: "environment-tool-names-test",
    workspaceRoot: ".",
  });

  const prompt = agent.prompt("manage environments");
  const callback = await waitForToolCallback();
  const expectedNames = [
    "environment_list",
    "environment_create",
    "environment_delete",
    "environment_install",
    "environment_uninstall",
  ];
  assert.deepEqual(
    payload.tools?.map((tool) => tool.name).filter((name) => name.startsWith("environment_")),
    expectedNames,
  );
  assert.ok(payload.tools?.every((tool) => /^[a-zA-Z0-9_-]+$/.test(tool.name)));

  await callback("environment_list", {}, "list-call");
  await callback("environment_create", { language: "python", name: "Analysis" }, "create-call");
  await callback("environment_delete", { environmentId: environment.id }, "delete-call");
  await callback("environment_install", { environmentId: environment.id, packages: ["numpy"] }, "install-call");
  await callback("environment_uninstall", { environmentId: environment.id, packages: ["numpy"] }, "uninstall-call");
  assert.deepEqual(calls, [
    "list",
    "create:Analysis:python",
    "delete:environment-1",
    "install:environment-1",
    "uninstall:environment-1",
  ]);

  controller?.enqueue(new TextEncoder().encode(`${JSON.stringify({ data: {}, type: "end" })}\n`));
  controller?.close();
  await prompt;
});

test("gateway normalizes the five legacy environment names in canonical history", async (t) => {
  let payload: { messages?: Array<Record<string, unknown>> } = {};
  mockGatewayRequest(t, (options) => {
    payload = JSON.parse(String(options.body)) as typeof payload;
    return { body: bodyFromText(`${JSON.stringify({ data: {}, type: "end" })}\n`) };
  });
  const unavailable = async () => { throw new Error("execution is not expected in this test"); };
  const legacyNames = [
    "environment.list",
    "environment.create",
    "environment.delete",
    "environment.install",
    "environment.uninstall",
  ];
  const expectedNames = [
    "environment_list",
    "environment_create",
    "environment_delete",
    "environment_install",
    "environment_uninstall",
  ];
  await createGatewayAgent({
    callbackUrl: "http://127.0.0.1:1/internal/tool-exec",
    config: { baseUrl: "http://127.0.0.1:1", dataDir: ".", model: "test" },
    enabledConnectorIds: [],
    executePython: unavailable,
    executeShell: unavailable,
    gatewayHistory: [
      {
        content: "",
        role: "assistant",
        tool_calls: legacyNames.map((name, index) => ({
          function: { arguments: "{}", name },
          id: `legacy-call-${index}`,
          type: "function",
        })),
      },
      ...legacyNames.map((name, index) => ({
        content: "[]",
        name,
        role: "tool",
        tool_call_id: `legacy-call-${index}`,
      })),
    ],
    gatewayUrl: "http://127.0.0.1:1",
    sessionId: "legacy-environment-history-test",
    workspaceRoot: ".",
  }).prompt("continue");

  const assistant = payload.messages?.[0] as { tool_calls?: Array<{ function?: { name?: string } }> };
  assert.deepEqual(assistant.tool_calls?.map((toolCall) => toolCall.function?.name), expectedNames);
  assert.deepEqual(payload.messages?.slice(1, 1 + expectedNames.length).map((message) => message.name), expectedNames);
  assert.doesNotMatch(JSON.stringify(payload.messages), /environment\.(?:list|create|delete|install|uninstall)/);
});

test("gateway rejects duplicate workspace tool names before callback registration", () => {
  const unavailable = async () => { throw new Error("execution is not expected in this test"); };
  assert.throws(() => createGatewayAgent({
    callbackUrl: "http://127.0.0.1:1/internal/tool-exec",
    config: { baseUrl: "http://127.0.0.1:1", dataDir: ".", model: "test" },
    enabledConnectorIds: [],
    executePython: unavailable,
    executeShell: unavailable,
    gatewayUrl: "http://127.0.0.1:1",
    mcpTools: [{
      description: "Duplicate built-in name",
      displayName: "Duplicate",
      execute: unavailable,
      inputSchema: { properties: {}, type: "object" },
      name: "run_python",
      routing: { keywords: [], mode: "off", priority: 0 },
      sourceId: "duplicate",
      toolId: "duplicate",
    }],
    sessionId: "duplicate-tool-name-test",
    workspaceRoot: ".",
  }), /Duplicate workspace tool name: run_python/);
});

test("gateway idle deadline covers a response body that stops streaming", async (t) => {
  mockGatewayRequest(t, (options) => {
    const signal = options.signal as AbortSignal | undefined;
    return { body: bodyFromStream(new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener("abort", () => {
          controller.error(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      },
    })) };
  });

  const unavailable = async () => {
    throw new Error("execution is not expected in this test");
  };
  const agent = createGatewayAgent({
    callbackUrl: "http://127.0.0.1:1/internal/tool-exec",
    config: { baseUrl: "http://127.0.0.1:1", dataDir: ".", model: "test" },
    enabledConnectorIds: [],
    executePython: unavailable,
    executeShell: unavailable,
    gatewayUrl: "http://127.0.0.1:1",
    runIdleTimeoutMs: 20,
    runTimeoutMs: 200,
    sessionId: "timeout-test",
    workspaceRoot: ".",
  });

  await assert.rejects(agent.prompt("test timeout"), /Agent run stalled: no gateway progress for 20 ms/);
  assert.equal(toolCallbackRegistry.size, 0);
});

test("gateway progress can continue beyond one idle window", async (t) => {
  mockGatewayRequest(t, (options) => {
    const signal = options.signal as AbortSignal | undefined;
    return { body: bodyFromStream(new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        let sequence = 0;
        const interval = setInterval(() => {
          sequence += 1;
          controller.enqueue(encoder.encode(`${JSON.stringify({
            data: { content: `chunk-${sequence}`, id: "progress-turn", type: "ai" },
            type: "messages-tuple",
          })}\n`));
          if (sequence === 4) {
            clearInterval(interval);
            controller.enqueue(encoder.encode(`${JSON.stringify({ data: {}, type: "end" })}\n`));
            controller.close();
          }
        }, 25);
        signal?.addEventListener("abort", () => {
          clearInterval(interval);
          controller.error(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      },
    })) };
  });

  const unavailable = async () => {
    throw new Error("execution is not expected in this test");
  };
  const agent = createGatewayAgent({
    callbackUrl: "http://127.0.0.1:1/internal/tool-exec",
    config: { baseUrl: "http://127.0.0.1:1", dataDir: ".", model: "test" },
    enabledConnectorIds: [],
    executePython: unavailable,
    executeShell: unavailable,
    gatewayUrl: "http://127.0.0.1:1",
    runIdleTimeoutMs: 75,
    runTimeoutMs: 500,
    sessionId: "progress-test",
    workspaceRoot: ".",
  });

  await agent.prompt("test progress");
  assert.equal(toolCallbackRegistry.size, 0);
});

test("zero disables both Gateway timers", async (t) => {
  mockGatewayRequest(t, () => ({ body: bodyFromStream(new ReadableStream<Uint8Array>({
    start(controller) {
      setTimeout(() => {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ data: {}, type: "end" })}\n`));
        controller.close();
      }, 40);
    },
  })) }));

  const unavailable = async () => {
    throw new Error("execution is not expected in this test");
  };
  const agent = createGatewayAgent({
    callbackUrl: "http://127.0.0.1:1/internal/tool-exec",
    config: { baseUrl: "http://127.0.0.1:1", dataDir: ".", model: "test" },
    enabledConnectorIds: [],
    executePython: unavailable,
    executeShell: unavailable,
    gatewayUrl: "http://127.0.0.1:1",
    runIdleTimeoutMs: 0,
    runTimeoutMs: 0,
    sessionId: "unlimited-test",
    workspaceRoot: ".",
  });

  await agent.prompt("test unlimited timers");
  assert.equal(toolCallbackRegistry.size, 0);
});

test("gateway request pins run contract in the system prompt", async (t) => {
  let payload: {
    messages?: Array<{ content?: string; role?: string }>;
    system_prompt?: string;
  } = {};
  mockGatewayRequest(t, (options) => {
    payload = JSON.parse(String(options.body)) as typeof payload;
    return { body: bodyFromText(`${JSON.stringify({ data: {}, type: "end" })}\n`) };
  });

  const unavailable = async () => {
    throw new Error("execution is not expected in this test");
  };
  const agent = createGatewayAgent({
    callbackUrl: "http://127.0.0.1:1/internal/tool-exec",
    config: { baseUrl: "http://127.0.0.1:1", dataDir: ".", model: "test" },
    enabledConnectorIds: [],
    executePython: unavailable,
    executeShell: unavailable,
    gatewayHistory: [{ role: "assistant", content: "prior summary" }],
    gatewayUrl: "http://127.0.0.1:1",
    runContract: "Original detailed user prompt that must survive compaction.",
    sessionId: "contract-test",
    workspaceRoot: ".",
  });

  await agent.prompt("continue");
  assert.match(payload.system_prompt ?? "", /<run_contract>/);
  assert.match(payload.system_prompt ?? "", /Original detailed user prompt that must survive compaction\./);
  assert.deepEqual(payload.messages, [
    { role: "assistant", content: "prior summary" },
    { role: "user", content: "continue" },
  ]);
});

test("gateway turn deadline still bounds a continuously active stream", async (t) => {
  mockGatewayRequest(t, (options) => {
    const signal = options.signal as AbortSignal | undefined;
    return { body: bodyFromStream(new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const interval = setInterval(() => {
          controller.enqueue(encoder.encode(`${JSON.stringify({
            data: { content: ".", id: "long-turn", type: "ai" },
            type: "messages-tuple",
          })}\n`));
        }, 5);
        signal?.addEventListener("abort", () => {
          clearInterval(interval);
          controller.error(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      },
    })) };
  });

  const unavailable = async () => {
    throw new Error("execution is not expected in this test");
  };
  const agent = createGatewayAgent({
    callbackUrl: "http://127.0.0.1:1/internal/tool-exec",
    config: { baseUrl: "http://127.0.0.1:1", dataDir: ".", model: "test" },
    enabledConnectorIds: [],
    executePython: unavailable,
    executeShell: unavailable,
    gatewayUrl: "http://127.0.0.1:1",
    runIdleTimeoutMs: 200,
    runTimeoutMs: 50,
    sessionId: "turn-timeout-test",
    workspaceRoot: ".",
  });

  await assert.rejects(agent.prompt("test turn timeout"), /Agent run timeout: gateway turn exceeded 50 ms/);
  assert.equal(toolCallbackRegistry.size, 0);
});

test("external tool waits pause the active gateway deadline", async (t) => {
  mockGatewayRequest(t, (options) => {
    const signal = options.signal as AbortSignal | undefined;
    return { body: bodyFromStream(new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener("abort", () => {
          controller.error(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      },
    })) };
  });
  const unavailable = async () => {
    throw new Error("execution is not expected in this test");
  };
  const agent = createGatewayAgent({
    callbackUrl: "http://127.0.0.1:1/internal/tool-exec",
    config: { baseUrl: "http://127.0.0.1:1", dataDir: ".", model: "test" },
    enabledConnectorIds: [],
    executePython: unavailable,
    executeShell: unavailable,
    gatewayUrl: "http://127.0.0.1:1",
    runTimeoutMs: 30,
    sessionId: "paused-timeout-test",
    workspaceRoot: ".",
  });
  const startedAt = Date.now();
  const prompt = agent.prompt("test paused timeout");
  await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  const release = agent.beginExternalWait();
  let settled = false;
  void prompt.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  assert.equal(settled, false);
  release();
  await assert.rejects(prompt, /Agent run timeout: gateway turn exceeded 30 ms/);
  assert.ok(Date.now() - startedAt >= 70);
  assert.equal(toolCallbackRegistry.size, 0);
});

test("gateway usage is normalized into an agent event", async (t) => {
  mockGatewayRequest(t, () => ({ body: bodyFromText(
    `${JSON.stringify({
      data: { usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 } },
      type: "end",
    })}\n`,
  ) }));
  const unavailable = async () => {
    throw new Error("execution is not expected in this test");
  };
  const agent = createGatewayAgent({
    callbackUrl: "http://127.0.0.1:1/internal/tool-exec",
    config: { baseUrl: "http://127.0.0.1:1", dataDir: ".", model: "test" },
    enabledConnectorIds: [],
    executePython: unavailable,
    executeShell: unavailable,
    gatewayUrl: "http://127.0.0.1:1",
    sessionId: "usage-test",
    workspaceRoot: ".",
  });
  let usage: SubagentUsage | undefined;
  agent.subscribe((event) => {
    if (event.type === "usage") usage = event.usage;
  });

  await agent.prompt("test usage");

  assert.deepEqual(usage, {
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inputTokens: 120,
    outputTokens: 30,
    totalTokens: 150,
  });
});

test("tool callback warns and hard-stops repeated identical tool calls", async (t) => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  mockGatewayRequest(t, () => ({ body: bodyFromStream(new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  })) }));
  let executedPython = 0;
  const agent = createGatewayAgent({
    callbackUrl: "http://127.0.0.1:1/internal/tool-exec",
    config: { baseUrl: "http://127.0.0.1:1", dataDir: ".", model: "test" },
    enabledConnectorIds: [],
    executePython: async () => {
      executedPython += 1;
      return successfulPythonResult();
    },
    executeShell: async () => {
      throw new Error("shell is not expected in this test");
    },
    gatewayUrl: "http://127.0.0.1:1",
    sessionId: "loop-detection-test",
    workspaceRoot: ".",
  });

  const prompt = agent.prompt("test loop detection");
  const callback = await waitForToolCallback();
  const results = [];
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const args = attempt === 2
      ? { metadata: { b: 2, a: 1 }, code: "print(1)" }
      : { code: "print(1)", metadata: { a: 1, b: 2 } };
    results.push(await callback("run_python", args, `loop-${attempt}`));
  }

  assert.equal(results[0]?.isError, false);
  assert.match(results[0]?.content ?? "", /stdout:\nok/);
  assert.equal(results[8]?.isError, false);
  assert.match(results[8]?.content ?? "", /stdout:\nok/);
  assert.equal(executedPython, 9);
  assert.equal(results[9]?.isError, false);
  assert.equal(JSON.parse(results[9]!.content).warning.code, "REPEATED_TOOL_CALL");
  assert.equal(JSON.parse(results[18]!.content).warning.count, 19);
  assert.equal(results[19]?.isError, true);
  assert.equal(JSON.parse(results[19]!.content).error.code, "TOOL_LOOP_DETECTED");
  assert.equal(executedPython, 9);

  controller?.enqueue(encoder.encode(`${JSON.stringify({ data: {}, type: "end" })}\n`));
  controller?.close();
  await prompt;
  assert.equal(toolCallbackRegistry.size, 0);
});

test("abort requested before execute still cancels the gateway run", async (t) => {
  mockGatewayRequest(t, (options) => {
    assert.equal((options.signal as AbortSignal | undefined)?.aborted, true);
    throw new DOMException("Aborted", "AbortError");
  });
  const unavailable = async () => {
    throw new Error("execution is not expected in this test");
  };
  const agent = createGatewayAgent({
    callbackUrl: "http://127.0.0.1:1/internal/tool-exec",
    config: { baseUrl: "http://127.0.0.1:1", dataDir: ".", model: "test" },
    enabledConnectorIds: [],
    executePython: unavailable,
    executeShell: unavailable,
    gatewayUrl: "http://127.0.0.1:1",
    sessionId: "pre-abort-test",
    workspaceRoot: ".",
  });

  agent.abort();

  await assert.rejects(agent.prompt("must not run"), /Agent run cancelled/);
});
