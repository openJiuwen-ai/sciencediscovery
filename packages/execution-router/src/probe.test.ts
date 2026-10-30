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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "os:windows", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import type { RunnerExecutionCapability, RunnerHealth } from "@sciencediscovery/schema";

import { providerBadgeLabel, providerUnusableMessage } from "./messages.js";
import { ExecutionProbe } from "./probe.js";
import { ExecutionProviderRegistry } from "./registry.js";
import { ExecutionRouter } from "./router.js";

function capability(sandbox: RunnerExecutionCapability["sandbox"], sandboxUsable: boolean): RunnerExecutionCapability {
  return {
    checkedAt: new Date().toISOString(), dependencyAvailable: true, instanceId: "i",
    ready: true, reason: "ready", sandbox, sandboxUsable,
  };
}

function health(available = true): RunnerHealth {
  return {
    cgroupDelegated: false, cgroupMode: "none", cgroupRoot: "", executionAuth: "bearer+hmac-sha256",
    executionTimeoutMs: 0, executionUser: "u", maxFileBytes: 0, maxOutputBytes: 0, platform: "win32" as const,
    scientificEnvs: { available, enabled: available, languages: available ? ["python", "r"] : [], provisioner: available ? "micromamba" : null, startersReady: available },
    service: "runner", version: "v",
  } as unknown as RunnerHealth;
}

function sources(overrides: {
  capability?: () => Promise<RunnerExecutionCapability>;
  health?: () => Promise<RunnerHealth>;
} = {}) {
  return {
    runnerCapability: overrides.capability ?? (async () => capability("none", false)),
    runnerHealth: overrides.health ?? (async () => health()),
  };
}

test("messages are the single wording source (0.B1 §4/§6)", () => {
  assert.equal(providerUnusableMessage("wsl"), "本地沙箱引擎插件未安装——安装后获得 🔒 沙箱执行");
  assert.equal(providerUnusableMessage("remote"), "远程执行未配置——设置页填写 SSH 主机");
  assert.equal(providerBadgeLabel("sandboxed"), "🔒 沙箱执行中");
  assert.equal(providerBadgeLabel("direct"), "⚠️ Windows 直跑（无沙箱隔离）");
  assert.equal(providerBadgeLabel("remote"), "🌐 远程执行中");
});

test("probe aggregates runner capability into the sandboxed predicate", async () => {
  const registry = new ExecutionProviderRegistry([{ id: "windows-direct", available: true, sandboxed: false, badge: "direct" }]);
  const probe = new ExecutionProbe(registry, sources({ capability: async () => capability("bubblewrap", true) }), { wslState: async () => null });
  const cap = await probe.get();
  assert.equal(cap.provider, "windows-direct");
  assert.equal(cap.sandboxed, true);
  assert.equal(cap.scientificEnvs.available, true);
  assert.equal(cap.scientificEnvs.provisioner, "micromamba");
  assert.deepEqual(cap.scientificEnvs.languages, ["python", "r"]);
  assert.equal(cap.wsl, undefined);
});

test("none sandbox maps to sandboxed=false (Provider A)", async () => {
  const registry = new ExecutionProviderRegistry([{ id: "windows-direct", available: true, sandboxed: false, badge: "direct" }]);
  const probe = new ExecutionProbe(registry, sources(), { wslState: async () => null });
  const cap = await probe.get();
  assert.equal(cap.sandboxed, false);
  assert.equal(cap.provider, "windows-direct");
});

test("probe caches per session; refresh re-probes", async () => {
  let capabilityCalls = 0;
  const registry = new ExecutionProviderRegistry([{ id: "windows-direct", available: true, sandboxed: false, badge: "direct" }]);
  const probe = new ExecutionProbe(registry, sources({
    capability: async () => { capabilityCalls += 1; return capability("none", false); },
  }), { wslState: async () => null });
  await probe.get();
  await probe.get();
  assert.equal(capabilityCalls, 1);
  await probe.get(true);
  assert.equal(capabilityCalls, 2);
});

