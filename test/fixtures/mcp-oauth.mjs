// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../services/api/package.json", import.meta.url));
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { SSEServerTransport } = require("@modelcontextprotocol/sdk/server/sse.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");

// Deterministic loopback identity provider and real MCP transport, never a vendor account.
export async function startOAuthFixture({ transport = "http", expiresIn = 3600, registration = true } = {}) {
  let origin;
  let mcpUrl;
  let stepUp = false;
  let delayToken;
  const clients = new Map([["fixture-client", { client_id: "fixture-client", client_secret: "fixture-client-secret" }]]);
  const codes = new Map();
  const tokens = new Set();
  const refreshTokens = new Set();
  const sessions = new Map();
  const connections = new Set();
  const counts = { registrations: 0, exchanges: 0, refreshes: 0, tools: 0, pkce: 0 };
  const json = (response, status, body) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  const body = async (request) => { let result = ""; for await (const chunk of request) result += chunk; return result; };
  const makeMcp = () => {
    const server = new Server({ name: "oauth-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo", description: "Local OAuth echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      counts.tools++;
      return { content: [{ type: "text", text: `OAUTH: ${params.arguments.text}` }] };
    });
    connections.add(server);
    return server;
  };
  const http = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, origin);
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return json(response, 200, { resource: mcpUrl, authorization_servers: [origin], scopes_supported: ["tools:read"] });
      if (url.pathname === "/.well-known/oauth-authorization-server") return json(response, 200, {
        issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
        ...(registration ? { registration_endpoint: `${origin}/register` } : {}),
        response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post"], code_challenge_methods_supported: ["S256"],
      });
      if (url.pathname === "/register" && registration) {
        const metadata = JSON.parse(await body(request));
        const client = { ...metadata, client_id: randomUUID() };
        clients.set(client.client_id, client); counts.registrations++;
        return json(response, 201, client);
      }
      if (url.pathname === "/authorize" || url.pathname === "/approve" || url.pathname === "/deny") {
        const params = url.searchParams;
        const client = clients.get(params.get("client_id"));
        if (!client || params.get("code_challenge_method") !== "S256" || !params.get("code_challenge") || params.get("resource") !== mcpUrl
          || (client.redirect_uris && !client.redirect_uris.includes(params.get("redirect_uri")))) return json(response, 400, { error: "invalid_request" });
        if (url.pathname === "/authorize") {
          const query = params.toString().replaceAll("&", "&amp;");
          response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Local MCP consent</title><h1>Local MCP consent</h1><a href="/approve?${query}">Allow test access</a><br><a href="/deny?${query}">Deny</a>`);
          return;
        }
        const callback = new URL(params.get("redirect_uri"));
        callback.searchParams.set("state", params.get("state"));
        if (url.pathname === "/deny") callback.searchParams.set("error", "access_denied");
        else { const code = randomUUID(); codes.set(code, params); callback.searchParams.set("code", code); }
        response.writeHead(302, { Location: callback.toString() }).end();
        return;
      }
      if (url.pathname === "/token") {
        const params = new URLSearchParams(await body(request));
        const client = clients.get(params.get("client_id"));
        if (!client || (client.client_secret && client.client_secret !== params.get("client_secret"))) return json(response, 401, { error: "invalid_client" });
        if (params.get("resource") !== mcpUrl) return json(response, 400, { error: "invalid_target" });
        if (params.get("grant_type") === "authorization_code") {
          const code = codes.get(params.get("code")); codes.delete(params.get("code"));
          if (!code || code.get("client_id") !== params.get("client_id") || code.get("redirect_uri") !== params.get("redirect_uri")
            || createHash("sha256").update(params.get("code_verifier") ?? "").digest("base64url") !== code.get("code_challenge")) return json(response, 400, { error: "invalid_grant" });
          counts.exchanges++; counts.pkce++;
        } else if (params.get("grant_type") === "refresh_token") {
          if (!refreshTokens.delete(params.get("refresh_token"))) return json(response, 400, { error: "invalid_grant" });
          counts.refreshes++;
        } else return json(response, 400, { error: "unsupported_grant_type" });
        if (delayToken) await delayToken;
        const token = randomUUID(); const refresh = randomUUID();
        tokens.add(token); refreshTokens.add(refresh);
        return json(response, 200, { access_token: token, refresh_token: refresh, token_type: "Bearer", expires_in: expiresIn, scope: "tools:read" });
      }
      if (["/mcp", "/sse", "/messages"].includes(url.pathname)) {
        if (!tokens.has(request.headers.authorization?.replace(/^Bearer /, ""))) {
          response.writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="tools:read"` }).end(); return;
        }
        if (stepUp) { response.writeHead(403, { "WWW-Authenticate": 'Bearer error="insufficient_scope", scope="tools:write"' }).end(); return; }
        if (transport === "sse") {
          if (url.pathname === "/sse" && request.method === "GET") {
            const wire = new SSEServerTransport("/messages", response);
            const server = makeMcp(); sessions.set(wire.sessionId, wire);
            response.on("close", () => { sessions.delete(wire.sessionId); connections.delete(server); void server.close(); });
            await server.connect(wire);
          } else {
            const wire = sessions.get(url.searchParams.get("sessionId"));
            if (!wire) return json(response, 404, {});
            await wire.handlePostMessage(request, response);
          }
        } else {
          const wire = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          const server = makeMcp();
          response.on("close", () => { connections.delete(server); void wire.close(); void server.close(); });
          await server.connect(wire); await wire.handleRequest(request, response);
        }
        return;
      }
      json(response, 404, {});
    } catch { if (!response.headersSent) json(response, 500, { error: "fixture_failure" }); else response.end(); }
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${http.address().port}`;
  mcpUrl = `${origin}/${transport === "sse" ? "sse" : "mcp"}`;
  return {
    origin, mcpUrl, counts,
    expire: () => tokens.clear(), revokeRefresh: () => refreshTokens.clear(),
    setStepUp: (value) => { stepUp = value; },
    setTokenDelay: (promise) => { delayToken = promise; },
    setExpiresIn: (seconds) => { expiresIn = seconds; },
    close: async () => { for (const server of connections) await server.close(); http.closeAllConnections(); await new Promise((resolve) => http.close(resolve)); },
  };
}
