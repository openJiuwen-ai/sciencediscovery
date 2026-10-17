// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
// Test-only loopback proxy. Point SCIENCE_AGENT_ADAPTER_PUBLIC_URL here on an
// isolated stack; never install this between a user deployment and its tools.
import { createServer, request as httpRequest } from "node:http";

const port = Number(process.env.E2E_MCP_PROXY_PORT ?? 4685);
const target = new URL(process.env.E2E_MCP_PROXY_TARGET ?? "http://127.0.0.1:4680");
if (target.hostname !== "127.0.0.1" || target.protocol !== "http:") throw new Error("Loopback HTTP target required");
const injected = new Set();
const server = createServer(async (incoming, outgoing) => {
  if (incoming.url === "/health" && incoming.method === "GET") {
    outgoing.writeHead(204);
    outgoing.end();
    return;
  }
  const chunks = [];
  try {
    for await (const chunk of incoming) chunks.push(chunk);
  } catch (error) {
    // A cancelled MCP request can close its socket while the body is being
    // read. The fixture must survive so later journeys can still use it.
    if (error?.code === "ECONNRESET") return;
    throw error;
  }
  const body = Buffer.concat(chunks);
  if (incoming.url?.startsWith("/mcp/") && incoming.method === "POST") {
    try {
      const message = JSON.parse(body.toString());
      const command = message.params?.arguments?.command;
      const key = `${message.params?.arguments?._sd_run}:${command}`;
      if (message.method === "tools/call" && typeof command === "string"
        && (command.startsWith("printf 'E2E_MCP_HTTP_503_") || command.startsWith("printf 'E2E_MCP_DISCONNECT_")) && !injected.has(key)) {
        injected.add(key);
        if (command.startsWith("printf 'E2E_MCP_DISCONNECT_")) { outgoing.destroy(); return; }
        outgoing.writeHead(503, { "content-type": "text/plain" });
        outgoing.end("Controlled E2E MCP request failure; no tool dispatched");
        return;
      }
    } catch { /* Forward malformed input unchanged. */ }
  }
  const destination = new URL(incoming.url, target);
  if (destination.origin !== target.origin) {
    outgoing.writeHead(400);
    outgoing.end("Only the fixed loopback target is allowed");
    return;
  }
  const upstream = httpRequest(destination, {
    method: incoming.method, headers: { ...incoming.headers, host: target.host },
  }, response => {
    outgoing.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(outgoing);
    response.on("error", () => outgoing.destroy());
  });
  upstream.on("error", () => {
    if (!outgoing.headersSent) outgoing.writeHead(502);
    outgoing.end();
  });
  outgoing.on("close", () => { if (!outgoing.writableEnded) upstream.destroy(); });
  upstream.end(body);
});
server.listen(port, "127.0.0.1", () => console.log(`MCP fault fixture listening on 127.0.0.1:${port}`));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
  server.close();
  server.closeAllConnections();
});
