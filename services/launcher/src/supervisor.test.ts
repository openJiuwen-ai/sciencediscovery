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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { Supervisor, type ServiceDefinition } from "./supervisor.js";

/** A Node script that serves /health and stays up until it is signalled. */
const HEALTHY_SERVICE = `
const { createServer } = require("node:http");
const server = createServer((request, response) => {
  response.writeHead(request.url === "/health" ? 200 : 404).end("ok");
});
server.listen(Number(process.env.PORT), "127.0.0.1");
process.on("SIGTERM", () => { server.close(); process.exit(0); });
`;

const IMMEDIATE_EXIT = 'process.exit(3);\n';
const IGNORES_SIGTERM = `
process.on("SIGTERM", () => {});
const { createServer } = require("node:http");
const server = createServer((request, response) => response.writeHead(200).end("ok"));
server.listen(Number(process.env.PORT), "127.0.0.1");
setInterval(() => {}, 1000);
`;

describe("service supervision", () => {
  let workspace = "";
  let basePort = 0;

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "sciencediscovery-supervisor-"));
    await writeFile(join(workspace, "healthy.cjs"), HEALTHY_SERVICE);
    await writeFile(join(workspace, "exits.cjs"), IMMEDIATE_EXIT);
    await writeFile(join(workspace, "stubborn.cjs"), IGNORES_SIGTERM);
    basePort = 24_000 + (process.pid % 1_000) * 10;
  });

  after(async () => {
    await rm(workspace, { force: true, recursive: true });
  });

  const service = (name: string, script: string, port?: number): ServiceDefinition => ({
    args: [join(workspace, script)],
    command: process.execPath,
    cwd: workspace,
    env: { ...process.env, PORT: String(port ?? 0) },
    name,
    ...(port ? { healthUrl: `http://127.0.0.1:${port}/health` } : {}),
  });

  test("starts services in order and gates each on health", async () => {
    const started: string[] = [];
    const supervisor = new Supervisor({
      healthAttempts: 100,
      healthIntervalMs: 50,
      log: (message) => started.push(message),
    });
    try {
      await supervisor.start([
        service("first", "healthy.cjs", basePort + 1),
        service("second", "healthy.cjs", basePort + 2),
      ]);
      // Both endpoints answer only because start() waited for each in turn.
      for (const port of [basePort + 1, basePort + 2]) {
        assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).ok, true);
      }
      assert.deepEqual(started, ["Starting first...", "Starting second..."]);
    } finally {
      await supervisor.stop();
    }
  });

  test("reports which service died before it became healthy", async () => {
    const supervisor = new Supervisor({ healthAttempts: 50, healthIntervalMs: 50, log: () => {} });
    try {
      await assert.rejects(
        supervisor.start([service("doomed", "exits.cjs", basePort + 3)]),
        /doomed exited before becoming healthy \(status 3\)/,
      );
    } finally {
      await supervisor.stop();
    }
  });

  test("gives up on an endpoint that never answers", async () => {
    const supervisor = new Supervisor({ healthAttempts: 3, healthIntervalMs: 20, log: () => {} });
    try {
      const definition = service("silent", "healthy.cjs", basePort + 4);
      // Point the health probe at a port nothing listens on.
      await assert.rejects(
        supervisor.start([{ ...definition, healthUrl: `http://127.0.0.1:${basePort + 5}/health` }]),
        /silent did not become healthy/,
      );
    } finally {
      await supervisor.stop();
    }
  });

  test("waitForFirstExit names the service that stopped", async () => {
    const supervisor = new Supervisor({ healthAttempts: 100, healthIntervalMs: 50, log: () => {} });
    try {
      await supervisor.start([service("stopper", "healthy.cjs", basePort + 6)]);
      const stopped = supervisor.waitForFirstExit();
      await fetch(`http://127.0.0.1:${basePort + 6}/health`);
      process.kill(0, 0); // no-op sanity check that signalling works in this env
      await supervisor.stop();
      const first = await stopped;
      assert.equal(first.name, "stopper");
    } finally {
      await supervisor.stop();
    }
  });

  test("escalates to SIGKILL when a service ignores SIGTERM", async () => {
    const messages: string[] = [];
    const supervisor = new Supervisor({
      healthAttempts: 100,
      healthIntervalMs: 50,
      log: (message) => messages.push(message),
      shutdownGraceMs: 300,
    });
    await supervisor.start([service("stubborn", "stubborn.cjs", basePort + 7)]);
    await supervisor.stop();
    assert.match(messages.join("\n"), /stubborn ignored SIGTERM; sending SIGKILL/);
  });

  test("stop is idempotent", async () => {
    const supervisor = new Supervisor({ healthAttempts: 100, healthIntervalMs: 50, log: () => {} });
    await supervisor.start([service("once", "healthy.cjs", basePort + 8)]);
    await supervisor.stop();
    await supervisor.stop();
  });
});
