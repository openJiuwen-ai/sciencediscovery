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
  ExecutionRun,
  RunStreamEvent,
  SessionUsageSummary,
  GlobalModelUsageSummary,
  SessionRun,
  SessionRunEvent,
  RuntimeStatus,
  SendMessageRequest,
  PromptManifest,
} from "@science-agent/schema";

import { SessionsApiClient } from "./sessions.js";

export class RunsApiClient extends SessionsApiClient {
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

  listRuns(sessionId: string): Promise<SessionRun[]> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/runs`);
  }

  createRun(sessionId: string, body: SendMessageRequest): Promise<SessionRun> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/runs`, {
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
    onEvent: (event: RunStreamEvent, sequence: number) => void,
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
      throw new Error(error.error || `Event stream failed (${response.status})`);
    }
    if (!response.body) throw new Error("Event stream has no body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sequence = after;
    while (true) {
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
          sequence = Number.isFinite(parsedSequence) && parsedSequence > sequence ? parsedSequence : sequence + 1;
          onEvent(JSON.parse(payload) as RunStreamEvent, sequence);
        }
      }
      if (done) break;
    }
  }

  cancelCurrentRun(sessionId: string): Promise<CancelRunResult> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/runs/current/cancel`, {
      method: "POST",
    });
  }

  async streamMessage(
    sessionId: string,
    body: SendMessageRequest,
    onEvent: (event: RunStreamEvent, sequence: number) => void,
    signal?: AbortSignal,
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
      throw new Error(error.error || `Run failed (${response.status})`);
    }
    if (!response.body) throw new Error("Streaming response has no body");

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
          sequence = Number.isFinite(parsed) && parsed > sequence ? parsed : sequence + 1;
          onEvent(JSON.parse(payload) as RunStreamEvent, sequence);
        }
        if (done) break;
      }
    } finally {
      // Aborting the request errors the body stream; release the reader either way.
      await reader.cancel().catch(() => undefined);
    }
  }
}
