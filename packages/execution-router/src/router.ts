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
 * 路由层门面：注册表 + 探测 + Provider 降级钩子（0.B1 §5）。
 *
 * 降级规则：B/C → A（插件卸载 / WSL 实例丢失 / 远端断连）时，全部
 * `always_allow` 会话强制降为 `ask_for_dangerous`（复用 setApprovalMode
 * 的 epoch/kernel-teardown 语义——钩子由 API 层注入实现，路由层只发事件）。
 */
import { providerUnusableMessage } from "./messages.js";
import { ExecutionProbe, type ExecutionProbeOptions, type ExecutionProbeSources } from "./probe.js";
import { ExecutionProviderRegistry } from "./registry.js";
import type { ExecutionCapability, ExecutionProvider, ExecutionProviderDescriptor } from "./types.js";

export interface ProviderDowngradeEvent {
  from: ExecutionCapability;
  to: ExecutionCapability;
  /** 被强制降级的会话数（钩子实现回写，便于审计与测试断言）。 */
  forcedSessions: number;
}

export interface ExecutionRouterOptions {
  sources: ExecutionProbeSources;
  onProviderDowngrade?: (event: ProviderDowngradeEvent) => void | Promise<void>;
  probe?: ExecutionProbeOptions;
  /** 测试可直接注入注册表（mock 插拔）；缺省建 P1 默认注册表。 */
  registry?: ExecutionProviderRegistry;
}

/** P1 默认注册表（F5.4 留桩语义）：A 恒可用；B/C 接口就位、available=false。 */
export function defaultProviderRegistry(): ExecutionProviderRegistry {
  const descriptors: ExecutionProviderDescriptor[] = [
    { id: "windows-direct", available: true, sandboxed: false, badge: "direct" },
    { id: "wsl", available: false, sandboxed: true, badge: "sandboxed", unavailableReason: providerUnusableMessage("wsl") },
    { id: "remote", available: false, sandboxed: true, badge: "remote", unavailableReason: providerUnusableMessage("remote") },
  ];
  return new ExecutionProviderRegistry(descriptors);
}

export class ExecutionRouter {
  readonly registry: ExecutionProviderRegistry;
  private readonly probe: ExecutionProbe;
  private readonly onProviderDowngrade?: (event: ProviderDowngradeEvent) => void | Promise<void>;

  constructor(options: ExecutionRouterOptions) {
    this.registry = options.registry ?? defaultProviderRegistry();
    this.probe = new ExecutionProbe(this.registry, options.sources, options.probe);
    this.onProviderDowngrade = options.onProviderDowngrade;
  }

  /** 当前 Provider 视图（注册表条目，含 B/C 留桩话术）。 */
  providers(): ExecutionProviderDescriptor[] {
    return this.registry.list();
  }

  /**
   * 能力视图。refresh=true（F5.5 热切换）重探测；若发生
   * sandboxed true→false 的降级，触发钩子。
   */
  async capability(refresh = false): Promise<ExecutionCapability> {
    const previous = this.probe.last;
    const next = await this.probe.get(refresh);
    if (refresh && previous && previous.sandboxed && !next.sandboxed && this.onProviderDowngrade) {
      const event: ProviderDowngradeEvent = { from: previous, forcedSessions: 0, to: next };
      await this.onProviderDowngrade(event);
    }
    return next;
  }

  /** 路由决策（显式选择入口；无 preference 走注册表默认优先级）。 */
  select(preference?: ExecutionProvider) {
    return this.registry.select(preference);
  }
}
