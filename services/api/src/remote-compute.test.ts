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

import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { resolve } from "node:path";
import { test } from "node:test";

import type { RemoteHostTarget, RemoteJob } from "@sciencediscovery/schema";

import {
  RemoteComputeClient,
  SshHostKeyUntrustedError,
  validateRunnerCommand,
  type RemoteCommandResult,
  type RemoteComputeLogger,
  type RemoteSshAccess,
  type RemoteTransport,
  type SshCommandResult,
  type SshSession,
} from "@sciencediscovery/executor";

interface RecordedLog {
  event: string;
  fields: Record<string, unknown>;
  level: "debug" | "info" | "warn" | "error";
}

function recordingLogger(): { events: RecordedLog[]; logger: RemoteComputeLogger } {
  const events: RecordedLog[] = [];
  const record = (level: RecordedLog["level"]) => (event: string, fields: Record<string, unknown> = {}) => {
    events.push({ event, fields: structuredClone(fields), level });
  };
  return {
    events,
    logger: {
      error: record("error"),
      info: record("info"),
      warn: record("warn"),
    },
  };
}

/**
 * Stands in for the SSH protocol. Probe, deployment and tunnel all go through
 * the transport, so recording the targets here shows which credentials and
 * which trusted key each of them used.
 */
class FakeTransport implements RemoteTransport {
  readonly calls: Array<{ script: string; target: RemoteSshAccess; timeoutMs: number }> = [];
  readonly opened: RemoteSshAccess[] = [];
  session?: SshSession;

  constructor(private readonly results: RemoteCommandResult[]) {}

  async open(target: RemoteSshAccess): Promise<SshSession> {
    this.opened.push(structuredClone(target));
    if (!this.session) throw new Error("Unexpected SSH connection");
    return this.session;
  }

  async run(target: RemoteSshAccess, script: string, timeoutMs: number): Promise<RemoteCommandResult> {
    this.calls.push({ script, target: structuredClone(target), timeoutMs });
    const result = this.results.shift();
    if (!result) throw new Error("Unexpected remote command");
    return result;
  }
}

const TRUSTED_KEY = { algorithm: "ssh-ed25519", fingerprint: `SHA256:${"a".repeat(43)}` };

/** Credentials the product holds itself; no ssh config, agent or known_hosts. */
function access(overrides: Partial<RemoteSshAccess> = {}): RemoteSshAccess {
  return {
    credentials: { password: "hunter2", username: "scientist" },
    destination: "10.0.0.8",
    trustedHostKey: TRUSTED_KEY,
    ...overrides,
  };
}

const PROBE_OUTPUT = {
  exitCode: 0,
  stderr: "",
  stdout: "platform=Linux\ncpu=32\nmemory_kib=65536\ngpu=NVIDIA A100\ncuda=12.4\nconda=1\nmodules=1\ncontainers=apptainer\nscratch=/scratch,/tmp\nsbatch=1\nrunner=1\nnode=v22.19.0\n",
};

/** A session that answers nothing: enough to observe how the tunnel was opened. */
function fakeSession(): SshSession {
  return {
    upload: async () => undefined,
    close: () => undefined,
    forwardToRemoteSocket: async () => { throw new Error("no forwarding in this test"); },
    onClose: () => undefined,
    run: async (): Promise<SshCommandResult> => ({ exitCode: 0, stderr: "", stdout: "" }),
    start: async () => undefined,
  };
}

/**
 * A session whose forwarded stream lands on a stand-in runner, so a connection
 * can actually go ready without any port being open on the remote machine.
 * Records every socket path it was asked to reach.
 */
