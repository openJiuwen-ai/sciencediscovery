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
 * The three waits a user actually feels, each with a budget in seconds.
 *
 * `store-performance.test.ts` guards the shape of the catalog write; this file
 * guards the product promise on top of it. A Session with hundreds of turns,
 * two hundred runs and a workspace of hundreds of files must switch in under a
 * second. The settings page assembles Skills, MCP sources, specialists,
 * connectors and settings from separate endpoints, and all of them together
 * must arrive in half a second. Deleting a Session or a whole Project answers
 * when the catalog commits — reclamation is queued, not awaited — and must do
 * so in under a second, or a second and a half for a Project whose Sessions
 * each carry their own history.
 *
 * The fixtures are deliberately heavy and the budgets deliberately loose: on
 * this host each flow measures in tens of milliseconds, so a budget of a second
 * is thirty times the observed cost. What it catches is an endpoint that starts
 * doing work proportional to the whole catalog, where the cost is seconds, not
 * milliseconds. Wall clocks differ between machines; the ratio guards in
 * `store-performance.test.ts` are what pin the marginal cost.
 */

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import type { TestContext } from "node:test";

import { offlineMcpTransport } from "./mcp/offline-transport.fixture.js";
import { createApiServer, type ServerConfig } from "./server.js";
import { SessionStore } from "./store.js";

/** Switching to a Session: the detail, its runs and its files, in parallel. */
const SWITCH_BUDGET_MS = 1_000;
/** The settings page's five lists, in parallel. */
const SETTINGS_BUDGET_MS = 500;
/** A deletion request, which answers once the catalog has committed. */
const DELETE_BUDGET_MS = 1_000;
/** A Project deletion, whose request also walks each Session's runs. */
const DELETE_PROJECT_BUDGET_MS = 1_500;

const MESSAGES = 800;
const RUNS = 200;
const FILES = 500;

const authorization = { authorization: "Bearer test-token" };

function testConfig(dataDir: string, runnerUrl: string): ServerConfig {
  return {
    authToken: "test-token",
    dataDir,
    gatewayIdleTimeoutMs: 120_000,
    gatewayTurnTimeoutMs: 300_000,
    host: "127.0.0.1",
    kernelIdleTimeoutMs: 300_000,
    // No packaging snapshot in tests: the catalog stays empty unless a test installs one.
    modelCatalogPath: resolve(dataDir, "model-catalog/absent.json"),
    paperPythonPath: resolve(process.cwd(), "../paper/.venv/bin/python"),
    paperWorkerPath: resolve(process.cwd(), "../paper/paper_worker.py"),
    permissionWaitTimeoutMs: 300_000,
    port: 0,
    runnerExecTimeoutMs: 300_000,
    runnerMaxOutputBytes: 1_000_000,
    runnerMaxWorkspaceBytes: 10_737_418_240,
    runnerToken: "runner-test-token",
    runnerUrl,
    sshConfigPath: resolve(dataDir, "ssh-config"),
    staticDir: resolve(dataDir, "missing-web-dist"),
    workspaceUpload: {
      maxFileBytes: 1_000_000,
      maxRequestBytes: 10_000_000,
      maxWorkspaceBytes: 10_737_418_240,
    },
    memoryGraph: { url: "http://127.0.0.1:17674", internalToken: "test" },
    evolve: { url: "http://127.0.0.1:4313", internalToken: "test" },
  };
}

/** A runner that answers health and every teardown: a deletion that has a
 *  reachable runner must not spend the request failing to reach one. */
function startStubDeps(context: TestContext): Promise<string> {
  const runner = createHttpServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(request.url === "/health"
      ? JSON.stringify({ status: "ok", scientificEnvs: { available: false, enabled: false } })
      : "{}");
  });
  context.after(() => new Promise<void>((done) => {
    runner.close(() => done());
    runner.closeAllConnections();
  }));
  return new Promise((ready) => runner.listen(0, "127.0.0.1", () => {
    ready(`http://127.0.0.1:${(runner.address() as AddressInfo).port}`);
  }));
}

interface Seeded {
  readonly origin: string;
  readonly root: string;
  readonly sessionIds: string[];
}

/** One Project whose first Session is the heavy one the tests switch to; a
 *  second, empty Session is the warm-up: the first request into a fresh API
 *  pays for lazy module loading, and that cost belongs to start-up, not to the
 *  switch being measured. */
