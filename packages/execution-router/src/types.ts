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
 * Provider routing layer types — frozen by client/docs-dev/Provider路由层接口约定.md
 * (0.B1 v1.0). This "Provider" is the *execution host* choice (where the Runner
 * and its sandbox live), one layer above sandbox-capability's SandboxProvider
 * (which sandbox backend a Linux/macOS Runner uses). The two never modify each
 * other.
 */
import type { SandboxCapability, SeatbeltCapability } from "@sciencediscovery/sandbox-capability";

/** 执行 Provider 枚举——与 sandbox-capability 的 SandboxProvider 是两个层，互不修改对方 */
export type ExecutionProvider = "windows-direct" | "wsl" | "remote";

/** Provider 注册表条目 */
export interface ExecutionProviderDescriptor {
  id: ExecutionProvider;
  /** 是否已安装/可启用：A 恒 true；B = 沙箱插件已装且 WSL 就绪；C = 用户已配置远端 */
  available: boolean;
  /** 该 Provider 是否提供沙箱隔离——F6 enforcement 的唯一谓词来源 */
  sandboxed: boolean;
  /** 角标与引导话术的单一来源（照抄 sandbox-capability 的 *Message 模式） */
  badge: ExecutionBadge;
  unavailableReason?: string;   // 面向用户的统一话术，如「本地沙箱引擎插件未安装」
}

/** 角标状态机（0.B1 §4） */
export type ExecutionBadge = "sandboxed" | "direct" | "remote"; // 🔒 / ⚠️ / 🌐

/** 路由层能力视图 = 探测层结果的聚合，不重探 */
export interface ExecutionCapability {
  provider: ExecutionProvider;          // 当前生效
  sandboxed: boolean;
  sandbox?: SandboxCapability | SeatbeltCapability;  // 来自 sandbox-capability 缓存，原样透传
  wsl?: WslState;                        // Provider B 三态（§3）
  remote?: { host: string; reachable: boolean };
  scientificEnvs: { available: boolean; provisioner: "micromamba" | null; languages: string[] };
}

/** WSL 三态检测（0.8c 结论：取代"启用内置组件"单一假设） */
export type WslState =
  | { kind: "ready"; distro: string }                 // 商店版/MSIX 已装且实例已导入
  | { kind: "inbox-enableable" }                      // 组件 inbox 可启用，需 UAC + 重启
  | { kind: "needs-download"; url: string };          // 旧版 22H2 干净机，GitHub release 直链

/** F6 enforcement 唯一谓词（0.B1 §5，逐字冻结） */
export function currentExecutionSandboxed(cap: ExecutionCapability): boolean {
  return cap.sandboxed; // Provider B/C = true，A = false
}
