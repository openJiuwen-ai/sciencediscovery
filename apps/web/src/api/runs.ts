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

import type {
  CancelRunResult,
  CreateSkillEvolutionRunRequest,
  ExecutionRun,
  AgentShellExecution,
  WorkspaceTransfer,
  RunStreamEvent,
  SessionUsageSummary,
  GlobalModelUsageSummary,
  ModelUsageAnalyticsFilters,
  ModelUsageAnalyticsSummary,
  SessionRun,
  SessionRunEvent,
  RuntimeStatus,
  SendMessageRequest,
  PromptManifest,
} from "@sciencediscovery/schema";

import { translateActive } from "../i18n/index.js";
import { ApiRequestError } from "./auth.js";
import { SessionsApiClient } from "./sessions.js";

export interface AgentActivity {
  executions: AgentShellExecution[];
  transfers: WorkspaceTransfer[];
  timers: Array<{ id: string; agentId: string; dueAt: number; message: string; state: "pending" | "fired" | "cancelled" }>;
  agents: Array<{ agentId: string; stopped: boolean }>;
}

type UsageAnalyticsQueryFilters = ModelUsageAnalyticsFilters & {
  displayCurrency?: "CNY" | "USD";
  format?: string;
};

function usageAnalyticsQuery(filters: UsageAnalyticsQueryFilters): string {
  const params = new URLSearchParams();
  for (const key of ["from", "to", "projectId", "modelProfileId", "timeZone", "format", "displayCurrency"] as const) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

function runStreamFinished(event: RunStreamEvent): boolean {
  return ["run.completed", "run.failed", "run.cancelled"].includes(event.type)
    || event.type === "run.status" && ["completed", "failed", "cancelled", "interrupted"].includes(event.status);
}

function canRetryRunStream(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted || error instanceof Error && error.name === "AbortError") return false;
  return !(error instanceof ApiRequestError) || error.status >= 500 || [408, 429].includes(error.status);
}

function waitForRunStreamRetry(attempt: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, Math.min(250 * 2 ** attempt, 4000));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

