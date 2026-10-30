// The wizard's model-config API surface is gone (just-in-time
// configuration); what remains under test is the self-check contract —
// api + runner gate entry, modelConfigured is informational only.
import test from "node:test";
import assert from "node:assert/strict";
import { runSelfCheck } from "../src/wizard-api.ts";

const BASE = "http://127.0.0.1:4310";
const TOKEN = "tok";

interface Route {
  method?: string;
  pattern: RegExp;
  reply: () => { status: number; body?: unknown };
}

/** Scripted fetch: routes evaluated in order (first match wins), calls recorded. */
function makeFetch(routes: Route[]): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push(`${method} ${url}`);
    for (const route of routes) {
      if ((route.method ?? "GET") !== method) continue;
      if (!route.pattern.test(url)) continue;
      const { status, body } = route.reply();
      return new Response(body === undefined ? null : JSON.stringify(body), { status });
    }
    return new Response(JSON.stringify({ error: `no route for ${method} ${url}` }), { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

// --- self-check ------------------------------------------------------------------

test("runSelfCheck: all green", async () => {
  const { fetchImpl } = makeFetch([
    { pattern: /\/api\/health$/, reply: () => ({ status: 200, body: { status: "ok" } }) },
    { pattern: /\/health$/, reply: () => ({ status: 200, body: { status: "ok", execution: { ready: true } } }) },
    { pattern: /\/api\/settings$/, reply: () => ({ status: 200, body: { effective: { modelId: "m" } } }) },
  ]);
  const res = await runSelfCheck(BASE, TOKEN, "http://127.0.0.1:4311", fetchImpl);
  assert.deepEqual(res, { api: true, runner: true, runnerChecked: true, modelConfigured: true, ok: true });
});

test("runSelfCheck: runner not ready fails the gate", async () => {
  const { fetchImpl } = makeFetch([
    { pattern: /\/api\/health$/, reply: () => ({ status: 200, body: {} }) },
    { pattern: /\/health$/, reply: () => ({ status: 200, body: { execution: { ready: false } } }) },
    { pattern: /\/api\/settings$/, reply: () => ({ status: 200, body: { effective: { modelId: "m" } } }) },
  ]);
  const res = await runSelfCheck(BASE, TOKEN, "http://127.0.0.1:4311", fetchImpl);
  assert.equal(res.runner, false);
  assert.equal(res.ok, false);
});

test("runSelfCheck: unknown runner base is skipped, not failed", async () => {
  const { fetchImpl } = makeFetch([
    { pattern: /\/api\/health$/, reply: () => ({ status: 200, body: {} }) },
    { pattern: /\/api\/settings$/, reply: () => ({ status: 200, body: { effective: { modelId: "m" } } }) },
  ]);
  const res = await runSelfCheck(BASE, TOKEN, null, fetchImpl);
  assert.equal(res.runnerChecked, false);
  assert.equal(res.ok, true);
});

test("runSelfCheck: API down → model not evaluated, gate fails", async () => {
  const { fetchImpl } = makeFetch([
    { pattern: /\/api\/health$/, reply: () => ({ status: 503, body: {} }) },
  ]);
  const res = await runSelfCheck(BASE, TOKEN, "http://127.0.0.1:4311", fetchImpl);
  assert.equal(res.api, false);
  assert.equal(res.modelConfigured, false);
  assert.equal(res.ok, false);
});

test("an unconfigured model never blocks entry (just-in-time config)", async () => {
  const { fetchImpl } = makeFetch([
    { pattern: /\/api\/health$/, reply: () => ({ status: 200, body: {} }) },
    { pattern: /\/health$/, reply: () => ({ status: 200, body: { execution: { ready: true } } }) },
    { pattern: /\/api\/settings$/, reply: () => ({ status: 200, body: { overrides: {}, effective: { modelId: null } } }) },
  ]);
  const res = await runSelfCheck(BASE, TOKEN, "http://127.0.0.1:4311", fetchImpl);
  assert.equal(res.modelConfigured, false);
  assert.equal(res.ok, true, "modelConfigured is informational — ok must not depend on it");
});
