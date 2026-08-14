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

import { useCallback, useEffect, useMemo, useState } from "react";

import type { ArtifactAnnotation, ComposerReference, MemoryGraphEdgeType, MemoryGraphNode, MemoryGraphNodeLabel, MemorySubgraph } from "@science-agent/schema";

import type { ApiClient } from "./api.js";
import { CloseIcon } from "./icons.js";
import { useLocale } from "./i18n/index.js";
import { EDGE_COLORS, graphNodeDisplayNames, graphNodeName, MemoryGraphCanvas, NODE_COLORS } from "./MemoryGraphCanvas.js";
import { MemoryGraphNodeDetail, useResolvedArtifactName } from "./MemoryGraphProduct.js";
import { ArtifactModal } from "./ScientificArtifacts.js";

const NODE_LABELS: MemoryGraphNodeLabel[] = ["ResearchGoal", "SubTask", "Paper", "Evidence", "Claim", "Code", "Artifact"];
// Edge types shown as Relationship filter chips. MUST stay in sync with
// MemoryGraphEdgeType (packages/schema) + EDGE_COLORS (MemoryGraphCanvas) —
// a type listed here but missing from EDGE_COLORS renders a grey chip, and a
// type in the schema but missing here silently disappears from the filter
// (the count is computed from graph.edges, then filtered by this list). Keep
// the order aligned with EDGE_COLORS so chip colors read top-to-bottom.
const EDGE_TYPES: MemoryGraphEdgeType[] = ["produces", "next", "extracted_from", "cites", "states", "input"];
// Module-level so the embedded artifact panel keeps a stable prop identity
// across the explorer's poll-driven re-renders.
const NOOP = () => undefined;

/**
 * Resolve a parent-artifact `logicalName` (and optional version) onto a graph
 * Artifact node, mirroring `useResolvedArtifactName`'s matching rules but in
 * the opposite direction: from the workspace logical name back to a graph
 * node. Used by the embedded provenance panel's "← derived from" links so a
 * parent click both highlights the node and pans the canvas to it.
 *
 * The graph stores the workspace `path` as `extra.path` (= the artifact's
 * logical name in the common case); we also accept a path-tail match because
 * legacy sessions sometimes prefix paths with a workspace root. When a version
 * is supplied, prefer the exact composite-key match; otherwise fall back to
 * the highest version recorded for that artifact.
 */
export function findArtifactNodeInGraph(
  nodes: readonly MemoryGraphNode[],
  logicalName: string,
  version?: number,
): MemoryGraphNode | undefined {
  const matches = nodes.filter((node) => {
    if (node.label !== "Artifact") return false;
    const path = typeof node.extra?.path === "string" ? node.extra.path : "";
    if (!path) return false;
    return path === logicalName || logicalName.endsWith(`/${path}`);
  });
  if (!matches.length) return undefined;
  if (version != null) {
    const exact = matches.find((node) => node.extra?.version === version);
    if (exact) return exact;
  }
  return matches.toSorted((left, right) =>
    (typeof right.extra?.version === "number" ? right.extra.version : -1) -
    (typeof left.extra?.version === "number" ? left.extra.version : -1),
  )[0];
}

/**
 * Resolve a provenance code-entry `runId` onto the graph Code node that ran
 * it. The graph stores the runId canonically as `extra.code_id`; older writes
 * (and the test session this skill was verified against) leave only the
 * node id populated, so fall back to `node.id === runId`. Used by the
 * embedded provenance panel's code-header link so a click drives the canvas
 * to select + highlight the producing Code node.
 */
export function findCodeNodeInGraph(
  nodes: readonly MemoryGraphNode[],
  runId: string,
): MemoryGraphNode | undefined {
  return nodes.find((node) => {
    if (node.label !== "Code") return false;
    if (typeof node.extra?.code_id === "string" && node.extra.code_id === runId) return true;
    return node.id === runId;
  });
}

/**
 * Full-screen memory-graph explorer.
 *
 * Left column: the product of the selected node. For Artifact nodes this is
 * the *same* artifacts panel the main page uses (ArtifactModal in embedded
 * mode), so previews, versions and provenance behave identically everywhere.
 * Right column: the interactive graph plus node/edge category filters.
 */
