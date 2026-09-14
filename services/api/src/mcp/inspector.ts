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

import { randomUUID } from "node:crypto";
import type { JsonValue, McpInspectorRequest, McpInspectorResult } from "@sciencediscovery/schema";
import { McpInvocationError, type McpGovernanceBroker } from "@sciencediscovery/data-source";
import type { McpSourceRegistry } from "@sciencediscovery/mcp-sources";
import type { SessionStore } from "../store.js";
import type { CustomMcpServers } from "./custom-servers.js";

export async function inspectMcpTool(
  id: string,
  body: McpInspectorRequest,
  dependencies: { servers: CustomMcpServers; registry: McpSourceRegistry; broker: McpGovernanceBroker; store: SessionStore },
  signal?: AbortSignal,
): Promise<McpInspectorResult> {
  if (!body || typeof body.sessionId !== "string" || typeof body.toolName !== "string") throw new Error("sessionId and toolName are required");
  const server = dependencies.servers.list().find((item) => item.id === id);
  if (!server) throw new Error("MCP server not found");
  if (!server.enabled) throw new Error("Enable the MCP server before invoking a tool");
  const session = dependencies.store.getSession(body.sessionId);
  if (!session) throw new Error("Session not found");
  const tool = Object.values(dependencies.registry.get(id).manifest.tools).find((item) => item.mcpToolName === body.toolName);
  if (!tool) throw new Error("MCP tool not found; test the connection to refresh tools");
  const started = Date.now();
  try {
    const response = await dependencies.broker.invoke({
      // This authenticated, explicit manual call authorizes only the selected
      // server. It does not change the Session's Agent connector selection.
      allowedSourceIds: [id],
      input: body.input,
      projectId: session.projectId,
      sessionId: session.id,
      sourceId: id,
      toolId: tool.id,
      toolCallId: `inspector-${randomUUID()}`,
      turnId: `mcp-inspector-${randomUUID()}`,
      signal,
    });
    const raw = response.invocation.rawResponse
      ? JSON.parse((await dependencies.broker.cas.read(response.invocation.rawResponse.hash)).toString("utf8")) as JsonValue
      : undefined;
    return { ok: true, invocationId: response.invocation.id, durationMs: Date.now() - started, result: response.result, ...(raw !== undefined ? { raw } : {}) };
  } catch (error) {
    if (!(error instanceof McpInvocationError)) throw error;
    const raw = error.invocation.rawResponse
      ? JSON.parse((await dependencies.broker.cas.read(error.invocation.rawResponse.hash)).toString("utf8")) as JsonValue
      : undefined;
    return { ok: false, invocationId: error.invocation.id, durationMs: Date.now() - started, error: error.message, ...(raw !== undefined ? { raw } : {}) };
  }
}
