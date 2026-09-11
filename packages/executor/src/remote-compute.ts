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

import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";

import type {
  RemoteConnectLogEntry,
  RemoteHostCapabilities,
  RemoteHostEndpoint,
  RemoteHostTarget,
  RemoteRunnerStatus,
} from "@sciencediscovery/schema";
import { seedRemoteProvisioner } from "./remote-provisioner.js";
import { shortErrorMessage } from "@sciencediscovery/operational-logging";
import { loadRunnerExecutable, type RunnerExecutable } from "./runner-executable.js";
import { RunnerClient } from "./runner-client.js";
import {
  SshConnection,
  SshHostKeyUntrustedError,
  type SshHostKeyChallenge,
  type SshSession,
  type SshTarget,
} from "./ssh-connection.js";

export interface RemoteCommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

/**
 * Receives bounded diagnostics whose error text has already been redacted by
 * the executor. Implementations may persist or forward these fields directly.
 */
export interface RemoteComputeLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

const noopLogger: RemoteComputeLogger = {
  info() {},
  warn() {},
  error() {},
};

function errorMessage(error: unknown): string {
  return shortErrorMessage(error, 1_000);
}

export interface RemoteComputeClientOptions {
  logger?: RemoteComputeLogger;
  /** Cache of pinned provisioners that can be uploaded to offline machines. */
  provisionerCacheDir?: string;
  transport?: RemoteTransport;
}

/**
 * Everything one SSH machine needs to be reached: where it is, who to log in
 * as, what secret proves it, and which host key the user already accepted.
 * Probing, deployment and the runner tunnel all take the same value, so they
 * cannot end up using different credentials or a different trusted key.
 */
export interface RemoteSshAccess extends SshTarget {}

/**
 * The single seam for talking SSH. Probing, deployment and the runner tunnel all
 * go through it, so a test can stand in for the whole protocol and none of the
 * three can quietly reach a machine a different way.
 */
export interface RemoteTransport {
  open(target: RemoteSshAccess): Promise<SshSession>;
  run(target: RemoteSshAccess, script: string, timeoutMs: number): Promise<RemoteCommandResult>;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * The SSH destination the user typed. An SSH config alias, a hostname and an
 * IPv4 address are all the same thing here, so this only rejects values that
 * would not be a single safe destination.
 */
export function validateSshDestination(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._-]{1,255}$/.test(normalized)) {
    throw new Error("An SSH machine must be an alias, hostname, or IP address using only letters, numbers, dots, underscores, and hyphens");
  }
  return normalized;
}

export function validateSshPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("The SSH port must be a whole number between 1 and 65535");
  }
  return port;
}

export function validateRunnerCommand(value: string): string {
  const command = value.trim() || "sciencediscovery-runner";
  if (command.length > 500 || !/^(?:[A-Za-z0-9._-]+|\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+)$/.test(command)) {
    throw new Error("Remote runner command must be an executable name or absolute POSIX path without arguments");
  }
  return command;
}

/** One connection per command: the product owns the client, so there is no agent or config to inherit. */
export class NativeSshTransport implements RemoteTransport {
  async open(target: RemoteSshAccess): Promise<SshSession> {
    return await SshConnection.open({ ...target, destination: validateSshDestination(target.destination) });
  }

  async run(target: RemoteSshAccess, script: string, timeoutMs: number): Promise<RemoteCommandResult> {
    const connection = await this.open(target);
    try {
      return await connection.run(script, timeoutMs);
    } finally {
      connection.close();
    }
  }
}

