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
import { sendError, sendJson } from "./response.js";

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
      const match = url.pathname.match(/^\/api\/mcp\/servers\/(custom-[a-f0-9]{12})(\/test|\/inspect)?$/);
      if (!match) sendError(response, 404, "MCP endpoint not found");
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
