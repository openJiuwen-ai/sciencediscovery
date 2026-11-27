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
  // Creating a research clears any grant a previous research with the same id held;
  // that revoke is not the retirement these tests are about.
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

/** A store whose Session can be deleted, so `getSession` can answer nothing. */
function deletableStore() {
  let session: { id: string; projectId: string } | undefined = { id: "s1", projectId: "p1" };
  return {
    ...storeWith({}),
    getSession: () => session,
    assertSessionWritable: () => {
      if (!session) throw new Error("Session not found");
      return session;
    },
    deleteSessionRecord: () => { session = undefined; },
  };
}

/**
 * A client that created a research with a real `RunTokenRegistry` grant for one
 * Session, plus the two failures a Session delete can hit on the way to the
 * engine.
 */
async function startedGrant() {
  const sent: Array<{ operation: string; researchId?: string; llm?: { token: string } }> = [];
  let cleanupFailure: { status: number } | { transport: true } | undefined;
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    const payload = JSON.parse(init.body) as (typeof sent)[number];
    sent.push(payload);
    if (cleanupFailure && "transport" in cleanupFailure) throw new TypeError("fetch failed");
    if (cleanupFailure) {
      return { ok: false, status: cleanupFailure.status, json: async () => ({ detail: "engine unavailable" }) } as never;
    }
    return { ok: true, json: async () => researchView("running", payload.researchId) } as never;
  }) as never;
  const store = deletableStore();
  const tokens = new RunTokenRegistry();
  const client = createIdeaResearchClient({
    url: "http://127.0.0.1:1",
    apiOrigin: "http://127.0.0.1:2",
    store: store as never,
    tokens,
  });
  const created = await client.command("s1", "create", { objective: "Compare treatments" });
  return {
    client, store, tokens,
    id: created.research.id as string,
    token: sent[0]!.llm!.token,
    operations: () => sent.map((payload) => payload.operation),
    failCleanup: (failure: { status: number } | { transport: true }) => { cleanupFailure = failure; },
    restore: () => { globalThis.fetch = original; },
  };
}

test("a Session delete the sidecar rejects still retires that Session's research grants", async () => {
  const run = await startedGrant();
  try {
    assert.ok(run.tokens.resolve(run.id, run.token), "the live research's grant answers before the delete");
    run.failCleanup({ status: 503 });
    await assert.rejects(run.client.cleanup("p1", "s1"), /Research cleanup failed: HTTP 503/,
      "the engine-side cleanup failure still surfaces");
    assert.deepEqual(run.operations(), ["create", "delete"], "the sidecar delete was still attempted");
    assert.equal(run.tokens.resolve(run.id, run.token), undefined,
      "the credential of a deleted Session does not outlive it");
  } finally {
    run.client.close();
    run.restore();
  }
});

test("a Session delete that never reaches the sidecar still retires its research grants", async () => {
  const run = await startedGrant();
  try {
    assert.ok(run.tokens.resolve(run.id, run.token), "the live research's grant answers before the delete");
    run.failCleanup({ transport: true });
    await assert.rejects(run.client.cleanup("p1", "s1"), /fetch failed/);
    assert.equal(run.tokens.resolve(run.id, run.token), undefined,
      "a transport error must not leak the credential either");
  } finally {
    run.client.close();
    run.restore();
  }
});

test("a grant whose Session record is gone is retired by the sweep instead of re-read", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const run = await startedGrant();
  try {
    assert.ok(run.tokens.resolve(run.id, run.token), "the live research's grant answers before the delete");
    run.store.deleteSessionRecord();
    t.mock.timers.tick(5_000);
    await settle();
    assert.equal(run.tokens.resolve(run.id, run.token), undefined,
      "a missing Session record is terminal, so the orphan grant is retired");
    assert.deepEqual(run.operations(), ["create"], "no read is attempted for a Session that no longer exists");
    t.mock.timers.tick(5_000);
    await settle();
    assert.deepEqual(run.operations(), ["create"], "the retired grant stops costing a wakeup every sweep");
  } finally {
    run.client.close();
    run.restore();
  }
});

/** A registry that records the grants the client issued, so a test can ask the
 *  same question the LLM proxy asks: would the engine's next call be admitted? */
function recordingTokens() {
  const registry = new RunTokenRegistry();
  const issued: Array<{ researchId: string; token: string }> = [];
  return {
    registry,
    ids: () => issued.map((item) => item.researchId),
    last(researchId: string) {
      const entry = [...issued].reverse().find((item) => item.researchId === researchId);
      return entry === undefined ? undefined : registry.resolve(researchId, entry.token);
    },
    api: {
      issue: (researchId: string, sessionId: string, modelId: string) => {
        const token = registry.issue(researchId, sessionId, modelId);
        issued.push({ researchId, token });
        return token;
      },
      revoke: (researchId: string) => registry.revoke(researchId),
    },
  };
}