function probeScript(runnerCommand: string): string {
  return `set +e
printf 'platform='; uname -s 2>/dev/null || true
printf 'architecture='; uname -m 2>/dev/null || true
printf 'cpu='; getconf _NPROCESSORS_ONLN 2>/dev/null || true
printf 'memory_kib='; awk '/MemTotal:/ {print $2; exit}' /proc/meminfo 2>/dev/null || true
printf 'gpu='; if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -n 1; else printf '\n'; fi
printf 'cuda='; if command -v nvcc >/dev/null 2>&1; then nvcc --version 2>/dev/null | awk '/release/ {print $5}' | tr -d ','; else printf '\n'; fi
printf 'conda='; if command -v conda >/dev/null 2>&1 || command -v micromamba >/dev/null 2>&1; then printf '1\n'; else printf '0\n'; fi
printf 'modules='; if command -v module >/dev/null 2>&1 || command -v modulecmd >/dev/null 2>&1; then printf '1\n'; else printf '0\n'; fi
printf 'containers='; found=''; for runtime in apptainer singularity docker podman; do if command -v "$runtime" >/dev/null 2>&1; then found="\${found}\${found:+,}$runtime"; fi; done; printf '%s\n' "$found"
printf 'scratch='; found=''; for path in /scratch /tmp "\${SCRATCH:-}"; do if [ -n "$path" ] && [ -d "$path" ] && [ -w "$path" ]; then found="\${found}\${found:+,}$path"; fi; done; printf '%s\n' "$found"
printf 'runner='; if command -v -- ${shellQuote(runnerCommand)} >/dev/null 2>&1; then printf '1\n'; else printf '0\n'; fi
printf 'node='; if command -v node >/dev/null 2>&1; then node --version 2>/dev/null || printf '\n'; else printf '\n'; fi
`;
}

function parseProbe(stdout: string): RemoteHostCapabilities {
  const values = new Map(stdout.split(/\r?\n/).flatMap((line) => {
    const separator = line.indexOf("=");
    return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1)]] : [];
  }));
  const cpu = Number(values.get("cpu"));
  const memoryKib = Number(values.get("memory_kib"));
  return {
    conda: values.get("conda") === "1",
    architecture: values.get("architecture")?.trim() || null,
    containerRuntimes: values.get("containers")?.split(",").filter(Boolean) ?? [],
    cpuCores: Number.isSafeInteger(cpu) && cpu > 0 ? cpu : null,
    cuda: values.get("cuda")?.trim() || null,
    gpu: values.get("gpu")?.trim() || null,
    memoryBytes: Number.isSafeInteger(memoryKib) && memoryKib > 0 ? memoryKib * 1024 : null,
    modules: values.get("modules") === "1",
    nodeVersion: values.get("node")?.trim() || null,
    platform: values.get("platform")?.trim() || null,
    probedAt: new Date().toISOString(),
    runnerCommandAvailable: values.get("runner") === "1",
    scratchPaths: [...new Set(values.get("scratch")?.split(",").filter(Boolean) ?? [])],
    slurm: false, // Historical capability field; standalone SLURM jobs are no longer supported.
  };
}

export interface RemoteRunnerConnectOptions {
  /** Resolve the shipped SEA for the actual remote architecture; injectable in tests. */
  executable?: (architecture: string) => Promise<RunnerExecutable>;
  /** Local runner version, reported beside the remote one so differences show. */
  localVersion?: string;
  /** Connection token of a self-deployed runner; required for `direct` hosts. */
  token?: string;
}

/** Where the product keeps its own files on a remote host. */
function remoteDataDirScript(): string {
  return "data_dir=\"${XDG_DATA_HOME:-$HOME/.local/share}/sciencediscovery/remote-runner\"";
}

function directBaseUrl(endpoint: RemoteHostEndpoint): string {
  const authority = endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host;
  return `${endpoint.protocol}://${authority}:${endpoint.port}`;
}

/** Resolves the credentials and trusted key a registered machine is reached with. */
export type RemoteSshAccessResolver = (hostId: string) => Promise<RemoteSshAccess>;

export class RemoteComputeClient {
  readonly transport: RemoteTransport;
  private readonly logger: RemoteComputeLogger;
  private readonly provisionerCacheDir?: string;
  private readonly runnerConnections = new Map<string, {
    client: RunnerClient;
    status: RemoteRunnerStatus;
    stop?: () => void;
  }>();
  private readonly runnerStatuses = new Map<string, RemoteRunnerStatus>();
  private readonly connectLogs = new Map<string, RemoteConnectLogEntry[]>();

  /** The connection story so far for one host, oldest first. */
  connectLog(hostId: string): RemoteConnectLogEntry[] {
    return structuredClone(this.connectLogs.get(hostId) ?? []);
  }

  /**
   * Append one line to a host's connection story. Bounded: a connect that
   * retries forever must not grow memory forever, and the earliest lines are
   * the least useful once the story gets long.
   */
  private logConnect(hostId: string, line: string): void {
    const entries = this.connectLogs.get(hostId) ?? [];
    entries.push({ at: new Date().toISOString(), line });
    if (entries.length > 200) entries.splice(0, entries.length - 200);
    this.connectLogs.set(hostId, entries);
  }

