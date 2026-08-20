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

import { setTimeout as delay } from "node:timers/promises";

import type { PermissionRequest, RemoteJob, RunStreamEvent } from "@sciencediscovery/schema";

import { ArtifactManager } from "../mcp/artifact-manager.js";
import { ProvenanceRecorder } from "../provenance.js";
import { RemoteComputeClient } from "../remote-compute.js";
import { SessionStore } from "../store.js";

type RunEventSink = (event: RunStreamEvent) => void | Promise<void>;

/** Serializes permission decisions within one Session without blocking other Sessions. */
export class PermissionDecisionQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.tails.set(sessionId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
    }
  }
}

export async function waitForPermissionDecision(
  store: SessionStore,
  request: PermissionRequest,
  timeoutMs: number,
  signal?: AbortSignal,
  runWait?: {
    emit: RunEventSink;
    runId: string;
    sessionId: string;
  },
): Promise<PermissionRequest> {
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : undefined;
  let blocked = false;
  let resolvedEmitted = false;
  const resumeBlockedRun = async (reason: string) => {
    if (!blocked || !runWait) return;
    const running = await store.updateSessionRunStatusIfCurrent(runWait.sessionId, runWait.runId, "blocked", "running");
    if (running) await runWait.emit({ reason, run: running, status: "running", type: "run.status" });
    blocked = false;
  };
  const cancelAbandonedWait = async (reason: string) => {
    const cancelled = await store.cancelPendingPermissionRequest(request.id);
    if (cancelled && runWait) await runWait.emit({ request: cancelled, type: "permission.resolved" });
    await resumeBlockedRun(reason);
  };
  try {
    while (deadline === undefined || Date.now() < deadline) {
      const current = store.getPermissionRequest(request.id);
      if (!current) throw new Error("Permission request disappeared before it was decided");
      if (current.state !== "pending") {
        if (runWait && !resolvedEmitted) {
          await runWait.emit({ request: current, type: "permission.resolved" });
          resolvedEmitted = true;
        }
        await resumeBlockedRun("Permission decision received");
        if (current.state === "cancelled" || current.state === "denied") return current;
        if (current.decisionEpochId && store.getPermissionEpoch(current.decisionEpochId)) return current;
      }
      if (!blocked && runWait) {
        const blockedRun = await store.updateSessionRunStatusIfCurrent(runWait.sessionId, runWait.runId, "running", "blocked");
        if (blockedRun) {
          blocked = true;
          await runWait.emit({ reason: "Waiting for permission decision", run: blockedRun, status: "blocked", type: "run.status" });
        }
      }
      await delay(100, undefined, signal ? { signal } : undefined);
    }
  } catch (error) {
    await cancelAbandonedWait("Permission wait ended");
    throw error;
  }
  await cancelAbandonedWait("Permission wait timed out");
  throw new Error(`Permission wait timed out after ${timeoutMs} ms: ${request.summary}`);
}

export async function startApprovedRemoteJob(
  job: RemoteJob,
  store: SessionStore,
  remoteCompute: RemoteComputeClient,
  provenanceRecorder: ProvenanceRecorder,
): Promise<RemoteJob> {
  if (job.state !== "approved") return job;
  try {
    const started = await remoteCompute.start(job, store.workspacePath(job.sessionId));
    for (const output of started.outputRecords) {
      if (!output.localPath) continue;
      await provenanceRecorder.registerWorkspaceArtifact({
        origin: "llm_declared",
        originMeta: { remoteJobId: job.id },
        path: output.localPath,
        sessionId: job.sessionId,
        workspaceRoot: store.workspacePath(job.sessionId),
      });
    }
    return await store.updateRemoteJob(started);
  } catch (error) {
    return await store.updateRemoteJob({
      ...job,
      error: error instanceof Error ? error.message : "Remote job failed to start",
      finishedAt: new Date().toISOString(),
      state: "failed",
      updatedAt: new Date().toISOString(),
    });
  }
}

export async function advanceResolvedPermissionRequests(
  requests: PermissionRequest[],
  store: SessionStore,
  artifactManager: ArtifactManager,
  remoteCompute: RemoteComputeClient,
  provenanceRecorder: ProvenanceRecorder,
): Promise<{
  artifactApprovals: Awaited<ReturnType<ArtifactManager["approveByPermissionRequest"]>>;
  remoteJobs: RemoteJob[];
}> {
  const artifactApprovals: Awaited<ReturnType<ArtifactManager["approveByPermissionRequest"]>> = [];
  const remoteJobs: RemoteJob[] = [];
  for (const permissionRequest of requests) {
    if (permissionRequest.action === "artifact_download" && permissionRequest.state === "allowed") {
      artifactApprovals.push(...await artifactManager.approveByPermissionRequest(permissionRequest.id));
    }
    if (permissionRequest.action === "remote_job") {
      const remoteJob = await store.applyRemoteJobPermissionDecision(permissionRequest.id);
      if (remoteJob) {
        remoteJobs.push(await startApprovedRemoteJob(remoteJob, store, remoteCompute, provenanceRecorder));
      }
    }
  }
  return { artifactApprovals, remoteJobs };
}
