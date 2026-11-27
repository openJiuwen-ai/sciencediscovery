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

import { createIdeaResearchClient } from "./research.js";
import { RunTokenRegistry } from "../evolution/llm-proxy.js";

const GLOBAL = {
  templateId: "scientific-hypothesis-general/v1",
  explorationIntensity: "standard",
  maxDepth: 5,
  maxNodes: 100,
  scoreDirection: "maximize",
  maxTokens: null,
};

/** A store whose Session differs from the deployment in exactly one field. */
function storeWith(sessionValues: Record<string, unknown>) {
  return {
    assertSessionWritable: () => ({ id: "s1", projectId: "p1" }),
    getSession: () => ({ id: "s1", projectId: "p1" }),
    resolveRuntimeSettings: () => ({ effective: { modelId: "m1" } }),
    getModel: () => ({ id: "m1", model: "model", name: "Model" }),
    getModelApiToken: () => "token",
    getIdeaTreeSettings: () => GLOBAL,
    resolveIdeaTreeSettings: () => ({ ...GLOBAL, ...sessionValues }),
  };
}

const tokens = { issue: () => "t", revoke: () => {} } as never;

/** Run one command and hand back the body that would leave for the engine. */
async function createdPayload(store: unknown) {
  const sent: any[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ items: [] }) } as never;
  }) as never;
  try {
    const client = createIdeaResearchClient({
      url: "http://127.0.0.1:1",
      apiOrigin: "http://127.0.0.1:2",
      store: store as never,
      tokens,
    });
    await client.command("s1", "create", { objective: "Compare treatments", materials: "Prepared evidence" });
    assert.equal(sent.length, 1, "the engine was called once");
    return sent[0];
  } finally {
    globalThis.fetch = original;
  }
}

test("a research is created with the Session's Idea Tree parameters", async () => {
  const payload = await createdPayload(storeWith({ maxDepth: 3 }));
  assert.equal(payload.settings.maxDepth, 3, "the Session value is what the engine gets");
  // The fields the Session did not override still come from the deployment.
  assert.equal(payload.settings.templateId, GLOBAL.templateId);
  assert.equal(payload.settings.maxNodes, GLOBAL.maxNodes);
});

test("with no override a research gets the deployment parameters unchanged", async () => {
  const payload = await createdPayload(storeWith({}));
  assert.deepEqual(payload.settings, GLOBAL);
});

function researchView(status: string, id = "research-1") {
  return {
    research: {
      id, objective: "Compare treatments", status, phase: "ideate", round: 0,
      batch: [], batchCompleted: 0, tokens: 10, usageKnown: true, reason: null, modelId: "m1",
      currentNodeId: null, settings: GLOBAL,
    },
    graph: { edges: [], nodes: [], objective: "Compare treatments", revision: 0, treeId: id, updatedAt: "" },
  };
}

/** Send one continue and keep the engine payloads and issued model grants. */
async function continueAttempt(status: string) {
  const sent: Array<{ operation: string }> = [];
  const issued: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    const payload = JSON.parse(init.body) as { operation: string };
    sent.push(payload);
    return { ok: true, json: async () => (payload.operation === "continue" ? researchView("running") : researchView(status)) } as never;
  }) as never;
  const client = createIdeaResearchClient({
    url: "http://127.0.0.1:1",
    apiOrigin: "http://127.0.0.1:2",
    store: storeWith({}) as never,
    tokens: { issue: (id: string) => { issued.push(id); return "t"; }, revoke: () => undefined } as never,
  });
  let error: unknown;
  try {
    await client.command("s1", "continue", { researchId: "research-1" });
  } catch (reason: unknown) {
    error = reason;
  } finally {
    client.close();
    globalThis.fetch = original;
  }
  return { error, issued, sent };
}

test("continue refuses a research whose token budget is spent", async () => {
  const attempt = await continueAttempt("budget_exhausted");
  assert.match(String(attempt.error), /increase the token limit and start a new research/);
  assert.deepEqual(attempt.sent.map((payload) => payload.operation), ["get"], "only the status read reached the engine; nothing was started");
  assert.deepEqual(attempt.issued, [], "no model grant was issued for a terminal research");
});

test("continue still restarts a paused research", async () => {
  const attempt = await continueAttempt("paused");
  assert.equal(attempt.error, undefined);
  assert.deepEqual(attempt.sent.map((payload) => payload.operation), ["get", "continue"]);
  assert.deepEqual(attempt.issued, ["research-1"]);
});