  constructor(
    /** Only used to import an existing `ssh_config` entry; never to reach a machine. */
    readonly sshConfigPath: string,
    private readonly resolveAccess: RemoteSshAccessResolver = async () => {
      throw new Error("This machine has no stored SSH credentials");
    },
    options: RemoteComputeClientOptions = {},
  ) {
    this.logger = options.logger ?? noopLogger;
    this.provisionerCacheDir = options.provisionerCacheDir;
    this.transport = options.transport ?? new NativeSshTransport();
  }

  /**
   * Read a machine's capabilities over SSH. The destination is whatever the user
   * typed — alias, hostname or IP. Host identity is checked against the key the
   * user accepted in this product, so an unknown or changed key fails closed
   * with a challenge the settings page can act on.
   */
  async probe(access: RemoteSshAccess, runnerCommandValue = "sciencediscovery-runner"): Promise<RemoteHostCapabilities> {
    const started = Date.now();
    const runnerCommand = validateRunnerCommand(runnerCommandValue);
    this.logger.info("remote_host_probe_started", {
      connectionKind: "ssh",
      destination: access.destination,
      port: access.port,
    });
    try {
      const result = await this.transport.run(access, probeScript(runnerCommand), 20_000);
      if (result.exitCode !== 0) {
        throw new Error(`SSH probe failed (${result.exitCode}): ${result.stderr.trim() || "authentication or connection failed"}`);
      }
      const capabilities = parseProbe(result.stdout);
      this.logger.info("remote_host_probe_succeeded", {
        connectionKind: "ssh",
        destination: access.destination,
        durationMs: Date.now() - started,
        platform: capabilities.platform,
      });
      return capabilities;
    } catch (error) {
      this.logger.error("remote_host_probe_failed", {
        connectionKind: "ssh",
        destination: access.destination,
        durationMs: Date.now() - started,
        errorMessage: errorMessage(error),
      });
      throw error;
    }
  }

  /** The key a machine currently presents, for the settings page to offer for trust. */
  async readHostKey(access: RemoteSshAccess): Promise<SshHostKeyChallenge> {
    return await SshConnection.readHostKey({ ...access, destination: validateSshDestination(access.destination) });
  }

  /**
   * Capabilities of a runner the user deployed themselves. There is no shell on
   * this path, so the runner's own health report is the only source; the token
   * is exercised against an authenticated endpoint so registering with a wrong
   * token fails here rather than at the first execution.
   */
  async probeDirect(endpoint: RemoteHostEndpoint, token: string): Promise<RemoteHostCapabilities> {
    const started = Date.now();
    this.logger.info("remote_host_probe_started", {
      connectionKind: "direct",
      destination: endpoint.host,
      port: endpoint.port,
      protocol: endpoint.protocol,
    });
    try {
      const client = new RunnerClient(directBaseUrl(endpoint), token);
      const health = await client.health();
      await client.status().catch(() => {
        throw new Error("The runner rejected this token");
      });
      const capabilities: RemoteHostCapabilities = {
        conda: false,
        containerRuntimes: [],
        cpuCores: null,
        cuda: null,
        gpu: null,
        memoryBytes: null,
        modules: false,
        nodeVersion: null,
        platform: health.platform === "linux" ? "Linux" : health.platform,
        probedAt: new Date().toISOString(),
        runnerCommandAvailable: true,
        scratchPaths: [],
        slurm: false,
      };
      this.logger.info("remote_host_probe_succeeded", {
        connectionKind: "direct",
        destination: endpoint.host,
        durationMs: Date.now() - started,
        platform: capabilities.platform,
      });
      return capabilities;
    } catch (error) {
      this.logger.error("remote_host_probe_failed", {
        connectionKind: "direct",
        destination: endpoint.host,
        durationMs: Date.now() - started,
        errorMessage: errorMessage(error),
      });
      throw error;
    }
  }

  runnerStatus(hostId: string): RemoteRunnerStatus {
    return structuredClone(this.runnerStatuses.get(hostId) ?? { hostId, state: "disconnected" });
  }

