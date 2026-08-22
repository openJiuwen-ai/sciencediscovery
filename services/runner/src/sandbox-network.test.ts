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
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { access, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";

import { NO_SANDBOX_NETWORK_ACCESS, type RunnerHealth, type SandboxNetworkAccess } from "@sciencediscovery/schema";

import {
  EGRESS_BRIDGE_PORT,
  EGRESS_PROXY_URL,
  EGRESS_SOCKET_PATH,
  resolveEgressBridge,
} from "./egress-bridge.js";
import { EgressGateway } from "./egress-gateway.js";
import { buildSandboxLaunch, prepareSandboxEgress, seccompVariantFor } from "./executor.js";
import { baselineSeccompFilter, ensureSeccompFilter } from "./seccomp.js";
import { createRunnerServer } from "./server.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sciencediscovery-sandbox-network-"));
  temporaryDirectories.push(directory);
  return directory;
}

after(async () => {
  for (const directory of temporaryDirectories) await rm(directory, { force: true, recursive: true });
});

const ALLOWLIST: SandboxNetworkAccess = {
  allowPrivateNetwork: true,
  allowedDomains: ["mirror.test"],
  mode: "domain-allowlist",
  revision: "test-revision",
};

function launchOptions(egress?: Awaited<ReturnType<typeof prepareSandboxEgress>>) {
  return {
    chdir: "/workspace",
    disableUserns: true,
    egress,
    environmentBinds: [],
    hostInterpreterMasks: [],
    hostRuntimeSupport: [],
    language: "shell" as const,
    pathEnv: "/usr/bin",
    procMode: "new" as const,
    workspaceBindArgs: ["--bind", "/host/workspace", "/workspace"],
  };
}

function deniedSyscalls(filter: Buffer): number[] {
  const syscalls: number[] = [];
  for (let offset = 4 * 8; offset < filter.length - 8; offset += 2 * 8) {
    syscalls.push(filter.readUInt32LE(offset + 4));
  }
  return syscalls;
}

test("a sandbox without network access keeps the current launch shape", () => {
  const launch = buildSandboxLaunch(launchOptions(undefined));
  assert.equal(launch.args.includes("--share-net"), false);
  assert.deepEqual(launch.commandPrefix, []);
  assert.equal(launch.args.join(" ").includes(EGRESS_SOCKET_PATH), false);
  assert.deepEqual(Object.keys(launch.env).toSorted(), ["HOME", "PATH"]);
  assert.equal(seccompVariantFor(NO_SANDBOX_NETWORK_ACCESS), "baseline");
});

test("a domain-allowlist sandbox keeps its own network namespace and exits through the gateway socket", async () => {
  const directory = await scratchDirectory();
  const gateway = new EgressGateway(ALLOWLIST, join(directory, "egress.sock"));
  await gateway.listen();
  try {
    const egress = await prepareSandboxEgress(directory, ALLOWLIST, {
      acquire: async () => gateway,
    } as never);
    const launch = buildSandboxLaunch(launchOptions(egress));
    // A′: no --share-net anywhere; the only way out is the bind-mounted socket.
    assert.equal(launch.args.includes("--share-net"), false);
    assert.ok(launch.args.includes("--unshare-all"));
    const socketBind = launch.args.indexOf(EGRESS_SOCKET_PATH);
    assert.ok(socketBind > 0);
    assert.equal(launch.args[socketBind - 1], gateway.socketPath);
    assert.equal(launch.args[socketBind - 2], "--bind");
    assert.equal(launch.env.HTTP_PROXY, EGRESS_PROXY_URL);
    assert.equal(launch.env.https_proxy, EGRESS_PROXY_URL);
    assert.ok(launch.commandPrefix.at(-1) === "--");
    assert.ok(launch.commandPrefix.includes(String(EGRESS_BRIDGE_PORT)));
    assert.equal(seccompVariantFor(ALLOWLIST), "network");
  } finally {
    await gateway.close();
  }
});

test("the network seccomp profile allows socket calls and keeps every other denial", () => {
  const baseline = deniedSyscalls(baselineSeccompFilter("x64"));
  const network = deniedSyscalls(baselineSeccompFilter("x64", "network"));
  const socketSyscalls = [41, 42, 43, 49, 50, 53, 288];
  for (const syscall of socketSyscalls) {
    assert.ok(baseline.includes(syscall), `baseline should deny ${syscall}`);
    assert.equal(network.includes(syscall), false, `network profile should allow ${syscall}`);
  }
  // ptrace, mount, setns, bpf, io_uring and friends stay denied.
  assert.deepEqual(network, baseline.filter((syscall) => !socketSyscalls.includes(syscall)));
  const armSocketSyscalls = [198, 199, 200, 201, 202, 203, 242];
  const armNetwork = deniedSyscalls(baselineSeccompFilter("arm64", "network"));
  for (const syscall of armSocketSyscalls) assert.equal(armNetwork.includes(syscall), false);
});

test("the two seccomp variants are written to separate files", async () => {
  const directory = await scratchDirectory();
  const baseline = await ensureSeccompFilter(directory, "baseline", "x64");
  const network = await ensureSeccompFilter(directory, "network", "x64");
  assert.notEqual(baseline, network);
  assert.match(network, /seccomp-network-x86_64\.bpf$/);
});

