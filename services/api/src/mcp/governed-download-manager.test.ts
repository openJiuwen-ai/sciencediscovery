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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";


import type { ArtifactJob, ArtifactPlan, McpInvocation, McpToolResult } from "@sciencediscovery/schema";
import { createBuiltinMcpSourceRegistry } from "@sciencediscovery/mcp-sources";

import { SessionStore } from "../store.js";
import { GovernedDownloadManager, assertSafeArtifactPath } from "@sciencediscovery/artifact-manager";
import { McpGovernanceBroker } from "@sciencediscovery/data-source";
import type { McpTransportClient } from "@sciencediscovery/data-source";
import { McpSourceCatalog } from "@sciencediscovery/data-source";

/** These flows never reach MCP; any call is a test-setup mistake, not a stub gap. */
function unusedTransport(): McpTransportClient {
  const fail = (): never => { throw new Error("MCP transport must not be used in this flow"); };
  return { catalog: fail, invoke: fail, reload: fail };
}


async function waitForCompleted(store: SessionStore, sessionId: string, jobId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = (await store.listArtifactJobs(sessionId)).find((item) => item.id === jobId);
    if (job && ["completed", "failed"].includes(job.state)) return job;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("Artifact job did not finish");
}

/**
 * The shared fixture for the download-failure cases: one session with one succeeded
 * invocation whose normalized result carries `artifacts`, and one injected fetch.
 * `name` keeps each case's temporary directory distinct.
 */
