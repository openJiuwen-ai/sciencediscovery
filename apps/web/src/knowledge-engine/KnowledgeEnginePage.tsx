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
import { useLocale, type MessageKey } from "../i18n/index.js";
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
  background: "var(--surface, #ffffff)",
  color: "var(--text, #0f172a)",
};

const HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 16px",
  borderBottom: "1px solid var(--border, #e2e8f0)",
  background: "var(--surface-subtle, #f8fafc)",
  flexShrink: 0,
};

const SIDEBAR_STYLE: CSSProperties = {
  width: 340,
  borderRight: "1px solid var(--border, #e2e8f0)",
  background: "var(--surface-subtle, #f8fafc)",
  padding: 12,
  overflowY: "auto",
  flexShrink: 0,
};

const SECTION_TITLE_STYLE: CSSProperties = {
  margin: "4px 0 8px",
  fontSize: 14,
  fontWeight: 600,
  color: "var(--text-heading, #0f172a)",
};

const EXPLAINER_STYLE: CSSProperties = {
  fontSize: 12,
  color: "var(--text-secondary, #475569)",
  lineHeight: 1.6,
  margin: "0 0 8px",
};

const PRIMARY_BUTTON_STYLE: CSSProperties = {
  fontSize: 13,
  padding: "6px 14px",
  borderRadius: "var(--radius-m, 6px)",
  border: "1px solid var(--accent, #2563eb)",
  background: "var(--accent, #2563eb)",
  color: "var(--accent-ink, #ffffff)",
  cursor: "pointer",
};

const GHOST_BUTTON_STYLE: CSSProperties = {
  fontSize: 13,
  padding: "6px 14px",
  borderRadius: "var(--radius-m, 6px)",
  border: "1px solid var(--border, #e2e8f0)",
  background: "transparent",
  color: "var(--text-secondary, #475569)",
  cursor: "pointer",
};

const INPUT_STYLE: CSSProperties = {
  width: "100%",
  fontSize: 13,
  padding: "6px 8px",
  borderRadius: "var(--radius-m, 6px)",
  border: "1px solid var(--border, #e2e8f0)",
  background: "var(--surface, #ffffff)",
  color: "var(--text, #0f172a)",
  boxSizing: "border-box",
};

const COUNTS_BADGE_STYLE: CSSProperties = {
  position: "absolute",
  top: 12,
  right: 12,
  zIndex: 5,
  fontSize: 12,
  color: "var(--text-secondary, #475569)",
  background: "var(--surface, #ffffff)",
  border: "1px solid var(--border, #e2e8f0)",
  borderRadius: "var(--radius-m, 6px)",
  padding: "4px 10px",
  boxShadow: "var(--shadow-1, 0 1px 2px rgba(0,0,0,0.06))",
};

const POLL_INTERVAL_MS = 2_500;
/** Consecutive fully/partially failed refresh rounds before the poll chain
 *  gives up and surfaces a hard error (transient SQLite BUSY etc. must never
 *  kill the chain — see qa P2 poll-chain death). */
const MAX_CONSECUTIVE_REFRESH_FAILURES = 8;

const SEED_COUNT_OPTIONS = [5, 10, 15, 20, 25];

const JOB_STATUS_COLOR: Record<string, string> = {
  pending: "var(--text-secondary, #475569)",
  running: "var(--accent, #2563eb)",
  succeeded: "var(--success, #10b981)",
  failed: "var(--danger, #ef4444)",
  dead: "var(--danger, #ef4444)",
};

/**
 * Knowledge Engine page: KB management (create/seed), growth control,
 * ingestion job status, and the progressive drill-down graph (communities →
 * members → entity) with an evidence detail panel. Styled after the Science
 * Agent subject-engine page; mounted as a full-page overlay (same pattern as
 * MemoryGraphExplorer).
 */
