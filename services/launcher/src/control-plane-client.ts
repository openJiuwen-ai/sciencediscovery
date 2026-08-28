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
 * Control-plane HTTP client for `ScienceDiscovery run`. A thin wrapper over the
 * Web frontend's existing REST routes + Bearer auth, so the CLI and the browser
 * share one backend contract (zero backend customization).
 *
 * Duplicated from `apps/web/src/api/` on purpose: the launcher is built as a
 * Single Executable Application whose esbuild bundle cannot pull workspace
 * packages without breaking packaging, so this client stays self-contained.
 *
 * The shapes redeclared below are the subset of `@sciencediscovery/schema` the
 * CLI actually reads; the authoritative definitions live there.
 */
import { TextDecoder } from "node:util";

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/** A run record. Only the fields the CLI reads are typed. */
export interface SessionRun {
  id: string;
  status: string;
  sessionId: string;
  error?: string;
  finishedAt?: string;
  [key: string]: unknown;
}

/** A single event on the run stream. `type` discriminates the rest. */
export interface RunStreamEvent {
  type: string;
  [key: string]: unknown;
}

export interface Session {
  id: string;
  projectId?: string;
  [key: string]: unknown;
}

export interface CreateProjectResponse {
  id?: string;
  projectId?: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface ControlPlaneClientOptions {
  baseUrl: string;
  token: string;
  /** Notified on 401 so the caller can surface a clear "wrong token" message. */
  onAuthFailure?: () => void;
}

export class ControlPlaneClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly onAuthFailure?: () => void;

  constructor(opts: ControlPlaneClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.onAuthFailure = opts.onAuthFailure;
  }

  protected async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      if (response.status === 401) this.onAuthFailure?.();
      const body = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string; code?: string };
      throw new ApiRequestError(body.error || `Request failed (${response.status})`, response.status, body.code);
    }
    return (await response.json()) as T;
  }

  /** Health probe; does not require auth. Returns false on any failure. */
  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/health`);
      return response.ok;
    } catch {
      return false;
    }
  }

  listProjects(): Promise<unknown[]> {
    return this.request("/api/projects");
  }

  /** POST /api/projects creates a project and its first untitled session. */
  createProject(body: Record<string, unknown> = {}): Promise<CreateProjectResponse> {
    return this.request("/api/projects", { body: JSON.stringify(body), method: "POST" });
  }

  createSession(projectId: string, body: Record<string, unknown>): Promise<Session> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/sessions`, {
      body: JSON.stringify(body),
      method: "POST",
    });
  }

  /** PUT /api/sessions/:id/settings — model/skills/connectors (runtime settings). */
  replaceSessionSettings(sessionId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/settings`, {
      body: JSON.stringify(body),
      method: "PUT",
    });
  }

  /** PATCH /api/sessions/:id — approvalMode/reviewMode (must be sent alone). */
  updateSession(sessionId: string, body: Record<string, unknown>): Promise<Session> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      body: JSON.stringify(body),
      method: "PATCH",
    });
  }

  createRun(sessionId: string, body: Record<string, unknown>): Promise<SessionRun> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/runs`, {
      body: JSON.stringify(body),
      method: "POST",
    });
  }

  getRun(sessionId: string, runId: string): Promise<SessionRun> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}`);
  }

  cancelRun(sessionId: string, runId: string): Promise<unknown> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
    });
  }

  decidePermissionRequest(requestId: string, decision: "allow_once" | "allow_matching" | "deny"): Promise<unknown> {
    return this.request(`/api/permission-requests/${encodeURIComponent(requestId)}/decision`, {
      body: JSON.stringify({ decision }),
      method: "POST",
    });
  }

  listPermissionAuthorizations(sessionId: string): Promise<unknown[]> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/permission-authorizations`);
  }

  /**
   * Subscribe to the SSE event stream for a run. Mirrors the Web frontend's
   * `subscribeRunEvents`: fetch with `accept: text/event-stream`, split frames
   * on `\n\n`, parse `id:` / `data:` lines, JSON.parse each payload.
   */
  async subscribeRunEvents(
    sessionId: string,
    runId: string,
    after: number,
    onEvent: (event: RunStreamEvent, sequence: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/events?after=${after}`,
      {
        headers: { accept: "text/event-stream", authorization: `Bearer ${this.token}` },
        ...(signal ? { signal } : {}),
      },
    );
    if (!response.ok) {
      if (response.status === 401) this.onAuthFailure?.();
      const error = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string };
      throw new ApiRequestError(error.error || `Event stream failed (${response.status})`, response.status);
    }
    if (!response.body) throw new Error("Event stream has no body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sequence = after;
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const eventId = frame.split("\n").find((line) => line.startsWith("id: "))?.slice(4).trim();
          const payload = frame.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
          if (payload) {
            const parsedSequence = eventId ? Number(eventId) : Number.NaN;
            sequence = Number.isFinite(parsedSequence) && parsedSequence > sequence ? parsedSequence : sequence + 1;
            onEvent(JSON.parse(payload) as RunStreamEvent, sequence);
          }
        }
        if (done) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}