function tunnelledSession(runnerPort: number, forwarded: string[], started: string[]): SshSession {
  const sockets: Socket[] = [];
  const closeListeners: Array<(error?: Error) => void> = [];
  let closed = false;
  return {
    upload: async () => undefined,
    close: () => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      for (const listener of closeListeners) listener();
    },
    forwardToRemoteSocket: async (socketPath: string) => {
      forwarded.push(socketPath);
      const socket = connect(runnerPort, "127.0.0.1");
      sockets.push(socket);
      return socket;
    },
    onClose: (listener) => { closeListeners.push(listener); },
    run: async (): Promise<SshCommandResult> => ({ exitCode: 0, stderr: "", stdout: "" }),
    start: async (script: string) => { started.push(script); },
  };
}

function readyRemoteHost(): RemoteHostTarget {
  const timestamp = "2026-08-31T00:00:00.000Z";
  return {
    alias: "10.0.0.8",
    capabilities: {
      conda: true,
      containerRuntimes: [],
      cpuCores: 8,
      cuda: null,
      gpu: null,
      memoryBytes: 16 * 1024 * 1024 * 1024,
      modules: false,
      nodeVersion: "v22.19.0",
      platform: "Linux",
      probedAt: timestamp,
      runnerCommandAvailable: true,
      scratchPaths: ["/tmp"],
      slurm: false,
    },
    connectionKind: "ssh",
    createdAt: timestamp,
    id: "host-1",
    runnerCommand: "sciencediscovery-runner",
    status: "ready",
    updatedAt: timestamp,
    username: "scientist",
  };
}

test("remote runner executable accepts only one safe executable token", () => {
  assert.equal(validateRunnerCommand("sciencediscovery-runner"), "sciencediscovery-runner");
  assert.equal(validateRunnerCommand("/opt/sciencediscovery/bin/runner"), "/opt/sciencediscovery/bin/runner");
  assert.throws(() => validateRunnerCommand("runner --token secret"), /without arguments/);
  assert.throws(() => validateRunnerCommand("/opt/runner; reboot"), /without arguments/);
});

test("the capability probe is read-only and carries the machine's own credentials", async () => {
  const transport = new FakeTransport([PROBE_OUTPUT]);
  const recorded = recordingLogger();
  const client = new RemoteComputeClient("/unused/ssh_config", async () => access(), {
    logger: recorded.logger,
    transport,
  });

  const capabilities = await client.probe(access());
  assert.equal(capabilities.cpuCores, 32);
  assert.equal(capabilities.memoryBytes, 64 * 1024 * 1024);
  assert.equal(capabilities.platform, "Linux");
  assert.equal(capabilities.runnerCommandAvailable, true);
  assert.deepEqual(capabilities.scratchPaths, ["/scratch", "/tmp"]);
  assert.doesNotMatch(transport.calls[0]!.script, /\b(?:mkdir|rm|touch)\b|\bsbatch\s+--/);
  assert.equal(transport.calls[0]!.target.credentials.username, "scientist");
  assert.deepEqual(transport.calls[0]!.target.trustedHostKey, TRUSTED_KEY);
  assert.ok(recorded.events.some((entry) => entry.event === "remote_host_probe_started"));
  assert.ok(recorded.events.some((entry) => entry.event === "remote_host_probe_succeeded"));
  assert.doesNotMatch(JSON.stringify(recorded.events), /hunter2/);
});

test("remote diagnostics redact credentials before reaching an injected logger", async () => {
  const transport = new FakeTransport([{
    exitCode: 1,
    stderr: "Authorization: Bearer ssh-secret https://user:pass@example.test/private?token=query-secret password=hidden",
    stdout: "",
  }]);
  const recorded = recordingLogger();
  const client = new RemoteComputeClient("/unused/ssh_config", async () => access(), {
    logger: recorded.logger,
    transport,
  });

  await assert.rejects(() => client.probe(access()), /SSH probe failed/);

  const serialized = JSON.stringify(recorded.events);
  assert.doesNotMatch(serialized, /ssh-secret|user:pass|query-secret|hidden/);
  assert.match(serialized, /\[REDACTED\]/);
});

const executable = async () => ({ path: "fixture-runner", id: "a".repeat(64), architecture: "x64" as const, size: 1 });

