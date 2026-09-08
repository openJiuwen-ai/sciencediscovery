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
  ConnectorManifest,
  CustomMcpServerDetails,
  CustomMcpServerInput,
  McpInspectorRequest,
  McpInspectorResult,
  McpSourceManifest,
  McpSourceStatus,
  UpdateWebSettingsRequest,
  WebSettingsDetails,
  WebUsageSummary,
  WorkbenchSearchResponse,
} from "@sciencediscovery/schema";

import { EvolveApiClient } from "./evolve.js";

export class WebApiClient extends EvolveApiClient {
  inspectMcpTool(id: string, body: McpInspectorRequest, signal?: AbortSignal): Promise<McpInspectorResult> {
    return this.request(`/api/mcp/servers/${encodeURIComponent(id)}/inspect`, { method: "POST", body: JSON.stringify(body), signal });
  }
  listMcpServers(): Promise<CustomMcpServerDetails[]> {
    return this.request("/api/mcp/servers");
  }

  saveMcpServer(body: CustomMcpServerInput, id?: string): Promise<CustomMcpServerDetails> {
    return this.request(`/api/mcp/servers${id ? `/${encodeURIComponent(id)}` : ""}`, { method: id ? "PUT" : "POST", body: JSON.stringify(body) });
  }

  testMcpServer(id: string): Promise<CustomMcpServerDetails> {
    return this.request(`/api/mcp/servers/${encodeURIComponent(id)}/test`, { method: "POST" });
  }

  deleteMcpServer(id: string): Promise<{ deleted: boolean }> {
    return this.request(`/api/mcp/servers/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  importMcpServers(body: unknown): Promise<CustomMcpServerDetails[]> {
    return this.request("/api/mcp/servers/import", { method: "POST", body: JSON.stringify(body) });
  }

  listMcpSources(): Promise<Array<{ manifest: McpSourceManifest; status: McpSourceStatus }>> {
    return this.request("/api/mcp/sources");
  }

  searchWorkbench(query = "", offset = 0, limit = 250): Promise<WorkbenchSearchResponse> {
    const parameters = new URLSearchParams({ limit: String(limit), offset: String(offset), q: query });
    return this.request(`/api/search?${parameters.toString()}`);
  }

  getWebSettings(): Promise<WebSettingsDetails> {
    return this.request("/api/web/settings");
  }

  updateWebSettings(body: UpdateWebSettingsRequest): Promise<WebSettingsDetails> {
    return this.request("/api/web/settings", { body: JSON.stringify(body), method: "PUT" });
  }

  getWebUsage(): Promise<WebUsageSummary> {
    return this.request("/api/web/usage");
  }

  listConnectors(): Promise<ConnectorManifest[]> {
    return this.request("/api/connectors");
  }
}
