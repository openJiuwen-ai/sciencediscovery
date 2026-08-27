// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

import { detectSeatbeltCapability } from "@sciencediscovery/sandbox-capability";
import type { PermissionEpoch } from "@sciencediscovery/schema";

import { executePython, executeShell, type ExecutorConfig } from "./executor.js";
import { EgressGatewayRegistry } from "./egress-gateway.js";
import { SessionEnvProfileStore } from "./session-env-profile.js";
import { ShellSessionManager } from "./shell-session-manager.js";
import { startRunnerServer } from "./server.js";

let dataDir = "";
let workspaceRoot = "";
let seatbeltUsable = false;

before(async () => {
  if (process.platform !== "darwin") return;
  seatbeltUsable = (await detectSeatbeltCapability("/usr/bin/sandbox-exec")).sandboxUsable;
  const testRoot = resolve(process.cwd(), ".tmp");
  await mkdir(testRoot, { recursive: true });
  dataDir = await mkdtemp(join(testRoot, "science-agent-seatbelt-"));
  workspaceRoot = join(dataDir, "projects", "project", "session", "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(dataDir, "not-mounted-secret.txt"), "must-not-leak\n");
});

after(async () => {
  if (dataDir) await rm(dataDir, { force: true, recursive: true });
});

function epoch(id: string): PermissionEpoch {
  return {
    createdAt: new Date().toISOString(),
    environmentRevisionId: "macos-test",
    id,
    mounts: [{ mode: "read-write", source: "workspace" }],
    networkPolicy: "none",
    reason: "macOS Seatbelt integration test",
    secretRefs: [],
    sessionId: "macos-session",
  };
}

function config(): ExecutorConfig {
  return {
    bwrapPath: "bwrap",
    dataDir,
    execTimeoutMs: 10_000,
    maxOutputBytes: 1_000_000,
    maxWorkspaceBytes: 10_000_000,
    sandboxProvider: "seatbelt",
    seatbeltPath: "/usr/bin/sandbox-exec",
  };
}

test("macOS Seatbelt writes only the workspace and denies direct network", async (context) => {
  if (process.platform !== "darwin" || !seatbeltUsable) {
    context.skip("Seatbelt is unavailable on this host");
    return;
  }
  const secret = join(dataDir, "not-mounted-secret.txt");
  const result = await executePython(config(), {
    agentId: "main",
    code: [
      "from pathlib import Path",
      "import socket",
      "Path('created.txt').write_text('seatbelt')",
      `try:\n Path(${JSON.stringify(secret)}).read_text(); print('secret=leaked')\nexcept OSError:\n print('secret=denied')`,
      "try:\n socket.create_connection(('1.1.1.1', 53), timeout=0.1); print('network=leaked')\nexcept OSError as error:\n print(f'network=denied:{error.errno}')",
    ].join("\n"),
    executionId: "macos-seatbelt-python",
    permissionEpoch: epoch("macos-python"),
    workspaceRoot,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.sandbox, "seatbelt");
  assert.match(result.stdout, /secret=denied/);
  assert.match(result.stdout, /network=denied:1/);
  assert.deepEqual(result.createdFiles, ["created.txt"]);
  assert.equal(await readFile(join(workspaceRoot, "created.txt"), "utf8"), "seatbelt");
});

test("macOS Seatbelt reaches an allowed domain only through the runner gateway", async (context) => {
  if (process.platform !== "darwin" || !seatbeltUsable) {
    context.skip("Seatbelt is unavailable on this host");
    return;
  }
  const target = createServer((_request, response) => response.end("gateway-ok"));
  await new Promise<void>((resolveListen, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = target.address();
  assert.ok(address && typeof address !== "string");
  const gateways = new EgressGatewayRegistry(dataDir, undefined, async () => [
    { address: "127.0.0.1", family: 4 },
  ]);
  const permissionEpoch: PermissionEpoch = {
    ...epoch("macos-network"),
    networkAccess: {
      allowPrivateNetwork: true,
      allowedDomains: [`runner.test:${address.port}`],
      mode: "domain-allowlist",
      revision: `macos-localhost-${address.port}`,
    },
    networkPolicy: "domain-allowlist",
  };
  try {
    const result = await executePython(config(), {
      agentId: "main",
      code: `import urllib.request\nprint(urllib.request.urlopen('http://runner.test:${address.port}', timeout=2).read().decode())`,
      executionId: "macos-seatbelt-network",
      permissionEpoch,
      workspaceRoot,
    }, undefined, undefined, undefined, gateways);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.trim(), "gateway-ok");
    assert.equal(result.networkPolicy, "domain-allowlist");
  } finally {
    await gateways.close();
    target.closeAllConnections();
    await new Promise<void>((resolveClose) => target.close(() => resolveClose()));
  }
});

test("macOS persistent shell retains cwd and exports inside one Seatbelt", async (context) => {
  if (process.platform !== "darwin" || !seatbeltUsable) {
    context.skip("Seatbelt is unavailable on this host");
    return;
  }
  const profiles = new SessionEnvProfileStore();
  const manager = new ShellSessionManager({ ...config(), idleTimeoutMs: 0 }, profiles);
  const permissionEpoch = epoch("macos-shell");
  try {
    const first = await manager.execute({
      agentId: "main",
      code: "export SCIENCE_TEST_VALUE=kept; mkdir -p nested; cd nested; printf first",
      executionId: "macos-shell-1",
      kernelMode: "persistent",
      permissionEpoch,
      workspaceRoot,
    });
    const second = await manager.execute({
      agentId: "main",
      code: "printf %s \"$SCIENCE_TEST_VALUE\"",
      executionId: "macos-shell-2",
      kernelMode: "persistent",
      permissionEpoch,
      workspaceRoot,
    });
    assert.equal(first.stdout, "first");
    assert.equal(second.stdout, "kept");
    assert.equal(second.workingDirectory, "/workspace/nested");
    assert.equal(second.environmentRevisionId, "system-shell-seatbelt-v1");
  } finally {
    await manager.close();
  }
});

test("macOS ephemeral shell reports logical workspace provenance", async (context) => {
  if (process.platform !== "darwin" || !seatbeltUsable) {
    context.skip("Seatbelt is unavailable on this host");
    return;
  }
  const result = await executeShell(config(), {
    agentId: "main",
    code: "printf shell-ok > shell.txt",
    executionId: "macos-seatbelt-shell",
    permissionEpoch: epoch("macos-ephemeral-shell"),
    workspaceRoot,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.workingDirectory, "/workspace");
  assert.equal(result.environmentRevisionId, "system-shell-seatbelt-v1");
});

test("macOS runner starts healthy and reports the real sandbox capabilities", async (context) => {
  if (process.platform !== "darwin" || !seatbeltUsable) {
    context.skip("Seatbelt is unavailable on this host");
    return;
  }
  const server = await startRunnerServer({
    ...config(),
    authToken: "macos-runner-test",
    host: "127.0.0.1",
    npuBrokerEnabled: false,
    port: 0,
    scientificEnvsEnabled: false,
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(response.status, 200);
    const health = await response.json() as Record<string, unknown>;
    assert.equal(health.sandbox, "seatbelt");
    assert.equal(health.noNewPrivileges, false);
    assert.equal(health.seccompBaseline, null);
    assert.deepEqual((health.sandboxNetwork as { modes: string[] }).modes, ["none", "domain-allowlist"]);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});