test("the probe, the deployment and the tunnel all use the same credentials and trusted key", async () => {
  const transport = new FakeTransport([
    PROBE_OUTPUT,
    { exitCode: 0, stderr: "", stdout: "architecture=x86_64\ndata_dir=/home/scientist/.local/share/sciencediscovery/remote-runner\n" },
  ]);
  transport.session = fakeSession();
  const target = access({ port: 2222 });
  const client = new RemoteComputeClient("/unused/ssh_config", async () => target, { transport });
  const host = readyRemoteHost();

  await client.probe(target);
  const status = await client.connectRunner(
    { ...host, capabilities: { ...host.capabilities!, runnerCommandAvailable: false } },
    { executable, localVersion: "local-build" },
  );
  // The fake session never answers health, so the connection cannot go ready;
  // what matters here is how each step addressed the machine.
  assert.equal(status.state, "error");
  assert.equal(transport.calls.length, 2, "one probe and one deployment");
  for (const call of transport.calls) {
    assert.equal(call.target.port, 2222);
    assert.equal(call.target.credentials.password, "hunter2");
    assert.deepEqual(call.target.trustedHostKey, TRUSTED_KEY);
  }
  assert.doesNotMatch(transport.calls[1]!.script, /tar -xzf|base64/);
  assert.doesNotMatch(transport.calls[1]!.script, /-mmin|-mtime|-type s.*-delete/, "preparation must not delete another live runner's socket based on age");
  assert.equal(transport.opened.length, 2, "transfer and tunnel each use a trusted SSH connection");
  assert.equal(transport.opened[0]!.port, 2222);
  assert.deepEqual(transport.opened[0]!.trustedHostKey, TRUSTED_KEY);
});

test("a connect attempt tells its story as a pollable log, ending with the failure cause", async () => {
  const transport = new FakeTransport([
    { exitCode: 1, stderr: "disk full", stdout: "" },
    { exitCode: 1, stderr: "disk full", stdout: "" },
  ]);
  const client = new RemoteComputeClient("/unused/ssh_config", async () => access(), { transport });
  const host = readyRemoteHost();

  const status = await client.connectRunner(host, { localVersion: "local-build" });
  assert.equal(status.state, "error");
  const entries = client.connectLog(host.id);
  assert.deepEqual(entries.map((entry) => entry.line), [
    "Connecting to 10.0.0.8 over SSH…",
    "Runner command found on the machine; preparing its data directory…",
    "Failed: Remote runner deployment failed (1): disk full",
  ]);
  for (const entry of entries) assert.ok(!Number.isNaN(Date.parse(entry.at)), "every line carries its timestamp");

  // A second attempt starts a fresh story rather than appending to the last.
  await client.connectRunner(host, { localVersion: "local-build" });
  assert.deepEqual(client.connectLog(host.id).map((entry) => entry.line), [
    "Connecting to 10.0.0.8 over SSH…",
    "Runner command found on the machine; preparing its data directory…",
    "Failed: Remote runner deployment failed (1): disk full",
  ]);
});

test("a machine whose key is not trusted is refused with the fingerprint to trust", async () => {
  const untrusted = new SshHostKeyUntrustedError(
    { algorithm: "ssh-ed25519", changed: false, fingerprint: `SHA256:${"b".repeat(43)}` },
    "192.168.100.236",
  );
  const refusing: RemoteTransport = {
    open: async () => { throw untrusted; },
    run: async () => { throw untrusted; },
  };
  const client = new RemoteComputeClient(
    "/unused/ssh_config",
    async () => access({ trustedHostKey: undefined }),
    { transport: refusing },
  );

  await assert.rejects(client.probe(access({ trustedHostKey: undefined })), (error: Error) => {
    assert.equal(error.name, "SshHostKeyUntrustedError");
    assert.match(error.message, /untrusted ssh-ed25519 host key/);
    // The old advice was to go edit the system known_hosts; the answer is now
    // inside the product, so the message must not send the user back there.
    assert.doesNotMatch(error.message, /known_hosts/);
    return true;
  });

  const status = await client.connectRunner(readyRemoteHost(), {});
  assert.equal(status.state, "error");
  assert.deepEqual(status.hostKeyChallenge, {
    algorithm: "ssh-ed25519",
    changed: false,
    fingerprint: `SHA256:${"b".repeat(43)}`,
  });
});

