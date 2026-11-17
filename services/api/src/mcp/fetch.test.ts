// Copyright (C) 2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fetchMcpRequest } from "./fetch.js";
import { startMcpProxy } from "../../../../test/support/mcp-network-fixtures.js";

test("native Requests preserve GET, POST, headers, cancellation and redirect protection through undici", async () => {
  const server = createServer(async (request, response) => {
    if (request.url === "/wait") return;
    if (request.url === "/redirect") { response.writeHead(302, { location: "/" }).end(); return; }
    let body = "";
    for await (const chunk of request) body += chunk;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ method: request.method, body, header: request.headers["x-fixture"] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const proxy = await startMcpProxy(origin);
  try {
    for (const method of ["GET", "POST"]) {
      const request = new Request("http://mcp-fixture.invalid/", { method, headers: { "x-fixture": "native" },
        ...(method === "POST" ? { body: "fixture-body" } : {}) });
      const result = await fetchMcpRequest(request, { mode: "url", url: proxy.url, noProxy: "" });
      assert.deepEqual(await result.json(), { method, body: method === "POST" ? "fixture-body" : "", header: "native" });
    }
    await assert.rejects(fetchMcpRequest(new Request(`${origin}/redirect`), { mode: "direct" }), /fetch failed/);
    await assert.rejects(fetchMcpRequest(new Request(`${origin}/wait`, { signal: AbortSignal.timeout(100) }), { mode: "direct" }), /abort|timeout/i);
    assert.ok(proxy.requests.length >= 2);
  } finally { await proxy.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
