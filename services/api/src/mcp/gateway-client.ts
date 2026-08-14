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

import type {
  JsonValue,
  McpCatalog,
  McpInvokeRequest,
  McpInvokeResponse,
  ResolvedProxy,
} from "@science-agent/schema";

const MAX_ERROR_BODY = 4_000;

async function responseError(response: Response): Promise<Error> {
  const body = (await response.text()).slice(0, MAX_ERROR_BODY);
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    if (typeof parsed.detail === "string") return new Error(`MCP gateway ${response.status}: ${parsed.detail}`);
  } catch {
    // Preserve the bounded raw body below.
  }
  return new Error(`MCP gateway ${response.status}: ${body || response.statusText}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseCatalog(value: unknown): McpCatalog {
  if (!isObject(value) || typeof value.revision !== "string" || typeof value.loadedAt !== "string"
    || !Array.isArray(value.servers)) {
    throw new Error("MCP gateway returned an invalid catalog");
  }
  return value as unknown as McpCatalog;
}

function parseInvokeResponse(value: unknown): McpInvokeResponse {
  if (!isObject(value) || typeof value.requestId !== "string" || typeof value.serverId !== "string"
    || typeof value.toolName !== "string" || typeof value.isError !== "boolean"
    || !Array.isArray(value.content) || !Array.isArray(value.attempts)) {
    throw new Error("MCP gateway returned an invalid invocation response");
  }
  return value as unknown as McpInvokeResponse;
}

export class McpGatewayClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) throw await responseError(response);
    return response;
  }

  async catalog(signal?: AbortSignal): Promise<McpCatalog> {
    const response = await this.request("/internal/mcp/catalog", { signal });
    return parseCatalog(await response.json());
  }

  async reload(proxies?: Record<string, ResolvedProxy>, signal?: AbortSignal): Promise<McpCatalog> {
    const response = await this.request("/internal/mcp/reload", {
      ...(proxies ? { body: JSON.stringify({ proxies }) } : {}),
      method: "POST",
      signal,
    });
    return parseCatalog(await response.json());
  }

  async invoke(request: McpInvokeRequest, signal?: AbortSignal): Promise<McpInvokeResponse> {
    const response = await this.request("/internal/mcp/invoke", {
      body: JSON.stringify(request),
      method: "POST",
      signal,
    });
    return parseInvokeResponse(await response.json());
  }
}

export function asMcpArguments(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MCP tool arguments must be a JSON object");
  }
  return value;
}
