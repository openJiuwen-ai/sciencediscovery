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
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { LogFields, OperationalLogger } from "@sciencediscovery/operational-logging";
import type { McpInvokeRequest, ResolvedProxy } from "@sciencediscovery/schema";

import { effectiveRouting, loadExtensionsConfig } from "./extensions-config.js";
import { McpNodeClient, proxyEnvOverlay, resolveMcpPython } from "./node-client.js";

const SDK_SERVER = import.meta.resolve("@modelcontextprotocol/sdk/server/index.js");
const SDK_STDIO = import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js");
const SDK_TYPES = import.meta.resolve("@modelcontextprotocol/sdk/types.js");

/** A real stdio MCP server (official SDK, low-level API — no extra deps). */
const ECHO_SERVER_SOURCE = `
import { Server } from "${SDK_SERVER}";
import { StdioServerTransport } from "${SDK_STDIO}";
import { CallToolRequestSchema, ListToolsRequestSchema } from "${SDK_TYPES}";

const server = new Server({ name: "echo", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (process.env.MCP_TEST_CATALOG_FAILURE === "1") {
    console.error("catalog stderr marker Authorization: Bearer catalog-secret");
    throw new Error("catalog failed");
  }
  return {
    tools: [{
      name: "echo_upper",
      description: "Uppercase the input text",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    }],
  };
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const text = String(request.params.arguments?.text ?? "");
  if (text === "explode") return { content: [{ type: "text", text: "synthetic failure" }], isError: true };
  return {
    content: [{ type: "text", text: text.toUpperCase() }],
    structuredContent: { upper: text.toUpperCase() },
  };
});
await server.connect(new StdioServerTransport());
`;

function invokeRequest(args: Record<string, unknown>): McpInvokeRequest {
  return {
    arguments: args as never,
    context: { projectId: "p", sessionId: "s", toolCallId: "t", turnId: "turn" },
    execution: {
      retryPolicy: { initialDelayMs: 10, jitterRatio: 0, maxAttempts: 2, maxDelayMs: 100, multiplier: 2, respectRetryAfter: true, retryOn: ["transport-error"] },
      timeoutMs: 20_000,
    },
    requestId: "req-1",
    serverId: "echo",
    toolName: "echo_upper",
  };
}

interface RecordedLog {
  event: string;
  fields: LogFields;
  level: "debug" | "info" | "warn" | "error";
}

function recordingLogger(): { events: RecordedLog[]; logger: OperationalLogger } {
  const events: RecordedLog[] = [];
  const record = (level: RecordedLog["level"]) => (event: string, fields: LogFields = {}) => {
    events.push({ event, fields: structuredClone(fields), level });
  };
  return {
    events,
    logger: {
      path: "",
      debug: record("debug"),
      error: record("error"),
      info: record("info"),
      warn: record("warn"),
    },
  };
}

function fixtureClient(logger?: OperationalLogger, env: Record<string, string> = {}): { client: McpNodeClient; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "mcp-node-"));
  const serverPath = join(dir, "echo-server.mjs");
  writeFileSync(serverPath, ECHO_SERVER_SOURCE);
  const configPath = join(dir, "extensions_config.json");
  writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      echo: {
        args: [serverPath],
        command: process.execPath,
        description: "Echo server",
        enabled: true,
        env,
        routing: { keywords: ["echo"], mode: "prefer", priority: 7 },
        type: "stdio",
      },
    },
  }));
  const client = new McpNodeClient(() => loadExtensionsConfig(configPath), undefined, logger);
  return { client, dir };
}

test("catalog lists tools from a real stdio server with routing annotations", async () => {
  const { client } = fixtureClient();
  try {
    const catalog = await client.catalog();
    assert.equal(catalog.servers.length, 1);
    const server = catalog.servers[0]!;
    assert.equal(server.id, "echo");
    assert.equal(server.transport, "stdio");
    const tool = server.tools.find((item) => item.name === "echo_upper");
    assert(tool);
    assert.equal((tool.annotations?.routing as { priority: number }).priority, 7);
    assert.equal(tool.inputSchema.type, "object");
    assert.match(tool.schemaHash, /^[0-9a-f]{64}$/);
  } finally {
    await client.close();
  }
});