  async runnerStatusWithResources(hostId: string): Promise<RemoteRunnerStatus> {
    const status = this.runnerStatus(hostId);
    if (status.state !== "ready") return status;
    try {
      const resources = await this.runnerClient(hostId).resources();
      // A concurrent disconnect must not resurrect a ready card or stale metrics.
      if (this.runnerStatus(hostId).connectedAt !== status.connectedAt || this.runnerStatus(hostId).state !== "ready") {
        return this.runnerStatus(hostId);
      }
      return { ...status, resources };
    } catch {
      return { ...this.runnerStatus(hostId), resourcesError: "Metrics unavailable. Refresh or reconnect an up-to-date Runner." };
    }
  }

  runnerClient(hostId: string): RunnerClient {
    const connection = this.runnerConnections.get(hostId);
    if (!connection || connection.status.state !== "ready") throw new Error("Remote runner is not connected");
    return connection.client;
  }

  /**
   * Make sure the remote host has a runner to start, and report where it lives.
   *
   * A pre-installed executable is used as-is. Otherwise the product deploys the
   * runner it ships with, keyed by the bundle's content hash, so reconnecting to
   * an already-deployed host transfers nothing.
   */
  private async prepareSshRunner(host: RemoteHostTarget, access: RemoteSshAccess, executable = loadRunnerExecutable): Promise<{
    dataDir: string;
    deployed: boolean;
    startCommand: string;
  }> {
    const capabilities = host.capabilities!;
    const runnerCommand = validateRunnerCommand(host.runnerCommand);
    const deploy = !capabilities.runnerCommandAvailable;
    this.logConnect(host.id, deploy
      ? "No Runner found on the machine; preparing its data directory before deployment…"
      : "Runner command found on the machine; preparing its data directory…");
    const script = [
      "set -eu",
      "test \"$(uname -s)\" = Linux",
      remoteDataDirScript(),
      "mkdir -p -- \"$data_dir/run\"",
      "chmod 700 -- \"$data_dir\" \"$data_dir/run\"",
      // Each runner owns and removes its socket on exit. Age alone does not
      // distinguish an orphan from another connection's long-running runner.
      "printf 'architecture='; uname -m",
      "printf 'data_dir=%s\\n' \"$data_dir\"",
      "",
    ].join("\n");
    const result = await this.transport.run(access, script, 180_000);
    if (result.exitCode !== 0) {
      throw new Error(`Remote runner deployment failed (${result.exitCode}): ${result.stderr.trim() || "the SSH command failed"}`);
    }
    const dataDir = /^data_dir=(.+)$/m.exec(result.stdout)?.[1]?.trim();
    if (!dataDir?.startsWith("/")) throw new Error("The remote host did not report its ScienceDiscovery data directory");
    const architecture = /^architecture=(.+)$/m.exec(result.stdout)?.[1]?.trim() ?? "";
    this.logConnect(host.id, `Remote data directory ready: ${dataDir} (${architecture || "unknown architecture"})`);
    let startCommand = shellQuote(runnerCommand);
    if (deploy) {
      const binary = await executable(architecture);
      const expectedArch = architecture === "x86_64" ? "x64" : architecture === "aarch64" ? "arm64" : undefined;
      if (!expectedArch || binary.architecture !== expectedArch || !/^[a-f0-9]{64}$/.test(binary.id)) throw new Error("Runner SEA artifact does not match the remote Linux architecture");
      const destination = `${dataDir}/bin/${binary.id}`;
      const stage = `${dataDir}/bin/.upload-${randomBytes(12).toString("hex")}`;
      const connection = await this.transport.open(access);
      try {
        const check = await connection.run([
          "set -eu", `mkdir -p -- ${shellQuote(`${dataDir}/bin`)}`, `chmod 700 -- ${shellQuote(`${dataDir}/bin`)}`,
          "command -v sha256sum >/dev/null 2>&1 || { echo 'sha256sum is required to verify the Runner binary' >&2; exit 1; }",
          `if [ -x ${shellQuote(destination)} ] && [ "$(sha256sum ${shellQuote(destination)} | cut -d ' ' -f 1)" = ${shellQuote(binary.id)} ]; then printf 'reused\\n'; fi`,
        ].join("\n"), 20_000);
        if (check.exitCode) throw new Error(`Runner deployment check failed: ${check.stderr.trim()}`);
        if (check.stdout.trim() !== "reused") {
          this.logConnect(host.id, `Uploading the Runner binary (${binary.architecture}) — this is the slow step on a first connect…`);
          await connection.upload(binary.path, stage);
          const installed = await connection.run([
            "set -eu",
            `test "$(sha256sum ${shellQuote(stage)} | cut -d ' ' -f 1)" = ${shellQuote(binary.id)} || { echo 'Runner binary checksum mismatch' >&2; exit 1; }`,
            `chmod 700 -- ${shellQuote(stage)}`, `mv -f -- ${shellQuote(stage)} ${shellQuote(destination)}`,
          ].join("\n"), 30_000);
          if (installed.exitCode) throw new Error(`Runner deployment failed: ${installed.stderr.trim()}`);
          this.logConnect(host.id, "Runner binary uploaded and verified (sha256).");
        } else {
          this.logConnect(host.id, "The Runner binary is already deployed; reusing it.");
        }
      } finally {
        // Only this transfer's staging file is removed; live versions and all
        // remote workspaces remain untouched, including on cancellation.
        await connection.run(`rm -f -- ${shellQuote(stage)}`, 5_000).catch(() => undefined);
        connection.close();
      }
      startCommand = shellQuote(destination);
    }
    await this.seedRemoteProvisioner(host.id, access, dataDir, architecture);
    return {
      dataDir,
      deployed: deploy,
      startCommand,
    };
  }

