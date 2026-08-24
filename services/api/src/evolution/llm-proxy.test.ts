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

/**
 * The model proxy, from the angle that matters: what a compromised sidecar can
 * and cannot do with what it was handed.
 *
 * The sidecar executes model-written code. The security claim of this design is
 * that the worst it can do with its credential is spend the run it belongs to —
 * so the tests are about the token's blast radius, not about the happy path.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, test } from "node:test";

import type { ModelInvocationUsage } from "@sciencediscovery/schema";

import { handleEvolveCompletion, RunTokenRegistry } from "./llm-proxy.js";

const MODEL = { baseUrl: "http://127.0.0.1:1", id: "model-1", model: "glm-5.2", name: "GLM" };

/** Just enough store for the proxy: the model and its (secret) key. */
function fakeStore(overrides: { apiToken?: string; model?: typeof MODEL | undefined } = {}) {
  const recorded: ModelInvocationUsage[] = [];
  return {
    recorded,
    store: {
      appendModelInvocationUsage: async (record: ModelInvocationUsage) => { recorded.push(record); },
      getModel: () => ("model" in overrides ? overrides.model : MODEL),
      getModelApiToken: () => ("apiToken" in overrides ? overrides.apiToken : "sk-provider-secret"),
    } as never,
  };
}

/** Mount the handler on a bare server: `createApiServer` cannot be imported on
 *  macOS (its environment probe shells out to `/usr/bin/bash`). */
async function mount(deps: Parameters<typeof handleEvolveCompletion>[3]): Promise<{ origin: string }> {
  const server: Server = createServer((request, response) => {
    const match = request.url?.match(/^\/internal\/evolve-llm\/([^/]+)\/v1\/chat\/completions$/);
    if (!match || request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    void handleEvolveCompletion(request, response, decodeURIComponent(match[1]!), deps)
      .catch((error: unknown) => {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: String(error) }));
      });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  after(() => new Promise<void>((closed) => { server.close(() => closed()); }));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { origin: `http://127.0.0.1:${port}` };
}

function completion(origin: string, runId: string, token?: string) {
  return fetch(`${origin}/internal/evolve-llm/${runId}/v1/chat/completions`, {
    body: JSON.stringify({ messages: [{ content: "改进这个程序", role: "user" }] }),
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    method: "POST",
  });
}

test("a run token buys exactly one run's completions and nothing else", async () => {
  const tokens = new RunTokenRegistry();
  const { recorded, store } = fakeStore();
  const upstream: Array<{ authorization?: string; body: unknown; url: string }> = [];
  const { origin } = await mount({
    fetchImpl: (async (url: string, init: RequestInit) => {
      upstream.push({
        authorization: (init.headers as Record<string, string>).authorization,
        body: JSON.parse(String(init.body)),
        url: String(url),
      });
      return new Response(JSON.stringify({
        choices: [{ message: { content: "```python\nprint(1)\n```" } }],
        usage: { completion_tokens: 40, prompt_tokens: 100, total_tokens: 140 },
      }), { headers: { "content-type": "application/json" }, status: 200 });
    }) as never,
    store,
    tokens,
  });

  const token = tokens.issue("run-1", "s1", "model-1");
  const ok = await completion(origin, "run-1", token);
  assert.equal(ok.status, 200);

  // The same token is worthless for any other run.
  assert.equal((await completion(origin, "run-2", token)).status, 401);

  // The provider key never left the control plane: it is on the upstream call
  // and nowhere the sidecar can see.
  assert.equal(upstream[0]?.authorization, "Bearer sk-provider-secret");
  assert.notEqual(token, "sk-provider-secret");

  // The URL, not just the body. A profile's base URL already carries the
  // provider's version segment — the convention every other caller in this
  // product follows — and appending another produced a 404 the proxy faithfully
  // forwarded, so every expansion became an empty reply. This assertion is here
  // because its absence is what let that reach a deployment.
  assert.equal(upstream[0]?.url, "http://127.0.0.1:1/chat/completions");

  // The spend is attributed, so it shows up as evolution rather than nowhere.
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.runId, "run-1");
  assert.equal(recorded[0]?.sessionId, "s1");
  assert.equal(recorded[0]?.invocationKind, "evolve");
  assert.equal(recorded[0]?.totalTokens, 140);
  assert.equal(recorded[0]?.usageStatus, "reported");
});

