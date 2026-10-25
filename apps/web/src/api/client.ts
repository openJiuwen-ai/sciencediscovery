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

import type { ChatMessage, RemoteWorkspaceSyncRecord } from "@sciencediscovery/schema";

import { ApiRequestError } from "./auth.js";
import { WebApiClient } from "./web.js";
import type { TrajectoryPort } from "@sciencediscovery/trajectory";

export { ApiRequestError } from "./auth.js";

export interface RunnerWorkspaceBinding {
  sessionId: string;
  projectId: string;
  runnerId: string;
  location: "local" | "remote";
  sessionTitle: string;
  projectName: string;
  workspaceKey: string;
  records: RemoteWorkspaceSyncRecord[];
}

export class ApiClient extends WebApiClient {
  async getErrorDiagnostics(ids: import("@sciencediscovery/operational-logging/diagnostics").DiagnosticIds): Promise<import("@sciencediscovery/operational-logging/diagnostics").DiagnosticSnapshot> {
    const params = new URLSearchParams(Object.entries(ids).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    // This best-effort read must not re-route the error being reported through
    // the normal 401 prompt callback, which can unmount an inline error alert.
    const response = await fetch(`/api/error-diagnostics?${params}`, {
      headers: { authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error("Diagnostic snapshot unavailable");
    return await response.json();
  }
  readonly trajectory: TrajectoryPort = {
    index: (id, signal) => this.request(`/api/sessions/${encodeURIComponent(id)}/trajectory`, { signal }),
    detail: (id, entry, signal) => this.request(`/api/sessions/${encodeURIComponent(id)}/trajectory/detail?id=${encodeURIComponent(entry)}`, { signal }),
    export: async (id, signal) => {
      const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/trajectory/export`, { signal, headers: { authorization: `Bearer ${this.token}` } });
      this.reportAuthStatus(response.status);
      if (!response.ok) throw new ApiRequestError(`Export failed (${response.status})`, response.status);
      return response.blob();
    },
  };
  forEnvironmentRunner(runnerId: string): ApiClient {
    return new RunnerEnvironmentApiClient(this.token, this.onAuthFailure, runnerId);
  }

  listRunnerWorkspaces(runnerId: string): Promise<RunnerWorkspaceBinding[]> {
    return this.request(`/api/runners/${encodeURIComponent(runnerId)}/workspaces`);
  }

  listRunnerWorkspaceFiles(runnerId: string, sessionId: string): Promise<{ runnerId: string; workspaceKey: string; files: Array<{ path: string; size: number }> }> {
    return this.request(`/api/runners/${encodeURIComponent(runnerId)}/workspaces/${encodeURIComponent(sessionId)}/files`);
  }

  deleteRunnerWorkspace(runnerId: string, sessionId: string): Promise<{ deleted: boolean }> {
    return this.request(`/api/runners/${encodeURIComponent(runnerId)}/workspaces/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  }
}

class RunnerEnvironmentApiClient extends ApiClient {
  constructor(token: string, onAuthFailure: (() => void) | undefined, private readonly runnerId: string) { super(token, onAuthFailure); }

  protected override request<T>(path: string, init: RequestInit = {}): Promise<T> {
    // Source preferences remain global; only execution-environment APIs route remotely.
    if (/^\/api\/(?:environments(?:\/|$)|environment-setup$|environment-revisions$)/.test(path)) {
      path = `/api/runners/${encodeURIComponent(this.runnerId)}/${path.slice(5)}`;
    }
    return super.request(path, init);
  }
}

/** True for the rejection fetch and its body reader raise when a caller aborts. */
export function isAbortError(reason: unknown): boolean {
  return typeof reason === "object" && reason !== null && (reason as { name?: unknown }).name === "AbortError";
}

export type { ChatMessage };
