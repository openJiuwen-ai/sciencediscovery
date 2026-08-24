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
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { access, chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import { createRunnerServer, type RunnerConfig } from "@sciencediscovery/runner";
import type {
  ApiError,
  ArtifactDerivation,
  ArtifactVersionProvenance,
  ArtifactVersionDiff,
  CreateProjectResponse,
  DeletionImpact,
  Environment,
  EnvironmentInstallStatus,
  EnvironmentRevision,
  EnvironmentSourceSettings,
  ExecutionRun,
  ModelProfile,
  McpInvocation,
  McpToolResult,
  PaperAcquisition,
  PaperVisionRun,
  PermissionAuthorization,
  PermissionDecisionResult,
  PermissionEpoch,
  PermissionGrant,
  PermissionRequest,
  ProxySettingsDetails,
  RunStreamEvent,
  PromptManifest,
  Project,
  RuntimeSettingsDetails,
  RuntimeStatus,
  Session,
  SessionDetail,
  SessionRun,
  SessionRunEvent,
  SessionUsageSummary,
  RunnerHealth,
  ScientificEnvironmentSetup,
  ScientificArtifact,
  ScientificArtifactVersion,
  SkillDeletionImpact,
  SkillDescriptor,
  SkillDetail,
  Specialist,
  Subagent,
  SubagentStep,
  SystemTimeoutSettings,
  WorkbenchSearchResult,
  WorkspaceFile,
  WorkspaceUploadResult,
} from "@sciencediscovery/schema";
import { createLocalSessionTitle, UNTITLED_SESSION_TITLE } from "@sciencediscovery/schema";
import {
  DEFAULT_MAX_CONCURRENT_SUBAGENTS,
} from "@sciencediscovery/context";
import {
  DEFAULT_SUBAGENT_MAX_TURNS,
  DEFAULT_SUBAGENT_TIMEOUT_SECONDS,
} from "@sciencediscovery/orchestration";
import { strToU8, zipSync } from "fflate";

import {
  aggregateToolText,
  createApiServer,
  createDeltaCoalescingSink,
  loadServerConfig,
  prepareSubagentHandoff,
  publishRunEvent,
  recoverSessionRuns,
  waitForPermissionDecision,
  type ServerConfig,
} from "./server.js";
import { SessionStore } from "./store.js";
import type { McpCatalog, McpInvokeResponse } from "@sciencediscovery/schema";
import type { McpTransportClient } from "@sciencediscovery/data-source";

const authorization = { authorization: "Bearer test-token" };
const execFileAsync = promisify(execFile);

interface TestSseEvent {
  subagent?: { id: string };
  subagentId?: string;
  type: string;
  [key: string]: unknown;
}

function parseSseEvents(stream: string): TestSseEvent[] {
  return stream.split("\n\n").flatMap((frame) => {
    const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    return data ? [JSON.parse(data) as TestSseEvent] : [];
  });
}

function rootSseGolden(stream: string): string[] {
  return parseSseEvents(stream)
    .filter((event) => !event.type.startsWith("subagent.") && event.type !== "run.queued" && event.type !== "run.status")
    .map((event) => event.type);
}

function subagentSseGoldens(stream: string): string[][] {
  const lanes = new Map<string, string[]>();
  for (const event of parseSseEvents(stream)) {
    if (!event.type.startsWith("subagent.")) continue;
    const id = event.subagentId ?? event.subagent?.id;
    assert.ok(id, `subagent SSE event ${event.type} must carry an id`);
    const lane = lanes.get(id) ?? [];
    lane.push(event.type);
    lanes.set(id, lane);
  }
  return [...lanes.values()].sort((left, right) => left.join(",").localeCompare(right.join(",")));
}

function testConfig(dataDir: string, runnerUrl = "http://127.0.0.1:1"): ServerConfig {
  return {
    authToken: "test-token",
    dataDir,
    gatewayIdleTimeoutMs: 240_000,
    gatewayTurnTimeoutMs: 0,
    host: "127.0.0.1",
    kernelIdleTimeoutMs: 0,
    paperPythonPath: resolve(process.cwd(), "../paper/.venv/bin/python"),
    paperWorkerPath: resolve(process.cwd(), "../paper/paper_worker.py"),
    port: 0,
    permissionWaitTimeoutMs: 0,
    runnerExecTimeoutMs: 0,
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
  };
}

/**
 * bubblewrap option arities, so the stand-in can find where the sandbox
 * arguments end and the command begins. An unknown option aborts rather than
 * guessing: a silently misparsed launch would run the wrong argv.
 */
const BWRAP_ARITY: Record<string, number> = {
  "--args": 1, "--argv0": 1, "--as-pid-1": 0, "--bind": 2, "--bind-data": 2,
  "--bind-try": 2, "--block-fd": 1, "--cap-add": 1, "--cap-drop": 1, "--chdir": 1,
  "--chmod": 2, "--clearenv": 0, "--dev": 1, "--dev-bind": 2, "--dev-bind-try": 2,
  "--die-with-parent": 0, "--dir": 1, "--disable-userns": 0, "--file": 2,
  "--gid": 1, "--hostname": 1, "--info-fd": 1, "--json-status-fd": 1,
  "--lock-file": 1, "--mqueue": 1, "--new-session": 0, "--perms": 1, "--pidns": 1,
  "--proc": 1, "--remount-ro": 1, "--ro-bind": 2, "--ro-bind-data": 2,
  "--ro-bind-try": 2, "--seccomp": 1, "--setenv": 2, "--share-net": 0, "--size": 1,
  "--symlink": 2, "--sync-fd": 1, "--tmpfs": 1, "--uid": 1, "--unsetenv": 1,
  "--unshare-all": 0, "--unshare-cgroup": 0, "--unshare-cgroup-try": 0,
  "--unshare-ipc": 0, "--unshare-net": 0, "--unshare-pid": 0, "--unshare-user": 0,
  "--unshare-user-try": 0, "--unshare-uts": 0, "--userns": 1, "--userns2": 1,
};

/**
 * A bubblewrap stand-in that runs the command for real but without namespaces.
 *
 * These tests assert on what an execution produces — stdout, exit codes,
 * timeout notices, subagent step contents — not on whether it was isolated.
 * Isolation is covered by services/runner's own suite and by the mocked E2E
 * journeys, both of which need a working sandbox. Using this stand-in here
 * makes the API suite deterministic on any host, including CI runners whose
 * container drops CAP_SYS_ADMIN and so cannot create a namespace at all.
 *
 * It translates the sandbox's view back to the host: bind destinations map to
 * their sources, so `--chdir /workspace` lands in the real workspace directory
 * and arguments naming sandbox paths resolve to the files they were bound from.
 */
async function writePassthroughBwrap(root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  const implementation = resolve(root, "bwrap-passthrough.mjs");
  await writeFile(implementation, `${[
    'import { spawn } from "node:child_process";',
    `const ARITY = ${JSON.stringify(BWRAP_ARITY)};`,
    'const argv = process.argv.slice(2);',
    'if (argv[0] === "--help") { console.log("usage: bwrap --cap-drop --die-with-parent --new-session --seccomp --unshare-all --unshare-user --disable-userns"); process.exit(0); }',
    'if (argv[0] === "--version") { console.log("bubblewrap 0.9.0"); process.exit(0); }',
    'const binds = []; const env = { ...process.env }; let cleared = false; let chdir; let index = 0;',
    'for (; index < argv.length; index += 1) {',
    '  const option = argv[index];',
    '  if (!option.startsWith("--")) break;',
    '  const arity = ARITY[option];',
    '  if (arity === undefined) { console.error(`bwrap-passthrough: unknown option ${option}`); process.exit(2); }',
    '  const values = argv.slice(index + 1, index + 1 + arity);',
    '  if (option === "--bind" || option === "--ro-bind" || option === "--dev-bind"',
    '   || option === "--bind-try" || option === "--ro-bind-try" || option === "--dev-bind-try") binds.push([values[1], values[0]]);',
    '  else if (option === "--chdir") chdir = values[0];',
    '  else if (option === "--clearenv") cleared = true;',
    '  else if (option === "--setenv") env[values[0]] = values[1];',
    '  else if (option === "--unsetenv") delete env[values[0]];',
    '  index += arity;',
    '}',
    '// Longest destination first so /workspace/sub wins over /workspace.',
    'binds.sort((a, b) => b[0].length - a[0].length);',
    'const toHost = (value) => {',
    '  for (const [destination, source] of binds) {',
    '    if (value === destination) return source;',
    '    if (value.startsWith(`${destination}/`)) return source + value.slice(destination.length);',
    '  }',
    '  return value;',
    '};',
    'const command = argv.slice(index).map(toHost);',
    'if (command.length === 0) { console.error("bwrap-passthrough: no command"); process.exit(2); }',
    '// --clearenv wipes PATH too; without it the shim could not resolve an',
    '// interpreter that the real sandbox reaches through its own /usr mount.',
    'const childEnv = cleared ? { ...Object.fromEntries(Object.entries(env).filter(([key]) => key === "PATH")), ...env } : env;',
    'if (!childEnv.PATH) childEnv.PATH = process.env.PATH ?? "/usr/bin:/bin";',
    'const child = spawn(command[0], command.slice(1), {',
    '  cwd: chdir ? toHost(chdir) : undefined, env: childEnv, stdio: "inherit",',
    '});',
    'child.on("error", (error) => { console.error(`bwrap-passthrough: ${error.message}`); process.exit(127); });',
    'child.on("exit", (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 0); });',
  ].join("\n")}\n`);
  const launcher = resolve(root, "bwrap");
  await writeFile(launcher, `#!/bin/sh\nexec node ${JSON.stringify(implementation)} "$@"\n`);
  await chmod(launcher, 0o755);
  return launcher;
}

async function startTestApi(
  context: TestContext,
  dataDir: string,
  mcpTransport?: McpTransportClient,
): Promise<{ origin: string }> {
  const runnerConfig: RunnerConfig = {
    authToken: "runner-test-token",
    bwrapPath: await writePassthroughBwrap(resolve(dataDir, "sandbox-stub")),
    dataDir,
    execTimeoutMs: 60_000,
    host: "127.0.0.1",
    maxOutputBytes: 1_000_000,
    maxWorkspaceBytes: 10_737_418_240,
    npuBrokerEnabled: true,
    port: 0,
  };
  const runner = createRunnerServer(runnerConfig);
  await new Promise<void>((resolveListen) => runner.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => {
    runner.close(() => resolveClose());
    runner.closeAllConnections();
  }));
  const runnerOrigin = `http://127.0.0.1:${(runner.address() as AddressInfo).port}`;

  const server = createApiServer(
    testConfig(dataDir, runnerOrigin),
    mcpTransport ? { mcpTransport } : {},
  );
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => {
    server.close(() => resolveClose());
    server.closeAllConnections();
  }));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function startScientificTestApi(
  context: TestContext,
  dataDir: string,
  onInstall?: (body: Record<string, unknown>) => void,
): Promise<{ origin: string }> {
  const snapshot = Buffer.from("{\"format\":\"scientific-test\"}\n");
  const snapshotHash = createHash("sha256").update(snapshot).digest("hex");
  const revisions: EnvironmentRevision[] = [];
  const environments: Environment[] = [];
  const addRevision = (environmentId: string, language: "python" | "r"): EnvironmentRevision => {
    const revision: EnvironmentRevision = {
      channels: ["conda-forge"], createdAt: new Date().toISOString(), environmentId, id: `rev-${randomUUID()}`,
      language, languageVersion: "test", packages: [], packageSpecHash: snapshotHash, platform: "linux-x64",
      provisioner: "test", runnerVersion: "test", snapshot: { hash: snapshotHash, size: snapshot.length },
    };
    revisions.push(revision);
    return revision;
  };
  for (const language of ["python", "r"] as const) {
    const id = `starter-${language}`;
    const revision = addRevision(id, language);
    environments.push({
      createdAt: new Date().toISOString(), currentRevisionId: revision.id, id, kind: "starter", language,
      name: `Starter ${language}`, updatedAt: new Date().toISOString(),
    });
  }
  const runner = createHttpServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://runner.test");
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(`${JSON.stringify(body)}\n`);
    };
    if (url.pathname === "/health") {
      send(200, {
        cgroupDelegated: false, cgroupMode: "none", cgroupRoot: "",
        executionAuth: "bearer+hmac-sha256", executionUser: "test", executionTimeoutMs: 60_000,
        maxFileBytes: 0, maxOutputBytes: 1_000_000, maxWorkspaceBytes: 1024, networkPolicy: "none", noNewPrivileges: true,
        runnerVersion: "test", sandbox: "bubblewrap",
        scientificEnvs: { available: true, enabled: true, languages: ["python", "r"], provisioner: "test", startersReady: true },
        seccompBaseline: "multiarch-v1-profile-aware", status: "ok", workerConcurrency: null,
      });
      return;
    }
    if (url.pathname === "/environment-setup") {
      const setup: ScientificEnvironmentSetup = {
        allowedChannels: ["conda-forge"],
        completedAt: new Date().toISOString(),
        error: null,
        managedProvisioner: true,
        message: "Python base environment is ready",
        networkPolicy: "allowed-channels",
        phase: "complete",
        provisioner: "micromamba",
        provisionerVersion: "test",
        startedAt: new Date().toISOString(),
        starterPackages: { python: ["python=3.12"], r: ["r-base=4.4"] },
        state: "ready",
        updatedAt: new Date().toISOString(),
      };
      return send(200, setup);
    }
    if (url.pathname === "/environments" && request.method === "GET") return send(200, environments);
    if (url.pathname === "/environment-revisions" && request.method === "GET") return send(200, revisions);
    if (/^\/environment-revisions\/[^/]+\/snapshot$/.test(url.pathname)) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(snapshot);
      return;
    }
    if (url.pathname === "/environments" && request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { language: "python" | "r"; name: string };
      const id = `task-${randomUUID()}`;
      const revision = addRevision(id, input.language);
      const environment: Environment = {
        createdAt: new Date().toISOString(), currentRevisionId: revision.id, id, kind: "task", language: input.language,
        name: input.name, updatedAt: new Date().toISOString(),
      };
      environments.push(environment);
      return send(201, environment);
    }
    const install = url.pathname.match(/^\/environments\/([^/]+)\/install$/);
    if (install && request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      onInstall?.(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      const environment = environments.find((candidate) => candidate.id === install[1]);
      if (!environment) return send(404, { error: "not found" });
      const revision = addRevision(environment.id, environment.language);
      environment.currentRevisionId = revision.id;
      return send(201, revision);
    }
    const uninstall = url.pathname.match(/^\/environments\/([^/]+)\/uninstall$/);
    if (uninstall && request.method === "POST") {
      const environment = environments.find((candidate) => candidate.id === uninstall[1]);
      if (!environment) return send(404, { error: "not found" });
      const revision = addRevision(environment.id, environment.language);
      environment.currentRevisionId = revision.id;
      return send(201, revision);
    }
    const deletion = url.pathname.match(/^\/environments\/([^/]+)$/);
    if (deletion && request.method === "DELETE") {
      const index = environments.findIndex((candidate) => candidate.id === deletion[1]);
      if (index >= 0) environments.splice(index, 1);
      return send(200, { deleted: deletion[1] });
    }
    send(404, { error: "not found" });
  });
  await new Promise<void>((resolveListen) => runner.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => runner.close(() => resolveClose())));
  const runnerOrigin = `http://127.0.0.1:${(runner.address() as AddressInfo).port}`;
  const server = createApiServer(testConfig(dataDir, runnerOrigin));
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<{ body: T; response: Response }> {
  const response = await fetch(url, init);
  return { body: (await response.json()) as T, response };
}

async function createTestModel(
  origin: string,
  input: { apiToken?: string; baseUrl?: string; model?: string; name?: string; vision?: boolean } = {},
): Promise<ModelProfile> {
  const result = await jsonRequest<ModelProfile>(`${origin}/api/models`, {
    body: JSON.stringify({
      apiToken: input.apiToken ?? "test-model-token",
      baseUrl: input.baseUrl ?? "https://models.example.test/v1",
      model: input.model ?? "test-model",
      name: input.name ?? "Test model",
      vision: input.vision ?? false,
    }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(result.response.status, 201);
  return result.body;
}

test("authenticated proxy REST returns complete settings URLs and manages MCP policies", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `proxy-api-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const { origin } = await startTestApi(context, tempRoot);

  assert.equal((await fetch(`${origin}/api/proxy/settings`)).status, 401);
  const created = await jsonRequest<ProxySettingsDetails["servers"][number]>(`${origin}/api/proxy/servers`, {
    body: JSON.stringify({
      kind: "custom_url",
      name: "Corporate proxy",
      url: "http://research%40team:p%40ss%3Aword@proxy.example.test:8080",
    }),
    headers: authorization,
    method: "POST",
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.hasUrl, true);
  assert.equal(created.body.url, "http://research%40team:p%40ss%3Aword@proxy.example.test:8080/");

  const configured = await jsonRequest<ProxySettingsDetails>(`${origin}/api/proxy/settings`, {
    body: JSON.stringify({ defaultPolicy: `proxy:${created.body.id}` }),
    headers: authorization,
    method: "PUT",
  });
  assert.equal(configured.response.status, 200);
  assert.equal(configured.body.defaultPolicy, `proxy:${created.body.id}`);
  assert.equal(
    configured.body.servers.find((server) => server.id === created.body.id)?.url,
    created.body.url,
  );
  const environment = configured.body.servers.find((server) => server.kind === "environment")?.environment;
  assert.ok(environment);
  assert.deepEqual(environment.variables.map((variable) => variable.names), [
    ["http_proxy", "HTTP_PROXY"],
    ["https_proxy", "HTTPS_PROXY"],
    ["all_proxy", "ALL_PROXY"],
    ["no_proxy", "NO_PROXY"],
  ]);

  const updated = await jsonRequest<ProxySettingsDetails["servers"][number]>(
    `${origin}/api/proxy/servers/${created.body.id}`,
    {
      body: JSON.stringify({ url: "socks5://updated-user:updated-pass@proxy.example.test:1080" }),
      headers: authorization,
      method: "PUT",
    },
  );
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.url, "socks5://updated-user:updated-pass@proxy.example.test:1080");
  assert.equal(
    (await jsonRequest<ProxySettingsDetails>(`${origin}/api/proxy/settings`, { headers: authorization })).body
      .servers.find((server) => server.id === created.body.id)?.url,
    updated.body.url,
  );

  const invalidCredential = "http://error-user:error-password@proxy.example.test:8080/#fragment";
  const invalid = await jsonRequest<{ error: string }>(`${origin}/api/proxy/servers`, {
    body: JSON.stringify({ kind: "custom_url", name: "Invalid", url: invalidCredential }),
    headers: authorization,
    method: "POST",
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.error, "The proxy URL cannot contain a fragment");
  assert.doesNotMatch(JSON.stringify(invalid.body), /error-user|error-password/);
  assert.doesNotMatch(await readFile(resolve(tempRoot, "logs", "api.log"), "utf8"), /error-user|error-password/);

  const mcp = await jsonRequest<{ policies: Record<string, string> }>(`${origin}/api/mcp/proxy-policies`, {
    body: JSON.stringify({ policies: { biomed: `proxy:${created.body.id}`, uniprot: "none" } }),
    headers: authorization,
    method: "PUT",
  });
  assert.deepEqual(mcp.body.policies, { biomed: `proxy:${created.body.id}`, uniprot: "none" });
  assert.deepEqual(
    (await jsonRequest<{ policies: Record<string, string> }>(`${origin}/api/mcp/proxy-policies`, { headers: authorization })).body,
    mcp.body,
  );

  const referencedDelete = await fetch(`${origin}/api/proxy/servers/${created.body.id}`, {
    headers: authorization,
    method: "DELETE",
  });
  assert.equal(referencedDelete.status, 409);
  assert.match((await referencedDelete.json() as { error: string }).error, /referenced/);
});

async function startToolModel(context: TestContext): Promise<{
  authorizations: string[];
  baseUrl: string;
}> {
  const authorizations: string[] = [];
  const analysisCode = [
    "from pathlib import Path",
    "raw = Path('input.csv').read_text(encoding='utf-8')",
    "Path('a').mkdir()",
    "Path('b').mkdir()",
    "Path('analysis_summary.csv').write_text('metric,value\\nrows,3\\n', encoding='utf-8')",
    "Path('analysis_chart.svg').write_text('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"240\" height=\"80\"><rect width=\"240\" height=\"80\" fill=\"#123\"/><text x=\"20\" y=\"45\" fill=\"white\">3 rows analyzed</text></svg>', encoding='utf-8')",
    "Path('a/out.csv').write_text('group,value\\na,1\\n', encoding='utf-8')",
    "Path('b/out.csv').write_text('group,value\\nb,2\\n', encoding='utf-8')",
    "print('created analysis outputs')",
  ].join("\n");
  const modelServer = createHttpServer(async (request, response) => {
    authorizations.push(request.headers.authorization ?? "");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages?: Array<{ role?: string }> };
    const toolResultCount = body.messages?.filter((message) => message.role === "tool").length ?? 0;
    const completionId = toolResultCount >= 2 ? "chatcmpl-result" : `chatcmpl-tool-${toolResultCount}`;
    const responseChunks = toolResultCount >= 2
      ? [{
          choices: [{ delta: { reasoning_content: "The calculation completed, so I can report the generated artifacts." }, finish_reason: null, index: 0 }],
          created: 1,
          id: completionId,
          model: "test-tool-model",
          object: "chat.completion.chunk",
        }, {
          choices: [{ delta: { content: "Created analysis_summary.csv and analysis_chart.svg with Python." }, finish_reason: null, index: 0 }],
          created: 1,
          id: completionId,
          model: "test-tool-model",
          object: "chat.completion.chunk",
        }]
      : toolResultCount === 1 ? [{
          choices: [{
            delta: {
              reasoning_content: "I should declare both useful outputs in the Project catalog.",
              role: "assistant",
              tool_calls: [{
                function: {
                  arguments: JSON.stringify({ paths: ["analysis_summary.csv", "analysis_chart.svg", "a/out.csv", "b/out.csv"] }),
                  name: "declare_artifact",
                },
                id: "call-declare-outputs",
                index: 0,
                type: "function",
              }],
            },
            finish_reason: null,
            index: 0,
          }],
          created: 1,
          id: completionId,
          model: "test-tool-model",
          object: "chat.completion.chunk",
        }]
      : [{
          choices: [{
            delta: {
              reasoning_content: "I should use the isolated Python tool to analyze the uploaded CSV.",
              role: "assistant",
              tool_calls: [{
                function: { arguments: JSON.stringify({ code: analysisCode }), name: "run_python" },
                id: "call-run-python",
                index: 0,
                type: "function",
              }],
            },
            finish_reason: null,
            index: 0,
          }],
          created: 1,
          id: completionId,
          model: "test-tool-model",
          object: "chat.completion.chunk",
        }];
    const finish = {
      choices: [{ delta: {}, finish_reason: toolResultCount >= 2 ? "stop" : "tool_calls", index: 0 }],
      created: 1,
      id: completionId,
      model: "test-tool-model",
      object: "chat.completion.chunk",
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const responseChunk of responseChunks) response.write(`data: ${JSON.stringify(responseChunk)}\n\n`);
    response.write(`data: ${JSON.stringify(finish)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolveListen) => modelServer.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => {
    modelServer.close(() => resolveClose());
    modelServer.closeAllConnections();
  }));
  return {
    authorizations,
    baseUrl: `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1`,
  };
}

const CONCURRENCY_BARRIER_TIMEOUT_MS = 10_000;

async function startSubagentModel(
  context: TestContext,
  options: {
    concurrentSubagentTarget?: number;
    pauseSubagent?: boolean;
    requireConcurrentSubagents?: boolean;
    structuredSubagentOutput?: string;
    structuredSubagentResult?: boolean;
    subagentPythonCode?: string;
    subagentUsesPython?: boolean;
    subagentType?: string;
    taskCount?: number;
  } = {},
): Promise<{
  baseUrl: string;
  getMaxConcurrentSubagents: () => number;
  releaseSubagent: () => void;
  requests: Array<{
    messages?: Array<{ content?: string; role?: string }>;
    tools?: Array<{ function?: { name?: string } }>;
  }>;
  setSpecialistId: (id: string) => void;
  subagentStarted: Promise<void>;
}> {
  let specialistId: string | undefined;
  const taskCount = options.taskCount ?? 1;
  // How many subagent requests the barrier waits for before letting any of
  // them answer. It is not always `taskCount`: the concurrency-limit test
  // issues one task call more than the API admits, so the surplus call never
  // reaches this model and the barrier would fall through to its timeout.
  const concurrentSubagentTarget = options.concurrentSubagentTarget ?? taskCount;
  let activeSubagentRequests = 0;
  let maxConcurrentSubagents = 0;
  let startedSubagentRequests = 0;
  let releaseConcurrencyBarrier: () => void = () => undefined;
  const concurrencyBarrier = new Promise<void>((resolveBarrier) => {
    releaseConcurrencyBarrier = resolveBarrier;
  });
  let releaseSubagent: () => void = () => undefined;
  const subagentGate = options.pauseSubagent
    ? new Promise<void>((resolveSubagent) => { releaseSubagent = resolveSubagent; })
    : Promise.resolve();
  let signalSubagentStarted: () => void = () => undefined;
  const subagentStarted = new Promise<void>((resolveStarted) => {
    signalSubagentStarted = resolveStarted;
  });
  let subagentCompletion = 0;
  const requests: Array<{
    messages?: Array<{ content?: string; role?: string }>;
    tools?: Array<{ function?: { name?: string } }>;
  }> = [];
  const modelServer = createHttpServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as (typeof requests)[number];
    requests.push(body);
    const systemPrompt = body.messages?.find((message) => message.role === "system")?.content ?? "";
    const isSubagent = systemPrompt.includes("Applied subagent preset general-purpose");
    const hasToolResult = body.messages?.some((message) => message.role === "tool") ?? false;
    const completionId = isSubagent
      ? `chatcmpl-subagent-${++subagentCompletion}`
      : hasToolResult ? "chatcmpl-parent-result" : "chatcmpl-parent-task";
    const responseChunks = isSubagent && options.subagentUsesPython && !hasToolResult
      ? [{
          choices: [{
            delta: {
              role: "assistant",
              tool_calls: [{
                function: {
                  arguments: JSON.stringify({ code: options.subagentPythonCode ?? "print('subagent permission check')" }),
                  name: "run_python",
                },
                id: "call-subagent-python",
                index: 0,
                type: "function",
              }],
            },
            finish_reason: null,
            index: 0,
          }],
          created: 1,
          id: completionId,
          model: "subagent-test-model",
          object: "chat.completion.chunk",
        }]
      : isSubagent && options.structuredSubagentResult
        ? [{
          choices: [{ delta: { content: options.structuredSubagentOutput ?? "{\"summary\":\"Structured inspection\",\"confidence\":\"high\"}", role: "assistant" }, finish_reason: null, index: 0 }],
          created: 1,
          id: completionId,
          model: "subagent-test-model",
          object: "chat.completion.chunk",
        }]
      : isSubagent
        ? [{
          choices: [{ delta: { content: "Subagent inspected the workspace ", role: "assistant" }, finish_reason: null, index: 0 }],
          created: 1,
          id: completionId,
          model: "subagent-test-model",
          object: "chat.completion.chunk",
        }, {
          choices: [{ delta: { content: "and returned a concise result." }, finish_reason: null, index: 0 }],
          created: 1,
          id: completionId,
          model: "subagent-test-model",
          object: "chat.completion.chunk",
        }]
        : hasToolResult
        ? [{
            choices: [{ delta: { content: "The subagent completed the delegated analysis.", role: "assistant" }, finish_reason: null, index: 0 }],
            created: 1,
            id: completionId,
            model: "subagent-test-model",
            object: "chat.completion.chunk",
          }]
        : [{
            choices: [{
              delta: {
                role: "assistant",
                tool_calls: Array.from({ length: taskCount }, (_, index) => ({
                  function: {
                    arguments: JSON.stringify({
                      ...(options.structuredSubagentResult ? {
                        brief: {
                          collaborationRules: ["Work independently", "Return one final JSON object"],
                          constraints: ["Use only visible workspace files"],
                          goal: "Inspect workspace and return structured evidence",
                          outputJsonSchema: {
                            additionalProperties: false,
                            properties: {
                              confidence: { enum: ["high", "medium", "low"], type: "string" },
                              summary: { type: "string" },
                            },
                            required: ["summary", "confidence"],
                            type: "object",
                          },
                          outputRequirements: ["Return summary and confidence"],
                          version: 1,
                        },
                      } : {}),
                      description: taskCount === 1 ? "Inspect workspace" : `Inspect workspace ${index + 1}`,
                      prompt: `Inspect workspace partition ${index + 1} and summarize what is available.`,
                      ...(specialistId ? { specialistId } : {}),
                      subagent_type: options.subagentType ?? "general-purpose",
                    }),
                    name: "task",
                  },
                  id: `call-task-${index + 1}`,
                  index,
                  type: "function",
                })),
              },
              finish_reason: null,
              index: 0,
            }],
            created: 1,
            id: completionId,
            model: "subagent-test-model",
            object: "chat.completion.chunk",
          }];
    const finish = {
      choices: [{
        delta: {},
        finish_reason: (isSubagent && options.subagentUsesPython && !hasToolResult)
          ? "tool_calls"
          : isSubagent || hasToolResult ? "stop" : "tool_calls",
        index: 0,
      }],
      created: 1,
      id: completionId,
      model: "subagent-test-model",
      object: "chat.completion.chunk",
      usage: { completion_tokens: 5, prompt_tokens: 20, total_tokens: 25 },
    };
    if (isSubagent) {
      activeSubagentRequests += 1;
      maxConcurrentSubagents = Math.max(maxConcurrentSubagents, activeSubagentRequests);
      if (options.requireConcurrentSubagents) {
        startedSubagentRequests += 1;
        if (startedSubagentRequests >= concurrentSubagentTarget) releaseConcurrencyBarrier();
        // Deadlock guard only: with the target reached the barrier is already
        // open, so this timer fires just when fewer subagents ran than the
        // test demands. It must outlast the API's own start-up latency for the
        // whole fan-out, or a slow machine silently caps the observed peak.
        const fallback = setTimeout(releaseConcurrencyBarrier, CONCURRENCY_BARRIER_TIMEOUT_MS);
        await concurrencyBarrier;
        clearTimeout(fallback);
      }
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify(responseChunks[0])}\n\n`);
    if (isSubagent) {
      signalSubagentStarted();
      await subagentGate;
    }
    for (const responseChunk of responseChunks.slice(1)) {
      response.write(`data: ${JSON.stringify(responseChunk)}\n\n`);
    }
    response.write(`data: ${JSON.stringify(finish)}\n\n`);
    response.end("data: [DONE]\n\n");
    if (isSubagent) activeSubagentRequests -= 1;
  });
  await new Promise<void>((resolveListen) => modelServer.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => modelServer.close(() => resolveClose())));
  return {
    baseUrl: `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1`,
    getMaxConcurrentSubagents: () => maxConcurrentSubagents,
    releaseSubagent,
    requests,
    setSpecialistId: (id) => {
      specialistId = id;
    },
    subagentStarted,
  };
}

async function startTextModel(context: TestContext, delayed = false): Promise<{
  baseUrl: string;
  release: () => void;
}> {
  let release: () => void = () => undefined;
  const gate = delayed ? new Promise<void>((resolveGate) => { release = resolveGate; }) : Promise.resolve();
  const modelServer = createHttpServer(async (request, response) => {
    for await (const _chunk of request) {
      // Consume the OpenAI-compatible request before streaming the fixture response.
    }
    await gate;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({
      choices: [{ delta: { content: "Snapshot response" }, finish_reason: null, index: 0 }],
      created: 1,
      id: "chatcmpl-snapshot",
      model: "snapshot-model",
      object: "chat.completion.chunk",
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
      created: 1,
      id: "chatcmpl-snapshot",
      model: "snapshot-model",
      object: "chat.completion.chunk",
    })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolveListen) => modelServer.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => modelServer.close(() => resolveClose())));
  return {
    baseUrl: `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1`,
    release,
  };
}

async function startAutoNamingModel(
  context: TestContext,
  delayNaming = false,
  delayTask = false,
  namingTitle = "Refined TP53 expression study",
): Promise<{
  baseUrl: string;
  namingRequests: Array<{ messages?: Array<{ content?: string; role?: string }> }>;
  namingStarted: Promise<void>;
  releaseNaming: () => void;
  releaseTask: () => void;
}> {
  const namingRequests: Array<{ messages?: Array<{ content?: string; role?: string }> }> = [];
  let releaseNaming: () => void = () => undefined;
  const namingGate = delayNaming
    ? new Promise<void>((resolveNaming) => { releaseNaming = resolveNaming; })
    : Promise.resolve();
  let releaseTask: () => void = () => undefined;
  const taskGate = delayTask
    ? new Promise<void>((resolveTask) => { releaseTask = resolveTask; })
    : Promise.resolve();
  let signalNamingStarted: () => void = () => undefined;
  const namingStarted = new Promise<void>((resolveStarted) => { signalNamingStarted = resolveStarted; });
  const modelServer = createHttpServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      messages?: Array<{ content?: string; role?: string }>;
    };
    const namingRequest = body.messages?.[0]?.content?.includes("Create a concise title for the research session");
    if (namingRequest) {
      namingRequests.push(body);
      signalNamingStarted();
      await namingGate;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { content: namingTitle } }],
        usage: { completion_tokens: 5, prompt_tokens: 16, total_tokens: 21 },
      }));
      return;
    }
    await taskGate;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({
      choices: [{ delta: { content: "The requested analysis is complete." }, finish_reason: null, index: 0 }],
      created: 1,
      id: "chatcmpl-auto-name-task",
      model: "auto-name-model",
      object: "chat.completion.chunk",
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
      created: 1,
      id: "chatcmpl-auto-name-task",
      model: "auto-name-model",
      object: "chat.completion.chunk",
      usage: { completion_tokens: 6, prompt_tokens: 20, total_tokens: 26 },
    })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolveListen) => modelServer.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => {
    releaseNaming();
    releaseTask();
    modelServer.close(() => resolveClose());
    modelServer.closeAllConnections();
  }));
  return {
    baseUrl: `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1`,
    namingRequests,
    namingStarted,
    releaseNaming,
    releaseTask,
  };
}

async function waitForRunStatus(
  origin: string,
  sessionId: string,
  runId: string,
  status: SessionRun["status"],
): Promise<SessionRun> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const runs = await jsonRequest<SessionRun[]>(`${origin}/api/sessions/${sessionId}/runs`, { headers: authorization });
    const run = runs.body.find((candidate) => candidate.id === runId);
    if (run?.status === status) return run;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Timed out waiting for run ${runId} to become ${status}`);
}