/**
 * An engine that has already scheduled the run when its answer is lost, plus what
 * a later read-back finds. `after: "lost"` makes the read-back fail too, which is
 * the case where nothing at all is known.
 */
function losingEngine(options: { before?: string; after: "running" | "paused" | "lost" }) {
  const operations: string[] = [];
  const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  let lost = false;
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    const payload = JSON.parse(init.body) as { operation: string };
    operations.push(payload.operation);
    if (payload.operation === "continue" || payload.operation === "create") {
      lost = true;
      throw timeout();
    }
    if (!lost) return { ok: true, json: async () => researchView(options.before ?? "paused") } as never;
    if (options.after === "lost") throw timeout();
    return { ok: true, json: async () => researchView(options.after) } as never;
  }) as never;
  return { operations, restore: () => { globalThis.fetch = original; } };
}

function clientWith(tokens: ReturnType<typeof recordingTokens>) {
  return createIdeaResearchClient({
    url: "http://127.0.0.1:1",
    apiOrigin: "http://127.0.0.1:2",
    store: storeWith({}) as never,
    tokens: tokens.api as never,
  });
}

test("a continue whose answer is lost keeps the grant when the research is running", async () => {
  const tokens = recordingTokens();
  const engine = losingEngine({ after: "running" });
  const client = clientWith(tokens);
  try {
    // The engine started the run before it stopped answering: the command took
    // effect, so the caller gets the state the engine reports, not an error.
    const view = await client.command("s1", "continue", { researchId: "research-1" });
    assert.equal(view.research.status, "running");
    assert.deepEqual(engine.operations, ["get", "continue", "get"],
      "the lost answer is followed by exactly one read-back");
    assert.ok(tokens.last("research-1"),
      "the next model call the engine makes is still admitted — the run is not left without a credential");
  } finally {
    client.close();
    engine.restore();
  }
});

test("a create whose answer is lost keeps the grant when the research is running", async () => {
  const tokens = recordingTokens();
  const engine = losingEngine({ after: "running" });
  const client = clientWith(tokens);
  try {
    const view = await client.command("s1", "create", { objective: "Compare treatments" });
    assert.equal(view.research.status, "running");
    const researchId = tokens.ids()[0];
    assert.ok(researchId, "the create issued a grant for the research it started");
    assert.ok(tokens.last(researchId),
      "the research the answer never confirmed keeps the credential its run needs");
  } finally {
    client.close();
    engine.restore();
  }
});

test("a command the engine refused gives its grant back", async () => {
  const tokens = recordingTokens();
  const original = globalThis.fetch;
  const operations: string[] = [];
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    const payload = JSON.parse(init.body) as { operation: string };
    operations.push(payload.operation);
    if (payload.operation === "continue") {
      return { ok: false, json: async () => ({ detail: "Research is not resumable" }) } as never;
    }
    return { ok: true, json: async () => researchView("paused") } as never;
  }) as never;
  const client = clientWith(tokens);
  try {
    await assert.rejects(client.command("s1", "continue", { researchId: "research-1" }), /not resumable/);
    assert.deepEqual(operations, ["get", "continue"],
      "an answered refusal needs no read-back: the engine said it started nothing");
    assert.equal(tokens.last("research-1"), undefined, "the grant it issued goes back");
  } finally {
    client.close();
    globalThis.fetch = original;
  }
});

test("a command whose answer is lost gives its grant back when the research did not start", async () => {
  const tokens = recordingTokens();
  const engine = losingEngine({ after: "paused" });
  const client = clientWith(tokens);
  try {
    await assert.rejects(client.command("s1", "continue", { researchId: "research-1" }), /timeout/i);
    assert.deepEqual(engine.operations, ["get", "continue", "get"],
      "the read-back is what decides this, not the missing answer");
    assert.equal(tokens.last("research-1"), undefined,
      "nothing is running, so the credential it was issued is revoked");
  } finally {
    client.close();
    engine.restore();
  }
});

test("a command nobody can be asked about keeps its grant and says so", async () => {
  const tokens = recordingTokens();
  const engine = losingEngine({ after: "lost" });
  const client = clientWith(tokens);
  try {
    await assert.rejects(
      client.command("s1", "continue", { researchId: "research-1" }),
      /could not be read back.*credential was kept/s,
    );
    assert.ok(tokens.last("research-1"),
      "with no fact to act on, the credential is kept rather than stranding a run that may have started");
  } finally {
    client.close();
    engine.restore();
  }
});
