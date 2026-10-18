// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { resolveEvolveInstallation, type EvolveInstallContext, type EvolveInstallation } from "./evolve-install.js";

export interface EvolveRuntimeStatus {
  state: "not_initialized" | "installing" | "ready" | "error";
  canInitialize: boolean;
  error?: string;
}
export interface EvolveRuntimeIo {
  install: (initialize: boolean) => Promise<EvolveInstallation | undefined>;
  spawn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  fetch: typeof fetch;
  startupTimeoutMs?: number;
  /** Explicit source-stack runtimes retain operator-controlled extra-package provisioning. */
  allowRuntimeProvisioning?: boolean;
}
/** Sidecar-owned settings only; never inherit model/provider credentials or HOME. */
export function evolveChildEnvironment(env: NodeJS.ProcessEnv, allowProvisioning: boolean): NodeJS.ProcessEnv {
  const keys = ["PATH", "LANG", "TMPDIR", "SCIENCE_AGENT_EVOLVE_CANDIDATE_DIR", "SCIENCE_AGENT_EVOLVE_LOG_LEVEL",
    "SCIENCE_AGENT_LOG_LEVEL", "SCIENCE_AGENT_LOG_DIR", "SCIENCE_AGENT_LOG_MAX_BYTES", "SCIENCE_AGENT_LOG_BACKUP_COUNT"];
  // Source/container runtimes explicitly retain their operator's provisioning
  // policy. Managed pinned runtimes never receive mutable-index/proxy settings.
  if (allowProvisioning) keys.push("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    "UV_INDEX_URL", "UV_DEFAULT_INDEX", "UV_EXTRA_INDEX_URL", "PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL", "SSL_CERT_FILE", "SSL_CERT_DIR");
  const result: NodeJS.ProcessEnv = {};
  for (const key of keys) if (env[key] !== undefined) result[key] = env[key];
  return result;
}

/** Same documented startup budget as the source stack's health wait. */
export function evolveStartupTimeoutMs(env: NodeJS.ProcessEnv): number {
  const seconds = Number(env.SCIENCE_DISCOVERY_HEALTH_TIMEOUT_SECONDS ?? 60);
  const milliseconds = seconds * 1000;
  if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(milliseconds) || seconds <= 0) throw new Error("SCIENCE_DISCOVERY_HEALTH_TIMEOUT_SECONDS must be positive whole seconds");
  return milliseconds;
}

/** Bind first, then publish the owned socket; no select-free-port/close/rebind race. */
export const EVOLVE_ENTRY = String.raw`
import socket, sys
s = socket.socket()
s.bind(("127.0.0.1", 0))
s.listen(128)
print("EVOLVE_PORT=" + str(s.getsockname()[1]), flush=True)
import uvicorn
from sciencediscovery_evolve.server import app
uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False)).run(sockets=[s])
`;

