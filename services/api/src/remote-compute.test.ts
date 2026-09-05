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
import { connect, type Socket } from "node:net";
import { resolve } from "node:path";
import { test } from "node:test";

import type { RemoteHostTarget, RemoteJob } from "@sciencediscovery/schema";

import {
  packRunnerBundle,
  RemoteComputeClient,
  SshHostKeyUntrustedError,
  validateRunnerCommand,
  type RemoteCommandResult,
  type RemoteSshAccess,
  type RemoteTransport,
  type SshCommandResult,
  type SshSession,
} from "@sciencediscovery/executor";

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
  return {
    close: () => { for (const socket of sockets) socket.destroy(); },
    forwardToRemoteSocket: async (socketPath: string) => {
      forwarded.push(socketPath);
      const socket = connect(runnerPort, "127.0.0.1");
      sockets.push(socket);
      return socket;
    },
    onClose: () => undefined,
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
  const client = new RemoteComputeClient("/unused/ssh_config", async () => access(), transport);

  const capabilities = await client.probe(access());
  assert.equal(capabilities.cpuCores, 32);
  assert.equal(capabilities.memoryBytes, 64 * 1024 * 1024);
  assert.equal(capabilities.platform, "Linux");
  assert.equal(capabilities.runnerCommandAvailable, true);
  assert.deepEqual(capabilities.scratchPaths, ["/scratch", "/tmp"]);
  assert.doesNotMatch(transport.calls[0]!.script, /\b(?:mkdir|rm|touch)\b|\bsbatch\s+--/);
  assert.equal(transport.calls[0]!.target.credentials.username, "scientist");
  assert.deepEqual(transport.calls[0]!.target.trustedHostKey, TRUSTED_KEY);
});

test("the probe, the deployment and the tunnel all use the same credentials and trusted key", async () => {
  const bundle = await packRunnerBundle();
  const transport = new FakeTransport([
    PROBE_OUTPUT,
    { exitCode: 0, stderr: "", stdout: "deploy=installed\ndata_dir=/home/scientist/.local/share/sciencediscovery/remote-runner\n" },
  ]);
  transport.session = fakeSession();
  const target = access({ port: 2222 });
  const client = new RemoteComputeClient("/unused/ssh_config", async () => target, transport);
  const host = readyRemoteHost();

  await client.probe(target);
  const status = await client.connectRunner(
    { ...host, capabilities: { ...host.capabilities!, runnerCommandAvailable: false } },
    { bundle, localVersion: "local-build" },
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
  assert.match(transport.calls[1]!.script, /tar -xzf/);
  assert.doesNotMatch(transport.calls[1]!.script, /-mmin|-mtime|-type s.*-delete/, "preparation must not delete another live runner's socket based on age");
  assert.equal(transport.opened.length, 1, "the tunnel opens its own connection");
  assert.equal(transport.opened[0]!.port, 2222);
  assert.deepEqual(transport.opened[0]!.trustedHostKey, TRUSTED_KEY);
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
  const client = new RemoteComputeClient("/unused/ssh_config", async () => access({ trustedHostKey: undefined }), refusing);

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
  const status = await new RemoteComputeClient("/unused/ssh_config", async () => access(), refusing)
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
    response.end(JSON.stringify({ runnerVersion: options.version, status: "ok" }));
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

test("a self-deployed runner is reachable by address only with the token it was started with", async (context) => {
  const runner = await startFakeRunner({ platform: "linux", token: "correct-token", version: "runner-v1" });
  context.after(() => runner.close());
  const client = new RemoteComputeClient("/unused/ssh_config", async () => access(), new FakeTransport([]));

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
  await client.disconnectRunner("host-direct");
});

test("a self-deployed runner that is not on Linux is refused", async (context) => {
  const runner = await startFakeRunner({ platform: "darwin", token: "correct-token", version: "runner-v1" });
  context.after(() => runner.close());
  const status = await new RemoteComputeClient("/unused/ssh_config", async () => access(), new FakeTransport([]))
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

test("automatic deployment is refused when the host has neither a runner nor a usable Node", async () => {
  const transport = new FakeTransport([]);
  const client = new RemoteComputeClient("/unused/ssh_config", async () => access(), transport);
  const bundle = await packRunnerBundle();

  const withoutNode = await client.connectRunner(sshHostWithoutRunner(null), { bundle });
  assert.equal(withoutNode.state, "error");
  assert.match(withoutNode.error ?? "", /needs Node\.js 22 or newer/);

  const oldNode = await client.connectRunner(sshHostWithoutRunner("v20.11.0"), { bundle });
  assert.match(oldNode.error ?? "", /found v20\.11\.0/);

  const withoutBundle = await client.connectRunner(sshHostWithoutRunner("v22.19.0"), {});
  assert.match(withoutBundle.error ?? "", /Pre-installed remote runner executable was not found/);
  assert.equal(transport.calls.length, 0);
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
  const client = new RemoteComputeClient("/unused/ssh_config", async () => target, transport);
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

test("a self-deployed runner keeps using its own address and port", async (context) => {
  const runner = await startFakeRunner({ platform: "linux", token: "correct-token", version: "runner-v1" });
  context.after(() => runner.close());
  // No SSH session is available at all, so a connection can only succeed by
  // addressing the runner directly.
  const transport = new FakeTransport([]);
  const client = new RemoteComputeClient("/unused/ssh_config", async () => access(), transport);
  context.after(() => client.close());

  const status = await client.connectRunner(directRemoteHost(runner.port), { token: "correct-token" });
  assert.equal(status.state, "ready", status.error ?? "the self-deployed runner did not become ready");
  assert.equal(transport.opened.length, 0, "a self-deployed runner needs no SSH connection");
});
