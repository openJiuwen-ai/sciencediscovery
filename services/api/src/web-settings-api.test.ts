// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test, describe, before, after } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import type { ServerConfig } from "./bootstrap/config.js";
import { createApiServer } from "./http/index.js";

describe("PUT /api/web/settings answers a client error that names the rejected field", () => {
  const cleanups: Array<() => unknown> = [];
  let request!: (method: "GET" | "PUT", body?: unknown) => Promise<{ status: number; body: { error?: string } & Record<string, unknown> }>;
  after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
  before(async () => {
    const root = resolve(process.cwd(), ".tmp", `web-settings-api-${Date.now()}-${process.pid}`);
    await mkdir(root, { recursive: true });
    const config: ServerConfig = {
      authToken: "test-token", dataDir: root, host: "127.0.0.1", port: 0,
      gatewayIdleTimeoutMs: 240_000, gatewayTurnTimeoutMs: 0, kernelIdleTimeoutMs: 0,
      modelCatalogPath: resolve(root, "absent.json"), paperPythonPath: resolve(root, "no-python"), paperWorkerPath: resolve(root, "no-worker"),
      permissionWaitTimeoutMs: 0, runnerExecTimeoutMs: 0, runnerMaxOutputBytes: 1_000_000, runnerMaxWorkspaceBytes: 10_737_418_240,
      runnerToken: "runner-test-token", runnerUrl: "http://127.0.0.1:1", sshConfigPath: resolve(root, "ssh-config"), staticDir: resolve(root, "no-web"),
      workspaceUpload: { maxFileBytes: 1_000_000, maxRequestBytes: 10_000_000, maxWorkspaceBytes: 10_737_418_240 },
      memoryGraph: { url: "http://127.0.0.1:1", internalToken: "test" },
      evolve: { url: "http://127.0.0.1:1", internalToken: "test" },
    };
    const catalog = { loadedAt: new Date().toISOString(), revision: "web-settings-test", servers: [] };
    const server = createApiServer(config, {
      mcpTransport: {
        catalog: async () => catalog,
        reload: async () => catalog,
        invoke: async () => { throw new Error("No MCP in a settings test"); },
      },
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    cleanups.push(async () => {
      await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); });
      await rm(root, { force: true, recursive: true });
    });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    request = async (method, body) => {
      const response = await fetch(`${origin}/api/web/settings`, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        method,
      });
      return { body: await response.json() as { error?: string } & Record<string, unknown>, status: response.status };
    };
  });

  test("an unsupported fetch provider is a 400 that names it, not a 500", async () => {
    const response = await request("PUT", { fetchProvider: "definitely-not-a-provider" });
    assert.equal(response.status, 400, "an unsupported provider is client input, not a server fault");
    assert.equal(response.body.error, "Unsupported web fetch provider");
  });

  test("an unknown setting key is a 400 that names the key", async () => {
    const response = await request("PUT", { nope: 1 });
    assert.equal(response.status, 400, "an unrecognised key is client input, not a server fault");
    assert.equal(response.body.error, "Unknown web setting: nope");
  });

  test("a valid update still answers 200 and reads back through GET", async () => {
    const put = await request("PUT", { searchCacheTtlSeconds: 17 });
    assert.equal(put.status, 200);
    const get = await request("GET");
    assert.equal(get.status, 200);
    assert.equal(get.body.searchCacheTtlSeconds, 17, "the accepted value is persisted, not just echoed");
  });
});
