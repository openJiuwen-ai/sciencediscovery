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
  /** The untitled session the backend creates alongside the project. */
  firstSession?: { id?: string; [key: string]: unknown };
  project?: { id?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** The thinking choices the session's effective model accepts. */
export interface SessionThinkingControls {
  efforts: string[];
  modelId?: string;
  modelName?: string;
  modes: string[];
  supported: boolean;
}

/** An evolve search record (`EvolveRun`), as `GET /api/evolve/runs` lists it. */
export interface EvolveRunRecord {
  id: string;
  status: string;
  sessionId: string;
  projectId?: string;
  algorithm?: string;
  candidates?: number;
  tokens?: number;
  costCents?: number;
  bestNodeIndex?: number;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  goal?: { statement?: string; budget?: { expansions?: number }; [key: string]: unknown };
  [key: string]: unknown;
}

/** One line of an evolve run's event log; `sequence` is the resume cursor. */
export interface EvolveEventRecord {
  createdAt: string;
  sequence: number;
  event: { type: string; [key: string]: unknown };
}

/** An Idea Tree research and its graph, as every research route returns it. */
export interface IdeaResearchView {
  research: {
    id: string;
    status: string;
    objective?: string;
    phase?: string;
    round?: number;
    batch?: string[];
    batchCompleted?: number;
    tokens?: number;
    usageKnown?: boolean;
    reason?: string | null;
    updatedAt?: string;
    settings?: { maxRounds?: number; [key: string]: unknown };
    activities?: Array<{
      role: string;
      nodeId: string | null;
      round: number;
      status: string;
      startedAt: string;
      finishedAt: string | null;
      error: string | null;
    }>;
    [key: string]: unknown;
  };
  graph: {
    nodes?: Array<{ id: string; kind?: string; status?: string; score?: number | null; hypothesis?: string; [key: string]: unknown }>;
    [key: string]: unknown;
  };
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

  /** GET /api/sessions/:id/thinking-controls — what the next run's model accepts. */
  getSessionThinkingControls(sessionId: string): Promise<SessionThinkingControls> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/thinking-controls`);
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

  /** GET /api/sessions/:id/usage — the same route the Web UI uses for usage. */
  getSessionUsage(sessionId: string): Promise<unknown> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/usage`);
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

  /** GET /api/evolve/runs, newest first; `sessionId` narrows it as the route allows. */
  listEvolveRuns(sessionId?: string): Promise<EvolveRunRecord[]> {
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
    return this.request(`/api/evolve/runs${query}`);
  }

  getEvolveCandidate(runId: string, codeHash: string): Promise<{ hash: string; source: string }> {
    return this.request(`/api/evolve/runs/${encodeURIComponent(runId)}/candidates/${encodeURIComponent(codeHash)}`);
  }

  /** The route the dashboard's Stop button calls: 202 while it winds down, or the run if already over. */
  stopEvolveRun(runId: string): Promise<{ runId: string; stopping: boolean } | EvolveRunRecord> {
    return this.request(`/api/evolve/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" });
  }

  listIdeaResearch(sessionId: string): Promise<{ items: IdeaResearchView[] }> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/idea-tree/research`);
  }

  /** The research card's control route: `get`, `pause`, `continue` and `end`. */
  ideaResearchCommand(sessionId: string, body: { operation: string; researchId: string }): Promise<IdeaResearchView> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/idea-tree/research`, {
      body: JSON.stringify(body),
      method: "POST",
    });
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
    const response = await this.openEventStream(
      `/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/events?after=${after}`,
      signal,
    );
    let sequence = after;
    await readEventStream(response, (payload, eventId) => {
      const parsedSequence = eventId ? Number(eventId) : Number.NaN;
      sequence = Number.isFinite(parsedSequence) && parsedSequence > sequence ? parsedSequence : sequence + 1;
      onEvent(JSON.parse(payload) as RunStreamEvent, sequence);
    });
  }

  /**
   * Follow an evolve run's log from `after`. The server replays what is on disk
   * first, then streams live, and ends the response once the run settles.
   */
  async subscribeEvolveEvents(
    runId: string,
    after: number,
    onRecord: (record: EvolveEventRecord) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.openEventStream(
      `/api/evolve/runs/${encodeURIComponent(runId)}/events?after=${after}`,
      signal,
    );
    await readEventStream(response, (payload) => {
      let record: EvolveEventRecord;
      try {
        record = JSON.parse(payload) as EvolveEventRecord;
      } catch {
        // A torn frame is dropped, as the dashboard does: the caller's cursor
        // still points before it, so the next connection delivers it again.
        return;
      }
      onRecord(record);
    });
  }

  /**
   * Follow an Idea Tree research. Every frame is the whole current view, not a
   * delta, and the server ends the response once the research stops running.
   */
  async subscribeIdeaResearch(
    sessionId: string,
    researchId: string,
    onView: (view: IdeaResearchView) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.openEventStream(
      `/api/sessions/${encodeURIComponent(sessionId)}/idea-tree/research/${encodeURIComponent(researchId)}/events`,
      signal,
    );
    await readEventStream(response, (payload) => onView(JSON.parse(payload) as IdeaResearchView));
  }

  private async openEventStream(path: string, signal?: AbortSignal): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: { accept: "text/event-stream", authorization: `Bearer ${this.token}` },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      if (response.status === 401) this.onAuthFailure?.();
      const error = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string; code?: string };
      throw new ApiRequestError(error.error || `Event stream failed (${response.status})`, response.status, error.code);
    }
    return response;
  }
}

/**
 * Split an SSE body into frames on `\n\n` and hand each frame's joined `data:`
 * payload and `id:` value to `onFrame`. Comment frames (keep-alives) carry no
 * data and are skipped.
 */
async function readEventStream(
  response: Response,
  onFrame: (payload: string, eventId: string | undefined) => void,
): Promise<void> {
  if (!response.body) throw new Error("Event stream has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const lines = frame.split("\n");
        const eventId = lines.find((line) => line.startsWith("id: "))?.slice(4).trim();
        const payload = lines.filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
        if (payload) onFrame(payload, eventId);
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
