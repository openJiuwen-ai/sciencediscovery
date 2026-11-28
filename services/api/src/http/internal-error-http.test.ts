// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test, describe, before, after } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import type { Server, ServerResponse } from "node:http";
import { resolve } from "node:path";

import type { ServerConfig } from "../bootstrap/config.js";
import { createApiServer } from "./index.js";
import { apiLog } from "../logging.js";

type Reply = { status: number; body: { error?: string } & Record<string, unknown> };

describe("an internal fault is answered 500 and never quotes its own message", () => {
  const cleanups: Array<() => unknown> = [];
  let server: Server;
  let request!: (method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) => Promise<Reply>;
  after(async () => {
    const ordered = cleanups.reverse();
    await Promise.all(ordered.map((cleanup) => cleanup()));
  });
  before(async () => {
    const root = resolve(process.cwd(), ".tmp", `internal-error-http-${Date.now()}-${process.pid}`);
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
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("the test server did not bind a TCP address");
    }
    const origin = `http://127.0.0.1:${address.port}`;
    request = async (method, path, body) => {
      const response = await fetch(`${origin}${path}`, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        method,
      });
      return { body: await response.json() as { error?: string } & Record<string, unknown>, status: response.status };
    };
  });

  /**
   * Throw once from inside the handler, the way a store fault surfaces: the
   * settings stores have no injection seam, so the first `writeHead` is where a
   * real fault would leave the request handler.
   */
  function failOnceWith(context: { mock: { method: (target: object, name: string, implementation: (...args: never[]) => unknown) => void } }, fault: Error): void {
    server.prependOnceListener("request", (_request, response) => {
      const writeHead = response.writeHead.bind(response as ServerResponse);
      let injected = false;
      context.mock.method(response as ServerResponse, "writeHead",
        (...args: Parameters<ServerResponse["writeHead"]>) => {
          if (!injected) {
            injected = true;
            throw fault;
          }
          return writeHead(...args);
        });
    });
  }

  test("a TypeError whose text says \"cannot\" is a 500 with the generic body", async (context) => {
    const events: string[] = [];
    context.mock.method(apiLog, "error", (event: string) => { events.push(event); });
    // #1520's own message: /cannot/ matched it, so the client used to receive
    // `400` plus this JavaScript text as the error body.
    failOnceWith(context as never, new TypeError("Cannot read properties of undefined (reading 'match')"));

    const response = await request("GET", "/api/projects");

    assert.equal(response.status, 500, "an internal fault is the server's problem, not the caller's");
    assert.equal(response.body.error, "Internal server error");
    const body = JSON.stringify(response.body);
    assert.equal(body.includes("reading 'match'"), false, "the interpreter's text must not reach the client");
    assert.equal(body.includes("Cannot read properties"), false, "the interpreter's text must not reach the client");
    assert.ok(events.includes("unclassified_request_error"),
      `the fault must be logged as unclassified for the team to find it, saw ${JSON.stringify(events)}`);
  });

  test("a plain Error quoting the same text is a 500 too", async (context) => {
    const events: string[] = [];
    context.mock.method(apiLog, "error", (event: string) => { events.push(event); });
    // A handler that re-wraps `cause.message` keeps the engine's wording and
    // loses the class; the text alone must still be read as this server's
    // fault, never as caller input the client gets to see.
    failOnceWith(context as never, new Error("Cannot read properties of undefined (reading 'match')"));

    const response = await request("GET", "/api/projects");

    assert.equal(response.status, 500, "the engine's wording is never the caller's fault");
    assert.equal(response.body.error, "Internal server error");
    const body = JSON.stringify(response.body);
    assert.equal(body.includes("reading 'match'"), false, "the interpreter's text must not reach the client");
    assert.equal(body.includes("Cannot read properties"), false, "the interpreter's text must not reach the client");
    assert.ok(events.includes("unclassified_request_error"),
      `the fault must be logged as unclassified for the team to find it, saw ${JSON.stringify(events)}`);
  });

  test("an error carrying a system code is a 500 even when its text says \"cannot\"", async (context) => {
    const events: string[] = [];
    context.mock.method(apiLog, "error", (event: string) => { events.push(event); });
    // A `code` marks the layer that raised the error, not the caller: the
    // catch-all answers the codes it knows before it reads any prose (#1533).
    failOnceWith(context as never, Object.assign(new Error("cannot start a transaction within a transaction"), { code: "ERR_SQLITE_ERROR" }));

    const response = await request("GET", "/api/projects");

    assert.equal(response.status, 500, "a coded fault is this server's, not the caller's");
    assert.equal(response.body.error, "Internal server error");
    assert.equal(JSON.stringify(response.body).includes("cannot start a transaction"), false,
      "the dependency's text must not reach the client");
    assert.ok(events.includes("unclassified_request_error"),
      `the fault must be logged as unclassified for the team to find it, saw ${JSON.stringify(events)}`);
  });

  test("a validator's own rejection still answers 400 with its wording", async () => {
    const response = await request("POST", "/api/specialists", { description: "d", instructions: "i" });
    assert.equal(response.status, 400, "legacy validator wording keeps its 400");
    assert.equal(response.body.error, "Specialist name is required");
  });
});
