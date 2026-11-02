// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { McpInvokeRequest } from "@sciencediscovery/schema";
import type { OperationalLogger } from "@sciencediscovery/operational-logging";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import type { ExtensionsConfigFile, McpServerEntry } from "./extensions-config.js";
import { McpNodeClient } from "./node-client.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
async function fixture(context: { after(action: () => Promise<void>): void }) {
  const state = { initializations: 0, deletes: 0, calls: 0 };
  let release = () => {}, enter = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { enter = resolve; });
  const http = createServer(async (request, response) => {
    if (request.method === "DELETE") { state.deletes++; response.writeHead(200); response.end(); return; }
    if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
    let raw = ""; for await (const part of request) { raw += String(part); } const rpc = JSON.parse(raw);
    if (rpc.id === undefined) { response.writeHead(202); response.end(); return; }
    let result: unknown;
    if (rpc.method === "initialize") { state.initializations++; result = { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "Owned deadline fixture", version: "1" } }; }
    else if (rpc.method === "tools/list") { result = { tools: [{ name: "owned_wait", inputSchema: { type: "object" } }] }; }
    else if (rpc.method === "tools/call") { state.calls++; enter(); await gate; result = { content: [{ type: "text", text: "Owned wait completed" }] }; }
    else { response.writeHead(400); response.end(); return; }
    if (!response.destroyed) { response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "owned-timeout-session" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })); }
  }); await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve)); const address = http.address(); assert.ok(address && typeof address !== "string");
  let server: McpServerEntry & { timeoutSeconds: number } = { transport: "http", description: "Owned", enabled: true, url: `http://127.0.0.1:${address.port}/mcp`, args: [], env: {}, headers: {}, timeoutSeconds: 4, toolCallTimeoutSeconds: 4, routing: { mode: "off", priority: 0, keywords: [] }, toolOverrides: {} };
  const config: ExtensionsConfigFile = { path: undefined, signature: "owned", servers: { owned: server } }, logger: OperationalLogger = { path: "owned-memory", debug() {}, info() {}, warn() {}, error() {} }, client = new McpNodeClient(() => config, undefined, logger);
  context.after(async () => { release(); await client.close(); await new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }); });
  const change = (seconds: number) => { server = { ...server, timeoutSeconds: seconds, toolCallTimeoutSeconds: seconds }; config.servers.owned = server; };
  const invoke = (id: string, timeoutMs = 4_000) => client.invoke({ arguments: {}, context: { projectId: "owned", sessionId: "owned", toolCallId: id, turnId: "owned" }, execution: { timeoutMs, retryPolicy: { initialDelayMs: 0, jitterRatio: 0, maxAttempts: 1, maxDelayMs: 0, multiplier: 1, respectRetryAfter: false, retryOn: [] } }, requestId: id, serverId: "owned", toolName: "owned_wait" } satisfies McpInvokeRequest);
  return { state, client, change, invoke, entered, release };
}

test("CFG-X03b: a new short deadline affects the next actual HTTP call without closing an admitted call", async context => {
  const h = await fixture(context); await h.client.catalog(); const old = h.invoke("old");
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([h.entered, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Owned call did not enter")), 3_000); })]).finally(() => clearTimeout(timer));
  h.change(1); const next = await h.invoke("new"); assert.equal(next.isError, true); assert.equal(next.attempts[0]?.status, "timeout"); assert.equal(next.attempts.length, 1); assert.equal(h.state.initializations, 1); assert.equal(h.state.deletes, 0);
  h.release(); const original = await old; assert.equal(original.isError, false); assert.equal(original.content[0]?.type, "text"); assert.ok(original.durationMs >= 900); assert.equal(h.state.calls, 2);
});

test("CFG-X03b: a new longer server timeout cannot widen the earlier broker invocation deadline", async context => {
  const h = await fixture(context); await h.client.catalog(); h.change(5); const result = await h.invoke("broker-short", 100); assert.equal(result.isError, true); assert.equal(result.attempts[0]?.status, "timeout"); assert.equal(h.state.initializations, 1); assert.equal(h.state.calls, 1);
});