/** Send one continue with a real registry, keeping the payloads that reached the engine. */
async function continueWithRealTokens(answer: (operation: string) => unknown) {
  const sent: Array<{ operation: string; researchId?: string; llm?: { token: string } }> = [];
  const tokens = new RunTokenRegistry();
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    const payload = JSON.parse(init.body) as { operation: string; researchId?: string };
    sent.push(payload);
    const reply = answer(payload.operation);
    if (reply instanceof Error) throw reply;
    return reply as never;
  }) as never;
  const client = createIdeaResearchClient({
    url: "http://127.0.0.1:1",
    apiOrigin: "http://127.0.0.1:2",
    store: storeWith({}) as never,
    tokens,
  });
  let error: unknown;
  try {
    await client.command("s1", "continue", { researchId: "research-1" });
  } catch (reason: unknown) {
    error = reason;
  }
  return {
    client, error, sent, tokens,
    restore: () => { globalThis.fetch = original; },
  };
}

function issuedToken(sent: Array<{ operation: string; llm?: { token: string } }>) {
  return sent.find((payload) => payload.operation === "continue")?.llm?.token;
}

test("a continue whose reply is lost keeps the grant its running engine holds", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const attempt = await continueWithRealTokens((operation) => {
    if (operation === "continue") {
      // evolve's start() already scheduled drive(); only its reply was lost.
      const timeout = new Error("The operation was aborted due to timeout");
      timeout.name = "TimeoutError";
      return timeout;
    }
    return { ok: true, json: async () => researchView("paused") };
  });
  try {
    assert.match(String(attempt.error), /The research command was sent/);
    assert.match(String(attempt.error), /the run may already be live/i);
    assert.match(String(attempt.error), /aborted due to timeout/);
    const token = issuedToken(attempt.sent);
    assert.ok(token, "the continue reached the engine");
    // The engine keeps the exact token it was started with, so the proxy must
    // still resolve it; a revocation here would turn every model call into a 401.
    assert.ok(attempt.tokens.resolve("research-1", token), "a lost reply keeps the live grant");
    assert.equal(attempt.tokens.size, 1, "the grant stays tracked for the fallback sweep");
    // With no stream listener, the next sweep reads the research: paused is
    // terminal, so that read retires the grant rather than leaking it.
    t.mock.timers.tick(5_000);
    await settle();
    assert.deepEqual(attempt.sent.map((payload) => payload.operation), ["get", "continue", "get"]);
    assert.equal(attempt.tokens.resolve("research-1", token), undefined,
      "a terminal read retires the grant the lost reply left behind");
  } finally {
    attempt.client.close();
    attempt.restore();
  }
});

test("a continue whose engine answers 5xx keeps the grant its run may be using", async () => {
  const attempt = await continueWithRealTokens((operation) => operation === "continue"
    ? { ok: false, status: 500, json: async () => ({ detail: "Internal Server Error" }) }
    : { ok: true, json: async () => researchView("paused") });
  try {
    // view() runs after start(), so a 500 does not prove the run never began.
    assert.match(String(attempt.error), /The research command was sent/);
    assert.match(String(attempt.error), /the run may already be live/i);
    assert.match(String(attempt.error), /Internal Server Error/);
    const token = issuedToken(attempt.sent);
    assert.ok(token);
    assert.ok(attempt.tokens.resolve("research-1", token), "a 5xx keeps the grant start() may already hold");
    assert.equal(attempt.tokens.size, 1);
  } finally {
    attempt.client.close();
    attempt.restore();
  }
});

test("a continue the engine refuses revokes the grant it was given", async () => {
  const attempt = await continueWithRealTokens((operation) => operation === "continue"
    ? { ok: false, status: 409, json: async () => ({ detail: "Research is not resumable" }) }
    : { ok: true, json: async () => researchView("paused") });
  try {
    assert.match(String(attempt.error), /Research is not resumable/);
    const token = issuedToken(attempt.sent);
    assert.ok(token);
    assert.equal(attempt.tokens.resolve("research-1", token), undefined,
      "a refusal received from the engine proves the command did not start a run");
    assert.equal(attempt.tokens.size, 0);
  } finally {
    attempt.client.close();
    attempt.restore();
  }
});

