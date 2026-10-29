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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { IdeaTreeServiceClient } from "@sciencediscovery/idea-tree";
import { RunTokenRegistry } from "./llm-proxy.js";
import { createIdeaResearchClient } from "../idea-tree/research.js";
import type { SessionStore } from "../store.js";

test("independent Idea Tree repository and research use scoped service transport", async () => {
  const original = globalThis.fetch; const paths: string[] = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname; paths.push(path);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-owned");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "/idea-tree/command") {
      assert.equal(body.projectId, "p"); assert.equal(body.sessionId, "s");
      assert.equal(body.operation, "readTree"); assert.deepEqual(body.params, { treeId: "tree" });
      return Response.json({ result: { id: "tree" } });
    }
    if (path === "/mcp/scopes") { assert.equal(body.projectId, "p"); assert.equal(body.sessionId, "s"); return Response.json({ token: "scope" }); }
    if (path === "/mcp/scope" && init?.method === "POST") return Response.json({ result: { content: [{ text: JSON.stringify({ research: { id: "r", status: "paused" }, graph: { nodes: [] } }) }] } });
    if (path === "/mcp/scope" && init?.method === "DELETE") return new Response(null, { status: 204 });
    if (path === "/idea-tree/research/events") return new Response("data: {}\n\n");
    if (path === "/idea-tree/research/command") { assert.equal(body.operation, "delete"); return Response.json({}); }
    throw new Error(`Unexpected request ${path}`);
  };
  const service = new IdeaTreeServiceClient({ url: "http://idea-tree.invalid", token: "synthetic-owned" });
  const store = { getSession: () => ({ id: "s", projectId: "p" }) } as unknown as SessionStore;
  const research = createIdeaResearchClient({ service, apiOrigin: "http://synthetic.invalid", store, tokens: new RunTokenRegistry() });
  try {
    assert.deepEqual(await service.repository({ projectId: "p", sessionId: "s" }).readTree("tree"), { id: "tree" });
    assert.equal((await research.command("s", "get", { researchId: "r" })).research.id, "r");
    const stream = await research.events("s", "r", new AbortController().signal); await stream.cancel();
    await research.cleanup("p", "s");
    assert.deepEqual(paths, ["/idea-tree/command", "/mcp/scopes", "/mcp/scope", "/mcp/scope", "/idea-tree/research/events", "/idea-tree/research/command"]);
  } finally { research.close(); globalThis.fetch = original; }
});


test("unavailable independent service fails without accessing model credentials", async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("service unavailable"); };
  const store = {
    getSession: () => ({ id: "s", projectId: "p" }),
    getModelApiToken: () => { throw new Error("must not access model credentials"); },
  } as unknown as SessionStore;
  const service = new IdeaTreeServiceClient({ url: "http://unavailable.invalid" });
  const research = createIdeaResearchClient({ service, apiOrigin: "http://synthetic.invalid", store, tokens: new RunTokenRegistry() });
  try {
    await assert.rejects(service.repository({ projectId: "p", sessionId: "s" }).readGraph("tree"), /service is unavailable/);
    await assert.rejects(research.command("s", "get", { researchId: "r" }), /service is unavailable/);
    await assert.rejects(research.events("s", "r", new AbortController().signal), /service is unavailable/);
    assert.equal(calls, 3);
  } finally { research.close(); globalThis.fetch = original; }
});

test("service transport sends a bearer only when configured", async () => {
  const { createServer } = await import("node:http");
  const requests: { authorization: string | undefined; body: Record<string, unknown> }[] = [];
  const server = createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += chunk;
    requests.push({ authorization: request.headers.authorization, body: JSON.parse(text) });
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ result: null }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    for (const token of [undefined, "synthetic-token"]) {
      const service = new IdeaTreeServiceClient({ url, token });
      assert.equal(await service.repository({ projectId: "p", sessionId: "s" }).readTree("tree"), null);
    }
    assert.deepEqual(requests.map(request => request.authorization), [undefined, "Bearer synthetic-token"]);
    for (const request of requests) {
      assert.equal(request.body.projectId, "p"); assert.equal(request.body.sessionId, "s");
      assert.equal(request.body.llm, undefined);
    }
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});
