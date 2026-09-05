// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import test from "node:test";
import { RemoteComputeClient, SshHostKeyUntrustedError, type RemoteSshAccess } from "@sciencediscovery/executor";
import type { RemoteHostTarget, RemoteJob } from "@sciencediscovery/schema";
import { createApiServer } from "./http/index.js";
import type { ServerConfig } from "./bootstrap/config.js";
import { startApprovedRemoteJob } from "./permissions/index.js";
import type { SessionStore } from "./store.js";
import type { ProvenanceRecorder } from "@sciencediscovery/provenance";

test("SSH settings preserve credentials and destination through persistence and trust retries", async (context) => {
  const root = resolve(process.cwd(), ".tmp", `ssh-api-regression-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  const targets: RemoteSshAccess[] = [];
  const authenticationError = "SSH authentication failed for operator@auth-host:2222.\nServer offered: publickey, password.\nActually tried: none, password (none is method discovery).\nStored credentials: password yes; key no.";
  const challenge = { algorithm: "ssh-ed25519", fingerprint: `SHA256:${"a".repeat(43)}`, changed: false };
  const remoteCompute = new RemoteComputeClient(resolve(root, "ssh-config"), async () => { throw new Error("Explicit access required"); }, {
    open: async () => { throw new Error("No real SSH in this test"); },
    run: async (target) => {
      targets.push(structuredClone(target));
      if (target.destination === "auth-host") throw new Error(authenticationError);
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
  await context.test("key file browser is authenticated, metadata-only and reports invalid locations", async () => {
    const path = resolve(root, "picker");
    await mkdir(path);
    const contents = randomBytes(32).toString("hex");
    await writeFile(resolve(path, "selected-key"), contents);
    const url = origin + "/api/remote-hosts/key-files?path=" + encodeURIComponent(path);
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers: { authorization: "Bearer test-token" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const listing = await response.json() as { entries: Array<{ path: string }> };
    assert.equal(listing.entries[0]?.path, resolve(path, "selected-key"));
    assert.ok(!JSON.stringify(listing).includes(contents));
    const missing = await fetch(url + encodeURIComponent("/missing"), { headers: { authorization: "Bearer test-token" } });
    assert.equal(missing.status, 400);
    assert.match(await missing.text(), /does not exist/);
    assert.equal(targets.length, 0, "browsing cannot initiate SSH");
  });
  async function request<T>(path: string, body: unknown, method = "POST"): Promise<{ status: number; body: T }> {
    const response = await fetch(origin + path, { method, headers: { authorization: "Bearer test-token", "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as T };
  }
  await context.test("independent job submission and old approval endpoints are retired", async () => {
    for (const suffix of ["", "/old-job/decision", "/old-job/refresh"]) {
      const before = targets.length;
      const result = await request(`/api/sessions/unused/remote-jobs${suffix}`, { command: "unsafe command", decision: "allow_once" });
      assert.equal(result.status, 410);
      assert.equal(targets.length, before);
    }
  });
  await context.test("method-level authentication diagnostics persist on credential save and subsequent reads", async () => {
    const password = randomBytes(24).toString("hex");
    const added = await request<RemoteHostTarget>("/api/remote-hosts", { alias: "auth-host", port: 2222, username: "operator", password });
    assert.equal(added.status, 201);
    const updated = await request<RemoteHostTarget>(`/api/remote-hosts/${added.body.id}/credentials`, { username: "operator", password }, "PUT");
    assert.equal(updated.status, 200);
    assert.equal(updated.body.error, authenticationError);
    assert.equal(updated.body.hasPassword, true);
    assert.equal(updated.body.hasPrivateKey, false);
    assert.ok(targets.at(-1)?.credentials.password === password);
    const list = await fetch(origin + "/api/remote-hosts", { headers: { authorization: "Bearer test-token" } });
    const hosts = await list.json() as RemoteHostTarget[];
    assert.equal(hosts.find((host) => host.id === added.body.id)?.error, authenticationError);
    assert.ok(!JSON.stringify(hosts).includes(password), "host responses never contain stored passwords");
  });
  await context.test("resolving a historical approval cannot restart bare SSH execution", async () => {
    const before = targets.length;
    const job = { id: "historical-job", state: "approved" } as RemoteJob;
    const result = await startApprovedRemoteJob(job, {
      updateRemoteJob: async (updated: RemoteJob) => updated,
    } as SessionStore, remoteCompute, {} as ProvenanceRecorder);
    assert.equal(result.state, "failed");
    assert.match(result.error!, /retired/);
    assert.equal(targets.length, before);
  });
  await context.test("parallel Runner identities on one host retain independent credentials and metadata", async () => {
    const first = await request<RemoteHostTarget>("/api/remote-hosts", { alias: "same-host", runnerName: "CPU environment", description: "Data preparation", username: "cpu", password: "cpu-secret", port: 2201 });
    const second = await request<RemoteHostTarget>("/api/remote-hosts", { alias: "same-host", runnerName: "GPU environment", description: "Model training", username: "gpu", password: "gpu-secret", port: 2202 });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.notEqual(first.body.id, second.body.id);
    assert.notEqual(first.body.workspaceNamespace, second.body.workspaceNamespace);
    const refreshed = await request<RemoteHostTarget>(`/api/remote-hosts/${second.body.id}/probe`, {});
    assert.equal(refreshed.body.description, "Model training");
    assert.equal(refreshed.body.id, second.body.id);
    assert.equal(targets.at(-1)?.credentials.password, "gpu-secret");
    await request(`/api/remote-hosts/${first.body.id}/probe`, {});
    assert.equal(targets.at(-1)?.credentials.password, "cpu-secret");
    assert.equal(targets.at(-1)?.port, 2201);
  });
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
