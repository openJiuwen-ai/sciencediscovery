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
import { EvolveSidecarClient } from "./sidecar.js";
import { loadServerConfig } from "../bootstrap/config.js";

const config = () => loadServerConfig({ SCIENCE_AGENT_AUTH_TOKEN: "synthetic", SCIENCE_AGENT_RUNNER_TOKEN: "synthetic" });
test("default config and all sidecar operations refuse an uninitialized service without transport or credential forwarding", async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("Unexpected network"); };
  try {
    const settings = config();
    assert.equal(settings.evolve.url, ""); assert.equal(settings.evolve.internalToken, "");
    const access = new EvolveAvailability(settings.evolve);
    assert.deepEqual(await access.refresh(), { state: "not_initialized", canInitialize: false });
    assert.equal(access.ready, false);
    await assert.rejects(access.connection(), /not initialized/);
    const client = new EvolveSidecarClient(settings.evolve);
    const spec = { searchId: "synthetic", scorecardHash: "synthetic", algorithm: "puct", expansions: 1, llm: { url: "http://synthetic.invalid", token: "synthetic-only" } };
    await assert.rejects(client.probe(spec), /not initialized/);
    await assert.rejects(async () => { for await (const _ of client.stream(spec)) {} }, /not initialized/);
    assert.equal(await client.health(), undefined); assert.equal(await client.stop("synthetic"), false);
    assert.equal(requests, 0);
  } finally { globalThis.fetch = original; }
});
test("configured external service proves health and auth without forwarding model credentials, and fails closed", async () => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let mode = "ok";
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (mode === "offline") throw new Error("socket failed");
    if (String(url).endsWith("/health")) return Response.json({ status: mode === "bad-health" ? "unhealthy" : "healthy" });
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-token");
    assert.equal(init?.body, undefined);
    return Response.json({ stopped: false }, { status: mode === "bad-auth" ? 401 : 200 });
  };
  try {
    const settings = loadServerConfig({ SCIENCE_AGENT_AUTH_TOKEN: "synthetic", SCIENCE_AGENT_RUNNER_TOKEN: "synthetic", SCIENCE_AGENT_EVOLVE_URL: "http://fixture.invalid/", SCIENCE_AGENT_EVOLVE_INTERNAL_TOKEN: "fixture-token" }).evolve;
    const access = new EvolveAvailability(settings);
    assert.equal((await access.refresh()).state, "ready");
    assert.deepEqual(await access.connection(), { url: "http://fixture.invalid", internalToken: "fixture-token" });
    for (const modeValue of ["bad-auth", "bad-health", "offline"]) {
      mode = modeValue; assert.equal((await access.refresh()).state, "error");
      assert.equal(access.ready, false); assert.equal(settings.url, "");
      await assert.rejects(access.connection(), /unavailable/);
    }
    mode = "ok"; assert.equal((await access.refresh()).state, "ready");
    assert(calls.every(call => call.url.startsWith("http://fixture.invalid/")));
  } finally { globalThis.fetch = original; }
});
test("managed Init uses authenticated private launcher transport, hides credentials and updates dynamic client target", async () => {
  const original = globalThis.fetch;
  const settings = { url: "", internalToken: "", controlUrl: "http://launcher.invalid", controlToken: "launcher-fixture" };
  let ready = false; let fail = false;
  globalThis.fetch = async (url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer launcher-fixture");
    if (fail) return Response.json({}, { status: 401 });
    if (String(url).endsWith("/init")) { assert.equal(init?.method, "POST"); ready = true; }
    return Response.json({ state: ready ? "ready" : "installing", canInitialize: true,
      ...(ready ? { connection: { url: "http://owned.invalid", internalToken: "private-fixture" } } : {}) });
  };
  try {
    const access = new EvolveAvailability(settings);
    assert.equal((await access.refresh()).state, "installing");
    const result = await access.refresh(true); assert.equal(result.state, "ready");
    assert(!JSON.stringify(result).includes("private-fixture"));
    assert.deepEqual(await access.connection(), { url: "http://owned.invalid", internalToken: "private-fixture" });
    fail = true; assert.equal((await access.refresh()).state, "error"); assert.equal(settings.url, "");
    assert.equal(settings.internalToken, "");
  } finally { globalThis.fetch = original; }
});
test("dynamic sidecar transport uses only the authenticated owned endpoint and gives contextual auth errors", async () => {
  const original = globalThis.fetch; let rejectAuth = true; const targets: string[] = [];
  const settings = { url: "", internalToken: "", controlUrl: "http://launcher.invalid", controlToken: "synthetic-control" };
  globalThis.fetch = async (url, init) => {
    const target = String(url); targets.push(target);
    if (target.startsWith("http://launcher.invalid/")) return Response.json({ state: "ready", canInitialize: true, connection: { url: "http://owned.invalid", internalToken: "synthetic-owned" } });
    assert(target.startsWith("http://owned.invalid/"));
    if (target.endsWith("/health")) return Response.json({ status: "healthy" });
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-owned");
    if (target.endsWith("/probe")) {
      assert.equal(JSON.parse(String(init?.body)).llm.token, "synthetic-model-only");
      return rejectAuth ? Response.json({ detail: "invalid internal token" }, { status: 401 }) : Response.json({ baseline: 0.5, flat: false, label: "fixture", worsened: 0 });
    }
    if (target.endsWith("/stop")) return Response.json({ stopped: true });
    return new Response(JSON.stringify({ createdAt: "2026-10-18T00:00:00Z", sequence: 1, event: { type: "search_finished", status: "succeeded" } }) + "\n");
  };
  try {
    const availability = new EvolveAvailability(settings);
    const client = new EvolveSidecarClient({ ...settings, connection: () => availability.connection() });
    const spec = { searchId: "fixture", algorithm: "puct", expansions: 1, scorecardHash: "fixture", llm: { url: "http://synthetic.invalid", token: "synthetic-model-only" } };
    await assert.rejects(client.probe(spec), /Evolve authentication failed/);
    rejectAuth = false; assert.equal((await client.probe(spec)).flat, false);
    assert.equal((await client.health())!.status, "healthy");
    const events = []; for await (const event of client.stream(spec)) events.push(event);
    assert.equal(events.length, 1); assert.equal(await client.stop("fixture"), true);
    assert(targets.every(target => target.startsWith("http://launcher.invalid/") || target.startsWith("http://owned.invalid/")));
  } finally { globalThis.fetch = original; }
});
test("concurrent operator refreshes share health/auth work without caching stale connections", async () => {
  const original = globalThis.fetch; let calls = 0; let release: () => void;
  const gate = new Promise<void>(done => { release = done; });
  globalThis.fetch = async url => { calls++; await gate; return String(url).endsWith('/health') ? Response.json({ status: 'healthy' }) : Response.json({ stopped: false }); };
  try {
    const access = new EvolveAvailability({ url: 'http://operator.invalid', internalToken: 'synthetic-operator' });
    const pending = [access.refresh(), access.refresh(), access.refresh()]; release!(); await Promise.all(pending);
    assert.equal(calls, 2);
    await access.connection(); assert.equal(calls, 4, 'a later operation must recheck, not reuse cached availability');
  } finally { globalThis.fetch = original; }
});
test("explicit Init waits for an earlier status response and concurrent Init/status share its result", async () => {
  const original = globalThis.fetch; let finishStatus: (response: Response) => void; let finishInit!: (response: Response) => void; let initCalls = 0;
  globalThis.fetch = async url => String(url).endsWith('/status') ? await new Promise<Response>(done => { finishStatus = done; }) : (initCalls++, await new Promise<Response>(done => { finishInit = done; }));
  const access = new EvolveAvailability({ url: '', internalToken: '', controlUrl: 'http://control.invalid', controlToken: 'synthetic-control' });
  const status = access.refresh(); const initializing = access.refresh(true);
  try {
    await Promise.resolve(); assert.equal(initCalls, 0, 'a late old status must finish before Init');
    finishStatus!(Response.json({ state: 'not_initialized', canInitialize: true })); await status;
    await Promise.resolve();
    const duplicate = access.refresh(true); const poll = access.refresh();
    finishInit!(Response.json({ state: 'ready', canInitialize: true, connection: { url: 'http://owned.invalid', internalToken: 'synthetic-owned' } }));
    assert.equal((await initializing).state, 'ready'); assert.equal((await duplicate).state, 'ready'); assert.equal((await poll).state, 'ready');
    assert.equal(initCalls, 1); assert.equal(access.ready, true);
  } finally {
    finishStatus!(Response.json({ state: 'not_initialized', canInitialize: true }));
    finishInit?.(Response.json({ state: 'not_initialized', canInitialize: true })); await status; await initializing; globalThis.fetch = original;
  }
});