test("a machine whose key changed says so, so it is not read as a first connection", async () => {
  const changed = new SshHostKeyUntrustedError(
    { algorithm: "ssh-rsa", changed: true, fingerprint: `SHA256:${"c".repeat(43)}` },
    "10.0.0.8",
  );
  const refusing: RemoteTransport = {
    open: async () => { throw changed; },
    run: async () => { throw changed; },
  };
  const status = await new RemoteComputeClient("/unused/ssh_config", async () => access(), { transport: refusing })
    .connectRunner(readyRemoteHost(), {});

  assert.equal(status.hostKeyChallenge?.changed, true);
  assert.match(status.error ?? "", /host key of 10\.0\.0\.8 changed/);
});

test("the transport has no bare SSH or SLURM job execution methods", () => {
  assert.equal("start" in RemoteComputeClient.prototype, false);
  assert.equal("refresh" in RemoteComputeClient.prototype, false);
});

/** A runner that answers `/health` to anyone and `/status` only to one token. */
async function startFakeRunner(options: { platform: string; token: string; version: string }): Promise<{
  close: () => Promise<void>;
  port: number;
}> {
  const server = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ platform: options.platform, runnerVersion: options.version, status: "ok" }));
      return;
    }
    if (request.headers.authorization !== `Bearer ${options.token}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url === "/resources" ? {
      capturedAt: new Date().toISOString(), cpuCores: 4, loadAverage1m: 0,
      memoryTotalBytes: 4096, memoryFreeBytes: 2048, uptimeSeconds: 60,
      workspaceDisk: { path: "/mounted/workspaces", totalBytes: 1000, availableBytes: 600 },
    } : { runnerVersion: options.version, status: "ok" }));
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  return {
    close: () => new Promise<void>((closed) => server.close(() => closed())),
    port: typeof address === "object" && address ? address.port : 0,
  };
}

function directRemoteHost(port: number): RemoteHostTarget {
  const timestamp = "2026-09-01T00:00:00.000Z";
  return {
    alias: "lab-workstation",
    capabilities: {
      conda: false, containerRuntimes: [], cpuCores: null, cuda: null, gpu: null, memoryBytes: null,
      modules: false, nodeVersion: null, platform: "Linux", probedAt: timestamp,
      runnerCommandAvailable: true, scratchPaths: [], slurm: false,
    },
    connectionKind: "direct",
    createdAt: timestamp,
    endpoint: { host: "127.0.0.1", port, protocol: "http" },
    id: "host-direct",
    runnerCommand: "sciencediscovery-runner",
    status: "ready",
    updatedAt: timestamp,
  };
}

test("a Runner whose clock is minutes off still gets signatures it accepts", async (context) => {
  // Internal machines routinely never reach an NTP server; one measured here
  // was 108 s behind. The Runner refuses any execution more than 30 s from its
  // own clock, so the product signs on the machine's clock instead of widening
  // that window for everyone.
  const skewMs = -108_000;
  const seen: Array<{ signedAt: number; receivedAt: number }> = [];
  const runner = createServer((request, response) => {
    const receivedAt = Date.now() + skewMs;
    const timestamp = Number(request.headers["x-science-execution-timestamp"]);
    if (Number.isFinite(timestamp)) seen.push({ receivedAt, signedAt: timestamp });
    // Answer with the machine's own clock, which is how the offset is learned.
    response.setHeader("date", new Date(receivedAt).toUTCString());
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url === "/health"
      ? { platform: "linux", runnerVersion: "runner-v1", sandbox: "bubblewrap" }
      : { activeExecutions: [], capturedAt: new Date(receivedAt).toISOString(), kernels: [], npuJobs: [], status: "ok" }));
  });
  await new Promise<void>((listening) => runner.listen(0, "127.0.0.1", listening));
  context.after(() => new Promise<void>((closed) => runner.close(() => closed())));
  const port = (runner.address() as AddressInfo).port;

  const client = new RemoteComputeClient("/unused/ssh_config", async () => access(), { transport: new FakeTransport([]) });
  const status = await client.connectRunner(directRemoteHost(port), { token: "any-token" });
  assert.equal(status.state, "ready");
  // Measured, not configured: within a second of the real skew.
  assert.ok(Math.abs((status.clockOffsetMs ?? 0) - skewMs) < 2_000, `offset was ${status.clockOffsetMs}`);
  // Recorded times stay on this machine's clock; a timeline built from several
  // machines' clocks is one nobody can read.
  assert.ok(Math.abs(Date.parse(status.connectedAt ?? "") - Date.now()) < 5_000);

  await client.runnerClient("host-direct").cancelNpuJob("job-1", "session-1").catch(() => undefined);
  const signed = seen.at(-1);
  assert.ok(signed, "the request carried a signed timestamp");
  // What the Runner compares: its own clock against the timestamp it received.
  assert.ok(Math.abs(signed.signedAt - signed.receivedAt) < 30_000,
    `signed ${signed.signedAt} against a clock at ${signed.receivedAt}`);
});

test("times the Runner reported come back on this machine's clock, with its measured duration intact", async (context) => {
  const skewMs = -108_000;
  const runner = createServer((request, response) => {
    const remoteNow = Date.now() + skewMs;
    response.setHeader("date", new Date(remoteNow).toUTCString());
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/health") {
      response.end(JSON.stringify({ platform: "linux", runnerVersion: "runner-v1", sandbox: "bubblewrap" }));
      return;
    }
    if (request.url?.startsWith("/shell-executions")) {
      // The Runner times its own work with its own clock: a 4s run, 108s ago
      // as far as this machine is concerned.
      response.end(JSON.stringify({
        agentId: "main", finishedAt: new Date(remoteNow).toISOString(), id: "exec-1",
        sessionId: "session-1", startedAt: new Date(remoteNow - 4_000).toISOString(), state: "completed",
      }));
      return;
    }
    response.end(JSON.stringify({ activeExecutions: [], capturedAt: new Date(remoteNow).toISOString(), kernels: [], npuJobs: [], status: "ok" }));
  });
  await new Promise<void>((listening) => runner.listen(0, "127.0.0.1", listening));
  context.after(() => new Promise<void>((closed) => runner.close(() => closed())));

  const client = new RemoteComputeClient("/unused/ssh_config", async () => access(), { transport: new FakeTransport([]) });
  await client.connectRunner(directRemoteHost((runner.address() as AddressInfo).port), { token: "any-token" });
  const execution = await client.runnerClient("host-direct").getShellExecution("exec-1", { agentId: "main", sessionId: "session-1" });

  // Written against this machine's clock, so it cannot land before the turn
  // that asked for it.
  assert.ok(Math.abs(Date.parse(execution.finishedAt ?? "") - Date.now()) < 5_000,
    `finishedAt was ${execution.finishedAt}`);
  // And the Runner's own measurement of how long it took survives the shift.
  assert.equal(Date.parse(execution.finishedAt ?? "") - Date.parse(execution.startedAt ?? ""), 4_000);
});

test("a machine with no Runner connected still reports whether it answers", async () => {
  // "Runner disconnected" is not a machine state. A powered-off host, a broken
  // route and a healthy host nobody connected yet look identical without this.
  const sshHost: RemoteHostTarget = {
    alias: "compute-node", connectionKind: "ssh", createdAt: "2026-09-01T00:00:00.000Z",
    id: "host-ssh", runnerCommand: "sciencediscovery-runner", status: "ready",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
  const transport = new FakeTransport([
    { exitCode: 0, stderr: "", stdout: "" },
    { exitCode: 255, stderr: "ssh: connect to host compute-node port 22: No route to host", stdout: "" },
  ]);
  const client = new RemoteComputeClient("/unused/ssh_config", async () => access(), { transport });

  const online = await client.reachability(sshHost);
  assert.equal(online.state, "online");
  assert.equal(transport.calls.length, 1, "asking a machine costs one short command");
  assert.equal(transport.calls[0]?.script.trim(), "true");
  assert.ok((transport.calls[0]?.timeoutMs ?? 0) <= 10_000, "a dead machine must not stall the list");

  // A page render is not a question about one machine: the answer is cached.
  const cached = await client.reachability(sshHost);
  assert.deepEqual(cached, online);
  assert.equal(transport.calls.length, 1);

  client.forgetReachability(sshHost.id);
  const offline = await client.reachability(sshHost);
  assert.equal(offline.state, "offline");
  assert.match(offline.error ?? "", /No route to host/u);
});

test("a machine this installation cannot reach at all is unknown, not offline", async () => {
  // Saying "offline" would send someone to check a machine that is probably up.
  const client = new RemoteComputeClient("/unused/ssh_config", async () => {
    throw new Error("This machine has no stored SSH credentials");
  }, { transport: new FakeTransport([]) });
  const result = await client.reachability({
    alias: "no-credentials", connectionKind: "ssh", createdAt: "2026-09-01T00:00:00.000Z",
    id: "host-nocreds", runnerCommand: "sciencediscovery-runner", status: "ready",
    updatedAt: "2026-09-01T00:00:00.000Z",
  });
  assert.equal(result.state, "unknown");
  assert.equal(result.error, undefined);
});

test("a self-deployed Runner is asked for its health endpoint rather than a shell", async (context) => {
  const runner = await startFakeRunner({ platform: "linux", token: "correct-token", version: "runner-v1" });
  context.after(() => runner.close());
  const transport = new FakeTransport([]);
  const client = new RemoteComputeClient("/unused/ssh_config", async () => access(), { transport });

  const online = await client.reachability(directRemoteHost(runner.port));
  assert.equal(online.state, "online", "answering at all proves the machine is up; the token is a separate question");
  assert.equal(transport.calls.length, 0, "a self-deployed Runner has no shell to use");

  await runner.close();
  client.forgetReachability("host-direct");
  const offline = await client.reachability(directRemoteHost(runner.port));
  assert.equal(offline.state, "offline");
  assert.ok(offline.error);
});

test("a self-deployed runner is reachable by address only with the token it was started with", async (context) => {
  const runner = await startFakeRunner({ platform: "linux", token: "correct-token", version: "runner-v1" });
  context.after(() => runner.close());
  const recorded = recordingLogger();
  const client = new RemoteComputeClient(
    "/unused/ssh_config",
    async () => access(),
    { logger: recorded.logger, transport: new FakeTransport([]) },
  );

  const refused = await client.connectRunner(directRemoteHost(runner.port), { token: "wrong-token" });
  assert.equal(refused.state, "error");
  assert.match(refused.error ?? "", /rejected this token/);
  assert.throws(() => client.runnerClient("host-direct"), /not connected/);

  const missing = await client.connectRunner(directRemoteHost(runner.port), {});
  assert.equal(missing.state, "error");
  assert.match(missing.error ?? "", /needs its connection token/);

  const connected = await client.connectRunner(directRemoteHost(runner.port), {
    localVersion: "runner-v2",
    token: "correct-token",
  });
  assert.equal(connected.state, "ready");
  assert.equal(connected.remoteVersion, "runner-v1");
  assert.equal(connected.versionMismatch, true);
  assert.ok(client.runnerClient("host-direct"));
  const measured = await client.runnerStatusWithResources("host-direct");
  assert.equal(measured.resources?.workspaceDisk?.availableBytes, 600);
  assert.equal(measured.resources?.workspaceDisk?.path, "/mounted/workspaces");
  client.runnerClient("host-direct").resources = async () => { throw new Error("private error must not appear"); };
  const unavailable = await client.runnerStatusWithResources("host-direct");
  assert.equal(unavailable.state, "ready");
  assert.equal(unavailable.resources, undefined);
  assert.match(unavailable.resourcesError!, /Metrics unavailable/);
  assert.doesNotMatch(JSON.stringify(unavailable), /private error/);
  await client.disconnectRunner("host-direct");
  const disconnected = await client.runnerStatusWithResources("host-direct");
  assert.equal(disconnected.state, "disconnected");
  assert.equal(disconnected.resources, undefined);
  assert.ok(recorded.events.some((entry) => entry.event === "remote_runner_connection_failed"));
  assert.ok(recorded.events.some((entry) => entry.event === "remote_runner_connection_succeeded"));
  assert.ok(recorded.events.some((entry) => entry.event === "remote_runner_connection_closed"
    && entry.fields.reason === "requested"));
  assert.doesNotMatch(JSON.stringify(recorded.events), /correct-token|wrong-token/);
});

test("a self-deployed runner that is not on Linux is refused", async (context) => {
  const runner = await startFakeRunner({ platform: "darwin", token: "correct-token", version: "runner-v1" });
  context.after(() => runner.close());
  const status = await new RemoteComputeClient(
    "/unused/ssh_config",
    async () => access(),
    { transport: new FakeTransport([]) },
  )
    .connectRunner(directRemoteHost(runner.port), { token: "correct-token" });

  assert.equal(status.state, "error");
  assert.match(status.error ?? "", /must run on Linux/);
});

function sshHostWithoutRunner(nodeVersion: string | null): RemoteHostTarget {
  const host = readyRemoteHost();
  return {
    ...host,
    capabilities: { ...host.capabilities!, nodeVersion, runnerCommandAvailable: false },
  };
}

test("SEA deploys without remote Node, reuses complete binaries and never starts an interrupted upload", async (context) => {
  const runner = await startFakeRunner({ platform: "linux", token: "ignored", version: "runner-v1" });
  context.after(() => runner.close());
  for (const mode of ["install", "reuse", "interrupted", "checksum failure"] as const) {
    await context.test(mode, async (t) => {
      const transport = new FakeTransport([{ exitCode: 0, stderr: "", stdout: "architecture=x86_64\ndata_dir=/fixture/remote\n" }]);
      const started: string[] = [];
      const session = tunnelledSession(runner.port, [], started);
      const commands: string[] = [];
      let uploads = 0;
      session.run = async (script) => {
        commands.push(script);
        if (mode === "checksum failure" && script.includes("mv -f")) return { exitCode: 1, stderr: "Runner binary checksum mismatch", stdout: "" };
        return { exitCode: 0, stderr: "", stdout: mode === "reuse" && script.includes("printf 'reused") ? "reused\n" : "" };
      };
      session.upload = async () => { uploads++; if (mode === "interrupted") throw new Error("transfer interrupted"); };
      transport.session = session;
      const client = new RemoteComputeClient("/unused/ssh_config", async () => access(), { transport });
      t.after(() => client.close());
      const status = await client.connectRunner(sshHostWithoutRunner(null), { executable });
      assert.equal(uploads, mode === "reuse" ? 0 : 1);
      assert.match(commands.at(-1)!, /^rm -f -- '\/fixture\/remote\/bin\/\.upload-/);
      if (mode === "install" || mode === "reuse") {
        assert.equal(status.state, "ready", status.error ?? "SEA tunnel must become ready");
        assert.match(started[0]!, /'\/fixture\/remote\/bin\/[a-f0-9]{64}'/);
        assert.doesNotMatch(started[0]!, /\bnode\b|server\.js/);
      } else { assert.equal(status.state, "error"); assert.equal(started.length, 0); }
      if (mode === "interrupted") assert.equal(commands.some(command => command.includes("mv -f")), false);
    });
  }
});


test("an SSH machine's runner is reached only through the tunnel, never over a port", async (context) => {
  // A stand-in runner on loopback, reachable in this test only because the
  // fake session forwards to it — the product is given no address for it.
  const runner = await startFakeRunner({ platform: "linux", token: "ignored", version: "runner-v1" });
  context.after(() => runner.close());
  const forwarded: string[] = [];
  const started: string[] = [];
  const transport = new FakeTransport([
    { exitCode: 0, stderr: "", stdout: "data_dir=/home/scientist/.local/share/sciencediscovery/remote-runner\n" },
  ]);
  transport.session = tunnelledSession(runner.port, forwarded, started);
  const target = access({ port: 2222 });
  const client = new RemoteComputeClient("/unused/ssh_config", async () => target, { transport });
  context.after(() => client.close());

  const status = await client.connectRunner(readyRemoteHost(), { localVersion: "runner-v1" });
  assert.equal(status.state, "ready", status.error ?? "the tunnelled runner did not become ready");

  // Reaching it went through a per-connection Unix socket under the machine's
  // data directory. Nothing addressed the machine's own network interface.
  assert.equal(forwarded.length > 0, true, "the runner must be reached through a forwarded socket");
  for (const path of forwarded) {
    assert.match(path, /^\/home\/scientist\/\.local\/share\/sciencediscovery\/remote-runner\/run\/[a-f0-9]{16}\.sock$/);
  }
  // The command that starts the runner tells it to listen on that socket, and
  // gives it no address or port: an SSH machine opens no runner port at all.
  assert.equal(started.length, 1, "the runner is started once, over the same connection");
  assert.match(started[0]!, /SCIENCE_AGENT_RUNNER_SOCKET='\/home\/scientist\/[^']*\.sock'/);
  assert.doesNotMatch(started[0]!, /SCIENCE_AGENT_RUNNER_PORT/);
  assert.doesNotMatch(started[0]!, /SCIENCE_AGENT_RUNNER_HOST/);
});

test("API shutdown closes an SSH runner without reporting a lost connection", async (context) => {
  const runner = await startFakeRunner({ platform: "linux", token: "ignored", version: "runner-v1" });
  context.after(() => runner.close());
  const transport = new FakeTransport([
    { exitCode: 0, stderr: "", stdout: "data_dir=/home/scientist/.local/share/sciencediscovery/remote-runner\n" },
  ]);
  transport.session = tunnelledSession(runner.port, [], []);
  const recorded = recordingLogger();
  const client = new RemoteComputeClient(
    "/unused/ssh_config",
    async () => access({ port: 2222 }),
    { logger: recorded.logger, transport },
  );
  context.after(() => client.close());

  const status = await client.connectRunner(readyRemoteHost(), { localVersion: "runner-v1" });
  assert.equal(status.state, "ready", status.error ?? "the tunnelled runner did not become ready");

  client.close();

  assert.equal(client.runnerStatus("host-1").state, "disconnected");
  assert.ok(recorded.events.some((entry) => entry.event === "remote_runner_connection_closed"
    && entry.fields.reason === "api_shutdown"));
  assert.equal(recorded.events.some((entry) => entry.event === "remote_runner_connection_lost"), false);
});

test("a self-deployed runner keeps using its own address and port", async (context) => {
  const runner = await startFakeRunner({ platform: "linux", token: "correct-token", version: "runner-v1" });
  context.after(() => runner.close());
  // No SSH session is available at all, so a connection can only succeed by
  // addressing the runner directly.
  const transport = new FakeTransport([]);
  const client = new RemoteComputeClient("/unused/ssh_config", async () => access(), { transport });
  context.after(() => client.close());

  const status = await client.connectRunner(directRemoteHost(runner.port), { token: "correct-token" });
  assert.equal(status.state, "ready", status.error ?? "the self-deployed runner did not become ready");
  assert.equal(transport.opened.length, 0, "a self-deployed runner needs no SSH connection");
});