async function setupDownloadFixture(
  name: string,
  artifacts: McpToolResult["artifacts"],
  fetchFn: typeof fetch = async () => new Response(Buffer.from("%PDF-1.4\nserved\n"), {
    headers: { "content-length": "14", "content-type": "application/pdf" },
    status: 200,
  }),
  maxArtifactBytes = 1024,
) {
  const dataDir = resolve(process.cwd(), ".tmp", `artifact-${name}-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  const store = new SessionStore(dataDir);
  await store.load();
  const model = await store.createModel({
    apiToken: "token",
    baseUrl: "https://models.example.test/v1",
    model: "model",
    name: "Model",
    vision: false,
  });
  const project = await store.createProject("Artifacts");
  const session = await store.createSession(project.id, "Download", model.id);
  const registry = createBuiltinMcpSourceRegistry();
  const gateway = unusedTransport();
  const broker = new McpGovernanceBroker(
    dataDir,
    store,
    registry,
    new McpSourceCatalog(registry, gateway),
    gateway,
  );
  const result: McpToolResult = {
    artifacts,
    attribution: "NCBI",
    license: "public-domain",
    records: [],
    retrievedAt: new Date().toISOString(),
    sourceId: "pubmed",
    toolId: "search",
    untrusted: true,
    warnings: [],
  };
  const timestamp = new Date().toISOString();
  const invocationId = `mcp-invocation-${name}`;
  await store.appendMcpInvocation({
    adapterVersion: "1",
    attempts: [],
    attribution: "NCBI",
    cache: { hit: false, key: name, scope: "session" },
    finishedAt: timestamp,
    id: invocationId,
    license: "public-domain",
    normalizedResult: await broker.cas.put(JSON.stringify(result)),
    projectId: project.id,
    request: await broker.cas.put("{}"),
    resultCount: 0,
    sessionId: session.id,
    sourceId: "pubmed",
    startedAt: timestamp,
    status: "succeeded",
    toolCallId: `call-${name}`,
    toolId: "search",
    transport: "mcp",
    turnId: `turn-${name}`,
  });
  const manager = new GovernedDownloadManager(store, registry, broker, fetchFn, maxArtifactBytes);
  return { broker, dataDir, invocationId, manager, session, store };
}

/** Run one prepared download to its terminal state by approving the permission request. */
async function approveAndAwait(store: SessionStore, sessionId: string, manager: GovernedDownloadManager,
  creation: Awaited<ReturnType<GovernedDownloadManager["prepare"]>>) {
  const request = creation.permissionRequest;
  if (!request) throw new Error("Expected a permission request for the prepared download");
  const terminalPromise = manager.waitForPlanTerminal(sessionId, creation.plan.id);
  await store.decidePermissionRequest(request.id, "allow_once");
  const [approved] = await manager.approveByPermissionRequest(request.id);
  if (!approved) throw new Error("Expected the approved plan to yield a job");
  const terminal = await terminalPromise;
  return { job: await waitForCompleted(store, sessionId, approved.job.id), terminal };
}

for (const fixture of ["pdf", "html", "empty", "non-pdf"] as const) {
test(`governed download validates ${fixture} content before publishing a completed artifact`, async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `artifact-manager-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  await store.load();
  const model = await store.createModel({
    apiToken: "token",
    baseUrl: "https://models.example.test/v1",
    model: "model",
    name: "Model",
    vision: false,
  });
  const project = await store.createProject("Artifacts");
  const session = await store.createSession(project.id, "Download", model.id);
  const registry = createBuiltinMcpSourceRegistry();
  const gateway = unusedTransport();
  const broker = new McpGovernanceBroker(
    dataDir,
    store,
    registry,
    new McpSourceCatalog(registry, gateway),
    gateway,
  );
  const bytes = Buffer.from(fixture === "html" ? "<html>Login required</html>" : fixture === "empty" ? ""
    : fixture === "non-pdf" ? "id,value\n1,2\n" : "%PDF-1.4\nverified artifact\n");
  const result: McpToolResult = {
    artifacts: [{
      attribution: "NCBI",
      checksum: { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") },
      expectedBytes: bytes.length,
      format: fixture === "non-pdf" ? "csv" : "pdf",
      id: "candidate-1",
      kind: "paper",
      license: "public-domain",
      logicalName: "record.pdf",
      mimeType: fixture === "non-pdf" ? "text/csv" : "application/pdf",
      sourceId: "pubmed",
      sourceRecordId: "12524540",
      sourceUrl: "https://eutils.ncbi.nlm.nih.gov/artifacts/record.pdf",
    }],
    attribution: "NCBI",
    license: "public-domain",
    records: [],
    retrievedAt: new Date().toISOString(),
    sourceId: "pubmed",
    toolId: "search",
    untrusted: true,
    warnings: [],
  };
  const normalizedResult = await broker.cas.put(JSON.stringify(result));
  const requestRef = await broker.cas.put("{}");
  const timestamp = new Date().toISOString();
  const invocation: McpInvocation = {
    adapterVersion: "1",
    attempts: [],
    attribution: "NCBI",
    cache: { hit: false, key: "test", scope: "session" },
    finishedAt: timestamp,
    id: "mcp-invocation-1",
    license: "public-domain",
    normalizedResult,
    projectId: project.id,
    request: requestRef,
    resultCount: 0,
    sessionId: session.id,
    sourceId: "pubmed",
    startedAt: timestamp,
    status: "succeeded",
    toolCallId: "call-1",
    toolId: "search",
    transport: "mcp",
    turnId: "turn-1",
  };
  await store.appendMcpInvocation(invocation);
  const manager = new GovernedDownloadManager(
    store,
    registry,
    broker,
    async () => new Response(bytes, {
      // A lying PDF Content-Type must not make an HTML page valid.
      headers: { "content-length": String(bytes.length), "content-type": "application/pdf" },
      status: 200,
    }),
    1024,
  );

  const creation = await manager.prepare(session.id, {
    candidateId: "candidate-1",
    destination: { path: "downloads/record.pdf", type: "workspace" },
    mcpInvocationId: invocation.id,
  });
  assert.equal(creation.plan.state, "awaiting_approval");
  assert.equal(creation.plan.candidates[0]?.sourceUrl, result.artifacts?.[0]?.sourceUrl);
  assert.ok(creation.permissionRequest);
  const terminalPromise = manager.waitForPlanTerminal(session.id, creation.plan.id);
  await store.decidePermissionRequest(creation.permissionRequest.id, "allow_once");
  const [approved] = await manager.approveByPermissionRequest(creation.permissionRequest.id);
  assert.ok(approved);
  const terminal = await terminalPromise;
  const completed = terminal.job ?? await waitForCompleted(store, session.id, approved.job.id);

  if (fixture === "html" || fixture === "empty") {
    assert.equal(terminal.status, "failed");
    assert.equal(completed.state, "failed");
    assert.equal(completed.error?.retryable, false);
    assert.match(completed.error?.message ?? "", /no PDF header/);
    await assert.rejects(readFile(resolve(store.workspacePath(session.id), "downloads/record.pdf")), { code: "ENOENT" });
    return;
  }

  assert.equal(terminal.status, "completed");
  assert.equal(completed.state, "completed");
  assert.equal(completed.progress.percent, 100);
  assert.equal(
    await readFile(resolve(store.workspacePath(session.id), "downloads/record.pdf"), "utf8"),
    bytes.toString("utf8"),
  );

  const child = await store.createSubagent(session.id, "parent-request", { description: "Child download", prompt: "Download a paper" });
  const identity = store.workspaceIdentity(session.id, `subagent:${child.id}`);
  await store.updateSubagent({ ...child, handoff: { workspaceId: identity.id, inputPaths: [],
    privateWorkspacePath: `subagents/${child.id}`, manifestPath: `subagents/${child.id}/handoff.json` } });
  const childRoot = store.agentWorkspacePath(session.id, child.id);
  await mkdir(childRoot, { recursive: true });
  const childCreation = await manager.prepare(session.id, {
    candidateId: "candidate-1", destination: { path: `subagents/${child.id}/downloads/record.pdf`, type: "workspace" },
    mcpInvocationId: invocation.id,
  });
  assert.ok(childCreation.permissionRequest);
  const childTerminal = manager.waitForPlanTerminal(session.id, childCreation.plan.id);
  await store.decidePermissionRequest(childCreation.permissionRequest.id, "allow_once");
  await manager.approveByPermissionRequest(childCreation.permissionRequest.id);
  assert.equal((await childTerminal).status, "completed");
  assert.equal(await readFile(resolve(childRoot, "downloads/record.pdf"), "utf8"), bytes.toString("utf8"));
  await assert.rejects(readFile(resolve(store.workspacePath(session.id), `subagents/${child.id}/downloads/record.pdf`)), { code: "ENOENT" });
});
}

