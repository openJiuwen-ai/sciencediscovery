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
 * is an SSE stream. There is no event id and no replay, so a reconnect refetches
 * instead of resuming.
 *
 * A stream frame is not a whole view: it carries the research state and only the
 * graph changes since the frame before it, with the first frame of every stream
 * carrying the whole tree. `applyIdeaResearchFrame` folds those frames into the
 * view a consumer already holds; a frame it cannot apply means frames were lost,
 * and the subscription refetches a whole view instead of showing a tree with holes.
 *
 * Everything that can be absent stays absent: `usageKnown` false means the engine has
 * not reported tokens, which is not the same as zero, and a node with no `stages`
 * entry has not been designed yet, which is not a score of 0.
 */

import type { IdeaResearchFrame, IdeaResearchState, IdeaResearchView, IdeaTreeGraph } from "@sciencediscovery/schema";
import { applyIdeaResearchFrame, reconcileIdeaResearchFrame } from "@sciencediscovery/schema";
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
 * the last frame it sends carries that resting state — no replay request is needed on
 * reconnect, a refetch is. Frames arrive as deltas after the first one, so they are
 * merged into the view held here rather than handed to `onView` one by one.
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
  /** The tree as this stream has built it. It starts empty, because the first frame
   *  of a stream is the whole tree. */
  let view: IdeaResearchView | undefined;
  const apply = async (frame: IdeaResearchFrame) => {
    const merged = applyIdeaResearchFrame(view, frame);
    if (merged !== undefined) return merged;
    // A delta the held tree is too old for means frames were lost (a torn frame, or
    // one the server wrote while the connection stalled). One whole view answers
    // that, and it is newer than the frame that exposed the gap: the read wins.
    const restored = await getIdeaResearch(client, sessionId, researchId);
    return reconcileIdeaResearchFrame(restored, frame);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      const decoded = frames.push(decoder.decode(value, { stream: !done }));
      for (const frame of done ? [...decoded, ...frames.flush()] : decoded) {
        let payload: IdeaResearchFrame;
        // A torn frame is stepped over: the frame after it no longer applies, and
        // that gap is what fetches a whole view.
        try { payload = JSON.parse(frame.data) as IdeaResearchFrame; } catch { continue; }
        const next = await apply(payload);
        if (next === undefined) continue;
        view = next;
        onView(next);
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}
