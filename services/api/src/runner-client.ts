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
  NpuJob,
  NpuJobLogs,
  NpuJobResult,
  NpuWorkloadDescriptor,
  PythonExecutionRequest,
  PythonExecutionResult,
  RunnerHealth,
  RunnerRuntimeStatus,
  ScientificEnvironmentSetup,
  ShellExecutionRequest,
  ShellExecutionResult,
  UninstallEnvironmentRequest,
} from "@sciencediscovery/schema";

export type RunnerInstallEnvironmentRequest = InstallEnvironmentRequest & { workspaceRoot?: string };

export class RunnerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async health(): Promise<RunnerHealth> {
    const response = await fetch(`${this.baseUrl}/health`);
    if (!response.ok) throw new Error(`Runner health check failed (${response.status})`);
    return await response.json() as RunnerHealth;
  }

  async status(): Promise<RunnerRuntimeStatus> {
    return await this.request("/status");
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
}