test("no token, a wrong token and a revoked token are the same answer", async () => {
  const tokens = new RunTokenRegistry();
  const { store } = fakeStore();
  const { origin } = await mount({ fetchImpl: (async () => new Response("{}")) as never, store, tokens });

  const token = tokens.issue("run-1", "s1", "model-1");
  assert.equal((await completion(origin, "run-1")).status, 401, "no token");
  assert.equal((await completion(origin, "run-1", "guessed")).status, 401, "wrong token");
  assert.equal((await completion(origin, "run-1", token)).status, 200);

  // A token dies with its run: this is what bounds a leak to the search.
  tokens.revoke("run-1");
  assert.equal((await completion(origin, "run-1", token)).status, 401, "revoked");
  assert.equal(tokens.size, 0);
});

test("the caller cannot choose the model it is billed for", async () => {
  const tokens = new RunTokenRegistry();
  const { store } = fakeStore();
  const seen: unknown[] = [];
  const { origin } = await mount({
    fetchImpl: (async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [] }), { status: 200 });
    }) as never,
    store,
    tokens,
  });

  const token = tokens.issue("run-1", "s1", "model-1");
  await fetch(`${origin}/internal/evolve-llm/run-1/v1/chat/completions`, {
    // A sidecar that could name any model could bill the user for one they
    // never chose.
    body: JSON.stringify({ messages: [{ content: "x", role: "user" }], model: "gpt-expensive" }),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    method: "POST",
  });

  assert.equal((seen[0] as { model: string }).model, "glm-5.2");
});

test("a provider that reports no usage is recorded as unknown, not as zero", async () => {
  const tokens = new RunTokenRegistry();
  const { recorded, store } = fakeStore();
  const { origin } = await mount({
    fetchImpl: (async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })) as never,
    store,
    tokens,
  });

  await completion(origin, "run-1", tokens.issue("run-1", "s1", "model-1"));

  // "We do not know" and "it was free" are different facts.
  assert.equal(recorded[0]?.usageStatus, "provider-not-reported");
  assert.equal(recorded[0]?.totalTokens, null);
});

test("the provider's own error is forwarded rather than flattened", async () => {
  const tokens = new RunTokenRegistry();
  const { recorded, store } = fakeStore();
  const { origin } = await mount({
    fetchImpl: (async () => new Response(
      JSON.stringify({ error: { message: "context length exceeded" } }),
      { headers: { "content-type": "application/json" }, status: 400 },
    )) as never,
    store,
    tokens,
  });

  const response = await completion(origin, "run-1", tokens.issue("run-1", "s1", "model-1"));

  // The sidecar surfaces this as why an expansion failed; "something went
  // wrong" would make a bad key indistinguishable from a bad prompt.
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /context length exceeded/);
  assert.equal(recorded.length, 0, "a failed call is not recorded as spend");
});

test("a run whose model has no key fails loudly instead of silently", async () => {
  const tokens = new RunTokenRegistry();
  const { store } = fakeStore({ apiToken: undefined });
  const { origin } = await mount({ fetchImpl: (async () => new Response("{}")) as never, store, tokens });

  const response = await completion(origin, "run-1", tokens.issue("run-1", "s1", "model-1"));
  assert.equal(response.status, 503);
});

test("an unreachable provider is a gateway failure, not a crash", async () => {
  const tokens = new RunTokenRegistry();
  const { store } = fakeStore();
  const { origin } = await mount({
    fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as never,
    store,
    tokens,
  });

  assert.equal((await completion(origin, "run-1", tokens.issue("run-1", "s1", "model-1"))).status, 502);
});

test("an empty request is refused before the provider is called", async () => {
  const tokens = new RunTokenRegistry();
  const { store } = fakeStore();
  let called = false;
  const { origin } = await mount({
    fetchImpl: (async () => { called = true; return new Response("{}"); }) as never,
    store,
    tokens,
  });

  const response = await fetch(`${origin}/internal/evolve-llm/run-1/v1/chat/completions`, {
    body: JSON.stringify({}),
    headers: {
      authorization: `Bearer ${tokens.issue("run-1", "s1", "model-1")}`,
      "content-type": "application/json",
    },
    method: "POST",
  });

  assert.equal(response.status, 400);
  assert.equal(called, false);
});

