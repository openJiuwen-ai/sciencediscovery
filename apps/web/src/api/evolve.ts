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

import type { EvolveEventRecord, EvolveGoal, EvolveRun, SearchGraphView } from "@sciencediscovery/schema";

import { SkillsApiClient } from "./skills.js";

/**
 * `/evolve` run control and its two event sources.
 *
 * `listEvents` and `subscribeEvents` return the same records — one from the log,
 * one live — because the dashboard must render identically whether it is
 * following a search or replaying a finished one. `getSearchGraph` is the third
 * source, a projection in Neo4j, and it is optional: with Science Memory off it
 * answers `memory_graph_disabled` and nothing else changes.
 */
export class EvolveApiClient extends SkillsApiClient {

  listEvolveRuns(sessionId?: string): Promise<EvolveRun[]> {
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
    return this.request(`/api/evolve/runs${query}`);
  }


  stopEvolveRun(runId: string): Promise<{ runId: string; stopping: boolean } | EvolveRun> {
    return this.request(`/api/evolve/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" });
  }

  listEvolveEvents(runId: string, after = 0): Promise<EvolveEventRecord[]> {
    return this.request(`/api/evolve/runs/${encodeURIComponent(runId)}/events?after=${after}`);
  }



  /**
   * One candidate's source, by the hash the event stream carries.
   *
   * Fetched on demand rather than streamed with the events: most candidates are
   * never opened, and a search that shipped every program it tried would put
   * megabytes of Python through the same channel the progress bar uses.
   */
  getEvolveCandidate(runId: string, codeHash: string): Promise<{ hash: string; source: string }> {
    return this.request(
      `/api/evolve/runs/${encodeURIComponent(runId)}/candidates/${encodeURIComponent(codeHash)}`,
    );
  }

  /** The retrospective source. Absent Science Memory this returns a `reason`
   *  and empty arrays — the dashboard reads the log instead and looks the same. */
  getSearchGraph(searchId: string, maxNodes?: number): Promise<SearchGraphView> {
    const query = maxNodes ? `?maxNodes=${maxNodes}` : "";
    return this.request(`/api/memory/search-graph/${encodeURIComponent(searchId)}${query}`);
  }

  /**
   * Follow a run's events over SSE, resuming from `after`.
   *
   * Mirrors `subscribeRunEvents`: the frame's `id:` carries the sequence, so a
   * dropped connection resumes from the last one delivered rather than replaying
   * the whole log.
   */
  async subscribeEvolveEvents(
    runId: string,
    after: number,
    onRecord: (record: EvolveEventRecord) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await fetch(`/api/evolve/runs/${encodeURIComponent(runId)}/events?after=${after}`, {
      headers: { accept: "text/event-stream", authorization: `Bearer ${this.token}` },
      signal,
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string };
      throw new Error(error.error || `Evolve event stream failed (${response.status})`);
    }
    if (!response.body) throw new Error("Evolve event stream has no body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const payload = frame
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n");
        if (!payload) continue;
        try {
          onRecord(JSON.parse(payload) as EvolveEventRecord);
        } catch {
          // A torn frame is dropped rather than taking the stream down; the
          // next reconnect replays from the last sequence that did arrive.
        }
      }
      if (done) break;
    }
  }
}
