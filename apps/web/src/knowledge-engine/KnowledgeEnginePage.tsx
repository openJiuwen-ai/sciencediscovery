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

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

import type { ApiClient } from "../api/client.js";
import type {
  KeDocument,
  KeEntityDetail,
  KeGraph,
  KeGraphRoots,
  KeGrowStatus,
  KeJob,
  KeKb,
} from "../api/knowledge-engine.js";
import { KeGraphCanvas } from "./KeGraphCanvas.js";
import { KeGrowPanel } from "./KeGrowPanel.js";
import { KeRootsView } from "./KeRootsView.js";

export interface KnowledgeEnginePageProps {
  client: ApiClient;
  onClose: () => void;
}

const OVERLAY_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: "var(--z-overlay-high, 60)" as unknown as number,
  display: "flex",
  flexDirection: "column",
  background: "var(--bg, #ffffff)",
};

const SIDEBAR_STYLE: CSSProperties = {
  width: 260,
  borderRight: "1px solid #e2e8f0",
  padding: 12,
  overflowY: "auto",
  flexShrink: 0,
};

const POLL_INTERVAL_MS = 2_500;
/** Consecutive fully/partially failed refresh rounds before the poll chain
 *  gives up and surfaces a hard error (transient SQLite BUSY etc. must never
 *  kill the chain — see qa P2 poll-chain death). */
const MAX_CONSECUTIVE_REFRESH_FAILURES = 8;

/**
 * Knowledge Engine page: KB management (create/seed), ingestion job status,
 * the force-directed entity graph, and entity details with verbatim evidence.
 * Mounted as a full-page overlay (same pattern as MemoryGraphExplorer).
 */
