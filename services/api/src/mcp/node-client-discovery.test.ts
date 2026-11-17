// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { startMcpFixture, startMcpProxy } from "../../../../test/support/mcp-network-fixtures.js";
import { McpNodeClient } from "./node-client.js";
import type { ResolvedProxy } from "@sciencediscovery/schema";
import { McpSourceCatalog } from "@sciencediscovery/data-source";
import { createMcpSourceRegistry } from "@sciencediscovery/mcp-sources";
import type { OperationalLogger } from "@sciencediscovery/operational-logging";

/** 构造仅包含一个远程服务的客户端，避免访问机器上已有连接器。 */
function clientFor(url: string, transport: "http" | "sse" = "http", logger?: OperationalLogger) {
  return new McpNodeClient(() => ({ path: undefined, signature: url, servers: {
    remote: { enabled: true, transport, url, description: "Local fixture", toolOverrides: {},
      command: "", args: [], env: {}, headers: {}, routing: { mode: "off", keywords: [], priority: 0 } },
  } }), undefined, logger);
}

for (const transport of ["http", "sse"] as const) {
  for (const mode of ["direct", "url", "environment"] as const) {
    test(`${transport} first refresh honours saved ${mode} policy and logs its actual route`, async () => {
      const fixture = await startMcpFixture(transport);
      const proxy = await startMcpProxy(fixture.origin);
      const events: Record<string, unknown>[] = [];
      const logger = { info: (event, fields) => { if (event === "mcp_connection_started") events.push(fields ?? {}); },
        debug: () => undefined, warn: () => undefined, error: () => undefined, path: "unused" } as OperationalLogger;
      const keys = ["http_proxy", "HTTP_PROXY", "no_proxy", "NO_PROXY"] as const;
      const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
      const endpoint = mode === "direct" ? fixture.origin : "http://mcp-fixture.invalid";
      const client = clientFor(`${endpoint}/${transport === "http" ? "mcp" : "sse"}`, transport, logger);
      const policy: ResolvedProxy = mode === "url" ? { mode, url: proxy.url, noProxy: "" } : { mode };
      try {
        process.env.http_proxy = proxy.url; process.env.no_proxy = ""; process.env.NO_PROXY = "";
        const catalog = new McpSourceCatalog(createMcpSourceRegistry(), client, () => ({ remote: policy }));
        assert.equal((await catalog.refresh()).servers[0]?.tools.length, 2);
        assert.equal(proxy.requests.length > 0, mode !== "direct");
        assert.equal(events[0]?.proxyApplied, mode !== "direct");
        assert.equal(events[0]?.proxyMode, mode);
        assert.equal((await catalog.refresh()).servers[0]?.tools.length, 2);
      } finally {
        for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
        await client.close(); await proxy.close(); await fixture.close();
      }
    });
  }
}

test("ordinary refresh applies proxy changes and respects NO_PROXY without a reload", async () => {
  const fixture = await startMcpFixture("http");
  const proxy = await startMcpProxy(fixture.origin);
  const client = clientFor("http://mcp-fixture.invalid/mcp");
  let policy: ResolvedProxy = { mode: "url", url: proxy.url, noProxy: "" };
  const catalog = new McpSourceCatalog(createMcpSourceRegistry(), client, () => ({ remote: policy }));
  try {
    assert.equal((await catalog.refresh()).servers[0]?.tools.length, 2);
    const before = proxy.requests.length;
    policy = { mode: "direct" };
    assert.ok((await catalog.refresh()).servers[0]?.error);
    assert.equal(proxy.requests.length, before);
    policy = { mode: "url", url: proxy.url, noProxy: "mcp-fixture.invalid" };
    assert.ok((await catalog.refresh()).servers[0]?.error);
    assert.equal(proxy.requests.length, before);
    policy = { mode: "url", url: proxy.url, noProxy: "" };
    assert.equal((await catalog.refresh()).servers[0]?.tools.length, 2);
    assert.ok(proxy.requests.length > before);
  } finally { await client.close(); await proxy.close(); await fixture.close(); }
});

test("HTTP listTools SDK timeout reconnects once and restarts pagination", async (context) => {
  const fixture = await startMcpFixture("http");
  const client = clientFor(`${fixture.origin}/mcp`);
  const cursors: Array<string | undefined> = [];
  const clients: Client[] = [];
  context.mock.method(Client.prototype, "listTools", async function (this: Client, params: { cursor?: string }) {
    cursors.push(params.cursor); clients.push(this);
    if (cursors.length === 2) throw new McpError(ErrorCode.RequestTimeout, "Request timed out");
    const name = params.cursor ? "second" : "first";
    return { tools: [{ name, inputSchema: { type: "object" } }], ...(!params.cursor ? { nextCursor: "next" } : {}) };
  });
  try {
    const catalog = await client.catalog();
    assert.equal(catalog.servers[0]?.error, undefined);
    assert.deepEqual(catalog.servers[0]?.tools.map((tool) => tool.name), ["first", "second"]);
    assert.deepEqual(cursors, [undefined, "next", undefined, "next"]);
    assert.notEqual(clients[0], clients[2]);
  } finally { await client.close(); await fixture.close(); }
});

