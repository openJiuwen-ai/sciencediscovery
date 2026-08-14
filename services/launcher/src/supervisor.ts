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
 * Ordered process supervision for `serve`.
 *
 * The start order and health gating mirror `scripts/start-stack.sh` local
 * mode — gateway, then runner, then the control API that serves the Web UI —
 * so the binary and the repository launcher bring the same stack up the same
 * way. Any service exiting takes the whole stack down, because a half-running
 * stack silently loses tool execution or agent turns.
 */
import { spawn, type ChildProcess } from "node:child_process";

export interface ServiceDefinition {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Endpoint polled until it answers before the next service starts. */
  healthUrl?: string;
}

export interface SupervisorOptions {
  /** Poll budget per service; the payload's first gateway import is slow. */
  healthAttempts?: number;
  healthIntervalMs?: number;
  /** Grace period between SIGTERM and SIGKILL during shutdown. */
  shutdownGraceMs?: number;
  log?: (message: string) => void;
}

const DEFAULT_HEALTH_ATTEMPTS = 300;
const DEFAULT_HEALTH_INTERVAL_MS = 200;
const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

async function probeHealth(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

interface RunningService {
  child: ChildProcess;
  definition: ServiceDefinition;
  /** Resolves once the process is gone, with how it ended. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  settled: boolean;
}

export class Supervisor {
  private readonly running: RunningService[] = [];
  private readonly options: Required<Omit<SupervisorOptions, "log">> & { log: (message: string) => void };
  private stopping = false;

  constructor(options: SupervisorOptions = {}) {
    this.options = {
      healthAttempts: options.healthAttempts ?? DEFAULT_HEALTH_ATTEMPTS,
      healthIntervalMs: options.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS,
      shutdownGraceMs: options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS,
      log: options.log ?? ((message: string) => process.stderr.write(`${message}\n`)),
    };
  }

  /** Spawn each service in order, gating on health before starting the next. */
  async start(services: readonly ServiceDefinition[]): Promise<void> {
    for (const definition of services) {
      this.options.log(`Starting ${definition.name}...`);
      const child = spawn(definition.command, definition.args, {
        cwd: definition.cwd,
        env: definition.env,
        stdio: "inherit",
      });
      const service: RunningService = {
        child,
        definition,
        settled: false,
        exited: new Promise((resolveExit) => {
          child.on("exit", (code, signal) => {
            service.settled = true;
            resolveExit({ code, signal });
          });
          child.on("error", (error) => {
            service.settled = true;
            this.options.log(`${definition.name} could not be started: ${error.message}`);
            resolveExit({ code: 127, signal: null });
          });
        }),
      };
      this.running.push(service);
      if (definition.healthUrl) await this.waitHealthy(service, definition.healthUrl);
    }
  }

  private async waitHealthy(service: RunningService, url: string): Promise<void> {
    for (let attempt = 0; attempt < this.options.healthAttempts; attempt += 1) {
      if (service.settled) {
        const { code, signal } = await service.exited;
        throw new Error(
          `${service.definition.name} exited before becoming healthy `
          + `(${signal ? `signal ${signal}` : `status ${String(code)}`}). See the output above.`,
        );
      }
      if (await probeHealth(url)) return;
      await sleep(this.options.healthIntervalMs);
    }
    throw new Error(`${service.definition.name} did not become healthy at ${url}.`);
  }

  /**
   * Resolve when the first service exits. `serve` awaits this so that a dead
   * gateway or runner brings the stack down instead of leaving a broken UI up.
   */
  async waitForFirstExit(): Promise<{ name: string; code: number | null; signal: NodeJS.Signals | null }> {
    return await Promise.race(
      this.running.map(async (service) => {
        const outcome = await service.exited;
        return { name: service.definition.name, ...outcome };
      }),
    );
  }

  /** SIGTERM every service in reverse start order, escalating to SIGKILL. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    for (const service of [...this.running].reverse()) {
      if (!service.settled) service.child.kill("SIGTERM");
    }
    const pending = this.running.filter((service) => !service.settled);
    await Promise.race([
      Promise.all(pending.map((service) => service.exited)),
      sleep(this.options.shutdownGraceMs),
    ]);
    for (const service of this.running) {
      if (!service.settled) {
        this.options.log(`${service.definition.name} ignored SIGTERM; sending SIGKILL.`);
        service.child.kill("SIGKILL");
      }
    }
    await Promise.all(this.running.map((service) => service.exited));
  }
}
