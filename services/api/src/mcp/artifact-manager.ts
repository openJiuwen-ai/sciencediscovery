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

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, rename, rm, stat, statfs } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { resolveWorkspaceFile } from "@sciencediscovery/workspace";
import type {
  ArtifactCandidate,
  ArtifactJob,
  ArtifactPlan,
  CreateArtifactPlanRequest,
  McpError,
  McpToolResult,
  PermissionRequest,
} from "@sciencediscovery/schema";
import type { McpSourceRegistry } from "@sciencediscovery/mcp-sources";

import { proxyDispatcher } from "../proxy/index.js";
import type { SessionStore } from "../store.js";
import type { McpGovernanceBroker } from "./broker.js";

const DEFAULT_MAX_ARTIFACT_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_MAX_PAPER_BYTES = 50 * 1024 * 1024;
const PROGRESS_WRITE_BYTES = 1024 * 1024;

export interface ArtifactPlanCreation {
  job?: ArtifactJob;
  permissionRequest?: PermissionRequest;
  plan: ArtifactPlan;
}

export interface ArtifactPlanTerminal {
  job?: ArtifactJob;
  plan: ArtifactPlan;
  status: "cancelled" | "completed" | "denied" | "failed";
}

export interface CompletedArtifact {
  candidate: ArtifactCandidate;
  job: ArtifactJob;
  plan: ArtifactPlan;
}

function artifactResource(plan: Pick<ArtifactPlan, "destination" | "selectedCandidateId" | "sourceId">): string {
  return `artifact:${plan.sourceId}:${plan.selectedCandidateId ?? "unselected"}:${plan.destination.type}:${plan.destination.path}`;
}

function jobError(code: McpError["code"], message: string, retryable: boolean): McpError {
  return { code, message: message.slice(0, 1_000), retryable };
}

function parseTotalBytes(response: Response, offset: number): number | undefined {
  const contentRange = response.headers.get("content-range");
  const rangeTotal = contentRange?.match(/\/(\d+)$/)?.[1];
  if (rangeTotal) return Number(rangeTotal);
  const contentLength = Number(response.headers.get("content-length"));
  return Number.isFinite(contentLength) && contentLength >= 0 ? offset + contentLength : undefined;
}