test("governed download manager resumes concurrent downloads without corrupting shared job state", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `artifact-resume-concurrent-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  await store.load();
  const model = await store.createModel({
    apiToken: "token",
    baseUrl: "https://models.example.test/v1",
    model: "model",
    name: "Model",
    vision: false,
  });
  const project = await store.createProject("Concurrent downloads");
  const session = await store.createSession(project.id, "Resume", model.id);
  const registry = createBuiltinMcpSourceRegistry();
  const gateway = unusedTransport();
  const broker = new McpGovernanceBroker(
    dataDir,
    store,
    registry,
    new McpSourceCatalog(registry, gateway),
    gateway,
  );
  const timestamp = new Date().toISOString();
  const plans: ArtifactPlan[] = [0, 1].map((index) => ({
    candidates: [{
      attribution: "NCBI",
      format: "pdf",
      id: `candidate-${index}`,
      kind: "paper",
      license: "public-domain",
      logicalName: `paper-${index}.pdf`,
      mimeType: "application/pdf",
      sourceId: "pubmed",
      sourceRecordId: `record-${index}`,
      sourceUrl: `https://eutils.ncbi.nlm.nih.gov/artifacts/paper-${index}.pdf`,
    }],
    createdAt: timestamp,
    destination: { path: `downloads/paper-${index}.pdf`, type: "workspace" },
    id: `plan-${index}`,
    mcpInvocationId: `invocation-${index}`,
    permissionAuthorizationId: `authorization-${index}`,
    permissionRequestId: `request-${index}`,
    selectedCandidateId: `candidate-${index}`,
    sessionId: session.id,
    sourceId: "pubmed",
    sourceRecordId: `record-${index}`,
    state: "approved",
    toolId: "search",
  }));
  const jobs: ArtifactJob[] = plans.map((plan, index) => ({
    attempts: 0,
    createdAt: timestamp,
    id: `job-${index}`,
    maxAttempts: 3,
    permissionAuthorizationId: `authorization-${index}`,
    planId: plan.id,
    progress: { bytesDownloaded: 0, filesCompleted: 0, filesTotal: 1 },
    projectId: project.id,
    sessionId: session.id,
    sourceId: "pubmed",
    sourceRecordId: `record-${index}`,
    state: "queued",
    updatedAt: timestamp,
  }));
  for (const plan of plans) await store.appendArtifactPlan(plan);
  for (const job of jobs) await store.appendArtifactJob(job);
  const manager = new GovernedDownloadManager(
    store,
    registry,
    broker,
    async (input) => {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      const bytes = Buffer.from(`%PDF-1.4\n${String(input)}\n`);
      return new Response(bytes, {
        headers: { "content-length": String(bytes.length) },
        status: 200,
      });
    },
    1024,
  );

  await manager.resumeInterrupted();
  const completed = await Promise.all(jobs.map((job) => waitForCompleted(store, session.id, job.id)));

  assert.deepEqual(completed.map((job) => job.state), ["completed", "completed"]);
  assert.deepEqual(
    (await store.listArtifactJobs(session.id)).map((job) => [job.id, job.state]),
    [["job-0", "completed"], ["job-1", "completed"]],
  );
});

