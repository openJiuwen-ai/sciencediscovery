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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { TestContext } from "node:test";

import { closeApiServer, createApiServer } from "./http/index.js";
import { offlineMcpTransport } from "./mcp/offline-transport.fixture.js";
import type { ServerConfig } from "./bootstrap/config.js";

const authorization = { authorization: "Bearer test-token" };

function testConfig(dataDir: string): ServerConfig {
  return {
    authToken: "test-token",
    dataDir,
    gatewayIdleTimeoutMs: 240_000,
    gatewayTurnTimeoutMs: 0,
    host: "127.0.0.1",
    kernelIdleTimeoutMs: 0,
    modelCatalogPath: resolve(dataDir, "model-catalog/absent.json"),
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
    staticDir: resolve(dataDir, "missing-web-dist"),
    workspaceUpload: { maxFileBytes: 1_000_000, maxRequestBytes: 10_000_000, maxWorkspaceBytes: 10_737_418_240 },
    memoryGraph: { url: "http://127.0.0.1:1", internalToken: "test" },
    evolve: { url: "", internalToken: "" },
  };
}

/** A bundled repository root where `idea-tree-team` ships the unquoted `: `
 *  description that used to reject every request, and `literature-searcher` is
 *  a healthy package that must survive the skip. */
async function temporaryRepository(): Promise<string> {
  const root = resolve(process.cwd(), ".tmp", "bundled-skill-api");
  await mkdir(root, { recursive: true });
  const repository = await mkdtemp(root);
  await mkdir(resolve(repository, "skills", "idea-tree-team"), { recursive: true });
  await writeFile(resolve(repository, "skills", "idea-tree-team", "SKILL.md"), [
    "---",
    "name: idea-tree-team",
    "description: Use when the user asks for autonomous Idea Tree research: prepare the inputs.",
    "---",
    "",
  ].join("\n"));
  await mkdir(resolve(repository, "skills", "literature-searcher"), { recursive: true });
  await writeFile(resolve(repository, "skills", "literature-searcher", "SKILL.md"), [
    "---",
    "name: literature-searcher",
    "description: Search the literature for evidence.",
    "---",
    "",
  ].join("\n"));
  return repository;
}

async function startApi(
  context: TestContext,
  dataDir: string,
  dependencies: { repositoryRoot?: string } = {},
): Promise<string> {
  await mkdir(dataDir, { recursive: true });
  const server = createApiServer(testConfig(dataDir), { mcpTransport: offlineMcpTransport, ...dependencies });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  context.after(async () => {
    await closeApiServer(server);
    await rm(resolve(dataDir, ".."), { force: true, maxRetries: 10, recursive: true, retryDelay: 50 });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object", "the API server is listening on a TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function healthy(origin: string, deadlineMs = 30_000): Promise<Response> {
  const deadline = Date.now() + deadlineMs;
  let response = await fetch(`${origin}/health`);
  while (response.status !== 200 && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 100));
    response = await fetch(`${origin}/health`);
  }
  return response;
}

test("a malformed bundled skill is contained: /health and /api/skills keep answering", async (context) => {
  const repository = await temporaryRepository();
  const origin = await startApi(context, resolve(repository, "data"), { repositoryRoot: repository });

  const health = await healthy(origin);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { liveness: "ok", service: "sciencediscovery-api" });
  // The authenticated detail reads the same successful startup.
  const detail = await fetch(`${origin}/health`, { headers: authorization });
  assert.equal(detail.status, 200);

  const response = await fetch(`${origin}/api/skills`, { headers: authorization });
  assert.equal(response.status, 200);
  const skills = await response.json() as Array<{ id: string; loadFailure?: { code: string; message: string } }>;
  const valid = skills.find((skill) => skill.id === "literature-searcher");
  assert.ok(valid, "the valid bundled skill is listed");
  assert.equal(valid.loadFailure, undefined);
  const failed = skills.find((skill) => skill.id === "idea-tree-team");
  assert.ok(failed, "the broken bundled skill is listed as failed instead of disappearing");
  assert.equal(failed.loadFailure?.code, "SKILL_VALIDATION");
  assert.match(failed.loadFailure?.message ?? "", /frontmatter|YAML/i);
});

test("a startup component that is unavailable answers 503, never the validation error as 400", async (context) => {
  const repository = await temporaryRepository();
  const dataDir = resolve(repository, "data");
  // An unsupported managed-catalog schema makes SkillCatalog.load reject after
  // the bundled packages loaded: the failure reaches `ready`, which every route
  // waits on. It must be reported as an unavailable service, not as a malformed
  // request from the caller.
  await mkdir(resolve(dataDir, "skills"), { recursive: true });
  await writeFile(resolve(dataDir, "skills", "catalog.json"), `${JSON.stringify({ schemaVersion: 2 })}\n`);
  const origin = await startApi(context, dataDir, { repositoryRoot: repository });

  const health = await fetch(`${origin}/health`);
  assert.equal(health.status, 503);
  const body = await health.json() as { error?: string; liveness?: string };
  assert.ok(body.liveness === "starting" || body.liveness === "unavailable");
  assert.doesNotMatch(JSON.stringify(body), /frontmatter|SKILL_VALIDATION/i);

  const projects = await fetch(`${origin}/api/projects`, { headers: authorization });
  assert.equal(projects.status, 503);
  assert.doesNotMatch(JSON.stringify(await projects.json()), /frontmatter|SKILL_VALIDATION/i);
});

test("the by-id switch answers 404 for a bundled package that failed to load, not 502", async (context) => {
  const repository = await temporaryRepository();
  // The by-id route only switches skills when JiuwenSwarm is the backend. The
  // lookup happens before any adapter call, so an unreachable adapter URL is
  // enough to reach the assertion without a fake server.
  const previous = { adapter: process.env.SCIENCE_AGENT_ADAPTER_URL, executor: process.env.SCIENCE_AGENT_EXECUTOR };
  process.env.SCIENCE_AGENT_EXECUTOR = "jiuwenswarm";
  process.env.SCIENCE_AGENT_ADAPTER_URL = "http://127.0.0.1:1";
  context.after(() => {
    if (previous.executor === undefined) delete process.env.SCIENCE_AGENT_EXECUTOR;
    else process.env.SCIENCE_AGENT_EXECUTOR = previous.executor;
    if (previous.adapter === undefined) delete process.env.SCIENCE_AGENT_ADAPTER_URL;
    else process.env.SCIENCE_AGENT_ADAPTER_URL = previous.adapter;
  });
  const origin = await startApi(context, resolve(repository, "data"), { repositoryRoot: repository });
  await healthy(origin);

  const response = await fetch(`${origin}/api/jiuwenswarm/skills-by-id/idea-tree-team`, {
    body: JSON.stringify({ enabled: false }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "PUT",
  });
  assert.equal(response.status, 404, "a failed bundled package is not an internal switch error");
  assert.deepEqual(await response.json(), { error: "Skill not found: idea-tree-team" });
});