export function KnowledgeEnginePage({ client, onClose }: KnowledgeEnginePageProps) {
  const { t } = useLocale();
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
  const [seedCount, setSeedCount] = useState(10);
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
  // graph query hitting SQLite BUSY) must not discard the other four
  // sections — that fail-closed round was what froze the panel on empty.
  // Returns the failed-endpoint count AND the freshly fetched jobs, so the
  // poll chain can decide re-arming from THIS round's data — reading the
  // jobsRef right after the await races React's render flush and can strand
  // the chain on a stale empty list (observed: panel frozen after seeding).
  const refreshKbData = useCallback(async (kbId: string): Promise<{ failed: number; jobs: KeJob[] }> => {
    const [graphResult, documentsResult, jobsResult, growResult, rootsResult] = await Promise.allSettled([
      client.getKeGraph(kbId),
      client.listKeDocuments(kbId),
      client.listKeJobs(kbId),
      client.getKeGrow(kbId),
      client.getKeGraphRoots(kbId),
    ]);
    // Drop the response if the user switched KBs (or left) mid-flight.
    if (!mountedRef.current || activeKbIdRef.current !== kbId) return { failed: 0, jobs: jobsRef.current };
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
      setTransientIssue(t("ke.transientIssue", { failed: failed.join(", ") }));
    }
    return {
      failed: failed.length,
      jobs: jobsResult.status === "fulfilled" ? jobsResult.value.jobs : jobsRef.current,
    };
  }, [client, t]);

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
      const { failed, jobs: freshJobs } = await refreshKbData(activeKbId);
      if (cancelled) return;
      consecutiveFailures = failed > 0 ? consecutiveFailures + 1 : 0;
      if (consecutiveFailures >= MAX_CONSECUTIVE_REFRESH_FAILURES) {
        setTransientIssue(undefined);
        reportError(new Error(t("ke.pollStopped")));
        return;
      }
      const hasActive = freshJobs.some((job) => job.status === "pending" || job.status === "running");
      if (hasActive || consecutiveFailures > 0) {
        timer = setTimeout(() => void loop(), POLL_INTERVAL_MS);
      }
    };
    void loop();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeKbId, pollNonce, refreshKbData, reportError, t]);

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

  // Header live counts: prefer the roots snapshot (fresh fingerprint), fall
  // back to the KB stats row.
  const headerEntities = roots?.entityCount ?? activeKb?.stats?.entities;
  const headerEdges = roots?.edgeCount ?? activeKb?.stats?.edges;

  // Top-right counts badge, per drill view.
  const countsBadgeText = (() => {
    if (graph.entities.length === 0) return undefined;
    if (showRoots && roots) {
      return t("ke.counts.roots", {
        count: roots.communities.length,
        method: roots.method === "louvain" ? t("ke.method.louvain") : t("ke.method.byType"),
      });
    }
    if (typeof drill === "number") {
      return t("ke.counts.community", { returned: visibleGraph.entities.length });
    }
    return t("ke.counts.graph", { entities: visibleGraph.entities.length, edges: visibleGraph.edges.length });
  })();

  const neighborName = (detail_: KeEntityDetail, otherId: string): string =>
    detail_.neighbors.find((neighbor) => neighbor.id === otherId)?.name ?? otherId.slice(0, 8);

  return (
    <div style={OVERLAY_STYLE} data-testid="knowledge-engine-page">
      <header style={HEADER_STYLE}>
        <button type="button" onClick={onClose} style={GHOST_BUTTON_STYLE} data-testid="ke-close">
          {t("ke.close")}
        </button>
        <strong style={{ fontSize: 15 }}>{t("ke.title")}</strong>
        <span style={{ color: "var(--text-secondary, #64748b)", fontSize: 13 }}>
          {activeKb ? activeKb.name : t("ke.noKbSelected")}
        </span>
        {headerEntities !== undefined ? (
          <span style={{ color: "var(--text-secondary, #64748b)", fontSize: 12 }} data-testid="ke-header-counts">
            {t("ke.header.counts", { entities: headerEntities, edges: headerEdges ?? 0 })}
          </span>
        ) : null}
        {graph.entities.length > 0 ? (
          <nav
            data-testid="ke-breadcrumb"
            style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, color: "var(--text-secondary, #475569)" }}
          >
            <button type="button" data-testid="ke-breadcrumb-roots" onClick={() => setDrill(null)} disabled={drill === null} style={GHOST_BUTTON_STYLE}>
              {t("ke.view.communities")}
            </button>
            <button type="button" data-testid="ke-breadcrumb-all" onClick={() => setDrill("all")} disabled={drill === "all"} style={GHOST_BUTTON_STYLE}>
              {t("ke.view.fullGraph")}
            </button>
            {drilledCommunity ? (
              <span>
                › <strong>{drilledCommunity.name}</strong> ({t("ke.view.communityEntities", { size: drilledCommunity.size })})
              </span>
            ) : null}
          </nav>
        ) : null}
        {transientIssue ? (
          <span data-testid="ke-transient-issue" style={{ color: "var(--warning, #b45309)", fontSize: 12 }}>{transientIssue}</span>
        ) : null}
        <span style={{ flex: 1 }} />
      </header>
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <aside style={SIDEBAR_STYLE}>
          <section>
            <h4 style={SECTION_TITLE_STYLE}>{t("ke.kb.list")}</h4>
            {kbs.map((kb) => (
              <button
                key={kb.id}
                type="button"
                data-testid={`ke-kb-${kb.id}`}
                onClick={() => {
                  // Clear every per-KB slice immediately: until the next
                  // refresh lands, the panels must not show the PREVIOUS
                  // KB's graph/documents/jobs (stale reads also fooled E2E
                  // waits into passing on the old KB's data).
                  setActiveKbId(kb.id);
                  setSelectedEntityId(undefined);
                  setDetail(undefined);
                  setDrill(null);
                  setGraph({ entities: [], edges: [] });
                  setDocuments([]);
                  setJobs([]);
                  setGrowStatus(undefined);
                  setRoots(undefined);
                }}
                style={{
                  display: "block", width: "100%", textAlign: "left", margin: "4px 0", padding: 8,
                  border: kb.id === activeKbId ? "2px solid var(--accent, #2563eb)" : "1px solid var(--border, #e2e8f0)",
                  borderRadius: "var(--radius-m, 6px)",
                  background: "var(--surface, #ffffff)",
                  color: "var(--text, #0f172a)",
                  cursor: "pointer",
                }}
              >
                <div style={{ fontWeight: 600 }}>{kb.name}</div>
                <div style={{ fontSize: 12, color: "var(--text-secondary, #64748b)" }}>
                  {kb.stats ? t("ke.kb.stats", { entities: kb.stats.entities, ready: kb.stats.documentsReady, total: kb.stats.documents }) : ""}
                </div>
              </button>
            ))}
            <div style={{ marginTop: 12, display: "flex", gap: 6 }}>
              <input
                aria-label={t("ke.kb.newPlaceholder")}
                data-testid="ke-new-kb-name"
                placeholder={t("ke.kb.newPlaceholder")}
                value={newKbName}
                onChange={(event) => setNewKbName(event.target.value)}
                style={{ ...INPUT_STYLE, flex: 1 }}
              />
              <button
                type="button"
                data-testid="ke-create-kb"
                style={PRIMARY_BUTTON_STYLE}
                disabled={!newKbName.trim()}
                onClick={() => {
                  void client.createKeKb(newKbName.trim()).then(() => {
                    setNewKbName("");
                    return refreshKbs();
                  }).catch(reportError);
                }}
              >
                {t("ke.kb.create")}
              </button>
            </div>
          </section>
          {activeKbId ? (
            <>
              <section style={{ marginTop: 20 }}>
                <h4 style={SECTION_TITLE_STYLE}>{t("ke.seed.title")}</h4>
                <p style={EXPLAINER_STYLE}>{t("ke.seed.explainer")}</p>
                <input
                  aria-label={t("ke.seed.queryPlaceholder")}
                  data-testid="ke-seed-query"
                  placeholder={t("ke.seed.queryPlaceholder")}
                  value={seedQuery}
                  onChange={(event) => setSeedQuery(event.target.value)}
                  style={{ ...INPUT_STYLE, marginBottom: 6 }}
                />
                <div style={{ display: "flex", gap: 6 }}>
                  <select
                    aria-label={t("ke.seed.countUnit")}
                    value={seedCount}
                    onChange={(event) => setSeedCount(Number(event.target.value))}
                    style={{ ...INPUT_STYLE, width: "auto" }}
                  >
                    {SEED_COUNT_OPTIONS.map((count) => (
                      <option key={count} value={count}>{count} {t("ke.seed.countUnit")}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    data-testid="ke-seed"
                    style={{ ...PRIMARY_BUTTON_STYLE, flex: 1 }}
                    disabled={!seedQuery.trim()}
                    onClick={() => {
                      void client.seedKeKb(activeKbId, seedQuery.trim(), seedCount).then(kickRefresh).catch(reportError);
                    }}
                  >
                    {t("ke.seed.button")}
                  </button>
                </div>
              </section>
              <KeGrowPanel client={client} kbId={activeKbId} status={growStatus} onChanged={kickRefresh} onError={reportError} />
              <div style={{ marginTop: 12 }}>
                <button
                  type="button"
                  data-testid="ke-resolve"
                  style={GHOST_BUTTON_STYLE}
                  title={t("ke.resolve.tooltip")}
                  onClick={() => {
                    void client.startKeResolution(activeKbId).then(kickRefresh).catch(reportError);
                  }}
                >
                  {t("ke.resolve.button")}
                </button>
              </div>
              <h4 style={{ ...SECTION_TITLE_STYLE, marginTop: 20 }}>{t("ke.jobs.title")}</h4>
              <div data-testid="ke-job-status" style={{ fontSize: 12, color: "var(--text-secondary, #475569)" }}>
                {jobs.length === 0 ? t("ke.jobs.empty") : null}
                {activeJobs.length > 0 ? <div>{t("ke.jobs.active", { count: activeJobs.length })}</div> : null}
                {jobs.slice(0, 30).map((job) => (
                  <div key={job.id} data-status={job.status} style={{ margin: "2px 0" }}>
                    <span style={{ color: JOB_STATUS_COLOR[job.status] ?? "var(--text-secondary, #475569)", fontWeight: 500 }}>
                      {t(`ke.job.status.${job.status}` as MessageKey)}
                    </span>
                    {" · "}
                    {job.type}
                    {job.error ? <span style={{ color: "var(--danger, #ef4444)" }}> — {job.error.slice(0, 60)}</span> : null}
                  </div>
                ))}
              </div>
              <h4 style={{ ...SECTION_TITLE_STYLE, marginTop: 20 }}>{t("ke.docs.title")}</h4>
              <div data-testid="ke-documents" style={{ fontSize: 12, color: "var(--text-secondary, #475569)" }}>
                {documents.map((doc) => (
                  <div key={doc.id} title={doc.title}>
                    {doc.status === "ready" ? "✓" : doc.status === "error" ? "✗" : "…"} {doc.title.slice(0, 40) || doc.id.slice(0, 8)}
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </aside>
        <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          {error ? <div role="alert" style={{ padding: 8, color: "var(--danger, #b91c1c)" }}>{error}</div> : null}
          <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
            {countsBadgeText ? (
              <div data-testid="ke-counts-badge" style={COUNTS_BADGE_STYLE}>{countsBadgeText}</div>
            ) : null}
            {graph.entities.length === 0 ? (
              <div style={{ padding: 40, color: "var(--text-faint, #94a3b8)" }} data-testid="ke-graph-empty">
                {activeKb ? t("ke.empty.noEntities") : t("ke.empty.noKb")}
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
              <KeGraphCanvas graph={visibleGraph} kbId={activeKbId} onSelect={setSelectedEntityId} selectedId={selectedEntityId} />
            ) : (
              <div style={{ padding: 40, color: "var(--text-faint, #94a3b8)" }} data-testid="ke-community-empty">
                {t("ke.empty.community")}
              </div>
            )}
          </div>
          <section
            data-testid={detail ? "ke-entity-detail" : "ke-detail-empty"}
            style={{
              borderTop: "1px solid var(--border, #e2e8f0)",
              background: "var(--surface-subtle, #f8fafc)",
              padding: 12,
              height: 230,
              flexShrink: 0,
              overflowY: "auto",
            }}
          >
            {!detail ? (
              <div style={{ color: "var(--text-faint, #94a3b8)", fontSize: 13, padding: 8 }}>{t("ke.empty.detail")}</div>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <strong style={{ fontSize: 15 }}>{detail.entity.name}</strong>
                  <span style={{ fontSize: 12, color: "var(--text-secondary, #64748b)" }}>
                    {t("ke.detail.meta", { type: detail.entity.type, support: detail.entity.supportCount, trust: detail.entity.trustLevel })}
                    {detail.entity.aliases.length > 0 ? ` · ${t("ke.detail.aliases", { list: detail.entity.aliases.join(", ") })}` : ""}
                  </span>
                  <span style={{ flex: 1 }} />
                  <button type="button" style={GHOST_BUTTON_STYLE} onClick={() => setSelectedEntityId(undefined)}>
                    {t("ke.close")}
                  </button>
                </div>
                {detail.entity.description ? (
                  <p style={{ margin: "6px 0", fontSize: 13, color: "var(--text-secondary, #475569)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {detail.entity.description}
                  </p>
                ) : null}
                {detail.evidence.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--text-faint, #94a3b8)", marginTop: 8 }}>{t("ke.detail.noRelations")}</div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 8, marginTop: 8 }}>
                    {detail.evidence.map((item) => {
                      const edge = detail.edges.find((candidate) => candidate.id === item.edgeId);
                      const outgoing = edge ? edge.srcId === detail.entity.id : true;
                      return (
                        <div
                          key={item.edgeId}
                          style={{
                            border: "1px solid var(--border, #e2e8f0)",
                            borderRadius: "var(--radius-m, 6px)",
                            background: "var(--surface, #ffffff)",
                            padding: 8,
                            fontSize: 12,
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                            <span style={{ color: "var(--text-secondary, #64748b)" }}>{outgoing ? "→" : "←"}</span>
                            <strong style={{ fontSize: 12 }}>{neighborName(detail, item.otherId)}</strong>
                            <span
                              style={{
                                fontSize: 11,
                                padding: "0 6px",
                                borderRadius: 4,
                                background: "var(--accent-soft, #eff6ff)",
                                color: "var(--accent, #2563eb)",
                              }}
                            >
                              {item.type}
                            </span>
                          </div>
                          <div
                            style={{
                              color: "var(--text-secondary, #475569)",
                              display: "-webkit-box",
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: "vertical",
                              overflow: "hidden",
                            }}
                          >
                            {item.docTitle
                              ? t("ke.detail.evidence", { doc: item.docTitle, quote: item.quote ?? "" })
                              : item.quote ?? ""}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
