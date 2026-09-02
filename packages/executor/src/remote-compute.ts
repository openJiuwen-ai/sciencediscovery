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

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { createServer } from "node:net";

import type {
  RemoteHostCapabilities,
  RemoteHostEndpoint,
  RemoteHostTarget,
  RemoteJob,
  RemoteJobOutputRecord,
  RemoteRunnerStatus,
} from "@sciencediscovery/schema";
import { RUNNER_BUNDLE_ENTRY, type RunnerBundle } from "./runner-bundle.js";
import { RunnerClient } from "./runner-client.js";

const MAX_SSH_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_PULLED_OUTPUT_BYTES = 1024 * 1024;
const SSH_HOST_KEY_GUIDANCE = "Verify the SSH config alias and update the host key in the user's default known_hosts file before retrying.";

export interface RemoteCommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface RemoteTransport {
  /** `port` is omitted when the destination should resolve through SSH configuration. */
  run(destination: string, script: string, timeoutMs: number, port?: number): Promise<RemoteCommandResult>;
}

/**
 * Arguments shared by every SSH invocation: the probe, the deployment and the
 * runner tunnel. Host identity is always verified on the command line so a
 * looser setting in the user's own config cannot weaken it.
 *
 * The port is only passed when the user gave one. Leaving it off is what lets a
 * plain name resolve through the user's SSH configuration, so an alias keeps
 * the `HostName` and `Port` it declares there.
 */
function sshConnectionArguments(configPath: string, port?: number): string[] {
  return [
    "-F", configPath,
    ...(port === undefined ? [] : ["-p", String(validateSshPort(port))]),
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=5",
  ];
}

function describeSshFailure(detail: string, fallback: string): string {
  const message = detail.trim() || fallback;
  if (message.includes(SSH_HOST_KEY_GUIDANCE)) return message;
  return /host key|known_hosts|remote host identification has changed/i.test(message)
    ? `${message}\n${SSH_HOST_KEY_GUIDANCE}`
    : message;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * The SSH destination the user typed. An SSH config alias, a hostname and an
 * IPv4 address are all the same thing here — `ssh` resolves whichever it is —
 * so this only rejects values that would not be a single safe argument.
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

function validateRemotePath(path: string, label: string): string {
  const normalized = path.trim();
  if (!normalized.startsWith("/") || normalized.includes("\0") || normalized.includes("\n") || normalized.length > 2_000) {
    throw new Error(`${label} must be an absolute remote POSIX path of at most 2000 characters`);
  }
  return normalized;
}

export class OpenSshTransport implements RemoteTransport {
  constructor(
    private readonly configPath: string,
    private readonly sshPath = "/usr/bin/ssh",
  ) {}

  run(destination: string, script: string, timeoutMs: number, port?: number): Promise<RemoteCommandResult> {
    return new Promise((resolveRun, reject) => {
      const child = spawn(this.sshPath, [
        ...sshConnectionArguments(this.configPath, port),
        "--", validateSshDestination(destination), "sh", "-s",
      ], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let settled = false;
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        if (!settled) reject(new Error(`SSH command timed out after ${timeoutMs} ms`));
        settled = true;
      }, timeoutMs);
      const append = (current: Buffer, chunk: Buffer) => {
        const next = Buffer.concat([current, chunk]);
        if (next.length > MAX_SSH_OUTPUT_BYTES) {
          child.kill("SIGKILL");
          throw new Error("SSH command output exceeded 2 MB");
        }
        return next;
      };
      child.stdout.on("data", (chunk: Buffer) => {
        try { stdout = append(stdout, chunk); } catch (error) { if (!settled) reject(error); settled = true; }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        try { stderr = append(stderr, chunk); } catch (error) { if (!settled) reject(error); settled = true; }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        if (!settled) reject(error);
        settled = true;
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        const exitCode = code ?? 255;
        const stderrText = stderr.toString("utf8");
        resolveRun({
          exitCode,
          stderr: exitCode === 0 ? stderrText : describeSshFailure(stderrText, "SSH command failed"),
          stdout: stdout.toString("utf8"),
        });
      });
      child.stdin.end(script);
    });
  }
}

