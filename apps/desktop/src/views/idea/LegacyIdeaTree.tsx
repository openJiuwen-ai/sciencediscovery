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
 * A pre-research Idea Tree, read-only.
 *
 * Sessions created before the research API carry their tree on the legacy graph
 * route (`GET /api/sessions/:id/idea-tree/graph`), which returns the graph and a
 * flag saying a tree run happened. There is nothing to control there — no
 * research id, no stream, no lifecycle — so this surface only draws what the
 * route returned and lets a node be read. It never starts, retries or resumes
 * anything, which is the same rule the research panel keeps.
 */

import { useCallback, useEffect, useState } from "react";
import type { IdeaTreeGraph, IdeaTreeNode } from "@sciencediscovery/schema";
import type { ApiClient } from "../../api/client.js";
import { ApiRequestError } from "../../api/client.js";
import { getIdeaTreeGraph } from "../../api/idea-tree.js";
import { TEXT } from "../../text.js";
import { IdeaNodeDetail, IdeaTreeView } from "./IdeaTree.js";

const t = TEXT.ideaTree;

export interface LegacyIdeaTreeState {
  graph?: IdeaTreeGraph;
  loading: boolean;
  error?: string;
}

/**
 * The legacy tree, when the session has one and no research does.
 *
 * `enabled` is what keeps this off the ordinary path: a session with researches
 * is described by them, and asking the legacy route as well would only add a
 * request whose answer is ignored. A 503 is a prerequisite, not an empty tree,
 * so it is reported instead of being read as "no legacy tree here".
 */
export function useLegacyIdeaTree(client: ApiClient, sessionId: string | undefined, enabled: boolean): LegacyIdeaTreeState {
  const [state, setState] = useState<LegacyIdeaTreeState>({ loading: false });
  const load = useCallback(async (signal: { cancelled: boolean }) => {
    if (!sessionId || !enabled) {
      setState({ loading: false });
      return;
    }
    setState({ loading: true });
    try {
      const response = await getIdeaTreeGraph(client, sessionId);
      if (signal.cancelled) return;
      setState({ graph: response.graph ?? undefined, loading: false });
    } catch (reason: unknown) {
      if (signal.cancelled) return;
      setState({ loading: false, error: reason instanceof ApiRequestError && reason.status === 503 ? t.unavailable : reason instanceof Error ? reason.message : String(reason) });
    }
  }, [client, enabled, sessionId]);

  useEffect(() => {
    const signal = { cancelled: false };
    void load(signal);
    return () => { signal.cancelled = true; };
  }, [load]);

  return state;
}

export function LegacyIdeaCard({ graph, onOpen }: { graph: IdeaTreeGraph; onOpen: () => void }) {
  return (
    <button className="evolve-run-card idea-run-card is-legacy" onClick={onOpen} type="button">
      <span aria-hidden="true" className="evolve-run-mark"><span className="idea-legacy-dot" /></span>
      <span className="evolve-run-text">
        <span className="evolve-run-title">{t.legacyCard}</span>
        <span className="evolve-run-meta"><span>{t.legacyHint}</span></span>
      </span>
      <span className="evolve-run-state is-quiet">{t.legacyCount(graph.nodes.length)}</span>
    </button>
  );
}

/** The legacy tree in the task tab: the drawing, one node's detail, no controls. */
export function LegacyIdeaTreePanel({ graph, onClose }: { graph: IdeaTreeGraph; onClose?: () => void }) {
  const [selectedId, setSelectedId] = useState<string>();
  const selected: IdeaTreeNode | undefined = selectedId === undefined
    ? undefined
    : graph.nodes.find((node) => node.id === selectedId);
  return (
    <section className="idea-panel" aria-label={t.detail.tree}>
      <header className="idea-panel-header">
        <div>
          <span className="eyebrow">{t.legacyCard}</span>
          <h2>{graph.objective || t.detail.tree}</h2>
        </div>
        {onClose ? <button aria-label={TEXT.settings.close} className="icon-button" onClick={onClose} type="button">×</button> : null}
      </header>
      <p className="idea-panel-reason">{t.legacyHint}</p>
      <div className="idea-panel-body">
        <IdeaTreeView graph={graph} onSelect={(node) => setSelectedId(node.id)} selectedId={selectedId} />
        {selected ? <IdeaNodeDetail node={selected} /> : null}
      </div>
    </section>
  );
}
