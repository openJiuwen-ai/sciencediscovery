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
import { randomUUID } from "node:crypto";
import { NO_SANDBOX_NETWORK_ACCESS, type PermissionAuthorization, type PermissionEpoch } from "@sciencediscovery/schema";
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
  return { store, permission, epoch, make, requests, consent: make(), revoke: () => { granted = false; }, end: () => { active = false; }, deny: () => { allowed = false; } };
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


test("a multi-host gateway denial still opens a complete card above ordinary summary length", async () => {
  const f = fixture();
  const hosts = Array.from({ length: 16 }, (_, i) => `research-service-${i}.long-scientific-domain.example.org:443`);
  const observed = await f.consent.observe({ networkDeniedHosts: hosts }, "local");
  assert.equal(observed.networkPermission?.state, "allowed");
  assert.equal(f.requests.length, 1);
  for (const host of hosts) assert.ok(f.requests[0]!.summary.includes(host));
  assert.ok(f.requests[0]!.summary.includes("Purpose:"));
});

test("consent unavailable after execution preserves its known terminal output", async () => {
  const f = fixture(); f.end();
  const result = await f.consent.observe({ networkDeniedHosts: input.hosts, exitCode: 1, stdout: "partial output" }, "local");
  assert.equal(result.networkPermission?.state, "blocked");
  assert.equal(result.exitCode, 1); assert.equal(result.stdout, "partial output");
  assert.equal(f.requests.length, 0);
});


for (const mode of ["domain-allowlist", "open"] as const) test(`scoped retry preserves configured ${mode} capability and private filtering`, async () => {
  const f = fixture();
  f.epoch.networkPolicy = mode;
  f.epoch.networkAccess = { ...NO_SANDBOX_NETWORK_ACCESS, mode, allowedDomains: mode === "open" ? [] : ["configured.example.org:443"], revision: "configured" };
  const decision = await f.consent.request(input);
  const epoch = await f.consent.consume(decision.authorizationId, "local");
  assert.equal(epoch.networkAccess!.mode, mode);
  assert.deepEqual(epoch.networkAccess!.allowedDomains, mode === "open" ? [] : ["configured.example.org:443", ...input.hosts]);
  assert.equal(epoch.networkAccess!.egressProxyPolicy, "inherit");
  assert.equal(epoch.networkAccess!.allowPrivateNetwork, false);
  assert.deepEqual(f.epoch.networkAccess.allowedDomains, mode === "open" ? [] : ["configured.example.org:443"]);
});

for (const invalid of ["localhost:8080", "bad_name.example.org:443", "127.0.0.1:80", "*.example.org"]) test(`mixed denial keeps ${invalid} blocked but asks about valid host`, async () => {
  const f = fixture();
  const result = await f.consent.observe({ networkDeniedHosts: [invalid, "pypi.org:443"], exitCode: 1, stdout: "partial" }, "local");
  assert.equal(f.requests.length, 1);
  assert.deepEqual(result.networkPermission?.hosts, ["pypi.org:443"]);
  assert.equal(result.networkPermission?.state, "allowed");
  assert.equal(result.networkPermission?.blockedHosts?.[0]?.host, invalid);
  assert.ok(result.networkPermission!.blockedHosts![0]!.reason);
  assert.match(result.networkPermission!.instruction, /remain blocked.*incomplete/);
  assert.equal(result.stdout, "partial"); assert.equal(result.exitCode, 1);
  const epoch = await f.consent.consume(result.networkPermission!.authorizationId, "local");
  assert.deepEqual(epoch.networkAccess?.allowedDomains, ["pypi.org:443"]);
});

test("unsupported-only and absent denials ask for no permission and never imply successful retrieval", async () => {
  const f = fixture(); const original = { networkDeniedHosts: undefined, exitCode: 0 };
  assert.equal(await f.consent.observe(original, "local"), original);
  const result = await f.consent.observe({ networkDeniedHosts: ["localhost:8080", "bad_name.example.org:443"] }, "local");
  assert.equal(result.networkPermission?.state, "blocked");
  assert.deepEqual(result.networkPermission?.hosts, []);
  assert.equal(result.networkPermission?.authorizationId, undefined);
  assert.equal(result.networkPermission?.blockedHosts?.length, 2);
  assert.equal(f.requests.length, 0);
});

test("network declaration validates purpose, bounded hosts and owning run before creating a card", async () => {
  const f = fixture();
  for (const purpose of [" ", "x".repeat(101)]) await assert.rejects(f.consent.request({ ...input, purpose }), /purpose/);
  await assert.rejects(f.consent.request({ ...input, hosts: ["a".repeat(4201) + ".org"] }), /4200/);
  await assert.rejects(f.consent.request({ ...input, runnerId: "foreign" }), /forbidden/);
  const unowned = createSandboxNetworkConsent({ sessionId: "s", agentId: "main", executionId: "r", store: f.store, permission: f.permission, assertRunner() {} });
  await assert.rejects(unowned.request(input), /owning run/);
  f.store.getSessionRun = async () => undefined;
  await assert.rejects(f.consent.request(input), /ended with its run/);
  assert.equal(f.requests.length, 0);
});

for (const mismatch of ["action", "outcome", "resource"] as const) test(`authorization ${mismatch} mismatch never issues an executable token`, async () => {
  const f = fixture();
  f.permission.requirePrivilege = async request => ({ id: "bad", action: request.action, resource: request.resource,
    outcome: "allowed", [mismatch]: "mismatch" } as unknown as PermissionAuthorization);
  await assert.rejects(f.consent.request(input), /scope mismatch/);
  await assert.rejects(f.consent.consume("bad", "local"), /foreign/);
});

test("one-use authorization without a standing grant is consumed and pending approvals are bounded", async () => {
  const f = fixture();
  f.permission.requirePrivilege = async request => ({ id: randomUUID(), action: request.action, resource: request.resource, outcome: "allowed" } as PermissionAuthorization);
  const once = await f.consent.request(input);
  await f.consent.consume(once.authorizationId, "local");
  await assert.rejects(f.consent.consume(once.authorizationId, "local"), /consumed/);
  for (let i = 0; i < 128; i++) await f.consent.request(input);
  await assert.rejects(f.consent.request(input), /Too many unused/);
});

test("cancellation during decision and run termination after approval issue no usable token", async () => {
  const f = fixture(); const controller = new AbortController();
  f.permission.requirePrivilege = async () => { controller.abort(); throw new Error("wait cancelled"); };
  await assert.rejects(f.consent.request(input, controller.signal), /abort/i);
  f.permission.requirePrivilege = async request => { f.end(); return { id: "ended", action: request.action, resource: request.resource, outcome: "allowed" } as PermissionAuthorization; };
  await assert.rejects(f.consent.request(input), /ended with its run/);
});

test("transport errors and observed rejection preserve incomplete outcomes, including non-Error failures", async () => {
  const f = fixture(); f.permission.requirePrivilege = async () => { throw "connection lost"; };
  const blocked = await f.consent.request(input);
  assert.equal(blocked.state, "blocked"); assert.match(blocked.instruction, /permission unavailable.*incomplete/);
  f.deny(); f.permission.requirePrivilege = async () => { throw new Error("user denied"); };
  const result = await f.consent.observe({ networkDeniedHosts: input.hosts }, "local");
  assert.equal(result.networkPermission?.state, "blocked"); assert.match(result.networkPermission!.instruction, /user denied/);
});
