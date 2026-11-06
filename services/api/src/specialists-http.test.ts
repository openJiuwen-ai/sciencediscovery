// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test, describe, before, after } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import type { Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import type { ServerConfig } from "./bootstrap/config.js";
import { createApiServer, specialistErrorStatus } from "./http/index.js";

type Reply = { status: number; body: { error?: string } & Record<string, unknown> };

describe("the Specialist routes answer a rejected input as a client error", () => {
  const cleanups: Array<() => unknown> = [];
  let server: Server;
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
    server = createApiServer(config);
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

  test("an unexpected fault inside the block is still a 500, not a relabelled 400", async (context) => {
    // The settings store has no injection seam, so fail the HTTPS response
    // itself: it throws from inside the guarded block, which is exactly the
    // "anything else" branch the route must rethrow to the catch-all.
    server.prependOnceListener("request", (_request, response) => {
      const writeHead = response.writeHead.bind(response as ServerResponse);
      let injected = false;
      context.mock.method(response as ServerResponse, "writeHead", (...args: Parameters<ServerResponse["writeHead"]>) => {
        if (!injected) { injected = true; throw new Error("injected internal failure"); }
        return writeHead(...args);
      });
    });
    const response = await request("POST", "/api/specialists", {
      connectorIds: [], description: "d", enabledSkillIds: [], instructions: "i", name: "internal-fault subject",
    });
    assert.equal(response.status, 500, "an unexpected fault must not be claimed as client input");
    assert.equal(response.body.error, "Internal server error");
  });
});

test("a store fault that is not the store's own rejection is never relabelled 400", () => {
  assert.equal(specialistErrorStatus(new Error("Specialist not found")), 404);
  assert.equal(specialistErrorStatus(new Error("Specialist name already exists")), 400);
  assert.equal(specialistErrorStatus(new Error("Built-in specialists are read-only; only their enabled flag can be toggled")), 400);
  assert.equal(specialistErrorStatus(new Error("Specialist skills are unavailable: nope")), 400);
  assert.equal(specialistErrorStatus(new Error("enabled must be a boolean")), 400);
  for (const fault of [new Error("Catalog database is not initialized"), new TypeError("database is locked"), new Error("ENOTDIR: not a directory")]) {
    assert.equal(specialistErrorStatus(fault), undefined,
      `an unexpected fault must reach the catch-all and read 500, not be claimed as client input: ${fault.message}`);
  }
});

test("every rejection the Specialist store raises is still a client error", () => {
  // The exact wording of services/api/src/store.ts, one entry per throw. A store
  // rejection that loses its mapping silently becomes a 500 the settings pane
  // cannot explain, so each one is pinned by its own message.
  const rejections = [
    "Specialist not found",
    "Specialist name is required",
    "Specialist description is required",
    "Specialist description must be 1-500 characters",
    "Specialist instructions must be 1-20000 characters",
    "Specialist name already exists",
    "Specialist skills are unavailable: nope",
    "Specialist connectors are unavailable: nope",
    "Built-in specialists are read-only; only their enabled flag can be toggled",
    "Built-in specialists cannot be deleted",
    "Specialist is referenced by a Session or subagent and cannot be deleted",
    "enabled must be a boolean",
  ];
  for (const message of rejections) {
    const status = specialistErrorStatus(new Error(message));
    assert.equal(status, message === "Specialist not found" ? 404 : 400,
      `the store's own rejection must keep its status, not fall through to 500: ${message}`);
  }
});

test("a fault that merely reads like input validation is still a 500", () => {
  // The store's wording is the only thing that may be read as client input. A
  // fault from anywhere else must not be relabelled because a word matched:
  // these all match the legacy isKnownClientInputError patterns.
  const faults = [
    "Catalog contains an unknown value",
    "the scheduler must not be unlocked here",
    "sqlite cannot open the catalog database",
    "secret storage is unavailable",
  ];
  for (const message of faults) {
    assert.equal(specialistErrorStatus(new Error(message)), undefined,
      `only the store's own wording is client input; this fault must read 500: ${message}`);
  }
});