test("a create whose reply is lost keeps the grant its running engine holds", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const sent: Array<{ operation: string; researchId: string; llm?: { token: string } }> = [];
  const tokens = new RunTokenRegistry();
  let createdId = "";
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    const payload = JSON.parse(init.body) as { operation: string; researchId: string };
    sent.push(payload);
    if (payload.operation === "create") {
      createdId = payload.researchId;
      const timeout = new Error("fetch failed");
      timeout.name = "TypeError";
      throw timeout;
    }
    return { ok: true, json: async () => researchView("paused", payload.researchId) } as never;
  }) as never;
  const client = createIdeaResearchClient({
    url: "http://127.0.0.1:1",
    apiOrigin: "http://127.0.0.1:2",
    store: storeWith({}) as never,
    tokens,
  });
  try {
    await assert.rejects(
      client.command("s1", "create", { content: "/idea-tree Compare treatments" }),
      /fetch failed/,
    );
    const token = sent.find((payload) => payload.operation === "create")?.llm?.token;
    assert.ok(token);
    assert.ok(tokens.resolve(createdId, token), "a lost create reply keeps the live grant");
    t.mock.timers.tick(5_000);
    await settle();
    assert.equal(tokens.resolve(createdId, token), undefined, "the fallback read still retires it");
  } finally {
    client.close();
    globalThis.fetch = original;
  }
});

test("a lost create reply is retired when the sweep's get returns the handler's 404", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const sent: Array<{ operation: string; researchId: string; llm?: { token: string } }> = [];
  const tokens = new RunTokenRegistry();
  let createdId = "";
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    const payload = JSON.parse(init.body) as { operation: string; researchId: string };
    sent.push(payload);
    if (payload.operation === "create") {
      createdId = payload.researchId;
      throw new Error("fetch failed");
    }
    return { ok: false, status: 404, json: async () => ({ detail: "Research not found" }) } as never;
  }) as never;
  const client = createIdeaResearchClient({
    url: "http://127.0.0.1:1",
    apiOrigin: "http://127.0.0.1:2",
    store: storeWith({}) as never,
    tokens,
  });
  try {
    await assert.rejects(
      client.command("s1", "create", { content: "/idea-tree Compare treatments" }),
      /fetch failed/,
    );
    const token = sent.find((payload) => payload.operation === "create")?.llm?.token;
    assert.ok(token);
    assert.ok(tokens.resolve(createdId, token));
    t.mock.timers.tick(5_000);
    await settle();
    assert.deepEqual(sent.map((payload) => payload.operation), ["create", "get"]);
    assert.equal(tokens.resolve(createdId, token), undefined,
      "a 404 get proves no run holds this id, so the grant is retired");
    t.mock.timers.tick(5_000);
    await settle();
    assert.deepEqual(sent.map((payload) => payload.operation), ["create", "get"],
      "the retired grant is not read again every sweep");
  } finally {
    client.close();
    globalThis.fetch = original;
  }
});

test("a route-level 404 keeps the grant the sweep keeps tracking", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const sent: Array<{ operation: string; researchId: string; llm?: { token: string } }> = [];
  const tokens = new RunTokenRegistry();
  let createdId = "";
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    const payload = JSON.parse(init.body) as { operation: string; researchId: string };
    sent.push(payload);
    if (payload.operation === "create") {
      createdId = payload.researchId;
      throw new Error("fetch failed");
    }
    // A proxy or wrong base URL answers 404 at the route level; it is not the
    // research handler saying this id does not exist.
    return { ok: false, status: 404, json: async () => ({ detail: "Not Found" }) } as never;
  }) as never;
  const client = createIdeaResearchClient({
    url: "http://127.0.0.1:1",
    apiOrigin: "http://127.0.0.1:2",
    store: storeWith({}) as never,
    tokens,
  });
  try {
    await assert.rejects(
      client.command("s1", "create", { content: "/idea-tree Compare treatments" }),
      /fetch failed/,
    );
    const token = sent.find((payload) => payload.operation === "create")?.llm?.token;
    assert.ok(token);
    assert.ok(tokens.resolve(createdId, token));
    t.mock.timers.tick(5_000);
    await settle();
    assert.deepEqual(sent.map((payload) => payload.operation), ["create", "get"]);
    assert.ok(tokens.resolve(createdId, token),
      "a route-level 404 says nothing about the research, so the grant stays");
    t.mock.timers.tick(5_000);
    await settle();
    assert.deepEqual(sent.map((payload) => payload.operation), ["create", "get", "get"],
      "the sweep keeps tracking the grant a route-level 404 left alone");
    assert.ok(tokens.resolve(createdId, token));
  } finally {
    client.close();
    globalThis.fetch = original;
  }
});