async function seedFixture(
  context: TestContext,
  label: string,
  plan: { messages: number; runs: number; files: number; sessions: number },
): Promise<Seeded> {
  const root = resolve(process.cwd(), ".tmp", `performance-budget-${label}-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  const store = new SessionStore(root);
  await store.load();
  const model = await store.createModel({
    apiToken: "performance-token",
    baseUrl: "https://models.example.test/v1",
    model: "science-model",
    name: "Performance model",
  });
  const project = await store.createProject("Performance", { modelId: model.id, reviewModelId: model.id });

  const now = new Date();
  const sessionIds: string[] = [];
  for (let index = 0; index < plan.sessions; index += 1) {
    const session = await store.createSession(project.id, `Session ${index}`);
    sessionIds.push(session.id);
    await seedHistory(store, root, session.id, model, plan, now);
  }
  // The warm-up Session is outside the measured plan.
  const warm = await store.createSession(project.id, "Warm");
  store.close();

  const runnerUrl = await startStubDeps(context);
  const api = createApiServer(testConfig(root, runnerUrl), { mcpTransport: offlineMcpTransport });
  await new Promise<void>((ready) => api.listen(0, "127.0.0.1", ready));
  context.after(async () => {
    await new Promise<void>((done) => { api.close(() => done()); api.closeAllConnections(); });
    // A deletion answers before the reclamation it queued has finished, and the
    // reclamation writes into the data directory. Let it settle, then remove
    // with retries: the directory is still being emptied underneath the rm.
    await new Promise((done) => setTimeout(done, 500));
    await rm(root, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 });
  });
  const origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  await warmUp(origin, warm.id);
  return { origin, root, sessionIds };
}

/** Writes the history an existing Session carries: a messages file, finished
 *  runs, and a workspace whose files have provenance. Written through the
 *  store where there is a bulk API, and as the file the store reads where there
 *  is not — a fixture that appended eight hundred messages one at a time would
 *  spend more time in setup than the budget it is checking. */
async function seedHistory(
  store: SessionStore,
  root: string,
  sessionId: string,
  model: { id: string; name: string },
  plan: { messages: number; runs: number; files: number },
  now: Date,
): Promise<void> {
  if (plan.messages > 0) {
    const directory = resolve(root, "messages");
    await mkdir(directory, { recursive: true });
    const messages = Array.from({ length: plan.messages }, (_, index) => ({
      content: `message ${index} ${"x".repeat(400)}`,
      createdAt: new Date(now.getTime() - (plan.messages - index) * 1_000).toISOString(),
      id: `${sessionId}-message-${index}`,
      kind: "message",
      modelId: model.id,
      modelName: model.name,
      role: index % 2 === 0 ? "assistant" : "user",
    }));
    await writeFile(resolve(directory, `${sessionId}.json`), JSON.stringify(messages));
  }

  for (let index = 0; index < plan.runs; index += 1) {
    const run = await store.createSessionRun({
      prompt: `turn ${index}`,
      sessionId,
      settingsSnapshot: store.resolveRuntimeSettings(sessionId).effective,
    });
    await store.updateSessionRunStatus(sessionId, run.id, "completed", {
      finishedAt: now.toISOString(),
      startedAt: now.toISOString(),
    });
  }

  if (plan.files > 0) {
    const workspace = store.workspacePath(sessionId);
    await mkdir(resolve(workspace, "data"), { recursive: true });
    const inputs = [];
    for (let index = 0; index < plan.files; index += 1) {
      const path = `data/file-${index}.md`;
      const absolute = resolve(workspace, path);
      await writeFile(absolute, `# file ${index}\n`);
      const metadata = await stat(absolute);
      inputs.push({
        mode: "write" as const,
        modifiedAt: metadata.mtime.toISOString(),
        origin: "agent" as const,
        path,
        size: metadata.size,
      });
    }
    await store.recordWorkspaceFileRevisions(sessionId, inputs);
  }
}

/** The first request into a freshly started API pays for module loading and
 *  connection setup on this host (about 230 ms, whichever endpoint it is).
 *  A user switching Sessions has already paid it at start-up. */
async function warmUp(origin: string, sessionId: string): Promise<void> {
  await Promise.all([
    fetch(`${origin}/api/sessions/${sessionId}`, { headers: authorization }).then((response) => response.text()),
    fetch(`${origin}/api/sessions/${sessionId}/runs`, { headers: authorization }).then((response) => response.text()),
    fetch(`${origin}/api/sessions/${sessionId}/files`, { headers: authorization }).then((response) => response.text()),
  ]);
}

