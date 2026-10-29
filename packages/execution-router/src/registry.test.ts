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
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { currentExecutionSandboxed, type ExecutionProviderDescriptor } from "./types.js";
import { ExecutionProviderRegistry, PROVIDER_PRIORITY, selectExecutionProvider } from "./registry.js";

function descriptor(id: ExecutionProviderDescriptor["id"], available: boolean): ExecutionProviderDescriptor {
  return { id, available, badge: id === "windows-direct" ? "direct" : id === "remote" ? "remote" : "sandboxed", sandboxed: id !== "windows-direct" };
}

test("priority order is B > C > A", () => {
  assert.deepEqual(PROVIDER_PRIORITY, ["wsl", "remote", "windows-direct"]);
});

test("no preference picks the highest-priority available provider", () => {
  const all = [descriptor("windows-direct", true), descriptor("wsl", true), descriptor("remote", true)];
  assert.deepEqual(selectExecutionProvider(all), { ok: true, provider: "wsl" });
  assert.deepEqual(selectExecutionProvider([descriptor("windows-direct", true), descriptor("remote", true)]), { ok: true, provider: "remote" });
  assert.deepEqual(selectExecutionProvider([descriptor("windows-direct", true)]), { ok: true, provider: "windows-direct" });
});

test("explicit preference wins over priority", () => {
  const all = [descriptor("windows-direct", true), descriptor("wsl", true), descriptor("remote", true)];
  assert.deepEqual(selectExecutionProvider(all, "windows-direct"), { ok: true, provider: "windows-direct" });
  assert.deepEqual(selectExecutionProvider(all, "remote"), { ok: true, provider: "remote" });
});

test("unavailable preference returns PROVIDER_UNAVAILABLE with registry reason", () => {
  const reason = "本地沙箱引擎插件未安装——安装后获得 🔒 沙箱执行";
  const wslStub: ExecutionProviderDescriptor = { ...descriptor("wsl", false), unavailableReason: reason };
  const selection = selectExecutionProvider([descriptor("windows-direct", true), wslStub], "wsl");
  assert.equal(selection.ok, false);
  if (!selection.ok) {
    assert.equal(selection.code, "PROVIDER_UNAVAILABLE");
    assert.equal(selection.provider, "wsl");
    assert.equal(selection.reason, reason);
  }
});

test("unregistered preference falls back to the unified message", () => {
  const selection = selectExecutionProvider([descriptor("windows-direct", true)], "remote");
  assert.equal(selection.ok, false);
  if (!selection.ok) assert.equal(selection.reason, "远程执行未配置——设置页填写 SSH 主机");
});

test("all-unavailable is a stable error, not a throw (A is恒可用 in practice)", () => {
  const selection = selectExecutionProvider([descriptor("windows-direct", false)]);
  assert.equal(selection.ok, false);
  if (!selection.ok) assert.equal(selection.provider, "windows-direct");
});

test("registry update plugs and unplugs providers (mock 插拔)", () => {
  const registry = new ExecutionProviderRegistry([
    { id: "windows-direct", available: true, sandboxed: false, badge: "direct" },
    { id: "wsl", available: false, sandboxed: true, badge: "sandboxed", unavailableReason: "stub" },
  ]);
  assert.deepEqual(registry.select(), { ok: true, provider: "windows-direct" });
  registry.update({ id: "wsl", available: true, sandboxed: true, badge: "sandboxed" });
  assert.deepEqual(registry.select(), { ok: true, provider: "wsl" });
  registry.update({ id: "wsl", available: false, sandboxed: true, badge: "sandboxed", unavailableReason: "uninstalled" });
  assert.deepEqual(registry.select(), { ok: true, provider: "windows-direct" });
  const unplugged = registry.select("wsl");
  assert.equal(unplugged.ok, false);
  if (!unplugged.ok) assert.equal(unplugged.reason, "uninstalled");
});

test("registry copies descriptors on read and write", () => {
  const initial = descriptor("remote", false);
  const registry = new ExecutionProviderRegistry([descriptor("windows-direct", true), initial]);
  initial.available = true; // mutate after construction
  assert.equal(registry.get("remote")?.available, false);
  const listed = registry.list();
  listed[0]!.available = false;
  assert.equal(registry.get("windows-direct")?.available, true);
});

test("currentExecutionSandboxed is the F6 predicate", () => {
  assert.equal(currentExecutionSandboxed({
    provider: "windows-direct", sandboxed: false,
    scientificEnvs: { available: true, languages: ["python"], provisioner: "micromamba" },
  }), false);
  assert.equal(currentExecutionSandboxed({
    provider: "wsl", sandboxed: true,
    scientificEnvs: { available: true, languages: ["python"], provisioner: "micromamba" },
  }), true);
});
