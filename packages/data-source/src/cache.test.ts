// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createTest } from "../../../test/support/tagged/compat.mjs";
import { McpResultCache } from "./result-cache.js";
import { WebCache, webCacheKey } from "./web/cache.js";
import type { McpToolResult } from "@sciencediscovery/schema";

const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});

const result = {
  attribution: "fixture",
  data: { value: 1 },
  license: "CC-BY",
  records: [],
  retrievedAt: "2026-11-19T00:00:00.000Z",
  sourceId: "arxiv",
  toolId: "search",
  untrusted: true,
  warnings: [],
} as McpToolResult;
const raw = { hash: "raw-hash", size: 10 };
const normalized = { hash: "normalized-hash", size: 20 };
const policy = { enabled: true, scope: "project" as const, ttlSeconds: 60 };

test("MCP result cache persists a complete entry and removes it after TTL", async (context) => {
  const dataDir = await mkdtemp(resolve(tmpdir(), "sciencediscovery-mcp-cache-"));
  context.after(async () => rm(dataDir, { recursive: true, force: true }));
  const first = new McpResultCache(dataDir);
  first.put({ cacheKey: "key", normalizedResult: normalized, policy, rawResponse: raw, result, scopeId: "project-1" });
  assert.deepEqual(first.get("key"), { normalizedResult: normalized, rawResponse: raw, result });
  first.close();

  const reopened = new McpResultCache(dataDir);
  assert.deepEqual(reopened.get("key")?.result.data, { value: 1 });
  reopened.close();

  const expired = new McpResultCache(dataDir);
  expired.put({ cacheKey: "expired", normalizedResult: normalized, policy: { ...policy, ttlSeconds: 0 }, rawResponse: raw, result });
  assert.equal(expired.get("expired"), undefined);
  expired.close();
});

test("MCP result cache evicts malformed persisted JSON instead of throwing", async (context) => {
  const dataDir = await mkdtemp(resolve(tmpdir(), "sciencediscovery-mcp-cache-corrupt-"));
  context.after(async () => rm(dataDir, { recursive: true, force: true }));
  const cache = new McpResultCache(dataDir);
  cache.close();
  const database = new DatabaseSync(resolve(dataDir, "mcp-result-cache.sqlite"));
  database.prepare(`INSERT INTO mcp_result_cache (
    cache_key, source_id, tool_id, source_version, created_at, expires_at,
    raw_response_hash, raw_response_size, normalized_result_hash,
    normalized_result_size, result_json, scope, scope_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "broken", "arxiv", "search", null, new Date().toISOString(), Date.now() + 60_000,
    "raw", 1, "normalized", 1, "{broken", "project", "p",
  );
  database.close();
  const reopened = new McpResultCache(dataDir);
  assert.equal(reopened.get("broken"), undefined);
  reopened.close();
});

test("web cache keys include operation, provider and request and expire entries", async (context) => {
  const dataDir = await mkdtemp(resolve(tmpdir(), "sciencediscovery-web-cache-"));
  context.after(async () => rm(dataDir, { recursive: true, force: true }));
  assert.notEqual(webCacheKey("search", "provider-a", "query"), webCacheKey("fetch", "provider-a", "query"));
  assert.notEqual(webCacheKey("search", "provider-a", "query"), webCacheKey("search", "provider-b", "query"));

  const cache = new WebCache(dataDir);
  const snapshot = { hash: "snapshot", size: 42 };
  cache.put("key", "body", snapshot, 60);
  assert.deepEqual(cache.get("key"), { content: "body", snapshot });
  cache.put("expired", "old", snapshot, 0);
  assert.equal(cache.get("expired"), undefined);
  cache.close();
});