  /**
   * Give the machine the micromamba it cannot fetch for itself.
   *
   * Never fatal: a machine may legitimately be here without managed
   * environments, and this control plane may itself be offline. A connection
   * that works for executions must not be refused because an optional
   * convenience could not be arranged — the Runner reports the missing
   * provisioner in its own setup status, and now says what to do about it.
   */
  private async seedRemoteProvisioner(
    hostId: string,
    access: RemoteSshAccess,
    dataDir: string,
    architecture: string,
  ): Promise<boolean> {
    if (!this.provisionerCacheDir) return false;
    this.logConnect(hostId, "Checking the managed provisioner (micromamba)…");
    const seeded = await seedRemoteProvisioner({
      access,
      architecture,
      cacheDir: this.provisionerCacheDir,
      dataDir,
      transport: this.transport,
    }).catch(() => false);
    this.logConnect(hostId, seeded
      ? "Managed provisioner is in place."
      : "Managed provisioner not seeded; the Runner will report how to fix that if it matters.");
    return seeded;
  }

  async connectRunner(host: RemoteHostTarget, options: RemoteRunnerConnectOptions = {}): Promise<RemoteRunnerStatus> {
    const { localVersion } = options;
    if (host.status !== "ready" || !host.capabilities) throw new Error("Remote host is not ready");
    const started = Date.now();
    await this.disconnectRunner(host.id, "reconnect");
    this.runnerStatuses.set(host.id, { hostId: host.id, ...(localVersion ? { localVersion } : {}), state: "connecting" });
    this.logger.info("remote_runner_connection_started", {
      connectionKind: host.connectionKind,
      hostId: host.id,
      ...(host.endpoint ? {
        destination: host.endpoint.host,
        port: host.endpoint.port,
        protocol: host.endpoint.protocol,
      } : {}),
    });
    // A fresh attempt starts a fresh story; the page polls it while this call
    // is still in flight.
    this.connectLogs.set(host.id, []);
    this.logConnect(host.id, host.connectionKind === "direct"
      ? `Connecting to the runner at ${host.endpoint?.host ?? host.alias}:${host.endpoint?.port ?? "?"}…`
      : `Connecting to ${host.alias} over SSH…`);
    try {
      const connected = host.connectionKind === "direct"
        ? await this.connectDirectRunner(host, options)
        : await this.connectSshRunner(host, options);
      this.logger.info("remote_runner_connection_succeeded", {
        connectionKind: host.connectionKind,
        deployed: connected.deployed ?? false,
        durationMs: Date.now() - started,
        hostId: host.id,
        remoteVersion: connected.remoteVersion,
        versionMismatch: connected.versionMismatch ?? false,
      });
      return connected;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Remote runner connection failed";
      this.logConnect(host.id, `Failed: ${message}`);
      const failed: RemoteRunnerStatus = {
        error: message,
        hostId: host.id,
        // An untrusted key travels with the status so the settings page can
        // offer to trust it rather than only showing a failure.
        ...(error instanceof SshHostKeyUntrustedError ? { hostKeyChallenge: error.challenge } : {}),
        ...(localVersion ? { localVersion } : {}),
        state: "error",
      };
      this.runnerStatuses.set(host.id, failed);
      this.logger.error("remote_runner_connection_failed", {
        connectionKind: host.connectionKind,
        durationMs: Date.now() - started,
        errorMessage: errorMessage(error),
        hostId: host.id,
      });
      return structuredClone(failed);
    }
  }

