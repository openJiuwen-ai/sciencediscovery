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

import type { McpCatalog, McpInvokeRequest, McpInvokeResponse, ResolvedProxy } from "@science-agent/schema";

/**
 * The MCP client surface the catalog and governance broker consume.
 *
 * `McpNodeClient` is the only implementation in production; keeping the seam a
 * type (rather than a second HTTP client) lets tests substitute a stub while
 * still driving the real broker and catalog code paths.
 */
export interface McpTransportClient {
  catalog(signal?: AbortSignal): Promise<McpCatalog>;
  invoke(request: McpInvokeRequest, signal?: AbortSignal): Promise<McpInvokeResponse>;
  reload(proxies?: Record<string, ResolvedProxy>, signal?: AbortSignal): Promise<McpCatalog>;
}
