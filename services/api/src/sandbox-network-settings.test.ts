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

import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import { epochSandboxNetworkAccess } from "@science-agent/schema";

import { SessionStore } from "./store.js";
import {
  normalizeSandboxNetworkSettings,
  sandboxNetworkAccess,
  sandboxNetworkRevision,
} from "./store/sandbox-network.js";

async function scratchStore(label: string, after: (cleanup: () => Promise<void>) => void): Promise<SessionStore> {
  const root = resolve(process.cwd(), ".tmp", `${label}-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  after(() => rm(root, { force: true, recursive: true }));
  const store = new SessionStore(root);
  await store.load();
  return store;
}

test("sandbox network settings are normalized and rejected when malformed", () => {
  assert.deepEqual(normalizeSandboxNetworkSettings({}), {
    allowPrivateNetwork: false,
    allowedDomains: [],
    mode: "none",
  });
  assert.deepEqual(
    normalizeSandboxNetworkSettings({ allowedDomains: ["B.example.org", "a.example.org", "B.example.org"], mode: "domain-allowlist" }),
    { allowPrivateNetwork: false, allowedDomains: ["a.example.org", "b.example.org"], mode: "domain-allowlist" },
  );
  assert.throws(() => normalizeSandboxNetworkSettings({ mode: "open" }), /none or domain-allowlist/);
  assert.throws(() => normalizeSandboxNetworkSettings({ mode: "domain-allowlist" }), /at least one allowed domain/);
  assert.throws(
    () => normalizeSandboxNetworkSettings({ allowedDomains: ["10.0.0.1"], mode: "domain-allowlist" }),
    /not an IP address/,
  );
  assert.throws(() => normalizeSandboxNetworkSettings({ proxyUrl: "http://x" }), /Unknown sandbox network setting/);
});

test("the policy revision follows the content, not the write", () => {
  const first = { allowPrivateNetwork: false, allowedDomains: ["b.example.org", "a.example.org"], mode: "domain-allowlist" as const };
  const same = { allowPrivateNetwork: false, allowedDomains: ["a.example.org", "b.example.org"], mode: "domain-allowlist" as const };
  assert.equal(
    sandboxNetworkRevision(normalizeSandboxNetworkSettings(first)),
    sandboxNetworkRevision(normalizeSandboxNetworkSettings(same)),
  );
  const changed = normalizeSandboxNetworkSettings({ allowedDomains: ["a.example.org"], mode: "domain-allowlist" });
  assert.notEqual(sandboxNetworkRevision(normalizeSandboxNetworkSettings(first)), sandboxNetworkRevision(changed));
  assert.equal(sandboxNetworkRevision({ allowPrivateNetwork: false, allowedDomains: [], mode: "none" }), "none");
  assert.deepEqual(sandboxNetworkAccess({ allowPrivateNetwork: true, allowedDomains: ["x.example.org"], mode: "none" }), {
    allowPrivateNetwork: false,
    allowedDomains: [],
    mode: "none",
    revision: "none",
  });
});

test("new Permission Epochs snapshot the policy and a policy change rotates open Sessions", async (context) => {
  const store = await scratchStore("sandbox-network-epoch", context.after.bind(context));
  const project = await store.createProject("Sandbox network");
  const session = await store.createSession(project.id, "Session", {}, {}, { allowUnconfiguredModel: true });

  const initial = store.getSessionPermissionEpoch(session.id)!;
  assert.equal(initial.networkPolicy, "none");
  assert.deepEqual(epochSandboxNetworkAccess(initial).allowedDomains, []);

  const saved = await store.replaceSandboxNetworkSettings({
    allowedDomains: ["api.example.org"],
    mode: "domain-allowlist",
  });
  assert.deepEqual(saved.rotatedSessionIds, [session.id]);
  const rotated = store.getSessionPermissionEpoch(session.id)!;
  assert.notEqual(rotated.id, initial.id);
  assert.equal(rotated.networkPolicy, "domain-allowlist");
  assert.deepEqual(epochSandboxNetworkAccess(rotated).allowedDomains, ["api.example.org"]);
  assert.match(rotated.memoryLostReason ?? "", /persistent kernel and shell memory was lost/);

  // The previous epoch keeps its snapshot: it is the immutable record of what
  // the executions recorded against it were allowed to reach.
  const previous = store.getPermissionEpoch(initial.id)!;
  assert.equal(previous.networkPolicy, "none");
  assert.deepEqual(epochSandboxNetworkAccess(previous).allowedDomains, []);

  // Saving the same policy again is a no-op: no revision change, no rotation.
  const again = await store.replaceSandboxNetworkSettings({
    allowedDomains: ["API.example.org"],
    mode: "domain-allowlist",
  });
  assert.deepEqual(again.rotatedSessionIds, []);
  assert.equal(store.getSessionPermissionEpoch(session.id)!.id, rotated.id);

  // Turning it back off rotates again and returns to the no-network snapshot.
  const off = await store.replaceSandboxNetworkSettings({ mode: "none" });
  assert.deepEqual(off.rotatedSessionIds, [session.id]);
  assert.equal(store.getSessionPermissionEpoch(session.id)!.networkPolicy, "none");
});

test("the saved policy survives a reload and reaches later epochs", async (context) => {
  const root = resolve(process.cwd(), ".tmp", `sandbox-network-reload-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  context.after(() => rm(root, { force: true, recursive: true }));

  const store = new SessionStore(root);
  await store.load();
  await store.replaceSandboxNetworkSettings({
    allowPrivateNetwork: true,
    allowedDomains: ["*.example.org"],
    mode: "domain-allowlist",
  });

  const reopened = new SessionStore(root);
  await reopened.load();
  assert.deepEqual(reopened.getSandboxNetworkSettings(), {
    allowPrivateNetwork: true,
    allowedDomains: ["*.example.org"],
    mode: "domain-allowlist",
  });
  const project = await reopened.createProject("Later");
  const session = await reopened.createSession(project.id, "Session", {}, {}, { allowUnconfiguredModel: true });
  const epoch = reopened.getSessionPermissionEpoch(session.id)!;
  assert.equal(epoch.networkPolicy, "domain-allowlist");
  assert.equal(epochSandboxNetworkAccess(epoch).allowPrivateNetwork, true);
});