export function MemoryGraphExplorer({
  client,
  initialNodeId,
  initialVersion,
  initialChainKind,
  autoChain,
  onClose,
  onError,
  onPendingAnnotation,
  sessionId,
  subgraph,
}: {
  client: ApiClient;
  initialNodeId?: string;
  /** Pins the initial Artifact node to a specific version (composite key) so
   * the auto-chain walks that version's chain. Absent → latest version. */
  initialVersion?: number;
  /** Overrides the label-based auto-chain default so the entry modal can ask
   * for a specific chain (e.g. the artifact modal's "View task chain" vs
   * "View artifact chain" buttons both enter on an Artifact node but walk
   * different chains). Absent → the label-based default below. */
  initialChainKind?: "full" | "task" | "artifact";
  autoChain?: boolean;
  onClose: () => void;
  onError: (message: string) => void;
  onPendingAnnotation?: (annotation: ArtifactAnnotation) => void;
  sessionId: string;
  subgraph: MemorySubgraph;
}) {
  const [selectedId, setSelectedId] = useState<string | undefined>(initialNodeId);
  const [activeLabels, setActiveLabels] = useState<ReadonlySet<MemoryGraphNodeLabel>>(new Set());
  const [activeEdges, setActiveEdges] = useState<ReadonlySet<MemoryGraphEdgeType>>(new Set());
  // Search narrows the graph to matching nodes; chain replaces it with one
  // node's upstream/downstream chain. Both are clearable back to the full graph.
  const [query, setQuery] = useState("");
  const [matchIds, setMatchIds] = useState<ReadonlySet<string>>();
  const [searchNote, setSearchNote] = useState<string>();
  const [searching, setSearching] = useState(false);
  const [chain, setChain] = useState<{ graph: MemorySubgraph; sourceName: string }>();
  const [chainLoading, setChainLoading] = useState(false);
  const [autoChainDone, setAutoChainDone] = useState(false);
  const { t } = useLocale();

  // The graph actually on screen: a chain when one is open, else the
  // session subgraph.
  const graph = chain?.graph ?? subgraph;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Auto-trigger chain display when opened from the artifact/evidence modals.
  // Pass the initial version so an Artifact composite-key source walks the
  // exact version's chain (not the latest, which may differ). The chain kind
  // comes from ``initialChainKind`` when the entry modal asked for a specific
  // one (the artifact modal's "View task chain" vs "View artifact chain"
  // buttons both enter on an Artifact node but walk different chains);
  // otherwise it mirrors the single-button default for the node's label:
  // Paper/Evidence/Claim/Artifact → artifact chain; everything else → full.
  useEffect(() => {
    if (!autoChain || !initialNodeId || autoChainDone || chain || chainLoading) return;
    const node = graph.nodes.find((n) => n.id === initialNodeId);
    if (!node) return;
    setAutoChainDone(true);
    const autoKind: "full" | "task" | "artifact" = initialChainKind ?? (
      node.label === "Paper" || node.label === "Evidence" || node.label === "Claim" || node.label === "Artifact"
        ? "artifact"
        : "full"
    );
    void showChain(initialVersion, autoKind);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoChain, initialNodeId, autoChainDone, chain, chainLoading, graph]);

  // Only offer categories that actually occur, with their counts.
  const labelCounts = useMemo(() => {
    const counts = new Map<MemoryGraphNodeLabel, number>();
    for (const node of graph.nodes) counts.set(node.label, (counts.get(node.label) ?? 0) + 1);
    return NODE_LABELS.flatMap((label) => counts.has(label) ? [{ count: counts.get(label)!, label }] : []);
  }, [graph]);

  const edgeCounts = useMemo(() => {
    const counts = new Map<MemoryGraphEdgeType, number>();
    for (const edge of graph.edges) counts.set(edge.type, (counts.get(edge.type) ?? 0) + 1);
    return EDGE_TYPES.flatMap((type) => counts.has(type) ? [{ count: counts.get(type)!, type }] : []);
  }, [graph]);

  const selected = graph.nodes.find((node) => node.id === selectedId);
  // Repeated names are numbered on the canvas; the status line has to agree
  // with what the user is looking at.
  const displayNames = useMemo(() => graphNodeDisplayNames(graph.nodes), [graph]);

  // A parent-file click in the embedded provenance panel both switches the
  // left artifact (handled inside ArtifactModal) AND drives the right graph
  // to follow along: find the matching Artifact node and select it, which the
  // canvas reads as "highlight + pan/zoom into view". When the parent isn't
  // in the current view (typical for a chain, which carries the
  // Artifact itself plus its SubTask/Code/ResearchGoal spine but not the
  // `input` artifacts that fed the producing Code), exit the chain and look
  // in the full session subgraph instead — otherwise the canvas stays put
  // while the left panel jumps and the two panels become inconsistent.
  // When the parent genuinely isn't tracked by the graph at all, we silently
  // leave the canvas alone; the left panel still updates so the user isn't
  // stuck.
  const navigateArtifactInGraph = useCallback((logicalName: string, version?: number) => {
    const target = findArtifactNodeInGraph(graph.nodes, logicalName, version);
    if (target) { setSelectedId(target.id); return; }
    if (!chain) return;
    const fullTarget = findArtifactNodeInGraph(subgraph.nodes, logicalName, version);
    if (!fullTarget) return;
    setChain(undefined);
    clearSearch();
    setSelectedId(fullTarget.id);
  }, [chain, graph.nodes, subgraph.nodes]);

  // A code-header click in the embedded provenance panel selects the Code
  // node that ran the script. The chain view DOES carry Code
  // nodes (the produces edge is part of the chain), so the in-graph match
  // usually succeeds; the full-subgraph fallback only fires when the user
  // has cleared the chain or the Code node wasn't tracked. When no Code
  // node carries that runId, leave the canvas alone — the embedded panel
  // already shows the code, so the click isn't a dead end.
  const navigateCodeInGraph = useCallback((runId: string) => {
    const target = findCodeNodeInGraph(graph.nodes, runId);
    if (target) { setSelectedId(target.id); return; }
    if (!chain) return;
    const fullTarget = findCodeNodeInGraph(subgraph.nodes, runId);
    if (!fullTarget) return;
    setChain(undefined);
    clearSearch();
    setSelectedId(fullTarget.id);
  }, [chain, graph.nodes, subgraph.nodes]);

  // A citation chip click in the embedded artifact panel (the report's
  // [artifactN]/[evidenceN] tokens) selects the cited node in the canvas.
  // Artifact chips carry the catalog artifact_id + version as the reference;
  // resolve it to a graph Artifact node by matching ``extra.artifact_id``
  // (composite-keyed on version when the chip pins one). Without this the
  // MarkdownRenderer renders the chips as disabled buttons — the reference
  // resolves, so they are not plain text, but ArtifactModal's onChipClick is
  // undefined in the chain view so the button stays disabled and unclickable.
  // Evidence/Artifact chips reference those labels directly by id.
  const navigateChipInGraph = useCallback((reference: ComposerReference) => {
    // ComposerReferenceKind is lowercase ("artifact"); MemoryGraphNodeLabel is
    // PascalCase ("Artifact"). Map the chip kind to its graph label so the
    // label comparison is meaningful; "session"/"skill" are composer-context
    // references, not chips, so they never reach this handler.
    const label = reference.kind === "artifact" ? "Artifact"
      : reference.kind === "evidence" ? "Evidence" : null;
    if (!label) return;
    const matchNode = (nodes: readonly MemoryGraphNode[]) => nodes.find((node) => {
      if (node.label !== label) return false;
      if (reference.kind === "artifact") {
        const artifactId = typeof node.extra?.artifact_id === "string" ? node.extra.artifact_id : "";
        if (artifactId !== reference.id) return false;
        return reference.version == null
          || node.extra?.version === reference.version;
      }
      return node.id === reference.id;
    });
    const target = matchNode(graph.nodes);
    if (target) { setSelectedId(target.id); return; }
    if (!chain) return;
    const fullTarget = matchNode(subgraph.nodes);
    if (!fullTarget) return;
    setChain(undefined);
    clearSearch();
    setSelectedId(fullTarget.id);
  }, [chain, graph.nodes, subgraph.nodes]);

  async function runSearch(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const term = query.trim();
    if (!term) { setMatchIds(undefined); setSearchNote(undefined); return; }
    setSearching(true);
    try {
      const result = await client.queryMemoryMatch(term, sessionId);
      const ids = new Set(result.hits.map((hit) => hit.id));
      setMatchIds(ids);
      // Hits can reference nodes outside the current view (other sessions or
      // pruned by a chain), so report both numbers rather than just the total.
      const onScreen = graph.nodes.filter((node) => ids.has(node.id)).length;
      // The read layer caps results server-side; say so rather than silently
      // showing a partial answer when the server truncates its result set.
      setSearchNote(result.hits.length
        ? `${onScreen} of ${result.hits.length}${result.truncated ? "+ (truncated)" : ""} match(es) in view`
        : "No matches");
    } catch (error) {
      onError(error instanceof Error ? error.message : "Search failed");
    } finally {
      setSearching(false);
    }
  }

  function clearSearch(): void {
    setQuery("");
    setMatchIds(undefined);
    setSearchNote(undefined);
  }

  async function showChain(version?: number, chainKind: "full" | "task" | "artifact" = "full"): Promise<void> {
    if (!selected) return;
    setChainLoading(true);
    try {
      const result = await client.getMemoryChain(selected.id, sessionId, version, chainKind);
      if (!result.nodes.length) { onError("No chain was found for this node."); return; }
      setChain({
        graph: { edges: result.edges, nodes: result.nodes, total: result.total, truncated: result.truncated },
        sourceName: graphNodeName(selected),
      });
      clearSearch();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not load the chain");
    } finally {
      setChainLoading(false);
    }
  }
  // Artifact nodes resolve to a real session artifact so the shared panel can
  // load it by logical name; other labels fall back to a property view.
  const { name: artifactName, state: resolveState } = useResolvedArtifactName(client, sessionId, selected);
  // An empty filter set means "no filter" rather than "hide everything".
  const visibleLabels = activeLabels.size ? activeLabels : undefined;
  const visibleEdgeTypes = activeEdges.size ? activeEdges : undefined;
  const filtered = activeLabels.size > 0 || activeEdges.size > 0;

  function toggleLabel(label: MemoryGraphNodeLabel): void {
    setActiveLabels((current) => {
      const next = new Set(current);
      if (next.has(label)) next.delete(label); else next.add(label);
      return next;
    });
  }

  function toggleEdge(type: MemoryGraphEdgeType): void {
    setActiveEdges((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type); else next.add(type);
      return next;
    });
  }

  return <div className="memory-explorer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section aria-label="Science Memory explorer" aria-modal="true" className="memory-explorer-panel" role="dialog">
      <header className="memory-explorer-header">
        <div>
          <span className="eyebrow">Session knowledge</span>
          <h2>Science Memory</h2>
        </div>
        <div className="memory-explorer-stats">
          <form className="memory-explorer-search" onSubmit={(event) => void runSearch(event)} role="search">
            <input
              aria-label="Search the Science Memory"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search nodes…"
              value={query}
            />
            <button disabled={searching} type="submit">{searching ? "…" : "Search"}</button>
            {matchIds ? <button onClick={clearSearch} type="button">Clear</button> : null}
          </form>
          {searchNote ? <span className="memory-search-note">{searchNote}</span> : null}
          <span>{graph.nodes.length} nodes</span>
          <span>{graph.edges.length} edges</span>
          {graph.truncated ? <span className="memory-truncated" title="The read layer caps results; this view is partial.">truncated</span> : null}
          <button aria-label="Close Science Memory" className="icon-button" onClick={onClose} title="Close Science Memory" type="button"><CloseIcon size={20} /></button>
        </div>
      </header>

      {chain ? <div className="memory-chain-banner">
        <span>{t("chain.for", { name: chain.sourceName })}</span>
        <button onClick={() => { setChain(undefined); clearSearch(); }} type="button">{t("chain.backToFullGraph")}</button>
      </div> : null}

      <div className="memory-explorer-body">
        <div className="memory-explorer-product">
          {selected && selected.label === "Artifact" && artifactName ? <ArtifactModal
            client={client}
            embedded
            // Key on (logicalName, version) so clicking v1 vs v2 remounts the
            // modal with the right initialVersion (same logicalName across
            // versions would otherwise reuse the v2 instance).
            key={`${artifactName}:${selected.extra?.version ?? ""}`}
            logicalName={artifactName}
            initialVersion={typeof selected.extra?.version === "number" ? selected.extra.version : undefined}
            onClose={() => setSelectedId(undefined)}
            onError={onError}
            onChipClick={navigateChipInGraph}
            onNavigateArtifact={navigateArtifactInGraph}
            onNavigateCode={navigateCodeInGraph}
            onPendingAnnotation={onPendingAnnotation ?? NOOP}
            sessionId={sessionId}
          /> : <MemoryGraphNodeDetail
            client={client}
            node={selected}
            onSelectNode={setSelectedId}
            resolveState={resolveState}
            sessionId={sessionId}
            subgraph={graph}
          />}
          {selected ? <div className="memory-chain-bar">
            {/* Artifact nodes get two buttons (task chain + artifact chain);
                every other node gets a single "View chain" button. ResearchGoal/
                SubTask/Code walk the full joint subgraph; Paper/Evidence/Claim
                walk the directed artifact chain (report anchor → selected node). */}
            {(selected.label === "ResearchGoal" || selected.label === "SubTask" || selected.label === "Code") && (
              <button disabled={chainLoading} onClick={() => void showChain(undefined, "full")} type="button">
                {chainLoading ? t("chain.loading") : t("chain.view")}
              </button>
            )}
            {(selected.label === "Paper" || selected.label === "Evidence" || selected.label === "Claim") && (
              <button disabled={chainLoading} onClick={() => void showChain(undefined, "artifact")} type="button">
                {chainLoading ? t("chain.loading") : t("chain.view")}
              </button>
            )}
            {selected.label === "Artifact" && <>
              <button disabled={chainLoading} onClick={() => void showChain(undefined, "task")} type="button">
                {chainLoading ? t("chain.loading") : t("chain.viewTask")}
              </button>
              <button disabled={chainLoading} onClick={() => void showChain(selected.extra?.version as number | undefined, "artifact")} type="button">
                {chainLoading ? t("chain.loading") : t("chain.viewArtifact")}
              </button>
            </>}
          </div> : null}
        </div>

        <div className="memory-explorer-right">
          {/* Above the canvas: the filters are a control, and controls belong
              where the eye lands first. Below the graph they read as a legend
              and were easy to miss entirely. */}
          <div className="memory-explorer-filters">
            <div className="memory-filter-block">
              <span className="memory-filter-title">Nodes ({graph.nodes.length})</span>
              <div className="memory-filter-chips">
                {labelCounts.map(({ count, label }) => <button
                  aria-pressed={activeLabels.has(label)}
                  className={activeLabels.has(label) ? "memory-chip active" : "memory-chip"}
                  key={label}
                  onClick={() => toggleLabel(label)}
                  style={{ borderColor: activeLabels.has(label) ? NODE_COLORS[label] : undefined }}
                  type="button"
                ><i style={{ background: NODE_COLORS[label] }} />{label} <em>{count}</em></button>)}
              </div>
            </div>
            <div className="memory-filter-block">
              <span className="memory-filter-title">Relationships ({graph.edges.length})</span>
              <div className="memory-filter-chips">
                {edgeCounts.map(({ count, type }) => <button
                  aria-pressed={activeEdges.has(type)}
                  className={activeEdges.has(type) ? "memory-chip active" : "memory-chip"}
                  key={type}
                  onClick={() => toggleEdge(type)}
                  style={{ borderColor: activeEdges.has(type) ? EDGE_COLORS[type] : undefined }}
                  type="button"
                ><i style={{ background: EDGE_COLORS[type] }} />{type} <em>{count}</em></button>)}
                {filtered ? <button className="memory-chip reset" onClick={() => { setActiveLabels(new Set()); setActiveEdges(new Set()); }} type="button">Clear filters</button> : null}
              </div>
            </div>
          </div>

          <div className="memory-explorer-canvas">
            <MemoryGraphCanvas
              interactive
              matchIds={matchIds}
              onSelect={setSelectedId}
              selectedId={selectedId}
              subgraph={graph}
              visibleEdgeTypes={visibleEdgeTypes}
              visibleLabels={visibleLabels}
            />
            <p className="memory-explorer-hint">
              {selected ? `Selected: ${displayNames.get(selected.id) ?? graphNodeName(selected)}` : "Click a node to inspect its product"} · drag to pan · scroll to zoom
            </p>
          </div>
        </div>
      </div>
    </section>
  </div>;
}
