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
 * Idea Tree research, as the control plane exposes it.
 *
 * `GET /research` lists the session's researches, `POST /research` takes one
 * `operation` (`get`, `pause`, `continue`, `end`, …), and `…/research/:id/events`
 * is an SSE stream whose every frame is a whole `{ research, graph }` view — there is
 * no event id and no replay, so a reconnect refetches instead of resuming.
 *
 * Everything that can be absent stays absent: `usageKnown` false means the engine has
 * not reported tokens, which is not the same as zero, and a node with no `stages`
 * entry has not been designed yet, which is not a score of 0.
 */

import type { IdeaResearchState, IdeaResearchView, IdeaTreeGraph } from "@sciencediscovery/schema";
import type { ApiClient } from "./client.js";
import { SseFrameDecoder } from "./stream.js";

export interface IdeaResearchList {
  items: IdeaResearchView[];
}

/** The list route answers with `{ items }`; older engines answer with a bare view. */
function viewsOf(payload: IdeaResearchList | IdeaResearchView | IdeaResearchState): IdeaResearchView[] {
  if (Array.isArray((payload as IdeaResearchList).items)) return (payload as IdeaResearchList).items;
  if ((payload as IdeaResearchView).research) return [payload as IdeaResearchView];
  if ((payload as IdeaResearchState).id) return [{ research: payload as IdeaResearchState, graph: emptyGraph() }];
  return [];
}

function emptyGraph(): IdeaTreeGraph {
  return { edges: [], nodes: [], objective: "", revision: 0, treeId: "", updatedAt: "" };
}

export async function listIdeaResearches(client: ApiClient, sessionId: string): Promise<IdeaResearchView[]> {
  const payload = await client.request<IdeaResearchList | IdeaResearchView | IdeaResearchState>(
    `/api/sessions/${encodeURIComponent(sessionId)}/idea-tree/research`,
  );
  return viewsOf(payload);
}

export async function getIdeaResearch(client: ApiClient, sessionId: string, researchId: string): Promise<IdeaResearchView> {
  return await client.request<IdeaResearchView>(`/api/sessions/${encodeURIComponent(sessionId)}/idea-tree/research`, {
    method: "POST",
    body: JSON.stringify({ operation: "get", researchId }),
  });
}

export type IdeaResearchControl = "pause" | "continue" | "end";

/** Pause, continue or end one research. The engine answers with the new view. */
export async function controlIdeaResearch(
  client: ApiClient,
  sessionId: string,
  researchId: string,
  operation: IdeaResearchControl,
): Promise<IdeaResearchView> {
  return await client.request<IdeaResearchView>(`/api/sessions/${encodeURIComponent(sessionId)}/idea-tree/research`, {
    method: "POST",
    body: JSON.stringify({ operation, researchId }),
  });
}

/** A legacy tree: the graph route answers `{ graph, hasIdeaTreeRun, treeIds }`. */
export interface IdeaTreeGraphResponse {
  graph: IdeaTreeGraph | null;
  hasIdeaTreeRun: boolean;
  treeIds: string[];
}

export async function getIdeaTreeGraph(client: ApiClient, sessionId: string, treeId?: string): Promise<IdeaTreeGraphResponse> {
  const query = treeId ? `?tree_id=${encodeURIComponent(treeId)}` : "";
  return await client.request<IdeaTreeGraphResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/idea-tree/graph${query}`);
}

/**
 * Follow one research until its stream closes.
 *
 * The server closes the stream once the status is no longer `running`/`pausing`, and
 * each frame carries the full view, so the last frame is the resting state — no
 * replay request is needed on reconnect, a refetch is.
 */
export async function subscribeIdeaResearchEvents(
  client: ApiClient,
  sessionId: string,
  researchId: string,
  onView: (view: IdeaResearchView) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await client.fetchStream(
    `/api/sessions/${encodeURIComponent(sessionId)}/idea-tree/research/${encodeURIComponent(researchId)}/events`,
    { headers: { accept: "text/event-stream" }, ...(signal ? { signal } : {}) },
  );
  if (!response.body) throw new Error("The Idea Tree stream has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames = new SseFrameDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      const decoded = frames.push(decoder.decode(value, { stream: !done }));
      for (const frame of done ? [...decoded, ...frames.flush()] : decoded) {
        // A torn frame is stepped over: the next one carries a whole view again.
        try { onView(JSON.parse(frame.data) as IdeaResearchView); } catch { /* skip */ }
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}