export function KnowledgeEnginePage({ client, onClose }: KnowledgeEnginePageProps) {
  const [kbs, setKbs] = useState<KeKb[]>([]);
  const [activeKbId, setActiveKbId] = useState<string | undefined>(undefined);
  const [graph, setGraph] = useState<KeGraph>({ entities: [], edges: [] });
  const [documents, setDocuments] = useState<KeDocument[]>([]);
  const [jobs, setJobs] = useState<KeJob[]>([]);
  const [growStatus, setGrowStatus] = useState<KeGrowStatus | undefined>(undefined);
  const [roots, setRoots] = useState<KeGraphRoots | undefined>(undefined);
  // Progressive drill-down: null = community bubbles (when the graph has
  // communities), "all" = full graph, number = one community's members.
  const [drill, setDrill] = useState<number | "all" | null>(null);
  const [selectedEntityId, setSelectedEntityId] = useState<string | undefined>(undefined);
  const [detail, setDetail] = useState<KeEntityDetail | undefined>(undefined);
  const [newKbName, setNewKbName] = useState("");
  const [seedQuery, setSeedQuery] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  // Non-banner hint for transient per-endpoint refresh failures (a BUSY graph
  // query must not look fatal and must not freeze the rest of the panel).
  const [transientIssue, setTransientIssue] = useState<string | undefined>(undefined);
  // Bumped by local actions (seed, grow start) to re-arm the poll chain when
  // it had stopped (no active jobs) — a plain refresh alone would leave the
  // recursive timeout dead and the grow progress frozen.
  const [pollNonce, setPollNonce] = useState(0);

  // Stale-response guards: a refresh that resolves after the user switched
  // KBs (or after unmount) must not land.
  const activeKbIdRef = useRef(activeKbId);
  activeKbIdRef.current = activeKbId;
  const jobsRef = useRef<KeJob[]>([]);
  jobsRef.current = jobs;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reportError = useCallback((loadError: unknown) => {
    if (mountedRef.current) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  const refreshKbs = useCallback(async () => {
    try {
      const result = await client.listKeKbs();
      if (!mountedRef.current) return;
      setKbs(result.kbs);
      setActiveKbId((current) => current ?? result.kbs[0]?.id);
      setError(undefined);
    } catch (loadError) {
      reportError(loadError);
    }
  }, [client, reportError]);

  // Per-endpoint isolation (allSettled): one transient failure (e.g. a slow
  // graph query hitting SQLite BUSY) must not discard the other three
  // sections — that fail-closed round was what froze the panel on empty.
  // Returns the number of failed endpoints so the poll chain can apply a
  // failure grace window instead of dying on a stale (empty) jobs list.
  const refreshKbData = useCallback(async (kbId: string): Promise<number> => {
    const [graphResult, documentsResult, jobsResult, growResult, rootsResult] = await Promise.allSettled([
      client.getKeGraph(kbId),
      client.listKeDocuments(kbId),
      client.listKeJobs(kbId),
      client.getKeGrow(kbId),
      client.getKeGraphRoots(kbId),
    ]);
    // Drop the response if the user switched KBs (or left) mid-flight.
    if (!mountedRef.current || activeKbIdRef.current !== kbId) return 0;
    const failed: string[] = [];
    if (graphResult.status === "fulfilled") setGraph(graphResult.value); else failed.push("graph");
    if (documentsResult.status === "fulfilled") setDocuments(documentsResult.value.documents); else failed.push("documents");
    if (jobsResult.status === "fulfilled") setJobs(jobsResult.value.jobs); else failed.push("jobs");
    if (growResult.status === "fulfilled") setGrowStatus(growResult.value); else failed.push("grow");
    if (rootsResult.status === "fulfilled") setRoots(rootsResult.value); else failed.push("roots");
    if (failed.length === 0) {
      setTransientIssue(undefined);
      setError(undefined);
    } else {
      setTransientIssue(`refresh partially failed (${failed.join(", ")}) — retrying`);
    }
    return failed.length;
  }, [client]);

  useEffect(() => {
    void refreshKbs();
  }, [refreshKbs]);

  // Recursive-timeout poll chain: one refresh, then re-arm while jobs are
  // active (read through the ref, so the chain never re-triggers itself on
  // state updates). Failed rounds get a grace window: the chain keeps polling
  // until MAX_CONSECUTIVE_REFRESH_FAILURES in a row, so a transient error can
  // never strand the panel on stale data (the original chain read the stale
  // empty jobsRef after a failed round and died permanently).
  useEffect(() => {
    if (!activeKbId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let consecutiveFailures = 0;
    const loop = async () => {
      const failed = await refreshKbData(activeKbId);
      if (cancelled) return;
      consecutiveFailures = failed > 0 ? consecutiveFailures + 1 : 0;
      if (consecutiveFailures >= MAX_CONSECUTIVE_REFRESH_FAILURES) {
        setTransientIssue(undefined);
        reportError(new Error("refresh keeps failing — polling stopped; use Seed/Grow to retry"));
        return;
      }
      const hasActive = jobsRef.current.some((job) => job.status === "pending" || job.status === "running");
      if (hasActive || consecutiveFailures > 0) {
        timer = setTimeout(() => void loop(), POLL_INTERVAL_MS);
      }
    };
    void loop();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeKbId, pollNonce, refreshKbData, reportError]);

  // Manual refresh trigger after local actions (seed, grow start): bumping
  // the nonce re-runs the poll effect above, which refreshes immediately AND
  // re-arms the chain if it had stopped.
  const kickRefresh = useCallback(() => {
    setPollNonce((nonce) => nonce + 1);
  }, []);

  useEffect(() => {
    if (!selectedEntityId) {
      setDetail(undefined);
      return;
    }
    let cancelled = false;
    void client.getKeEntity(selectedEntityId).then((result) => {
      if (!cancelled) setDetail(result);
    }).catch(() => {
      if (!cancelled) setDetail(undefined);
    });
    return () => {
      cancelled = true;
    };
  }, [client, selectedEntityId]);

  const activeKb = kbs.find((kb) => kb.id === activeKbId);
  const activeJobs = jobs.filter((job) => job.status === "pending" || job.status === "running");

  // Drill-down view model: the community being inspected (if any) and the
  // graph filtered to its members.
  const drilledCommunity = typeof drill === "number" ? roots?.communities.find((c) => c.id === drill) : undefined;
  const visibleGraph: KeGraph = (() => {
    if (typeof drill !== "number") return graph;
    const memberIds = new Set(
      graph.entities.filter((entity) => entity.communityId === drill).map((entity) => entity.id),
    );
    return {
      entities: graph.entities.filter((entity) => memberIds.has(entity.id)),
      edges: graph.edges.filter((edge) => memberIds.has(edge.srcId) && memberIds.has(edge.dstId)),
    };
  })();
  // Roots view only when there is something meaningful to cluster.
  const showRoots = drill === null && roots !== undefined && roots.communities.length > 1;

  return (
    <div style={OVERLAY_STYLE} data-testid="knowledge-engine-page">
      <header style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderBottom: "1px solid #e2e8f0" }}>
        <strong>Knowledge Engine</strong>
        <span style={{ color: "#64748b", fontSize: 13 }}>{activeKb ? activeKb.name : "no knowledge base selected"}</span>
        {transientIssue ? (
          <span data-testid="ke-transient-issue" style={{ color: "#b45309", fontSize: 12 }}>{transientIssue}</span>
        ) : null}
        <span style={{ flex: 1 }} />
        <button type="button" onClick={onClose}>Close</button>
      </header>
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <aside style={SIDEBAR_STYLE}>
          <section>
            <h4 style={{ margin: "4px 0" }}>Knowledge bases</h4>
            {kbs.map((kb) => (
              <button
                key={kb.id}
                type="button"
                data-testid={`ke-kb-${kb.id}`}
                onClick={() => {
                  setActiveKbId(kb.id);
                  setSelectedEntityId(undefined);
                  setDrill(null);
                  setRoots(undefined);
                }}
                style={{
                  display: "block", width: "100%", textAlign: "left", margin: "4px 0", padding: 8,
                  border: kb.id === activeKbId ? "2px solid #2563eb" : "1px solid #e2e8f0", borderRadius: 6, background: "#fff",
                }}
              >
                <div style={{ fontWeight: 600 }}>{kb.name}</div>
                <div style={{ fontSize: 12, color: "#64748b" }}>
                  {kb.stats ? `${kb.stats.entities} entities · ${kb.stats.documentsReady}/${kb.stats.documents} docs` : ""}
                </div>
              </button>
            ))}
            <div style={{ marginTop: 12 }}>
              <input
                aria-label="new kb name"
                placeholder="New KB name"
                value={newKbName}
                onChange={(event) => setNewKbName(event.target.value)}
                style={{ width: "100%", marginBottom: 6 }}
              />
              <button
                type="button"
                data-testid="ke-create-kb"
                disabled={!newKbName.trim()}
                onClick={() => {
                  void client.createKeKb(newKbName.trim()).then(() => {
                    setNewKbName("");
                    return refreshKbs();
                  }).catch(reportError);
                }}
              >
                Create
              </button>
            </div>
          </section>
          {activeKbId ? (
            <section style={{ marginTop: 20 }}>
              <h4 style={{ margin: "4px 0" }}>Seed papers</h4>
              <input
                aria-label="seed query"
                placeholder='e.g. "Ebola glycoprotein antibody"'
                value={seedQuery}
                onChange={(event) => setSeedQuery(event.target.value)}
                style={{ width: "100%", marginBottom: 6 }}
              />
              <button
                type="button"
                data-testid="ke-seed"
                disabled={!seedQuery.trim()}
                onClick={() => {
                  void client.seedKeKb(activeKbId, seedQuery.trim(), 10).then(kickRefresh).catch(reportError);
                }}
              >
                Seed 10 papers
              </button>
              <KeGrowPanel client={client} kbId={activeKbId} status={growStatus} onChanged={kickRefresh} onError={reportError} />
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  data-testid="ke-resolve"
                  title="Batch entity resolution (offline track; honors the SCIENCE_AGENT_KE_ENTITY_RESOLUTION mode switch)"
                  onClick={() => {
                    void client.startKeResolution(activeKbId).then(kickRefresh).catch(reportError);
                  }}
                >
                  Resolve duplicate entities
                </button>
              </div>
              <h4 style={{ margin: "16px 0 4px" }}>Jobs</h4>
              <div data-testid="ke-job-status" style={{ fontSize: 12, color: "#475569" }}>
                {jobs.length === 0 ? "no jobs yet" : null}
                {activeJobs.length > 0 ? <div>{activeJobs.length} active</div> : null}
                {jobs.slice(0, 8).map((job) => (
                  <div key={job.id}>
                    {job.type}: {job.status}{job.error ? ` — ${job.error.slice(0, 60)}` : ""}
                  </div>
                ))}
              </div>
              <h4 style={{ margin: "16px 0 4px" }}>Documents</h4>
              <div data-testid="ke-documents" style={{ fontSize: 12, color: "#475569" }}>
                {documents.map((doc) => (
                  <div key={doc.id} title={doc.title}>
                    {doc.status === "ready" ? "✓" : doc.status === "error" ? "✗" : "…"} {doc.title.slice(0, 40) || doc.id.slice(0, 8)}
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </aside>
        <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          {error ? <div role="alert" style={{ padding: 8, color: "#b91c1c" }}>{error}</div> : null}
          {graph.entities.length > 0 ? (
            <div
              data-testid="ke-breadcrumb"
              style={{ padding: "6px 12px", borderBottom: "1px solid #e2e8f0", fontSize: 13, color: "#475569", display: "flex", gap: 8, alignItems: "center" }}
            >
              <button type="button" data-testid="ke-breadcrumb-roots" onClick={() => setDrill(null)} disabled={drill === null}>
                Communities
              </button>
              <button type="button" data-testid="ke-breadcrumb-all" onClick={() => setDrill("all")} disabled={drill === "all"}>
                Full graph
              </button>
              {drilledCommunity ? (
                <span>
                  › <strong>{drilledCommunity.name}</strong> ({drilledCommunity.size} entities)
                </span>
              ) : null}
            </div>
          ) : null}
          <div style={{ flex: 1, minHeight: 0 }}>
            {graph.entities.length === 0 ? (
              <div style={{ padding: 40, color: "#94a3b8" }} data-testid="ke-graph-empty">
                {activeKb ? "No entities yet — seed papers to build the graph." : "Create or select a knowledge base."}
              </div>
            ) : showRoots && roots ? (
              <KeRootsView
                roots={roots}
                onSelectCommunity={(communityId) => {
                  setDrill(communityId);
                  setSelectedEntityId(undefined);
                }}
              />
            ) : visibleGraph.entities.length > 0 ? (
              <KeGraphCanvas graph={visibleGraph} onSelect={setSelectedEntityId} selectedId={selectedEntityId} />
            ) : (
              <div style={{ padding: 40, color: "#94a3b8" }} data-testid="ke-community-empty">
                This community has no member entities in the current graph snapshot — the partition may be
                refreshing. Back to communities in a moment.
              </div>
            )}
          </div>
          {detail ? (
            <section data-testid="ke-entity-detail" style={{ borderTop: "1px solid #e2e8f0", padding: 12, maxHeight: 220, overflowY: "auto" }}>
              <strong>{detail.entity.name}</strong>
              <span style={{ marginLeft: 8, fontSize: 12, color: "#64748b" }}>
                {detail.entity.type} · support {detail.entity.supportCount}
                {detail.entity.aliases.length > 0 ? ` · aka ${detail.entity.aliases.join(", ")}` : ""}
              </span>
              {detail.entity.description ? <p style={{ margin: "6px 0", fontSize: 13 }}>{detail.entity.description}</p> : null}
              <div style={{ fontSize: 12, color: "#475569" }}>
                {detail.evidence.map((item) => (
                  <div key={item.edgeId} style={{ margin: "6px 0" }}>
                    <em>{item.type}</em> — “{item.quote}”
                    {item.docTitle ? <span style={{ color: "#94a3b8" }}> ({item.docTitle})</span> : null}
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </main>
      </div>
    </div>
  );
}
