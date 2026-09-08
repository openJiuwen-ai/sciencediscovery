// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
// http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Local protocol fixture; never calls a model or an external service.
import { createRequire } from "node:module";
import { createServer } from "node:http";
const require = createRequire(new URL("../../services/api/package.json", import.meta.url));
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { SSEServerTransport } = require("@modelcontextprotocol/sdk/server/sse.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");

function makeServer() {
  const server = new Server({ name: "local-mcp-echo", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: "echo", description: "Return the supplied text in uppercase. A local connection test; no external calls.", inputSchema: { type: "object", properties: { text: { type: "string", description: "Text to uppercase" } }, required: ["text"], additionalProperties: false } },
    { name: "add_numbers", description: "Add two numbers and return the sum.", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"], additionalProperties: false } },
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (params.name === "echo") {
      const text = String(params.arguments?.text ?? "");
      if (text === "slow") await new Promise((resolve) => setTimeout(resolve, 2_000));
      if (text === "error") return { isError: true, content: [{ type: "text", text: "Requested fixture error" }] };
      return { content: [{ type: "text", text: text.toUpperCase() }], structuredContent: { echoed: text.toUpperCase() } };
    }
    if (params.name === "add_numbers") {
      const sum = Number(params.arguments?.a) + Number(params.arguments?.b);
      return { content: [{ type: "text", text: String(sum) }], structuredContent: { sum } };
    }
    return { isError: true, content: [{ type: "text", text: "Unknown tool" }] };
  });
  return server;
}

const mode = process.argv[2];
if (mode === "--http" || mode === "--sse") {
  const sessions = new Map();
  const http = createServer(async (request, response) => {
    try {
      if (process.env.MCP_FIXTURE_AUTH && request.headers.authorization !== process.env.MCP_FIXTURE_AUTH) { response.writeHead(401).end(); return; }
      if (mode === "--sse") {
        if (request.method === "GET" && request.url === "/sse") {
          const transport = new SSEServerTransport("/messages", response);
          const server = makeServer();
          sessions.set(transport.sessionId, transport);
          response.on("close", () => { sessions.delete(transport.sessionId); void server.close(); });
          await server.connect(transport);
        } else {
          const id = new URL(request.url, "http://localhost").searchParams.get("sessionId");
          const transport = sessions.get(id);
          if (!transport) { response.writeHead(404).end(); return; }
          await transport.handlePostMessage(request, response);
        }
      } else {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const server = makeServer();
        response.on("close", () => { void transport.close(); void server.close(); });
        await server.connect(transport);
        await transport.handleRequest(request, response);
      }
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  http.listen(Number(process.argv[3] ?? 0), "127.0.0.1", () => console.error(JSON.stringify({ port: http.address().port })));
} else {
  await makeServer().connect(new StdioServerTransport());
}
