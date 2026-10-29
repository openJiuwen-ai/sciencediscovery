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
const { test } = createTest(import.meta.url, { tags: ["category:ut"] });
import assert from "node:assert/strict";

import type { WslCommandRunner } from "./types.js";
import { detectWslState, parseDismFeatureState, parseWslDistroList, WSL_RELEASES_URL } from "./win32.js";

test("parseWslDistroList decodes UTF-16LE with NUL padding", () => {
  const output = "Ubuntu-22.04\0\0\r\n\0docker-desktop\0\r\n";
  assert.deepEqual(parseWslDistroList(output), ["Ubuntu-22.04", "docker-desktop"]);
});

test("parseWslDistroList tolerates BOM, blank lines and junk", () => {
  assert.deepEqual(parseWslDistroList("\uFEFF\r\n\r\n"), []);
  assert.deepEqual(parseWslDistroList("  \r\n\x00\x00"), []);
});

test("parseDismFeatureState reads the State line", () => {
  assert.equal(parseDismFeatureState("功能名称 : Microsoft-Windows-Subsystem-Linux\r\n状态 : 已禁用\r\n", 0), "disabled");
  assert.equal(parseDismFeatureState("Feature Name : Microsoft-Windows-Subsystem-Linux\r\nState : Enabled\r\n", 0), "enabled");
  assert.equal(parseDismFeatureState("State : Disabled with Payload Removed\r\n", 0), "disabled");
});

test("parseDismFeatureState maps unknown feature to absent (Error 87)", () => {
  assert.equal(parseDismFeatureState("错误: 87\r\n", 87), "absent");
  assert.equal(parseDismFeatureState("Error: 0x800f080c\r\n", 87), "absent");
  assert.equal(parseDismFeatureState("random failure\r\n", 11), "unknown");
});

/** 剧本驱动的 wsl.exe/dism.exe 桩 */
function scripted(steps: Record<string, { status: number | null; stdout?: string; stderr?: string }>): WslCommandRunner {
  const seen: string[] = [];
  return async (command, args) => {
    const key = `${command} ${args.join(" ")}`;
    seen.push(key);
    const step = steps[key];
    if (!step) return { status: 1, stderr: "unexpected command", stdout: "" };
    return { status: step.status ?? 0, stderr: step.stderr ?? "", stdout: step.stdout ?? "" };
  };
}

test("distro installed → ready with the first distro name", async () => {
  const state = await detectWslState(scripted({
    "wsl.exe -l -q": { status: 0, stdout: "Ubuntu-22.04\0\r\n\0" },
  }));
  assert.deepEqual(state, { distro: "Ubuntu-22.04", kind: "ready" });
});

test("platform installed without distro → ready with empty distro (F15 导入后变为具体名)", async () => {
  const state = await detectWslState(scripted({
    "wsl.exe -l -q": { status: 1, stderr: "no distributions" },
    "wsl.exe --status": { status: 0, stdout: "默认版本: 2" },
  }));
  assert.deepEqual(state, { distro: "", kind: "ready" });
});

test("component present but disabled → inbox-enableable", async () => {
  const state = await detectWslState(scripted({
    "wsl.exe -l -q": { status: 1 },
    "wsl.exe --status": { status: 1, stderr: "未安装" },
    "dism.exe /Online /Get-FeatureInfo /FeatureName:Microsoft-Windows-Subsystem-Linux": { status: 0, stdout: "State : Disabled\r\n" },
  }));
  assert.deepEqual(state, { kind: "inbox-enableable" });
});

test("clean legacy machine → needs-download with the GitHub release link", async () => {
  const state = await detectWslState(scripted({
    "wsl.exe -l -q": { status: 1 },
    "wsl.exe --status": { status: 1 },
    "dism.exe /Online /Get-FeatureInfo /FeatureName:Microsoft-Windows-Subsystem-Linux": { status: 87, stdout: "错误: 87" },
  }));
  assert.deepEqual(state, { kind: "needs-download", url: WSL_RELEASES_URL });
});

test("dism enabled but wsl.exe broken → ready, conservative fallback", async () => {
  const state = await detectWslState(scripted({
    "wsl.exe -l -q": { status: 1 },
    "wsl.exe --status": { status: 1 },
    "dism.exe /Online /Get-FeatureInfo /FeatureName:Microsoft-Windows-Subsystem-Linux": { status: 0, stdout: "State : Enabled\r\n" },
  }));
  assert.deepEqual(state, { distro: "", kind: "ready" });
});