export class RunsApiClient extends SessionsApiClient {
  getAgentActivity(sessionId: string): Promise<AgentActivity> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/agent-activity`);
  }
  executionLogs(sessionId: string, id: string): Promise<{ chunks: Array<{ text: string }> }> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/agent-activity/executions/${encodeURIComponent(id)}/logs`);
  }
  cancelActivity(sessionId: string, kind: "executions" | "transfers" | "timers", id: string): Promise<unknown> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/agent-activity/${kind}/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  }
  resumeSubagent(sessionId: string, id: string): Promise<unknown> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(id)}/resume`, { method: "POST" });
  }
  getRuntimeStatus(): Promise<RuntimeStatus> {
    return this.request("/api/runtime-status");
  }

  teardownKernel(kernelId: string): Promise<{ count: number; kernelId: string; reason: string }> {
    return this.request(`/api/runtime-status/kernels/${encodeURIComponent(kernelId)}/teardown`, { method: "POST" });
  }

  listExecutionRuns(sessionId: string): Promise<ExecutionRun[]> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/execution-runs`);
  }

  /** Read a CAS-addressed blob as UTF-8 text. The memory graph stores only
   *  CAS hashes on Code nodes (code_hash / stdout_hash / stderr_hash); the
   *  real bytes live in CAS and are served by `/api/cas/{hash}`. Returns text
   *  (not JSON) — use this, not `request`, which would `JSON.parse` the body. */
  readCas(hash: string): Promise<string> {
    return this.requestText(`/api/cas/${encodeURIComponent(hash)}`);
  }

  listPromptManifests(sessionId: string): Promise<PromptManifest[]> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/prompt-manifests`);
  }

  getSessionUsage(sessionId: string): Promise<SessionUsageSummary> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/usage`);
  }

  getGlobalModelUsage(): Promise<GlobalModelUsageSummary> {
    return this.request("/api/usage/models");
  }

  getModelUsageAnalytics(filters: ModelUsageAnalyticsFilters = {}): Promise<ModelUsageAnalyticsSummary> {
    return this.request(`/api/usage/analytics${usageAnalyticsQuery(filters)}`);
  }

  async exportModelUsageAnalytics(
    format: "csv" | "json",
    filters: UsageAnalyticsQueryFilters = {},
  ): Promise<Blob> {
    const response = await fetch(`/api/usage/analytics/export${usageAnalyticsQuery({ ...filters, format })}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) {
      this.reportAuthStatus(response.status);
      const error = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string };
      throw new ApiRequestError(error.error || translateActive("error.usageExportFailed", { status: response.status }), response.status);
    }
    return await response.blob();
  }

  listRuns(sessionId: string, signal?: AbortSignal): Promise<SessionRun[]> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/runs`, signal ? { signal } : {});
  }

  createRun(sessionId: string, body: SendMessageRequest): Promise<SessionRun> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/runs`, {
      body: JSON.stringify(body),
      method: "POST",
    });
  }

  createSkillEvolutionRun(
    sessionId: string,
    runId: string,
    body: CreateSkillEvolutionRunRequest = {},
  ): Promise<SessionRun> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/skill-evolution`, {
      body: JSON.stringify(body),
      method: "POST",
    });
  }

  cancelRun(sessionId: string, runId: string): Promise<SessionRun> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
    });
  }

  listRunEvents(sessionId: string, runId: string, after = 0): Promise<SessionRunEvent[]> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/events?after=${after}`);
  }

  listRunStreamEvents(sessionId: string, runId: string, streamId: string, after = 0): Promise<SessionRunEvent[]> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/streams/${encodeURIComponent(streamId)}/events?after=${after}`);
  }

  async subscribeRunEvents(
    sessionId: string,
    runId: string,
    after: number,
    onEvent: (event: RunStreamEvent, sequence?: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    let cursor = after;
    let terminal = false;
    let failures = 0;
    while (!terminal) {
      signal?.throwIfAborted();
      const previous = cursor;
      let failure: unknown = new Error(translateActive("error.resumeRunEvents"));
      try {
        await this.subscribeRunEventsOnce(sessionId, runId, cursor, (event, sequence) => {
          if (sequence !== undefined && sequence <= cursor) return;
          onEvent(event, sequence);
          if (sequence !== undefined) cursor = Math.max(cursor, sequence);
          terminal ||= runStreamFinished(event);
        }, signal);
      } catch (error) {
        if (terminal) return;
        if (!canRetryRunStream(error, signal)) throw error;
        failure = error;
      }
      if (terminal) return;
      signal?.throwIfAborted();
      // A normal EOF is only final when the persisted run is actually terminal.
      // Reconnect the accepted run, never submit the user's message again.
      try {
        const run = (await this.listRuns(sessionId, signal)).find(item => item.id === runId);
        if (run && ["completed", "failed", "cancelled", "interrupted"].includes(run.status)) return;
      } catch (error) {
        if (!canRetryRunStream(error, signal)) throw error;
      }
      failures = cursor > previous ? 0 : failures + 1;
      if (failures >= 5) throw failure;
      await waitForRunStreamRetry(failures, signal);
    }
  }

  private async subscribeRunEventsOnce(
    sessionId: string,
    runId: string,
    after: number,
    onEvent: (event: RunStreamEvent, sequence?: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/events?after=${after}`, {
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${this.token}`,
      },
      signal,
    });
    if (!response.ok) {
      this.reportAuthStatus(response.status);
      const error = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string };
      throw new ApiRequestError(error.error || translateActive("error.eventStreamFailed", { status: response.status }), response.status);
    }
    if (!response.body) throw new Error(translateActive("error.eventStreamNoBody"));
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sequence = after;
    try { while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const eventId = frame
          .split("\n")
          .find((line) => line.startsWith("id: "))
          ?.slice(4)
          .trim();
        const payload = frame
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n");
        if (payload) {
          const parsedSequence = eventId ? Number(eventId) : Number.NaN;
          if (Number.isFinite(parsedSequence)) sequence = Math.max(sequence, parsedSequence);
          // Child-stream payloads are multiplexed onto the live response but
          // deliberately have no main-stream id. Do not invent one: doing so
          // advances the replay cursor past main events that have not arrived.
          onEvent(JSON.parse(payload) as RunStreamEvent, Number.isFinite(parsedSequence) ? parsedSequence : undefined);
        }
      }
      if (done) break;
    } } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }

  cancelCurrentRun(sessionId: string): Promise<CancelRunResult> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/runs/current/cancel`, {
      method: "POST",
    });
  }

  async streamMessage(
    sessionId: string,
    body: SendMessageRequest,
    onEvent: (event: RunStreamEvent, sequence?: number) => void,
    signal?: AbortSignal,
    onAccepted?: (runId: string) => void,
  ): Promise<void> {
    let runId: string | undefined;
    let cursor = 0;
    let terminal = false;
    try {
      await this.streamMessageOnce(sessionId, body, (event, sequence) => {
        if (event.type === "run.queued" || event.type === "run.status") runId = event.run.id;
        else if (event.type === "run.started") runId = event.runId;
        onEvent(event, sequence);
        if (sequence !== undefined) cursor = Math.max(cursor, sequence);
        terminal ||= runStreamFinished(event);
      }, signal, acceptedRunId => { runId = acceptedRunId; onAccepted?.(acceptedRunId); });
    } catch (error) {
      if (terminal) return;
      if (!runId || !canRetryRunStream(error, signal)) throw error;
    }
    if (terminal) return;
    if (!runId) throw new Error(translateActive("error.streamNoBody"));
    await this.subscribeRunEvents(sessionId, runId, cursor, onEvent, signal);
  }

  private async streamMessageOnce(
    sessionId: string,
    body: SendMessageRequest,
    onEvent: (event: RunStreamEvent, sequence?: number) => void,
    signal?: AbortSignal,
    onAccepted?: (runId: string) => void,
  ): Promise<void> {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      method: "POST",
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      this.reportAuthStatus(response.status);
      const error = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string };
      throw new ApiRequestError(error.error || translateActive("error.runFailedStatus", { status: response.status }), response.status);
    }
    // The server commits the run before flushing these headers. Remember its
    // identity even if the first SSE frame is partial or never arrives.
    const acceptedRunId = response.headers.get("x-sciencediscovery-run-id");
    if (acceptedRunId) onAccepted?.(acceptedRunId);
    if (!response.body) throw new Error(translateActive("error.streamNoBody"));

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sequence = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const id = frame.split("\n").find((line) => line.startsWith("id: "))?.slice(4);
          const payload = frame
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n");
          if (!payload) continue;
          const parsed = Number(id);
          if (Number.isFinite(parsed)) sequence = Math.max(sequence, parsed);
          onEvent(JSON.parse(payload) as RunStreamEvent, Number.isFinite(parsed) ? parsed : undefined);
        }
        if (done) break;
      }
    } finally {
      // Aborting the request errors the body stream; release the reader either way.
      await reader.cancel().catch(() => undefined);
    }
  }
}
