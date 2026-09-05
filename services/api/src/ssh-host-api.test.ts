// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import test from "node:test";
import { RemoteComputeClient, SshHostKeyUntrustedError, type RemoteSshAccess } from "@sciencediscovery/executor";
import type { RemoteHostTarget } from "@sciencediscovery/schema";
import { createApiServer } from "./http/index.js";
import type { ServerConfig } from "./bootstrap/config.js";

test("SSH settings preserve credentials and destination through persistence and trust retries", async (context) => {
  const root = resolve(process.cwd(), ".tmp", `ssh-api-regression-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  const targets: RemoteSshAccess[] = [];
  const challenge = { algorithm: "ssh-ed25519", fingerprint: `SHA256:${"a".repeat(43)}`, changed: false };
  const remoteCompute = new RemoteComputeClient(resolve(root, "ssh-config"), async () => { throw new Error("Explicit access required"); }, {
    open: async () => { throw new Error("No real SSH in this test"); },
    run: async (target) => {
      targets.push(structuredClone(target));
      if (target.destination === "generated-host" && !target.trustedHostKey) {
        throw new SshHostKeyUntrustedError(challenge, target.destination);
      }
      return { exitCode: 0, stderr: "", stdout: "platform=Linux\ncpu=8\nmemory_kib=65536\nrunner=1\nnode=v22.19.0\n" };
    },
  });
  const config: ServerConfig = {
    authToken: "test-token", dataDir: root, host: "127.0.0.1", port: 0,
    gatewayIdleTimeoutMs: 240_000, gatewayTurnTimeoutMs: 0, kernelIdleTimeoutMs: 0,
    modelCatalogPath: resolve(root, "absent.json"), paperPythonPath: resolve(root, "no-python"), paperWorkerPath: resolve(root, "no-worker"),
    permissionWaitTimeoutMs: 0, runnerExecTimeoutMs: 0, runnerMaxOutputBytes: 1_000_000, runnerMaxWorkspaceBytes: 10_737_418_240,
    runnerToken: "runner-test-token", runnerUrl: "http://127.0.0.1:1", sshConfigPath: resolve(root, "ssh-config"), staticDir: resolve(root, "no-web"),
    workspaceUpload: { maxFileBytes: 1_000_000, maxRequestBytes: 10_000_000, maxWorkspaceBytes: 10_737_418_240 },
    memoryGraph: { url: "http://127.0.0.1:1", internalToken: "test" },
  };
  const catalog = { loadedAt: new Date().toISOString(), revision: "ssh-settings-test", servers: [] };
  const server = createApiServer(config, { remoteCompute, mcpTransport: {
    catalog: async () => catalog, reload: async () => catalog, invoke: async () => { throw new Error("No MCP in settings"); },
  } });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  context.after(async () => {
    await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); });
    await rm(root, { force: true, recursive: true });
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function request<T>(path: string, body: unknown, method = "POST"): Promise<{ status: number; body: T }> {
    const response = await fetch(origin + path, { method, headers: { authorization: "Bearer test-token", "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as T };
  }
  let hostId: string;
  await context.test("port, password and passphrase survive registration, probe and credential updates", async () => {
    const added = await request<RemoteHostTarget>("/api/remote-hosts", { alias: "port-host", port: 2222, username: "old", password: " password ", passphrase: " phrase " });
    assert.equal(added.status, 201);
    hostId = added.body.id;
    assert.equal(added.body.port, 2222);
    assert.equal(targets.at(-1)?.credentials.password, " password ");
    assert.equal(targets.at(-1)?.credentials.passphrase, " phrase ");
    const updated = await request<RemoteHostTarget>(`/api/remote-hosts/${hostId}/credentials`, { username: "new", password: " new password ", passphrase: " new phrase " }, "PUT");
    assert.equal(updated.status, 200);
    assert.equal(updated.body.port, 2222);
    assert.equal(targets.at(-1)?.port, 2222);
    assert.equal(targets.at(-1)?.credentials.username, "new");
    assert.equal(targets.at(-1)?.credentials.password, " new password ");
    assert.equal(targets.at(-1)?.credentials.passphrase, " new phrase ");
    await request(`/api/remote-hosts/${hostId}/probe`, {});
    assert.equal(targets.at(-1)?.port, 2222);
    const retained = await request<RemoteHostTarget>(`/api/remote-hosts/${hostId}/credentials`, {}, "PUT");
    assert.equal(retained.body.hasPassword, true);
    assert.equal(targets.at(-1)?.credentials.password, " new password ");
  });
  await context.test("generated keys are consumed after saving and trust retries use the saved host", async () => {
    const generated = await request<{ privateKeyPath: string; publicKey: string }>("/api/remote-hosts/generate-key", {});
    const input = { alias: "generated-host", username: "user", privateKeyPath: generated.body.privateKeyPath };
    const failed = await request<{ details: { hostId: string }; code: string }>("/api/remote-hosts", input);
    assert.equal(failed.status, 409);
    assert.equal(failed.body.code, "SSH_HOST_KEY_UNTRUSTED");
    assert.ok(failed.body.details.hostId);
    await assert.rejects(access(input.privateKeyPath), { code: "ENOENT" });
    const trusted = await request<RemoteHostTarget>(`/api/remote-hosts/${failed.body.details.hostId}/trust-host-key`, challenge);
    assert.equal(trusted.status, 200);
    assert.equal(trusted.body.status, "ready");
    assert.equal(trusted.body.hasPrivateKey, true);
    assert.equal(trusted.body.publicKey?.split(" ").slice(0, 2).join(" "), generated.body.publicKey.split(" ").slice(0, 2).join(" "));
    assert.ok(targets.at(-1)?.credentials.privateKey);
    assert.equal(JSON.stringify(trusted.body).includes("PRIVATE KEY"), false);
    const unsaved = await request<{ privateKeyPath: string }>("/api/remote-hosts/generate-key", {});
    const rejected = await request("/api/remote-hosts", { alias: "invalid name", username: "user", privateKeyPath: unsaved.body.privateKeyPath });
    assert.equal(rejected.status, 400);
    await access(unsaved.body.privateKeyPath);
  });
  await context.test("explicit credentials override login without bypassing config destination defaults", async () => {
    await writeFile(config.sshConfigPath, "Host cluster\n HostName resolved.example\n Port 2223\n User imported\n IdentityFile /missing/unused-key\n");
    const imported = await request<RemoteHostTarget>("/api/remote-hosts", { alias: "cluster", username: "manual", password: "password" });
    assert.equal(imported.status, 201);
    assert.equal(imported.body.port, 2223);
    assert.equal(targets.at(-1)?.destination, "resolved.example");
    assert.equal(targets.at(-1)?.credentials.username, "manual");
    const overridden = await request<RemoteHostTarget>("/api/remote-hosts", { alias: "cluster", port: 2224, username: "manual", password: "password" });
    assert.equal(overridden.body.port, 2224);
    assert.equal(targets.at(-1)?.port, 2224);
  });
  await context.test("connect host-key failures use the same structured error as probe", async () => {
    context.mock.method(remoteCompute, "connectRunner", async (host: RemoteHostTarget) => ({
      hostId: host.id, state: "error" as const, error: "Host key changed", hostKeyChallenge: { ...challenge, changed: true },
    }));
    const failed = await request<{ code: string; details: { hostId: string; hostKey: unknown } }>(`/api/remote-hosts/${hostId}/runner/connect`, {});
    assert.equal(failed.status, 409);
    assert.equal(failed.body.code, "SSH_HOST_KEY_CHANGED");
    assert.equal(failed.body.details.hostId, hostId);
    assert.deepEqual(failed.body.details.hostKey, { algorithm: challenge.algorithm, fingerprint: challenge.fingerprint });
  });
});