/** Launcher owns the child, lifecycle and private configuration, including after UI initialization. */
export class EvolveRuntime {
  private state: EvolveRuntimeStatus = { state: "not_initialized", canInitialize: true };
  private child?: ChildProcess;
  private exited?: Promise<void>;
  private pending?: Promise<void>;
  private stopping = false;
  private readonly controller = new AbortController();
  private endpoint?: { url: string; internalToken: string };
  private readonly io: EvolveRuntimeIo;
  private readonly context: Pick<EvolveInstallContext, "dataDir" | "env">;
  constructor(context: EvolveInstallContext);
  constructor(context: Pick<EvolveInstallContext, "dataDir" | "env">, io: EvolveRuntimeIo);
  constructor(context: EvolveInstallContext | Pick<EvolveInstallContext, "dataDir" | "env">, io?: EvolveRuntimeIo) {
    this.context = context;
    // The one-argument overload supplies full installation metadata; explicit
    // source runtimes supply their already-provisioned interpreter via io.
    this.io = io ?? { install: (initialize) => resolveEvolveInstallation({ ...context as EvolveInstallContext, signal: this.controller.signal }, initialize), spawn, fetch: globalThis.fetch };
  }
  status(): EvolveRuntimeStatus { return { ...this.state }; }
  connection(): { url: string; internalToken: string } | undefined { return this.state.state === "ready" ? this.endpoint : undefined; }
  async start(initialize = false): Promise<void> {
    if (this.stopping) throw new Error("Evolve launcher is stopping");
    if (this.state.state === "ready") return;
    if (this.pending) return await this.pending;
    this.pending = this.startOnce(initialize).finally(() => { this.pending = undefined; });
    return await this.pending;
  }
  private async startOnce(initialize: boolean): Promise<void> {
    this.state = { state: initialize ? "installing" : "not_initialized", canInitialize: true };
    try {
      const install = await this.io.install(initialize);
      if (!install || this.stopping) return;
      const child = this.io.spawn(install.python, ["-I", "-u", "-c", EVOLVE_ENTRY], {
        cwd: install.root,
        env: {
          ...evolveChildEnvironment(this.context.env, Boolean(this.io.allowRuntimeProvisioning)),
          PYTHONNOUSERSITE: "1",
          ...(!this.io.allowRuntimeProvisioning ? { UV_NO_INDEX: "1", UV_NO_CACHE: "1", UV_NO_CONFIG: "1", PIP_NO_INDEX: "1", PIP_CONFIG_FILE: "/dev/null" } : {}),
          SCIENCE_AGENT_DATA_DIR: this.context.dataDir,
          SCIENCE_AGENT_EVOLVE_INTERNAL_TOKEN: install.token,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.child = child;
      let exited = false;
      this.exited = new Promise((resolveExit) => {
        const gone = () => {
          exited = true;
          if (this.child === child) {
            this.endpoint = undefined;
            if (!this.stopping) this.state = { state: "error", canInitialize: true, error: "Evolve stopped. Select Init Evolve to restart it." };
          }
          resolveExit();
        };
        child.once("exit", gone);
        child.once("error", gone);
      });
      // Drain output without retaining/logging process data, paths or credentials.
      child.stderr?.resume();
      let buffer = "";
      let port: number | undefined;
      child.stdout?.on("data", (bytes: Buffer) => {
        buffer = (buffer + bytes.toString("utf8")).slice(-4096);
        const match = buffer.match(/(?:^|\n)EVOLVE_PORT=(\d+)\r?\n/);
        if (match) {
          const value = Number(match[1]);
          if (value > 0 && value < 65536) port = value;
        }
      });
      const deadline = Date.now() + (this.io.startupTimeoutMs ?? evolveStartupTimeoutMs(this.context.env));
      const ownsLiveChild = () => !this.stopping && !exited && this.child === child && child.exitCode === null && child.signalCode === null;
      while (ownsLiveChild() && Date.now() < deadline) {
        if (port) {
          const url = `http://127.0.0.1:${port}`;
          try {
            const health = await this.io.fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000), redirect: "error" });
            if (health.ok && (await health.json() as { status?: string }).status === "healthy") {
              if (!ownsLiveChild()) break;
              const auth = await this.io.fetch(`${url}/runs/readiness-${randomUUID()}/stop`, {
                method: "POST", headers: { authorization: `Bearer ${install.token}` },
                signal: AbortSignal.timeout(2_000), redirect: "error",
              });
              // Awaited responses can outlive either the child or shutdown.
              if (!ownsLiveChild()) break;
              if (!auth.ok) throw new Error("Evolve authentication failed");
              this.endpoint = { url, internalToken: install.token };
              this.state = { state: "ready", canInitialize: true };
              return;
            }
          } catch { /* Imports/startup may still be in progress; bounded by deadline. */ }
        }
        await delay(100);
      }
      throw new Error("Evolve did not become ready");
    } catch {
      await this.stopChild();
      if (!this.stopping) this.state = { state: "error", canInitialize: true, error: "Evolve could not initialize. Check network access and free disk space, then select Init Evolve to retry." };
    }
  }
  private async stopChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    this.endpoint = undefined;
    child.kill("SIGTERM");
    await Promise.race([this.exited, delay(5_000, undefined, { ref: false })]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await this.exited;
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.controller.abort();
    await this.stopChild();
    await this.pending;
    this.state = { state: "not_initialized", canInitialize: false };
  }
}

export interface EvolveControl { env: NodeJS.ProcessEnv; close: () => Promise<void>; runtime: EvolveRuntime }
/** Authenticated loopback channel; endpoint/token never reach public status responses. */
export async function startEvolveControl(context: EvolveInstallContext): Promise<EvolveControl> {
  return await createEvolveControl(new EvolveRuntime(context), context.signal);
}
export async function createEvolveControl(runtime: EvolveRuntime, signal?: AbortSignal): Promise<EvolveControl> {
  signal?.throwIfAborted();
  let closeOwned = () => runtime.stop();
  const abort = () => { void closeOwned(); };
  signal?.addEventListener("abort", abort, { once: true });
  try { await runtime.start(false); signal?.throwIfAborted(); }
  catch (error) { signal?.removeEventListener("abort", abort); await runtime.stop(); throw error; }
  const token = randomBytes(32).toString("base64url");
  const expected = Buffer.from(`Bearer ${token}`);
  const server: Server = createServer(async (request, response) => {
    try {
      const actual = Buffer.from(request.headers.authorization ?? "");
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        response.writeHead(401).end(); return;
      }
      if (request.url === "/init" && request.method === "POST") await runtime.start(true);
      else if (request.url !== "/status" || request.method !== "GET") { response.writeHead(404).end(); return; }
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ ...runtime.status(), connection: runtime.connection() }));
    } catch {
      response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ state: "error", canInitialize: false, error: "Evolve launcher is stopping or unavailable." }));
    }
  });
  try {
    await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  } catch (error) { signal?.removeEventListener("abort", abort); await runtime.stop(); throw error; }
  const port = (server.address() as { port: number }).port;
  const control: EvolveControl = {
    runtime,
    env: { SCIENCE_AGENT_EVOLVE_CONTROL_URL: `http://127.0.0.1:${port}`, SCIENCE_AGENT_EVOLVE_CONTROL_TOKEN: token },
    close: async () => {
      signal?.removeEventListener("abort", abort);
      // Close idle status connections and stop owned work even if Init is in progress.
      server.closeAllConnections();
      await Promise.all([runtime.stop(), new Promise<void>((resolveClose) => server.close(() => resolveClose()))]);
    },
  };
  closeOwned = control.close;
  if (signal?.aborted) { await control.close(); signal.throwIfAborted(); }
  return control;
}