export async function assertSafeArtifactPath(root: string, target: string): Promise<void> {
  const relativePath = relative(root, target);
  if (!relativePath || relativePath.startsWith("..") || relativePath.split(sep).includes("..")) {
    throw new Error("Artifact path escapes the workspace");
  }
  let current = root;
  for (const part of relativePath.split(sep)) {
    current = resolve(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Artifact path contains a symbolic link: ${relative(root, current)}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
}

export class ArtifactManager {
  private completedHandler?: (artifact: CompletedArtifact) => Promise<void>;
  private readonly running = new Map<string, AbortController>();
  private mutationQueue = Promise.resolve();

  constructor(
    private readonly store: SessionStore,
    private readonly registry: McpSourceRegistry,
    private readonly broker: McpGovernanceBroker,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly maxArtifactBytes = DEFAULT_MAX_ARTIFACT_BYTES,
  ) {}

  setCompletedHandler(handler: (artifact: CompletedArtifact) => Promise<void>): void {
    this.completedHandler = handler;
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return await result;
  }

  async resumeInterrupted(): Promise<void> {
    for (const project of this.store.listProjects()) {
      for (const session of this.store.listSessions(project.id, "all")) {
        if (session.archivedAt) continue;
        for (const job of await this.store.listArtifactJobs(session.id)) {
          if (!["queued", "retrying", "running", "verifying"].includes(job.state)) continue;
          const queued: ArtifactJob = {
            ...job,
            state: "queued",
            updatedAt: new Date().toISOString(),
          };
          await this.store.replaceArtifactJob(queued);
          this.schedule(queued);
        }
      }
    }
  }

  private async getPlan(sessionId: string, planId: string): Promise<ArtifactPlan> {
    const plan = (await this.store.listArtifactPlans(sessionId)).find((item) => item.id === planId);
    if (!plan) throw new Error("Artifact plan not found");
    return plan;
  }

  private async getJob(sessionId: string, jobId: string): Promise<ArtifactJob> {
    const job = (await this.store.listArtifactJobs(sessionId)).find((item) => item.id === jobId);
    if (!job) throw new Error("Artifact job not found");
    return job;
  }

  async getCompletedArtifact(sessionId: string, jobId: string): Promise<CompletedArtifact> {
    const job = await this.getJob(sessionId, jobId);
    if (job.state !== "completed" || !job.finalPath) {
      throw new Error("PDF extraction requires a completed artifact download");
    }
    const plan = await this.getPlan(sessionId, job.planId);
    const candidate = plan.candidates.find((item) => item.id === plan.selectedCandidateId);
    if (!candidate) throw new Error("Artifact candidate is missing");
    return {
      candidate: structuredClone(candidate),
      job: structuredClone(job),
      plan: structuredClone(plan),
    };
  }

  async prepare(sessionId: string, input: CreateArtifactPlanRequest): Promise<ArtifactPlanCreation> {
    const session = this.store.assertSessionWritable(sessionId);
    const invocation = (await this.store.listMcpInvocations(sessionId))
      .find((item) => item.id === input.mcpInvocationId);
    if (!invocation || invocation.status !== "succeeded" || !invocation.normalizedResult) {
      throw new Error("A successful MCP invocation with a normalized result is required");
    }
    const result = JSON.parse(
      (await this.broker.cas.read(invocation.normalizedResult.hash)).toString("utf8"),
    ) as McpToolResult;
    const candidate = result.artifacts?.find((item) => item.id === input.candidateId);
    if (!candidate) throw new Error("Artifact candidate was not produced by the selected MCP invocation");
    if (candidate.sourceId !== invocation.sourceId) throw new Error("Artifact candidate source does not match its MCP invocation");
    const existingPlan = (await this.store.listArtifactPlans(sessionId)).find((plan) =>
      plan.mcpInvocationId === invocation.id
      && plan.selectedCandidateId === candidate.id
      && plan.destination.type === input.destination.type
      && plan.destination.path === input.destination.path);
    if (existingPlan) {
      const job = (await this.store.listArtifactJobs(sessionId)).find((item) => item.planId === existingPlan.id);
      const permissionRequest = existingPlan.permissionRequestId
        ? this.store.getPermissionRequest(existingPlan.permissionRequestId)
        : undefined;
      return {
        ...(job ? { job } : {}),
        ...(permissionRequest?.state === "pending" ? { permissionRequest } : {}),
        plan: existingPlan,
      };
    }
    this.assertCandidateUrl(candidate);
    resolveWorkspaceFile(this.store.workspacePath(sessionId), input.destination.path);
    const filesystem = await statfs(this.store.workspacePath(sessionId));
    const quotaAvailableBytes = Number(filesystem.bavail * filesystem.bsize);
    if (candidate.expectedBytes !== undefined && candidate.expectedBytes > quotaAvailableBytes) {
      throw new Error("Artifact is larger than the available workspace filesystem quota");
    }
    const timestamp = new Date().toISOString();
    const provisional: ArtifactPlan = {
      candidates: [structuredClone(candidate)],
      createdAt: timestamp,
      destination: structuredClone(input.destination),
      ...(candidate.expectedBytes !== undefined ? { estimatedBytes: candidate.expectedBytes } : {}),
      ...(candidate.expiresAt ? { expiresAt: candidate.expiresAt } : {}),
      id: randomUUID(),
      mcpInvocationId: invocation.id,
      permissionRequestId: "",
      quotaAvailableBytes,
      selectedCandidateId: candidate.id,
      sessionId,
      sourceId: invocation.sourceId,
      sourceRecordId: candidate.sourceRecordId,
      state: "awaiting_approval",
      toolId: invocation.toolId,
    };
    const permission = await this.store.requestPermission(
      sessionId,
      "artifact_download",
      artifactResource(provisional),
      `Download ${candidate.logicalName} to workspace path ${input.destination.path}`,
      { executionId: invocation.turnId, toolCallId: invocation.toolCallId },
    );
    let plan: ArtifactPlan;
    if (permission.allowed) {
      plan = {
        ...provisional,
        permissionAuthorizationId: permission.authorization.id,
        permissionRequestId: "",
        state: "approved",
      };
    } else {
      plan = { ...provisional, permissionRequestId: permission.request.id };
    }
    await this.store.appendArtifactPlan(plan);
    if (!permission.allowed) return { permissionRequest: permission.request, plan };
    const job = await this.createJob(plan, permission.authorization.id);
    return { job, plan };
  }

  async approveByPermissionRequest(permissionRequestId: string): Promise<Array<{ job: ArtifactJob; plan: ArtifactPlan }>> {
    const approved: Array<{ job: ArtifactJob; plan: ArtifactPlan }> = [];
    for (const project of this.store.listProjects()) {
      for (const session of this.store.listSessions(project.id, "all")) {
        const plan = (await this.store.listArtifactPlans(session.id))
          .find((item) => item.permissionRequestId === permissionRequestId);
        if (!plan) continue;
        approved.push(await this.approve(session.id, plan.id));
      }
    }
    return approved;
  }

  async approve(sessionId: string, planId: string): Promise<{ job: ArtifactJob; plan: ArtifactPlan }> {
    const plan = await this.getPlan(sessionId, planId);
    if (plan.state === "expired" || (plan.expiresAt && Date.parse(plan.expiresAt) <= Date.now())) {
      if (plan.state !== "expired") await this.store.replaceArtifactPlan({ ...plan, state: "expired" });
      throw new Error("Artifact plan has expired");
    }
    if (plan.state === "approved" && plan.permissionAuthorizationId) {
      const existing = (await this.store.listArtifactJobs(sessionId)).find((job) => job.planId === plan.id);
      if (existing) return { job: existing, plan };
      return { job: await this.createJob(plan, plan.permissionAuthorizationId), plan };
    }
    if (plan.state === "approved" && plan.permissionGrantId) {
      const authorization = await this.store.ensureLegacyPermissionAuthorization(
        sessionId,
        "artifact_download",
        artifactResource(plan),
        plan.permissionGrantId,
      );
      const migrated = { ...plan, permissionAuthorizationId: authorization.id };
      await this.store.replaceArtifactPlan(migrated);
      const existing = (await this.store.listArtifactJobs(sessionId)).find((job) => job.planId === plan.id);
      if (existing) return { job: existing, plan: migrated };
      return { job: await this.createJob(migrated, authorization.id), plan: migrated };
    }
    const request = this.store.getPermissionRequest(plan.permissionRequestId);
    if (!request || request.state !== "allowed") {
      throw new Error("Artifact download permission has not been approved");
    }
    if (!request.permissionAuthorizationId) {
      throw new Error("Artifact download permission has no authorization record");
    }
    const authorization = this.store.getPermissionAuthorization(request.permissionAuthorizationId);
    if (!authorization || authorization.outcome !== "allowed") {
      throw new Error("Artifact download authorization is unavailable");
    }
    const approved: ArtifactPlan = {
      ...plan,
      permissionAuthorizationId: authorization.id,
      state: "approved",
    };
    await this.store.replaceArtifactPlan(approved);
    return { job: await this.createJob(approved, authorization.id), plan: approved };
  }

  async waitForPlanTerminal(
    sessionId: string,
    planId: string,
    signal?: AbortSignal,
  ): Promise<ArtifactPlanTerminal> {
    for (;;) {
      signal?.throwIfAborted();
      const plan = await this.getPlan(sessionId, planId);
      const job = (await this.store.listArtifactJobs(sessionId)).find((item) => item.planId === plan.id);
      if (job && ["cancelled", "completed", "failed"].includes(job.state)) {
        return {
          job,
          plan,
          status: job.state as ArtifactPlanTerminal["status"],
        };
      }
      if (plan.state === "expired") return { plan, status: "failed" };
      if (plan.permissionRequestId) {
        const permission = this.store.getPermissionRequest(plan.permissionRequestId);
        if (permission?.state === "denied" || permission?.state === "cancelled") {
          return { plan, status: permission.state === "denied" ? "denied" : "cancelled" };
        }
      }
      await delay(100, undefined, signal ? { signal } : undefined);
    }
  }

  async cancel(sessionId: string, jobId: string): Promise<ArtifactJob> {
    const job = await this.getJob(sessionId, jobId);
    if (["completed", "failed", "cancelled"].includes(job.state)) return job;
    this.running.get(job.id)?.abort();
    return await this.mutate(async () => {
      const current = await this.getJob(sessionId, jobId);
      const cancelled: ArtifactJob = {
        ...current,
        error: jobError("CANCELLED", "Artifact download was cancelled", false),
        finishedAt: new Date().toISOString(),
        state: "cancelled",
        updatedAt: new Date().toISOString(),
      };
      await this.store.replaceArtifactJob(cancelled);
      return cancelled;
    });
  }

  async retry(sessionId: string, jobId: string): Promise<ArtifactJob> {
    const job = await this.getJob(sessionId, jobId);
    if (job.state !== "failed") throw new Error("Only a failed artifact job can be retried");
    const queued: ArtifactJob = {
      ...job,
      attempts: 0,
      error: undefined,
      finishedAt: undefined,
      state: "queued",
      updatedAt: new Date().toISOString(),
    };
    await this.store.replaceArtifactJob(queued);
    this.schedule(queued);
    return queued;
  }

  private async createJob(plan: ArtifactPlan, permissionAuthorizationId: string): Promise<ArtifactJob> {
    const session = this.store.getSession(plan.sessionId);
    if (!session) throw new Error("Session not found");
    const candidate = plan.candidates.find((item) => item.id === plan.selectedCandidateId);
    if (!candidate) throw new Error("Artifact plan has no selected candidate");
    const timestamp = new Date().toISOString();
    const job: ArtifactJob = {
      attempts: 0,
      createdAt: timestamp,
      ...(candidate.checksum ? { expectedChecksum: `${candidate.checksum.algorithm}:${candidate.checksum.value.toLowerCase()}` } : {}),
      id: randomUUID(),
      maxAttempts: 3,
      permissionAuthorizationId,
      planId: plan.id,
      progress: {
        bytesDownloaded: 0,
        filesCompleted: 0,
        filesTotal: 1,
        ...(candidate.expectedBytes !== undefined ? { totalBytes: candidate.expectedBytes } : {}),
      },
      projectId: session.projectId,
      sessionId: plan.sessionId,
      sourceId: plan.sourceId,
      sourceRecordId: plan.sourceRecordId,
      state: "queued",
      updatedAt: timestamp,
    };
    await this.store.appendArtifactJob(job);
    this.schedule(job);
    return job;
  }

  private schedule(job: ArtifactJob): void {
    queueMicrotask(() => {
      void this.run(job.sessionId, job.id).catch((error) => this.failUnexpected(job, error));
    });
  }

  private async failUnexpected(job: ArtifactJob, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Artifact job ${job.id} failed outside the download boundary:`, error);
    try {
      const current = await this.getJob(job.sessionId, job.id);
      if (["cancelled", "completed", "failed"].includes(current.state)) return;
      await this.store.replaceArtifactJob({
        ...current,
        error: jobError("UPSTREAM_UNAVAILABLE", message, true),
        finishedAt: new Date().toISOString(),
        state: "failed",
        updatedAt: new Date().toISOString(),
      });
    } catch (persistenceError) {
      console.error(`Could not persist failure for artifact job ${job.id}:`, persistenceError);
    }
  }

  private async run(sessionId: string, jobId: string): Promise<void> {
    if (this.running.has(jobId)) return;
    const controller = new AbortController();
    this.running.set(jobId, controller);
    try {
      for (;;) {
        let job = await this.getJob(sessionId, jobId);
        if (job.state === "cancelled") return;
        job = {
          ...job,
          attempts: job.attempts + 1,
          startedAt: job.startedAt ?? new Date().toISOString(),
          state: job.attempts ? "retrying" : "running",
          updatedAt: new Date().toISOString(),
        };
        await this.store.replaceArtifactJob(job);
        try {
          await this.download(job, controller.signal);
          return;
        } catch (error) {
          if (controller.signal.aborted) return;
          const retryable = !(error instanceof ArtifactValidationError);
          if (job.attempts < job.maxAttempts && retryable) continue;
          const failed: ArtifactJob = {
            ...await this.getJob(sessionId, jobId),
            error: jobError(
              error instanceof ArtifactValidationError ? error.code : "UPSTREAM_UNAVAILABLE",
              error instanceof Error ? error.message : String(error),
              retryable,
            ),
            finishedAt: new Date().toISOString(),
            state: "failed",
            updatedAt: new Date().toISOString(),
          };
          await this.store.replaceArtifactJob(failed);
          return;
        }
      }
    } finally {
      this.running.delete(jobId);
    }
  }

  private assertCandidateUrl(candidate: ArtifactCandidate): URL {
    const url = new URL(candidate.sourceUrl);
    if (!["https:", "http:"].includes(url.protocol)) throw new Error("Artifact URL must use HTTP or HTTPS");
    const allowedHosts = new Set(this.registry.get(candidate.sourceId).manifest.governance.networkHosts);
    if (!allowedHosts.has(url.hostname)) throw new Error(`Artifact host is not allowlisted: ${url.hostname}`);
    return url;
  }

  private async fetchAllowed(candidate: ArtifactCandidate, offset: number, signal: AbortSignal): Promise<Response> {
    let url = this.assertCandidateUrl(candidate);
    const manifest = this.registry.get(candidate.sourceId).manifest;
    const allowedHosts = new Set(manifest.governance.networkHosts);
    // Artifact downloads follow the owning MCP server's proxy policy through
    // the shared network base (undici dispatcher).
    const resolvedProxy = this.store.resolveProxy(this.store.mcpProxyPolicy(manifest.transport.mcpServerId));
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      // Re-evaluate protocol and NO_PROXY after each allow-listed redirect.
      const dispatcher = proxyDispatcher(resolvedProxy, url);
      const response = await this.fetchFn(url, {
        ...(dispatcher ? { dispatcher } : {}),
        headers: offset ? { range: `bytes=${offset}-` } : {},
        redirect: "manual",
        signal,
      } as RequestInit);
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get("location");
      if (!location) throw new Error(`Artifact redirect ${response.status} has no Location header`);
      url = new URL(location, url);
      if (!["https:", "http:"].includes(url.protocol) || !allowedHosts.has(url.hostname)) {
        throw new ArtifactValidationError("LICENSE_BLOCKED", `Artifact redirect host is not allowlisted: ${url.hostname}`);
      }
    }
    throw new Error("Artifact download exceeded five redirects");
  }

  private async download(job: ArtifactJob, signal: AbortSignal): Promise<void> {
    const plan = await this.getPlan(job.sessionId, job.planId);
    const candidate = plan.candidates.find((item) => item.id === plan.selectedCandidateId);
    if (!candidate) throw new ArtifactValidationError("NOT_FOUND", "Artifact candidate is missing");
    if (candidate.expiresAt && Date.parse(candidate.expiresAt) <= Date.now()) {
      throw new ArtifactValidationError("NOT_FOUND", "Artifact download URL has expired");
    }
    const workspaceRoot = this.store.workspacePath(job.sessionId);
    const finalPath = resolveWorkspaceFile(workspaceRoot, plan.destination.path);
    const stagingPath = resolve(workspaceRoot, ".sciencediscovery", "staging", `${job.id}.part`);
    await assertSafeArtifactPath(workspaceRoot, finalPath);
    await assertSafeArtifactPath(workspaceRoot, stagingPath);
    await mkdir(dirname(stagingPath), { recursive: true });
    await mkdir(dirname(finalPath), { recursive: true });
    await assertSafeArtifactPath(workspaceRoot, finalPath);
    await assertSafeArtifactPath(workspaceRoot, stagingPath);
    try {
      await stat(finalPath);
      throw new ArtifactValidationError("INVALID_INPUT", `Destination already exists: ${plan.destination.path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let offset = 0;
    try {
      offset = (await stat(stagingPath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let response = await this.fetchAllowed(candidate, offset, signal);
    if (offset && response.status !== 206) {
      await rm(stagingPath, { force: true });
      offset = 0;
      response = await this.fetchAllowed(candidate, 0, signal);
    }
    if (!response.ok || !response.body) throw new Error(`Artifact download failed with HTTP ${response.status}`);
    const totalBytes = candidate.expectedBytes ?? parseTotalBytes(response, offset);
    const artifactLimit = candidate.kind === "paper"
      ? Math.min(this.maxArtifactBytes, DEFAULT_MAX_PAPER_BYTES)
      : this.maxArtifactBytes;
    if (totalBytes !== undefined && totalBytes > artifactLimit) {
      throw new ArtifactValidationError("RESPONSE_TOO_LARGE", `Artifact exceeds the ${artifactLimit} byte quota`);
    }
    const file = await open(stagingPath, offset ? "a" : "w");
    let downloaded = offset;
    let lastPersisted = downloaded;
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        downloaded += value.byteLength;
        if (downloaded > artifactLimit) {
          await reader.cancel();
          throw new ArtifactValidationError("RESPONSE_TOO_LARGE", "Artifact exceeded the download quota");
        }
        await file.write(value);
        if (downloaded - lastPersisted >= PROGRESS_WRITE_BYTES) {
          lastPersisted = downloaded;
          await this.updateProgress(job.sessionId, job.id, downloaded, totalBytes, stagingPath);
        }
      }
    } finally {
      await file.close();
    }
    if (candidate.expectedBytes !== undefined && downloaded !== candidate.expectedBytes) {
      throw new ArtifactValidationError(
        "NORMALIZATION_FAILED",
        `Artifact size mismatch: expected ${candidate.expectedBytes}, received ${downloaded}`,
      );
    }
    await this.updateProgress(job.sessionId, job.id, downloaded, totalBytes, stagingPath, "verifying");
    const algorithm = candidate.checksum?.algorithm ?? "sha256";
    const hash = createHash(algorithm);
    for await (const chunk of createReadStream(stagingPath)) hash.update(chunk);
    const actualChecksum = `${algorithm}:${hash.digest("hex")}`;
    if (candidate.checksum && actualChecksum !== `${candidate.checksum.algorithm}:${candidate.checksum.value.toLowerCase()}`) {
      throw new ArtifactValidationError("NORMALIZATION_FAILED", "Artifact checksum verification failed");
    }
    await rename(stagingPath, finalPath);
    const completed: ArtifactJob = {
      ...await this.getJob(job.sessionId, job.id),
      actualChecksum,
      finalPath: plan.destination.path,
      finishedAt: new Date().toISOString(),
      progress: {
        bytesDownloaded: downloaded,
        filesCompleted: 1,
        filesTotal: 1,
        percent: 100,
        ...(totalBytes !== undefined ? { totalBytes } : {}),
      },
      stagingPath: undefined,
      state: "completed",
      updatedAt: new Date().toISOString(),
    };
    if (this.completedHandler) {
      await this.completedHandler({
        candidate: structuredClone(candidate),
        job: structuredClone(completed),
        plan: structuredClone(plan),
      });
    }
    await this.store.replaceArtifactJob(completed);
  }

  private async updateProgress(
    sessionId: string,
    jobId: string,
    bytesDownloaded: number,
    totalBytes: number | undefined,
    stagingPath: string,
    state: "running" | "verifying" = "running",
  ): Promise<void> {
    const current = await this.getJob(sessionId, jobId);
    if (current.state === "cancelled") throw new DOMException("Cancelled", "AbortError");
    const relativeStaging = stagingPath.startsWith(this.store.workspacePath(sessionId))
      ? stagingPath.slice(this.store.workspacePath(sessionId).length + 1)
      : stagingPath;
    await this.store.replaceArtifactJob({
      ...current,
      progress: {
        bytesDownloaded,
        filesCompleted: 0,
        filesTotal: 1,
        ...(totalBytes !== undefined ? {
          percent: totalBytes ? Math.min(100, Math.round(bytesDownloaded / totalBytes * 10_000) / 100) : 100,
          totalBytes,
        } : {}),
      },
      stagingPath: relativeStaging,
      state,
      updatedAt: new Date().toISOString(),
    });
  }
}

class ArtifactValidationError extends Error {
  constructor(
    readonly code: McpError["code"],
    message: string,
  ) {
    super(message);
    this.name = "ArtifactValidationError";
  }
}