test("probe failure degrades instead of throwing (sandboxed fails closed)", async () => {
  const registry = new ExecutionProviderRegistry([{ id: "windows-direct", available: true, sandboxed: false, badge: "direct" }]);
  const probe = new ExecutionProbe(registry, {
    runnerCapability: async () => { throw new Error("runner down"); },
    runnerHealth: async () => { throw new Error("runner down"); },
  }, { wslState: async () => { throw new Error("wsl.exe missing"); } });
  const cap = await probe.get();
  assert.equal(cap.provider, "windows-direct");
  assert.equal(cap.sandboxed, false);
  assert.equal(cap.scientificEnvs.available, false);
  assert.equal(cap.wsl, undefined);
});

test("probe timeout bounds a hanging source", async () => {
  const registry = new ExecutionProviderRegistry([{ id: "windows-direct", available: true, sandboxed: false, badge: "direct" }]);
  const probe = new ExecutionProbe(registry, {
    runnerCapability: async () => await new Promise<RunnerExecutionCapability>(() => {}),
    runnerHealth: async () => await new Promise<RunnerHealth>(() => {}),
  }, { timeoutMs: 50, wslState: async () => null });
  const cap = await probe.get();
  assert.equal(cap.sandboxed, false);
  assert.equal(cap.scientificEnvs.available, false);
});

test("wsl state passes through when detected (Provider B 三态)", async () => {
  const registry = new ExecutionProviderRegistry([
    { id: "windows-direct", available: true, sandboxed: false, badge: "direct" },
    { id: "wsl", available: true, sandboxed: true, badge: "sandboxed" },
  ]);
  const probe = new ExecutionProbe(registry, sources(), { wslState: async () => ({ distro: "Ubuntu", kind: "ready" }) });
  const cap = await probe.get();
  assert.equal(cap.provider, "wsl");
  assert.equal(cap.sandboxed, false); // 本地 runner 仍无沙箱；B 生效时此项由 B 的 runner 报告
  assert.deepEqual(cap.wsl, { distro: "Ubuntu", kind: "ready" });
});

test("router fires the downgrade hook on sandboxed true→false during refresh (F5.5)", async () => {
  let sandboxUsable = true;
  const registry = new ExecutionProviderRegistry([
    { id: "windows-direct", available: true, sandboxed: false, badge: "direct" },
    { id: "wsl", available: true, sandboxed: true, badge: "sandboxed" },
  ]);
  const events: string[] = [];
  const router = new ExecutionRouter({
    registry,
    sources: sources({ capability: async () => capability("bubblewrap", sandboxUsable) }),
    probe: { wslState: async () => null },
    onProviderDowngrade: (event) => { events.push(`${event.from.provider}->${event.to.provider}`); },
  });
  const before = await router.capability();
  assert.equal(before.sandboxed, true);
  registry.update({ id: "wsl", available: false, sandboxed: true, badge: "sandboxed", unavailableReason: "插件已卸载" });
  sandboxUsable = false;
  const after = await router.capability(true);
  assert.equal(after.sandboxed, false);
  assert.deepEqual(events, ["wsl->windows-direct"]);
});

test("router does not fire the hook without refresh or without a transition", async () => {
  const registry = new ExecutionProviderRegistry([{ id: "windows-direct", available: true, sandboxed: false, badge: "direct" }]);
  let calls = 0;
  const router = new ExecutionRouter({
    registry,
    sources: sources(),
    probe: { wslState: async () => null },
    onProviderDowngrade: () => { calls += 1; },
  });
  await router.capability();
  await router.capability();       // cached, no transition
  await router.capability(true);   // refresh but stays unsandboxed
  assert.equal(calls, 0);
});

test("default registry stubs B/C with unified wording (F5.4)", async () => {
  const router = new ExecutionRouter({ sources: sources(), probe: { wslState: async () => null } });
  const providers = router.providers();
  assert.equal(providers.length, 3);
  const wsl = providers.find((entry) => entry.id === "wsl")!;
  const remote = providers.find((entry) => entry.id === "remote")!;
  assert.equal(wsl.available, false);
  assert.equal(wsl.unavailableReason, "本地沙箱引擎插件未安装——安装后获得 🔒 沙箱执行");
  assert.equal(remote.available, false);
  assert.equal(remote.unavailableReason, "远程执行未配置——设置页填写 SSH 主机");
  const selection = router.select("wsl");
  assert.equal(selection.ok, false);
  if (!selection.ok) assert.equal(selection.code, "PROVIDER_UNAVAILABLE");
});
