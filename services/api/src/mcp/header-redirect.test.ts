// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { OperationalLogger } from "@sciencediscovery/operational-logging";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import type { ExtensionsConfigFile, McpServerEntry } from "./extensions-config.js";
import { McpNodeClient } from "./node-client.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
const logger: OperationalLogger = { path: "owned-memory", debug() {}, info() {}, warn() {}, error() {} };
async function fixture(context: { after(action: () => Promise<void>): void }, transport: "http" | "sse", redirect: "cross" | "same" | "none") {
  const key = "synthetic-owned-" + randomUUID(), state = { sourceRequests: 0, destinationRequests: 0, destinationGotKey: false, initializations: 0 }; let stream: ServerResponse | undefined;
  const destination = createServer((request, response) => { state.destinationRequests++; state.destinationGotKey ||= request.headers["x-api-key"] === key; response.writeHead(403); response.end(); });
  await new Promise<void>(resolve => destination.listen(0, "127.0.0.1", resolve)); const targetAddress = destination.address(); assert.ok(targetAddress && typeof targetAddress !== "string");
  const http = createServer(async (request, response) => {
    if (request.url === "/redirected") { state.destinationRequests++; state.destinationGotKey ||= request.headers["x-api-key"] === key; response.writeHead(403); response.end(); return; }
    state.sourceRequests++;
    if (redirect !== "none") { response.writeHead(307, { location: redirect === "cross" ? `http://127.0.0.1:${targetAddress.port}/redirected` : "/redirected" }); response.end(); return; }
    if (request.method === "GET" && transport === "sse") { response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }); stream = response; response.write("event: endpoint\ndata: /messages\n\n"); return; }
    if (request.method !== "POST") { response.writeHead(request.method === "DELETE" ? 200 : 405); response.end(); return; }
    let raw = ""; for await (const part of request) { raw += String(part); } const rpc = JSON.parse(raw);
    if (rpc.id === undefined) { response.writeHead(202); response.end(); return; }
    let result: unknown;
    if (rpc.method === "initialize") { state.initializations++; result = { protocolVersion: rpc.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "Owned origin-bound fixture", version: "1" } }; }
    else if (rpc.method === "tools/list") { result = { tools: [] }; }
    else { response.writeHead(400); response.end(); return; }
    const answer = JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result });
    if (transport === "sse") { response.writeHead(202); response.end(); stream?.write(`event: message\ndata: ${answer}\n\n`); }
    else { response.writeHead(200, { "content-type": "application/json" }); response.end(answer); }
  }); await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve)); const address = http.address(); assert.ok(address && typeof address !== "string");
  const entry: McpServerEntry = { description: "Owned redirect boundary", transport, enabled: true, url: `http://127.0.0.1:${address.port}/${transport === "sse" ? "sse" : "mcp"}`, args: [], env: {}, headers: { "X-Api-Key": key }, toolCallTimeoutSeconds: 2, routing: { mode: "off", priority: 0, keywords: [] }, toolOverrides: {} };
  const config: ExtensionsConfigFile = { path: undefined, signature: "owned", servers: { owned: entry } }, client = new McpNodeClient(() => config, undefined, logger);
  context.after(async () => { await client.close(); stream?.end(); await Promise.all([http, destination].map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }))); });
  return { client, state };
}
for (const transport of ["http", "sse"] as const) {
  test(`CFG-XBUG-13: ${transport} cross-origin redirect must never forward the configured API-key header`, async context => {
    const h = await fixture(context, transport, "cross"), catalog = await h.client.catalog(); assert.ok(catalog.servers[0]?.error); assert.equal(h.state.destinationGotKey, false, "A redirected origin received the synthetic key"); assert.equal(h.state.destinationRequests, 0); assert.ok(h.state.sourceRequests > 0);
  });
  test(`CFG-XBUG-13: ${transport} same-origin direct requests still complete initialization and catalog`, async context => {
    const h = await fixture(context, transport, "none"), catalog = await h.client.catalog(); assert.equal(catalog.servers[0]?.error, undefined); assert.equal(h.state.initializations, 1); assert.equal(h.state.destinationRequests, 0);
  });
}
test("CFG-XBUG-13: redirects to another path require configuring the final URL, matching OAuth redirect policy", async context => {
  const h = await fixture(context, "http", "same"); assert.ok((await h.client.catalog()).servers[0]?.error); assert.equal(h.state.destinationRequests, 0);
});
