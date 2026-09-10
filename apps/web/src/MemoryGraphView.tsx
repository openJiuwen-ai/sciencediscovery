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

/** Poll cadence: fast while a run is active (the graph is changing), slow
 *  when idle (just enough to catch async sidecar writes). True realtime needs
 *  a backend `graph.changed` SSE event — TODO(P2), see design doc §7. */
const GRAPH_POLL_ACTIVE_MS = 1_500;
const GRAPH_POLL_IDLE_MS = 8_000;

/** Statuses that count as "finished" for the completed-node badge. */
const DONE_STATUSES = new Set(["succeeded", "success", "completed", "done", "ok"]);

export function isNodeCompleted(node: { extra?: Record<string, unknown> }): boolean {
  const status = node.extra?.status;
  return typeof status === "string" && DONE_STATUSES.has(status.toLowerCase());
}

interface MemoryGraphViewProps {
  /** Polled by the parent via `useMemorySubgraph` and shared with the explorer. */
  subgraph: MemorySubgraph | null;
  health: string;
  /** Open the full-screen explorer. The whole card is clickable. */
  onOpenExplorer: () => void;
}

/**
 * A node that ended by cancellation (status === "cancelled", PR1's
 * failure_reason="aborted"). Counted separately from completed so the
 * done-badge can split `✓ N done · ⊘ M cancelled` (doc16 §2.5) — cancelled
 * work is terminal-but-failed, neither pending nor succeeded.
 */
export function isNodeCancelled(node: { extra?: Record<string, unknown> }): boolean {
  const status = node.extra?.status;
  return typeof status === "string" && status.toLowerCase() === "cancelled";
}

/**
 * Polls the session's memory subgraph + health so the right-rail card and the
 * full-screen explorer share one snapshot. The cadence adapts: fast (1.5s)
 * while a run is active so the thumbnail tracks live graph writes, slow (8s)
 * when idle to catch async sidecar writes without busy-looping. True realtime
 * needs a backend `graph.changed` SSE event — TODO(P2), design doc §7. Both
 * consumers reuse this so the explorer never re-fetches what the card has.
 */
export function useMemorySubgraph(
  client: ApiClient,
  sessionId: string | undefined,
  refreshKey: string,
  onError: (message: string) => void,
  active: boolean,
): { subgraph: MemorySubgraph | null; health: string } {
  const [subgraph, setSubgraph] = useState<MemorySubgraph | null>(null);
  const [health, setHealth] = useState<string>("unknown");
  // Bumped on a timer so the thumbnail keeps up with graph writes that do not
  // move refreshKey (the sidecar mirrors runs asynchronously).
  const [pollTick, setPollTick] = useState(0);

  // When `active` flips the cadence changes — the effect tears down and
  // re-arms with the new interval (no stale-timer drift).
  useEffect(() => {
    const interval = active ? GRAPH_POLL_ACTIVE_MS : GRAPH_POLL_IDLE_MS;
    const timer = setInterval(() => setPollTick((value) => value + 1), interval);
    return () => clearInterval(timer);
  }, [active]);

  useEffect(() => {
    // No session yet (landing view) → nothing to poll; leave the card absent.
    if (!sessionId) return;
    let alive = true;
    void client.getMemorySubgraph(sessionId)
      .then((result) => { if (alive) setSubgraph(result); })
      .catch((error: Error) => { if (alive) onError(error.message); });
    void client.getMemoryHealth()
      .then((result) => { if (alive) setHealth(result.memoryGraph ?? "unknown"); })
      .catch(() => { if (alive) setHealth("unknown"); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, pollTick, refreshKey, sessionId]);

  return { subgraph, health };
}

/**
 * Workspace-panel card: an interactive entry to the session's memory graph.
 * The whole card is clickable and opens the full-screen explorer; it shows a
 * health badge and node/edge counts so the user knows what they're opening
 * into. (The mini spine preview was tried and removed — it duplicated the big
 * canvas at a size too small to read; the default backbone view belongs in the
 * explorer itself, commit 2.)
 */
export function MemoryGraphView({ subgraph, health, onOpenExplorer }: MemoryGraphViewProps) {
  const { t } = useLocale();

  // A default-off feature should leave no footprint in the UI.
  if (health === "disabled") return null;
  if (!subgraph) return null;
  if (subgraph.reason === "memory_graph_disabled") return null;

  if (subgraph.reason === "memory_graph_unreachable" && !subgraph.nodes.length) {
    return <section className="memory-graph-view memory-graph-empty">
      <h3>ScienceMemory</h3>
      <p className="memory-graph-hint">
        {t("memory.view.neo4jUnreachable")}
      </p>
    </section>;
  }
  if (subgraph.reason && !subgraph.nodes.length) {
    return <section className="memory-graph-view memory-graph-empty">
      <h3>ScienceMemory</h3>
      <p className="memory-graph-hint">{t("memory.view.unavailable")}</p>
    </section>;
  }
  if (!subgraph.nodes.length) {
    return <section className="memory-graph-view memory-graph-empty">
      <h3>ScienceMemory</h3>
      <p className="memory-graph-hint">{t("memory.view.empty")}</p>
    </section>;
  }

  const completed = subgraph.nodes.filter((node) => isNodeCompleted(node)).length;
  const cancelled = subgraph.nodes.filter((node) => isNodeCancelled(node)).length;
  const open = () => onOpenExplorer();

  return <section className="memory-graph-view memory-graph-entry" onClick={open} role="button" tabIndex={0}
    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } }}>
    <header className="memory-graph-header">
      <h3>ScienceMemory</h3>
      <span className={health === "healthy" ? "memory-badge memory-badge-ok" : "memory-badge memory-badge-warn"}>{health}</span>
    </header>
    <p className="memory-thumb-meta memory-graph-stats">
      {subgraph.nodes.length} {t("memory.stats.nodes")} · {subgraph.edges.length} {t("memory.stats.edges")}
      {completed ? <em className="memory-thumb-done">✓ {completed} {t("memory.stats.done")}</em> : null}
      {cancelled ? <em className="memory-thumb-cancelled">⊘ {cancelled} {t("memory.stats.cancelled")}</em> : null}
    </p>
    <p className="memory-graph-hint memory-graph-hint-row">
      <InfoIcon size={14} />
      <span>{t("memory.hint.entryCard")}</span>
    </p>
  </section>;
}