function probeScript(runnerCommand: string): string {
  return `set +e
printf 'platform='; uname -s 2>/dev/null || true
printf 'cpu='; getconf _NPROCESSORS_ONLN 2>/dev/null || true
printf 'memory_kib='; awk '/MemTotal:/ {print $2; exit}' /proc/meminfo 2>/dev/null || true
printf 'gpu='; if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -n 1; else printf '\n'; fi
printf 'cuda='; if command -v nvcc >/dev/null 2>&1; then nvcc --version 2>/dev/null | awk '/release/ {print $5}' | tr -d ','; else printf '\n'; fi
printf 'conda='; if command -v conda >/dev/null 2>&1 || command -v micromamba >/dev/null 2>&1; then printf '1\n'; else printf '0\n'; fi
printf 'modules='; if command -v module >/dev/null 2>&1 || command -v modulecmd >/dev/null 2>&1; then printf '1\n'; else printf '0\n'; fi
printf 'containers='; found=''; for runtime in apptainer singularity docker podman; do if command -v "$runtime" >/dev/null 2>&1; then found="\${found}\${found:+,}$runtime"; fi; done; printf '%s\n' "$found"
printf 'scratch='; found=''; for path in /scratch /tmp "\${SCRATCH:-}"; do if [ -n "$path" ] && [ -d "$path" ] && [ -w "$path" ]; then found="\${found}\${found:+,}$path"; fi; done; printf '%s\n' "$found"
printf 'sbatch='; if command -v sbatch >/dev/null 2>&1; then printf '1\n'; else printf '0\n'; fi
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
    slurm: values.get("sbatch") === "1",
  };
}

export interface RemoteRunnerConnectOptions {
  /**
   * Deployable runner tree used when the SSH host has no pre-installed runner.
   * Omitting it keeps the pre-installed-only behaviour.
   */
  bundle?: RunnerBundle;
  /** Local runner version, reported beside the remote one so differences show. */
  localVersion?: string;
  /** Connection token of a self-deployed runner; required for `direct` hosts. */
  token?: string;
}

/** Where the product keeps its own files on a remote host. */
function remoteDataDirScript(): string {
  return "data_dir=\"${XDG_DATA_HOME:-$HOME/.local/share}/sciencediscovery/remote-runner\"";
}

/**
 * Install the runner bundle under the remote data directory.
 *
 * The archive travels inside the shell script as a quoted here-document, which
 * keeps every line short — a single multi-megabyte argument is what a remote
 * `sh` is least likely to accept. The extracted tree is swapped into place only
 * after it is complete, so an interrupted transfer cannot leave a half-written
 * runner behind, and a host that already carries this bundle id is skipped.
 */
function deployScript(bundle: RunnerBundle): string[] {
  const payload = bundle.archive.toString("base64").replaceAll(/(.{76})/g, "$1\n");
  return [
    "app_dir=\"$data_dir/app\"",
    `if [ -f "$app_dir/.deployment-id" ] && [ "$(cat "$app_dir/.deployment-id")" = ${shellQuote(bundle.id)} ]; then`,
    "  printf 'deploy=reused\\n'",
    "else",
    "  command -v tar >/dev/null 2>&1 || { echo 'tar is required to deploy the ScienceDiscovery runner' >&2; exit 1; }",
    "  command -v base64 >/dev/null 2>&1 || { echo 'base64 is required to deploy the ScienceDiscovery runner' >&2; exit 1; }",
    "  stage=\"$data_dir/.stage\"",
    "  rm -rf -- \"$stage\"",
    "  mkdir -p -- \"$stage\"",
    "  base64 -d > \"$stage/bundle.tar.gz\" <<'SCIENCEDISCOVERY_RUNNER_BUNDLE'",
    payload,
    "SCIENCEDISCOVERY_RUNNER_BUNDLE",
    "  tar -xzf \"$stage/bundle.tar.gz\" -C \"$stage\"",
    "  rm -f -- \"$stage/bundle.tar.gz\"",
    `  printf '%s' ${shellQuote(bundle.id)} > "$stage/.deployment-id"`,
    "  rm -rf -- \"$data_dir/.previous\"",
    "  if [ -d \"$app_dir\" ]; then mv -- \"$app_dir\" \"$data_dir/.previous\"; fi",
    "  mv -- \"$stage\" \"$app_dir\"",
    "  rm -rf -- \"$data_dir/.previous\"",
    "  printf 'deploy=installed\\n'",
    "fi",
  ];
}

function directBaseUrl(endpoint: RemoteHostEndpoint): string {
  const authority = endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host;
  return `${endpoint.protocol}://${authority}:${endpoint.port}`;
}

