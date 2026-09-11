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

import {
  createExecutionSignature,
  skillBundleIdentity,
  EXECUTION_SIGNATURE_HEADER,
  EXECUTION_TIMESTAMP_HEADER,
} from "@sciencediscovery/runner";
import type {
  CreateEnvironmentRequest,
  Environment,
  EnvironmentRevision,
  InstallEnvironmentRequest,
  KernelSession,
  CreateNpuJobRequest,
  NpuInventory,
  NpuJob,
  NpuJobLogs,
  NpuJobResult,
  NpuWorkloadDescriptor,
  PythonExecutionRequest,
  PythonExecutionResult,
  RunnerHealth,
  RunnerRuntimeStatus,
  RunnerResources,
  RemoteWorkspaceFile,
  RemoteWorkspaceSnapshot,
  ScientificEnvironmentSetup,
  ShellExecutionRequest,
  ShellExecutionResult,
  SkillPackageBundle,
  SkillPackageManifest,
  ExecutionOwner,
  ExecutionLogPage,
  ManagedExecution,
  UninstallEnvironmentRequest,
} from "@sciencediscovery/schema";

export type RunnerInstallEnvironmentRequest = InstallEnvironmentRequest & { workspaceRoot?: string; runnerWorkspaceKey?: string };

/** HTTP adapter for the isolated execution service. */
export class RunnerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  /**
   * Make this Runner hold the selected frozen packages and say where it mounted
   * them. The manifest alone names the snapshot, so a Runner that already has
   * those exact bytes answers without anything being read or shipped; only a
   * miss calls `loadBundle`. The returned path is the Runner's own, never this
   * machine's staging root.
   */
  async prepareSkillPackages(
    manifest: SkillPackageManifest,
    loadBundle: () => Promise<SkillPackageBundle>,
    signal?: AbortSignal,
  ): Promise<string> {
    const id = skillBundleIdentity(manifest);
    try {
      let result = await this.request<{ id: string; root?: string }>(`/skill-packages/${id}`, { signal });
      if (result.id !== id) throw new Error("Runner answered for a different Skill snapshot");
      if (!result.root) {
        result = await this.request("/skill-packages", { method: "POST", body: JSON.stringify(await loadBundle()), signal });
      }
      if (result.id !== id || !result.root) throw new Error("Runner did not confirm Skill snapshot publication");
      return result.root;
    } catch (error) {
      // Never fall through to an execution with no packages mounted: a Session
      // that selected Skills must not silently run without them.
      throw new Error(`Remote Skill preparation failed: ${(error as Error).message}`, { cause: error });
    }
  }

  async health(): Promise<RunnerHealth> {
    const response = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Runner health check failed (${response.status})`);
    return await response.json() as RunnerHealth;
  }

  async status(): Promise<RunnerRuntimeStatus> {
    return await this.request("/status");
  }

  async resources(): Promise<RunnerResources> {
    return await this.request("/resources", { signal: AbortSignal.timeout(3_000) });
  }

  /**
   * This machine's Ascend cards and whether each one opens inside a sandbox.
   *
   * `refresh` re-probes instead of answering from the Runner's own cache. It
   * costs one throwaway sandbox per card, so it is for the moment a decision
   * is made about the cards — saving a selection — not for status polling.
   */
  async npuDevices(options: { refresh?: boolean } = {}): Promise<NpuInventory> {
    return await this.request(`/npu/devices${options.refresh ? "?refresh=1" : ""}`, {
      signal: AbortSignal.timeout(options.refresh ? 60_000 : 5_000),
    });
  }

  async listRemoteWorkspaceFiles(workspaceKey: string, paths?: string[]): Promise<RemoteWorkspaceFile[]> {
    if (paths?.length) {
      return await this.request("/remote-workspace/files", {
        body: JSON.stringify({ paths, workspace: workspaceKey }),
        method: "POST",
      });
    }
    return await this.request(`/remote-workspace/files?workspace=${encodeURIComponent(workspaceKey)}`);
  }

  async deleteRemoteWorkspace(workspaceKey: string): Promise<void> {
    await this.request(`/remote-workspace?workspace=${encodeURIComponent(workspaceKey)}`, { method: "DELETE" });
  }

  async snapshotRemoteWorkspace(workspace: string, paths: string[], signal?: AbortSignal): Promise<RemoteWorkspaceSnapshot> {
    try {
      return await this.request("/remote-workspace/snapshots", { method: "POST", body: JSON.stringify({ workspace, paths }), signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(`Immutable Workspace snapshot export is unavailable; a Runner with snapshot support is required. ${error instanceof Error ? error.message : "Export failed"}`);
    }
  }

  async streamWorkspaceSnapshot(snapshot: RemoteWorkspaceSnapshot, path: string, signal?: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
    const response = await fetch(`${this.baseUrl}/remote-workspace/snapshots/${encodeURIComponent(snapshot.id)}/file?workspace=${encodeURIComponent(snapshot.workspace)}&path=${encodeURIComponent(path)}`, {
      headers: { authorization: `Bearer ${this.token}` }, signal,
    });
    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error || `Workspace snapshot read failed (${response.status})`);
    }
    return response.body;
  }

  async readRemoteWorkspaceFile(workspaceKey: string, path: string): Promise<Buffer> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of await this.streamRemoteWorkspaceFile(workspaceKey, path)) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  async streamRemoteWorkspaceFile(workspaceKey: string, path: string, signal?: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
    const response = await fetch(
      `${this.baseUrl}/remote-workspace/file?workspace=${encodeURIComponent(workspaceKey)}&path=${encodeURIComponent(path)}`,
      { headers: { authorization: `Bearer ${this.token}` }, signal },
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
      throw new Error(body.error || `Remote workspace read failed (${response.status})`);
    }
    if (!response.body) throw new Error("Remote workspace file response has no body");
    const body = response.body;
    return (async function* () {
      const reader = body.getReader();
      try {
        while (true) { const next = await reader.read(); if (next.done) break; yield next.value; }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    })();
  }

  async writeRemoteWorkspaceFile(
    workspaceKey: string,
    path: string,
    content: Uint8Array,
    conflict: "overwrite" | "reject" = "reject",
  ): Promise<{ path: string; size: number }> {
    const response = await fetch(
      `${this.baseUrl}/remote-workspace/file?workspace=${encodeURIComponent(workspaceKey)}&path=${encodeURIComponent(path)}&conflict=${conflict}`,
      {
        body: Buffer.from(content),
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/octet-stream" },
        method: "PUT",
      },
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
      throw new Error(body.error || `Remote workspace write failed (${response.status})`);
    }
    return await response.json() as { path: string; size: number };
  }

  async uploadWorkspaceSnapshotFile(workspace: string, path: string, chunks: AsyncIterable<Uint8Array>,
    metadata: { size: number; sha256: string; executable?: number }, conflict: "reject" | "overwrite", signal?: AbortSignal): Promise<void> {
    const response = await fetch(`${this.baseUrl}/remote-workspace/transfer-file?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(path)}&conflict=${conflict}`, {
      method: "PUT", body: chunks as unknown as RequestInit["body"], duplex: "half", signal,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/octet-stream",
        "x-workspace-size": String(metadata.size), "x-workspace-sha256": metadata.sha256,
        "x-workspace-executable": String(metadata.executable ?? 0) },
    } as RequestInit);
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error || `Runner does not support verified streaming upload (${response.status})`);
    }
    const receipt = await response.json() as { size: number; sha256: string };
    if (receipt.size !== metadata.size || receipt.sha256 !== metadata.sha256) throw new Error("Runner upload receipt mismatch");
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
      throw new Error(body.error || `Runner request failed (${response.status})`);
    }
    return await response.json() as T;
  }

  async listEnvironments(): Promise<Environment[]> {
    return await this.request("/environments");
  }

  async getEnvironmentSetup(): Promise<ScientificEnvironmentSetup> {
    return await this.request("/environment-setup");
  }

  async setupScientificEnvironments(): Promise<ScientificEnvironmentSetup> {
    return await this.request("/environment-setup", {
      body: JSON.stringify({ confirmed: true }),
      method: "POST",
    });
  }

  async listEnvironmentRevisions(): Promise<EnvironmentRevision[]> {
    return await this.request("/environment-revisions");
  }

  async environmentSnapshot(revisionId: string): Promise<Buffer> {
    const response = await fetch(`${this.baseUrl}/environment-revisions/${encodeURIComponent(revisionId)}/snapshot`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
      throw new Error(body.error || `Runner environment snapshot failed (${response.status})`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async createEnvironment(input: CreateEnvironmentRequest): Promise<Environment> {
    return await this.request("/environments", { body: JSON.stringify(input), method: "POST" });
  }

  async deleteEnvironment(environmentId: string): Promise<void> {
    await this.request(`/environments/${encodeURIComponent(environmentId)}`, { method: "DELETE" });
  }

  async installEnvironment(environmentId: string, input: RunnerInstallEnvironmentRequest): Promise<EnvironmentRevision> {
    return await this.request(`/environments/${encodeURIComponent(environmentId)}/install`, {
      body: JSON.stringify(input),
      method: "POST",
    });
  }

  async uninstallEnvironment(environmentId: string, input: UninstallEnvironmentRequest): Promise<EnvironmentRevision> {
    return await this.request(`/environments/${encodeURIComponent(environmentId)}/uninstall`, {
      body: JSON.stringify(input),
      method: "POST",
    });
  }

  async listKernels(): Promise<KernelSession[]> {
    return await this.request("/kernels");
  }

  async teardownKernels(sessionId: string, reason: string): Promise<{ count: number; reason: string }> {
    return await this.request("/kernels/teardown", {
      body: JSON.stringify({ reason, sessionId }),
      method: "POST",
    });
  }

  async teardownKernel(kernelId: string, reason: string): Promise<{ count: number; kernelId: string; reason: string }> {
    return await this.request(`/kernels/${encodeURIComponent(kernelId)}/teardown`, {
      body: JSON.stringify({ reason }),
      method: "POST",
    });
  }

  async listNpuWorkloads(): Promise<NpuWorkloadDescriptor[]> {
    return await this.request("/npu/workloads");
  }

  async listNpuJobs(sessionId: string): Promise<NpuJob[]> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      throw new Error("sessionId is required for NPU job list");
    }
    return await this.request(`/npu/jobs?session_id=${encodeURIComponent(normalizedSessionId)}`);
  }

  async getNpuJob(jobId: string, sessionId: string): Promise<NpuJob> {
    return await this.request(`/npu/jobs/${encodeURIComponent(jobId)}?session_id=${encodeURIComponent(sessionId)}`);
  }

  async npuJobLogs(jobId: string, sessionId: string): Promise<NpuJobLogs> {
    return await this.request(`/npu/jobs/${encodeURIComponent(jobId)}/logs?session_id=${encodeURIComponent(sessionId)}`);
  }

  async cancelNpuJob(jobId: string, sessionId: string): Promise<NpuJob> {
    const body = JSON.stringify({ sessionId });
    const timestamp = Date.now().toString();
    return await this.request(`/npu/jobs/${encodeURIComponent(jobId)}/cancel`, {
      body,
      headers: {
        [EXECUTION_SIGNATURE_HEADER]: createExecutionSignature(this.token, timestamp, body),
        [EXECUTION_TIMESTAMP_HEADER]: timestamp,
      },
      method: "POST",
    });
  }

  async npuJobResult(jobId: string, sessionId: string): Promise<NpuJobResult> {
    return await this.request(`/npu/jobs/${encodeURIComponent(jobId)}/result?session_id=${encodeURIComponent(sessionId)}`);
  }

  async submitNpuJob(request: CreateNpuJobRequest): Promise<NpuJob> {
    const body = JSON.stringify(request);
    const timestamp = Date.now().toString();
    const response = await fetch(`${this.baseUrl}/npu/jobs`, {
      body,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        [EXECUTION_SIGNATURE_HEADER]: createExecutionSignature(this.token, timestamp, body),
        [EXECUTION_TIMESTAMP_HEADER]: timestamp,
      },
      method: "POST",
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
      throw new Error(body.error || `Runner NPU job submission failed (${response.status})`);
    }
    return await response.json() as NpuJob;
  }

  async execute(request: PythonExecutionRequest, signal?: AbortSignal): Promise<PythonExecutionResult> {
    const body = JSON.stringify(request);
    const timestamp = Date.now().toString();
    const response = await fetch(`${this.baseUrl}/execute`, {
      body,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        [EXECUTION_SIGNATURE_HEADER]: createExecutionSignature(this.token, timestamp, body),
        [EXECUTION_TIMESTAMP_HEADER]: timestamp,
      },
      method: "POST",
      signal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
      throw new Error(body.error || `Runner execution failed (${response.status})`);
    }
    return await response.json() as PythonExecutionResult;
  }

  async executeShell(request: ShellExecutionRequest, signal?: AbortSignal): Promise<ShellExecutionResult> {
    const body = JSON.stringify(request);
    const timestamp = Date.now().toString();
    const response = await fetch(`${this.baseUrl}/execute-shell`, {
      body,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        [EXECUTION_SIGNATURE_HEADER]: createExecutionSignature(this.token, timestamp, body),
        [EXECUTION_TIMESTAMP_HEADER]: timestamp,
      },
      method: "POST",
      signal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
      throw new Error(body.error || `Runner shell execution failed (${response.status})`);
    }
    return await response.json() as ShellExecutionResult;
  }

  async startShellExecution(request: ShellExecutionRequest, signal?: AbortSignal): Promise<ManagedExecution> {
    const body = JSON.stringify(request);
    const timestamp = Date.now().toString();
    return this.request("/shell-executions", {
      method: "POST", body, signal,
      headers: {
        [EXECUTION_SIGNATURE_HEADER]: createExecutionSignature(this.token, timestamp, body),
        [EXECUTION_TIMESTAMP_HEADER]: timestamp,
      },
    });
  }

  async getShellExecution(id: string, owner: ExecutionOwner, signal?: AbortSignal): Promise<ManagedExecution> {
    return this.request(`/shell-executions/${encodeURIComponent(id)}?${new URLSearchParams({ ...owner })}`, { signal });
  }

  async shellExecutionLogs(id: string, owner: ExecutionOwner, cursor = 0, signal?: AbortSignal): Promise<ExecutionLogPage> {
    return this.request(`/shell-executions/${encodeURIComponent(id)}/logs?${new URLSearchParams({ ...owner, cursor: String(cursor) })}`, { signal });
  }

  async cancelShellExecution(id: string, owner: ExecutionOwner, signal?: AbortSignal): Promise<ManagedExecution> {
    return this.request(`/shell-executions/${encodeURIComponent(id)}/cancel?${new URLSearchParams({ ...owner })}`, { method: "POST", signal });
  }
}
