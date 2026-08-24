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
  McpSourceManifest,
  McpSourceStatus,
  UpdateWebSettingsRequest,
  WebSettingsDetails,
  WebUsageSummary,
  WorkbenchSearchResult,
} from "@sciencediscovery/schema";

import { SkillsApiClient } from "./skills.js";

export class WebApiClient extends SkillsApiClient {
  listMcpSources(): Promise<Array<{ manifest: McpSourceManifest; status: McpSourceStatus }>> {
    return this.request("/api/mcp/sources");
  }

  searchWorkbench(query = ""): Promise<WorkbenchSearchResult[]> {
    return this.request(`/api/search?q=${encodeURIComponent(query)}`);
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
