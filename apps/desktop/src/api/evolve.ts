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
 * `/api/evolve/*`: one search's status, its event log and its candidate text.
 *
 * The desktop reads the same control plane as `apps/web`. Three sources feed
 * one view — the run list, the event stream, and a candidate's source on
 * demand — and the stream is used for both a live search and a finished one,
 * because replaying the log is what makes a panel opened after the fact render
 * exactly like a panel that watched it happen.
 */

import type { EvolveEventRecord, EvolveRun } from "@sciencediscovery/schema";

import type { ApiClient } from "./client.js";
import { SseFrameDecoder } from "./stream.js";

export interface EvolveStatus {
  /** `installing` is a state of its own because the first start downloads and
   *  unpacks the engine; showing "not initialized" through those minutes
   *  would invite a second click that starts a second install. */
  canInitialize: boolean;
  error?: string;
  state: "error" | "installing" | "not_initialized" | "ready";
}

export function getEvolveStatus(client: ApiClient): Promise<EvolveStatus> {
  return client.request<EvolveStatus>("/api/evolve/status");
}

/** The first-run install. It resolves when the runtime reports ready, which
 *  can take minutes; the caller keeps its own pending state rather than
 *  inferring one from a status poll that has not moved yet. */
export function initEvolve(client: ApiClient): Promise<EvolveStatus> {
  return client.request<EvolveStatus>("/api/evolve/init", { method: "POST" });
}

export function listEvolveRuns(client: ApiClient, sessionId?: string): Promise<EvolveRun[]> {
  const query = sessionId === undefined ? "" : `?sessionId=${encodeURIComponent(sessionId)}`;
  return client.request<EvolveRun[]>(`/api/evolve/runs${query}`);
}

export function stopEvolveRun(client: ApiClient, runId: string): Promise<{ runId: string; stopping: boolean } | EvolveRun> {
  return client.request(`/api/evolve/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" });
}

/**
 * One candidate's text, by the hash the event stream carries.
 *
 * Fetched on demand: most candidates are never opened, and a search that
 * shipped every program it tried would put megabytes through the same channel
 * the progress uses. A hash the run never wrote answers 404; the caller shows
 * "source unavailable" rather than an empty diff that would read as "it
 * changed nothing".
 */
export function getEvolveCandidate(
  client: ApiClient,
  runId: string,
  codeHash: string,
): Promise<{ hash: string; source: string }> {
  return client.request(
    `/api/evolve/runs/${encodeURIComponent(runId)}/candidates/${encodeURIComponent(codeHash)}`,
  );
}

/**
 * Follow a run's events over SSE, resuming from `after`.
 *
 * The server replays the log first and only then attaches to the live feed, so
 * a panel opened on a long-running search catches up before it follows. The
 * frame's `id:` is the sequence, which is what a dropped connection would send
 * back as `?after=`.
 */
export async function subscribeEvolveEvents(
  client: ApiClient,
  runId: string,
  after: number,
  onRecord: (record: EvolveEventRecord) => void,
  signal?: AbortSignal,
  onSkipped?: (count: number) => void,
): Promise<void> {
  const response = await client.fetchStream(
    `/api/evolve/runs/${encodeURIComponent(runId)}/events?after=${after}`,
    {
      headers: { accept: "text/event-stream" },
      ...(signal ? { signal } : {}),
    },
  );
  if (!response.body) throw new Error("The evolve stream has no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames = new SseFrameDecoder();
  let skipped = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      const decoded = frames.push(decoder.decode(value, { stream: !done }));
      // The final chunk may end without the blank line that closes a frame.
      for (const frame of done ? [...decoded, ...frames.flush()] : decoded) {
        try {
          onRecord(JSON.parse(frame.data) as EvolveEventRecord);
        } catch {
          // A torn frame is counted and stepped over: the next one is usually
          // whole, and a reconnect resumes from the last sequence that arrived.
          skipped += 1;
        }
      }
      if (done) break;
    }
  } finally {
    // Aborting errors the body stream; release the reader either way.
    await reader.cancel().catch(() => undefined);
  }
  if (skipped > 0) onSkipped?.(skipped);
}