test("HTTP listTools repeated timeouts stop after two attempts", async (context) => {
  const fixture = await startMcpFixture("http");
  const client = clientFor(`${fixture.origin}/mcp`);
  let calls = 0;
  context.mock.method(Client.prototype, "listTools", async () => { calls += 1; throw new McpError(ErrorCode.RequestTimeout, "localized discovery failure"); });
  try {
    assert.match((await client.catalog()).servers[0]?.error ?? "", /localized discovery failure/);
    assert.equal(calls, 2);
  } finally { await client.close(); await fixture.close(); }
});

for (const message of ["Request timed out", "socket timeout"]) {
  test(`HTTP listTools retries the compatibility error message: ${message}`, async (context) => {
    const fixture = await startMcpFixture("http");
    const client = clientFor(`${fixture.origin}/mcp`);
    let calls = 0;
    context.mock.method(Client.prototype, "listTools", async () => {
      calls += 1;
      if (calls === 1) throw new Error(message);
      return { tools: [] };
    });
    try {
      assert.equal((await client.catalog()).servers[0]?.error, undefined);
      assert.equal(calls, 2);
    } finally { await client.close(); await fixture.close(); }
  });
}

test("HTTP connection failure is not retried as a tools/list timeout", async (context) => {
  const client = clientFor("http://127.0.0.1:1/mcp");
  let calls = 0;
  context.mock.method(Client.prototype, "connect", async () => {
    calls += 1;
    throw new McpError(ErrorCode.RequestTimeout, "handshake timed out");
  });
  try {
    assert.match((await client.catalog()).servers[0]?.error ?? "", /handshake timed out/);
    assert.equal(calls, 1);
  } finally { await client.close(); }
});

test("HTTP listTools non-timeout errors are not retried", async (context) => {
  const fixture = await startMcpFixture("http");
  const client = clientFor(`${fixture.origin}/mcp`);
  let calls = 0;
  context.mock.method(Client.prototype, "listTools", async () => { calls += 1; throw new Error("Permission denied"); });
  try {
    assert.match((await client.catalog()).servers[0]?.error ?? "", /Permission denied/);
    assert.equal(calls, 1);
  } finally { await client.close(); await fixture.close(); }
});

for (const transport of ["http", "sse"] as const) {
  test(`${transport} discovery uses the effective URL proxy on the wire`, async () => {
    const fixture = await startMcpFixture(transport);
    const proxy = await startMcpProxy(fixture.origin);
    const client = clientFor(`http://mcp-fixture.invalid/${transport === "sse" ? "sse" : "mcp"}`, transport);
    try {
      const catalog = await client.reload({ remote: { mode: "url", url: proxy.url, noProxy: "" } });
      assert.equal(catalog.servers[0]?.error, undefined);
      assert.equal(catalog.servers[0]?.tools.length, 2);
      assert.ok(proxy.requests.some((request) => request.startsWith("POST ")));
    } finally { await client.close(); await proxy.close(); await fixture.close(); }
  });
}

test("HTTP environment proxy and explicit direct policy choose different routes", async () => {
  const fixture = await startMcpFixture("http");
  const proxy = await startMcpProxy(fixture.origin);
  const remote = clientFor("http://mcp-fixture.invalid/mcp");
  const direct = clientFor(`${fixture.origin}/mcp`);
  const keys = ["http_proxy", "HTTP_PROXY", "no_proxy", "NO_PROXY"] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.http_proxy = proxy.url; process.env.no_proxy = ""; process.env.NO_PROXY = "";
    const policies: Array<{ client: McpNodeClient; policy: ResolvedProxy }> = [
      { client: remote, policy: { mode: "environment" } }, { client: direct, policy: { mode: "direct" } },
    ];
    for (const { client, policy } of policies) {
      const before = proxy.requests.length;
      const catalog = await client.reload({ remote: policy });
      assert.equal(catalog.servers[0]?.tools.length, 2, catalog.servers[0]?.error ?? "");
      assert.equal(proxy.requests.length > before, policy.mode === "environment");
    }
  } finally {
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    await remote.close(); await direct.close(); await proxy.close(); await fixture.close();
  }
});
