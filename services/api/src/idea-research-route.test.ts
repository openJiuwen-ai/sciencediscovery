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

/**
 * The assistant turn the research route appends when it starts a research.
 *
 * No client sends `{operation: "create", content}`: both front ends reach the engine
 * through the agent's `create_idea_research` tool, which appends no message. That makes
 * the route's sentence the one piece of user-visible copy nothing else exercises, so it
 * is pinned here rather than through a journey that would stay green without it.
 */

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test, describe } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import type { ServerConfig } from "./bootstrap/config.js";
import { createApiServer } from "./http/index.js";

const authorization = { authorization: "Bearer test-token", "content-type": "application/json" };

/** What the Python engine answers for a `create`; the route only reads `research.id`. */
const STARTED = {
  research: { id: "research-1", status: "running" },
  graph: { edges: [], nodes: [], objective: "", revision: 0, treeId: "research-1", updatedAt: "" },
};

function testConfig(dataDir: string, evolveUrl: string): ServerConfig {
  return {
    authToken: "test-token",
    dataDir,
    evolve: { internalToken: "engine-token", url: evolveUrl },
    gatewayIdleTimeoutMs: 240_000,
    gatewayTurnTimeoutMs: 0,
    host: "127.0.0.1",
    kernelIdleTimeoutMs: 0,
    memoryGraph: { internalToken: "test", url: "http://127.0.0.1:1" },
    modelCatalogPath: resolve(dataDir, "absent.json"),
    paperPythonPath: resolve(dataDir, "no-python"),
    paperWorkerPath: resolve(dataDir, "no-worker"),
    permissionWaitTimeoutMs: 0,
    port: 0,
    runnerExecTimeoutMs: 0,
    runnerMaxOutputBytes: 1_000_000,
    runnerMaxWorkspaceBytes: 10_737_418_240,
    runnerToken: "runner-test-token",
    runnerUrl: "http://127.0.0.1:1",
    sshConfigPath: resolve(dataDir, "ssh-config"),
    staticDir: resolve(dataDir, "no-web"),
    workspaceUpload: { maxFileBytes: 1_000_000, maxRequestBytes: 10_000_000, maxWorkspaceBytes: 10_737_418_240 },
  };
}

describe("starting a research through its route", () => {
  test("the assistant turn it appends names the feature in Chinese", async (context) => {
    const dataDir = resolve(process.cwd(), ".tmp", `idea-research-route-${Date.now()}-${process.pid}`);
    await mkdir(dataDir, { recursive: true });
    const now = "2026-01-01T00:00:00.000Z";
    const project = { createdAt: now, id: "project-idea-route", name: "Route Project", updatedAt: now };
    const session = {
      approvalMode: "always_allow" as const,
      createdAt: now,
      id: "session-idea-route",
      projectId: project.id,
      title: "Route Session",
      updatedAt: now,
    };
    await writeFile(resolve(dataDir, "catalog.json"), `${JSON.stringify({ projects: [project], sessions: [session] }, null, 2)}\n`, "utf8");

    // The engine the research client talks to. `connection()` probes `/health` and one
    // authenticated cancel before it will hand the client a URL, so both are answered.
    const commands: Array<Record<string, unknown>> = [];
    const engine = createHttpServer((request, response) => {
      if (request.method === "GET" && request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "healthy" }));
        return;
      }
      if (request.method === "POST" && (request.url ?? "").endsWith("/stop")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      if (request.method === "POST" && request.url === "/idea-tree/research/command") {
        let body = "";
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          commands.push(JSON.parse(body) as Record<string, unknown>);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(STARTED));
        });
        return;
      }
      response.writeHead(404).end();
    });
    context.after(() => new Promise<void>((done) => { engine.close(() => done()); engine.closeAllConnections(); }));
    await new Promise<void>((listening) => engine.listen(0, "127.0.0.1", listening));
    const engineOrigin = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;

    const api = createApiServer(testConfig(dataDir, engineOrigin));
    context.after(() => new Promise<void>((done) => {
      api.close(() => done());
      api.closeAllConnections();
      void rm(dataDir, { force: true, recursive: true });
    }));
    await new Promise<void>((listening) => api.listen(0, "127.0.0.1", listening));
    const origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    // A create needs a model with a token: that is what the engine is handed credentials for.
    const model = await fetch(`${origin}/api/models`, {
      body: JSON.stringify({ apiToken: "stub-token", baseUrl: "http://127.0.0.1:1/v1", model: "stub-model", name: "Stub engine" }),
      headers: authorization,
      method: "POST",
    });
    const modelBody = await model.text();
    assert.equal(model.status, 201, `the stub model is accepted: ${modelBody}`);

    const content = "/idea-tree 探索低成本铁锰催化剂";
    const started = await fetch(`${origin}/api/sessions/${session.id}/idea-tree/research`, {
      body: JSON.stringify({ content, operation: "create" }),
      headers: authorization,
      method: "POST",
    });
    const startedBody = await started.text();
    assert.equal(started.status, 200, `the route starts the research: ${startedBody}`);
    const view = JSON.parse(startedBody) as { research: { id: string } };
    assert.equal(view.research.id, STARTED.research.id);

    // The engine was asked to create, with the command stripped off the objective.
    assert.equal(commands.length, 1);
    assert.equal(commands[0]?.operation, "create");
    assert.equal(commands[0]?.objective, "探索低成本铁锰催化剂");

    const messages = JSON.parse(await readFile(resolve(dataDir, "messages", `${session.id}.json`), "utf8")) as Array<{ content: string; role: string }>;
    const assistant = messages.filter((message) => message.role === "assistant");
    assert.equal(assistant.length, 1, "the route appends exactly one assistant turn");
    assert.match(assistant[0]!.content, /^已启动研究思路树（research-1）/);
    assert.ok(assistant[0]!.content.includes("请在研究思路树卡片查看实时进度"));
    assert.ok(!assistant[0]!.content.includes("Idea Tree"), "a zh-CN reader does not meet the English name in this turn");
  });
});
