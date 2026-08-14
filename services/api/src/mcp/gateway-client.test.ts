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

import assert from "node:assert/strict";
import test from "node:test";

import type { McpInvokeRequest } from "@science-agent/schema";

import { McpGatewayClient } from "./gateway-client.js";

test("MCP gateway client authenticates catalog and invocation requests", async () => {
  const seen: Array<{ init?: RequestInit; url: string }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    seen.push({ init, url });
    if (url.endsWith("/catalog")) {
      return Response.json({ loadedAt: "2026-01-01T00:00:00Z", revision: "rev", servers: [] });
    }
    return Response.json({
      attempts: [],
      content: [],
      durationMs: 1,
      isError: false,
      requestId: "request-1",
      serverId: "demo",
      toolName: "search",
    });
  };
  const client = new McpGatewayClient("http://gateway", "secret", fetchMock);
  await client.catalog();
  const request: McpInvokeRequest = {
    arguments: { query: "TP53" },
    context: {
      projectId: "project-1",
      sessionId: "session-1",
      toolCallId: "call-1",
      turnId: "turn-1",
    },
    execution: {
      retryPolicy: {
        initialDelayMs: 1,
        jitterRatio: 0,
        maxAttempts: 1,
        maxDelayMs: 1,
        multiplier: 2,
        respectRetryAfter: true,
        retryOn: [],
      },
      timeoutMs: 1_000,
    },
    requestId: "request-1",
    serverId: "demo",
    toolName: "search",
  };
  await client.invoke(request);

  assert.equal(seen.length, 2);
  assert.equal(new Headers(seen[0]?.init?.headers).get("authorization"), "Bearer secret");
  assert.equal(seen[1]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(seen[1]?.init?.body)), request);
});

test("MCP gateway client rejects malformed responses", async () => {
  const client = new McpGatewayClient("http://gateway", "secret", async () => Response.json({ servers: [] }));
  await assert.rejects(client.catalog(), /invalid catalog/);
});