test("connection lifecycle records server and proxy metadata without credentials", async () => {
  const recorded = recordingLogger();
  const { client } = fixtureClient(recorded.logger);
  try {
    await client.reload({
      echo: {
        mode: "url",
        url: "http://proxy-user:proxy-password@proxy.example.test:8080/private?token=secret",
      },
    });
    const started = recorded.events.find((entry) => entry.event === "mcp_connection_started");
    assert(started);
    assert.equal(started.level, "info");
    assert.equal(started.fields.serverId, "echo");
    assert.equal(started.fields.transport, "stdio");
    assert.equal(started.fields.proxyMode, "url");
    assert.equal(started.fields.proxyHost, "proxy.example.test:8080");
    assert.equal(started.fields.proxyApplied, true);
    assert.ok(recorded.events.some((entry) => entry.event === "mcp_connection_succeeded"));
    assert.ok(recorded.events.some((entry) => entry.event === "mcp_catalog_loaded"));
    const serialized = JSON.stringify(recorded.events);
    assert.doesNotMatch(serialized, /proxy-user|proxy-password|token=secret|\/private/);
  } finally {
    await client.close();
  }
  assert.ok(recorded.events.some((entry) => entry.event === "mcp_connection_closed"
    && entry.fields.reason === "shutdown"));
});

test("catalog failures include a bounded redacted stdio stderr tail", async () => {
  const recorded = recordingLogger();
  const { client } = fixtureClient(recorded.logger, { MCP_TEST_CATALOG_FAILURE: "1" });
  try {
    const catalog = await client.catalog();
    assert.match(catalog.servers[0]?.error ?? "", /catalog failed/);
    const failed = recorded.events.find((entry) => entry.event === "mcp_catalog_server_failed");
    assert(failed);
    assert.match(String(failed.fields.stderrTail), /catalog stderr marker/);
    assert.doesNotMatch(JSON.stringify(failed), /catalog-secret/);
  } finally {
    await client.close();
  }
});

test("invoke round-trips content and structured content", async () => {
  const { client } = fixtureClient();
  try {
    const response = await client.invoke(invokeRequest({ text: "abc" }));
    assert.equal(response.isError, false);
    assert.deepEqual(response.content, [{ text: "ABC", type: "text" }]);
    assert.deepEqual(response.structuredContent, { upper: "ABC" });
    assert.equal(response.attempts.at(-1)?.status, "succeeded");

    // Parallel invocations share the session safely.
    const [first, second] = await Promise.all([
      client.invoke({ ...invokeRequest({ text: "one" }), requestId: "req-2" }),
      client.invoke({ ...invokeRequest({ text: "two" }), requestId: "req-3" }),
    ]);
    assert.deepEqual(first.content, [{ text: "ONE", type: "text" }]);
    assert.deepEqual(second.content, [{ text: "TWO", type: "text" }]);
  } finally {
    await client.close();
  }
});

test("a tool-reported error surfaces as a failed invocation with attempts", async () => {
  const { client } = fixtureClient();
  try {
    const response = await client.invoke(invokeRequest({ text: "explode" }));
    assert.equal(response.isError, true);
    assert.match(String(response.content[0] && "text" in response.content[0] ? response.content[0].text : ""), /synthetic failure/);
    assert.equal(response.attempts.at(-1)?.status, "semantic-error");
  } finally {
    await client.close();
  }
});

test("unknown server rejects with a 404-tagged error", async () => {
  const { client } = fixtureClient();
  try {
    await assert.rejects(
      () => client.invoke({ ...invokeRequest({ text: "x" }), serverId: "missing" }),
      (error: Error & { statusCode?: number }) => error.statusCode === 404,
    );
  } finally {
    await client.close();
  }
});

