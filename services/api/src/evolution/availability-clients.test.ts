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
import { EvolveAvailability } from "./availability.js";
import { RunTokenRegistry } from "./llm-proxy.js";
import { ideaTreeRepositoryForSession } from "../idea-tree/python-client.js";
import { createIdeaResearchClient } from "../idea-tree/research.js";
import type { SessionStore } from "../store.js";

test("uninitialized Idea Tree and research paths refuse before transport or model credential access", async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("Unexpected request"); };
  const availability = new EvolveAvailability({ url: "", internalToken: "" });
  const store = { getSession: () => { throw new Error("must refuse before session/model access"); } } as unknown as SessionStore;
  const research = createIdeaResearchClient({ url: "", apiOrigin: "http://synthetic.invalid", store, tokens: new RunTokenRegistry() });
  try {
    const tree = ideaTreeRepositoryForSession({ url: "", connection: () => availability.connection() }, { projectId: "p", sessionId: "s" });
    await assert.rejects(tree.readTree("synthetic"), /not initialized/);
    const emptyTree = ideaTreeRepositoryForSession({ url: "" }, { projectId: "p", sessionId: "s" });
    await assert.rejects(emptyTree.readGraph("synthetic"), /not initialized/);
    await assert.rejects(research.command("s", "create", { content: "synthetic" }), /not initialized/);
    await assert.rejects(research.events("s", "r", new AbortController().signal), /not initialized/);
    await research.cleanup("p", "s");
    assert.equal(calls, 0);
  } finally { research.close(); globalThis.fetch = original; }
});
test("Idea Tree resolves the current owned connection instead of a stale constructor endpoint", async () => {
  const original = globalThis.fetch; const urls: string[] = []; let endpoint = "http://owned-one.invalid";
  globalThis.fetch = async (url, init) => {
    urls.push(String(url)); assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-owned");
    const body = JSON.parse(String(init?.body)); assert.equal(body.projectId, "p"); assert.equal(body.sessionId, "s");
    return Response.json({ result: { id: "tree" } });
  };
  try {
    const tree = ideaTreeRepositoryForSession({ url: "http://stale.invalid", connection: async () => ({ url: endpoint, internalToken: "synthetic-owned" }) }, { projectId: "p", sessionId: "s" });
    assert.deepEqual(await tree.readTree("tree"), { id: "tree" });
    endpoint = "http://owned-two.invalid"; await tree.readGraph("tree");
    assert.deepEqual(urls, ["http://owned-one.invalid/idea-tree/command", "http://owned-two.invalid/idea-tree/command"]);
  } finally { globalThis.fetch = original; }
});
test("research command, event and cleanup transport use the resolved owned connection", async () => {
  const original = globalThis.fetch; const urls: string[] = [];
  const store = { getSession: () => ({ id: "s", projectId: "p" }) } as unknown as SessionStore;
  globalThis.fetch = async (url, init) => {
    urls.push(String(url)); assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-owned");
    assert.equal(JSON.parse(String(init?.body)).sessionId, "s");
    return Response.json({ research: { id: "r", status: "paused" }, graph: { nodes: [] } });
  };
  const research = createIdeaResearchClient({ url: "http://stale.invalid", connection: async () => ({ url: "http://owned.invalid", internalToken: "synthetic-owned" }),
    apiOrigin: "http://synthetic.invalid", store, tokens: new RunTokenRegistry() });
  try {
    assert.equal((await research.command("s", "get", { researchId: "r" })).research.id, "r");
    const body = await research.events("s", "r", new AbortController().signal); await body.cancel();
    await research.cleanup("p", "s");
    assert.equal(urls.length, 3); assert(urls.every(url => url.startsWith("http://owned.invalid/")));
  } finally { research.close(); globalThis.fetch = original; }
});

test("explicit operator Idea Tree/research HTTP calls omit absent bearer and retain configured bearer", async () => {
  const { createServer } = await import("node:http");
  const requests: { path: string; authorization: string | undefined; body: Record<string, unknown> }[] = [];
  const server = createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += chunk;
    requests.push({ path: request.url!, authorization: request.headers.authorization, body: JSON.parse(text) });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url === "/idea-tree/command" ? { result: null } : { research: { id: "r", status: "paused" }, graph: { nodes: [] } }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const store = { getSession: () => ({ id: "s", projectId: "p" }) } as unknown as SessionStore;
    for (const token of [undefined, "synthetic-operator-only"]) {
      const tree = ideaTreeRepositoryForSession({ url, token }, { projectId: "p", sessionId: "s" });
      assert.equal(await tree.readTree("tree"), null);
      const research = createIdeaResearchClient({ url, token, apiOrigin: "http://unused.invalid", store, tokens: new RunTokenRegistry() });
      try {
        assert.equal((await research.command("s", "get", { researchId: "r" })).research.id, "r");
        const stream = await research.events("s", "r", new AbortController().signal); await stream.cancel();
        await research.cleanup("p", "s");
      } finally { research.close(); }
    }
    assert.equal(requests.length, 8);
    for (const [index, request] of requests.entries()) {
      assert.equal(request.authorization, index < 4 ? undefined : "Bearer synthetic-operator-only");
      assert.equal(request.body.projectId, "p"); assert.equal(request.body.sessionId, "s"); assert.equal(request.body.llm, undefined);
    }
    assert.deepEqual(requests.slice(0, 4).map(request => request.path), ["/idea-tree/command", "/idea-tree/research/command", "/idea-tree/research/events", "/idea-tree/research/command"]);
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});