async function timed(action: () => Promise<void>): Promise<number> {
  const started = process.hrtime.bigint();
  await action();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

async function expectOk(response: Response): Promise<string> {
  const body = await response.text();
  assert.equal(response.status, 200, body);
  return body;
}

test("switching to a Session with a long history answers within a second", async (context) => {
  const { origin, sessionIds } = await seedFixture(context, "switch", {
    files: FILES,
    messages: MESSAGES,
    runs: RUNS,
    sessions: 1,
  });
  const sessionId = sessionIds[0]!;

  let detail = "";
  let runs = "";
  let files = "";
  const elapsed = await timed(async () => {
    // The desktop reads all three at once when the user picks a Session.
    [detail, runs, files] = await Promise.all([
      fetch(`${origin}/api/sessions/${sessionId}`, { headers: authorization }).then(expectOk),
      fetch(`${origin}/api/sessions/${sessionId}/runs`, { headers: authorization }).then(expectOk),
      fetch(`${origin}/api/sessions/${sessionId}/files`, { headers: authorization }).then(expectOk),
    ]);
  });

  // A fast empty answer is not a pass: the payloads carry the history.
  assert.equal((JSON.parse(detail) as { messages: unknown[] }).messages.length, MESSAGES);
  assert.equal((JSON.parse(runs) as unknown[]).length, RUNS);
  assert.equal((JSON.parse(files) as unknown[]).length, FILES);
  assert.ok(elapsed < SWITCH_BUDGET_MS, `switching to a Session took ${elapsed.toFixed(1)} ms`);
});

test("the Skills, MCP and specialists lists load within half a second", async (context) => {
  const { origin } = await seedFixture(context, "settings", {
    files: 0,
    messages: 0,
    runs: 0,
    sessions: 0,
  });

  let skills = "";
  let sources = "";
  let specialists = "";
  let connectors = "";
  const elapsed = await timed(async () => {
    // The settings page asks for these together.
    [skills, sources, specialists, connectors] = await Promise.all([
      fetch(`${origin}/api/skills`, { headers: authorization }).then(expectOk),
      fetch(`${origin}/api/mcp/sources`, { headers: authorization }).then(expectOk),
      fetch(`${origin}/api/specialists`, { headers: authorization }).then(expectOk),
      fetch(`${origin}/api/connectors`, { headers: authorization }).then(expectOk),
    ]);
    await expectOk(await fetch(`${origin}/api/settings`, { headers: authorization }));
  });

  assert.ok((JSON.parse(skills) as unknown[]).length > 0, "the bundled Skills are listed");
  assert.ok((JSON.parse(sources) as unknown[]).length > 0, "the MCP sources are listed");
  assert.ok(Array.isArray(JSON.parse(specialists)), "the specialists are listed");
  assert.ok((JSON.parse(connectors) as unknown[]).length > 0, "the connectors are listed");
  assert.ok(elapsed < SETTINGS_BUDGET_MS, `the settings lists took ${elapsed.toFixed(1)} ms`);
});

test("deleting a Session with a long history answers within a second", async (context) => {
  const { origin, sessionIds } = await seedFixture(context, "delete-session", {
    files: FILES,
    messages: MESSAGES,
    runs: RUNS,
    sessions: 1,
  });
  const sessionId = sessionIds[0]!;

  const elapsed = await timed(async () => {
    await expectOk(await fetch(`${origin}/api/sessions/${sessionId}`, {
      body: JSON.stringify({ confirmationId: sessionId }),
      headers: { ...authorization, "content-type": "application/json" },
      method: "DELETE",
    }));
  });
  assert.ok(elapsed < DELETE_BUDGET_MS, `deleting a Session took ${elapsed.toFixed(1)} ms`);

  // The answer means the catalog committed, not merely that the request parsed.
  assert.equal((await fetch(`${origin}/api/sessions/${sessionId}`, { headers: authorization })).status, 404);
});

test("deleting a Project with several heavy Sessions answers within a second and a half", async (context) => {
  const { origin } = await seedFixture(context, "delete-project", {
    files: 100,
    messages: 200,
    runs: 20,
    sessions: 6,
  });
  const projects = await fetch(`${origin}/api/projects`, { headers: authorization })
    .then((response) => expectOk(response))
    .then((body) => JSON.parse(body) as Array<{ id: string; name: string }>);
  const project = projects.find((candidate) => candidate.name === "Performance");
  assert.ok(project, "the seeded Project is listed");

  const elapsed = await timed(async () => {
    await expectOk(await fetch(`${origin}/api/projects/${project.id}`, {
      body: JSON.stringify({ confirmationId: project.id }),
      headers: { ...authorization, "content-type": "application/json" },
      method: "DELETE",
    }));
  });
  assert.ok(elapsed < DELETE_PROJECT_BUDGET_MS, `deleting a Project took ${elapsed.toFixed(1)} ms`);

  const remaining = await fetch(`${origin}/api/projects`, { headers: authorization })
    .then((response) => expectOk(response))
    .then((body) => JSON.parse(body) as Array<{ id: string }>);
  assert.ok(!remaining.some((candidate) => candidate.id === project.id), "the Project is gone");
});
