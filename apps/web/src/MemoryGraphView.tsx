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

import { useEffect, useState } from "react";

import type { MemorySubgraph } from "@sciencediscovery/schema";

import type { ApiClient } from "./api.js";
import { useLocale } from "./i18n/LocaleProvider.js";
import { InfoIcon } from "./icons.js";

/** How often the thumbnail re-pulls the subgraph so it tracks live activity. */
const GRAPH_POLL_MS = 8_000;

interface MemoryGraphViewProps {
  client: ApiClient;
  onError: (message: string) => void;
  refreshKey: string;
  sessionId: string;
}

/** Statuses that count as "finished" for the completed-node badge. */
const DONE_STATUSES = new Set(["succeeded", "success", "completed", "done", "ok"]);

export function isNodeCompleted(node: { extra?: Record<string, unknown> }): boolean {
  const status = node.extra?.status;
  return typeof status === "string" && DONE_STATUSES.has(status.toLowerCase());
}

/**
 * Workspace-panel card: a status summary of the session's memory graph.
 * The card is non-interactive — it shows the health badge, node count, and a
 * hint pointing to the per-product "View chain" entry (the explorer itself is
 * opened from a product's preview, not from this card).
 */
export function MemoryGraphView({ client, onError, refreshKey, sessionId }: MemoryGraphViewProps) {
  const { t } = useLocale();
  const [subgraph, setSubgraph] = useState<MemorySubgraph | null>(null);
  const [health, setHealth] = useState<string>("unknown");
  // Bumped on a timer so the thumbnail keeps up with graph writes that do not
  // move refreshKey (the sidecar mirrors runs asynchronously).
  const [pollTick, setPollTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setPollTick((value) => value + 1), GRAPH_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    void client.getMemorySubgraph(sessionId)
      .then((result) => { if (active) setSubgraph(result); })
      .catch((error: Error) => { if (active) onError(error.message); });
    void client.getMemoryHealth()
      .then((result) => { if (active) setHealth(result.memoryGraph ?? "unknown"); })
      .catch(() => { if (active) setHealth("unknown"); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, pollTick, refreshKey, sessionId]);

  // A default-off feature should leave no footprint in the UI.
  if (health === "disabled") return null;
  if (!subgraph) return null;
  if (subgraph.reason === "memory_graph_disabled") return null;

  if (subgraph.reason === "memory_graph_unreachable" && !subgraph.nodes.length) {
    return <section className="memory-graph-view memory-graph-empty">
      <h3>Science Memory</h3>
      <p className="memory-graph-hint">
        Science Memory is enabled but Neo4j is not reachable. Start Neo4j, then open System Settings → Science Memory and set the Neo4j password.
      </p>
    </section>;
  }
  if (subgraph.reason && !subgraph.nodes.length) {
    return <section className="memory-graph-view memory-graph-empty">
      <h3>Science Memory</h3>
      <p className="memory-graph-hint">Science Memory is not available right now.</p>
    </section>;
  }
  if (!subgraph.nodes.length) {
    return <section className="memory-graph-view memory-graph-empty">
      <h3>Science Memory</h3>
      <p className="memory-graph-hint">No nodes yet. Run a task that produces an artifact to populate the graph.</p>
    </section>;
  }

  const completed = subgraph.nodes.filter((node) => isNodeCompleted(node)).length;

  return <section className="memory-graph-view">
    <header className="memory-graph-header">
      <h3>Science Memory</h3>
      <span className={health === "healthy" ? "memory-badge memory-badge-ok" : "memory-badge memory-badge-warn"}>{health}</span>
    </header>
    <p className="memory-graph-hint memory-graph-hint-row">
      <InfoIcon size={14} />
      <span>{t("memory.hint.chainEntry")}</span>
    </p>
    <p className="memory-thumb-meta memory-graph-stats">
      {subgraph.nodes.length} {t("memory.stats.nodes")} · {subgraph.edges.length} {t("memory.stats.edges")}
      {completed ? <em className="memory-thumb-done">✓ {completed} {t("memory.stats.done")}</em> : null}
    </p>
  </section>;
}