  /**
   * Connect to a runner the user started on another machine. The token is the
   * whole access control here, so it is checked against an authenticated
   * endpoint before the connection counts as ready: `/health` is deliberately
   * unauthenticated and would accept any token.
   */
  private async connectDirectRunner(host: RemoteHostTarget, options: RemoteRunnerConnectOptions): Promise<RemoteRunnerStatus> {
    if (!host.endpoint) throw new Error("This runner has no address; re-register it with an IP address and port");
    const token = options.token?.trim();
    if (!token) throw new Error("This runner needs its connection token; re-register the machine with the token it was started with");
    const client = new RunnerClient(directBaseUrl(host.endpoint), token);
    const health = await client.health().catch((error: unknown) => {
      throw new Error(`Could not reach the runner at ${host.endpoint!.host}:${host.endpoint!.port}: ${error instanceof Error ? error.message : "connection failed"}`);
    });
    this.logConnect(host.id, `The runner answered (version ${health.runnerVersion}); checking the token…`);
    if (health.platform !== "linux") {
      throw new Error(`Remote runners must run on Linux; ${host.alias} reports ${health.platform}`);
    }
    await client.status().catch(() => {
      throw new Error("The runner rejected this token. Re-register the machine with the token it was started with.");
    });
    this.logConnect(host.id, "Token accepted; the runner is ready.");
    const status: RemoteRunnerStatus = {
      connectedAt: new Date().toISOString(),
      hostId: host.id,
      ...(options.localVersion ? { localVersion: options.localVersion } : {}),
      remoteVersion: health.runnerVersion,
      state: "ready",
      ...(options.localVersion ? { versionMismatch: options.localVersion !== health.runnerVersion } : {}),
    };
    this.runnerConnections.set(host.id, { client, status });
    this.runnerStatuses.set(host.id, status);
    return structuredClone(status);
  }

