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

type Reply = { status: number; body: { error?: string } & Record<string, unknown> };

describe("the Specialist routes answer a rejected input as a client error", () => {
  const cleanups: Array<() => unknown> = [];
  let request!: (method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) => Promise<Reply>;
  after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
  before(async () => {
    const root = resolve(process.cwd(), ".tmp", `specialists-http-${Date.now()}-${process.pid}`);
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
    const server = createApiServer(config);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    cleanups.push(async () => {
      await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); });
      await rm(root, { force: true, recursive: true });
    });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    request = async (method, path, body) => {
      const response = await fetch(`${origin}${path}`, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        method,
      });
      return { body: await response.json() as { error?: string } & Record<string, unknown>, status: response.status };
    };
  });

  test("a taken Specialist name is a 400 that keeps the store's wording", async () => {
    const specialist = { connectorIds: [], description: "d", enabledSkillIds: [], instructions: "i", name: "duplicate-name subject" };
    const first = await request("POST", "/api/specialists", specialist);
    assert.equal(first.status, 201, "the first create is accepted");
    const second = await request("POST", "/api/specialists", specialist);
    assert.equal(second.status, 400, "a duplicate name is client input, not a server fault");
    assert.equal(second.body.error, "Specialist name already exists");
  });

  test("an unknown Specialist id on PUT is a 404", async () => {
    const response = await request("PUT", "/api/specialists/nope", { name: "nope renamed" });
    assert.equal(response.status, 404);
    assert.equal(response.body.error, "Specialist not found");
  });

  test("an unknown Specialist id on DELETE is a 404", async () => {
    const response = await request("DELETE", "/api/specialists/nope");
    assert.equal(response.status, 404);
    assert.equal(response.body.error, "Specialist not found");
  });

  test("editing a built-in Specialist is a 400 that says it is read-only", async () => {
    const response = await request("PUT", "/api/specialists/builtin-assessment-screener", { name: "assessment-screener renamed" });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, "Built-in specialists are read-only; only their enabled flag can be toggled");
  });

  test("toggling a built-in Specialist's enabled flag still answers 200 and flips it", async () => {
    const response = await request("PUT", "/api/specialists/builtin-assessment-screener", { enabled: false });
    assert.equal(response.status, 200, "the enabled toggle stays the documented writable field");
    assert.equal(response.body.enabled, false);
    const listed = await request("GET", "/api/specialists");
    assert.equal(listed.status, 200);
    const screener = (listed.body as unknown as Array<{ enabled: boolean; id: string }>).find((entry) => entry.id === "builtin-assessment-screener");
    assert.equal(screener?.enabled, false, "the toggle is persisted, not just echoed");
  });

  test("deleting a built-in Specialist still answers 400 and keeps its message", async () => {
    const response = await request("DELETE", "/api/specialists/builtin-assessment-screener");
    assert.equal(response.status, 400);
    assert.equal(response.body.error, "Built-in specialists cannot be deleted");
  });
});
