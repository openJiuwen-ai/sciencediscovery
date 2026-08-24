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

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { CasObjectRef, WebOperation } from "@sciencediscovery/schema";

export interface WebCacheEntry {
  content: string;
  snapshot: CasObjectRef;
}

export function webCacheKey(operation: WebOperation, provider: string, request: string): string {
  return createHash("sha256").update(JSON.stringify({ operation, provider, request })).digest("hex");
}

export class WebCache {
  private readonly database: DatabaseSync;

  constructor(dataDir: string) {
    const path = resolve(dataDir, "web-cache.sqlite");
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS web_cache (
        cache_key TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        content TEXT NOT NULL,
        snapshot_hash TEXT NOT NULL,
        snapshot_size INTEGER NOT NULL
      )
    `);
  }

  get(key: string): WebCacheEntry | undefined {
    const row = this.database.prepare(
      "SELECT expires_at, content, snapshot_hash, snapshot_size FROM web_cache WHERE cache_key = ?",
    ).get(key) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    if (Number(row.expires_at) <= Date.now()) {
      this.database.prepare("DELETE FROM web_cache WHERE cache_key = ?").run(key);
      return undefined;
    }
    return {
      content: String(row.content),
      snapshot: { hash: String(row.snapshot_hash), size: Number(row.snapshot_size) },
    };
  }

  put(key: string, content: string, snapshot: CasObjectRef, ttlSeconds: number): void {
    this.database.prepare(`
      INSERT OR REPLACE INTO web_cache
        (cache_key, created_at, expires_at, content, snapshot_hash, snapshot_size)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      key,
      new Date().toISOString(),
      Date.now() + ttlSeconds * 1_000,
      content,
      snapshot.hash,
      snapshot.size,
    );
  }
}
