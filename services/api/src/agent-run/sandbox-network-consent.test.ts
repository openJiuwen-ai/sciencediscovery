// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NO_SANDBOX_NETWORK_ACCESS, type PermissionEpoch } from "@sciencediscovery/schema";
import type { AgentPermissionRuntime } from "@sciencediscovery/governance";
import type { SessionStore } from "../store.js";
import { createSandboxNetworkConsent } from "./sandbox-network-consent.js";

function fixture() {
  const epoch = { id: "epoch", networkPolicy: "none", networkAccess: NO_SANDBOX_NETWORK_ACCESS } as PermissionEpoch;
  let active = true, granted = true, allowed = true;
  const requests: Array<{ action: string; resource: string; summary: string }> = [];
  const store = { assertSessionWritable() {}, getSessionRun: async () => ({ status: active ? "running" : "completed" }),
    getPermissionGrant: () => ({ state: granted ? "active" : "revoked" }),
  } as unknown as SessionStore;
  const permission = { getEpoch: () => epoch, requirePrivilege: async (input: { action: string; resource: string; summary: string }) => {
    requests.push(input); if (!allowed) throw new Error("Permission denied/dismissed");
    return { action: input.action, outcome: "allowed", resource: input.resource, id: randomUUID(), permissionGrantId: "grant" };
  } } as unknown as AgentPermissionRuntime;
  const make = (agentId = "main", executionId = "run") => createSandboxNetworkConsent({ store, permission,
    sessionId: "s", agentId, executionId, rootRunId: "root", assertRunner(runnerId) { if (runnerId === "foreign") throw new Error("Runner forbidden"); } });
  return { epoch, make, requests, consent: make(), revoke: () => { granted = false; }, end: () => { active = false; }, deny: () => { allowed = false; } };
}
const input = { hosts: ["eutils.ncbi.nlm.nih.gov:443"], purpose: "Retrieve requested PubMed records" };

test("consent leaves default/global epoch offline and exact hosts are granted to one new call only", async () => {
  const f = fixture();
  assert.equal((await f.consent.consume(undefined, "local")).networkPolicy, "none");
  const decision = await f.consent.request(input);
  assert.equal(decision.state, "allowed"); assert.match(f.requests[0]!.summary, /eutils.ncbi.nlm.nih.gov:443.*Retrieve requested PubMed/);
  assert.equal(f.epoch.networkPolicy, "none");
  const granted = await f.consent.consume(decision.authorizationId, "local");
  assert.deepEqual(granted.networkAccess?.allowedDomains, input.hosts);
  assert.equal(granted.networkPolicy, "domain-allowlist"); assert.equal(granted.networkAccess?.allowPrivateNetwork, false);
  assert.notEqual(granted.id, f.epoch.id);
  await assert.rejects(f.consent.consume(decision.authorizationId, "local"), /consumed/);
  assert.equal((await f.consent.consume(undefined, "local")).networkPolicy, "none");
});

test("network tokens cannot cross Runner, Agent or run and concurrent consumption succeeds once", async () => {
  const f = fixture(); const decision = await f.consent.request(input);
  await assert.rejects(f.consent.consume(decision.authorizationId, "remote"), /foreign/);
  await assert.rejects(f.make("child").consume(decision.authorizationId, "local"), /foreign/);
  await assert.rejects(f.make("main", "next-run").consume(decision.authorizationId, "local"), /foreign/);
  const results = await Promise.allSettled([f.consent.consume(decision.authorizationId, "local"), f.consent.consume(decision.authorizationId, "local")]);
  assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
});

for (const change of ["revoke", "end"] as const) test(`network token rejects ${change} before dispatch`, async () => {
  const f = fixture(); const decision = await f.consent.request(input); f[change]();
  await assert.rejects(f.consent.consume(decision.authorizationId, "local"));
});

test("denial/dismissal is visibly blocked and cancellation issues no token", async () => {
  const f = fixture(); f.deny(); const decision = await f.consent.request(input);
  assert.equal(decision.state, "blocked"); assert.equal(decision.authorizationId, undefined);
  assert.match(decision.instruction, /incomplete.*Do not silently/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.consent.request(input, controller.signal)); assert.equal(f.requests.length, 1);
});

test("observed denial asks about exact blocked hosts and preserves prior side effects without replay", async () => {
  const f = fixture(); const result = { networkDeniedHosts: input.hosts, stdout: "already wrote output", createdFiles: ["partial.csv"], exitCode: 0 };
  const observed = await f.consent.observe(result, "local");
  assert.deepEqual(observed.createdFiles, ["partial.csv"]); assert.equal(observed.exitCode, 0);
  assert.equal(f.requests.length, 1); assert.equal(observed.networkPermission?.state, "allowed");
  assert.match(observed.networkPermission!.instruction, /reconcile files and remote side effects/);
  assert.equal(f.epoch.networkPolicy, "none");
});

test("rejects wildcard, URL, IP and oversized host declarations before asking", async () => {
  const f = fixture();
  for (const hosts of [["*.example.org"], ["https://example.org"], ["127.0.0.1"], [], Array(17).fill("a.example.org")]) {
    await assert.rejects(f.consent.request({ ...input, hosts }));
  }
  assert.equal(f.requests.length, 0);
});

test("matching resources include exact hosts, run, Agent and target", async () => {
  const f = fixture();
  await f.consent.request(input); await f.consent.request(input);
  assert.equal(f.requests[0]!.resource, f.requests[1]!.resource);
  await f.consent.request({ ...input, hosts: ["arxiv.org"] });
  await f.consent.request({ ...input, runnerId: "remote" });
  await f.make("child").request(input); await f.make("main", "next-run").request(input);
  assert.equal(new Set(f.requests.map(x => x.resource)).size, 5);
});
