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

import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpInspectorRequest } from "@sciencediscovery/schema";
import { inspectMcpTool } from "../mcp/inspector.js";
import type { CustomMcpServers } from "../mcp/custom-servers.js";
import { MCP_OAUTH_CALLBACK } from "../mcp/oauth.js";
import { send, sendError, sendJson } from "./response.js";

export async function handleMcpOAuthCallback(request: IncomingMessage, response: ServerResponse, url: URL, servers: CustomMcpServers): Promise<boolean> {
  if (url.pathname !== MCP_OAUTH_CALLBACK) return false;
  let success = false;
  if (request.method === "GET") {
    try {
      const id = await servers.oauth.complete(url.searchParams.get("state") ?? "", url.searchParams.get("code"), url.searchParams.has("error"));
      success = true;
      // Catalog refresh may involve other servers; don't hold the browser callback open.
      void servers.test(id).catch(() => undefined);
    } catch { /* Provider text and authorization codes must not appear in the callback page. */ }
  }
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  response.setHeader("Referrer-Policy", "no-referrer");
  send(response, success ? 200 : 400, "text/html; charset=utf-8", `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>MCP OAuth</title><h1>${success ? "Authorization complete" : "Authorization failed"}</h1><p>${success ? "Return to ScienceDiscovery. You can close this window." : "Return to MCP settings and try signing in again."}</p></html>`);
  return true;
}

export async function handleCustomMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  servers: CustomMcpServers,
  readBody: () => Promise<unknown>,
  inspector: Omit<Parameters<typeof inspectMcpTool>[2], "servers">,
): Promise<boolean> {
  const root = "/api/mcp/servers";
  if (url.pathname !== root && !url.pathname.startsWith(`${root}/`)) return false;
  try {
    if (url.pathname === root && request.method === "GET") sendJson(response, 200, servers.list());
    else if (url.pathname === root && request.method === "POST") sendJson(response, 201, await servers.save(await readBody()));
    else if (url.pathname === `${root}/import` && request.method === "POST") sendJson(response, 201, await servers.import(await readBody()));
    else {
      const match = url.pathname.match(/^\/api\/mcp\/servers\/(custom-[a-f0-9]{12})(\/test|\/inspect|\/oauth\/start|\/oauth\/cancel|\/oauth\/clear)?$/);
      if (!match) sendError(response, 404, "MCP endpoint not found");
      else if (match[2]?.startsWith("/oauth/") && request.method === "POST") {
        const id = match[1]!;
        if (!servers.list().some((item) => item.id === id)) throw new Error("MCP server not found");
        if (match[2] === "/oauth/start") {
          const body = await readBody() as { redirectUrl?: unknown } | null;
          if (typeof body?.redirectUrl !== "string") throw new Error("OAuth callback URL is required");
          const callback = new URL(body.redirectUrl);
          const origin = request.headers.origin ?? `${"encrypted" in request.socket && request.socket.encrypted ? "https" : "http"}://${request.headers.host}`;
          if (callback.origin !== origin) throw new Error("OAuth callback must use this browser's application origin");
          sendJson(response, 200, await servers.oauth.begin(id, callback.toString()));
        } else {
          if (match[2] === "/oauth/clear") { await servers.oauth.clear(id); await servers.test(id); }
          else servers.oauth.cancel(id);
          sendJson(response, 200, { ok: true });
        }
      }
      else if (match[2] === "/test" && request.method === "POST") sendJson(response, 200, await servers.test(match[1]!));
      else if (match[2] === "/inspect" && request.method === "POST") {
        const controller = new AbortController();
        const abort = () => { if (!response.writableEnded) controller.abort(); };
        response.on("close", abort);
        try {
          sendJson(response, 200, await inspectMcpTool(match[1]!, await readBody() as McpInspectorRequest, { ...inspector, servers }, controller.signal));
        } finally { response.off("close", abort); }
      }
      else if (!match[2] && request.method === "PUT") sendJson(response, 200, await servers.save(await readBody(), match[1]!));
      else if (!match[2] && request.method === "DELETE") {
        await servers.remove(match[1]!);
        sendJson(response, 200, { deleted: true });
      } else sendError(response, 405, "Method not allowed");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "MCP configuration failed";
    sendError(response, message === "MCP server not found" ? 404 : 400, message);
  }
  return true;
}