test("scientific environment install stays independent of the sandbox network policy", async () => {
  // Install networking (conda channels / pip index / offline cache) is a
  // control-plane path; enabling a runtime allowlist must not open package
  // repositories, so the environment store never reaches for the egress plumbing.
  const source = await readFile(new URL("../src/environment-store.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /egress-gateway|egress-bridge|SandboxNetworkAccess|epochSandboxNetworkAccess/);
});

test("runner health reports the sandbox network capability without touching the data directory", async () => {
  // Every agent run reads runner health before it starts, so /health must not
  // spawn an interpreter probe per request or stage the bridge script; only a
  // domain-allowlist launch does that.
  const directory = await scratchDirectory();
  const server = createRunnerServer({
    authToken: "runner-test-token",
    bwrapPath: "bwrap",
    dataDir: directory,
    execTimeoutMs: 0,
    host: "127.0.0.1",
    maxOutputBytes: 0,
    maxWorkspaceBytes: 0,
    npuBrokerEnabled: false,
    port: 0,
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", () => listening()));
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const health = await (await fetch(`${origin}/health`)).json() as RunnerHealth;
    assert.ok(health.sandboxNetwork.modes.includes("none"));
    assert.equal(health.networkPolicy, "none");
    await assert.rejects(access(join(directory, "runner-runtime", "egress-bridge.py")));
  } finally {
    await new Promise<void>((closed) => server.close(() => closed()));
  }

  // The launch path is what stages the script.
  await resolveEgressBridge(directory);
  await access(join(directory, "runner-runtime", "egress-bridge.py"));
});

async function bwrapAvailable(): Promise<boolean> {
  try {
    await execFileAsync("bwrap", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/** Run one command inside a real sandbox built from the launch args. */
function runSandbox(args: string[], command: string[], seccompPath: string): Promise<{ code: number; output: string }> {
  return new Promise((resolveRun, reject) => {
    void open(seccompPath, "r").then((filter) => {
      const child = spawn("bwrap", [...args, ...command], { stdio: ["ignore", "pipe", "pipe", filter.fd] });
      void filter.close();
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      child.once("error", reject);
      child.once("close", (code) => resolveRun({ code: code ?? 1, output }));
    }, reject);
  });
}

const FETCH_SCRIPT = "import sys, urllib.request\n"
  + "print(urllib.request.urlopen(sys.argv[1], timeout=5).read().decode())\n";

test("a real sandbox reaches allowed domains through the gateway and nothing else", async (t) => {
  if (!await bwrapAvailable()) {
    t.skip("bubblewrap is not installed");
    return;
  }
  const directory = await scratchDirectory();
  const target = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(`reached ${request.headers.host}`);
  });
  await new Promise<void>((listening) => target.listen(0, "127.0.0.1", () => listening()));
  const address = target.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const gateway = new EgressGateway(ALLOWLIST, join(directory, "egress.sock"), {
    resolveAddresses: async () => [{ address: "127.0.0.1", family: 4 }],
  });
  await gateway.listen();
  try {
    await resolveEgressBridge(directory);
  } catch {
    t.skip("no host Python 3 interpreter for the egress bridge");
    await gateway.close();
    await new Promise<void>((closed) => target.close(() => closed()));
    return;
  }
  try {
    const egress = await prepareSandboxEgress(directory, ALLOWLIST, { acquire: async () => gateway } as never);
    const launch = buildSandboxLaunch({
      ...launchOptions(egress),
      workspaceBindArgs: ["--bind", directory, "/workspace"],
    });
    const networkFilter = await ensureSeccompFilter(directory, "network");
    const baselineFilter = await ensureSeccompFilter(directory, "baseline");

    const allowed = await runSandbox(
      [...launch.args, ...launch.commandPrefix],
      ["/usr/bin/python3", "-c", FETCH_SCRIPT, `http://mirror.test:${port}/`],
      networkFilter,
    );
    assert.equal(allowed.code, 0, allowed.output);
    assert.match(allowed.output, /reached mirror\.test/);

    const denied = await runSandbox(
      [...launch.args, ...launch.commandPrefix],
      ["/usr/bin/python3", "-c", FETCH_SCRIPT, `http://blocked.test:${port}/`],
      networkFilter,
    );
    assert.notEqual(denied.code, 0);
    assert.match(denied.output, /403/);

    // The same target is unreachable for a sandbox without network access:
    // no bridge, no socket, and seccomp still refuses to create a socket.
    const offline = buildSandboxLaunch({
      ...launchOptions(undefined),
      workspaceBindArgs: ["--bind", directory, "/workspace"],
    });
    const withoutNetwork = await runSandbox(
      offline.args,
      ["/usr/bin/python3", "-c", FETCH_SCRIPT, `http://127.0.0.1:${port}/`],
      baselineFilter,
    );
    assert.notEqual(withoutNetwork.code, 0);
    assert.match(withoutNetwork.output, /URLError|PermissionError|Errno/);
  } finally {
    await gateway.close();
    await new Promise<void>((closed) => target.close(() => closed()));
  }
});
