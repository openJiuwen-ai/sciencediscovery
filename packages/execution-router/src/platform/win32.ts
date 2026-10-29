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

/**
 * WSL 三态检测的 win32 实现（0.8c 结论）。纯解析函数单独导出以便单测；
 * detectWslState 的命令执行器可注入（测试用桩）。
 *
 * 三态（0.B1 §2 WslState）：
 *   ready            平台已装（商店版/MSIX/inbox 已启用）；distro 为默认分发
 *                    名，平台可用但无分发时为空串（F15 插件导入专用实例后
 *                    变为具体名）
 *   inbox-enableable 组件 inbox 存在但未启用（需 UAC + 重启）
 *   needs-download   干净机（旧版 22H2）：给 GitHub release 直链
 */
import { execFile } from "node:child_process";

import type { WslState } from "../types.js";
import type { WslCommandRunner } from "./types.js";

/** 旧版干净机的 WSL MSIX 下载地址（0.B1 §2 needs-download.url） */
export const WSL_RELEASES_URL = "https://github.com/microsoft/WSL/releases/latest";

/** Per-command budget. dism on a quiet box answers in seconds; 10s is ample. */
const WSL_COMMAND_TIMEOUT_MS = 10_000;

const defaultRunner: WslCommandRunner = (command, args) => new Promise((resolvePromise) => {
  execFile(command, args, {
    encoding: "buffer",
    maxBuffer: 1024 * 1024,
    timeout: WSL_COMMAND_TIMEOUT_MS,
    windowsHide: true,
  }, (error, stdout, stderr) => {
    resolvePromise({
      // wsl.exe prints UTF-16LE for `-l`; --status is only read via exit code.
      // 任何失败（spawn 缺失、非零退出、超时）统一为 null，调用方按不可用降级。
      status: error ? null : 0,
      stderr: Buffer.from(stderr).toString("utf8"),
      stdout: Buffer.from(stdout).toString("utf16le"),
    });
  });
});

/**
 * `wsl -l -q` 的分发名列表。输出是 UTF-16LE，一行一个名字，可能带
 * 前导 BOM 与控制字符；解析失败（异常输出）返回空列表而不是抛错——
 * 探测层要求"探测失败降级"。
 */
export function parseWslDistroList(stdout: string): string[] {
  return stdout
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/[\0-\x1F]/g, "").trim())
    .filter(Boolean);
}

/** `dism /Online /Get-FeatureInfo` 输出中的功能状态（跟随系统区域，中英文都认）。 */
export type DismFeatureState = "enabled" | "disabled" | "absent" | "unknown";

export function parseDismFeatureState(stdout: string, status: number | null): DismFeatureState {
  if (status !== 0) {
    // Error 87 / 0x800f080c: 功能名未知——组件不存在（旧版干净机）。
    return /87|0x800f080c/i.test(stdout) ? "absent" : "unknown";
  }
  const match = /(?:State|状态)\s*:\s*(.+)/i.exec(stdout);
  if (!match) return "unknown";
  const value = match[1]!.trim();
  if (/enabled|已启用/i.test(value)) return "enabled";
  if (/disabled|已禁用/i.test(value)) return "disabled";
  return "unknown";
}

export async function detectWslState(run: WslCommandRunner = defaultRunner): Promise<WslState> {
  const listed = await run("wsl.exe", ["-l", "-q"]);
  const distros = listed.status === 0 ? parseWslDistroList(listed.stdout) : [];
  if (distros.length) return { distro: distros[0]!, kind: "ready" };

  const status = await run("wsl.exe", ["--status"]);
  if (status.status === 0) {
    // 平台已装、尚无分发：F15 导入专用实例后 distro 变为具体名。
    return { distro: "", kind: "ready" };
  }

  const feature = await run("dism.exe", ["/Online", "/Get-FeatureInfo", "/FeatureName:Microsoft-Windows-Subsystem-Linux"]);
  const featureState = parseDismFeatureState(feature.stdout, feature.status);
  if (featureState === "disabled" || featureState === "unknown") return { kind: "inbox-enableable" };
  if (featureState === "enabled") return { distro: "", kind: "ready" };
  return { kind: "needs-download", url: WSL_RELEASES_URL };
}
