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
 * Provider 注册表 + 路由决策（F5.1）。
 *
 * 决策纪律（0.B1 §7）：路由层不做自动择优——用户显式选择优先；无显式
 * 选择时按优先级 B > C > A 取第一个可用项（A 恒可用，所以无选择时
 * 必然有解）。对不可用的显式选择返回稳定错误码 PROVIDER_UNAVAILABLE，
 * UI 据此渲染插件中心入口。
 */
import { providerUnusableMessage } from "./messages.js";
import type { ExecutionProvider, ExecutionProviderDescriptor } from "./types.js";

/** 默认解析优先级：B > C > A（features/F5-Provider路由层.md F5.1） */
export const PROVIDER_PRIORITY: readonly ExecutionProvider[] = ["wsl", "remote", "windows-direct"];

/** 路由决策结果：ok 携带生效 Provider；失败携带稳定错误码与统一话术 */
export type ProviderSelection =
  | { ok: true; provider: ExecutionProvider }
  | { ok: false; code: "PROVIDER_UNAVAILABLE"; provider: ExecutionProvider; reason: string };

/**
 * 路由决策全分支：
 * - preference 给了且可用 → 生效；
 * - preference 给了但不可用/未注册 → PROVIDER_UNAVAILABLE（reason 取注册表
 *   的 unavailableReason，缺省回退到统一话术）；
 * - 未给 preference → 按 B > C > A 取第一个 available；
 * - 全部不可用（仅理论情形：A 恒可用）→ PROVIDER_UNAVAILABLE(windows-direct)。
 */
export function selectExecutionProvider(
  descriptors: readonly ExecutionProviderDescriptor[],
  preference?: ExecutionProvider,
): ProviderSelection {
  if (preference) {
    const chosen = descriptors.find((entry) => entry.id === preference);
    if (chosen?.available) return { ok: true, provider: chosen.id };
    return {
      ok: false,
      code: "PROVIDER_UNAVAILABLE",
      provider: preference,
      reason: chosen?.unavailableReason ?? providerUnusableMessage(preference),
    };
  }
  for (const id of PROVIDER_PRIORITY) {
    if (descriptors.find((entry) => entry.id === id)?.available) return { ok: true, provider: id };
  }
  return {
    ok: false,
    code: "PROVIDER_UNAVAILABLE",
    provider: "windows-direct",
    reason: providerUnusableMessage("windows-direct"),
  };
}

/**
 * 可变的 Provider 注册表。P1 里 B/C 是留桩（available=false，F5.4）；
 * F5.5 热切换与 mock 插拔测试通过 update() 改条目后重新决策，
 * 无需重启进程。
 */
export class ExecutionProviderRegistry {
  private readonly entries = new Map<ExecutionProvider, ExecutionProviderDescriptor>();

  constructor(initial: readonly ExecutionProviderDescriptor[]) {
    for (const entry of initial) this.entries.set(entry.id, { ...entry });
  }

  list(): ExecutionProviderDescriptor[] {
    return [...this.entries.values()].map((entry) => ({ ...entry }));
  }

  get(id: ExecutionProvider): ExecutionProviderDescriptor | undefined {
    const entry = this.entries.get(id);
    return entry ? { ...entry } : undefined;
  }

  /** 插入或整体替换一个条目（插件装/卸、mock 插拔、热切换探测结果回写） */
  update(descriptor: ExecutionProviderDescriptor): void {
    this.entries.set(descriptor.id, { ...descriptor });
  }

  select(preference?: ExecutionProvider): ProviderSelection {
    return selectExecutionProvider(this.list(), preference);
  }
}
