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
  McpSourceAdapter,
  McpSourceId,
  McpSourceManifest,
  McpToolId,
  McpToolManifest,
} from "@sciencediscovery/schema";

export class McpSourceRegistry {
  private readonly sources = new Map<McpSourceId, McpSourceAdapter>();

  register(source: McpSourceAdapter): this {
    const id = source.manifest.id;
    if (!id.trim()) throw new Error("MCP source manifest.id is required");
    if (this.sources.has(id)) throw new Error(`MCP source already registered: ${id}`);
    this.sources.set(id, source);
    return this;
  }

  upsert(source: McpSourceAdapter): this {
    this.sources.set(source.manifest.id, source);
    return this;
  }

  has(sourceId: McpSourceId): boolean {
    return this.sources.has(sourceId);
  }

  get(sourceId: McpSourceId): McpSourceAdapter {
    const source = this.sources.get(sourceId);
    if (!source) throw new Error(`Unknown MCP source: ${sourceId}`);
    return source;
  }

  getTool(sourceId: McpSourceId, toolId: McpToolId): McpToolManifest {
    const tool = this.get(sourceId).manifest.tools[toolId];
    if (!tool) throw new Error(`Unknown MCP tool: ${sourceId}/${toolId}`);
    return tool;
  }

  list(): McpSourceAdapter[] {
    return [...this.sources.values()];
  }

  listManifests(): McpSourceManifest[] {
    return this.list().map((source) => structuredClone(source.manifest));
  }
}

export function createMcpSourceRegistry(): McpSourceRegistry {
  return new McpSourceRegistry();
}