test("governed download manager waits for a pending permission and returns denial as a terminal result", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `artifact-denied-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  await store.load();
  const model = await store.createModel({
    apiToken: "token", baseUrl: "https://model.test/v1", model: "model", name: "Model", vision: false,
  });
  const project = await store.createProject("Denied");
  const session = await store.createSession(project.id, "Denied", model.id);
  const registry = createBuiltinMcpSourceRegistry();
  const gateway = unusedTransport();
  const broker = new McpGovernanceBroker(
    dataDir,
    store,
    registry,
    new McpSourceCatalog(registry, gateway),
    gateway,
  );
  const result: McpToolResult = {
    artifacts: [{
      attribution: "NCBI", format: "pdf", id: "candidate-denied", kind: "paper",
      license: "public-domain", logicalName: "denied.pdf", mimeType: "application/pdf",
      sourceId: "pubmed", sourceRecordId: "1",
      sourceUrl: "https://eutils.ncbi.nlm.nih.gov/artifacts/denied.pdf",
    }],
    attribution: "NCBI", license: "public-domain", records: [], retrievedAt: new Date().toISOString(),
    sourceId: "pubmed", toolId: "search", untrusted: true, warnings: [],
  };
  const timestamp = new Date().toISOString();
  await store.appendMcpInvocation({
    adapterVersion: "1", attempts: [], attribution: "NCBI",
    cache: { hit: false, key: "denied", scope: "session" }, finishedAt: timestamp,
    id: "mcp-invocation-denied", license: "public-domain",
    normalizedResult: await broker.cas.put(JSON.stringify(result)),
    projectId: project.id, request: await broker.cas.put("{}"), resultCount: 0,
    sessionId: session.id, sourceId: "pubmed", startedAt: timestamp, status: "succeeded",
    toolCallId: "call-denied", toolId: "search", transport: "mcp", turnId: "turn-denied",
  });
  const manager = new GovernedDownloadManager(store, registry, broker);
  const creation = await manager.prepare(session.id, {
    candidateId: "candidate-denied",
    destination: { path: "downloads/denied.pdf", type: "workspace" },
    mcpInvocationId: "mcp-invocation-denied",
  });
  assert.ok(creation.permissionRequest);
  const terminalPromise = manager.waitForPlanTerminal(session.id, creation.plan.id);
  await store.decidePermissionRequest(creation.permissionRequest.id, "deny");
  const terminal = await terminalPromise;
  assert.equal(terminal.status, "denied");
  assert.equal(terminal.job, undefined);
});

test("governed download manager rejects a candidate whose host is outside the source manifest", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `artifact-host-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const store = new SessionStore(dataDir);
  await store.load();
  const model = await store.createModel({
    apiToken: "token", baseUrl: "https://model.test/v1", model: "model", name: "Model", vision: false,
  });
  const project = await store.createProject("Host");
  const session = await store.createSession(project.id, "Host", model.id);
  const registry = createBuiltinMcpSourceRegistry();
  const gateway = unusedTransport();
  const broker = new McpGovernanceBroker(
    dataDir,
    store,
    registry,
    new McpSourceCatalog(registry, gateway),
    gateway,
  );
  const result: McpToolResult = {
    artifacts: [{
      attribution: "NCBI", format: "txt", id: "candidate-1", kind: "dataset",
      license: "public-domain", logicalName: "record.txt", sourceId: "pubmed",
      sourceRecordId: "1", sourceUrl: "https://attacker.example/record.txt",
    }],
    attribution: "NCBI", license: "public-domain", records: [], retrievedAt: new Date().toISOString(),
    sourceId: "pubmed", toolId: "search", untrusted: true, warnings: [],
  };
  const timestamp = new Date().toISOString();
  await store.appendMcpInvocation({
    adapterVersion: "1", attempts: [], attribution: "NCBI",
    cache: { hit: false, key: "test", scope: "session" }, finishedAt: timestamp,
    id: "mcp-invocation-1", license: "public-domain",
    normalizedResult: await broker.cas.put(JSON.stringify(result)),
    projectId: project.id, request: await broker.cas.put("{}"), resultCount: 0,
    sessionId: session.id, sourceId: "pubmed", startedAt: timestamp, status: "succeeded",
    toolCallId: "call-1", toolId: "search", transport: "mcp", turnId: "turn-1",
  });
  const manager = new GovernedDownloadManager(store, registry, broker);
  await assert.rejects(
    manager.prepare(session.id, {
      candidateId: "candidate-1",
      destination: { path: "record.txt", type: "workspace" },
      mcpInvocationId: "mcp-invocation-1",
    }),
    /not allowlisted/,
  );
});

