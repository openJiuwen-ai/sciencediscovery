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
  KeGrowStatus,
  KeJob,
  KeKb,
} from "../api/knowledge-engine.js";
import { KeGraphCanvas } from "./KeGraphCanvas.js";
import { KeGrowPanel } from "./KeGrowPanel.js";

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
  const [selectedEntityId, setSelectedEntityId] = useState<string | undefined>(undefined);
  const [detail, setDetail] = useState<KeEntityDetail | undefined>(undefined);
  const [newKbName, setNewKbName] = useState("");
  const [seedQuery, setSeedQuery] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
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

  const refreshKbData = useCallback(async (kbId: string) => {
    try {
      const [graphResult, documentsResult, jobsResult, growResult] = await Promise.all([
        client.getKeGraph(kbId),
        client.listKeDocuments(kbId),
        client.listKeJobs(kbId),
        client.getKeGrow(kbId),
      ]);
      // Drop the response if the user switched KBs (or left) mid-flight.
      if (!mountedRef.current || activeKbIdRef.current !== kbId) return;
      setGraph(graphResult);
      setDocuments(documentsResult.documents);
      setJobs(jobsResult.jobs);
      setGrowStatus(growResult);
      setError(undefined);
    } catch (loadError) {
      reportError(loadError);
    }
  }, [client, reportError]);

  useEffect(() => {
    void refreshKbs();
  }, [refreshKbs]);

  // Recursive-timeout poll chain: one refresh, then re-arm ONLY while jobs
  // are active (read through the ref, so the chain never re-triggers itself
  // on state updates). Switching KBs cancels the old chain exactly once.
  useEffect(() => {
    if (!activeKbId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      await refreshKbData(activeKbId);
      if (cancelled) return;
      const hasActive = jobsRef.current.some((job) => job.status === "pending" || job.status === "running");
      if (hasActive) {
        timer = setTimeout(() => void loop(), POLL_INTERVAL_MS);
      }
    };
    void loop();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeKbId, pollNonce, refreshKbData]);

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

  return (
    <div style={OVERLAY_STYLE} data-testid="knowledge-engine-page">
      <header style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderBottom: "1px solid #e2e8f0" }}>
        <strong>Knowledge Engine</strong>
        <span style={{ color: "#64748b", fontSize: 13 }}>{activeKb ? activeKb.name : "no knowledge base selected"}</span>
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
          <div style={{ flex: 1, minHeight: 0 }}>
            {graph.entities.length > 0 ? (
              <KeGraphCanvas graph={graph} onSelect={setSelectedEntityId} selectedId={selectedEntityId} />
            ) : (
              <div style={{ padding: 40, color: "#94a3b8" }} data-testid="ke-graph-empty">
                {activeKb ? "No entities yet — seed papers to build the graph." : "Create or select a knowledge base."}
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