  private async connectSshRunner(host: RemoteHostTarget, options: RemoteRunnerConnectOptions): Promise<RemoteRunnerStatus> {
    const { localVersion } = options;
    if (host.capabilities!.platform !== "Linux") throw new Error("SSH remote runner supports Linux hosts only");
    const access = await this.resolveAccess(host.id);
    const prepared = await this.prepareSshRunner(host, access, options.executable);
    const token = randomBytes(32).toString("base64url");
    // The runner listens on a per-connection Unix socket instead of a port, so
    // the remote host exposes nothing to its network and two connections never
    // collide on one address.
    const socketPath = `${prepared.dataDir}/run/${randomBytes(8).toString("hex")}.sock`;
    if (Buffer.byteLength(socketPath) > 100) {
      throw new Error(`The remote data directory path is too long for a Unix socket: ${prepared.dataDir}`);
    }
    const script = [
      "set -eu",
      "test \"$(uname -s)\" = Linux",
      `exec env SCIENCE_AGENT_RUNNER_SOCKET=${shellQuote(socketPath)} SCIENCE_AGENT_RUNNER_TOKEN=${shellQuote(token)} SCIENCE_AGENT_DATA_DIR=${shellQuote(prepared.dataDir)} ${prepared.startCommand}`,
      "",
    ].join("\n");

    const connection = await this.transport.open(access);
    this.logConnect(host.id, "SSH session established; starting the Runner on the machine…");
    let remoteFailure = "";
    let stopped = false;
    const record: { client: RunnerClient; status: RemoteRunnerStatus; stop?: () => void } = {
      client: undefined as unknown as RunnerClient,
      status: { hostId: host.id, ...(localVersion ? { localVersion } : {}), state: "connecting" },
    };
    // Every local request opens its own forwarded stream to the remote socket,
    // which is what lets the ordinary HTTP client talk to a runner that listens
    // on no port at all.
    const bridge: Server = createServer((socket: Socket) => {
      connection.forwardToRemoteSocket(socketPath).then((stream) => {
        socket.pipe(stream).pipe(socket);
        stream.once("error", (error) => {
          this.logger.warn("remote_runner_tunnel_stream_failed", {
            errorMessage: errorMessage(error),
            hostId: host.id,
          });
          socket.destroy();
        });
        socket.once("error", (error) => {
          this.logger.warn("remote_runner_tunnel_socket_failed", {
            errorMessage: errorMessage(error),
            hostId: host.id,
          });
          stream.destroy();
        });
      }).catch((error) => {
        this.logger.warn("remote_runner_tunnel_forward_failed", {
          errorMessage: errorMessage(error),
          hostId: host.id,
        });
        socket.destroy();
      });
    });
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      bridge.close();
      // A pseudo-terminal was requested for the runner, so ending the
      // connection hangs it up instead of leaving it on the user's machine.
      connection.close();
    };
    record.stop = stop;
    // A runner that exits, or a connection that drops, must move the machine to
    // an error state rather than leaving a client pointing at a dead bridge.
    const fail = (message: string): void => {
      if (this.runnerConnections.get(host.id)?.stop !== stop) return;
      this.runnerConnections.delete(host.id);
      this.runnerStatuses.set(host.id, { ...record.status, error: message, state: "error" });
      this.logger.error("remote_runner_connection_lost", {
        errorMessage: errorMessage(message),
        hostId: host.id,
      });
      stop();
    };
    connection.onClose((error) => fail(error?.message || remoteFailure.trim() || "The SSH connection to this machine closed"));
    try {
      await connection.start(script, (code, stderr) => {
        remoteFailure = stderr;
        fail(stderr.trim() || `The remote runner exited (${code ?? "unknown"})`);
      });
      const localPort = await new Promise<number>((resolveListen, reject) => {
        bridge.once("error", reject);
        bridge.listen(0, "127.0.0.1", () => {
          const address = bridge.address();
          resolveListen(typeof address === "object" && address ? address.port : 0);
        });
      });
      const client = new RunnerClient(`http://127.0.0.1:${localPort}`, token);
      record.client = client;
      this.runnerConnections.set(host.id, record);
      this.logConnect(host.id, "Runner process launched; waiting for its first answer…");
      const deadline = Date.now() + 30_000;
      let health;
      while (Date.now() < deadline && !stopped) {
        try {
          health = await client.health();
          break;
        } catch {
          await new Promise((resolveWait) => setTimeout(resolveWait, 150));
        }
      }
      if (!health) {
        throw new Error(remoteFailure.trim() || "Remote runner did not become ready within 30 seconds");
      }
      if (remoteFailure.trim()) this.logConnect(host.id, `Runner output: ${remoteFailure.trim()}`);
      this.logConnect(host.id, `Runner is ready (version ${health.runnerVersion}).`);
      record.status = {
        connectedAt: new Date().toISOString(),
        ...(prepared.deployed ? { deployed: true } : {}),
        hostId: host.id,
        ...(localVersion ? { localVersion } : {}),
        remoteVersion: health.runnerVersion,
        state: "ready",
        ...(localVersion ? { versionMismatch: localVersion !== health.runnerVersion } : {}),
      };
      this.runnerStatuses.set(host.id, record.status);
      return structuredClone(record.status);
    } catch (error) {
      this.runnerConnections.delete(host.id);
      stop();
      throw error;
    }
  }

  async disconnectRunner(hostId: string, reason = "requested"): Promise<RemoteRunnerStatus> {
    const connection = this.runnerConnections.get(hostId);
    const previous = this.runnerStatuses.get(hostId);
    if (connection) {
      this.runnerConnections.delete(hostId);
      connection.stop?.();
    }
    const status: RemoteRunnerStatus = { hostId, state: "disconnected" };
    this.runnerStatuses.set(hostId, status);
    if (connection || (previous && previous.state !== "disconnected")) {
      this.logger.info("remote_runner_connection_closed", { hostId, reason });
    }
    return structuredClone(status);
  }

  close(): void {
    for (const [hostId, connection] of this.runnerConnections) {
      this.runnerConnections.delete(hostId);
      connection.stop?.();
      this.runnerStatuses.set(hostId, { hostId, state: "disconnected" });
      this.logger.info("remote_runner_connection_closed", { hostId, reason: "api_shutdown" });
    }
  }

}