test("extensions config parses env placeholders, aliases, and routing overrides", () => {
  const dir = mkdtempSync(join(tmpdir(), "ext-config-"));
  const path = join(dir, "extensions_config.json");
  process.env.MCP_TEST_TOKEN = "sekrit";
  writeFileSync(path, JSON.stringify({
    mcpServers: {
      remote: {
        transport: "streamable_http",
        url: "http://example.test/mcp",
        headers: { authorization: "$MCP_TEST_TOKEN" },
        routing: { mode: "prefer", priority: 999, keywords: ["k"] },
        tools: { special: { routing: { mode: "prefer", priority: 5, keywords: ["s"] } } },
      },
      disabled: { command: "python", enabled: false },
    },
  }));
  const config = loadExtensionsConfig(path);
  const remote = config.servers.remote!;
  assert.equal(remote.transport, "http");
  assert.equal(remote.headers.authorization, "sekrit");
  assert.equal(remote.routing.priority, 100); // clamped
  assert.equal(effectiveRouting(remote, "special")!.priority, 5);
  assert.equal(effectiveRouting(remote, "other")!.priority, 100);
  assert.equal(config.servers.disabled!.enabled, false);
  delete process.env.MCP_TEST_TOKEN;
});

test("a dead server is classified as a transport error and retried per policy", async () => {
  // Replaces the deleted gateway-client transport tests: the failure modes that
  // used to be HTTP concerns now surface through the in-process client, so the
  // retry/classification contract is pinned on the real code path.
  const dir = mkdtempSync(join(tmpdir(), "mcp-node-dead-"));
  const serverPath = join(dir, "dies.mjs");
  writeFileSync(serverPath, 'console.error("Authorization: Bearer stderr-secret password=hidden"); process.exit(1);\n');
  const configPath = join(dir, "extensions_config.json");
  writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      echo: { args: [serverPath], command: process.execPath, enabled: true, type: "stdio" },
    },
  }));
  const recorded = recordingLogger();
  const client = new McpNodeClient(() => loadExtensionsConfig(configPath), undefined, recorded.logger);
  try {
    const response = await client.invoke(invokeRequest({ text: "abc" }));
    assert.equal(response.isError, true);
    // maxAttempts is 2 and retryOn includes transport-error, so both are tried.
    assert.equal(response.attempts.length, 2);
    for (const attempt of response.attempts) {
      assert.equal(attempt.status, "transport-error");
      assert.equal(attempt.errorCode, "TRANSPORT_ERROR");
    }
    // The failure text reaches the caller instead of being swallowed.
    assert.ok(response.content.some((block) => block.type === "text" && block.text.length > 0));
    assert.ok(recorded.events.some((entry) => entry.event === "mcp_connection_failed"));
    assert.ok(recorded.events.some((entry) => entry.event === "mcp_invocation_attempt_failed"
      && entry.fields.status === "transport-error"));
    assert.ok(recorded.events.some((entry) => entry.event === "mcp_invocation_retry_scheduled"));
    const serialized = JSON.stringify(recorded.events);
    assert.match(serialized, /stderrTail/);
    assert.match(serialized, /\[REDACTED\]/);
    assert.doesNotMatch(serialized, /stderr-secret|password=hidden/);
  } finally {
    await client.close();
  }
});

test("stdio proxy overlay follows the resolved policy", () => {
  // Adapted from the gateway's proxy-injection coverage: the same contract now
  // applies to the environment Node projects onto an MCP subprocess.
  const previous = { ...process.env };
  try {
    process.env.HTTPS_PROXY = "http://ambient.test:8080";
    process.env.NO_PROXY = "localhost";
    // "direct" must not leak the ambient proxy into the child.
    assert.deepEqual(proxyEnvOverlay({ mode: "direct" }), {});
    // "environment" copies what the process already has.
    assert.equal(proxyEnvOverlay({ mode: "environment" }).HTTPS_PROXY, "http://ambient.test:8080");
    // "url" pins every proxy variable while preserving NO_PROXY.
    const pinned = proxyEnvOverlay({ mode: "url", url: "http://pinned.test:3128" });
    assert.equal(pinned.HTTPS_PROXY, "http://pinned.test:3128");
    assert.equal(pinned.http_proxy, "http://pinned.test:3128");
    assert.equal(pinned.NO_PROXY, "localhost");
    assert.throws(() => proxyEnvOverlay({ mode: "url" } as ResolvedProxy), /requires a proxy URL/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test("bundled python MCP servers resolve to a configured interpreter", () => {
  assert.equal(resolveMcpPython({ SCIENCE_AGENT_GATEWAY_PYTHON_PATH: "/opt/py/bin/python" }), "/opt/py/bin/python");
  // With nothing configured and no provisioned environment, the bare command
  // is the documented last resort rather than a hard failure.
  assert.equal(resolveMcpPython({}), "python");
});