test("artifact paths reject traversal and an existing symlink parent", async (context) => {
  const root = resolve(process.cwd(), ".tmp", `artifact-path-${Date.now()}-${process.pid}`);
  const outside = resolve(process.cwd(), ".tmp", `artifact-outside-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(outside, resolve(root, "linked"));
  context.after(() => Promise.all([
    rm(root, { force: true, recursive: true }),
    rm(outside, { force: true, recursive: true }),
  ]));

  await assert.rejects(assertSafeArtifactPath(root, resolve(root, "linked", "file.txt")), /symbolic link/);
  await assert.rejects(assertSafeArtifactPath(root, resolve(root, "..", "outside.txt")), /escapes/);
});

test("governed download fails instead of publishing an artifact whose checksum does not match", async (context) => {
  const bytes = Buffer.from("%PDF-1.4\nserved artifact\n");
  const fixture = await setupDownloadFixture("checksum", [{
    attribution: "NCBI",
    // The declared digest belongs to different content than the bytes served below.
    checksum: { algorithm: "sha256", value: createHash("sha256").update("different content").digest("hex") },
    expectedBytes: bytes.length,
    format: "pdf",
    id: "candidate-checksum",
    kind: "paper",
    license: "public-domain",
    logicalName: "record.pdf",
    mimeType: "application/pdf",
    sourceId: "pubmed",
    sourceRecordId: "12524540",
    sourceUrl: "https://eutils.ncbi.nlm.nih.gov/artifacts/record.pdf",
  }], async () => new Response(bytes, {
    headers: { "content-length": String(bytes.length), "content-type": "application/pdf" },
    status: 200,
  }));
  context.after(() => rm(fixture.dataDir, { force: true, recursive: true }));

  const creation = await fixture.manager.prepare(fixture.session.id, {
    candidateId: "candidate-checksum",
    destination: { path: "downloads/record.pdf", type: "workspace" },
    mcpInvocationId: fixture.invocationId,
  });
  const { job, terminal } = await approveAndAwait(fixture.store, fixture.session.id, fixture.manager, creation);

  assert.equal(terminal.status, "failed");
  assert.equal(job.state, "failed");
  assert.match(job.error?.message ?? "", /checksum/i);
  // A rejected artifact must never be observable as a completed file.
  await assert.rejects(
    readFile(resolve(fixture.store.workspacePath(fixture.session.id), "downloads/record.pdf")),
    { code: "ENOENT" },
  );
});

test("governed download fails when the transfer ends shorter than the declared size", async (context) => {
  const bytes = Buffer.from("%PDF-1.4\ntruncated artifact\n");
  const fixture = await setupDownloadFixture("size", [{
    attribution: "NCBI",
    expectedBytes: bytes.length + 64,
    format: "pdf",
    id: "candidate-size",
    kind: "paper",
    license: "public-domain",
    logicalName: "record.pdf",
    mimeType: "application/pdf",
    sourceId: "pubmed",
    sourceRecordId: "12524540",
    sourceUrl: "https://eutils.ncbi.nlm.nih.gov/artifacts/record.pdf",
  }], async () => new Response(bytes, {
    headers: { "content-length": String(bytes.length), "content-type": "application/pdf" },
    status: 200,
  }));
  context.after(() => rm(fixture.dataDir, { force: true, recursive: true }));

  const creation = await fixture.manager.prepare(fixture.session.id, {
    candidateId: "candidate-size",
    destination: { path: "downloads/record.pdf", type: "workspace" },
    mcpInvocationId: fixture.invocationId,
  });
  const { job, terminal } = await approveAndAwait(fixture.store, fixture.session.id, fixture.manager, creation);

  assert.equal(terminal.status, "failed");
  assert.equal(job.state, "failed");
  assert.match(job.error?.message ?? "", /size mismatch/i);
  await assert.rejects(
    readFile(resolve(fixture.store.workspacePath(fixture.session.id), "downloads/record.pdf")),
    { code: "ENOENT" },
  );
});

test("a denied download is reported as terminal, leaves no artifact, and does not block a later download", async (context) => {
  const bytes = Buffer.from("%PDF-1.4\nrecovered artifact\n");
  const fixture = await setupDownloadFixture("deny-recover", [{
    attribution: "NCBI",
    checksum: { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") },
    expectedBytes: bytes.length,
    format: "pdf",
    id: "candidate-deny-recover",
    kind: "paper",
    license: "public-domain",
    logicalName: "record.pdf",
    mimeType: "application/pdf",
    sourceId: "pubmed",
    sourceRecordId: "12524540",
    sourceUrl: "https://eutils.ncbi.nlm.nih.gov/artifacts/record.pdf",
  }], async () => new Response(bytes, {
    headers: { "content-length": String(bytes.length), "content-type": "application/pdf" },
    status: 200,
  }));
  context.after(() => rm(fixture.dataDir, { force: true, recursive: true }));

  const destination = { path: "downloads/record.pdf", type: "workspace" } as const;
  const first = await fixture.manager.prepare(fixture.session.id, {
    candidateId: "candidate-deny-recover",
    destination,
    mcpInvocationId: fixture.invocationId,
  });
  const deniedRequest = first.permissionRequest;
  if (!deniedRequest) throw new Error("Expected a permission request for the prepared download");
  const deniedTerminal = fixture.manager.waitForPlanTerminal(fixture.session.id, first.plan.id);
  await fixture.store.decidePermissionRequest(deniedRequest.id, "deny");
  const denied = await deniedTerminal;

  // The refusal reaches the caller as a terminal state, and no job or file was produced.
  assert.equal(denied.status, "denied");
  assert.equal(denied.job, undefined);
  await assert.rejects(
    readFile(resolve(fixture.store.workspacePath(fixture.session.id), "downloads/record.pdf")),
    { code: "ENOENT" },
  );

  // A refusal is terminal for that request: re-preparing the identical download
  // returns the same plan, which carries no pending permission request and no job.
  const repeated = await fixture.manager.prepare(fixture.session.id, {
    candidateId: "candidate-deny-recover",
    destination,
    mcpInvocationId: fixture.invocationId,
  });
  assert.equal(repeated.plan.id, first.plan.id);
  assert.equal(repeated.permissionRequest, undefined);
  assert.equal(repeated.job, undefined);

  // The session is not poisoned: a download the operator does approve still completes.
  const second = await fixture.manager.prepare(fixture.session.id, {
    candidateId: "candidate-deny-recover",
    destination: { path: "downloads/record-retry.pdf", type: "workspace" },
    mcpInvocationId: fixture.invocationId,
  });
  const { job, terminal } = await approveAndAwait(fixture.store, fixture.session.id, fixture.manager, second);

  assert.equal(terminal.status, "completed");
  assert.equal(job.state, "completed");
  assert.deepEqual(
    await readFile(resolve(fixture.store.workspacePath(fixture.session.id), "downloads/record-retry.pdf")),
    bytes,
  );
});

test("an interrupted download resumes with a Range request and publishes the complete artifact", async (context) => {
  const full = Buffer.from("%PDF-1.4\nresumed artifact payload\n");
  const prefix = full.subarray(0, 12);
  const remainder = full.subarray(12);
  const ranges: Array<string | undefined> = [];
  const fixture = await setupDownloadFixture("resume-range", [{
    attribution: "NCBI",
    checksum: { algorithm: "sha256", value: createHash("sha256").update(full).digest("hex") },
    expectedBytes: full.length,
    format: "pdf",
    id: "candidate-resume",
    kind: "paper",
    license: "public-domain",
    logicalName: "resumed.pdf",
    mimeType: "application/pdf",
    sourceId: "pubmed",
    sourceRecordId: "12524540",
    sourceUrl: "https://eutils.ncbi.nlm.nih.gov/artifacts/resumed.pdf",
  }], async (_input, init) => {
    const headers = init?.headers as Record<string, string> | undefined;
    ranges.push(headers?.range);
    return headers?.range
      ? new Response(remainder, { headers: { "content-length": String(remainder.length) }, status: 206 })
      : new Response(full, { headers: { "content-length": String(full.length) }, status: 200 });
  });
  context.after(() => rm(fixture.dataDir, { force: true, recursive: true }));

  const workspace = fixture.store.workspacePath(fixture.session.id);
  const timestamp = new Date().toISOString();
  const plan: ArtifactPlan = {
    candidates: [{
      attribution: "NCBI",
      checksum: { algorithm: "sha256", value: createHash("sha256").update(full).digest("hex") },
      expectedBytes: full.length,
      format: "pdf",
      id: "candidate-resume",
      kind: "paper",
      license: "public-domain",
      logicalName: "resumed.pdf",
      mimeType: "application/pdf",
      sourceId: "pubmed",
      sourceRecordId: "12524540",
      sourceUrl: "https://eutils.ncbi.nlm.nih.gov/artifacts/resumed.pdf",
    }],
    createdAt: timestamp,
    destination: { path: "downloads/resumed.pdf", type: "workspace" },
    id: "plan-resume",
    mcpInvocationId: fixture.invocationId,
    permissionAuthorizationId: "authorization-resume",
    permissionRequestId: "request-resume",
    selectedCandidateId: "candidate-resume",
    sessionId: fixture.session.id,
    sourceId: "pubmed",
    sourceRecordId: "12524540",
    state: "approved",
    toolId: "search",
  };
  const job: ArtifactJob = {
    attempts: 0,
    createdAt: timestamp,
    id: "job-resume",
    maxAttempts: 3,
    permissionAuthorizationId: "authorization-resume",
    planId: plan.id,
    progress: { bytesDownloaded: 0, filesCompleted: 0, filesTotal: 1 },
    projectId: plan.sessionId,
    sessionId: fixture.session.id,
    sourceId: "pubmed",
    sourceRecordId: "12524540",
    state: "queued",
    updatedAt: timestamp,
  };
  await fixture.store.appendArtifactPlan(plan);
  await fixture.store.appendArtifactJob(job);
  // A previous attempt left these bytes staged; the manager must continue from them.
  const staging = resolve(workspace, ".sciencediscovery", "staging", `${job.id}.part`);
  await mkdir(dirname(staging), { recursive: true });
  await writeFile(staging, prefix);

  await fixture.manager.resumeInterrupted();
  const completed = await waitForCompleted(fixture.store, fixture.session.id, job.id);

  assert.equal(completed.state, "completed");
  assert.deepEqual(ranges, [`bytes=${prefix.length}-`]);
  assert.deepEqual(await readFile(resolve(workspace, "downloads/resumed.pdf")), full);
  await assert.rejects(readFile(staging), { code: "ENOENT" });
});
