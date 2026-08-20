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
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import type { ArtifactJob, ArtifactPlan, McpInvocation, McpToolResult } from "@science-agent/schema";
import { createBuiltinMcpSourceRegistry } from "@science-agent/mcp-sources";

import { SessionStore } from "../store.js";
import { GovernedDownloadManager, assertSafeArtifactPath } from "@science-agent/artifact-manager";
import { McpGovernanceBroker } from "@science-agent/data-source";
import type { McpTransportClient } from "@science-agent/data-source";
import { McpSourceCatalog } from "@science-agent/data-source";

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

test("governed download manager derives an immutable plan from MCP CAS data and downloads after approval", async (context) => {
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
  const bytes = Buffer.from("%PDF-1.4\nverified artifact\n");
  const result: McpToolResult = {
    artifacts: [{
      attribution: "NCBI",
      checksum: { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") },
      expectedBytes: bytes.length,
      format: "pdf",
      id: "candidate-1",
      kind: "paper",
      license: "public-domain",
      logicalName: "record.pdf",
      mimeType: "application/pdf",
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
      headers: { "content-length": String(bytes.length) },
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

  assert.equal(terminal.status, "completed");
  assert.equal(completed.state, "completed");
  assert.equal(completed.progress.percent, 100);
  assert.equal(
    await readFile(resolve(store.workspacePath(session.id), "downloads/record.pdf"), "utf8"),
    bytes.toString("utf8"),
  );
});

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
