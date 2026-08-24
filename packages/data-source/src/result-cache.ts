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

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { CasObjectRef, McpToolResult, ResultCachePolicy } from "@sciencediscovery/schema";

export interface McpResultCacheEntry {
  normalizedResult: CasObjectRef;
  rawResponse: CasObjectRef;
  result: McpToolResult;
}

/** Persistent cache owned by the data-source domain. */
export class McpResultCache {
  private readonly database: DatabaseSync;

  constructor(dataDir: string) {
    const path = resolve(dataDir, "mcp-result-cache.sqlite");
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS mcp_result_cache (
        cache_key TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        tool_id TEXT NOT NULL,
        source_version TEXT,
        created_at TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        raw_response_hash TEXT NOT NULL,
        raw_response_size INTEGER NOT NULL,
        normalized_result_hash TEXT NOT NULL,
        normalized_result_size INTEGER NOT NULL,
        result_json TEXT NOT NULL,
        scope TEXT NOT NULL,
        scope_id TEXT
      )
    `);
  }

  get(cacheKey: string): McpResultCacheEntry | undefined {
    const row = this.database.prepare(`
      SELECT expires_at, raw_response_hash, raw_response_size,
             normalized_result_hash, normalized_result_size, result_json
      FROM mcp_result_cache WHERE cache_key = ?
    `).get(cacheKey) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    if (Number(row.expires_at) <= Date.now()) {
      this.database.prepare("DELETE FROM mcp_result_cache WHERE cache_key = ?").run(cacheKey);
      return undefined;
    }
    try {
      return {
        normalizedResult: {
          hash: String(row.normalized_result_hash),
          size: Number(row.normalized_result_size),
        },
        rawResponse: {
          hash: String(row.raw_response_hash),
          size: Number(row.raw_response_size),
        },
        result: JSON.parse(String(row.result_json)) as McpToolResult,
      };
    } catch {
      this.database.prepare("DELETE FROM mcp_result_cache WHERE cache_key = ?").run(cacheKey);
      return undefined;
    }
  }

  put(options: {
    cacheKey: string;
    normalizedResult: CasObjectRef;
    policy: ResultCachePolicy;
    rawResponse: CasObjectRef;
    result: McpToolResult;
    scopeId?: string;
  }): void {
    this.database.prepare(`
      INSERT OR REPLACE INTO mcp_result_cache (
        cache_key, source_id, tool_id, source_version, created_at, expires_at,
        raw_response_hash, raw_response_size, normalized_result_hash,
        normalized_result_size, result_json, scope, scope_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      options.cacheKey,
      options.result.sourceId,
      options.result.toolId,
      options.result.sourceVersion ?? null,
      new Date().toISOString(),
      Date.now() + options.policy.ttlSeconds * 1_000,
      options.rawResponse.hash,
      options.rawResponse.size,
      options.normalizedResult.hash,
      options.normalizedResult.size,
      JSON.stringify(options.result),
      options.policy.scope,
      options.scopeId ?? null,
    );
  }

  close(): void {
    this.database.close();
  }
}