test("a 404 get does not retire a grant issued while that read was in flight", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const sent: Array<{ operation: string; researchId: string; llm?: { token: string } }> = [];
  const tokens = new RunTokenRegistry();
  let createdId = "";
  let getCalls = 0;
  let release!: (value: unknown) => void;
  const held = new Promise<unknown>((resolve) => { release = resolve; });
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    const payload = JSON.parse(init.body) as { operation: string; researchId: string };
    sent.push(payload);
    if (payload.operation === "create") {
      createdId = payload.researchId;
      throw new Error("fetch failed");
    }
    if (payload.operation === "continue") {
      return { ok: true, json: async () => researchView("running", payload.researchId) } as never;
    }
    getCalls += 1;
    // Hold the sweep's read open, then answer continue's resumability read.
    if (getCalls === 1) return held as never;
    return { ok: true, json: async () => researchView("paused", payload.researchId) } as never;
  }) as never;
  const client = createIdeaResearchClient({
    url: "http://127.0.0.1:1",
    apiOrigin: "http://127.0.0.1:2",
    store: storeWith({}) as never,
    tokens,
  });
  try {
    await assert.rejects(
      client.command("s1", "create", { content: "/idea-tree Compare treatments" }),
      /fetch failed/,
    );
    const first = sent.find((payload) => payload.operation === "create")?.llm?.token;
    assert.ok(first);
    t.mock.timers.tick(5_000);
    await settle();
    assert.deepEqual(sent.map((payload) => payload.operation), ["create", "get"]);
    // Resume while that read is in flight: this issues a newer grant for the id.
    await client.command("s1", "continue", { researchId: createdId });
    const second = sent.find((payload) => payload.operation === "continue")?.llm?.token;
    assert.ok(second);
    assert.notEqual(second, first);
    assert.equal(tokens.resolve(createdId, first), undefined,
      "continue's resumability read retired the previous generation");
    // The older read now answers 404; it must not retire the newer grant.
    release({ ok: false, status: 404, json: async () => ({ detail: "Research not found" }) });
    await settle();
    assert.ok(tokens.resolve(createdId, second),
      "a grant issued after the read started survives that read's 404");
    // A later read of the current generation still retires it.
    t.mock.timers.tick(5_000);
    await settle();
    assert.equal(tokens.resolve(createdId, second), undefined);
  } finally {
    client.close();
    globalThis.fetch = original;
  }
});

/** An engine stub that records operations, answers with `status()`, and lets a test drive the stream. */
function engineStub(options: { status?: () => string; statuses?: Record<string, string> } = {}) {
  const sent: Array<{ operation: string; researchId?: string }> = [];
  const encoder = new TextEncoder();
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: { body: string }) => {
    const payload = JSON.parse(init.body) as { operation: string; researchId?: string };
    // Only command reads are counted: the events POST carries `operation: "get"`
    // too, and it is the stream, not a read the sweep made.
    if (String(url).endsWith("/idea-tree/research/events")) {
      const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
      return { ok: true, body } as never;
    }
    sent.push(payload);
    const status = options.statuses?.[payload.operation] ?? options.status?.() ?? (payload.operation === "create" ? "running" : "completed");
    return { ok: true, json: async () => researchView(status, payload.researchId) } as never;
  }) as never;
  return {
    operations: () => sent.map((payload) => payload.operation),
    frames: (...statuses: string[]) => { for (const status of statuses) stream?.enqueue(encoder.encode(`data: ${JSON.stringify(researchView(status))}\n\n`)); },
    closeStream: () => stream?.close(),
    restore: () => { globalThis.fetch = original; },
  };
}

/** A created research, its client and the grants the client revoked after creating it. */
async function startedResearch(engine: ReturnType<typeof engineStub>) {
  const revoked: string[] = [];
  // Every issue is a distinguishable grant: a resumed research must keep the one it
  // just received, and a token is how a retirement tells the generations apart.
  let issued = 0;
  const client = createIdeaResearchClient({
    url: "http://127.0.0.1:1",
    apiOrigin: "http://127.0.0.1:2",
    store: storeWith({}) as never,
    tokens: { issue: () => `t${(issued += 1)}`, revoke: (id: string) => revoked.push(id) } as never,
  });
  const created = await client.command("s1", "create", { objective: "Compare treatments" });
  // Creating a research issues its grant; reset the record so these tests see only
  // the retirements that follow.
  revoked.length = 0;
  return { client, id: created.research.id as string, revoked };
}

/** Let the sweep's fire-and-forget read reach the engine stub. */
async function settle() {
  for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("a watched research is retired by its terminal frame and never read on a timer", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const engine = engineStub();
  const { client, id, revoked } = await startedResearch(engine);
  try {
    assert.deepEqual(engine.operations(), ["create"]);
    const stream = await client.events("s1", id, new AbortController().signal);
    const reader = stream.getReader();
    engine.frames("running");
    await reader.read();
    // The stream is the only read: a sweep while it is open must ask nothing.
    t.mock.timers.tick(5_000);
    await settle();
    assert.deepEqual(engine.operations(), ["create"], "a watched research is not re-read");
    assert.deepEqual(revoked, [], "the research is still live, so its grant stays");
    engine.frames("completed");
    await reader.read();
    assert.deepEqual(revoked, [id], "the terminal frame retires the grant");
    engine.closeStream();
    await reader.read().catch(() => undefined);
    t.mock.timers.tick(5_000);
    await settle();
    assert.deepEqual(engine.operations(), ["create"], "a retired grant is not read again");
  } finally {
    client.close();
    engine.restore();
  }
});