export class RemoteComputeClient {
  readonly transport: RemoteTransport;
  private readonly runnerConnections = new Map<string, {
    child?: ReturnType<typeof spawn>;
    client: RunnerClient;
    status: RemoteRunnerStatus;
  }>();
  private readonly runnerStatuses = new Map<string, RemoteRunnerStatus>();

  constructor(
    readonly sshConfigPath: string,
    transport?: RemoteTransport,
    private readonly sshPath = "/usr/bin/ssh",
  ) {
    this.transport = transport ?? new OpenSshTransport(sshConfigPath, sshPath);
  }

  /**
   * Read a machine's capabilities over SSH. The destination is whatever the user
   * typed — alias, hostname or IP — and is not required to appear in the SSH
   * config: host identity is still verified against `known_hosts`, so an unknown
   * machine fails closed rather than being silently trusted.
   */
  async probe(
    destinationValue: string,
    runnerCommandValue = "sciencediscovery-runner",
    port?: number,
  ): Promise<RemoteHostCapabilities> {
    const destination = validateSshDestination(destinationValue);
    const runnerCommand = validateRunnerCommand(runnerCommandValue);
    const result = await this.transport.run(destination, probeScript(runnerCommand), 20_000, port);
    if (result.exitCode !== 0) {
      throw new Error(`SSH probe failed (${result.exitCode}): ${describeSshFailure(result.stderr, "authentication or connection failed")}`);
    }
    return parseProbe(result.stdout);
  }

