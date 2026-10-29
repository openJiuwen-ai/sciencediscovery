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

import type { WslState } from "../types.js";

/**
 * OS adaptation surface for WSL detection (0.B2 分层约定 §2; 0.B1 §3:
 * 「WSL 三态 | Windows 侧本地探测，不进 runner，进 platform 适配层」).
 * Consumers import only platform/index.ts; platform files are never imported
 * directly.
 */
export interface WslPlatform {
  /**
   * WSL 三态检测。win32 实跑 `wsl.exe` / `dism.exe`；posix 恒 null
   * （WSL 不适用，ExecutionCapability.wsl 留空）。
   */
  detectWslState(run?: WslCommandRunner): Promise<WslState | null>;
}

/** 可注入的命令执行器：测试用桩，生产默认 execFile wsl.exe/dism.exe。 */
export type WslCommandRunner = (command: string, args: string[]) => Promise<{ status: number | null; stdout: string; stderr: string }>;