test("a research nobody watches is retired by one fallback read", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let status = "running";
  const engine = engineStub({ status: () => status });
  const { client, id, revoked } = await startedResearch(engine);
  try {
    t.mock.timers.tick(5_000);
    await settle();
    assert.deepEqual(engine.operations(), ["create", "get"], "an unwatched research gets exactly one read per sweep");
    assert.deepEqual(revoked, []);
    status = "completed";
    t.mock.timers.tick(5_000);
    await settle();
    assert.deepEqual(engine.operations(), ["create", "get", "get"]);
    assert.deepEqual(revoked, [id], "the read that sees the terminal state retires the grant");
    t.mock.timers.tick(5_000);
    await settle();
    assert.deepEqual(engine.operations(), ["create", "get", "get"], "nothing is read once the grant is gone");
  } finally {
    client.close();
    engine.restore();
  }
});

test("closing the page keeps the grant until the research settles", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let status = "running";
  const engine = engineStub({ status: () => status });
  const { client, id, revoked } = await startedResearch(engine);
  try {
    const controller = new AbortController();
    const stream = await client.events("s1", id, controller.signal);
    const reader = stream.getReader();
    engine.frames("running");
    await reader.read();
    controller.abort();
    assert.deepEqual(revoked, [], "an abandoned stream does not cancel the research it was watching");
    t.mock.timers.tick(5_000);
    await settle();
    assert.deepEqual(engine.operations(), ["create", "get"], "the fallback read covers the closed page");
    status = "ended";
    t.mock.timers.tick(5_000);
    await settle();
    assert.deepEqual(revoked, [id]);
  } finally {
    client.close();
    engine.restore();
  }
});

test("a terminal frame from the stream that ended does not retire the grant a continue just issued", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  // `pause` and the resume check answer the pausable state `continue` accepts, and
  // the resumed run is live; the sweep's later read finds the stub paused again.
  const engine = engineStub({ statuses: { get: "paused", pause: "paused", continue: "running" } });
  const { client, id, revoked } = await startedResearch(engine);
  try {
    // The panel is watching the first run; the user pauses it and resumes it from
    // the same card, which issues a new grant for the same research id.
    const stream = await client.events("s1", id, new AbortController().signal);
    const reader = stream.getReader();
    engine.frames("running");
    await reader.read();
    const paused = await client.command("s1", "pause", { researchId: id });
    assert.equal(paused.research.status, "paused", "the pause retired the grant the stream was opened for");
    await client.command("s1", "continue", { researchId: id });
    const revokesAfterResume = revoked.length;
    // The old stream now reports the run that ended, and its frame must not be
    // taken as the end of the run the user just started.
    engine.frames("completed");
    await reader.read();
    assert.equal(revoked.length, revokesAfterResume,
      "a frame from the previous stream leaves the fresh grant alone");
    engine.closeStream();
    await reader.read().catch(() => undefined);
    // The fresh grant is live: nothing was lost, so the fallback sweep now covers it.
    t.mock.timers.tick(5_000);
    await settle();
    // `continue` reads the research once to check it is resumable; after that the
    // only request is the sweep's, which proves the fresh grant is still tracked.
    assert.deepEqual(engine.operations(), ["create", "pause", "get", "continue", "get"],
      "the resumed research is still tracked and settled by the one fallback read");
  } finally {
    client.close();
    engine.restore();
  }
});

test("a stream the consumer throws away stops counting as a listener", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const engine = engineStub();
  const { client, id } = await startedResearch(engine);
  try {
    const stream = await client.events("s1", id, new AbortController().signal);
    const reader = stream.getReader();
    engine.frames("running");
    await reader.read();
    // A consumer that cancels its reader leaves no abort signal behind: the release
    // has to come from the stream itself, or this research would never be swept for
    // the rest of the process's life.
    await reader.cancel();
    t.mock.timers.tick(5_000);
    await settle();
    assert.deepEqual(engine.operations(), ["create", "get"],
      "the fallback read resumes once the abandoned stream has let go");
  } finally {
    client.close();
    engine.restore();
  }
});