  /**
   * Capabilities of a runner the user deployed themselves. There is no shell on
   * this path, so the runner's own health report is the only source; the token
   * is exercised against an authenticated endpoint so registering with a wrong
   * token fails here rather than at the first execution.
   */
  async probeDirect(endpoint: RemoteHostEndpoint, token: string): Promise<RemoteHostCapabilities> {
    const client = new RunnerClient(directBaseUrl(endpoint), token);
    const health = await client.health();
    await client.status().catch(() => {
      throw new Error("The runner rejected this token");
    });
    return {
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
  }

  runnerStatus(hostId: string): RemoteRunnerStatus {
    return structuredClone(this.runnerStatuses.get(hostId) ?? { hostId, state: "disconnected" });
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
  private async prepareSshRunner(host: RemoteHostTarget, bundle?: RunnerBundle): Promise<{
    dataDir: string;
    deployed: boolean;
    startCommand: string;
  }> {
    const capabilities = host.capabilities!;
    const runnerCommand = validateRunnerCommand(host.runnerCommand);
    const deploy = !capabilities.runnerCommandAvailable;
    if (deploy) {
      if (!bundle) throw new Error(`Pre-installed remote runner executable was not found: ${host.runnerCommand}`);
      const major = Number(/^v(\d+)\./.exec(capabilities.nodeVersion ?? "")?.[1]);
      if (!Number.isSafeInteger(major) || major < 22) {
        throw new Error(
          `Automatic deployment needs Node.js 22 or newer on ${host.alias} (found ${capabilities.nodeVersion ?? "none"}).`
          + ` Install Node.js there, install ${host.runnerCommand}, or register the machine as a self-deployed runner instead.`,
        );
      }
    }
    const script = [
      "set -eu",
      "test \"$(uname -s)\" = Linux",
      remoteDataDirScript(),
      "mkdir -p -- \"$data_dir/run\"",
      "chmod 700 -- \"$data_dir\" \"$data_dir/run\"",
      // Sockets of runners whose SSH session died days ago are the only files
      // this ever removes; a live connection keeps its socket mtime fresh.
      "find \"$data_dir/run\" -maxdepth 1 -type s -mmin +1440 -delete 2>/dev/null || true",
      ...(deploy ? deployScript(bundle!) : []),
      "printf 'data_dir=%s\\n' \"$data_dir\"",
      "",
    ].join("\n");
    const result = await this.transport.run(validateSshDestination(host.alias), script, 180_000);
    if (result.exitCode !== 0) {
      throw new Error(`Remote runner deployment failed (${result.exitCode}): ${describeSshFailure(result.stderr, "the SSH command failed")}`);
    }
    const dataDir = /^data_dir=(.+)$/m.exec(result.stdout)?.[1]?.trim();
    if (!dataDir?.startsWith("/")) throw new Error("The remote host did not report its ScienceDiscovery data directory");
    return {
      dataDir,
      deployed: deploy,
      startCommand: deploy
        ? `node ${shellQuote(`${dataDir}/app/${RUNNER_BUNDLE_ENTRY}`)}`
        : shellQuote(runnerCommand),
    };
  }

  async connectRunner(host: RemoteHostTarget, options: RemoteRunnerConnectOptions = {}): Promise<RemoteRunnerStatus> {
    const { localVersion } = options;
    if (host.status !== "ready" || !host.capabilities) throw new Error("Remote host is not ready");
    await this.disconnectRunner(host.id);
    this.runnerStatuses.set(host.id, { hostId: host.id, ...(localVersion ? { localVersion } : {}), state: "connecting" });
    try {
      return host.connectionKind === "direct"
        ? await this.connectDirectRunner(host, options)
        : await this.connectSshRunner(host, options);
    } catch (error) {
      const failed: RemoteRunnerStatus = {
        error: error instanceof Error ? error.message : "Remote runner connection failed",
        hostId: host.id,
        ...(localVersion ? { localVersion } : {}),
        state: "error",
      };
      this.runnerStatuses.set(host.id, failed);
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
    if (health.platform !== "linux") {
      throw new Error(`Remote runners must run on Linux; ${host.alias} reports ${health.platform}`);
    }
    await client.status().catch(() => {
      throw new Error("The runner rejected this token. Re-register the machine with the token it was started with.");
    });
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
    const prepared = await this.prepareSshRunner(host, options.bundle);
    const localPort = await new Promise<number>((resolvePort, reject) => {
      const reservation = createServer();
      reservation.once("error", reject);
      reservation.listen(0, "127.0.0.1", () => {
        const address = reservation.address();
        const port = typeof address === "object" && address ? address.port : 0;
        reservation.close((error) => error ? reject(error) : resolvePort(port));
      });
    });
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
    const child = spawn(this.sshPath, [
      ...sshConnectionArguments(this.sshConfigPath),
      "-o", "ExitOnForwardFailure=yes",
      "-L", `127.0.0.1:${localPort}:${socketPath}`,
      // Force a pseudo-terminal so the remote runner is hung up when this
      // connection ends. Without one, sshd only closes the channel and the
      // runner keeps running on the host after a disconnect or an API crash,
      // which is exactly the process this product must not leave behind.
      "-tt",
      "--", validateSshDestination(host.alias), "sh", "-s",
    ], { stdio: ["pipe", "ignore", "pipe"] });
    const client = new RunnerClient(`http://127.0.0.1:${localPort}`, token);
    const status: RemoteRunnerStatus = { hostId: host.id, ...(localVersion ? { localVersion } : {}), state: "connecting" };
    const connection = { child, client, status };
    this.runnerConnections.set(host.id, connection);
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000);
    });
    child.once("error", (error) => {
      stderr = error.message;
    });
    child.once("close", (code) => {
      if (this.runnerConnections.get(host.id)?.child !== child) return;
      this.runnerConnections.delete(host.id);
      this.runnerStatuses.set(host.id, {
        ...connection.status,
        error: describeSshFailure(stderr, `SSH tunnel closed (${code ?? "unknown"})`),
        state: "error",
      });
    });
    child.stdin?.end(script);
    const deadline = Date.now() + 30_000;
    try {
      let health;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) {
          throw new Error(describeSshFailure(stderr, `SSH tunnel closed (${child.exitCode})`));
        }
        try {
          health = await client.health();
          break;
        } catch {
          await new Promise((resolveWait) => setTimeout(resolveWait, 150));
        }
      }
      if (!health) throw new Error(stderr.trim() || "Remote runner did not become ready within 30 seconds");
      connection.status = {
        connectedAt: new Date().toISOString(),
        ...(prepared.deployed ? { deployed: true } : {}),
        hostId: host.id,
        ...(localVersion ? { localVersion } : {}),
        remoteVersion: health.runnerVersion,
        state: "ready",
        ...(localVersion ? { versionMismatch: localVersion !== health.runnerVersion } : {}),
      };
      this.runnerStatuses.set(host.id, connection.status);
      return structuredClone(connection.status);
    } catch (error) {
      child.kill("SIGTERM");
      this.runnerConnections.delete(host.id);
      throw error;
    }
  }

  async disconnectRunner(hostId: string): Promise<RemoteRunnerStatus> {
    const connection = this.runnerConnections.get(hostId);
    if (connection) {
      this.runnerConnections.delete(hostId);
      connection.child?.kill("SIGTERM");
    }
    const status: RemoteRunnerStatus = { hostId, state: "disconnected" };
    this.runnerStatuses.set(hostId, status);
    return structuredClone(status);
  }

  close(): void {
    for (const connection of this.runnerConnections.values()) connection.child?.kill("SIGTERM");
    this.runnerConnections.clear();
  }

  async start(job: RemoteJob, workspaceRoot: string): Promise<RemoteJob> {
    const workingDirectory = validateRemotePath(job.card.remoteWorkingDirectory, "Remote working directory");
    const now = new Date().toISOString();
    if (job.card.mode === "slurm") {
      const partition = job.card.resources.partition;
      if (partition && !/^[A-Za-z0-9._-]{1,80}$/.test(partition)) throw new Error("SLURM partition contains unsupported characters");
      const batch = [
        "#!/bin/sh",
        `#SBATCH --cpus-per-task=${job.card.resources.cpus}`,
        `#SBATCH --mem=${job.card.resources.memoryMb}M`,
        `#SBATCH --time=${Math.floor(job.card.resources.walltimeMinutes / 60).toString().padStart(2, "0")}:${(job.card.resources.walltimeMinutes % 60).toString().padStart(2, "0")}:00`,
        ...(job.card.resources.gpus ? [`#SBATCH --gpus=${job.card.resources.gpus}`] : []),
        ...(partition ? [`#SBATCH --partition=${partition}`] : []),
        "set -eu",
        `cd -- ${shellQuote(workingDirectory)}`,
        job.card.command,
        "",
      ].join("\n");
      const scriptReference = `${workingDirectory}/.sciencediscovery/jobs/${job.id}.sh`;
      const encoded = Buffer.from(batch).toString("base64");
      const submit = await this.transport.run(job.card.targetAlias, [
        "set -eu",
        `job_script=${shellQuote(scriptReference)}`,
        `mkdir -p -- ${shellQuote(dirname(scriptReference))}`,
        `printf '%s' ${shellQuote(encoded)} | base64 -d > "$job_script"`,
        "chmod 700 \"$job_script\"",
        "sbatch --parsable \"$job_script\"",
        "",
      ].join("\n"), 30_000, job.card.targetPort);
      if (submit.exitCode !== 0) throw new Error(`SLURM submission failed (${submit.exitCode}): ${submit.stderr.trim() || submit.stdout.trim()}`);
      const remoteJobId = submit.stdout.trim().split(/[;\s]/)[0];
      if (!remoteJobId || !/^\d+(?:_\d+)?$/.test(remoteJobId)) throw new Error("SLURM did not return a valid job id");
      return {
        ...job,
        outputRecords: job.card.outputs.map((output) => ({
          ...output,
          status: output.disposition === "remote" ? "remote" : "pending",
        })),
        remoteJobId,
        scriptReference,
        startedAt: now,
        state: "submitted",
        stderr: submit.stderr.slice(0, 20_000),
        stdout: submit.stdout.slice(0, 20_000),
        updatedAt: now,
      };
    }

    const run = await this.transport.run(
      job.card.targetAlias,
      `set -eu\ncd -- ${shellQuote(workingDirectory)}\n${job.card.command}\n`,
      Math.min(job.card.resources.walltimeMinutes * 60_000, 24 * 60 * 60_000),
      job.card.targetPort,
    );
    const outputRecords = await this.collectOutputs(job, workspaceRoot);
    return {
      ...job,
      error: run.exitCode === 0 ? undefined : `Remote SSH command exited with ${run.exitCode}`,
      finishedAt: new Date().toISOString(),
      outputRecords,
      scriptReference: `inline:${job.id}`,
      startedAt: now,
      state: run.exitCode === 0 ? "completed" : "failed",
      stderr: run.stderr.slice(0, 20_000),
      stdout: run.stdout.slice(0, 20_000),
      updatedAt: new Date().toISOString(),
    };
  }

  async refresh(job: RemoteJob, workspaceRoot: string): Promise<RemoteJob> {
    if (job.card.mode !== "slurm" || !job.remoteJobId || !["submitted", "running"].includes(job.state)) return job;
    const status = await this.transport.run(job.card.targetAlias, [
      "set +e",
      `job_id=${shellQuote(job.remoteJobId)}`,
      "state=$(sacct -j \"$job_id\" --noheader --parsable2 --format=State 2>/dev/null | awk -F'|' 'NF {print $1; exit}')",
      "if [ -z \"$state\" ]; then state=$(squeue -h -j \"$job_id\" -o '%T' 2>/dev/null | head -n 1); fi",
      "printf '%s\\n' \"$state\"",
      "",
    ].join("\n"), 20_000, job.card.targetPort);
    if (status.exitCode !== 0) throw new Error(`Could not refresh SLURM job: ${status.stderr.trim()}`);
    const remoteState = status.stdout.trim().split(/[+\s]/)[0]?.toLocaleUpperCase();
    if (remoteState === "COMPLETED") {
      return {
        ...job,
        finishedAt: new Date().toISOString(),
        outputRecords: await this.collectOutputs(job, workspaceRoot),
        state: "completed",
        updatedAt: new Date().toISOString(),
      };
    }
    if (["FAILED", "TIMEOUT", "CANCELLED", "NODE_FAIL", "OUT_OF_MEMORY"].includes(remoteState ?? "")) {
      return { ...job, error: `SLURM job ended in ${remoteState}`, finishedAt: new Date().toISOString(), state: "failed", updatedAt: new Date().toISOString() };
    }
    return { ...job, state: remoteState === "RUNNING" ? "running" : "submitted", updatedAt: new Date().toISOString() };
  }

  private async collectOutputs(job: RemoteJob, workspaceRoot: string): Promise<RemoteJobOutputRecord[]> {
    const records: RemoteJobOutputRecord[] = [];
    for (const [index, output] of job.card.outputs.entries()) {
      const path = validateRemotePath(output.path, "Remote output path");
      if (output.disposition === "remote") {
        records.push({ ...output, status: "remote" });
        continue;
      }
      const result = await this.transport.run(job.card.targetAlias, [
        "set -eu",
        `path=${shellQuote(path)}`,
        "if [ ! -f \"$path\" ]; then printf 'missing\\n'; exit 0; fi",
        "size=$(wc -c < \"$path\" | tr -d ' ')",
        `if [ "$size" -gt ${MAX_PULLED_OUTPUT_BYTES} ]; then printf 'remote|%s\\n' "$size"; exit 0; fi`,
        "printf 'file|%s|' \"$size\"",
        "base64 < \"$path\" | tr -d '\\n'",
        "printf '\\n'",
        "",
      ].join("\n"), 20_000, job.card.targetPort);
      if (result.exitCode !== 0) throw new Error(`Could not inspect remote output ${path}: ${result.stderr.trim()}`);
      const [kind, rawSize, encoded] = result.stdout.trim().split("|", 3);
      const size = Number(rawSize);
      if (kind === "missing") {
        records.push({ ...output, status: "missing" });
      } else if (kind === "remote" || !Number.isSafeInteger(size) || size > MAX_PULLED_OUTPUT_BYTES) {
        records.push({ ...output, ...(Number.isSafeInteger(size) ? { size } : {}), status: "remote" });
      } else if (kind === "file" && encoded !== undefined) {
        const content = Buffer.from(encoded, "base64");
        if (content.length !== size) throw new Error(`Remote output size changed while pulling ${path}`);
        const safeName = basename(path).replaceAll(/[^A-Za-z0-9._-]/g, "_") || `output-${index}`;
        const localPath = `remote-outputs/${job.id}/${index}-${safeName}`;
        const target = resolve(workspaceRoot, localPath);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
        records.push({ ...output, localPath, size, status: "available" });
      } else {
        records.push({ ...output, status: "missing" });
      }
    }
    return records;
  }
}
