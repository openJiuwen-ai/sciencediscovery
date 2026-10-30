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
 * 能力探测聚合 + 会话级缓存（F5.2）+ refresh 热切换（F5.5）。
 *
 * 探测协议复用既有 wire 格式，不新增（0.B1 §3）：
 * - 读能力   GET  /execution-capability（runner，RunnerClient.executionCapability）
 * - 环境面   GET  /health（runner）——scientificEnvs 的唯一来源
 * - WSL 三态  Windows 侧本地探测（platform 适配层，不进 runner）
 * - 超时     探测层 15s 对 WSL 冷启动可能不足，路由层统一包 30s
 *
 * 缓存纪律：结果缓存到会话级（本进程）；插件安装/卸载 → refresh 删缓存
 * 重探（机制同 sandbox-capability 的 detect*Capability refresh 语义）。
 * 探测失败降级：任何一项探测抛错都不使聚合抛错——该项按"不可用"落结果，
 * 保障角标与 enforcement 谓词始终有答案。
 */
import type { RunnerExecutionCapability, RunnerHealth } from "@sciencediscovery/schema";

import { detectWslState } from "./platform/index.js";
import type { ExecutionProviderRegistry } from "./registry.js";
import type { ExecutionCapability, WslState } from "./types.js";

/** 0.B1 §3：路由层探测预算（WSL 冷启动重估） */
export const ROUTER_PROBE_TIMEOUT_MS = 30_000;

export interface ExecutionProbeSources {
  /** GET /execution-capability（runner） */
  runnerCapability: () => Promise<RunnerExecutionCapability>;
  /** GET /health（runner）——scientificEnvs 的唯一来源 */
  runnerHealth: () => Promise<RunnerHealth>;
}

export interface ExecutionProbeOptions {
  timeoutMs?: number;
  /** 测试注入用；缺省走 platform 适配层 */
  wslState?: () => Promise<WslState | null>;
  log?: (message: string) => void;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`execution probe timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolvePromise(value); },
      (error: unknown) => { clearTimeout(timer); rejectPromise(error instanceof Error ? error : new Error(String(error))); },
    );
  });
}

export class ExecutionProbe {
  private cached?: ExecutionCapability;
  private pending?: Promise<ExecutionCapability>;

  constructor(
    private readonly registry: ExecutionProviderRegistry,
    private readonly sources: ExecutionProbeSources,
    private readonly options: ExecutionProbeOptions = {},
  ) {}

  /** 最近一次成功的聚合结果；未探过为 undefined。 */
  get last(): ExecutionCapability | undefined {
    return this.cached;
  }

  /**
   * 读缓存；refresh=true 删缓存重探（F5.5 热切换）。单飞：并发调用共享
   * 同一次探测。
   */
  async get(refresh = false): Promise<ExecutionCapability> {
    if (this.pending) return this.pending;
    if (!refresh && this.cached) return this.cached;
    this.pending = this.probe().then((value) => (this.cached = value)).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async safe<T>(label: string, operation: () => Promise<T>): Promise<T | undefined> {
    try {
      return await withTimeout(operation(), this.options.timeoutMs ?? ROUTER_PROBE_TIMEOUT_MS);
    } catch (error) {
      // 探测失败降级：单项不可用，聚合继续。sandboxed 落 false 是
      // fail-closed——F6 谓词在拿不准时按无沙箱处理。
      this.options.log?.(`[execution-router] ${label} probe failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  private async probe(): Promise<ExecutionCapability> {
    const selection = this.registry.select();
    const capability = await this.safe("runner capability", this.sources.runnerCapability);
    const health = await this.safe("runner health", this.sources.runnerHealth);
    const wsl = await this.safe("wsl state", this.options.wslState ?? detectWslState);

    const scientificEnvs = health?.scientificEnvs;
    return {
      provider: selection.provider,
      // 沙箱谓词：本地 runner 报告的 sandbox 不是 none 且可用。探测失败
      // 按无沙箱处理（fail-closed，见 safe()）。
      sandboxed: capability ? capability.sandbox !== "none" && capability.sandboxUsable : false,
      ...(wsl ? { wsl } : {}),
      scientificEnvs: {
        available: scientificEnvs?.available ?? false,
        languages: scientificEnvs?.languages ?? [],
        provisioner: scientificEnvs?.provisioner === "micromamba" ? "micromamba" : null,
      },
    };
  }
}
