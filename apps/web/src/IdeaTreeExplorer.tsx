// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

import { useEffect, useMemo, useState, type ReactNode } from "react";

import type { IdeaTreeGraph, IdeaTreeNode } from "@sciencediscovery/schema";

import { CloseIcon } from "./icons.js";
import { IDEA_TREE_STATUS_COLORS, IdeaTreeCanvas } from "./IdeaTreeCanvas.js";

const STATUSES: IdeaTreeNode["status"][] = ["pending", "running", "done", "needs_retry", "failed"];

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  return String(value);
}

function IdeaTreeNodeDetail({ node, autonomous, onOpenArtifact, onOpenSubagent }: { node?: IdeaTreeNode; autonomous?: boolean; onOpenArtifact?: (id: string) => void; onOpenSubagent?: (id: string) => void }) {
  if (!node) return <div className="idea-tree-detail-empty">
    <strong>Select a tree node</strong>
    <p>Click a node to inspect its hypothesis, result, score, execution state, and artifacts.</p>
  </div>;
  const fields: Array<[string, unknown]> = autonomous ? [
    ["类型", node.kind === "direction" ? "研究方向" : "候选方案"],
    ["深度", node.depth], ["评分", node.score], ["父节点", node.parentId],
    ["子节点", node.childrenIds],
  ] : [
    ["Status", node.status],
    ["Search", node.searchStatus],
    ["Depth", node.depth],
    ["Priority", node.priority],
    ["Score", node.score],
    ["Attempts", node.attemptCount],
    ["Parent", node.parentId],
    ["Children", node.childrenIds],
    ["Artifacts", node.artifactRefs],
    ["Active execution", node.activeExecutionId],
    ["Last execution", node.lastExecutionId],
    ["Result handle", node.completedResultHandle],
    ["Updated", node.updatedAt],
  ];
  return <article className="idea-tree-detail">
    <header>
      <span className="idea-tree-detail-id">{node.id}</span>
      <span className="idea-tree-status" style={{ borderColor: IDEA_TREE_STATUS_COLORS[node.status], color: IDEA_TREE_STATUS_COLORS[node.status] }}>{node.kind === "direction" ? "研究方向" : node.status}</span>
    </header>
    <section>
      <h3>Hypothesis</h3>
      <p>{node.hypothesis}</p>
    </section>
    {node.insight ? <section><h3>Insight</h3><p>{node.insight}</p></section> : null}
    {!autonomous && node.result ? <section><h3>Result</h3><p>{node.result}</p></section> : null}
    {autonomous && Object.entries(node.stages ?? {}).map(([role, result]) => <section key={role}>
      <h3>{{design: "材料设计", activity: "活性评估", stability: "稳定性评估", sustainability: "可持续性评估", aggregate: "综合评估"}[role] ?? role}{result.score === undefined ? "" : ` · ${result.score}`}</h3>
      <p>{result.text}</p>
    </section>)}
    {node.pruneReason ? <section><h3>Prune reason</h3><p>{node.pruneReason}</p></section> : null}
    <section>{node.artifactRefs.map(id => <button key={id} type="button" onClick={() => onOpenArtifact?.(id)}>Artifact {id}</button>)}</section>
    <section>{node.subagentIds?.map((id, index) => <button key={id} type="button" onClick={() => onOpenSubagent?.(id)}>Subagent {index + 1}</button>)}</section>
    <dl>
      {fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{formatValue(value)}</dd></div>)}
    </dl>
  </article>;
}

