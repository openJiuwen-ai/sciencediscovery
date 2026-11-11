// The wizard's model-config API surface is gone (just-in-time
// configuration); what remains under test is the self-check contract —
// api + runner gate entry, modelConfigured is informational only.
//
// The Runner readiness the gate reads now arrives inside the API's
// authenticated `/api/health` detail: an anonymous caller gets liveness only,
// so these mocks answer with a detail body only when the bearer token is sent.
import test from "node:test";
import assert from "node:assert/strict";
import { runSelfCheck } from "../src/wizard-api.ts";

const BASE = "http://127.0.0.1:4310";
const TOKEN = "tok";

interface Call {
  method: string;
  url: string;
  authorization: string | null;
}

interface Route {
  method?: string;
  pattern: RegExp;
  reply: (call: Call) => { status: number; body?: unknown };
}

/** Scripted fetch: routes evaluated in order (first match wins), calls recorded. */
function makeFetch(routes: Route[]): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const call: Call = { method, url, authorization: headers.get("authorization") };
    calls.push(call);
    for (const route of routes) {
      if ((route.method ?? "GET") !== method) continue;
      if (!route.pattern.test(url)) continue;
      const { status, body } = route.reply(call);
      return new Response(body === undefined ? null : JSON.stringify(body), { status });
    }
    return new Response(JSON.stringify({ error: `no route for ${method} ${url}` }), { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** The API's two answers on the same port: detail with the token, liveness without. */
function apiHealth(detail: unknown): Route {
  return {
    pattern: /\/api\/health$/,
    reply: (call) => call.authorization === `Bearer ${TOKEN}`
      ? { status: 200, body: detail }
      : { status: 200, body: { service: "sciencediscovery-api", status: "ok" } },
  };
}

const READY_DETAIL = {
  service: "sciencediscovery-api",
  status: "ok",
  runner: { status: "ok", execution: { ready: true } },
};

const RUNNER_SIDE = {
  pattern: /\/health$/,
  reply: () => ({ status: 200, body: { status: "ok" } }),
};

// --- self-check ------------------------------------------------------------------

test("runSelfCheck: all green", async () => {
  const { fetchImpl } = makeFetch([
    apiHealth(READY_DETAIL),
    RUNNER_SIDE,
    { pattern: /\/api\/settings$/, reply: () => ({ status: 200, body: { effective: { modelId: "m" } } }) },
  ]);
  const res = await runSelfCheck(BASE, TOKEN, "http://127.0.0.1:4311", fetchImpl);
  assert.deepEqual(res, { api: true, runner: true, runnerChecked: true, modelConfigured: true, ok: true });
});

test("runSelfCheck: runner not ready fails the gate", async () => {
  const { fetchImpl } = makeFetch([
    apiHealth({ ...READY_DETAIL, runner: { status: "ok", execution: { ready: false } } }),
    RUNNER_SIDE,
    { pattern: /\/api\/settings$/, reply: () => ({ status: 200, body: { effective: { modelId: "m" } } }) },
  ]);
  const res = await runSelfCheck(BASE, TOKEN, "http://127.0.0.1:4311", fetchImpl);
  assert.equal(res.runner, false);
  assert.equal(res.ok, false);
});

test("runSelfCheck: readiness is read with the token, never from an anonymous answer", async () => {
  // The Runner port answers liveness only, so an unauthenticated health answer
  // must not be able to satisfy the gate: this is the shape that broke the
  // packaged shell when the detail started requiring a token.
  const { fetchImpl, calls } = makeFetch([
    apiHealth(READY_DETAIL),
    RUNNER_SIDE,
    { pattern: /\/api\/settings$/, reply: () => ({ status: 200, body: { effective: { modelId: "m" } } }) },
  ]);
  const anonymousToken = "not-the-api-token";
  const res = await runSelfCheck(BASE, anonymousToken, "http://127.0.0.1:4311", fetchImpl);
  assert.equal(res.api, true, "liveness is still an answer");
  assert.equal(res.runner, false);
  assert.equal(res.ok, false);
  assert.ok(
    calls.every(call => call.url !== "http://127.0.0.1:4311/health"),
    "the Runner port is not probed anonymously for readiness",
  );
});

test("runSelfCheck: runner reported unavailable is not ready", async () => {
  const { fetchImpl } = makeFetch([
    apiHealth({ ...READY_DETAIL, status: "degraded", runner: { status: "unavailable" } }),
    { pattern: /\/api\/settings$/, reply: () => ({ status: 200, body: { effective: { modelId: "m" } } }) },
  ]);
  const res = await runSelfCheck(BASE, TOKEN, "http://127.0.0.1:4311", fetchImpl);
  assert.equal(res.runner, false);
  assert.equal(res.ok, false);
});

test("runSelfCheck: unknown runner base is skipped, not failed", async () => {
  const { fetchImpl } = makeFetch([
    apiHealth(READY_DETAIL),
    { pattern: /\/api\/settings$/, reply: () => ({ status: 200, body: { effective: { modelId: "m" } } }) },
  ]);
  const res = await runSelfCheck(BASE, TOKEN, null, fetchImpl);
  assert.equal(res.runnerChecked, false);
  assert.equal(res.ok, true);
});

test("runSelfCheck: API down → model not evaluated, gate fails", async () => {
  const { fetchImpl } = makeFetch([
    { pattern: /\/api\/health$/, reply: () => ({ status: 503, body: { service: "sciencediscovery-api", status: "starting" } }) },
  ]);
  const res = await runSelfCheck(BASE, TOKEN, "http://127.0.0.1:4311", fetchImpl);
  assert.equal(res.api, false);
  assert.equal(res.modelConfigured, false);
  assert.equal(res.ok, false);
});

test("an unconfigured model never blocks entry (just-in-time config)", async () => {
  const { fetchImpl } = makeFetch([
    apiHealth(READY_DETAIL),
    RUNNER_SIDE,
    { pattern: /\/api\/settings$/, reply: () => ({ status: 200, body: { overrides: {}, effective: { modelId: null } } }) },
  ]);
  const res = await runSelfCheck(BASE, TOKEN, "http://127.0.0.1:4311", fetchImpl);
  assert.equal(res.modelConfigured, false);
  assert.equal(res.ok, true, "modelConfigured is informational — ok must not depend on it");
});
