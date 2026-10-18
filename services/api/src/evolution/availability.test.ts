// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
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
    const settings = config().evolve; settings.url = "http://fixture.invalid"; settings.internalToken = "fixture-token";
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