export function IdeaTreeExplorer({
  graph,
  autonomous = false,
  embedded = false,
  controls,
  onOpenArtifact,
  onOpenSubagent,
  loading,
  onClose,
  onSelectTree,
  treeIds,
}: {
  graph: IdeaTreeGraph;
  autonomous?: boolean;
  embedded?: boolean;
  controls?: ReactNode;
  onOpenArtifact?: (id: string) => void;
  onOpenSubagent?: (id: string) => void;
  loading?: boolean;
  onClose: () => void;
  onSelectTree: (treeId: string) => void;
  treeIds: string[];
}) {
  const [selectedId, setSelectedId] = useState<string>("ROOT");
  const [query, setQuery] = useState("");
  const [visibleStatuses, setVisibleStatuses] = useState<ReadonlySet<IdeaTreeNode["status"]>>(new Set(STATUSES));

  useEffect(() => {
    setSelectedId("ROOT");
  }, [graph.treeId]);

  useEffect(() => {
    if (embedded) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [embedded, onClose]);

  const selected = useMemo(
    () => graph.nodes.find((node) => node.id === selectedId),
    [graph.nodes, selectedId],
  );
  const statusCounts = useMemo(() => {
    const counts = new Map<IdeaTreeNode["status"], number>();
    for (const node of graph.nodes.filter(n => n.kind !== "direction")) counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
    return counts;
  }, [graph.nodes]);

  const toggleStatus = (status: IdeaTreeNode["status"]) => {
    setVisibleStatuses((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  return <div className={embedded ? "idea-tree-inline" : "idea-tree-explorer-backdrop"} onMouseDown={(event) => { if (!embedded && event.target === event.currentTarget) onClose(); }}>
    <section aria-label="Idea Tree explorer" aria-modal={embedded ? undefined : true} className="idea-tree-explorer-panel" role={embedded ? "region" : "dialog"}>
      <header className="idea-tree-explorer-header">
        <div>
          <span className="eyebrow">Agent search</span>
          <h2>Idea Tree</h2>
          <p title={graph.objective}>{graph.objective}</p>
        </div>
        <div className="idea-tree-explorer-controls">
          {treeIds.length > 1 ? <label>
            <span>Tree</span>
            <select disabled={loading} onChange={(event) => onSelectTree(event.target.value)} value={graph.treeId}>
              {treeIds.map((treeId, index) => <option key={treeId} value={treeId}>{index === 0 ? "Latest · " : ""}{treeId}</option>)}
            </select>
          </label> : null}
          <span>{graph.nodes.length} nodes</span>
          {!autonomous && <span>revision {graph.revision}</span>}
          {!embedded && <button aria-label="Close Idea Tree" className="icon-button" onClick={onClose} type="button"><CloseIcon size={20} /></button>}
        </div>
      </header>
      {controls}
      <div className="idea-tree-explorer-body">
        <aside className="idea-tree-explorer-detail"><IdeaTreeNodeDetail autonomous={autonomous} node={selected} onOpenArtifact={onOpenArtifact} onOpenSubagent={onOpenSubagent} /></aside>
        <main className="idea-tree-explorer-graph">
          <div className="idea-tree-toolbar">
            <label className="idea-tree-search">
              <span>Find</span>
              <input onChange={(event) => setQuery(event.target.value)} placeholder="Node id, hypothesis, insight…" value={query} />
            </label>
            <div className="idea-tree-filter-chips" aria-label="Filter node statuses">
              {STATUSES.filter((status) => statusCounts.has(status)).map((status) => <button
                aria-pressed={visibleStatuses.has(status)}
                className={visibleStatuses.has(status) ? "active" : ""}
                key={status}
                onClick={() => toggleStatus(status)}
                type="button"
              ><i style={{ background: IDEA_TREE_STATUS_COLORS[status] }} />{status}<em>{statusCounts.get(status)}</em></button>)}
            </div>
          </div>
          <div className="idea-tree-canvas-host">
            <IdeaTreeCanvas
              graph={graph}
              onSelect={setSelectedId}
              query={query}
              selectedId={selectedId}
              visibleStatuses={visibleStatuses}
            />
            {loading ? <div className="idea-tree-loading">Loading tree…</div> : null}
            <p className="idea-tree-canvas-hint">Auto layout · click to inspect · drag background to pan · scroll to zoom</p>
          </div>
        </main>
      </div>
    </section>
  </div>;
}