test("a completion that was already paid for survives a bookkeeping failure", async () => {
  const tokens = new RunTokenRegistry();
  const { store } = fakeStore();
  // The session was deleted, or never existed: `appendModelInvocationUsage`
  // asserts the session is writable and throws.
  (store as unknown as { appendModelInvocationUsage: () => Promise<void> })
    .appendModelInvocationUsage = async () => { throw new Error("Session not found"); };

  const { origin } = await mount({
    fetchImpl: (async () => new Response(
      JSON.stringify({ choices: [{ message: { content: "```python\npass\n```" } }] }),
      { headers: { "content-type": "application/json" }, status: 200 },
    )) as never,
    store,
    tokens,
  });

  const response = await completion(origin, "run-1", tokens.issue("run-1", "gone", "model-1"));

  // Discarding it would spend the user's money and throw the answer away, and
  // the search would read as a model that returns nothing.
  assert.equal(response.status, 200);
  assert.match(JSON.stringify(await response.json()), /pass/);
});

test("the caller's thinking setting reaches the provider, unlike its model", async () => {
  const tokens = new RunTokenRegistry();
  const { store } = fakeStore();
  const seen: Array<Record<string, unknown>> = [];
  const { origin } = await mount({
    fetchImpl: (async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ choices: [] }), { status: 200 });
    }) as never,
    store,
    tokens,
  });

  await fetch(`${origin}/internal/evolve-llm/run-1/v1/chat/completions`, {
    body: JSON.stringify({
      messages: [{ content: "改进这个程序", role: "user" }],
      model: "gpt-expensive",
      thinking: { type: "disabled" },
    }),
    headers: {
      authorization: `Bearer ${tokens.issue("run-1", "s1", "model-1")}`,
      "content-type": "application/json",
    },
    method: "POST",
  });

  // Whole-program rewrites do not want thinking: left on, a reasoning model
  // spends the entire output budget on it and returns nothing — measured at
  // 16001 of 16000 tokens, six expansions in a row.
  assert.deepEqual(seen[0]?.thinking, { type: "disabled" });
  // The model is still not the caller's to choose: one changes how the chosen
  // model answers, the other changes who is billed.
  assert.equal(seen[0]?.model, "glm-5.2");
});

test("a caller that says nothing about thinking has nothing added", async () => {
  const tokens = new RunTokenRegistry();
  const { store } = fakeStore();
  const seen: Array<Record<string, unknown>> = [];
  const { origin } = await mount({
    fetchImpl: (async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ choices: [] }), { status: 200 });
    }) as never,
    store,
    tokens,
  });

  await completion(origin, "run-1", tokens.issue("run-1", "s1", "model-1"));

  // A provider that has never heard of the field should not be sent it.
  assert.equal("thinking" in (seen[0] ?? {}), false);
});

test("a run's two models get two tokens, and neither buys the other", async () => {
  // A judged scorecard needs a second model: one rewrites the candidate, one
  // grades it. The proxy pins the model to the token exactly so a caller cannot
  // choose what it is billed for, so they cannot share one.
  const tokens = new RunTokenRegistry();
  const mutate = tokens.issue("run-1", "s1", "model-mutate");
  const judge = tokens.issue("run-1", "s1", "model-judge");

  assert.notEqual(mutate, judge);
  assert.equal(tokens.resolve("run-1", mutate)?.modelId, "model-mutate");
  assert.equal(tokens.resolve("run-1", judge)?.modelId, "model-judge");
  // Still one run: the registry counts runs with live tokens, not tokens.
  assert.equal(tokens.size, 1);

  // Neither is worth anything for another run…
  assert.equal(tokens.resolve("run-2", judge), undefined);
  // …and both die with the search.
  tokens.revoke("run-1");
  assert.equal(tokens.resolve("run-1", mutate), undefined);
  assert.equal(tokens.resolve("run-1", judge), undefined);
  assert.equal(tokens.size, 0);
});