async function listRunEvents(origin: string, sessionId: string, runId: string): Promise<SessionRunEvent[]> {
  const events = await jsonRequest<SessionRunEvent[]>(
    `${origin}/api/sessions/${sessionId}/runs/${runId}/events`,
    { headers: authorization },
  );
  assert.equal(events.response.status, 200);
  return events.body;
}

async function startLiteratureModel(context: TestContext): Promise<{
  baseUrl: string;
  requests: Array<{ messages?: Array<{ content?: string; name?: string; role?: string }> }>;
}> {
  const requests: Array<{ messages?: Array<{ content?: string; name?: string; role?: string }> }> = [];
  const modelServer = createHttpServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as (typeof requests)[number];
    requests.push(body);
    const toolResultCount = body.messages?.filter((message) => message.role === "tool").length ?? 0;
    const completionId = toolResultCount >= 2 ? "chatcmpl-literature-result" : "chatcmpl-literature-tool";
    const responseChunks = toolResultCount >= 2
      ? [{
          choices: [{
            delta: {
              content: [
                "## TP53 literature summary",
                "",
                "The retrieved abstract reports p53-dependent apoptosis after iASPP inhibition in the tested systems [PMID:12524540](https://pubmed.ncbi.nlm.nih.gov/12524540/).",
                "",
                "Evidence boundary: abstract only; no article full text was retrieved in this search.",
              ].join("\n"),
            },
            finish_reason: null,
            index: 0,
          }],
          created: 1,
          id: completionId,
          model: "literature-test-model",
          object: "chat.completion.chunk",
        }]
      : [{
          choices: [{
            delta: {
              role: "assistant",
              tool_calls: [{
                function: {
                  arguments: JSON.stringify(toolResultCount === 0
                    ? { query: "select:mcp__pubmed__search" }
                    : { limit: 5, query: "TP53 apoptosis" }),
                  name: toolResultCount === 0 ? "tool_search" : "mcp__pubmed__search",
                },
                id: toolResultCount === 0 ? "call-tool-search" : "call-pubmed",
                index: 0,
                type: "function",
              }],
            },
            finish_reason: null,
            index: 0,
          }],
          created: 1,
          id: completionId,
          model: "literature-test-model",
          object: "chat.completion.chunk",
        }];
    const finish = {
      choices: [{ delta: {}, finish_reason: toolResultCount >= 2 ? "stop" : "tool_calls", index: 0 }],
      created: 1,
      id: completionId,
      model: "literature-test-model",
      object: "chat.completion.chunk",
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const responseChunk of responseChunks) response.write(`data: ${JSON.stringify(responseChunk)}\n\n`);
    response.write(`data: ${JSON.stringify(finish)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolveListen) => modelServer.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => modelServer.close(() => resolveClose())));
  return {
    baseUrl: `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1`,
    requests,
  };
}

async function startReviewerCorrectionModel(context: TestContext): Promise<string> {
  let calls = 0;
  const modelServer = createHttpServer(async (request, response) => {
    for await (const _chunk of request) {
      // Consume the request before returning the deterministic review-loop response.
    }
    calls += 1;
    const content = calls > 1
      ? "I retract the computed mean because no successful execution record exists."
      : "The computed mean is 42.";
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null, index: 0 }], created: 1, id: "review-correction", model: "review-correction", object: "chat.completion.chunk" })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }], created: 1, id: "review-correction", model: "review-correction", object: "chat.completion.chunk" })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolveListen) => modelServer.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => modelServer.close(() => resolveClose())));
  return `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1`;
}

// Explicit credentials keep the configuration tests away from the bootstrap
// token files; generation, reuse and precedence are covered in detail by
// `http/bootstrap-tokens.test.ts`.
const CONFIGURED_TOKENS = {
  SCIENCE_AGENT_AUTH_TOKEN: "configured-auth-token",
  SCIENCE_AGENT_GATEWAY_INTERNAL_TOKEN: "configured-gateway-token",
};

test("loadServerConfig uses safe local defaults", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `config-defaults-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const config = loadServerConfig({ SCIENCE_AGENT_DATA_DIR: tempRoot });
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 4310);
  // No shipped credential: an unset variable means "generate one for this
  // installation", so the token must be fresh rather than a known literal.
  assert.equal(config.authTokenSource, "generated");
  assert.equal(config.authToken.length >= 32, true);
  assert.notEqual(config.authToken, "science-agent-local");
  assert.equal(config.dataDir, tempRoot);
  assert.equal(config.paperPythonPath, resolve(config.dataDir, "envs/paper/bin/python"));
  assert.equal(config.runnerUrl, "http://127.0.0.1:4311");
  assert.equal(config.gatewayIdleTimeoutMs, 240_000);
  assert.equal(config.gatewayTurnTimeoutMs, 0);
  assert.equal(config.runnerExecTimeoutMs, 0);
  assert.equal(config.kernelIdleTimeoutMs, 0);
  assert.equal(config.permissionWaitTimeoutMs, 0);
});

test("loadServerConfig defaults the data directory to the repository data dir", () => {
  const config = loadServerConfig({ ...CONFIGURED_TOKENS });
  assert.equal(config.dataDir.endsWith("/.sciencediscovery-data"), true);
});

test("loadServerConfig preserves an explicit network bind", () => {
  const config = loadServerConfig({ ...CONFIGURED_TOKENS, SCIENCE_AGENT_HOST: "0.0.0.0" });
  assert.equal(config.host, "0.0.0.0");
});

test("loadServerConfig derives the paper env from a relocated data dir", () => {
  const config = loadServerConfig({ ...CONFIGURED_TOKENS, SCIENCE_AGENT_DATA_DIR: "/srv/sciencediscovery" });
  assert.equal(config.dataDir, "/srv/sciencediscovery");
  assert.equal(config.paperPythonPath, "/srv/sciencediscovery/envs/paper/bin/python");
});

test("loadServerConfig validates the port", () => {
  assert.throws(
    () => loadServerConfig({ ...CONFIGURED_TOKENS, SCIENCE_AGENT_PORT: "70000" }),
    /integer between 0 and 65535/,
  );
});

test("loadServerConfig validates gateway timeout bounds", () => {
  const config = loadServerConfig({
    ...CONFIGURED_TOKENS,
    SCIENCE_AGENT_GATEWAY_IDLE_TIMEOUT_MS: "30000",
    SCIENCE_AGENT_GATEWAY_TURN_TIMEOUT_MS: "120000",
  });
  assert.equal(config.gatewayIdleTimeoutMs, 30_000);
  assert.equal(config.gatewayTurnTimeoutMs, 120_000);
  assert.equal(loadServerConfig({ ...CONFIGURED_TOKENS, SCIENCE_AGENT_GATEWAY_IDLE_TIMEOUT_MS: "0" }).gatewayIdleTimeoutMs, 0);
  assert.equal(loadServerConfig({ ...CONFIGURED_TOKENS, SCIENCE_AGENT_GATEWAY_TURN_TIMEOUT_MS: "0" }).gatewayTurnTimeoutMs, 0);
  assert.throws(
    () => loadServerConfig({
      ...CONFIGURED_TOKENS,
      SCIENCE_AGENT_GATEWAY_IDLE_TIMEOUT_MS: "120000",
      SCIENCE_AGENT_GATEWAY_TURN_TIMEOUT_MS: "30000",
    }),
    /must be greater than or equal/,
  );
  assert.throws(
    () => loadServerConfig({ ...CONFIGURED_TOKENS, SCIENCE_AGENT_PERMISSION_WAIT_TIMEOUT_MS: "-1" }),
    /must be a non-negative integer/,
  );
});

