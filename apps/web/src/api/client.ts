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

import { WebApiClient } from "./web.js";

export { ApiRequestError } from "./auth.js";

export interface RunnerWorkspaceBinding {
  sessionId: string;
  sessionTitle: string;
  projectName: string;
  workspaceKey: string;
  records: RemoteWorkspaceSyncRecord[];
}

export class ApiClient extends WebApiClient {
  forEnvironmentRunner(runnerId: string): ApiClient {
    return runnerId === "local" ? this : new RunnerEnvironmentApiClient(this.token, this.onAuthFailure, runnerId);
  }

  listRunnerWorkspaces(runnerId: string): Promise<RunnerWorkspaceBinding[]> {
    return this.request(`/api/remote-hosts/${encodeURIComponent(runnerId)}/workspaces`);
  }

  deleteRunnerWorkspace(runnerId: string, sessionId: string): Promise<{ deleted: boolean }> {
    return this.request(`/api/remote-hosts/${encodeURIComponent(runnerId)}/workspaces/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  }
}

class RunnerEnvironmentApiClient extends ApiClient {
  constructor(token: string, onAuthFailure: (() => void) | undefined, private readonly runnerId: string) { super(token, onAuthFailure); }

  protected override request<T>(path: string, init: RequestInit = {}): Promise<T> {
    // Source preferences remain global; only execution-environment APIs route remotely.
    if (/^\/api\/(?:environments(?:\/|$)|environment-setup$|environment-revisions$)/.test(path)) {
      path = `/api/remote-hosts/${encodeURIComponent(this.runnerId)}/${path.slice(5)}`;
    }
    return super.request(path, init);
  }
}

/** True for the rejection fetch and its body reader raise when a caller aborts. */
export function isAbortError(reason: unknown): boolean {
  return typeof reason === "object" && reason !== null && (reason as { name?: unknown }).name === "AbortError";
}

export type { ChatMessage };