test("creating a Project opens an implicit Session and refines its first-message title", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `session-auto-name-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const namingModel = await startAutoNamingModel(context);
  const { origin } = await startTestApi(context, tempRoot);
  await createTestModel(origin, {
    baseUrl: namingModel.baseUrl,
    model: "auto-name-model",
    name: "Auto name model",
  });

  const created = await jsonRequest<CreateProjectResponse>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Automatic naming" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.id, created.body.project.id, "legacy Project fields remain at the response root");
  assert.equal(created.body.firstSession.projectId, created.body.project.id);
  assert.equal(created.body.firstSession.title, "Untitled session");
  assert.equal("sessionNamingMode" in created.body.firstSession, false);
  const listed = await jsonRequest<Session[]>(
    `${origin}/api/projects/${created.body.project.id}/sessions`,
    { headers: authorization },
  );
  assert.deepEqual(listed.body.map((session) => session.id), [created.body.firstSession.id]);

  const firstMessage = "Analyze TP53 expression across the uploaded single-cell cohorts and compare conditions";
  const run = await fetch(`${origin}/api/sessions/${created.body.firstSession.id}/messages`, {
    body: JSON.stringify({ content: firstMessage }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(run.status, 200);
  const events = parseSseEvents(await run.text());
  const localUpdate = events.find((event) => event.type === "session.updated") as
    | { session?: Session; type: string }
    | undefined;
  assert.equal(localUpdate?.session?.title, createLocalSessionTitle(firstMessage, created.body.firstSession.createdAt));

  let named: Session | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await jsonRequest<Session>(
      `${origin}/api/sessions/${created.body.firstSession.id}`,
      { headers: authorization },
    );
    if (current.body.title === "Refined TP53 expression study") {
      named = current.body;
      break;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  assert.equal(named?.title, "Refined TP53 expression study");
  assert.equal(namingModel.namingRequests.length, 1);
  const usage = await jsonRequest<SessionUsageSummary>(
    `${origin}/api/sessions/${created.body.firstSession.id}/usage`,
    { headers: authorization },
  );
  assert.equal(usage.body.byInvocationKind.find((item) => item.key === "session-naming")?.invocationCount, 1);

  const secondRun = await fetch(`${origin}/api/sessions/${created.body.firstSession.id}/messages`, {
    body: JSON.stringify({ content: "Now compare the validation cohort" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(secondRun.status, 200);
  await secondRun.text();
  assert.equal(namingModel.namingRequests.length, 1);
});

test("every later unnamed Session independently reuses first-message automatic naming", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `later-session-auto-name-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const namingModel = await startAutoNamingModel(context);
  const { origin } = await startTestApi(context, tempRoot);
  await createTestModel(origin, {
    baseUrl: namingModel.baseUrl,
    model: "auto-name-model",
    name: "Auto name model",
  });

  const createdProject = await jsonRequest<CreateProjectResponse>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Later Session naming" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const firstMessages = [
    "Compare EGFR expression across the treatment and control cohorts",
    "Map T-cell marker expression across all sampled tissues",
    "Summarize enriched pathways for each experimental condition",
  ];
  const sessionIds = new Set([createdProject.body.firstSession.id]);

  for (const firstMessage of firstMessages) {
    const createdSession = await jsonRequest<Session>(
      `${origin}/api/projects/${createdProject.body.project.id}/sessions`,
      {
        body: JSON.stringify({}),
        headers: { ...authorization, "content-type": "application/json" },
        method: "POST",
      },
    );
    assert.equal(createdSession.response.status, 201);
    assert.equal(createdSession.body.title, UNTITLED_SESSION_TITLE);
    assert.equal(sessionIds.has(createdSession.body.id), false);
    sessionIds.add(createdSession.body.id);

    const run = await fetch(`${origin}/api/sessions/${createdSession.body.id}/messages`, {
      body: JSON.stringify({ content: firstMessage }),
      headers: { ...authorization, "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(run.status, 200);
    const events = parseSseEvents(await run.text());
    const localUpdate = events.find((event) => event.type === "session.updated") as
      | { session?: Session; type: string }
      | undefined;
    assert.equal(
      localUpdate?.session?.title,
      createLocalSessionTitle(firstMessage, createdSession.body.createdAt),
    );

    const runs = await jsonRequest<SessionRun[]>(
      `${origin}/api/sessions/${createdSession.body.id}/runs`,
      { headers: authorization },
    );
    assert.equal(runs.body[0]?.queueOrder, 1);

    let named: Session | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await jsonRequest<Session>(
        `${origin}/api/sessions/${createdSession.body.id}`,
        { headers: authorization },
      );
      if (current.body.title === "Refined TP53 expression study") {
        named = current.body;
        break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    assert.equal(named?.title, "Refined TP53 expression study");
  }
  assert.equal(namingModel.namingRequests.length, firstMessages.length);
});

test("Session title refinement completes while the first task is still running", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `session-auto-name-concurrent-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const namingModel = await startAutoNamingModel(context, false, true);
  const { origin } = await startTestApi(context, tempRoot);
  await createTestModel(origin, {
    baseUrl: namingModel.baseUrl,
    model: "auto-name-model",
    name: "Auto name model",
  });
  const created = await jsonRequest<CreateProjectResponse>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Concurrent naming" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });

  const runRequest = fetch(`${origin}/api/sessions/${created.body.firstSession.id}/messages`, {
    body: JSON.stringify({ content: "Analyze TP53 expression across treatment cohorts" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  let refined: Session | undefined;
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await jsonRequest<Session>(
        `${origin}/api/sessions/${created.body.firstSession.id}`,
        { headers: authorization },
      );
      if (current.body.title === "Refined TP53 expression study") {
        refined = current.body;
        break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    assert.equal(refined?.title, "Refined TP53 expression study");
    const runs = await jsonRequest<SessionRun[]>(
      `${origin}/api/sessions/${created.body.firstSession.id}/runs`,
      { headers: authorization },
    );
    const firstRun = runs.body[0];
    assert.ok(firstRun);
    const running = await waitForRunStatus(origin, created.body.firstSession.id, firstRun.id, "running");
    assert.equal(running.status, "running");
    assert.equal(namingModel.namingRequests.length, 1);
  } finally {
    namingModel.releaseTask();
  }
  const run = await runRequest;
  assert.equal(run.status, 200);
  assert.match(await run.text(), /"status":"completed"/);
});

test("Session title refinement persists when the naming model finishes after the run stream closes", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `session-auto-name-after-terminal-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const namingModel = await startAutoNamingModel(context, true);
  const { origin } = await startTestApi(context, tempRoot);
  await createTestModel(origin, {
    baseUrl: namingModel.baseUrl,
    model: "auto-name-model",
    name: "Auto name model",
  });
  const created = await jsonRequest<CreateProjectResponse>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Late naming" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const runRequest = fetch(`${origin}/api/sessions/${created.body.firstSession.id}/messages`, {
    body: JSON.stringify({ content: "Compare TP53 expression across treatment cohorts" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });

  await namingModel.namingStarted;
  const runResponse = await runRequest;
  assert.equal(runResponse.status, 200);
  assert.match(await runResponse.text(), /"status":"completed"/);
  const beforeRefinement = await jsonRequest<Session>(
    `${origin}/api/sessions/${created.body.firstSession.id}`,
    { headers: authorization },
  );
  assert.equal(
    beforeRefinement.body.title,
    createLocalSessionTitle("Compare TP53 expression across treatment cohorts", created.body.firstSession.createdAt),
  );

  namingModel.releaseNaming();
  let refined: Session | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await jsonRequest<Session>(
      `${origin}/api/sessions/${created.body.firstSession.id}`,
      { headers: authorization },
    );
    if (current.body.title === "Refined TP53 expression study") {
      refined = current.body;
      break;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  assert.equal(refined?.title, "Refined TP53 expression study");

  const runs = await jsonRequest<SessionRun[]>(
    `${origin}/api/sessions/${created.body.firstSession.id}/runs`,
    { headers: authorization },
  );
  const events = await listRunEvents(origin, created.body.firstSession.id, runs.body[0]!.id);
  const terminalIndex = events.findIndex((record) => record.event.type === "run.completed");
  const refinedIndex = events.findIndex((record) =>
    record.event.type === "session.updated"
    && record.event.session.title === "Refined TP53 expression study");
  assert.equal(terminalIndex >= 0, true);
  assert.equal(refinedIndex > terminalIndex, true);
});

test("concurrent first messages keep every run and auto-name only once from queue order one", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `session-first-message-concurrency-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const namingModel = await startAutoNamingModel(context, true, true);
  const { origin } = await startTestApi(context, tempRoot);
  await createTestModel(origin, {
    baseUrl: namingModel.baseUrl,
    model: "auto-name-model",
    name: "Auto name model",
  });
  const created = await jsonRequest<CreateProjectResponse>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Concurrent first messages" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const prompts = [
    "Analyze the first submitted cohort",
    "Compare the second submitted cohort",
  ];
  const requests = prompts.map((content) => fetch(
    `${origin}/api/sessions/${created.body.firstSession.id}/messages`,
    {
      body: JSON.stringify({ content }),
      headers: { ...authorization, "content-type": "application/json" },
      method: "POST",
    },
  ));

  let runs: SessionRun[] = [];
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await jsonRequest<SessionRun[]>(
        `${origin}/api/sessions/${created.body.firstSession.id}/runs`,
        { headers: authorization },
      );
      runs = current.body;
      if (runs.length === prompts.length) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    assert.deepEqual(runs.map((run) => run.queueOrder), [1, 2]);
    assert.deepEqual(runs.map((run) => run.prompt).toSorted(), prompts.toSorted());
    const current = await jsonRequest<Session>(
      `${origin}/api/sessions/${created.body.firstSession.id}`,
      { headers: authorization },
    );
    assert.equal(
      current.body.title,
      createLocalSessionTitle(runs[0]!.prompt, created.body.firstSession.createdAt),
    );
    await namingModel.namingStarted;
    assert.equal(namingModel.namingRequests.length, 1);
  } finally {
    namingModel.releaseNaming();
    namingModel.releaseTask();
  }
  const responses = await Promise.all(requests);
  assert.equal(responses.every((response) => response.status === 200), true);
  await Promise.all(responses.map((response) => response.text()));
  assert.equal(namingModel.namingRequests.length, 1);
});

test("an asynchronous title refinement never overwrites a manual rename", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `session-auto-name-manual-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const namingModel = await startAutoNamingModel(context, true);
  const { origin } = await startTestApi(context, tempRoot);
  await createTestModel(origin, {
    baseUrl: namingModel.baseUrl,
    model: "auto-name-model",
    name: "Auto name model",
  });
  const created = await jsonRequest<CreateProjectResponse>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Manual override" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const run = await fetch(`${origin}/api/sessions/${created.body.firstSession.id}/messages`, {
    body: JSON.stringify({ content: "Compare TP53 expression between treatment groups" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(run.status, 200);
  assert.match(await run.text(), /"status":"completed"/);
  await namingModel.namingStarted;

  const manual = await jsonRequest<Session>(`${origin}/api/sessions/${created.body.firstSession.id}`, {
    body: JSON.stringify({ title: "My curated TP53 analysis" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "PATCH",
  });
  assert.equal(manual.body.title, "My curated TP53 analysis");
  namingModel.releaseNaming();
  let namingInvocationCount = 0;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const usage = await jsonRequest<SessionUsageSummary>(
      `${origin}/api/sessions/${created.body.firstSession.id}/usage`,
      { headers: authorization },
    );
    namingInvocationCount = usage.body.byInvocationKind
      .find((item) => item.key === "session-naming")?.invocationCount ?? 0;
    if (namingInvocationCount === 1) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  assert.equal(namingInvocationCount, 1);
  const afterRefine = await jsonRequest<Session>(
    `${origin}/api/sessions/${created.body.firstSession.id}`,
    { headers: authorization },
  );
  assert.equal(afterRefine.body.title, "My curated TP53 analysis");
  assert.equal(namingModel.namingRequests.length, 1);
});

test("a second message never triggers another naming request", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `session-auto-name-dedupe-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const namingModel = await startAutoNamingModel(context, false, false, "Compact title");
  const { origin } = await startTestApi(context, tempRoot);
  await createTestModel(origin, {
    baseUrl: namingModel.baseUrl,
    model: "auto-name-model",
    name: "Auto name model",
  });
  const created = await jsonRequest<CreateProjectResponse>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Naming dedupe" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const run = await fetch(`${origin}/api/sessions/${created.body.firstSession.id}/messages`, {
    body: JSON.stringify({ content: "Compact title" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(run.status, 200);
  await run.text();

  let namingInvocationCount = 0;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const usage = await jsonRequest<SessionUsageSummary>(
      `${origin}/api/sessions/${created.body.firstSession.id}/usage`,
      { headers: authorization },
    );
    namingInvocationCount = usage.body.byInvocationKind
      .find((item) => item.key === "session-naming")?.invocationCount ?? 0;
    if (namingInvocationCount === 1) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  assert.equal(namingInvocationCount, 1);

  const secondRun = await fetch(`${origin}/api/sessions/${created.body.firstSession.id}/messages`, {
    body: JSON.stringify({ content: "Continue with a second analysis request" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(secondRun.status, 200);
  await secondRun.text();
  assert.equal(namingModel.namingRequests.length, 1);
});

test("an explicitly named Session is never auto-renamed", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `session-explicit-name-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const namingModel = await startAutoNamingModel(context);
  const { origin } = await startTestApi(context, tempRoot);
  await createTestModel(origin, {
    baseUrl: namingModel.baseUrl,
    model: "auto-name-model",
    name: "Auto name model",
  });

  const project = await jsonRequest<CreateProjectResponse>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Explicit naming" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const named = await jsonRequest<Session>(
    `${origin}/api/projects/${project.body.project.id}/sessions`,
    {
      body: JSON.stringify({ title: "Curated cohort analysis" }),
      headers: { ...authorization, "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(named.response.status, 201);

  const run = await fetch(`${origin}/api/sessions/${named.body.id}/messages`, {
    body: JSON.stringify({ content: "Compare cell-state abundance across all treatment cohorts" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(run.status, 200);
  assert.equal(parseSseEvents(await run.text()).some((event) => event.type === "session.updated"), false);
  const current = await jsonRequest<Session>(
    `${origin}/api/sessions/${named.body.id}`,
    { headers: authorization },
  );
  assert.equal(current.body.title, "Curated cohort analysis");
  assert.equal(namingModel.namingRequests.length, 0);
});

test("aggregateToolText preserves every textual tool-result block", () => {
  assert.equal(aggregateToolText({
    content: [
      { text: "first diagnostic", type: "text" },
      { type: "image" },
      { text: "Python execution timed out after 25 ms", type: "text" },
    ],
  }), "first diagnostic\nPython execution timed out after 25 ms");
});

test("permission wait timeout and abort cancel only the abandoned request and emit its terminal state", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `permission-timeout-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const store = new SessionStore(tempRoot);
  await store.load();
  const model = await store.createModel({
    apiToken: "test-token",
    baseUrl: "https://models.example.test/v1",
    model: "test-model",
    name: "Test model",
  });
  await store.replaceGlobalSettings({ modelId: model.id });
  const project = await store.createProject("Permission timeout");
  const session = await store.createSession(project.id, "Permission timeout");
  const run = await store.createSessionRun({
    prompt: "Wait for permission",
    sessionId: session.id,
    settingsSnapshot: store.resolveRuntimeSettings(session.id).effective,
  });
  await store.updateSessionRunStatus(session.id, run.id, "running", { startedAt: new Date().toISOString() });
  const pending = await store.requestPermission(session.id, "connector", "pubmed", "Query PubMed");
  assert.equal(pending.allowed, false);
  if (pending.allowed) throw new Error("Expected a pending permission request");
  const events: RunStreamEvent[] = [];
  const runWait = {
    emit: (event: RunStreamEvent) => { events.push(event); },
    runId: run.id,
    sessionId: session.id,
  };
  await assert.rejects(
    waitForPermissionDecision(store, pending.request, 10, undefined, runWait),
    /Permission wait timed out after 10 ms: Query PubMed/,
  );
  const timedOut = store.getPermissionRequest(pending.request.id);
  assert.equal(timedOut?.state, "cancelled");
  assert.ok(timedOut?.decidedAt);
  assert.equal(events.filter((event) => event.type === "permission.resolved").length, 1);
  assert.equal((await store.getSessionRun(session.id, run.id))?.status, "running");
  await assert.rejects(
    store.decidePermissionRequest(pending.request.id, "allow_once"),
    /Permission request was already decided/,
  );

  const aborted = await store.requestPermission(session.id, "connector", "arxiv", "Query arXiv");
  if (aborted.allowed) throw new Error("Expected a pending permission request");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    waitForPermissionDecision(store, aborted.request, 0, controller.signal, runWait),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  const abortedRequest = store.getPermissionRequest(aborted.request.id);
  assert.equal(abortedRequest?.state, "cancelled");
  assert.ok(abortedRequest?.decidedAt);
  assert.equal(events.filter((event) => event.type === "permission.resolved").length, 2);
  assert.equal((await store.getSessionRun(session.id, run.id))?.status, "running");
});

test("runtime-status Kernel teardown is authenticated and proxied to the Runner", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `kernel-teardown-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  let runnerRequest: { authorization?: string; body?: unknown; path?: string } = {};
  const runner = createHttpServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    runnerRequest = {
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      path: request.url,
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      count: 1,
      kernelId: "kernel-one",
      reason: "User cleared the persistent Kernel from Runtime status",
    }));
  });
  await new Promise<void>((resolveListen) => runner.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => runner.close(() => resolveClose())));
  const runnerOrigin = `http://127.0.0.1:${(runner.address() as AddressInfo).port}`;
  const server = createApiServer(testConfig(tempRoot, runnerOrigin));
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const result = await jsonRequest<{ count: number; kernelId: string; reason: string }>(
    `${origin}/api/runtime-status/kernels/kernel-one/teardown`,
    { headers: authorization, method: "POST" },
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.body.count, 1);
  assert.deepEqual(runnerRequest, {
    authorization: "Bearer runner-test-token",
    body: { reason: "User cleared the persistent Kernel from Runtime status" },
    path: "/kernels/kernel-one/teardown",
  });
});

test("timeout settings drive live runs, runtime status, and persistent explainable timeout messages", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `timeout-runtime-status-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const runner = createRunnerServer({
    authToken: "runner-test-token",
    bwrapPath: await writePassthroughBwrap(resolve(tempRoot, "sandbox-stub")),
    dataDir: tempRoot,
    execTimeoutMs: 0,
    host: "127.0.0.1",
    maxOutputBytes: 1_000_000,
    maxWorkspaceBytes: 10_737_418_240,
    npuBrokerEnabled: true,
    port: 0,
  });
  await new Promise<void>((resolveListen) => runner.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => runner.close(() => resolveClose())));
  const runnerOrigin = `http://127.0.0.1:${(runner.address() as AddressInfo).port}`;

  let gatewayMode: "silent" | "tool-success-timeout-text" | "tool-timeout" = "silent";
  const openModelResponses: ServerResponse[] = [];
  const gateway = createHttpServer((request, response) => {
    if (request.url !== "/chat/completions" || request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      if (gatewayMode === "silent") {
        // The API's configured idle timer aborts this deliberately silent stream.
        openModelResponses.push(response);
        return;
      }
      const body = JSON.parse(raw) as { messages: Array<{ content?: unknown; role?: string }> };
      const lastRole = body.messages.at(-1)?.role;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (frame: unknown) => response.write(`data: ${JSON.stringify(frame)}\n\n`);
      if (lastRole === "tool") {
        send({ choices: [{ delta: { content: gatewayMode === "tool-timeout"
          ? "The requested operation did not complete."
          : "The successful tool output was summarized." } }] });
      } else {
        // Real run_python execution: the sleep trips the configured Runner
        // exec timeout in tool-timeout mode; the print completes in success mode.
        const code = gatewayMode === "tool-timeout"
          ? "import time\ntime.sleep(2)"
          : "print('A paper title says: Python execution timed out after 25 ms')";
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${gatewayMode}`, type: "function", function: { name: "run_python", arguments: JSON.stringify({ code }) } }] } }] });
      }
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await new Promise<void>((resolveListen) => gateway.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => {
    for (const open of openModelResponses) open.destroy();
    gateway.close(() => resolveClose());
    gateway.closeAllConnections();
  }));
  const modelOrigin = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;

  const server = createApiServer({
    ...testConfig(tempRoot, runnerOrigin),
    gatewayIdleTimeoutMs: 25,
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const defaults = await jsonRequest<SystemTimeoutSettings>(`${origin}/api/timeout-settings`, { headers: authorization });
  assert.deepEqual(defaults.body, {
    gatewayIdleTimeoutMs: 25,
    gatewayTurnTimeoutMs: 0,
    kernelIdleTimeoutMs: 0,
    permissionWaitTimeoutMs: 0,
    runnerExecTimeoutMs: 0,
  });
  const configured = await jsonRequest<SystemTimeoutSettings>(`${origin}/api/timeout-settings`, {
    body: JSON.stringify({ ...defaults.body, gatewayIdleTimeoutMs: 40 }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "PUT",
  });
  assert.equal(configured.body.gatewayIdleTimeoutMs, 40);
  const invalidTimeouts = await fetch(`${origin}/api/timeout-settings`, {
    body: JSON.stringify({
      ...configured.body,
      gatewayIdleTimeoutMs: 240_000,
      gatewayTurnTimeoutMs: 120_000,
    }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "PUT",
  });
  assert.equal(invalidTimeouts.status, 400);
  assert.match(
    (await invalidTimeouts.json() as { error: string }).error,
    /gatewayTurnTimeoutMs must be greater than or equal to gatewayIdleTimeoutMs when both timeouts are finite/,
  );
  assert.deepEqual(
    (await jsonRequest<SystemTimeoutSettings>(`${origin}/api/timeout-settings`, { headers: authorization })).body,
    configured.body,
  );

  const model = await createTestModel(origin, {
    baseUrl: modelOrigin,
    model: "scripted-loop-model",
    name: "Scripted loop model",
  });
  await jsonRequest(`${origin}/api/settings`, {
    body: JSON.stringify({ modelId: model.id, semanticReviewEnabled: false }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "PUT",
  });
  const project = await jsonRequest<Project>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Timeout project" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const session = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ title: "Timeout session" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });

  const run = await fetch(`${origin}/api/sessions/${session.body.id}/messages`, {
    body: JSON.stringify({ content: "Wait for the silent Gateway." }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(run.status, 200);
  const live = await jsonRequest<RuntimeStatus>(`${origin}/api/runtime-status`, { headers: authorization });
  assert.equal(live.body.sessions[0]?.sessionId, session.body.id);
  assert.equal(live.body.runner.status, "ok");

  const stream = await run.text();
  assert.match(stream, /no gateway progress for 40 ms/);
  const detail = await jsonRequest<SessionDetail>(`${origin}/api/sessions/${session.body.id}`, { headers: authorization });
  const notice = detail.body.messages.at(-1);
  assert.equal(notice?.kind, "timeout_notice");
  assert.equal(notice?.timeout?.kind, "gateway_idle");
  assert.equal(notice?.timeout?.timeoutMs, 40);
  assert.match(notice?.content ?? "", /Agent idle timeout was reached after 40 milliseconds/);

  const completed = await jsonRequest<RuntimeStatus>(`${origin}/api/runtime-status`, { headers: authorization });
  assert.deepEqual(completed.body.sessions, []);

  gatewayMode = "tool-success-timeout-text";
  // Real tool execution follows; keep the idle window generous so only the
  // Runner exec timeout (next phase) is under test.
  await jsonRequest<SystemTimeoutSettings>(`${origin}/api/timeout-settings`, {
    body: JSON.stringify({ ...configured.body, gatewayIdleTimeoutMs: 30_000 }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "PUT",
  });
  const successfulToolSession = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ approvalMode: "always_allow", title: "Successful tool session" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const successfulToolRun = await fetch(`${origin}/api/sessions/${successfulToolSession.body.id}/messages`, {
    body: JSON.stringify({ content: "Summarize text containing timeout-like words." }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  await successfulToolRun.text();
  const successfulToolDetail = await jsonRequest<SessionDetail>(
    `${origin}/api/sessions/${successfulToolSession.body.id}`,
    { headers: authorization },
  );
  assert.equal(
    successfulToolDetail.body.messages.some((message) => message.kind === "timeout_notice"),
    false,
  );

  gatewayMode = "tool-timeout";
  await jsonRequest<SystemTimeoutSettings>(`${origin}/api/timeout-settings`, {
    body: JSON.stringify({ ...configured.body, gatewayIdleTimeoutMs: 30_000, runnerExecTimeoutMs: 25 }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "PUT",
  });
  const toolTimeoutSession = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ approvalMode: "always_allow", title: "Runner timeout session" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const toolTimeoutRun = await fetch(`${origin}/api/sessions/${toolTimeoutSession.body.id}/messages`, {
    body: JSON.stringify({ content: "Run a deliberately slow Python operation." }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  await toolTimeoutRun.text();
  const toolTimeoutDetail = await jsonRequest<SessionDetail>(
    `${origin}/api/sessions/${toolTimeoutSession.body.id}`,
    { headers: authorization },
  );
  const runnerNotice = toolTimeoutDetail.body.messages.find((message) => message.kind === "timeout_notice");
  assert.equal(runnerNotice?.timeout?.kind, "runner_exec");
  assert.equal(runnerNotice?.timeout?.timeoutMs, 25);
  assert.match(runnerNotice?.content ?? "", /Runner execution timeout was reached after 25 milliseconds/);

  gatewayMode = "silent";
  await jsonRequest<SystemTimeoutSettings>(`${origin}/api/timeout-settings`, {
    body: JSON.stringify({ ...configured.body, gatewayIdleTimeoutMs: 2_000 }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "PUT",
  });
  const cancelledSession = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ title: "Cancelled session" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const cancelledRun = await fetch(`${origin}/api/sessions/${cancelledSession.body.id}/messages`, {
    body: JSON.stringify({ content: "Wait until the user stops this run." }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(cancelledRun.status, 200);
  const cancellation = await jsonRequest<{ cancelled: true; sessionId: string }>(
    `${origin}/api/sessions/${cancelledSession.body.id}/run/cancel`,
    { headers: authorization, method: "POST" },
  );
  assert.equal(cancellation.response.status, 202);
  assert.deepEqual(cancellation.body, { cancelled: true, sessionId: cancelledSession.body.id });
  assert.match(await cancelledRun.text(), /Run cancelled/);
  const afterCancellation = await jsonRequest<RuntimeStatus>(`${origin}/api/runtime-status`, { headers: authorization });
  assert.deepEqual(afterCancellation.body.sessions, []);
});

test("native MCP literature flow produces an audited cited summary", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `literature-review-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const modelServer = await startLiteratureModel(context);
  const searchSchema = {
      additionalProperties: false,
      properties: {
        limit: { default: 5, maximum: 25, minimum: 1, type: "integer" },
        query: { maxLength: 500, minLength: 1, type: "string" },
      },
      required: ["query"],
      type: "object",
    };
  const pubmedCatalog = ({
        loadedAt: new Date().toISOString(),
        revision: "pubmed-test-catalog",
        servers: [{
          enabled: true,
          id: "biomed",
          tools: [
            { description: "search", inputSchema: searchSchema, name: "pubmed_search", schemaHash: "search" },
            {
              description: "prepare",
              inputSchema: {
                additionalProperties: false,
                properties: { identifier: { maxLength: 80, minLength: 1, pattern: "^\\d{1,9}$", type: "string" } },
                required: ["identifier"],
                type: "object",
              },
              name: "pubmed_prepare_paper_download",
              schemaHash: "prepare",
            },
          ],
          transport: "stdio",
        }],
      }) as unknown as McpCatalog;
    const citation = {
      identifier: "12524540",
      identifierType: "PMID",
      label: "PMID 12524540",
      markdown: "[PMID:12524540](https://pubmed.ncbi.nlm.nih.gov/12524540/)",
      role: "primary-literature" as const,
      source: "pubmed",
      url: "https://pubmed.ncbi.nlm.nih.gov/12524540/",
    };
    const result: McpToolResult = {
      attribution: "NLM",
      license: "NCBI",
      records: [{
        abstract: "iASPP inhibition caused p53-dependent apoptosis in the tested systems.",
        authors: ["Bergamaschi D"],
        citations: [citation],
        contentScope: "abstract",
        [`cross${"References"}`]: [],
        fullTextRetrieved: false,
        identifier: "12524540",
        identifierType: "PMID",
        primaryCitation: citation,
        source: "pubmed",
        structuredData: { journal: "Nature Genetics" },
        title: "iASPP oncoprotein is a key inhibitor of p53",
        url: citation.url,
        warnings: [],
      }],
      retrievedAt: new Date().toISOString(),
      sourceId: "pubmed",
      toolId: "search",
      untrusted: true,
      warnings: [],
    };
    const pubmedInvocation = ({
      attempts: [{
        attempt: 1,
        durationMs: 1,
        finishedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        status: "succeeded",
      }],
      content: [{ type: "json", value: result }],
      durationMs: 1,
      isError: false,
      requestId: "pubmed-request",
      serverId: "biomed",
      toolName: "pubmed_search",
    }) as unknown as McpInvokeResponse;
  const mcpTransport: McpTransportClient = {
    catalog: async () => pubmedCatalog,
    invoke: async () => pubmedInvocation,
    reload: async () => pubmedCatalog,
  };
  const { origin } = await startTestApi(context, tempRoot, mcpTransport);
  const model = await createTestModel(origin, {
    baseUrl: modelServer.baseUrl,
    model: "literature-test-model",
    name: "Literature test model",
  });
  const settings = await jsonRequest<RuntimeSettingsDetails>(`${origin}/api/settings`, {
    body: JSON.stringify({
      enabledConnectorIds: ["pubmed"],
      modelId: model.id,
      semanticReviewEnabled: false,
    }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "PUT",
  });
  assert.equal(settings.response.status, 200);
  // Skills are selected from the Project layer down; Global only carries connectors and the model.
  const project = await jsonRequest<Project>(`${origin}/api/projects`, {
    body: JSON.stringify({
      name: "Literature review",
      settingsOverrides: { enabledSkillIds: ["life-science-evidence-brief"], skillSelectionMode: "selected" },
    }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const session = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ title: "TP53 evidence" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.deepEqual(session.body.enabledConnectorIds, ["pubmed"]);
  assert.deepEqual(session.body.enabledSkillIds, ["life-science-evidence-brief"]);

  const run = await fetch(`${origin}/api/sessions/${session.body.id}/messages`, {
    body: JSON.stringify({ content: "Research TP53 apoptosis and summarize the literature with verifiable citations." }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(run.status, 200);
  assert.ok(run.body);
  const reader = run.body.getReader();
  const decoder = new TextDecoder();
  let stream = "";
  let permissionRequestId: string | undefined;
  while (!permissionRequestId) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`run ended before requesting MCP permission:\n${stream}`);
    stream += decoder.decode(value, { stream: true });
    const permissionFrame = stream
      .split("\n\n")
      .find((frame) => frame.includes('"type":"permission.required"'));
    if (permissionFrame) {
      const payload = permissionFrame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
      permissionRequestId = payload
        ? (JSON.parse(payload) as { request?: { id?: string } }).request?.id
        : undefined;
    }
  }
  const permissionDecision = await jsonRequest(`${origin}/api/permission-requests/${permissionRequestId}/decision`, {
    body: JSON.stringify({ decision: "allow_matching" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(permissionDecision.response.status, 200);
  while (true) {
    const { done, value } = await reader.read();
    stream += decoder.decode(value, { stream: !done });
    if (done) break;
  }
  assert.match(stream, /"type":"permission.required"/);
  assert.match(stream, /"name":"mcp__pubmed__search"/);
  assert.match(stream, /"status":"completed"/);
  assert.match(stream, /PMID:12524540/);
  assert.doesNotMatch(stream, /"type":"run.failed"/);

  const invocations = await jsonRequest<McpInvocation[]>(
    `${origin}/api/sessions/${session.body.id}/mcp/invocations`,
    { headers: authorization },
  );
  assert.equal(invocations.body.length, 1);
  assert.equal(invocations.body[0]?.status, "succeeded");
  assert.ok(invocations.body[0]?.normalizedResult);
  const normalized = await jsonRequest<McpToolResult>(
    `${origin}/api/cas/${invocations.body[0]!.normalizedResult!.hash}`,
    { headers: authorization },
  );
  assert.equal(normalized.body.records[0]?.contentScope, "abstract");
  assert.equal(normalized.body.records[0]?.fullTextRetrieved, false);
  assert.equal(normalized.body.records[0]?.primaryCitation.markdown, "[PMID:12524540](https://pubmed.ncbi.nlm.nih.gov/12524540/)");

  const detail = await jsonRequest<SessionDetail>(`${origin}/api/sessions/${session.body.id}`, { headers: authorization });
  const summary = detail.body.messages.findLast((message) => message.role === "assistant")?.content ?? "";
  assert.match(summary, /abstract only; no article full text was retrieved/i);
  assert.match(summary, /\[PMID:12524540\]\(https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/12524540\/\)/);
  const manifests = await jsonRequest<PromptManifest[]>(
    `${origin}/api/sessions/${session.body.id}/prompt-manifests`,
    { headers: authorization },
  );
  assert.equal(manifests.body[0]?.skillRefs[0]?.id, "life-science-evidence-brief");
  const systemPrompt = modelServer.requests[0]?.messages?.find((message) => message.role === "system")?.content ?? "";
  assert.match(systemPrompt, /<skill_system>/);
  assert.match(systemPrompt, /<name>life-science-evidence-brief<\/name>/);
  assert.doesNotMatch(systemPrompt, /# Life-science Evidence Brief/);
  assert.match(systemPrompt, /never invent a paper or identifier/i);
});

test("workbench search and Composer references use authenticated authoritative identities", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `workbench-search-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const modelServer = await startTextModel(context);
  const { origin } = await startTestApi(context, tempRoot);
  const model = await createTestModel(origin, { baseUrl: modelServer.baseUrl });
  const project = await jsonRequest<Project>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Proteomics" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const session = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ modelId: model.id, title: "Differential analysis" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const upload = await fetch(`${origin}/api/sessions/${session.body.id}/files`, {
    body: JSON.stringify({ content: "# Result\n", path: "reports/result.md" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(upload.status, 201);

  assert.equal((await fetch(`${origin}/api/search?q=result`)).status, 401);
  const search = await jsonRequest<WorkbenchSearchResult[]>(`${origin}/api/search?q=result`, { headers: authorization });
  assert.deepEqual(search.body.map((result) => result.kind), ["artifact"]);
  assert.equal(search.body[0]?.path, "reports/result.md");
  assert.match(search.body[0]?.id ?? "", /^artifact:/);
  assert.equal(search.body[0]?.sessionId, session.body.id);

  const catalog = await jsonRequest<ScientificArtifact[]>(
    `${origin}/api/projects/${project.body.id}/artifacts`,
    { headers: authorization },
  );
  const uploadedArtifact = catalog.body[0]!;
  assert.equal(uploadedArtifact.origin, "user_upload");

  const run = await fetch(`${origin}/api/sessions/${session.body.id}/messages`, {
    body: JSON.stringify({
      content: "Compare @[reports/result.md] #[Differential analysis] /life-science-evidence-brief",
      references: [
        { id: uploadedArtifact.id, kind: "artifact", label: "untrusted", path: "reports/result.md" },
        { id: session.body.id, kind: "session", label: "untrusted" },
        { id: "life-science-evidence-brief", kind: "skill", label: "untrusted" },
      ],
    }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(run.status, 200);
  const stream = await run.text();
  assert.deepEqual(rootSseGolden(stream), [
    "run.started",
    "agent.phase",
    "assistant.delta",
    "run.completed",
  ]);

  const detail = await jsonRequest<SessionDetail>(`${origin}/api/sessions/${session.body.id}`, { headers: authorization });
  const userMessage = detail.body.messages.findLast((message) => message.role === "user");
  assert.deepEqual(userMessage?.references?.map((reference) => [reference.kind, reference.label]), [
    ["artifact", "reports/result.md"],
    ["session", "Differential analysis"],
    ["skill", "life-science-evidence-brief"],
  ]);

  const invalid = await fetch(`${origin}/api/sessions/${session.body.id}/messages`, {
    body: JSON.stringify({
      content: "Use missing context",
      references: [{ id: "missing", kind: "artifact", label: "missing", path: "missing.csv" }],
    }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(invalid.status, 400);
  assert.match(await invalid.text(), /Referenced Project artifact is unavailable/);
});

test("running sessions accept queued runs and start them after the active run completes", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `queued-runs-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const modelServer = await startTextModel(context, true);
  const { origin } = await startTestApi(context, tempRoot);
  const model = await createTestModel(origin, { baseUrl: modelServer.baseUrl });
  const project = await jsonRequest<Project>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Queue project" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const session = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ modelId: model.id, title: "Queue session" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });

  const first = await jsonRequest<SessionRun>(`${origin}/api/sessions/${session.body.id}/runs`, {
    body: JSON.stringify({ content: "Hold the first response." }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(first.response.status, 201);
  await waitForRunStatus(origin, session.body.id, first.body.id, "running");

  const second = await jsonRequest<SessionRun>(`${origin}/api/sessions/${session.body.id}/runs`, {
    body: JSON.stringify({ content: "Queue the second response." }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(second.response.status, 201);
  assert.equal(second.body.status, "queued");
  assert.ok(first.body.queueOrder < second.body.queueOrder);

  const duringFirst = await jsonRequest<SessionDetail>(`${origin}/api/sessions/${session.body.id}`, { headers: authorization });
  assert.deepEqual(duringFirst.body.messages.map((message) => message.content), ["Hold the first response."]);

  modelServer.release();
  await waitForRunStatus(origin, session.body.id, first.body.id, "completed");
  await waitForRunStatus(origin, session.body.id, second.body.id, "completed");
  assert.deepEqual((await listRunEvents(origin, session.body.id, second.body.id)).map((event) => event.event.type).slice(0, 3), [
    "run.queued",
    "run.status",
    "run.started",
  ]);
});

test("completed runs persist the assistant message identity used by hydrated timeline deduplication", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `completed-run-message-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const modelServer = await startTextModel(context);
  const { origin } = await startTestApi(context, tempRoot);
  const model = await createTestModel(origin, { baseUrl: modelServer.baseUrl });
  const project = await jsonRequest<Project>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Completed run project" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const session = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ modelId: model.id, title: "Completed run session" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });

  const response = await fetch(`${origin}/api/sessions/${session.body.id}/messages`, {
    body: JSON.stringify({ content: "Complete this response." }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /"type":"run.completed"/);

  const runs = await jsonRequest<SessionRun[]>(`${origin}/api/sessions/${session.body.id}/runs`, {
    headers: authorization,
  });
  assert.equal(runs.body.length, 1);
  assert.equal(runs.body[0]?.status, "completed");
  assert.ok(runs.body[0]?.assistantMessageId);

  const detail = await jsonRequest<SessionDetail>(`${origin}/api/sessions/${session.body.id}`, {
    headers: authorization,
  });
  assert.equal(detail.body.messages.some((message) => message.id === runs.body[0]!.assistantMessageId), true);
  const hydratedMessages = detail.body.messages.filter((message) => message.id !== runs.body[0]!.assistantMessageId);
  assert.equal(hydratedMessages.some((message) => message.role === "assistant"), false);
});

test("environment setup and mutation routes reject unauthenticated callers", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `environment-permission-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const { origin } = await startTestApi(context, tempRoot);
  const requests = [
    fetch(`${origin}/api/environment-source-settings`),
    fetch(`${origin}/api/environment-setup`, { method: "POST" }),
    fetch(`${origin}/api/environments`, {
      body: JSON.stringify({ language: "python", name: "denied" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    fetch(`${origin}/api/environments/task-denied/install`, {
      body: JSON.stringify({ packages: ["numpy=2.0"] }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    fetch(`${origin}/api/environments/task-denied/uninstall`, {
      body: JSON.stringify({ packages: ["numpy"] }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    fetch(`${origin}/api/environments/task-denied`, {
      method: "DELETE",
    }),
  ];
  const responses = await Promise.all(requests);
  assert.deepEqual(responses.map((response) => response.status), [401, 401, 401, 401, 401, 401]);
});

test("authenticated environment catalog routes proxy create, install, uninstall, and delete", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `environment-routes-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const installBodies: Array<Record<string, unknown>> = [];
  const { origin } = await startScientificTestApi(context, tempRoot, (body) => installBodies.push(body));

  const unauthorized = await fetch(`${origin}/api/environments`);
  assert.equal(unauthorized.status, 401);
  const defaultSources = await jsonRequest<EnvironmentSourceSettings>(
    `${origin}/api/environment-source-settings`,
    { headers: authorization },
  );
  assert.deepEqual(defaultSources.body, { condaSource: "upstream", pipSource: "upstream" });
  const selectedSources = await jsonRequest<EnvironmentSourceSettings>(
    `${origin}/api/environment-source-settings`,
    {
      body: JSON.stringify({ condaSource: "tsinghua", pipSource: "huawei" }),
      headers: { ...authorization, "content-type": "application/json" },
      method: "PUT",
    },
  );
  assert.deepEqual(selectedSources.body, { condaSource: "tsinghua", pipSource: "huawei" });
  const persistedSources = await jsonRequest<EnvironmentSourceSettings>(
    `${origin}/api/environment-source-settings`,
    { headers: authorization },
  );
  assert.deepEqual(persistedSources.body, { condaSource: "tsinghua", pipSource: "huawei" });
  const setup = await jsonRequest<ScientificEnvironmentSetup>(`${origin}/api/environment-setup`, {
    headers: authorization,
    method: "POST",
  });
  assert.equal(setup.body.state, "ready");
  const initial = await jsonRequest<Environment[]>(`${origin}/api/environments`, { headers: authorization });
  assert.deepEqual(initial.body.map((environment) => environment.id), ["starter-python", "starter-r"]);
  const created = await jsonRequest<Environment>(`${origin}/api/environments`, {
    body: JSON.stringify({ language: "python", name: "single-cell" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.kind, "task");
  const installed = await jsonRequest<EnvironmentInstallStatus>(`${origin}/api/environments/${created.body.id}/install`, {
    body: JSON.stringify({ packages: ["scanpy=1.10"] }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(installed.response.status, 201);
  assert.equal(installed.body.status, "succeeded");
  assert.notEqual(installed.body.revision.id, created.body.currentRevisionId);
  const pipInstalled = await jsonRequest<EnvironmentInstallStatus>(`${origin}/api/environments/${created.body.id}/install`, {
    body: JSON.stringify({
      manager: "pip",
      packages: ["mindspore==2.7.0"],
      workspaceRoot: "/forged/browser/workspace",
    }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(pipInstalled.response.status, 201);
  const explicitPipInstalled = await jsonRequest<EnvironmentInstallStatus>(`${origin}/api/environments/${created.body.id}/install`, {
    body: JSON.stringify({
      indexUrl: "https://download.pytorch.org/whl/cpu",
      manager: "pip",
      packages: ["torch", "torchvision"],
    }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(explicitPipInstalled.response.status, 201);
  const invalidSource = await jsonRequest<{ error: string }>(`${origin}/api/environments/${created.body.id}/install`, {
    body: JSON.stringify({
      indexUrl: "https://pypi.org/simple --trusted-host attacker",
      manager: "pip",
      packages: ["numpy"],
    }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(invalidSource.response.status, 400);
  assert.match(invalidSource.body.error, /indexUrl/);
  const localWheelInstalled = await jsonRequest<{ error: string }>(`${origin}/api/environments/${created.body.id}/install`, {
    body: JSON.stringify({
      manager: "pip",
      packages: ["wheels/example_pkg-1.2.3-py3-none-any.whl"],
    }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(localWheelInstalled.response.status, 400);
  assert.match(localWheelInstalled.body.error, /require an Agent Session workspace/);
  assert.deepEqual(installBodies, [
    {
      channels: ["https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge"],
      manager: "conda",
      packages: ["scanpy=1.10"],
    },
    {
      indexUrl: "https://mirrors.huaweicloud.com/repository/pypi/simple",
      manager: "pip",
      packages: ["mindspore==2.7.0"],
    },
    {
      indexUrl: "https://download.pytorch.org/whl/cpu",
      manager: "pip",
      packages: ["torch", "torchvision"],
    },
  ]);
  const uninstalled = await jsonRequest<EnvironmentInstallStatus>(`${origin}/api/environments/${created.body.id}/uninstall`, {
    body: JSON.stringify({ packages: ["scanpy"] }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(uninstalled.response.status, 201);
  assert.equal(uninstalled.body.status, "succeeded");
  assert.notEqual(uninstalled.body.revision.id, installed.body.revision.id);
  const deleted = await fetch(`${origin}/api/environments/${created.body.id}`, {
    headers: authorization,
    method: "DELETE",
  });
  assert.equal(deleted.status, 200);
  const final = await jsonRequest<Environment[]>(`${origin}/api/environments`, { headers: authorization });
  assert.equal(final.body.some((environment) => environment.id === created.body.id), false);
});

test("an active run keeps its effective settings snapshot while later runs use updates", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `settings-snapshot-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const { origin } = await startTestApi(context, tempRoot);
  const delayedModel = await startTextModel(context, true);
  const nextModel = await startTextModel(context);
  const modelA = await createTestModel(origin, { baseUrl: delayedModel.baseUrl, model: "model-a", name: "Model A" });
  const modelB = await createTestModel(origin, { baseUrl: nextModel.baseUrl, model: "model-b", name: "Model B" });
  const skill = await jsonRequest<SkillDetail>(`${origin}/api/skills`, {
    body: JSON.stringify({
      description: "A revision snapshot test skill.",
      instructions: "# Revision one\n\nUse the first revision.",
      name: "snapshot-skill",
    }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(skill.response.status, 201);
  const project = await jsonRequest<Project>(`${origin}/api/projects`, {
    body: JSON.stringify({
      name: "Snapshot project",
      settingsOverrides: { enabledSkillIds: [skill.body.id], skillSelectionMode: "selected" },
    }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const session = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ modelId: modelA.id, title: "Snapshot session" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });

  const firstRun = await fetch(`${origin}/api/sessions/${session.body.id}/messages`, {
    body: JSON.stringify({ content: "Use the first model" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(firstRun.status, 200);
  assert.ok(firstRun.body);
  const firstReader = firstRun.body.getReader();
  const firstDecoder = new TextDecoder();
  let firstStream = "";
  while (!parseSseEvents(firstStream).some((event) => event.type === "run.status" && event.status === "running")) {
    const { done, value } = await firstReader.read();
    if (done) throw new Error(`run ended before reporting a running status:\n${firstStream}`);
    firstStream += firstDecoder.decode(value, { stream: true });
  }
  const archiveDuringRun = await fetch(`${origin}/api/sessions/${session.body.id}/archive`, {
    headers: authorization,
    method: "POST",
  });
  assert.equal(archiveDuringRun.status, 409);
  const deleteDuringRun = await fetch(`${origin}/api/sessions/${session.body.id}`, {
    body: JSON.stringify({ confirmationId: session.body.id }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "DELETE",
  });
  assert.equal(deleteDuringRun.status, 409);
  const deleteProjectDuringRun = await fetch(`${origin}/api/projects/${project.body.id}`, {
    body: JSON.stringify({ confirmationId: project.body.id }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "DELETE",
  });
  assert.equal(deleteProjectDuringRun.status, 409);
  const updated = await jsonRequest<Session>(`${origin}/api/sessions/${session.body.id}`, {
    body: JSON.stringify({ modelId: modelB.id }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "PATCH",
  });
  assert.equal(updated.body.modelId, modelB.id);
  const updatedSkill = await jsonRequest<SkillDetail>(`${origin}/api/skills/${skill.body.id}`, {
    body: JSON.stringify({
      description: "A revision snapshot test skill after editing.",
      expectedRevision: 1,
      instructions: "# Revision two\n\nUse the second revision.",
      name: skill.body.id,
    }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "PUT",
  });
  assert.equal(updatedSkill.body.currentRevision, 2);
  delayedModel.release();
  while (true) {
    const { done, value } = await firstReader.read();
    firstStream += firstDecoder.decode(value, { stream: !done });
    if (done) break;
  }
  assert.match(firstStream, new RegExp(`"modelId":"${modelA.id}"`));

  const secondRun = await fetch(`${origin}/api/sessions/${session.body.id}/messages`, {
    body: JSON.stringify({ content: "Use the updated model" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(secondRun.status, 200);
  await secondRun.text();

  const manifests = await jsonRequest<PromptManifest[]>(
    `${origin}/api/sessions/${session.body.id}/prompt-manifests`,
    { headers: authorization },
  );
  assert.deepEqual(manifests.body.map((manifest) => manifest.modelProfileId), [modelA.id, modelB.id]);
  assert.deepEqual(manifests.body.map((manifest) => manifest.runtimeSettings.modelId), [modelA.id, modelB.id]);
  assert.deepEqual(manifests.body.map((manifest) => manifest.skillRefs[0]?.revision), [1, 2]);
  assert.deepEqual(manifests.body.map((manifest) => manifest.skillRefs.map((ref) => ref.id)), [
    [skill.body.id],
    [skill.body.id],
  ]);

  // The Project runs in `selected` mode, so a `/` attachment outside its
  // whitelist must fail the run instead of widening the active skill set.
  const blockedAttachment = await fetch(`${origin}/api/sessions/${session.body.id}/messages`, {
    body: JSON.stringify({
      content: "Use an unselected skill",
      references: [{ id: "life-science-evidence-brief", kind: "skill", label: "life-science-evidence-brief" }],
    }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(blockedAttachment.status, 200);
  assert.match(
    await blockedAttachment.text(),
    /These skills are not enabled for this Session: life-science-evidence-brief/,
  );
  const afterBlocked = await jsonRequest<PromptManifest[]>(
    `${origin}/api/sessions/${session.body.id}/prompt-manifests`,
    { headers: authorization },
  );
  assert.equal(afterBlocked.body.length, manifests.body.length, "a rejected attachment must not record a manifest");
});

test("skill lifecycle APIs author, import, edit, select, audit impact, and delete safely", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `skill-api-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const { origin } = await startTestApi(context, tempRoot);

  assert.equal((await fetch(`${origin}/api/skills`)).status, 401);
  const initial = await jsonRequest<SkillDescriptor[]>(`${origin}/api/skills`, { headers: authorization });
  assert.equal(initial.response.status, 200);
  assert.deepEqual(initial.body.map((item) => item.id), [
    "antibody-protenix-pipeline",
    "citation-reviewer",
    "code-engineer",
    "computation-reviewer",
    "evidence-extractor",
    "life-science-evidence-brief",
    "literature-searcher",
    "report-writer",
    "result-evaluator",
    "science-research-team",
    "structure-pocket-inspection",
  ]);
  assert.equal(initial.body[0]?.readOnly, true);
  assert.equal("instructions" in (initial.body[0] ?? {}), false);

  const dialogueDraft = await jsonRequest<{ name: string; origin: string; sourceSummary: string }>(`${origin}/api/skills/drafts/dialogue`, {
    body: JSON.stringify({ description: "Prepare a repeatable microscopy quantification workflow." }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(dialogueDraft.response.status, 200);
  assert.equal(dialogueDraft.body.origin, "dialogue");
  assert.match(dialogueDraft.body.sourceSummary, /review/i);

  const created = await jsonRequest<SkillDetail>(`${origin}/api/skills`, {
    body: JSON.stringify({
      description: "A managed skill created through the API.",
      instructions: "# Managed\n\nFollow the managed instructions.",
      metadata: { version: "1.0.0" },
      name: "managed-api-skill",
    }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.currentRevision, 1);
  assert.equal(created.body.version, "1.0.0");

  const stale = await fetch(`${origin}/api/skills/${created.body.id}`, {
    body: JSON.stringify({
      description: created.body.description,
      expectedRevision: 0,
      instructions: created.body.instructions,
      name: created.body.name,
    }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "PUT",
  });
  assert.equal(stale.status, 409);
  const edited = await jsonRequest<SkillDetail>(`${origin}/api/skills/${created.body.id}`, {
    body: JSON.stringify({
      description: "A managed skill after editing.",
      expectedRevision: 1,
      instructions: "# Managed revision two\n\nUse the updated instructions.",
      name: created.body.name,
    }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "PUT",
  });
  assert.equal(edited.body.currentRevision, 2);

  const archive = Buffer.from(zipSync({
    "imported-api-skill/SKILL.md": strToU8("---\nname: imported-api-skill\ndescription: Imported through multipart.\n---\n\n# Imported\n"),
    "imported-api-skill/references/guide.md": strToU8("Imported reference"),
    "imported-api-skill/scripts/inert.py": strToU8("raise RuntimeError('must not run')"),
  }));
  const importForm = new FormData();
  importForm.set("file", new Blob([archive], { type: "application/zip" }), "imported-api-skill.zip");
  const imported = await jsonRequest<SkillDetail>(`${origin}/api/skills/import`, {
    body: importForm,
    headers: authorization,
    method: "POST",
  });
  assert.equal(imported.response.status, 201);
  assert.deepEqual(imported.body.resources.map((item) => item.path), ["references/guide.md", "scripts/inert.py"]);
  const resource = await jsonRequest<{ content: string; revision: number }>(
    `${origin}/api/skills/${imported.body.id}/resources/references%2Fguide.md`,
    { headers: authorization },
  );
  assert.equal(resource.body.content, "Imported reference");
  assert.equal(resource.body.revision, 1);

  const unsafeArchive = Buffer.from(zipSync({
    "../escape.txt": strToU8("escape"),
    "unsafe-skill/SKILL.md": strToU8("---\nname: unsafe-skill\ndescription: Unsafe archive.\n---\n\n# Unsafe\n"),
  }));
  const unsafeForm = new FormData();
  unsafeForm.set("file", new Blob([unsafeArchive], { type: "application/zip" }), "unsafe.zip");
  assert.equal((await fetch(`${origin}/api/skills/import`, {
    body: unsafeForm,
    headers: authorization,
    method: "POST",
  })).status, 400);

  const model = await createTestModel(origin);
  const project = await jsonRequest<Project>(`${origin}/api/projects`, {
    body: JSON.stringify({
      name: "Skill references",
      settingsOverrides: { enabledSkillIds: [created.body.id], modelId: model.id, skillSelectionMode: "selected" },
    }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(project.response.status, 201);
  const session = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ title: "Inherits skill" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.deepEqual(session.body.enabledSkillIds, [created.body.id]);
  const impact = await jsonRequest<SkillDeletionImpact>(`${origin}/api/skills/${created.body.id}/deletion-impact`, {
    headers: authorization,
  });
  assert.deepEqual(impact.body.references.map((item) => item.scope), ["project"]);
  assert.equal((await fetch(`${origin}/api/skills/${created.body.id}`, {
    headers: authorization,
    method: "DELETE",
  })).status, 409);

  await jsonRequest(`${origin}/api/projects/${project.body.id}/settings`, {
    body: JSON.stringify({ enabledSkillIds: [], modelId: model.id }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "PUT",
  });
  assert.equal((await fetch(`${origin}/api/skills/${created.body.id}`, {
    headers: authorization,
    method: "DELETE",
  })).status, 200);
  assert.equal((await fetch(`${origin}/api/skills/life-science-evidence-brief`, {
    headers: authorization,
    method: "DELETE",
  })).status, 409);
  const unknownSetting = await fetch(`${origin}/api/projects/${project.body.id}/settings`, {
    body: JSON.stringify({ enabledSkillIds: ["missing-skill"], modelId: model.id }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "PUT",
  });
  assert.equal(unknownSetting.status, 400);

  for (const content of ["# Result\n\nOriginal value.\n", "# Result\n\nCorrected value with units.\n"]) {
    const saved = await fetch(`${origin}/api/sessions/${session.body.id}/files`, {
      body: JSON.stringify({ content, path: "reviewed-report.md" }),
      headers: { ...authorization, "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(saved.status, 201);
  }
  const reportArtifacts = await jsonRequest<ScientificArtifact[]>(`${origin}/api/sessions/${session.body.id}/artifacts`, { headers: authorization });
  const report = reportArtifacts.body.find((artifact) => artifact.logicalName === "reviewed-report.md")!;
  const reportVersions = await jsonRequest<ScientificArtifactVersion[]>(`${origin}/api/sessions/${session.body.id}/artifacts/${report.id}/versions`, { headers: authorization });
  assert.deepEqual(reportVersions.body.map((version) => version.version), [1, 2]);
  const diff = await jsonRequest<ArtifactVersionDiff>(`${origin}/api/sessions/${session.body.id}/artifact-versions/${reportVersions.body[1]!.id}/diff`, { headers: authorization });
  assert.ok(diff.body.lines.some((line) => line.kind === "removed" && line.text === "Original value."));
  assert.ok(diff.body.lines.some((line) => line.kind === "added" && line.text === "Corrected value with units."));
});

test("PDF upload extracts full text and tables into the session workspace", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `paper-api-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const { origin } = await startTestApi(context, tempRoot);
  const project = await jsonRequest<Project>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Paper project" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const taskModel = await createTestModel(origin);
  const session = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ modelId: taskModel.id, title: "Paper analysis" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const pdfPath = resolve(tempRoot, "fixture.pdf");
  const pythonPath = testConfig(tempRoot).paperPythonPath;
  await execFileAsync(pythonPath, ["-c", [
    "from reportlab.pdfgen import canvas",
    "import sys",
    "pdf=canvas.Canvas(sys.argv[1], pagesize=(400,500))",
    "pdf.drawString(40,460,'Scientific result with embedded text')",
    "[pdf.line(x,300,x,390) for x in (40,180,320)]",
    "[pdf.line(40,y,320,y) for y in (300,330,360,390)]",
    "pdf.drawString(55,370,'Group'); pdf.drawString(195,370,'Mean')",
    "pdf.drawString(55,340,'Control'); pdf.drawString(195,340,'1.2')",
    "pdf.drawString(55,310,'Treatment'); pdf.drawString(195,310,'2.4')",
    "pdf.save()",
  ].join("\n"), pdfPath]);
  const uploaded = await jsonRequest<PaperAcquisition>(
    `${origin}/api/sessions/${session.body.id}/papers/upload?title=Example%20paper`,
    {
      body: await readFile(pdfPath),
      headers: { ...authorization, "content-type": "application/pdf" },
      method: "POST",
    },
  );
  assert.equal(uploaded.response.status, 201);
  assert.equal(uploaded.body.connectorId, "upload");
  assert.equal(uploaded.body.extraction.pageCount, 1);
  assert.ok(uploaded.body.extraction.textCharacters > 20);
  assert.ok(uploaded.body.extraction.tables.length >= 1);
  assert.equal(uploaded.body.pdf.hash, uploaded.body.extraction.inputSha256);

  const listed = await jsonRequest<PaperAcquisition[]>(`${origin}/api/sessions/${session.body.id}/papers`, {
    headers: authorization,
  });
  assert.equal(listed.body.length, 1);
  const textPath = `${uploaded.body.manifestPath.replace(/manifest\.json$/, "")}${uploaded.body.extraction.textPath}`;
  const textResponse = await fetch(`${origin}/api/sessions/${session.body.id}/file?path=${encodeURIComponent(textPath)}`, {
    headers: authorization,
  });
  assert.equal(textResponse.status, 200);
  assert.match(await textResponse.text(), /Scientific result with embedded text/);

  let visionAuthorization = "";
  let visionPayload: { messages?: Array<{ content?: unknown[] }> } = {};
  const visionServer = createHttpServer(async (request, response) => {
    visionAuthorization = request.headers.authorization ?? "";
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    visionPayload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof visionPayload;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "The page contains a two-column experimental results table." } }] }));
  });
  await new Promise<void>((resolveListen) => visionServer.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => visionServer.close(() => resolveClose())));
  const visionOrigin = `http://127.0.0.1:${(visionServer.address() as AddressInfo).port}/v1`;
  const visionModel = await jsonRequest<ModelProfile>(`${origin}/api/models`, {
    body: JSON.stringify({ apiToken: "ephemeral-vision-token", baseUrl: visionOrigin, model: "vision-test", name: "Vision test", vision: true }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(visionModel.body.vision, true);
  const vision = await jsonRequest<PaperVisionRun>(
    `${origin}/api/sessions/${session.body.id}/papers/${uploaded.body.id}/vision`,
    {
      body: JSON.stringify({ modelId: visionModel.body.id }),
      headers: { ...authorization, "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(vision.response.status, 201);
  assert.equal(vision.body.inputPaths.length, 1);
  assert.equal(visionAuthorization, "Bearer ephemeral-vision-token");
  assert.equal(visionPayload.messages?.[0]?.content?.length, 2);
  const visionFile = await fetch(`${origin}/api/sessions/${session.body.id}/file?path=${encodeURIComponent(vision.body.resultPath)}`, {
    headers: authorization,
  });
  assert.match(await visionFile.text(), /two-column experimental results table/);
  assert.doesNotMatch(await readFile(resolve(tempRoot, "catalog.sqlite"), "utf8"), /ephemeral-vision-token/);
});

test("legacy Reviewer does not inject findings or block the main agent", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `review-loop-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const { origin } = await startTestApi(context, tempRoot);
  const model = await createTestModel(origin, {
    baseUrl: await startReviewerCorrectionModel(context),
    model: "review-correction",
    name: "Review correction model",
  });
  const project = await jsonRequest<Project>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Review loop" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const session = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ modelId: model.id, reviewMode: "auto", title: "Unsupported claim" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const response = await fetch(`${origin}/api/sessions/${session.body.id}/messages`, {
    body: JSON.stringify({ content: "Report the result." }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const stream = await response.text();
  assert.deepEqual(rootSseGolden(stream), [
    "run.started",
    "agent.phase",
    "assistant.delta",
    "run.completed",
  ]);
  const started = parseSseEvents(stream).find((event) => event.type === "run.started");
  assert.equal(typeof started?.runId, "string");
  assert.equal(parseSseEvents(stream).filter((event) => event.type === "run.started").length, 1);
  assert.doesNotMatch(stream, /COMPUTED_CLAIM_WITHOUT_EXECUTION|review\.completed/);
  assert.match(stream, /"type":"run.completed"/);
  const detail = await jsonRequest<SessionDetail>(`${origin}/api/sessions/${session.body.id}`, { headers: authorization });
  assert.deepEqual(detail.body.messages.map((message) => message.kind), ["message", "message"]);
  assert.equal((await fetch(`${origin}/api/sessions/${session.body.id}/reviews`, { headers: authorization })).status, 404);
});

test("API runs a configured OpenAI-compatible model through the gateway and Python", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `api-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const { origin } = await startTestApi(context, tempRoot);
  const toolModel = await startToolModel(context);
  const configuredModel = await createTestModel(origin, {
    apiToken: "ephemeral-test-token",
    baseUrl: toolModel.baseUrl,
    model: "test-tool-model",
    name: "Tool test model",
  });

  const health = await jsonRequest<{ runner: RunnerHealth; status: string }>(`${origin}/health`);
  assert.equal(health.response.status, 200);
  assert.equal(health.body.status, "ok");
  assert.equal(health.body.runner.seccompBaseline, "multiarch-v1-profile-aware");
  assert.equal(health.body.runner.noNewPrivileges, true);
  assert.equal(health.body.runner.executionAuth, "bearer+hmac-sha256");
  assert.equal(health.body.runner.workerConcurrency, null);
  assert.equal(health.body.runner.executionTimeoutMs, 60_000);

  const unauthorized = await fetch(`${origin}/api/projects`);
  assert.equal(unauthorized.status, 401);

  const projectResult = await jsonRequest<Project>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Analysis project" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(projectResult.response.status, 201);

  const sessionResult = await jsonRequest<Session>(
    `${origin}/api/projects/${projectResult.body.id}/sessions`,
    {
      body: JSON.stringify({ modelId: configuredModel.id, title: "CSV analysis" }),
      headers: { ...authorization, "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(sessionResult.response.status, 201);
  assert.equal(sessionResult.body.modelId, configuredModel.id);
  assert.ok(sessionResult.body.permissionEpochId);

  const originalEpoch = await jsonRequest<PermissionEpoch>(
    `${origin}/api/sessions/${sessionResult.body.id}/permission-epoch`,
    { headers: authorization },
  );
  assert.equal(originalEpoch.body.networkPolicy, "none");
  const rotatedEpoch = await jsonRequest<PermissionEpoch>(
    `${origin}/api/sessions/${sessionResult.body.id}/permission-epoch`,
    {
      body: JSON.stringify({ reason: "Test permission restart" }),
      headers: { ...authorization, "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.notEqual(rotatedEpoch.body.id, originalEpoch.body.id);
  assert.equal(rotatedEpoch.body.reason, "Test permission restart");

  const codePermission = await jsonRequest<{ allowed: false; request: { id: string } }>(
    `${origin}/api/sessions/${sessionResult.body.id}/permission-requests`,
    {
      body: JSON.stringify({ action: "code", resource: "workspace-code", summary: "Run code for the M0 analysis" }),
      headers: { ...authorization, "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(codePermission.body.allowed, false);
  const permissionDecision = await jsonRequest<{ permissionEpoch: PermissionEpoch }>(
    `${origin}/api/permission-requests/${codePermission.body.request.id}/decision`,
    {
      body: JSON.stringify({ decision: "allow_matching" }),
      headers: { ...authorization, "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(permissionDecision.body.permissionEpoch.executeGrantScope, "session");

  const fixture = "label,value\nalpha,1\nbeta,2\ngamma,3\n";
  const upload = await fetch(`${origin}/api/sessions/${sessionResult.body.id}/files`, {
    body: JSON.stringify({ content: fixture, path: "input.csv" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(upload.status, 201);

  const run = await fetch(`${origin}/api/sessions/${sessionResult.body.id}/messages`, {
    body: JSON.stringify({
      content: "Analyze the CSV and make a chart.",
    }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(run.status, 200);
  const stream = await run.text();
  const streamEvents = stream.split("\n\n").flatMap((frame) => {
    const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    return data ? [JSON.parse(data) as { type: string }] : [];
  });
  const eventTypes = streamEvents.map((event) => event.type);
  assert.match(stream, /"type":"run.started"/);
  assert.match(stream, new RegExp(`"id":"${configuredModel.id}"`));
  assert.ok(eventTypes.filter((type) => type === "agent.phase").length >= 2);
  assert.ok(eventTypes.filter((type) => type === "assistant.thinking.delta").length >= 2);
  assert.ok(eventTypes.indexOf("agent.phase") < eventTypes.indexOf("assistant.thinking.delta"));
  assert.ok(eventTypes.indexOf("assistant.thinking.delta") < eventTypes.indexOf("tool.started"));
  assert.ok(eventTypes.indexOf("tool.started") < eventTypes.indexOf("tool.completed"));
  assert.match(stream, /"type":"tool.started"/);
  assert.match(stream, /"name":"run_python"/);
  assert.match(stream, /"type":"assistant.delta"/);
  assert.doesNotMatch(stream, /"type":"review.completed"/);
  assert.match(stream, /"type":"run.completed"/);
  assert.deepEqual(toolModel.authorizations, [
    "Bearer ephemeral-test-token",
    "Bearer ephemeral-test-token",
    "Bearer ephemeral-test-token",
  ]);

  const filesResult = await jsonRequest<WorkspaceFile[]>(
    `${origin}/api/sessions/${sessionResult.body.id}/files`,
    { headers: authorization },
  );
  assert.deepEqual(
    filesResult.body.map((file) => file.path).toSorted(),
    ["a/out.csv", "analysis_chart.svg", "analysis_summary.csv", "b/out.csv", "input.csv"],
  );
  const runsResult = await jsonRequest<ExecutionRun[]>(
    `${origin}/api/sessions/${sessionResult.body.id}/execution-runs`,
    { headers: authorization },
  );
  assert.equal(runsResult.body.length, 1);
  const execution = runsResult.body[0]!;
  assert.equal(execution.status, "succeeded");
  assert.equal(execution.permissionEpochId, permissionDecision.body.permissionEpoch.id);
  assert.equal(execution.networkPolicy, "none");
  assert.equal(execution.cgroupMode, "none");
  assert.equal(execution.sandbox, "bubblewrap");
  assert.match(execution.code.hash, /^[a-f0-9]{64}$/);
  assert.match(execution.stdout.hash, /^[a-f0-9]{64}$/);
  assert.match(execution.stderr.hash, /^[a-f0-9]{64}$/);

  const derivationsResult = await jsonRequest<ArtifactDerivation[]>(
    `${origin}/api/sessions/${sessionResult.body.id}/artifact-derivations`,
    { headers: authorization },
  );
  assert.deepEqual(
    derivationsResult.body.map((item) => item.path).toSorted(),
    ["a/out.csv", "analysis_chart.svg", "analysis_summary.csv", "b/out.csv"],
  );
  assert.ok(derivationsResult.body.every((item) => item.executionRunIds[0] === execution.id));
  const artifactsResult = await jsonRequest<ScientificArtifact[]>(
    `${origin}/api/sessions/${sessionResult.body.id}/artifacts`,
    { headers: authorization },
  );
  assert.deepEqual(artifactsResult.body.map((artifact) => artifact.logicalName).toSorted(), ["a/out.csv", "analysis_chart.svg", "analysis_summary.csv", "b/out.csv", "input.csv"]);
  const sameBasenameArtifacts = artifactsResult.body.filter((artifact) => artifact.name.endsWith("/out.csv"));
  assert.deepEqual(sameBasenameArtifacts.map((artifact) => artifact.name).toSorted(), ["a/out.csv", "b/out.csv"]);
  assert.equal(new Set(sameBasenameArtifacts.map((artifact) => artifact.id)).size, 2);
  const chart = artifactsResult.body.find((artifact) => artifact.logicalName === "analysis_chart.svg")!;
  assert.equal(chart.kind, "figure");
  const chartVersions = await jsonRequest<ScientificArtifactVersion[]>(
    `${origin}/api/sessions/${sessionResult.body.id}/artifacts/${chart.id}/versions`,
    { headers: authorization },
  );
  assert.deepEqual(chartVersions.body.map((version) => version.version), [1]);
  assert.equal(chartVersions.body[0]?.inputArtifactVersionIds.length, 1);
  const chartContent = await fetch(
    `${origin}/api/sessions/${sessionResult.body.id}/artifact-versions/${chartVersions.body[0]!.id}/content`,
    { headers: authorization },
  );
  assert.equal(chartContent.headers.get("content-type"), "image/svg+xml");
  assert.match(await chartContent.text(), /3 rows analyzed/);
  const chartProvenance = await jsonRequest<ArtifactVersionProvenance>(
    `${origin}/api/sessions/${sessionResult.body.id}/artifact-versions/${chartVersions.body[0]!.id}/provenance`,
    { headers: authorization },
  );
  assert.equal(chartProvenance.body.code.length, 1);
  assert.equal(chartProvenance.body.executionLog.length, 1);
  assert.equal(chartProvenance.body.executionLog[0]?.workingDirectory, execution.workingDirectory);
  assert.deepEqual(chartProvenance.body.executionLog[0]?.envSnapshot, execution.envSnapshot);
  assert.ok(chartProvenance.body.executionLog[0]?.processEnvironment);
  const environmentObject = await fetch(
    `${origin}/api/cas/${chartProvenance.body.executionLog[0]!.envSnapshot!.hash}`,
    { headers: authorization },
  );
  assert.equal(environmentObject.status, 200);
  assert.deepEqual(chartProvenance.body.executionLog[0]?.processEnvironment, await environmentObject.json());
  assert.equal(chartProvenance.body.environments.length, 1);
  assert.equal(chartProvenance.body.messages.at(-1)?.content, "Analyze the CSV and make a chart.");
  assert.equal(chartProvenance.body.review.length, 0);
  assert.equal(chartProvenance.body.dependencies[0]?.artifact.logicalName, "input.csv");
  const codeObject = await fetch(`${origin}/api/cas/${execution.code.hash}`, { headers: authorization });
  assert.equal(codeObject.status, 200);
  assert.match(await codeObject.text(), /analysis_summary\.csv/);

  const manifestsResult = await jsonRequest<PromptManifest[]>(
    `${origin}/api/sessions/${sessionResult.body.id}/prompt-manifests`,
    { headers: authorization },
  );
  assert.equal(manifestsResult.body.length, 1);
  assert.equal(manifestsResult.body[0]?.status, "succeeded");
  assert.equal(manifestsResult.body[0]?.modelProfileId, configuredModel.id);
  assert.equal(manifestsResult.body[0]?.inputs.at(-1)?.role, "user");
  assert.ok(manifestsResult.body[0]?.response);

  const completedSession = await jsonRequest<SessionDetail>(
    `${origin}/api/sessions/${sessionResult.body.id}`,
    { headers: authorization },
  );
  const assistantMessage = completedSession.body.messages.find((message) => message.role === "assistant");
  assert.equal(assistantMessage?.modelId, configuredModel.id);
  assert.equal(assistantMessage?.modelName, "Tool test model");
  assert.doesNotMatch(await readFile(resolve(tempRoot, "catalog.sqlite"), "utf8"), /ephemeral-test-token/);
});

test("API runs one observable subagent through task and keeps nested task denied", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `api-subagent-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const subagentCatalog = ({
    loadedAt: new Date().toISOString(),
    revision: "arxiv-subagent-catalog",
    servers: [{
      enabled: true,
      id: "biomed",
      tools: [{
        description: "prepare",
        inputSchema: {
          additionalProperties: false,
          properties: {
            identifier: {
              maxLength: 80,
              minLength: 1,
              pattern: "^(?:\\d{4}\\.\\d{4,5}|[A-Za-z.-]+/\\d{7})(?:v\\d+)?$",
              type: "string",
            },
          },
          required: ["identifier"],
          type: "object",
        },
        name: "arxiv_prepare_paper_download",
        schemaHash: "prepare",
      }, {
        description: "search",
        inputSchema: {
          additionalProperties: false,
          properties: {
            limit: { default: 5, maximum: 25, minimum: 1, type: "integer" },
            query: { maxLength: 500, minLength: 1, type: "string" },
          },
          required: ["query"],
          type: "object",
        },
        name: "arxiv_search",
        schemaHash: "search",
      }],
      transport: "stdio",
    }],
  }) as unknown as McpCatalog;
  const mcpTransport: McpTransportClient = {
    catalog: async () => subagentCatalog,
    invoke: async () => { throw new Error("subagent flow does not invoke MCP"); },
    reload: async () => subagentCatalog,
  };
  const { origin } = await startTestApi(context, tempRoot, mcpTransport);
  const fixture = await startSubagentModel(context, { subagentType: "code-engineer" });
  const model = await createTestModel(origin, {
    baseUrl: fixture.baseUrl,
    model: "subagent-test-model",
    name: "Subagent test model",
  });
  const specialist = await jsonRequest<Specialist>(`${origin}/api/specialists`, {
    body: JSON.stringify({
      connectorIds: ["arxiv"],
      description: "Reviews structural biology evidence and limitations.",
      enabledSkillIds: ["structure-pocket-inspection"],
      instructions: "Inspect structural evidence and state any limitations.",
      name: "Structure reviewer",
    }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  fixture.setSpecialistId(specialist.body.id);
  const project = await jsonRequest<Project>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Subagent project" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const session = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ approvalMode: "always_allow", modelId: model.id, title: "Subagent session" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const arxivStatus = await jsonRequest<{ availableTools: string[]; status: string }>(
    `${origin}/api/mcp/sources/arxiv/status`,
    { headers: authorization },
  );
  assert.equal(arxivStatus.body.status, "ready");
  assert.deepEqual(arxivStatus.body.availableTools.toSorted(), ["prepare_paper_download", "search"]);

  const run = await fetch(`${origin}/api/sessions/${session.body.id}/messages`, {
    body: JSON.stringify({ content: "Delegate workspace inspection." }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(run.status, 200);
  const stream = await run.text();
  assert.deepEqual(rootSseGolden(stream), [
    "run.started",
    "agent.phase",
    "tool.started",
    "tool.output",
    "tool.completed",
    "agent.phase",
    "assistant.delta",
    "run.completed",
  ]);
  assert.deepEqual(subagentSseGoldens(stream), [[
    "subagent.updated",
    "subagent.updated",
    "subagent.step",
    "subagent.step",
    "subagent.step",
    "subagent.usage",
    "subagent.updated",
  ]]);
  const eventTypes = stream.split("\n\n").flatMap((frame) => {
    const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    return data ? [(JSON.parse(data) as { type: string }).type] : [];
  });
  assert.ok(eventTypes.filter((type) => type === "subagent.updated").length >= 2);
  assert.ok(eventTypes.includes("subagent.step"));
  assert.ok(eventTypes.includes("subagent.usage"));
  assert.match(stream, /The subagent completed the delegated analysis/);
  const parentExecutionId = parseSseEvents(stream)
    .find((event) => event.type === "run.started")?.runId;
  assert.equal(typeof parentExecutionId, "string");

  const subagents = await jsonRequest<Subagent[]>(
    `${origin}/api/sessions/${session.body.id}/subagents`,
    { headers: authorization },
  );
  assert.equal(subagents.response.status, 200);
  assert.equal(subagents.body.length, 1);
  assert.equal(subagents.body[0]?.input.description, "Inspect workspace");
  assert.equal(subagents.body[0]?.input.subagentType, "code-engineer");
  assert.equal(subagents.body[0]?.parentTurnId, parentExecutionId);
  assert.equal(subagents.body[0]?.status, "completed");
  assert.equal(subagents.body[0]?.maxTurns, DEFAULT_SUBAGENT_MAX_TURNS);
  assert.equal(subagents.body[0]?.timeoutSeconds, DEFAULT_SUBAGENT_TIMEOUT_SECONDS);
  assert.equal(subagents.body[0]?.model?.name, "Subagent test model");
  assert.equal(subagents.body[0]?.specialistId, specialist.body.id);
  assert.equal(subagents.body[0]?.handoff?.privateWorkspacePath, `subagents/${subagents.body[0]?.id}`);
  assert.equal(subagents.body[0]?.handoff?.manifestPath, `subagents/${subagents.body[0]?.id}/handoff.json`);
  const assistantSteps = subagents.body[0]?.steps.filter((step) => step.kind === "assistant") ?? [];
  assert.equal(assistantSteps.length, 1);
  assert.equal(assistantSteps[0]?.content, "Subagent inspected the workspace and returned a concise result.");
  assert.deepEqual(subagents.body[0]?.usage, {
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inputTokens: 20,
    outputTokens: 5,
    totalTokens: 25,
  });

  const subagentRequest = fixture.requests.find((request) =>
    request.messages?.some((message) => message.role === "system"
      && message.content?.includes("Applied subagent preset general-purpose")));
  assert.ok(subagentRequest);
  const leadRequest = fixture.requests.find((request) =>
    request.tools?.some((tool) => tool.function?.name === "task"));
  assert.ok(leadRequest);
  const leadSystemPrompt = leadRequest.messages?.find((message) => message.role === "system")?.content ?? "";
  assert.match(leadSystemPrompt, /<subagent_system>/);
  assert.match(leadSystemPrompt, /SUBAGENT MODE ACTIVE - DECOMPOSE, DELEGATE, SYNTHESIZE/);
  assert.match(leadSystemPrompt, /Maximum 10 task calls in a single model response/);
  assert.match(leadSystemPrompt, /Maximum 50 task calls for the current user request\/run/);
  assert.doesNotMatch(leadSystemPrompt, /If a selected skill defines a required subagent workflow/);
  assert.doesNotMatch(leadSystemPrompt, /Applied subagent preset general-purpose/);
  const subagentToolNames = subagentRequest.tools?.flatMap((tool) =>
    tool.function?.name ? [tool.function.name] : []) ?? [];
  assert.ok(subagentToolNames.includes("read_file"), JSON.stringify(subagentToolNames));
  assert.ok(subagentToolNames.includes("tool_search"), JSON.stringify(subagentToolNames));
  assert.equal(subagentToolNames.some((name) => name.startsWith("mcp__")), false);
  assert.equal(subagentToolNames.includes("invoke_connector"), false);
  assert.equal(subagentRequest.tools?.some((tool) => tool.function?.name === "task"), false);
  assert.equal(subagentRequest.tools?.some((tool) => tool.function?.name === "propose_plan"), false);
  assert.equal(subagentRequest.tools?.some((tool) => tool.function?.name === "propose_remote_job"), false);
  const subagentSystemPrompt = subagentRequest.messages?.find((message) => message.role === "system")?.content ?? "";
  assert.doesNotMatch(subagentSystemPrompt, /<subagent_system>/);
  assert.doesNotMatch(subagentSystemPrompt, /SUBAGENT MODE ACTIVE/);
  assert.match(subagentSystemPrompt, /Applied user specialist Structure reviewer/);
  assert.match(subagentSystemPrompt, /Inspect structural evidence and state any limitations/);
  assert.match(subagentSystemPrompt, /<name>code-engineer<\/name>/);
  assert.match(subagentSystemPrompt, /<name>structure-pocket-inspection<\/name>/);
  assert.doesNotMatch(subagentSystemPrompt, /# Code Engineer/);
  assert.doesNotMatch(subagentSystemPrompt, /Plan governance mode/);
  const subagentUserPrompt = subagentRequest.messages?.find((message) => message.role === "user")?.content ?? "";
  assert.match(subagentUserPrompt, new RegExp(`Private workspace root: subagents/${subagents.body[0]?.id}`));
  assert.match(subagentUserPrompt, /Handoff manifest visible inside your workspace: handoff\.json/);
  assert.ok(fixture.requests.some((request) => request.tools?.some((tool) => tool.function?.name === "task")));
  assert.ok(fixture.requests.some((request) => request.tools?.some((tool) => tool.function?.name === "propose_plan")));

  const parentResultRequest = fixture.requests.find((request) =>
    request.messages?.some((message) => message.role === "tool"));
  const taskResultContent = parentResultRequest?.messages?.find((message) => message.role === "tool")?.content ?? "";
  const taskResult = JSON.parse(taskResultContent) as Record<string, unknown>;
  assert.equal(taskResult.id, subagents.body[0]?.id);
  assert.equal(taskResult.status, "completed");
  assert.equal(taskResult.turnCount, 1);
  assert.equal(taskResult.finalText, "Subagent inspected the workspace and returned a concise result.");
  assert.deepEqual(taskResult.usage, {
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inputTokens: 20,
    outputTokens: 5,
    totalTokens: 25,
  });
  assert.doesNotMatch(taskResultContent, /Inspect workspace partition/);
  assert.doesNotMatch(taskResultContent, /"steps"|"prompt"/);
});

test("API does not auto-select a specialist by description for a subagent type", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `api-subagent-specialist-no-match-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const { origin } = await startTestApi(context, tempRoot);
  const fixture = await startSubagentModel(context, { subagentType: "code-engineer" });
  const model = await createTestModel(origin, {
    baseUrl: fixture.baseUrl,
    model: "subagent-specialist-no-match-model",
    name: "Subagent specialist no-match model",
  });
  const specialist = await jsonRequest<Specialist>(`${origin}/api/specialists`, {
    body: JSON.stringify({
      description: "code-engineer",
      instructions: "Implement code changes and report verification.",
      name: "Code implementer",
    }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const project = await jsonRequest<Project>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Subagent specialist no-match project" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const session = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ approvalMode: "always_allow", modelId: model.id, title: "Subagent specialist no-match session" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });

  const run = await fetch(`${origin}/api/sessions/${session.body.id}/messages`, {
    body: JSON.stringify({ content: "Delegate code engineering work." }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(run.status, 200);
  const stream = await run.text();
  assert.match(stream, /The subagent completed the delegated analysis/);

  const subagents = await jsonRequest<Subagent[]>(
    `${origin}/api/sessions/${session.body.id}/subagents`,
    { headers: authorization },
  );
  assert.equal(subagents.response.status, 200);
  assert.equal(subagents.body.length, 1);
  assert.equal(subagents.body[0]?.input.subagentType, "code-engineer");
  assert.equal(subagents.body[0]?.input.specialistId, undefined);
  assert.equal(subagents.body[0]?.specialistId, undefined);

  const subagentRequest = fixture.requests.find((request) =>
    request.messages?.some((message) => message.role === "system"
      && message.content?.includes("Applied user specialist Code implementer")));
  assert.equal(subagentRequest, undefined);
  assert.equal(specialist.response.status, 201);
});

test("API validates subagent Brief v1 structured output before summarizing task result", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `api-subagent-brief-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const { origin } = await startTestApi(context, tempRoot);
  const fixture = await startSubagentModel(context, { structuredSubagentResult: true });
  const model = await createTestModel(origin, {
    baseUrl: fixture.baseUrl,
    model: "subagent-brief-model",
    name: "Subagent Brief model",
  });
  const project = await jsonRequest<Project>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Subagent Brief project" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const session = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ approvalMode: "always_allow", modelId: model.id, title: "Subagent Brief session" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });

  const run = await fetch(`${origin}/api/sessions/${session.body.id}/messages`, {
    body: JSON.stringify({ content: "Delegate structured workspace inspection." }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(run.status, 200);
  const stream = await run.text();
  const subagents = await jsonRequest<Subagent[]>(
    `${origin}/api/sessions/${session.body.id}/subagents`,
    { headers: authorization },
  );
  assert.equal(subagents.body[0]?.input.brief?.goal, "Inspect workspace and return structured evidence");
  assert.equal(subagents.body[0]?.handoff?.privateWorkspacePath, `subagents/${subagents.body[0]?.id}`);
  assert.equal(subagents.body[0]?.resultValidation?.status, "passed");
  assert.deepEqual(subagents.body[0]?.structuredResult, { confidence: "high", summary: "Structured inspection" });

  const parentResultRequest = fixture.requests.find((request) =>
    request.messages?.some((message) => message.role === "tool"));
  const taskResultContent = parentResultRequest?.messages?.find((message) => message.role === "tool")?.content ?? "";
  const taskResult = JSON.parse(taskResultContent) as Record<string, unknown>;
  assert.equal(taskResult.status, "completed");
  assert.deepEqual(taskResult.resultValidation, subagents.body[0]?.resultValidation);
  assert.deepEqual(taskResult.structuredResult, { confidence: "high", summary: "Structured inspection" });
  assert.match(stream, /The subagent completed the delegated analysis/);
  assert.doesNotMatch(taskResultContent, /Inspect workspace partition/);
});

test("subagent handoff skips oversized parent files instead of failing the run setup", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `api-subagent-handoff-limits-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const store = new SessionStore(tempRoot);
  store.setAvailableSkillIds([]);
  await store.load();
  const model = await store.createModel({ apiToken: "test", baseUrl: "https://models.example.test/v1", model: "test", name: "Test" });
  const project = await store.createProject("Subagent handoff limits");
  const session = await store.createSession(project.id, "Subagent handoff", { modelId: model.id });
  const workspaceRoot = store.workspacePath(session.id);
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(resolve(workspaceRoot, "small.csv"), "value\n1\n");
  await writeFile(resolve(workspaceRoot, "large.csv"), Buffer.alloc(10_000_001, "x"));

  const handoff = await prepareSubagentHandoff(store, session.id, "subagent-limit-test", {
    description: "Inspect declared inputs",
    inputPaths: ["small.csv", "large.csv"],
    prompt: "Use the declared inputs.",
  });

  assert.deepEqual(handoff.inputPaths, ["inputs/small.csv"]);
  assert.equal(handoff.skippedInputPaths?.[0]?.path, "large.csv");
  assert.match(handoff.skippedInputPaths?.[0]?.reason ?? "", /single file size limit/);
  assert.equal((await readFile(resolve(workspaceRoot, "subagents/subagent-limit-test/inputs/small.csv"), "utf8")), "value\n1\n");
  const manifest = JSON.parse(await readFile(resolve(workspaceRoot, handoff.manifestPath), "utf8")) as NonNullable<Subagent["handoff"]>;
  assert.equal(manifest.skippedInputPaths?.[0]?.path, "large.csv");
});

test("subagent handoff copies only declared or referenced parent files", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `api-subagent-handoff-selective-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const store = new SessionStore(tempRoot);
  store.setAvailableSkillIds([]);
  await store.load();
  const model = await store.createModel({ apiToken: "test", baseUrl: "https://models.example.test/v1", model: "test", name: "Test" });
  const project = await store.createProject("Subagent handoff selective");
  const session = await store.createSession(project.id, "Subagent handoff", { modelId: model.id });
  const workspaceRoot = store.workspacePath(session.id);
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(resolve(workspaceRoot, "needed.csv"), "value\n1\n");
  await writeFile(resolve(workspaceRoot, "notneeded.csv"), "value\n3\n");
  await writeFile(resolve(workspaceRoot, "unmentioned.csv"), "value\n2\n");

  const handoff = await prepareSubagentHandoff(store, session.id, "subagent-selective-test", {
    description: "Inspect needed.csv",
    prompt: "Read needed.csv and summarize it.",
  });

  assert.deepEqual(handoff.inputPaths, ["inputs/needed.csv"]);
  assert.equal((await readFile(resolve(workspaceRoot, "subagents/subagent-selective-test/needed.csv"), "utf8")), "value\n1\n");
  await assert.rejects(readFile(resolve(workspaceRoot, "subagents/subagent-selective-test/inputs/notneeded.csv")));
  await assert.rejects(readFile(resolve(workspaceRoot, "subagents/subagent-selective-test/inputs/unmentioned.csv")));
  const manifest = JSON.parse(await readFile(resolve(workspaceRoot, handoff.manifestPath), "utf8")) as {
    availableParentInputPaths?: string[];
    parentInputPaths?: string[];
  };
  assert.deepEqual(manifest.parentInputPaths, ["needed.csv"]);
  assert.equal(manifest.availableParentInputPaths, undefined);
});

test("subagent handoff does not implicitly copy the only parent file", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `api-subagent-handoff-no-default-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const store = new SessionStore(tempRoot);
  store.setAvailableSkillIds([]);
  await store.load();
  const model = await store.createModel({ apiToken: "test", baseUrl: "https://models.example.test/v1", model: "test", name: "Test" });
  const project = await store.createProject("Subagent handoff no default");
  const session = await store.createSession(project.id, "Subagent handoff", { modelId: model.id });
  const workspaceRoot = store.workspacePath(session.id);
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(resolve(workspaceRoot, "mmc5.csv"), "time,status\n1,0\n");

  const handoff = await prepareSubagentHandoff(store, session.id, "subagent-no-default-test", {
    description: "Analyze the provided CSV.",
    prompt: "Run the requested analysis.",
  });

  assert.deepEqual(handoff.inputPaths, []);
  await assert.rejects(readFile(resolve(workspaceRoot, "subagents/subagent-no-default-test/inputs/mmc5.csv")));
  await assert.rejects(readFile(resolve(workspaceRoot, "subagents/subagent-no-default-test/mmc5.csv")));
  const manifest = JSON.parse(await readFile(resolve(workspaceRoot, handoff.manifestPath), "utf8")) as {
    parentInputPaths?: string[];
  };
  assert.deepEqual(manifest.parentInputPaths, []);
});

test("subagent handoff preserves copied input snapshots for audit", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `api-subagent-handoff-audit-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const store = new SessionStore(tempRoot);
  store.setAvailableSkillIds([]);
  await store.load();
  const model = await store.createModel({ apiToken: "test", baseUrl: "https://models.example.test/v1", model: "test", name: "Test" });
  const project = await store.createProject("Subagent handoff audit");
  const session = await store.createSession(project.id, "Subagent handoff", { modelId: model.id });
  const workspaceRoot = store.workspacePath(session.id);
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(resolve(workspaceRoot, "needed.csv"), "value\n1\n");

  const handoff = await prepareSubagentHandoff(store, session.id, "subagent-cleanup-test", {
    description: "Inspect declared input",
    inputPaths: ["needed.csv"],
    prompt: "Use the declared input.",
  });
  assert.equal((await readFile(resolve(workspaceRoot, "subagents/subagent-cleanup-test/inputs/needed.csv"), "utf8")), "value\n1\n");
  assert.equal((await readFile(resolve(workspaceRoot, "subagents/subagent-cleanup-test/needed.csv"), "utf8")), "value\n1\n");
  assert.ok(JSON.parse(await readFile(resolve(workspaceRoot, handoff.manifestPath), "utf8")));
});

test("API fails subagents when structured output fails schema validation", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `api-subagent-brief-invalid-schema-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const { origin } = await startTestApi(context, tempRoot);
  const fixture = await startSubagentModel(context, {
    structuredSubagentOutput: "{\"summary\":\"Structured inspection\"}",
    structuredSubagentResult: true,
  });
  const model = await createTestModel(origin, {
    baseUrl: fixture.baseUrl,
    model: "subagent-brief-invalid-schema-model",
    name: "Subagent Brief invalid schema model",
  });
  const project = await jsonRequest<Project>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Subagent Brief invalid schema project" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const session = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ approvalMode: "always_allow", modelId: model.id, title: "Subagent Brief invalid schema session" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });

  const run = await fetch(`${origin}/api/sessions/${session.body.id}/messages`, {
    body: JSON.stringify({ content: "Delegate structured workspace inspection." }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(run.status, 200);
  await run.text();
  const subagents = await jsonRequest<Subagent[]>(
    `${origin}/api/sessions/${session.body.id}/subagents`,
    { headers: authorization },
  );
  assert.equal(subagents.body[0]?.status, "failed");
  assert.equal(subagents.body[0]?.resultValidation?.status, "failed");
  assert.match(subagents.body[0]?.error ?? "", /result validation failed/);
  assert.equal(subagents.body[0]?.structuredResult, undefined);
  assert.equal(subagents.body[0]?.rawStructuredResult, "{\"summary\":\"Structured inspection\"}");

  const parentResultRequest = fixture.requests.find((request) =>
    request.messages?.some((message) => message.role === "tool"));
  const taskResultContent = parentResultRequest?.messages?.find((message) => message.role === "tool")?.content ?? "";
  const taskResult = JSON.parse(taskResultContent) as Record<string, unknown>;
  assert.equal(taskResult.status, "failed");
  assert.equal(taskResult.structuredResult, undefined);
  assert.equal(taskResult.rawStructuredResult, "{\"summary\":\"Structured inspection\"}");
  assert.equal((taskResult.resultValidation as { status?: string } | undefined)?.status, "failed");
});

test("API preserves raw subagent structured output when final JSON parsing fails", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `api-subagent-brief-raw-output-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const { origin } = await startTestApi(context, tempRoot);
  const fixture = await startSubagentModel(context, {
    structuredSubagentOutput: "analysis complete but no final json",
    structuredSubagentResult: true,
  });
  const model = await createTestModel(origin, {
    baseUrl: fixture.baseUrl,
    model: "subagent-brief-raw-output-model",
    name: "Subagent Brief raw output model",
  });
  const project = await jsonRequest<Project>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Subagent Brief raw output project" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const session = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ approvalMode: "always_allow", modelId: model.id, title: "Subagent Brief raw output session" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });

  const run = await fetch(`${origin}/api/sessions/${session.body.id}/messages`, {
    body: JSON.stringify({ content: "Delegate structured workspace inspection." }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(run.status, 200);
  await run.text();
  const subagents = await jsonRequest<Subagent[]>(
    `${origin}/api/sessions/${session.body.id}/subagents`,
    { headers: authorization },
  );
  assert.equal(subagents.body[0]?.status, "failed");
  assert.equal(subagents.body[0]?.resultValidation?.status, "failed");
  assert.equal(subagents.body[0]?.rawStructuredResult, "analysis complete but no final json");

  const parentResultRequest = fixture.requests.find((request) =>
    request.messages?.some((message) => message.role === "tool"));
  const taskResultContent = parentResultRequest?.messages?.find((message) => message.role === "tool")?.content ?? "";
  const taskResult = JSON.parse(taskResultContent) as Record<string, unknown>;
  assert.equal(taskResult.status, "failed");
  assert.equal(taskResult.rawStructuredResult, "analysis complete but no final json");
});

test("API PATCH endpoint updates a non-running subagent brief and rejects running updates", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `api-subagent-brief-patch-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const { origin } = await startTestApi(context, tempRoot);
  const fixture = await startSubagentModel(context, { pauseSubagent: true });
  const model = await createTestModel(origin, {
    baseUrl: fixture.baseUrl,
    model: "subagent-brief-patch-model",
    name: "Subagent brief patch model",
  });
  const project = await jsonRequest<Project>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Subagent brief patch project" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const session = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ approvalMode: "always_allow", modelId: model.id, title: "Subagent brief patch session" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });

  // Start a run; the subagent pauses while running so we can probe PATCH 409.
  const run = await fetch(`${origin}/api/sessions/${session.body.id}/messages`, {
    body: JSON.stringify({ content: "Delegate a paused workspace inspection." }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(run.status, 200);
  await fixture.subagentStarted;

  let running: Subagent | undefined;
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const current = await jsonRequest<Subagent[]>(
      `${origin}/api/sessions/${session.body.id}/subagents`,
      { headers: authorization },
    );
    running = current.body.find((subagent) => subagent.status === "running");
    if (running) break;
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 25));
  }
  assert.ok(running, "expected a running subagent before completion");

  const conflict = await fetch(`${origin}/api/sessions/${session.body.id}/subagents/${running!.id}/brief`, {
    body: JSON.stringify({
      brief: {
        collaborationRules: ["Work independently"],
        constraints: ["Use only provided inputs"],
        goal: "Revised goal while running",
        outputRequirements: ["Return findings"],
      },
    }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "PATCH",
  });
  assert.equal(conflict.status, 409);
  assert.match(await conflict.text(), /is running/);

  fixture.releaseSubagent();
  await run.text();
  const completed = await jsonRequest<Subagent[]>(
    `${origin}/api/sessions/${session.body.id}/subagents`,
    { headers: authorization },
  );
  const target = completed.body.find((subagent) => subagent.id === running!.id);
  assert.ok(target, "expected the subagent to persist after completion");
  assert.equal(target!.status, "completed");

  // After completion, PATCH succeeds and the server forces version to auto-increment
  // from 0 (no prior brief) to 1, ignoring the client-supplied version.
  const patched = await jsonRequest<Subagent>(
    `${origin}/api/sessions/${session.body.id}/subagents/${target!.id}/brief`,
    {
      body: JSON.stringify({
        brief: {
          collaborationRules: ["Work independently", "Surface limitations"],
          constraints: ["Use only provided inputs", "Cite file paths"],
          goal: "Revised workspace inspection",
          outputJsonSchema: {
            additionalProperties: false,
            properties: { summary: { type: "string" } },
            required: ["summary"],
            type: "object",
          },
          outputRequirements: ["Return a summary field"],
          version: 99,
        },
      }),
      headers: { ...authorization, "content-type": "application/json" },
      method: "PATCH",
    },
  );
  assert.equal(patched.response.status, 200);
  assert.equal(patched.body.input.brief?.version, 1);
  assert.equal(patched.body.input.brief?.goal, "Revised workspace inspection");
  assert.deepEqual(patched.body.input.brief?.constraints, ["Use only provided inputs", "Cite file paths"]);
  assert.ok(patched.body.steps.some((step) => step.kind === "system" && /Brief updated to v1/.test(step.content)));

  // A second PATCH increments again to v2, proving the version chain is tracked server-side.
  const repatched = await jsonRequest<Subagent>(
    `${origin}/api/sessions/${session.body.id}/subagents/${target!.id}/brief`,
    {
      body: JSON.stringify({
        brief: {
          collaborationRules: ["Work independently"],
          constraints: ["Use only provided inputs"],
          goal: "Further revised inspection",
          outputRequirements: ["Return findings"],
        },
      }),
      headers: { ...authorization, "content-type": "application/json" },
      method: "PATCH",
    },
  );
  assert.equal(repatched.response.status, 200);
  assert.equal(repatched.body.input.brief?.version, 2);
  assert.equal(repatched.body.input.brief?.goal, "Further revised inspection");
  assert.ok(repatched.body.steps.some((step) => step.kind === "system" && /Brief updated to v2/.test(step.content)));

  const reloaded = await jsonRequest<Subagent[]>(
    `${origin}/api/sessions/${session.body.id}/subagents`,
    { headers: authorization },
  );
  assert.equal(reloaded.body.find((subagent) => subagent.id === target!.id)?.input.brief?.version, 2);

  // Unknown subagent id returns 404.
  const missing = await fetch(`${origin}/api/sessions/${session.body.id}/subagents/missing-id/brief`, {
    body: JSON.stringify({
      brief: {
        collaborationRules: ["x"],
        constraints: ["x"],
        goal: "x",
        outputRequirements: ["x"],
      },
    }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "PATCH",
  });
  assert.equal(missing.status, 404);

  // Invalid brief (empty goal) returns 400.
  const invalid = await fetch(`${origin}/api/sessions/${session.body.id}/subagents/${target!.id}/brief`, {
    body: JSON.stringify({
      brief: {
        collaborationRules: ["x"],
        constraints: ["x"],
        goal: "   ",
        outputRequirements: ["x"],
      },
    }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "PATCH",
  });
  assert.equal(invalid.status, 400);
});

test("manual subagent permission requests use the outer SSE sink and refresh the shared epoch", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `api-subagent-permission-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const { origin } = await startTestApi(context, tempRoot);
  const fixture = await startSubagentModel(context, { subagentUsesPython: true });
  const model = await createTestModel(origin, {
    baseUrl: fixture.baseUrl,
    model: "subagent-permission-model",
    name: "Subagent permission model",
  });
  const project = await jsonRequest<Project>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Subagent permission project" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const session = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ approvalMode: "ask_for_dangerous", modelId: model.id, title: "Subagent permission session" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });

  const run = await fetch(`${origin}/api/sessions/${session.body.id}/messages`, {
    body: JSON.stringify({ content: "Delegate a Python permission check." }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(run.status, 200);
  assert.ok(run.body);
  const reader = run.body.getReader();
  const decoder = new TextDecoder();
  let stream = "";
  let permissionRequestId: string | undefined;
  while (!permissionRequestId) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false, "run ended before the subagent permission request");
    stream += decoder.decode(chunk.value, { stream: true });
    const completed = stream.slice(0, Math.max(0, stream.lastIndexOf("\n\n") + 2));
    const required = parseSseEvents(completed).find((event) => event.type === "permission.required");
    permissionRequestId = (required?.request as { id?: string } | undefined)?.id;
  }
  const decision = await jsonRequest<{ permissionEpoch: PermissionEpoch }>(
    `${origin}/api/permission-requests/${permissionRequestId}/decision`,
    {
      body: JSON.stringify({ decision: "allow_matching" }),
      headers: { ...authorization, "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(decision.response.status, 200);
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    stream += decoder.decode(chunk.value, { stream: true });
  }
  stream += decoder.decode();

  assert.equal(parseSseEvents(stream).filter((event) => event.type === "permission.required").length, 1);
  assert.equal(parseSseEvents(stream).filter((event) => event.type === "permission.resolved").length, 1);
  assert.match(stream, /"type":"subagent.updated"/);
  assert.match(stream, /"type":"run.completed"/);
  const runId = (parseSseEvents(stream).find((event) => event.type === "run.started")?.runId as string | undefined);
  assert.ok(runId);
  const replay = await listRunEvents(origin, session.body.id, runId);
  assert.ok(replay.some((record) => record.event.type === "permission.required"));
  assert.ok(replay.some((record) =>
    record.event.type === "permission.resolved" && record.event.request.state === "allowed"));
  assert.ok(replay.some((record) =>
    record.event.type === "assistant.delta" || record.event.type === "assistant.thinking.delta"
    || record.event.type === "assistant.snapshot" || record.event.type === "assistant.thinking.snapshot"));
  const executions = await jsonRequest<ExecutionRun[]>(
    `${origin}/api/sessions/${session.body.id}/execution-runs`,
    { headers: authorization },
  );
  assert.equal(executions.body.length, 1);
  assert.equal(executions.body[0]?.permissionEpochId, decision.body.permissionEpoch.id);
});

test("concurrent permission decisions serialize and return an authoritative conflict", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `api-permission-conflict-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const { origin } = await startTestApi(context, tempRoot);
  const created = await jsonRequest<CreateProjectResponse>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Permission conflict" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const createPermission = async (summary: string) => jsonRequest<{
    allowed: boolean;
    request?: PermissionRequest;
  }>(`${origin}/api/sessions/${created.body.firstSession.id}/permission-requests`, {
    body: JSON.stringify({ action: "code", resource: "workspace-code", summary }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const first = await createPermission("Run Python");
  const second = await createPermission("Run shell");
  assert.equal(first.response.status, 201);
  assert.equal(second.response.status, 201);
  assert.ok(first.body.request && second.body.request);

  const decide = (requestId: string) => fetch(`${origin}/api/permission-requests/${requestId}/decision`, {
    body: JSON.stringify({ decision: "allow_matching" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const responses = await Promise.all([decide(first.body.request.id), decide(second.body.request.id)]);
  assert.deepEqual(responses.map((response) => response.status).toSorted(), [200, 409]);
  const bodies = await Promise.all(responses.map(async (response) => ({
    body: await response.json() as ApiError | PermissionDecisionResult,
    status: response.status,
  })));
  const success = bodies.find((item) => item.status === 200)?.body as PermissionDecisionResult | undefined;
  const conflict = bodies.find((item) => item.status === 409)?.body as ApiError | undefined;
  assert.equal(success?.resolvedRequests.length, 2, "allow-matching resolves both pending requests exactly once");
  assert.equal(conflict?.code, "PERMISSION_ALREADY_RESOLVED");
  assert.equal((conflict?.details?.request as PermissionRequest | undefined)?.state, "allowed");

  const grants = await jsonRequest<PermissionGrant[]>(`${origin}/api/permission-grants`, { headers: authorization });
  assert.equal(grants.body.length, 1, "the stale second click does not create another standing grant");
  const requests = await jsonRequest<PermissionRequest[]>(
    `${origin}/api/permission-requests?sessionId=${created.body.firstSession.id}`,
    { headers: authorization },
  );
  assert.deepEqual(requests.body.map((request) => request.state), ["allowed", "allowed"]);
});

test("switching an active run to always-allow resolves its pending subagent action", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `api-active-always-allow-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const { origin } = await startTestApi(context, tempRoot);
  const fixture = await startSubagentModel(context, { subagentUsesPython: true });
  const model = await createTestModel(origin, {
    baseUrl: fixture.baseUrl,
    model: "active-always-allow-model",
    name: "Active always-allow model",
  });
  const project = await jsonRequest<Project>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Active always-allow project" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const session = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({
      approvalMode: "ask_for_dangerous",
      modelId: model.id,
      title: "Active always-allow session",
    }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const run = await fetch(`${origin}/api/sessions/${session.body.id}/messages`, {
    body: JSON.stringify({ content: "Delegate Python and continue after the policy changes." }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.ok(run.body);
  const reader = run.body.getReader();
  const decoder = new TextDecoder();
  let stream = "";
  let permissionRequestId: string | undefined;
  while (!permissionRequestId) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false, "run ended before the permission request");
    stream += decoder.decode(chunk.value, { stream: true });
    const completed = stream.slice(0, Math.max(0, stream.lastIndexOf("\n\n") + 2));
    const required = parseSseEvents(completed).find((event) => event.type === "permission.required");
    permissionRequestId = (required?.request as { id?: string } | undefined)?.id;
  }
  const changed = await jsonRequest<Session>(`${origin}/api/sessions/${session.body.id}`, {
    body: JSON.stringify({ approvalMode: "always_allow" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "PATCH",
  });
  assert.equal(changed.response.status, 200);
  assert.equal(changed.body.approvalMode, "always_allow");
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    stream += decoder.decode(chunk.value, { stream: true });
  }
  stream += decoder.decode();
  assert.match(stream, /"type":"run.completed"/);
  const requests = await jsonRequest<PermissionRequest[]>(
    `${origin}/api/permission-requests?sessionId=${encodeURIComponent(session.body.id)}`,
    { headers: authorization },
  );
  assert.equal(requests.body.find((request) => request.id === permissionRequestId)?.state, "allowed");
  const grants = await jsonRequest<PermissionGrant[]>(`${origin}/api/permission-grants`, {
    headers: authorization,
  });
  assert.deepEqual(grants.body, []);
  const authorizations = await jsonRequest<PermissionAuthorization[]>(
    `${origin}/api/sessions/${session.body.id}/permission-authorizations`,
    { headers: authorization },
  );
  assert.equal(authorizations.body.length, 1);
  assert.equal(authorizations.body[0]?.source, "always_allow");
});

test("manual concurrent actions keep independent live waiters and resume independently", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `api-independent-permissions-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const { origin } = await startTestApi(context, tempRoot);
  const fixture = await startSubagentModel(context, {
    requireConcurrentSubagents: true,
    subagentUsesPython: true,
    taskCount: 2,
  });
  const model = await createTestModel(origin, {
    baseUrl: fixture.baseUrl,
    model: "independent-permission-model",
    name: "Independent permission model",
  });
  const project = await jsonRequest<Project>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Independent permission project" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const session = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ approvalMode: "ask_for_dangerous", modelId: model.id, title: "Independent permission session" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });

  const run = await fetch(`${origin}/api/sessions/${session.body.id}/messages`, {
    body: JSON.stringify({ content: "Run two independent Python subagents." }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(run.status, 200);
  assert.ok(run.body);
  const reader = run.body.getReader();
  const decoder = new TextDecoder();
  const requestIds = new Set<string>();
  let stream = "";
  while (requestIds.size < 2) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false, "run ended before both permission requests were emitted");
    stream += decoder.decode(chunk.value, { stream: true });
    const completed = stream.slice(0, Math.max(0, stream.lastIndexOf("\n\n") + 2));
    for (const event of parseSseEvents(completed)) {
      const id = event.type === "permission.required"
        ? (event.request as { id?: string } | undefined)?.id
        : undefined;
      if (id) requestIds.add(id);
    }
  }
  const [firstRequestId, secondRequestId] = [...requestIds];

  const firstDecision = await jsonRequest<PermissionDecisionResult>(
    `${origin}/api/permission-requests/${firstRequestId}/decision`,
    {
      body: JSON.stringify({ decision: "allow_once" }),
      headers: { ...authorization, "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(firstDecision.response.status, 200);

  let executions: ExecutionRun[] = [];
  for (let attempt = 0; attempt < 40 && executions.length < 1; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    executions = (await jsonRequest<ExecutionRun[]>(
      `${origin}/api/sessions/${session.body.id}/execution-runs`,
      { headers: authorization },
    )).body;
  }
  const stillPending = await jsonRequest<PermissionRequest[]>(
    `${origin}/api/permission-requests?sessionId=${encodeURIComponent(session.body.id)}`,
    { headers: authorization },
  );
  const firstActionExecutionCount = executions.length;
  const secondActionState = stillPending.body.find((request) => request.id === secondRequestId)?.state;

  const secondDecision = await jsonRequest<PermissionDecisionResult>(
    `${origin}/api/permission-requests/${secondRequestId}/decision`,
    {
      body: JSON.stringify({ decision: "allow_once" }),
      headers: { ...authorization, "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(secondDecision.response.status, 200);
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    stream += decoder.decode(chunk.value, { stream: true });
  }
  stream += decoder.decode();
  assert.notEqual(firstRequestId, secondRequestId);
  assert.notEqual(firstDecision.body.authorization.id, secondDecision.body.authorization.id);
  assert.equal(firstDecision.body.grant, undefined);
  assert.equal(secondDecision.body.grant, undefined);
  assert.equal(firstDecision.body.resolvedRequests.length, 1);
  assert.equal(secondDecision.body.resolvedRequests.length, 1);
  assert.equal(firstActionExecutionCount, 1, "the allowed action should run without waiting for the other decision");
  assert.equal(secondActionState, "pending", "the live sibling remains independently decidable");
  assert.match(stream, /"type":"run.completed"/);
  assert.doesNotMatch(stream, /"type":"run.failed"/);
  const resolvedEvents = parseSseEvents(stream).filter((event) => event.type === "permission.resolved");
  assert.equal(resolvedEvents.length, 2);
  assert.ok(resolvedEvents.every((event) => (event.request as PermissionRequest).state === "allowed"));
  const requests = await jsonRequest<PermissionRequest[]>(
    `${origin}/api/permission-requests?sessionId=${encodeURIComponent(session.body.id)}`,
    { headers: authorization },
  );
  assert.equal(requests.body.filter((request) => request.state === "pending").length, 0);
  assert.equal(requests.body.find((request) => request.id === firstRequestId)?.state, "allowed");
  assert.equal(requests.body.find((request) => request.id === secondRequestId)?.state, "allowed");
  executions = (await jsonRequest<ExecutionRun[]>(
    `${origin}/api/sessions/${session.body.id}/execution-runs`,
    { headers: authorization },
  )).body;
  assert.equal(executions.length, 2);
  assert.ok(executions.every((execution) => execution.status === "succeeded"));
});

test("allow-matching resolves every currently pending action covered by the Session grant", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `api-matching-permissions-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const { origin } = await startTestApi(context, tempRoot);
  const fixture = await startSubagentModel(context, {
    requireConcurrentSubagents: true,
    subagentUsesPython: true,
    taskCount: 2,
  });
  const model = await createTestModel(origin, {
    baseUrl: fixture.baseUrl,
    model: "matching-permission-model",
    name: "Matching permission model",
  });
  const project = await jsonRequest<Project>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Matching permission project" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const session = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ approvalMode: "ask_for_dangerous", modelId: model.id, title: "Matching permission session" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });

  const run = await fetch(`${origin}/api/sessions/${session.body.id}/messages`, {
    body: JSON.stringify({ content: "Run two matching Python subagents." }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(run.status, 200);
  assert.ok(run.body);
  const reader = run.body.getReader();
  const decoder = new TextDecoder();
  const requestIds = new Set<string>();
  let stream = "";
  while (requestIds.size < 2) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false, "run ended before both matching permission requests were emitted");
    stream += decoder.decode(chunk.value, { stream: true });
    const completed = stream.slice(0, Math.max(0, stream.lastIndexOf("\n\n") + 2));
    for (const event of parseSseEvents(completed)) {
      const id = event.type === "permission.required"
        ? (event.request as { id?: string } | undefined)?.id
        : undefined;
      if (id) requestIds.add(id);
    }
  }

  const decision = await jsonRequest<PermissionDecisionResult>(
    `${origin}/api/permission-requests/${[...requestIds][0]}/decision`,
    {
      body: JSON.stringify({ decision: "allow_matching" }),
      headers: { ...authorization, "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(decision.response.status, 200);
  assert.equal(decision.body.grant?.scope, "session");
  assert.equal(decision.body.resolvedRequests.length, 2);
  assert.equal(decision.body.authorizations.length, 2);
  assert.equal(new Set(decision.body.authorizations.map((item) => item.id)).size, 2);

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    stream += decoder.decode(chunk.value, { stream: true });
  }
  stream += decoder.decode();
  assert.match(stream, /"type":"run.completed"/);
  assert.doesNotMatch(stream, /"type":"run.failed"/);

  const requests = await jsonRequest<PermissionRequest[]>(
    `${origin}/api/permission-requests?sessionId=${encodeURIComponent(session.body.id)}`,
    { headers: authorization },
  );
  assert.ok([...requestIds].every((id) =>
    requests.body.find((request) => request.id === id)?.state === "allowed"));
  const executions = await jsonRequest<ExecutionRun[]>(
    `${origin}/api/sessions/${session.body.id}/execution-runs`,
    { headers: authorization },
  );
  assert.equal(executions.body.length, 2);
  assert.ok(executions.body.every((execution) => execution.status === "succeeded"));
});

test("always-allow executes subagent code without permission requests or grants", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `api-subagent-auto-permission-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const { origin } = await startTestApi(context, tempRoot);
  const subagentPythonCode = "print('x' * 650)";
  const fixture = await startSubagentModel(context, { subagentPythonCode, subagentUsesPython: true });
  const model = await createTestModel(origin, {
    baseUrl: fixture.baseUrl,
    model: "subagent-auto-permission-model",
    name: "Subagent auto permission model",
  });
  const project = await jsonRequest<Project>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Subagent auto permission project" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const session = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ approvalMode: "always_allow", modelId: model.id, title: "Subagent always-allow session" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });

  const run = await fetch(`${origin}/api/sessions/${session.body.id}/messages`, {
    body: JSON.stringify({ content: "Delegate an automatic Python execution." }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(run.status, 200);
  const stream = await run.text();
  assert.equal(parseSseEvents(stream).filter((event) => event.type === "permission.required").length, 0);
  assert.match(stream, /"type":"subagent.updated"/);
  assert.match(stream, /"type":"run.completed"/);
  assert.doesNotMatch(stream, /"type":"run.failed"/);
  const streamedToolSteps = parseSseEvents(stream).flatMap((rawEvent) => {
    const event = rawEvent as { step?: SubagentStep; type: string };
    return event.type === "subagent.step" && event.step?.kind === "tool" ? [event.step] : [];
  });
  assert.deepEqual(streamedToolSteps.map((step) => step.status), ["running", "completed"]);
  assert.ok(streamedToolSteps.every((step) => step.input === subagentPythonCode));
  assert.equal(streamedToolSteps[0]?.content, subagentPythonCode);
  assert.ok((streamedToolSteps[1]?.content.length ?? 0) > 400);

  const permissions = await jsonRequest<PermissionRequest[]>(
    `${origin}/api/permission-requests?sessionId=${encodeURIComponent(session.body.id)}`,
    { headers: authorization },
  );
  assert.deepEqual(permissions.body, []);
  const grants = await jsonRequest<PermissionGrant[]>(
    `${origin}/api/permission-grants`,
    { headers: authorization },
  );
  assert.deepEqual(grants.body, []);
  const authorizations = await jsonRequest<PermissionAuthorization[]>(
    `${origin}/api/sessions/${session.body.id}/permission-authorizations`,
    { headers: authorization },
  );
  assert.equal(authorizations.body.length, 1);
  assert.equal(authorizations.body[0]?.source, "always_allow");
  assert.ok(authorizations.body[0]?.executionId);
  const executions = await jsonRequest<ExecutionRun[]>(
    `${origin}/api/sessions/${session.body.id}/execution-runs`,
    { headers: authorization },
  );
  assert.equal(executions.body.length, 1);
  assert.equal(executions.body[0]?.status, "succeeded");
  const subagents = await jsonRequest<Subagent[]>(
    `${origin}/api/sessions/${session.body.id}/subagents`,
    { headers: authorization },
  );
  const toolStep = subagents.body[0]?.steps.find((step) => step.kind === "tool");
  assert.equal(toolStep?.input, subagentPythonCode);
  assert.equal(toolStep?.status, "completed");
  assert.ok((toolStep?.content.length ?? 0) > 400);
  assert.match(toolStep?.content ?? "", /x{650}/);
});

test("failed subagent tool steps retain raw input and the full error result", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `api-subagent-failed-tool-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const { origin } = await startTestApi(context, tempRoot);
  const subagentPythonCode = "raise RuntimeError('y' * 650)";
  const fixture = await startSubagentModel(context, { subagentPythonCode, subagentUsesPython: true });
  const model = await createTestModel(origin, {
    baseUrl: fixture.baseUrl,
    model: "subagent-failed-tool-model",
    name: "Subagent failed tool model",
  });
  const project = await jsonRequest<Project>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Subagent failed tool project" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const session = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ approvalMode: "always_allow", modelId: model.id, title: "Subagent failed tool session" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });

  const run = await fetch(`${origin}/api/sessions/${session.body.id}/messages`, {
    body: JSON.stringify({ content: "Delegate a failing Python execution." }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(run.status, 200);
  await run.text();
  const subagents = await jsonRequest<Subagent[]>(
    `${origin}/api/sessions/${session.body.id}/subagents`,
    { headers: authorization },
  );
  const toolStep = subagents.body[0]?.steps.find((step) => step.kind === "tool");
  assert.equal(toolStep?.input, subagentPythonCode);
  assert.equal(toolStep?.status, "failed");
  assert.ok((toolStep?.content.length ?? 0) > 400);
  assert.match(toolStep?.content ?? "", /RuntimeError/);
  assert.match(toolStep?.content ?? "", /y{650}/);
});

test("API flushes in-flight subagent progress before the run completes", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `api-subagent-progress-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const { origin } = await startTestApi(context, tempRoot);
  const fixture = await startSubagentModel(context, { pauseSubagent: true });
  const model = await createTestModel(origin, {
    baseUrl: fixture.baseUrl,
    model: "subagent-progress-model",
    name: "Subagent progress model",
  });
  const project = await jsonRequest<Project>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Subagent progress project" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const session = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ approvalMode: "always_allow", modelId: model.id, title: "Subagent progress session" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });

  const run = await fetch(`${origin}/api/sessions/${session.body.id}/messages`, {
    body: JSON.stringify({ content: "Delegate a long workspace inspection." }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(run.status, 200);
  await fixture.subagentStarted;

  let flushed: Subagent | undefined;
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const current = await jsonRequest<Subagent[]>(
      `${origin}/api/sessions/${session.body.id}/subagents`,
      { headers: authorization },
    );
    flushed = current.body.find((subagent) =>
      subagent.status === "running"
      && subagent.steps.some((step) => step.kind === "assistant" && step.content.includes("Subagent inspected")));
    if (flushed) break;
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 25));
  }

  fixture.releaseSubagent();
  await run.text();
  assert.ok(flushed, "expected a running subagent assistant step to be persisted before completion");
  assert.equal(flushed.turnCount, 1);
});

test("API runs two task calls concurrently with independent persisted records", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `api-subagent-concurrency-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const { origin } = await startTestApi(context, tempRoot);
  const fixture = await startSubagentModel(context, { requireConcurrentSubagents: true, taskCount: 2 });
  const model = await createTestModel(origin, {
    baseUrl: fixture.baseUrl,
    model: "subagent-concurrency-model",
    name: "Subagent concurrency model",
  });
  const project = await jsonRequest<Project>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Subagent concurrency project" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const session = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ approvalMode: "always_allow", modelId: model.id, title: "Subagent concurrency session" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });

  const run = await fetch(`${origin}/api/sessions/${session.body.id}/messages`, {
    body: JSON.stringify({ content: "Inspect two workspace partitions concurrently." }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(run.status, 200);
  const stream = await run.text();
  assert.equal(fixture.getMaxConcurrentSubagents(), 2);
  assert.deepEqual(rootSseGolden(stream), [
    "run.started",
    "agent.phase",
    "tool.started",
    "tool.started",
    "tool.output",
    "tool.completed",
    "tool.output",
    "tool.completed",
    "agent.phase",
    "assistant.delta",
    "run.completed",
  ]);
  const childGolden = [
    "subagent.updated",
    "subagent.updated",
    "subagent.step",
    "subagent.step",
    "subagent.step",
    "subagent.usage",
    "subagent.updated",
  ];
  assert.deepEqual(subagentSseGoldens(stream), [childGolden, childGolden]);
  const parentExecutionId = parseSseEvents(stream)
    .find((event) => event.type === "run.started")?.runId;
  assert.equal(typeof parentExecutionId, "string");

  const subagents = await jsonRequest<Subagent[]>(
    `${origin}/api/sessions/${session.body.id}/subagents`,
    { headers: authorization },
  );
  assert.equal(subagents.body.length, 2);
  assert.equal(new Set(subagents.body.map((subagent) => subagent.id)).size, 2);
  assert.equal(new Set(subagents.body.map((subagent) => subagent.parentTurnId)).size, 1);
  assert.ok(subagents.body.every((subagent) => subagent.parentTurnId === parentExecutionId));
  assert.deepEqual(
    subagents.body.map((subagent) => subagent.input.description).toSorted(),
    ["Inspect workspace 1", "Inspect workspace 2"],
  );
  assert.ok(subagents.body.every((subagent) => subagent.status === "completed"));
  assert.ok(subagents.body.every((subagent) =>
    subagent.steps.filter((step) => step.kind === "assistant").length === 1));

  const updatedIds = stream.split("\n\n").flatMap((frame) => {
    const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    if (!data) return [];
    const event = JSON.parse(data) as { subagent?: Subagent; type: string };
    return event.type === "subagent.updated" && event.subagent ? [event.subagent.id] : [];
  });
  assert.equal(new Set(updatedIds).size, 2);
});

test("API enforces the per-run subagent concurrency limit", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `api-subagent-limit-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const { origin } = await startTestApi(context, tempRoot);
  const taskCount = DEFAULT_MAX_CONCURRENT_SUBAGENTS + 1;
  const fixture = await startSubagentModel(context, {
    concurrentSubagentTarget: DEFAULT_MAX_CONCURRENT_SUBAGENTS,
    requireConcurrentSubagents: true,
    taskCount,
  });
  const model = await createTestModel(origin, {
    baseUrl: fixture.baseUrl,
    model: "subagent-limit-model",
    name: "Subagent limit model",
  });
  const project = await jsonRequest<Project>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Subagent limit project" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const session = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ approvalMode: "always_allow", modelId: model.id, title: "Subagent limit session" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });

  const run = await fetch(`${origin}/api/sessions/${session.body.id}/messages`, {
    body: JSON.stringify({ content: `Inspect ${taskCount} workspace partitions concurrently.` }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(run.status, 200);
  const stream = await run.text();
  assert.match(stream, /"type":"run.completed"/);
  assert.equal(fixture.getMaxConcurrentSubagents(), DEFAULT_MAX_CONCURRENT_SUBAGENTS);

  const subagents = await jsonRequest<Subagent[]>(
    `${origin}/api/sessions/${session.body.id}/subagents`,
    { headers: authorization },
  );
  assert.equal(subagents.body.length, DEFAULT_MAX_CONCURRENT_SUBAGENTS);
  const startedDescriptions = subagents.body.map((subagent) => subagent.input.description).toSorted();
  const allDescriptions = Array.from({ length: taskCount }, (_, index) => `Inspect workspace ${index + 1}`);
  assert.equal(startedDescriptions.length, DEFAULT_MAX_CONCURRENT_SUBAGENTS);
  assert.deepEqual(startedDescriptions.filter((description) => allDescriptions.includes(description)), startedDescriptions);
  const rejectedDescription = allDescriptions.find((description) => !startedDescriptions.includes(description));
  assert.ok(rejectedDescription);

  const parentResultRequest = fixture.requests.find((request) =>
    request.messages?.some((message) =>
      message.role === "tool" && message.content?.includes("Subagent concurrency limit reached")));
  assert.ok(parentResultRequest);
  const rejectedToolMessages = parentResultRequest.messages?.filter((message) =>
    message.role === "tool"
    && message.content?.includes("Subagent concurrency limit reached")
    && message.content.includes(rejectedDescription)) ?? [];
  assert.equal(rejectedToolMessages.length, 1);
});

test("hierarchical settings and Project/Session lifecycle APIs preserve and delete the expected data", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `settings-lifecycle-api-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const { origin } = await startTestApi(context, tempRoot);
  const modelA = await createTestModel(origin, { model: "model-a", name: "Model A" });
  const modelB = await createTestModel(origin, { model: "model-b", name: "Model B" });

  const globalSettings = await jsonRequest<RuntimeSettingsDetails>(`${origin}/api/settings`, {
    body: JSON.stringify({
      enabledConnectorIds: ["uniprot"],
      enabledSkillIds: ["life-science-evidence-brief"],
      modelId: modelA.id,
      reviewModelId: modelA.id,
      semanticReviewEnabled: true,
    }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "PUT",
  });
  assert.equal(globalSettings.response.status, 200);
  assert.equal(globalSettings.body.sources.modelId, "global");

  const project = await jsonRequest<CreateProjectResponse>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Lifecycle project", settingsOverrides: { reviewModelId: modelB.id } }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.deepEqual(project.body.settingsOverrides, { reviewModelId: modelB.id });
  const renamedProject = await jsonRequest<Project>(`${origin}/api/projects/${project.body.id}`, {
    body: JSON.stringify({ name: "Renamed lifecycle project" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "PATCH",
  });
  assert.equal(renamedProject.body.name, "Renamed lifecycle project");
  const blankProjectName = await fetch(`${origin}/api/projects/${project.body.id}`, {
    body: JSON.stringify({ name: "   " }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "PATCH",
  });
  assert.equal(blankProjectName.status, 400);
  const projectSettings = await jsonRequest<RuntimeSettingsDetails>(
    `${origin}/api/projects/${project.body.id}/settings`,
    {
      body: JSON.stringify({ enabledConnectorIds: ["pubmed"], modelId: modelB.id, semanticReviewEnabled: false }),
      headers: { ...authorization, "content-type": "application/json" },
      method: "PUT",
    },
  );
  assert.equal(projectSettings.body.effective.modelId, modelB.id);
  assert.equal(projectSettings.body.sources.modelId, "project");
  assert.doesNotMatch(JSON.stringify(projectSettings.body), /test-model-token/);

  const session = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ title: "Inherited lifecycle session" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(session.response.status, 201);
  assert.equal(session.body.modelId, modelB.id);
  assert.deepEqual(session.body.settingsOverrides, {});
  const renamedSession = await jsonRequest<Session>(`${origin}/api/sessions/${session.body.id}`, {
    body: JSON.stringify({ title: "Renamed lifecycle session" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "PATCH",
  });
  assert.equal(renamedSession.body.title, "Renamed lifecycle session");
  const blankSessionTitle = await fetch(`${origin}/api/sessions/${session.body.id}`, {
    body: JSON.stringify({ title: "   " }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "PATCH",
  });
  assert.equal(blankSessionTitle.status, 400);
  const inherited = await jsonRequest<RuntimeSettingsDetails>(
    `${origin}/api/sessions/${session.body.id}/settings`,
    { headers: authorization },
  );
  assert.deepEqual(inherited.body.overrides, {});
  assert.equal(inherited.body.sources.modelId, "project");
  assert.equal(inherited.body.sources.reviewModelId, "global");

  const sessionSettings = await jsonRequest<RuntimeSettingsDetails>(
    `${origin}/api/sessions/${session.body.id}/settings`,
    {
      body: JSON.stringify({ enabledConnectorIds: [], modelId: modelA.id }),
      headers: { ...authorization, "content-type": "application/json" },
      method: "PUT",
    },
  );
  assert.deepEqual(sessionSettings.body.effective.enabledConnectorIds, []);
  assert.equal(sessionSettings.body.sources.enabledConnectorIds, "session");
  assert.equal(sessionSettings.body.effective.modelId, modelA.id);
  const invalidSettings = await jsonRequest<{ error: string }>(
    `${origin}/api/sessions/${session.body.id}/settings`,
    {
      body: JSON.stringify({ enabledConnectorIds: ["unknown"] }),
      headers: { ...authorization, "content-type": "application/json" },
      method: "PUT",
    },
  );
  assert.equal(invalidSettings.response.status, 400);
  const afterInvalid = await jsonRequest<RuntimeSettingsDetails>(
    `${origin}/api/sessions/${session.body.id}/settings`,
    { headers: authorization },
  );
  assert.deepEqual(afterInvalid.body.overrides, sessionSettings.body.overrides);

  const upload = await fetch(`${origin}/api/sessions/${session.body.id}/files`, {
    body: JSON.stringify({ content: "preserved", path: "preserved.txt" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(upload.status, 201);
  const archived = await jsonRequest<Session>(`${origin}/api/sessions/${session.body.id}/archive`, {
    headers: authorization,
    method: "POST",
  });
  assert.ok(archived.body.archivedAt);
  const archivedRename = await fetch(`${origin}/api/sessions/${session.body.id}`, {
    body: JSON.stringify({ title: "Blocked archived rename" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "PATCH",
  });
  assert.equal(archivedRename.status, 409);
  const activeList = await jsonRequest<Session[]>(
    `${origin}/api/projects/${project.body.id}/sessions`,
    { headers: authorization },
  );
  const archivedList = await jsonRequest<Session[]>(
    `${origin}/api/projects/${project.body.id}/sessions?state=archived`,
    { headers: authorization },
  );
  assert.deepEqual(activeList.body.map((item) => item.id), [project.body.firstSession.id]);
  assert.deepEqual(archivedList.body.map((item) => item.id), [session.body.id]);
  assert.equal((await fetch(`${origin}/api/sessions/${session.body.id}`, { headers: authorization })).status, 200);
  assert.equal((await fetch(`${origin}/api/sessions/${session.body.id}/files`, {
    body: JSON.stringify({ content: "blocked", path: "blocked.txt" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  })).status, 409);
  assert.equal((await fetch(`${origin}/api/sessions/${session.body.id}/settings`, {
    body: JSON.stringify({}),
    headers: { ...authorization, "content-type": "application/json" },
    method: "PUT",
  })).status, 409);
  assert.equal((await fetch(`${origin}/api/sessions/${session.body.id}/messages`, {
    body: JSON.stringify({ content: "blocked" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  })).status, 409);

  const restored = await jsonRequest<Session>(`${origin}/api/sessions/${session.body.id}/restore`, {
    headers: authorization,
    method: "POST",
  });
  assert.equal(restored.body.archivedAt, undefined);
  const sessionImpact = await jsonRequest<DeletionImpact>(
    `${origin}/api/sessions/${session.body.id}/deletion-impact`,
    { headers: authorization },
  );
  assert.equal(sessionImpact.body.totalSessionCount, 1);
  assert.ok(sessionImpact.body.dataCategories.includes("workspace files"));
  const wrongSessionDelete = await fetch(`${origin}/api/sessions/${session.body.id}`, {
    body: JSON.stringify({ confirmationId: "wrong" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "DELETE",
  });
  assert.equal(wrongSessionDelete.status, 400);
  const sessionRoot = resolve(tempRoot, "projects", project.body.id, "sessions", session.body.id);
  const deletedSession = await fetch(`${origin}/api/sessions/${session.body.id}`, {
    body: JSON.stringify({ confirmationId: session.body.id }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "DELETE",
  });
  assert.equal(deletedSession.status, 200);
  assert.equal((await fetch(`${origin}/api/sessions/${session.body.id}`, { headers: authorization })).status, 404);
  await assert.rejects(stat(sessionRoot), { code: "ENOENT" });

  const activeChild = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ title: "Active child" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const archivedChild = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ title: "Archived child" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  await fetch(`${origin}/api/sessions/${archivedChild.body.id}/archive`, { headers: authorization, method: "POST" });
  const projectImpact = await jsonRequest<DeletionImpact>(
    `${origin}/api/projects/${project.body.id}/deletion-impact`,
    { headers: authorization },
  );
  assert.equal(projectImpact.body.activeSessionCount, 2);
  assert.equal(projectImpact.body.archivedSessionCount, 1);
  assert.deepEqual(
    projectImpact.body.sessionIds.toSorted(),
    [project.body.firstSession.id, activeChild.body.id, archivedChild.body.id].toSorted(),
  );
  const deletedProject = await fetch(`${origin}/api/projects/${project.body.id}`, {
    body: JSON.stringify({ confirmationId: project.body.id }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "DELETE",
  });
  assert.equal(deletedProject.status, 200);
  assert.equal((await fetch(`${origin}/api/projects/${project.body.id}/settings`, { headers: authorization })).status, 404);
  await assert.rejects(stat(resolve(tempRoot, "projects", project.body.id)), { code: "ENOENT" });
});

test("deleting a session/project mirrors the cleanup to the memory-graph sidecar", async (context) => {
  // Verifies the handler wiring: after deleteSession/deleteProject commit on
  // the store, the fire-and-forget sink posts /cleanup/session and
  // /cleanup/project to the sidecar. The sidecar is a fake loopback that
  // records requests; the memory-graph toggle is flipped on so the sink is
  // not short-circuited (default is off).
  const tempRoot = resolve(process.cwd(), ".tmp", `cleanup-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const received: { path: string; body: unknown }[] = [];
  const fakeSidecar = createHttpServer((request, response) => {
    let data = "";
    request.on("data", (chunk) => { data += chunk; });
    request.on("end", () => {
      let body: unknown = null;
      try { body = data ? JSON.parse(data) : null; } catch { /* null */ }
      received.push({ path: request.url ?? "/", body });
      response.writeHead(200, { "content-type": "application/json" });
      const path = request.url ?? "";
      if (path === "/health") response.end(JSON.stringify({ status: "healthy" }));
      else if (path === "/internal/neo4j-password") response.end(JSON.stringify({ status: "healthy" }));
      else if (path === "/cleanup/session") response.end(JSON.stringify({ status: "healthy", "marked": 1, "deleted": 1 }));
      else if (path === "/cleanup/project") response.end(JSON.stringify({ status: "healthy", "deleted": 1 }));
      else response.end("{}");
    });
  });
  await new Promise<void>((resolveListen) => fakeSidecar.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => fakeSidecar.close(() => resolveClose())));
  const sidecarUrl = `http://127.0.0.1:${(fakeSidecar.address() as AddressInfo).port}`;

  const server = createApiServer({ ...testConfig(tempRoot, "http://127.0.0.1:1"), memoryGraph: { url: sidecarUrl, internalToken: "test" } });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((resolveClose) => { server.close(() => resolveClose()); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Two independent projects so the session-delete and project-delete checks
  // don't interfere (deleting a session mutates the other project's impact
  // snapshot). Each project gets a second session so project-cleanup carries
  // >1 session id.
  const projectA = await jsonRequest<{ project: { id: string }; firstSession: { id: string } }>(
    `${origin}/api/projects`, {
      body: JSON.stringify({ name: "Cleanup mirror A" }),
      headers: { ...authorization, "content-type": "application/json" },
      method: "POST",
    });
  assert.equal(projectA.response.status, 201);
  const sessionId = projectA.body.firstSession.id;
  const projectAId = projectA.body.project.id;

  const projectB = await jsonRequest<{ project: { id: string }; firstSession: { id: string } }>(
    `${origin}/api/projects`, {
      body: JSON.stringify({ name: "Cleanup mirror B" }),
      headers: { ...authorization, "content-type": "application/json" },
      method: "POST",
    });
  assert.equal(projectB.response.status, 201);
  const projectBId = projectB.body.project.id;
  const secondB = await jsonRequest<{ id: string }>(`${origin}/api/projects/${projectBId}/sessions`, {
    body: JSON.stringify({ title: "Second" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(secondB.response.status, 201);

  // Flip the memory-graph toggle ON (no password push — only enabled is set,
  // so the sidecar receives just a /health probe).
  const toggled = await fetch(`${origin}/api/memory/settings`, {
    body: JSON.stringify({ enabled: true }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "PUT",
  });
  assert.equal(toggled.status, 200);

  // Delete the session → handler fires cleanupSession(sessionId).
  const deletedSession = await fetch(`${origin}/api/sessions/${sessionId}`, {
    body: JSON.stringify({ confirmationId: sessionId }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "DELETE",
  });
  assert.equal(deletedSession.status, 200);

  // Capture the project's deletion-impact snapshot (its session ids at this
  // moment) BEFORE deleting it — the handler reads impact before deleteProject,
  // and cleanupProject must receive exactly this snapshot.
  const projectImpact = await jsonRequest<{ sessionIds: string[] }>(
    `${origin}/api/projects/${projectBId}/deletion-impact`, { headers: authorization });
  assert.equal(projectImpact.response.status, 200);
  const expectedProjectSessionIds = projectImpact.body.sessionIds.toSorted();

  // Delete the project → handler fires cleanupProject(projectId, impact.sessionIds).
  const deletedProject = await fetch(`${origin}/api/projects/${projectBId}`, {
    body: JSON.stringify({ confirmationId: projectBId }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "DELETE",
  });
  assert.equal(deletedProject.status, 200);

  // Wait for the two fire-and-forget posts to land (fire-and-forget does not
  // await; poll until both /cleanup calls appear on the fake sidecar).
  const deadline = Date.now() + 2_000;
  let cleanups: { path: string; body: unknown }[] = [];
  while (Date.now() < deadline) {
    cleanups = received.filter((r) => r.path === "/cleanup/session" || r.path === "/cleanup/project");
    if (cleanups.length >= 2) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 15));
  }
  assert.ok(cleanups.some((c) => c.path === "/cleanup/session"),
    "deleteSession must fire cleanupSession → POST /cleanup/session");
  assert.ok(cleanups.some((c) => c.path === "/cleanup/project"),
    "deleteProject must fire cleanupProject → POST /cleanup/project");

  const sessionCall = cleanups.find((c) => c.path === "/cleanup/session")!.body as Record<string, unknown>;
  assert.equal(sessionCall.session_id, sessionId);

  const projectCall = cleanups.find((c) => c.path === "/cleanup/project")!.body as Record<string, unknown>;
  assert.equal(projectCall.project_id, projectBId);
  // impact.sessionIds mirrors the pre-deletion snapshot (both of projectB's
  // sessions); order-independent.
  assert.deepEqual((projectCall.session_ids as string[]).toSorted(), expectedProjectSessionIds);
});

test("model registry persists multiple profiles and assigns them per session", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `models-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const { origin } = await startTestApi(context, tempRoot);

  const initialModels = await jsonRequest<ModelProfile[]>(`${origin}/api/models`, { headers: authorization });
  assert.deepEqual(initialModels.body, []);

  const unconfiguredProject = await jsonRequest<Project>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Unconfigured project" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const unconfiguredSession = await jsonRequest<Session>(
    `${origin}/api/projects/${unconfiguredProject.body.id}/sessions`,
    {
      body: JSON.stringify({}),
      headers: { ...authorization, "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(unconfiguredSession.response.status, 201);
  assert.equal(unconfiguredSession.body.title, UNTITLED_SESSION_TITLE);
  assert.equal(unconfiguredSession.body.modelId, undefined);

  const missingModelSession = await jsonRequest<{ error: string }>(
    `${origin}/api/projects/${unconfiguredProject.body.id}/sessions`,
    {
      body: JSON.stringify({ settingsOverrides: { modelId: "missing-model" } }),
      headers: { ...authorization, "content-type": "application/json" },
      method: "POST",
    },
  );
  assert.equal(missingModelSession.response.status, 400);
  assert.equal(missingModelSession.body.error, "modelId must reference an existing model profile");

  const invalidModel = await fetch(`${origin}/api/models`, {
    body: JSON.stringify({ baseUrl: "file:///models", model: "invalid", name: "Invalid" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(invalidModel.status, 400);

  const fast = await jsonRequest<ModelProfile>(`${origin}/api/models`, {
    body: JSON.stringify({
      apiToken: "must-not-persist",
      baseUrl: "https://models.example.test/v1/",
      model: "fast-science",
      name: "Fast science",
    }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const reviewer = await jsonRequest<ModelProfile>(`${origin}/api/models`, {
    body: JSON.stringify({
      apiToken: "review-token",
      baseUrl: "https://review.example.test/v1",
      model: "careful-reviewer",
      name: "Careful reviewer",
    }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(fast.body.baseUrl, "https://models.example.test/v1");
  assert.equal(fast.body.hasApiToken, true);
  assert.equal("apiToken" in fast.body, false);
  assert.equal(reviewer.response.status, 201);
  assert.equal(reviewer.body.hasApiToken, true);
  assert.equal("builtin" in fast.body, false);
  assert.equal("demoMode" in fast.body, false);

  const project = await jsonRequest<Project>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Multi-model project" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const analysis = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ modelId: fast.body.id, title: "Quick analysis" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const review = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ modelId: reviewer.body.id, title: "Paper review" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(analysis.body.modelId, fast.body.id);
  assert.equal(review.body.modelId, reviewer.body.id);

  const clearedReviewer = await jsonRequest<ModelProfile>(`${origin}/api/models/${reviewer.body.id}`, {
    body: JSON.stringify({
      apiToken: null,
      baseUrl: reviewer.body.baseUrl,
      model: reviewer.body.model,
      name: reviewer.body.name,
      vision: reviewer.body.vision,
    }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "PUT",
  });
  assert.equal(clearedReviewer.body.hasApiToken, false);

  const reassigned = await jsonRequest<Session>(`${origin}/api/sessions/${analysis.body.id}`, {
    body: JSON.stringify({ modelId: fast.body.id, reviewModelId: reviewer.body.id }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "PATCH",
  });
  assert.equal(reassigned.body.modelId, fast.body.id);
  assert.equal(reassigned.body.reviewModelId, reviewer.body.id);

  const missingTokenRun = await fetch(`${origin}/api/sessions/${review.body.id}/messages`, {
    body: JSON.stringify({ content: "Review the paper" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(missingTokenRun.status, 200);
  const missingTokenStream = await missingTokenRun.text();
  assert.match(missingTokenStream, /"type":"run.failed"/);
  assert.match(missingTokenStream, /saved API token/);
  const unchanged = await jsonRequest<SessionDetail>(`${origin}/api/sessions/${review.body.id}`, { headers: authorization });
  assert.equal(unchanged.body.messages.length, 0);

  const assignedDelete = await fetch(`${origin}/api/models/${reviewer.body.id}`, {
    headers: authorization,
    method: "DELETE",
  });
  assert.equal(assignedDelete.status, 400);
  const database = new DatabaseSync(resolve(tempRoot, "catalog.sqlite"), { readOnly: true });
  const catalog = database.prepare("SELECT json FROM catalog_state WHERE id = 1").get() as { json: string };
  database.close();
  assert.doesNotMatch(catalog.json, /must-not-persist/);
  assert.doesNotMatch(await readFile(resolve(tempRoot, "catalog.sqlite"), "utf8"), /must-not-persist/);
});

test("WSP-001 multipart upload preserves hashes and exposes specific workspace preview kinds", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `wsp-upload-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const { origin } = await startTestApi(context, tempRoot);
  const model = await createTestModel(origin);
  const project = await jsonRequest<Project>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Workspace upload" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const session = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ modelId: model.id, title: "Upload session" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(session.response.status, 201);

  const csv = Buffer.from("metric,value\nrows,3\n");
  const json = Buffer.from('{"metric":"rows","value":3}\n');
  const markdown = Buffer.from("# Notes\n");
  const pdf = Buffer.from("%PDF-1.4 binary-pdf-bytes");
  const pdb = Buffer.from("HEADER PROTEIN\nATOM      1  N   ALA A   1\n");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
  const unknown = Buffer.from([0x00, 0x01, 0x02, 0x03]);
  const form = new FormData();
  form.append("files", new Blob([csv], { type: "text/csv" }), "input.csv");
  form.append("files", new Blob([json], { type: "application/json" }), "data.json");
  form.append("files", new Blob([markdown], { type: "text/markdown" }), "notes.md");
  form.append("files", new Blob([pdf], { type: "application/pdf" }), "paper.pdf");
  form.append("files", new Blob([pdb], { type: "chemical/x-pdb" }), "protein.pdb");
  form.append("files", new Blob([png], { type: "image/png" }), "chart.png");
  form.append("files", new Blob([unknown], { type: "application/octet-stream" }), "scratch.bin");

  const uploaded = await jsonRequest<WorkspaceUploadResult>(
    `${origin}/api/sessions/${session.body.id}/workspace/upload`,
    { body: form, headers: authorization, method: "POST" },
  );
  assert.equal(uploaded.response.status, 201);
  assert.equal(uploaded.body.errors.length, 0);
  assert.deepEqual(
    uploaded.body.uploaded.map((item) => item.path).sort(),
    ["chart.png", "data.json", "input.csv", "notes.md", "paper.pdf", "protein.pdb", "scratch.bin"],
  );
  const listed = await jsonRequest<WorkspaceFile[]>(
    `${origin}/api/sessions/${session.body.id}/files`,
    { headers: authorization },
  );
  for (const files of [uploaded.body.files, listed.body]) {
    assert.equal(files.find((file) => file.path === "chart.png")?.previewKind, "figure");
    assert.equal(files.find((file) => file.path === "data.json")?.previewKind, "json");
    assert.equal(files.find((file) => file.path === "input.csv")?.previewKind, "dataset");
    assert.equal(files.find((file) => file.path === "notes.md")?.previewKind, "markdown");
    assert.equal(files.find((file) => file.path === "paper.pdf")?.previewKind, "report");
    assert.equal(files.find((file) => file.path === "protein.pdb")?.previewKind, "structure");
    assert.equal(Object.hasOwn(files.find((file) => file.path === "scratch.bin")!, "previewKind"), false);
    assert.equal(files.some((file) => Object.hasOwn(file, "kind")), false);
  }

  const csvHash = createHash("sha256").update(csv).digest("hex");
  const pdfHash = createHash("sha256").update(pdf).digest("hex");
  const pngHash = createHash("sha256").update(png).digest("hex");
  assert.equal(uploaded.body.uploaded.find((item) => item.path === "input.csv")?.hash, csvHash);
  assert.equal(uploaded.body.uploaded.find((item) => item.path === "paper.pdf")?.hash, pdfHash);
  assert.equal(uploaded.body.uploaded.find((item) => item.path === "chart.png")?.hash, pngHash);

  const readCsv = await fetch(`${origin}/api/sessions/${session.body.id}/file?path=input.csv`, { headers: authorization });
  const readPdf = await fetch(`${origin}/api/sessions/${session.body.id}/file?path=paper.pdf`, { headers: authorization });
  const readPng = await fetch(`${origin}/api/sessions/${session.body.id}/file?path=chart.png`, { headers: authorization });
  assert.equal(createHash("sha256").update(Buffer.from(await readCsv.arrayBuffer())).digest("hex"), csvHash);
  assert.equal(createHash("sha256").update(Buffer.from(await readPdf.arrayBuffer())).digest("hex"), pdfHash);
  assert.equal(createHash("sha256").update(Buffer.from(await readPng.arrayBuffer())).digest("hex"), pngHash);
});

test("WSP-003 rejects traversal upload paths and leaves the host untouched", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `wsp-escape-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const { origin } = await startTestApi(context, tempRoot);
  const model = await createTestModel(origin);
  const project = await jsonRequest<Project>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Escape" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const session = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ modelId: model.id, title: "Escape session" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(session.response.status, 201);
  const form = new FormData();
  form.append("files", new Blob([Buffer.from("owned")]), "../../outside.txt");
  const uploaded = await jsonRequest<{ error?: string }>(
    `${origin}/api/sessions/${session.body.id}/workspace/upload`,
    { body: form, headers: authorization, method: "POST" },
  );
  assert.equal(uploaded.response.status, 400);
  assert.match(uploaded.body.error ?? "", /plain basename|path/);
  const listed = await jsonRequest<WorkspaceFile[]>(
    `${origin}/api/sessions/${session.body.id}/files`,
    { headers: authorization },
  );
  assert.equal(listed.body.length, 0);
  await assert.rejects(stat(resolve(tempRoot, "outside.txt")), { code: "ENOENT" });
  const workspaceOutside = resolve(
    tempRoot,
    "projects",
    project.body.id,
    "sessions",
    session.body.id,
    "workspace",
    "outside.txt",
  );
  await assert.rejects(stat(workspaceOutside), { code: "ENOENT" });
});

test("same-named uploads remain physically isolated and append one Project artifact version chain", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `wsp-iso-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const { origin } = await startTestApi(context, tempRoot);
  const model = await createTestModel(origin);
  const project = await jsonRequest<Project>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Isolation" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const sessionA = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ modelId: model.id, title: "A" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const sessionB = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ modelId: model.id, title: "B" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(sessionA.response.status, 201);
  assert.equal(sessionB.response.status, 201);
  for (const [sessionId, content] of [
    [sessionA.body.id, "session-a"],
    [sessionB.body.id, "session-b"],
  ] as const) {
    const form = new FormData();
    form.append("files", new Blob([Buffer.from(content)]), "input.csv");
    const uploaded = await jsonRequest<WorkspaceUploadResult>(
      `${origin}/api/sessions/${sessionId}/workspace/upload`,
      { body: form, headers: authorization, method: "POST" },
    );
    assert.equal(uploaded.response.status, 201);
  }
  const readA = await (await fetch(`${origin}/api/sessions/${sessionA.body.id}/file?path=input.csv`, { headers: authorization })).text();
  const readB = await (await fetch(`${origin}/api/sessions/${sessionB.body.id}/file?path=input.csv`, { headers: authorization })).text();
  assert.equal(readA, "session-a");
  assert.equal(readB, "session-b");
  const artifacts = await jsonRequest<ScientificArtifact[]>(
    `${origin}/api/projects/${project.body.id}/artifacts`,
    { headers: authorization },
  );
  assert.equal(artifacts.body.length, 1);
  assert.equal(artifacts.body[0]?.name, "input.csv");
  const versions = await jsonRequest<ScientificArtifactVersion[]>(
    `${origin}/api/projects/${project.body.id}/artifacts/${artifacts.body[0]!.id}/versions`,
    { headers: authorization },
  );
  assert.deepEqual(versions.body.map((version) => version.sessionId), [sessionA.body.id, sessionB.body.id]);
});

test("recovery cancels and replays undecided approvals for run and subagent scopes", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `recover-approvals-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const store = new SessionStore(tempRoot);
  await store.load();
  const model = await store.createModel({
    apiToken: "test-token",
    baseUrl: "https://models.example.test/v1",
    model: "test-model",
    name: "Test model",
  });
  await store.replaceGlobalSettings({ modelId: model.id });
  const project = await store.createProject("Recovery approvals");
  const session = await store.createSession(project.id, "Recovery approvals");
  const run = await store.createSessionRun({
    prompt: "Interrupted by a process exit",
    sessionId: session.id,
    settingsSnapshot: store.resolveRuntimeSettings(session.id).effective,
  });
  await store.updateSessionRunStatus(session.id, run.id, "running", { startedAt: new Date().toISOString() });
  const subagent = await store.createSubagent(session.id, run.id, {
    description: "Python delegate",
    prompt: "Run a Python check",
    subagentType: "general-purpose",
  });

  const runScoped = await store.requestPermission(
    session.id, "code", "workspace-code", "Run python code", { executionId: run.id });
  const subagentScoped = await store.requestPermission(
    session.id, "code", "workspace-code", "Run python code in subagent", { executionId: subagent.id });
  if (runScoped.allowed || subagentScoped.allowed) throw new Error("Expected pending permission requests");

  await recoverSessionRuns(store);

  assert.equal(store.getPermissionRequest(runScoped.request.id)?.state, "cancelled");
  assert.equal(store.getPermissionRequest(subagentScoped.request.id)?.state, "cancelled");
  const replay = await store.listSessionRunEvents(session.id, run.id);
  const resolved = replay.flatMap((record) =>
    record.event.type === "permission.resolved" ? [record.event.request] : []);
  assert.deepEqual(
    resolved.map((request) => request.id).toSorted(),
    [runScoped.request.id, subagentScoped.request.id].toSorted(),
    "both scopes reach a persisted terminal event exactly once",
  );
  for (const request of resolved) {
    assert.equal(request.state, "cancelled");
    assert.ok(request.decidedAt);
  }
  const last = replay.at(-1);
  assert.ok(last?.event.type === "run.status" && last.event.status === "interrupted");
});

test("cancelling a run while a subagent approval is pending persists its terminal state once", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `subagent-cancel-approval-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const { origin } = await startTestApi(context, tempRoot);
  const fixture = await startSubagentModel(context, { subagentUsesPython: true });
  const model = await createTestModel(origin, {
    baseUrl: fixture.baseUrl,
    model: "subagent-cancel-model",
    name: "Subagent cancel model",
  });
  const project = await jsonRequest<Project>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Subagent cancel project" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  const session = await jsonRequest<Session>(`${origin}/api/projects/${project.body.id}/sessions`, {
    body: JSON.stringify({ approvalMode: "ask_for_dangerous", modelId: model.id, title: "Subagent cancel session" }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });

  const run = await fetch(`${origin}/api/sessions/${session.body.id}/messages`, {
    body: JSON.stringify({ content: "Delegate a Python permission check." }),
    headers: { ...authorization, "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(run.status, 200);
  assert.ok(run.body);
  const reader = run.body.getReader();
  const decoder = new TextDecoder();
  let stream = "";
  let permissionRequestId: string | undefined;
  while (!permissionRequestId) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false, "run ended before the subagent permission request");
    stream += decoder.decode(chunk.value, { stream: true });
    const completed = stream.slice(0, Math.max(0, stream.lastIndexOf("\n\n") + 2));
    const required = parseSseEvents(completed).find((event) => event.type === "permission.required");
    permissionRequestId = (required?.request as { id?: string } | undefined)?.id;
  }
  const runId = parseSseEvents(stream).find((event) => event.type === "run.started")?.runId as string | undefined;
  assert.ok(runId);

  const cancel = await fetch(`${origin}/api/sessions/${session.body.id}/runs/current/cancel`, {
    headers: authorization,
    method: "POST",
  });
  assert.equal(cancel.status, 200);
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    stream += decoder.decode(chunk.value, { stream: true });
  }

  const replay = await listRunEvents(origin, session.body.id, runId);
  const resolved = replay.filter((record) =>
    record.event.type === "permission.resolved" && record.event.request.id === permissionRequestId);
  assert.equal(resolved.length, 1, "the subagent-scoped approval reaches its terminal event exactly once");
  const record = resolved[0]!;
  assert.equal(record.event.type === "permission.resolved" && record.event.request.state, "cancelled");
  assert.ok(record.event.type === "permission.resolved" && record.event.request.decidedAt);
});

test("delta coalescing merges streamed text without reordering surrounding events", async () => {
  const published: RunStreamEvent[] = [];
  const sink = createDeltaCoalescingSink((event) => { published.push(event); }, 10_000, 1_000);
  void sink.emit({ delta: "Hel", type: "assistant.delta" });
  void sink.emit({ delta: "lo", type: "assistant.delta" });
  void sink.emit({ trace: { id: "tool-1", name: "run_python", status: "running" }, type: "tool.started" });
  void sink.emit({ delta: "wor", type: "assistant.delta" });
  await sink.flush();
  assert.deepEqual(published, [
    { delta: "Hello", type: "assistant.delta" },
    { trace: { id: "tool-1", name: "run_python", status: "running" }, type: "tool.started" },
    { delta: "wor", type: "assistant.delta" },
  ], "a non-delta event closes the window before it publishes");

  const sized: RunStreamEvent[] = [];
  const sizedSink = createDeltaCoalescingSink((event) => { sized.push(event); }, 10_000, 5);
  void sizedSink.emit({ delta: "abc", type: "assistant.delta" });
  void sizedSink.emit({ delta: "def", type: "assistant.delta" });
  assert.deepEqual(sized, [{ delta: "abcdef", type: "assistant.delta" }], "the size cap closes a window");

  const turns: RunStreamEvent[] = [];
  const turnSink = createDeltaCoalescingSink((event) => { turns.push(event); }, 10_000, 1_000);
  void turnSink.emit({ delta: "a", turn: 1, type: "assistant.thinking.delta" });
  void turnSink.emit({ delta: "b", turn: 2, type: "assistant.thinking.delta" });
  void turnSink.emit({ delta: "c", type: "assistant.delta" });
  await turnSink.flush();
  assert.deepEqual(turns, [
    { delta: "a", turn: 1, type: "assistant.thinking.delta" },
    { delta: "b", turn: 2, type: "assistant.thinking.delta" },
    { delta: "c", type: "assistant.delta" },
  ], "turn and stream changes never merge across a boundary");
});

test("delta coalescing publishes a window when its timer fires", async () => {
  const published: RunStreamEvent[] = [];
  const sink = createDeltaCoalescingSink((event) => { published.push(event); }, 20, 1_000);
  void sink.emit({ delta: "slow ", type: "assistant.delta" });
  void sink.emit({ delta: "stream", type: "assistant.delta" });
  await new Promise((settle) => setTimeout(settle, 80));
  assert.deepEqual(published, [{ delta: "slow stream", type: "assistant.delta" }]);
  await sink.flush();
  assert.equal(published.length, 1, "an empty buffer flushes to nothing");
});

test("publishing routes growable payloads into child streams and keeps the main timeline slim", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `stream-routing-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const store = new SessionStore(tempRoot);
  await store.load();
  const model = await store.createModel({
    apiToken: "test-token",
    baseUrl: "https://models.example.test/v1",
    model: "test-model",
    name: "Test model",
  });
  await store.replaceGlobalSettings({ modelId: model.id });
  const project = await store.createProject("Stream routing");
  const session = await store.createSession(project.id, "Stream routing");
  const run = await store.createSessionRun({
    prompt: "Route child streams",
    sessionId: session.id,
    settingsSnapshot: store.resolveRuntimeSettings(session.id).effective,
  });
  const subagent = await store.createSubagent(session.id, run.id, {
    description: "Delegate",
    prompt: "Do the delegated work",
    subagentType: "general-purpose",
  });

  const output = await publishRunEvent(store, session.id, run.id, {
    chunk: "stdout:\n121932799878",
    toolCallId: "call-1",
    type: "tool.output",
  });
  assert.equal(output.sequence, 0, "child payloads carry no main-stream cursor");
  const toolStream = await store.listRunStreamEvents(session.id, run.id, "tool-call-1");
  assert.equal(toolStream.length, 1);
  assert.ok(toolStream[0]?.event.type === "tool.output" && toolStream[0].event.chunk.includes("121932799878"));

  await publishRunEvent(store, session.id, run.id, {
    step: subagent.steps[0]!,
    subagentId: subagent.id,
    type: "subagent.step",
  });
  const subagentStream = await store.listRunStreamEvents(session.id, run.id, `subagent-${subagent.id}`);
  assert.equal(subagentStream.length, 1, "subagent process events live in their own stream");

  await publishRunEvent(store, session.id, run.id, { subagent, type: "subagent.updated" });
  const main = await store.listSessionRunEvents(session.id, run.id);
  assert.deepEqual(main.map((record) => record.event.type), ["subagent.updated"],
    "only the slim milestone reaches the main timeline");
  const milestone = main[0]!;
  assert.ok(milestone.event.type === "subagent.updated" && milestone.event.subagent.steps.length === 0,
    "the persisted milestone does not repeat accumulated steps");
  assert.ok(subagent.steps.length > 0, "the source subagent still owns its steps");
});
