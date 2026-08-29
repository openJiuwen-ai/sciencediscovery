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

import type { ArtifactAnnotation, ComposerReference, MemoryGraphEdgeType, MemoryGraphNode, MemoryGraphNodeLabel, MemorySubgraph } from "@sciencediscovery/schema";

import type { ApiClient } from "./api.js";
import { CloseIcon } from "./icons.js";
import { useLocale } from "./i18n/index.js";
import type { MessageKey } from "./i18n/messages.js";
import { aggregateOwnerScope, EDGE_COLORS, graphNodeDisplayNames, graphNodeName, isAggregateNode, isChildNode, isScopeNode, isSurrogateEdge, MemoryGraphCanvas, NODE_COLORS } from "./MemoryGraphCanvas.js";
import { collapseProducesOwner, countFoldedProducesMembers, expandProducesOwner, mainChainNodeIds, projectToCanvas, producesMembersOf } from "./memoryGraphBackbone.js";
import { MeaningBubble, type LegendKind, type LegendId } from "./MemoryGraphLegend.js";
import { MemoryGraphTour } from "./MemoryGraphTour.js";
import { MemoryGraphNodeDetail, useResolvedArtifactName } from "./MemoryGraphProduct.js";
import { ArtifactModal } from "./ScientificArtifacts.js";

/**
 * A per-node chain button. `key` is an i18n key (`chain.<slug>`); `kind` is a
 * button-level key into the sidecar's ``_BUTTON_CHAIN_HOPS`` table (e.g.
 * ``"viewOutput"``, ``"viewCitingArtifactForEvidence"``). The sidecar walks
 * exactly that button's directed short chain and returns it; the frontend
 * highlights whatever edges come back — no client-side slicing, no edge-type
 * filtering, no ``expand``. Whether a button has anything to show is decided
 * by the sidecar too (``POST /query/chain-exists``), so a button whose chain
 * is empty is hidden *before* the user clicks it (same hop table as a click,
 * so shown = guaranteed non-empty when opened).
 */
interface ChainButton {
  /** i18n key (full `chain.<slug>`, a MessageKey). */
  key: MessageKey;
  /** Button-level chain key into the sidecar hop table. */
  kind: string;
}

/**
 * Per-node-label chain buttons. ResearchGoal / ToolCall get NO buttons (spine
 * root/leaf, already visible in the backbone view). Each button's ``kind``
 * names a directed short chain in the sidecar's ``_BUTTON_CHAIN_HOPS`` table;
 * see that table for the exact hops per kind. Clicking a button fetches that
 * one chain (``getMemoryChain(nodeId, sessionId, version, button.kind)``); the
 * returned nodes/edges ARE the highlight — ``chainEdgeKeys`` just reads them
 * off, it does not re-slice.
 */
const CHAIN_BUTTONS: Partial<Record<MemoryGraphNodeLabel, ChainButton[]>> = {
  ResearchGoal: [],
  ToolCall: [],
  Task: [
    { key: "chain.viewPrevTask", kind: "viewPrevTask" },
    { key: "chain.viewNextTask", kind: "viewNextTask" },
    { key: "chain.viewGoal", kind: "viewGoal" },
  ],
  Code: [
    { key: "chain.viewInput", kind: "viewInput" },
    { key: "chain.viewOutput", kind: "viewOutput" },
    { key: "chain.viewProducingTask", kind: "viewProducingTask" },
  ],
  Paper: [
    { key: "chain.viewExtractedEvidence", kind: "viewExtractedEvidence" },
    { key: "chain.viewCitingClaim", kind: "viewCitingClaim" },
    { key: "chain.viewCitingArtifact", kind: "viewCitingArtifact" },
    { key: "chain.viewSearchingTask", kind: "viewSearchingTask" },
  ],
  Evidence: [
    { key: "chain.viewSourcePaper", kind: "viewSourcePaper" },
    { key: "chain.viewCitingClaimForEvidence", kind: "viewCitingClaimForEvidence" },
    { key: "chain.viewCitingArtifactForEvidence", kind: "viewCitingArtifactForEvidence" },
  ],
  Claim: [
    { key: "chain.viewCitingEvidence", kind: "viewCitingEvidenceForClaim" },
    { key: "chain.viewContainingArtifact", kind: "viewContainingArtifact" },
  ],
  Artifact: [
    { key: "chain.viewContainedClaims", kind: "viewContainedClaims" },
    { key: "chain.viewCitingClaimForArtifact", kind: "viewCitingClaimForArtifact" },
    { key: "chain.viewProducingCode", kind: "viewProducingCode" },
    { key: "chain.viewCitingEvidence", kind: "viewCitingEvidenceForArtifact" },
    { key: "chain.viewCitedPaper", kind: "viewCitedPaper" },
    { key: "chain.viewRelatedTask", kind: "viewRelatedTask" },
  ],
};

const NODE_LABELS: MemoryGraphNodeLabel[] = ["ResearchGoal", "Task", "ToolCall", "Paper", "Evidence", "Claim", "Code", "Artifact"];
// Edge types shown as Relationship filter chips. MUST stay in sync with
// MemoryGraphEdgeType (packages/schema) + EDGE_COLORS (MemoryGraphCanvas) —
// a type listed here but missing from EDGE_COLORS renders a grey chip, and a
// a type in the schema but missing here silently disappears from the filter
// (the count is computed from graph.edges, then filtered by this list). Keep
// the order aligned with EDGE_COLORS so chip colors read top-to-bottom.
// ``contains`` is the subagent scope→child spine (PR1); it surfaces as a
// chip so the user can isolate the scope subtree when a scope is expanded.
// ``supersedes`` (Artifact version→previous version) is intentionally
// omitted — version history is out of scope for the canvas/chain view, and
// the Canvas drops those edges before layout anyway.
const EDGE_TYPES: MemoryGraphEdgeType[] = ["produces", "next", "extracts", "supports", "stated_in", "input", "contains"];
// Module-level so the embedded artifact panel keeps a stable prop identity
// across the explorer's poll-driven re-renders.
const NOOP = () => undefined;

/**
 * A "meaning" target: which filter row (node label / edge type) + its id,
 * for the hover lookup (A).
 */
type MeaningTarget = { kind: LegendKind; id: LegendId };
/** Alias kept to avoid repeating the union; mirrors MeaningTarget. */
type FirstSeenState = MeaningTarget;

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
 * The folded subgraph that ``get_subgraph`` returns carries, for every
 * subagent scope, *both* the real child spine (``contains`` edges, the child
 * ToolCalls, the child→Code→Artifact / child→Paper chain) *and* the synthesised
 * surrogate edges (scope→product, ``extra.surrogate``). That is the raw
 * "everything" read — the folded *view* must hide the child subtree so the
 * collapsed canvas reads as scope→product hints only (总方案 §2.4: one
 * relation, one visible edge — the surrogate and the real chain never
 * coexist). An expanded scope does the inverse: drop its surrogate, surface
 * the real child spine (here taken from the cached scope-expansion payload,
 * whose edges are real persisted edges with no ``surrogate`` marker).
 *
 * ``isExpandedScopeSurrogate`` tags a surrogate whose *owning* scope is
 * expanded so the merge can drop it; surrogates of folded scopes stay.
 */
function isExpandedScopeSurrogate(
  edge: { type: MemoryGraphEdgeType; source: string; target: string; extra?: Record<string, unknown> },
  expandedScopes: ReadonlySet<string>,
): boolean {
  if (!isSurrogateEdge(edge)) return false;
  // Surrogates are emitted source = scope task_id (see query.py's folded
  // synthesis), so an expanded scope's surrogate is simply one whose source
  // is an expanded scope id. via_child is the responsible child hop.
  return expandedScopes.has(edge.source);
}

/**
 * Merge the child subtrees of every expanded scope into the folded subgraph,
 * and fold the child subtrees of every *collapsed* scope back out of view.
 * Pure + deterministic so the 8s poll produces a byte-identical result when
 * the underlying subgraph is unchanged — the canvas keys its layout rebuild
 * on a content signature, so a stable merge keeps an expanded graph from
 * re-laying-out on every poll tick (§3.3 "stable expansion subgraph").
 *
 * Visibility rules (one relation, one visible edge — §2.4):
 *  - A *collapsed* scope: hide its entire child subtree — the child ToolCalls,
 *    the ``contains`` spine, and the real child→Code→Artifact /
 *    child→Paper chain — and keep its surrogate(s) as the quiet scope→product
 *    hint. The subtree is the forward-reachable set from the scope's direct
 *    children along real (non-surrogate) folded edges. A product inside that
 *    subtree is rescued back into view when one of the collapsed scope's own
 *    surviving surrogates targets it (the hint is its visible relation) OR
 *    when some other visible node still edges into it (e.g. a top-level
 *    ToolCall co-producing the same artifact) — in the latter case the outside
 *    edge is what keeps the product, and the child's edge to it folds away.
 *  - An *expanded* scope: drop its surrogate(s); surface the real child
 *    spine from the cached scope-expansion payload (children + ``contains``
 *    + real produces edges; no surrogate marker on any of them).
 *  - Nodes de-duped by id; edges de-duped by ``(source, target, type)``. An
 *    edge is kept iff both endpoints are visible after the node fold — this
 *    is what naturally drops the contains spine and the child→product chain
 *    while preserving an outside→product link to a rescued product.
 * The result's ``truncated``/``reason`` mirror the folded subgraph (the
 * expansion is a view-level overlay, not a new read); ``total`` reflects the
 * post-fold node count.
 */
export function mergeExpansions(
  folded: MemorySubgraph,
  expansionGraphs: ReadonlyMap<string, MemorySubgraph>,
  expandedScopes: ReadonlySet<string>,
  groupGraphs?: ReadonlyMap<string, MemorySubgraph>,
  expandedGroups?: ReadonlySet<string>,
): MemorySubgraph {
  // 0. Aggregate virtual nodes (需求3). A folded scope with >1 product of one
  //    kind collapses into ONE ``_group:<scopeId>:<Kind>`` node in the folded
  //    read. Two cases drive its visibility here:
  //    - the aggregate is expanded (expandedGroups has its id): drop the
  //      virtual node + its surrogate edge and surface the real member
  //      products + one surrogate ``scope→member`` edge each (from groupGraphs).
  //    - the owning scope is expanded: the scope's surrogate edges (incl. the
  //      one to this aggregate) are dropped at step 3, so the aggregate becomes
  //      an orphan — hide it too, since the real members now show via the
  //      child subtree. Both cases are ``hiddenGroups`` below.
  const hiddenGroups = new Set<string>();
  for (const node of folded.nodes) {
    if (!isAggregateNode(node)) continue;
    if (expandedGroups?.has(node.id)) hiddenGroups.add(node.id);
    // Resolve the owning scope from the aggregate id (``_group:<scope>:<Kind>``).
    const owner = aggregateOwnerScope(node.id);
    if (owner && expandedScopes.has(owner)) hiddenGroups.add(node.id);
  }

  // 1. Collect every subagent scope in the folded read. Only scopes carry a
  //    child subtree to fold; a scope not present in the folded set has no
  //    subtree to hide (its expansion, if any, is a view-only overlay below).
  const scopeIds = new Set<string>();
  for (const node of folded.nodes) if (isScopeNode(node)) scopeIds.add(node.id);
  const collapsedScopes = new Set<string>();
  for (const id of scopeIds) if (!expandedScopes.has(id)) collapsedScopes.add(id);

  // 2. Seed each collapsed scope's subtree with its direct children (those
  //    carrying parent_subtask_id == the scope, or the :exec: task_id shape),
  //    then walk forward along real (non-surrogate) folded edges to capture
  //    the whole child→Code→Artifact / child→Paper chain. Surrogates are not
  //    followed (they are view hints, not structural hops) so the walk stays
  //    inside the real subtree. The walk follows only *structural* edge
  //    types — produces (child→Code→Artifact / child→Paper), contains
  //    (scope→child spine), next (scope_chain sibling order). The `input` edge
  //    (Artifact→Code) is a *consumer* link, not subtree composition: it points
  //    from a scope's product out to the Code that reads it, and that Code
  //    belongs to a different scope or the top-level chain. Following `input`
  //    forward pulls an outside Code (and whatever it produces) into this
  //    scope's folded subtree, hiding the outside producer's own products when
  //    the scope is folded — e.g. G2M artifact →input→ top-level Code
  //    →produces→ `_methodology_ref.md` wrongly hid the methodology artifact
  //    under G2M (session db799384). Argumentation/evidence edges — supports /
  //    stated_in / extracts / supersedes — are likewise cross-claim semantics,
  //    not subtree composition: a child's product supporting a Claim that is
  //    stated_in a sibling or top-level Artifact must not pull that Artifact
  //    into this scope's folded subtree (it stays visible only via its own
  //    real producer edge).
  const SUBTREE_EDGE_TYPES = new Set<string>(["produces", "contains", "next"]);
  const subtree = new Set<string>();
  for (const node of folded.nodes) {
    if (!isChildNode(node)) continue;
    const parent = typeof node.extra?.parent_subtask_id === "string"
      ? (node.extra.parent_subtask_id as string)
      : childScopeFromId(node.id);
    if (parent && collapsedScopes.has(parent)) subtree.add(node.id);
  }
  const forward = new Map<string, Array<string>>();
  for (const edge of folded.edges) {
    if (isSurrogateEdge(edge)) continue;
    if (!SUBTREE_EDGE_TYPES.has(edge.type)) continue;
    const arr = forward.get(edge.source);
    if (arr) arr.push(edge.target); else forward.set(edge.source, [edge.target]);
  }
  const queue = [...subtree];
  while (queue.length > 0) {
    const cur = queue.pop() as string;
    for (const next of forward.get(cur) ?? []) {
      if (!subtree.has(next)) {
        subtree.add(next);
        queue.push(next);
      }
    }
  }

  // 3. Folded edges that the merge keeps from the raw folded read:
  //    - drop surrogates of *expanded* scopes (the real chain takes over);
  //    - drop any edge whose target is a hidden aggregate virtual node (the
  //      aggregate was expanded into its members, or its owning scope was
  //      expanded so the real members now show via the child subtree);
  //    every other folded edge is retained and re-filtered against the final
  //    visible-node set at step 6 (this is what drops the contains spine and
  //    the child→product chain once their child endpoint is hidden, while an
  //    outside→product edge survives because the product is rescued/resolved).
  const foldedEdges: MemorySubgraph["edges"] = [];
  for (const edge of folded.edges) {
    if (isExpandedScopeSurrogate(edge, expandedScopes)) continue;
    if (hiddenGroups.has(edge.target) || hiddenGroups.has(edge.source)) continue;
    foldedEdges.push(edge);
  }

  // 4. Rescue a subtree product that one of the *collapsed* scopes still
  //    points at via a surviving surrogate — the surrogate is the product's
  //    visible relation, so the product reappears. (A product also reached by
  //    an outside node is kept by that outside edge regardless; the rescue
  //    only matters when the surrogate is the sole visible path.)
  const rescued = new Set<string>();
  for (const edge of foldedEdges) {
    if (isSurrogateEdge(edge) && subtree.has(edge.target)) rescued.add(edge.target);
  }

  // 5. Visible nodes: folded minus the subtree (minus rescued products) minus
  //    hidden aggregate virtual nodes, plus each expanded scope's expansion
  //    nodes (children/products) and each expanded aggregate's member products.
  //    An expanded scope's children are *not* in `subtree` (the subtree only
  //    covers collapsed scopes), so they pass through the folded set anyway;
  //    pulling them from the expansion overlay normalises their shape.
  //    An expanded aggregate's members come from the group-expansion overlay
  //    (one surrogate ``scope→member`` produces edge per member — same shape
  //    the folded view would have drawn had it not collapsed them).
  const expansionEdges: MemorySubgraph["edges"] = [];
  const expansionNodes = new Map<string, MemoryGraphNode>();
  for (const scopeId of expandedScopes) {
    const expansion = expansionGraphs.get(scopeId);
    if (!expansion) continue;
    for (const node of expansion.nodes) expansionNodes.set(node.id, node);
    for (const edge of expansion.edges) expansionEdges.push(edge);
    // The scope-internal child→child ``next`` chain is now persisted by the
    // backend (persistence.py's ``_link_scope_children`` writes
    // ``contains``→first child + ``next`` between consecutive children,
    // method='scope_chain') and returned by ``get_scope_expansion`` (which
    // includes 'next' in its edge-type filter). No frontend synthesis needed —
    // the persisted edges are the single source of truth, so we just merge
    // them through (de-duped at step 6 below).
  }
  const groupEdges: MemorySubgraph["edges"] = [];
  for (const groupId of expandedGroups ?? []) {
    const group = groupGraphs?.get(groupId);
    if (!group) continue;
    for (const node of group.nodes) expansionNodes.set(node.id, node);
    for (const edge of group.edges) groupEdges.push(edge);
  }
  const nodesById = new Map<string, MemoryGraphNode>();
  for (const node of folded.nodes) {
    if (subtree.has(node.id) && !rescued.has(node.id)) continue;
    if (hiddenGroups.has(node.id)) continue;
    nodesById.set(node.id, node);
  }
  for (const node of expansionNodes.values()) nodesById.set(node.id, node);

  // 6. Edges: keep an edge iff both endpoints are visible, de-duped by
  //    ``(source, target, type)``. This drops the contains spine (child hidden)
  //    and the child→Code→Artifact chain (child + Code hidden), and keeps an
  //    outside→product edge whose product was rescued (both endpoints visible).
  //    The group-expansion surrogate edges (scope→member) survive because both
  //    endpoints are visible (the scope + each member product).
  const edgeKeys = new Set<string>();
  const edges: MemorySubgraph["edges"] = [];
  const pushEdge = (edge: MemorySubgraph["edges"][number]): void => {
    if (!nodesById.has(edge.source) || !nodesById.has(edge.target)) return;
    const key = `${edge.source}>${edge.target}:${edge.type}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push(edge);
  };
  for (const edge of foldedEdges) pushEdge(edge);
  for (const edge of expansionEdges) pushEdge(edge);
  for (const edge of groupEdges) pushEdge(edge);
  return {
    nodes: [...nodesById.values()],
    edges,
    total: nodesById.size,
    truncated: folded.truncated,
    reason: folded.reason,
  };
}

// Overlay scope expansions onto a CHAIN view, AND fold collapsed scopes'
// child ToolCalls away. The artifact-chain walker pulls a subagent scope's
// child ToolCalls into the eid set: it walks the producing Code's ``produces
// in`` ancestor — the child ToolCall — then ``next out`` fans across the
// child→child next chain. So a chain typically carries a scope's child
// ToolCalls (and the one Code whose produced Artifact the chain cites) as free
// nodes alongside the scope node, even when the scope is folded. Two cases:
//
//  - EXPANDED scope: union its ``getScopeExpansion`` nodes + edges onto the
//    chain (the full child ToolCalls + their Codes + the real produces/
//    contains/next edges connecting them). Self-loops + surrogates skipped;
//    de-duped by (source, target, type).
//  - COLLAPSED scope (in the chain but NOT in expandedScopes): HIDE its child
//    ToolCalls and the Codes produced by those children, but KEEP the
//    scope's own products (the chain-cited Artifact) and reconnect them to
//    the scope with a synthesised surrogate ``scope→produces→artifact`` edge.
//    Without this fold path the children stay scattered as free nodes — the
//    "double-click to collapse only hid the overlaid Codes, not the base-chain
//    ToolCalls" symptom on session db799384's G2M scope (9 children, 1 cited
//    Artifact 0608…#v1 — a key input ancestor of trace.md v4). Keeping the
//    product preserves the chain's continuity (the Artifact is an input to a
//    downstream top-level Code); hiding only the children + Codes matches the
//    folded get_subgraph view's scope+surrogate-product shape.
//
// ``mergeExpansions`` can't be reused: it subtracts subtrees from a folded
// read whose child nodes are present-but-hidden and whose products are reached
// by pre-existing surrogate edges (rescued by those surrogates). A chain is
// pure real edges (no surrogates), so the fold synthesises the surrogate that
// the folded get_subgraph view would have carried, to rescue the scope's
// chain-cited product once its producing child + Code are hidden.
export function mergeChainScopeExpansions(
  chain: MemorySubgraph,
  expansionGraphs: ReadonlyMap<string, MemorySubgraph>,
  expandedScopes: ReadonlySet<string>,
): MemorySubgraph {
  // FOLD PASS — find the child ToolCalls + Codes to hide for every collapsed
  // scope in the chain. A scope node's children are the chain nodes whose
  // owning scope (``extra.parent_subtask_id`` or the ``:exec:`` task_id
  // prefix) is collapsed.
  const chainScopes = new Set<string>();
  for (const node of chain.nodes) if (isScopeNode(node)) chainScopes.add(node.id);
  const collapsedScopes = new Set<string>();
  for (const id of chainScopes) if (!expandedScopes.has(id)) collapsedScopes.add(id);
  const hiddenDirect = new Set<string>();
  // child -> its owning collapsed scope (resolved once here, threaded through
  // the BFS below so a product reached via child→Code→Artifact is attributed
  // to the scope, not the intermediate Code). Also scope -> one child task_id
  // to tag synthesised surrogate edges with ``via_child`` (the same marker
  // get_subgraph's folded surrogates carry, so a click on the folded edge can
  // still jump to the responsible child).
  const childScope = new Map<string, string>();
  const viaChild = new Map<string, string>();
  for (const node of chain.nodes) {
    if (!isChildNode(node)) continue;
    const parent = childParentScope(node);
    if (parent && collapsedScopes.has(parent)) {
      hiddenDirect.add(node.id);
      childScope.set(node.id, parent);
      if (!viaChild.has(parent)) viaChild.set(parent, node.id);
    }
  }
  // Forward BFS along ``produces`` from each collapsed scope's children: hide
  // the Codes those children produced (the chain carries child→Code→Artifact
  // for the cited Artifact). Codes are structural plumbing, not products —
  // they have no meaning once their producing child is hidden. Products
  // (Artifacts/Papers) are the opposite: they are the scope's cited outputs
  // and must stay; the BFS records them (foldedProducts) so a synthesised
  // surrogate can re-attach them to the scope. A product also reached by a
  // NON-hidden producer (a top-level ToolCall) is not a child-subtree product
  // and is left to that producer's real edge — it is never added here.
  const producesForward = new Map<string, string[]>();
  for (const edge of chain.edges) {
    if (edge.type !== "produces" || isSurrogateEdge(edge)) continue;
    const arr = producesForward.get(edge.source);
    if (arr) arr.push(edge.target); else producesForward.set(edge.source, [edge.target]);
  }
  const labelById = new Map<string, string>();
  for (const node of chain.nodes) labelById.set(node.id, node.label);
  const hidden = new Set<string>(hiddenDirect);          // hidden children + Codes
  const foldedProducts = new Set<string>();              // rescued scope products
  const foldedProductScope = new Map<string, string>();   // product -> owning collapsed scope
  // Queue carries the owning collapsed scope so a product reached via a chain
  // of hidden Codes (child→Code→Artifact) is attributed to the scope, not to
  // the intermediate Code that produces it.
  const queue: Array<{ node: string; scope: string }> = [];
  for (const child of hiddenDirect) queue.push({ node: child, scope: childScope.get(child) ?? "" });
  while (queue.length > 0) {
    const { node: cur, scope } = queue.pop() as { node: string; scope: string };
    for (const next of producesForward.get(cur) ?? []) {
      if (hidden.has(next) || chainScopes.has(next)) continue;
      const label = labelById.get(next);
      if (label === "Artifact" || label === "Paper") {
        // Product of the collapsed scope — keep it, record owning scope.
        foldedProducts.add(next);
        if (!foldedProductScope.has(next)) foldedProductScope.set(next, scope);
        // Don't enqueue: a product reached once is rescued; we don't walk
        // past it (its own ``produces`` out-edges belong to a different
        // derivation, e.g. an Artifact feeding a downstream Code via input).
        continue;
      }
      // A Code (or other structural node) produced by a hidden child → hide,
      // inheriting the same owning scope for its own produces targets.
      hidden.add(next);
      queue.push({ node: next, scope });
    }
  }
  // A product reached by the child subtree is rescued (kept) ONLY if it has
  // no NON-hidden producer outside the subtree — otherwise the outside real
  // edge is the one that keeps it visible and the folded scope shouldn't
  // claim it (the surrogate would duplicate the outside edge's relation).
  const outsideProducers = new Map<string, number>();
  for (const edge of chain.edges) {
    if (hidden.has(edge.source)) continue;
    if (edge.type !== "produces") continue;
    outsideProducers.set(edge.target, (outsideProducers.get(edge.target) ?? 0) + 1);
  }
  const rescued = new Set<string>();
  for (const prod of foldedProducts) {
    if ((outsideProducers.get(prod) ?? 0) === 0) rescued.add(prod);
  }

  const nodesById = new Map<string, MemoryGraphNode>();
  for (const node of chain.nodes) {
    if (hidden.has(node.id)) continue;                   // child ToolCall / Code — hidden
    nodesById.set(node.id, node);
  }
  // Synthesise a surrogate scope→product edge for each rescued product of a
  // collapsed scope — the folded hint that re-attaches the cited product to
  // the scope once its producing child + Code are hidden. Tagged surrogate +
  // via_child so it reads as the same kind of view edge get_subgraph emits.
  const foldedSurrogates: MemorySubgraph["edges"] = [];
  for (const prod of rescued) {
    const scope = foldedProductScope.get(prod);
    if (!scope || !nodesById.has(scope) || !nodesById.has(prod)) continue;
    foldedSurrogates.push({
      source: scope,
      target: prod,
      type: "produces",
      extra: { surrogate: true, via_child: viaChild.get(scope) ?? null },
    });
  }

  // Expansion edges that are surrogates drop (view hints, already drawn);
  // a folded scope's synthesised surrogate is added below as the folded hint.
  const edgeKeys = new Set<string>();
  const edges: MemorySubgraph["edges"] = [];
  const pushEdge = (edge: MemorySubgraph["edges"][number], fromExpansion: boolean): void => {
    if (edge.source === edge.target) return;            // self-loop (scope_chain noise)
    if (fromExpansion && isSurrogateEdge(edge)) return; // view hint, already drawn
    if (!nodesById.has(edge.source) || !nodesById.has(edge.target)) return;
    const key = `${edge.source}>${edge.target}:${edge.type}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push(edge);
  };
  // Seed the dedup set with the chain's own edges (post-fold filtering) so
  // expansion edges that duplicate a chain edge don't double-draw.
  for (const edge of chain.edges) pushEdge(edge, false);
  // Add the synthesised folded surrogates (a real chain has none, so they
  // never collide with a chain edge; the dedup is still a safety net).
  for (const edge of foldedSurrogates) pushEdge(edge, false);
  // EXPAND PASS — union each expanded scope's expansion nodes + edges.
  for (const scopeId of expandedScopes) {
    const expansion = expansionGraphs.get(scopeId);
    if (!expansion) continue;
    for (const node of expansion.nodes) nodesById.set(node.id, node);
    for (const edge of expansion.edges) pushEdge(edge, true);
  }
  return {
    nodes: [...nodesById.values()],
    edges,
    total: nodesById.size,
    truncated: chain.truncated,
    reason: chain.reason,
  };
}

/**
 * A child's task_id embeds its scope's id via PR1's ``:exec:`` shape
 * ``subtask:subagent:<scopeId>:exec:<execId>``. Recover the scope id (the
 * prefix before ``:exec:``) so a child node whose ``parent_subtask_id`` is
 * absent can still be attributed to its owning scope for the fold. Returns
 * ``undefined`` when the id does not carry the marker.
 */
function childScopeFromId(id: string): string | undefined {
  const idx = id.indexOf(":exec:");
  return idx > 0 ? id.slice(0, idx) : undefined;
}

/**
 * The owning scope id of a child node — ``extra.parent_subtask_id`` when PR1
 * wrote it, otherwise recovered from the ``:exec:`` task_id shape. Used both
 * to attribute a child to its scope for the fold (mergeExpansions) and to
 * group children per scope for the synthesised ``next`` chain. Returns
 * ``undefined`` when the node is not a scope child (no parent, no marker).
 */
function childParentScope(node: { id: string; extra?: Record<string, unknown> }): string | undefined {
  const explicit = node.extra?.parent_subtask_id;
  if (typeof explicit === "string" && explicit) return explicit;
  return childScopeFromId(node.id);
}

/**
 * Count every child ToolCall owned by a scope, straight from the raw folded
 * node set. The backend's ``get_subgraph`` returns the whole session graph
 * (children included) before the frontend folds the child subtree out of
 * view, so this count is independent of expansion state — the scope's "▸ N"
 * badge shows the true child total whether collapsed or expanded. (Counting
 * from the visible ``contains`` edges would read 0 while collapsed, because
 * mergeExpansions folds the spine away; the raw node set is the stable source.)
 */
export function countScopeChildren(
  scopeId: string,
  nodes: readonly MemoryGraphNode[],
): number {
  let n = 0;
  for (const node of nodes) {
    if (!isChildNode(node)) continue;
    if (childParentScope(node) === scopeId) n += 1;
  }
  return n;
}

/**
 * Build the scope→child-count map once per raw folded read, so the canvas
 * badge reads the true child total regardless of which scopes are expanded.
 * Pure over the node set; called with the pre-merge folded subgraph.
 */
export function buildScopeChildCounts(nodes: readonly MemoryGraphNode[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (!isScopeNode(node)) continue;
    counts.set(node.id, countScopeChildren(node.id, nodes));
  }
  return counts;
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
  onOpenEvolveRun,
  initialVersion,
  autoChain,
  onClose,
  onError,
  onPendingAnnotation,
  sessionId,
  subgraph,
}: {
  client: ApiClient;
  initialNodeId?: string;
  /** Open the evolve panel for a run a graph node points at. */
  onOpenEvolveRun?: (runId: string) => void;
  /** Pins the initial Artifact node to a specific version (composite key) so
   * the auto-chain walks that version's chain. Absent → latest version. */
  initialVersion?: number;
  /** Legacy prop retained for backward compat with callers that still pass it
   * (the artifact/evidence modal entry no longer auto-walks a chain — the entry
   * just focuses the selected node; the user picks the chain button manually).
   * Accepted but ignored. */
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
  const [chain, setChain] = useState<{ graph: MemorySubgraph; sourceName: string; sourceId: string }>();
  const [chainLoading, setChainLoading] = useState(false);
  const [autoChainDone, setAutoChainDone] = useState(false);
  // 链路 overlay 化后，chain 不再替换画布，而是叠在全图骨架上的高亮 overlay。
  // chainSlice 是当前按钮激活的「边类型切片」（按钮映射表 CHAIN_BUTTONS 里每
  // 项的 edges + pick），chainEdgeKeys memo 据它从 chain.graph.edges 筛出该切
  // 片要高亮的边 key。点同一节点的不同按钮换切片（同 kind 不重拉），点别的
  // 节点换按钮组、旧链暂留、点新按钮才切链。见 §3.2/3.3。
  const [chainSlice, setChainSlice] = useState<ChainButton | undefined>();
  // 入口焦点（autoChain 路径）：从产物/证据模态进来时不拉链路，入口节点
  // （Artifact/Evidence）作为**固定焦点始终高亮**，主干其余雾化。focusNodeId
  // 持有入口节点 id，matchIds = {focusNodeId, selectedId}——入口节点恒亮，点
  // 别的节点浏览时被点节点**追加**进高亮集（不替换入口），主干其余仍雾化。
  // focusNodeId 不随点节点变化；只有激活链路（showChain 清 focusNodeId）或
  // 搜索时，焦点才让位给真正的高亮模式。见 §入口焦点。
  const [focusNodeId, setFocusNodeId] = useState<string | undefined>();
  // Subagent scope expansion: expandedScopes holds the task_ids of scopes
  // whose child subtrees are merged into the on-screen graph; expansionGraphs
  // caches each scope's getScopeExpansion payload so the 8s poll can re-merge
  // without re-fetching (the expansion is toggle-driven, not poll-driven —
  // §3.3 "stable expansion subgraph"). scopeNotes surfaces per-scope
  // notices ("no products yet" / "scope gone") instead of a blank expansion.
  const [expandedScopes, setExpandedScopes] = useState<Set<string>>(new Set());
  const [expansionGraphs, setExpansionGraphs] = useState<Map<string, MemorySubgraph>>(new Map());
  const [expandingScopes, setExpandingScopes] = useState<Set<string>>(new Set());
  const [scopeNotes, setScopeNotes] = useState<Map<string, string>>(new Map());
  // Aggregate expansion (需求3): a folded scope with >1 product of one kind
  // (Artifact/Paper) collapses into ONE virtual ``_group:<scopeId>:<Kind>``
  // node in the folded view. expandedGroups holds the ids of aggregates whose
  // member products have been unpacked into the on-screen graph; groupGraphs
  // caches each aggregate's getGroupExpansion payload so the 8s poll can
  // re-merge without re-fetching. Separate from scope expansion — clicking an
  // "Artifacts"/"Papers" node unpacks only the members of that kind, NOT the
  // scope's child subtree (that's onToggleScope). expandingGroups gates
  // double-clicks while a fetch is in flight.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [groupGraphs, setGroupGraphs] = useState<Map<string, MemorySubgraph>>(new Map());
  const [expandingGroups, setExpandingGroups] = useState<Set<string>>(new Set());
  // produces 成员折叠（规则3）：任意非 scope/aggregate 节点双击展开其
  // produces/citation 邻接（一层），再双击级联折叠。独立于 expandedScopes
  // （subagent scope 子树）和 expandedGroups（aggregate 成员）——三套各管
  // 各的折叠面，互不干扰。上游的 mergeExpansions 只折叠 subagent scope
  // 的 contains 子树，单 agent session 没有 subagent scope 时整图无折叠；
  // 这套 expandedNodeMap 补上「每个节点的 produces 产出默认折叠」。
  //
  // 「谁展开谁折叠」模型（仿 Neo4j，边为中心）：ownerId → 它**亲手拉进来**
  // 的子节点 id 集。展开时只记当前不可见的新成员（expandProducesOwner）；
  // 折叠时只删 owner 名下的 + 递归删它们各自名下的（collapseProducesOwner）。
  // 一个节点若被别的 owner 拉进来，折叠当前 owner 不碰它——它因还连着那个
  // owner 的边而留下（「边为中心、对端不收」）。
  const [expandedNodeMap, setExpandedNodeMap] = useState<Map<string, Set<string>>>(new Map());
  // 「已出现节点集」（等价 Neo4j nodeMap 键集）：节点被任一次展开拉进来就进
  // 这个集，折叠只从该集移除被显式删除的**直接子**（浅层），孙辈留下。这让
  // 浅层折叠 report2 后 Claim 消失、Evidence 留着——Evidence 在 appearedIds，
  // Claim 被删也不失保（脱离 owner 仍可见，Neo4j nodeMap 语义）。projectToCanvas
  // 的 keep 集 produces 部分从这里推，不再从 expandedNodeMap 的 children 推。
  const [appearedIds, setAppearedIds] = useState<Set<string>>(new Set());
  const { t } = useLocale();

  // The graph actually on screen: a chain when one is open, else the
  // session subgraph with every expanded scope's child subtree + every
  // expanded aggregate's member products merged in (an expanded scope's
  // surrogate edges dropped — the real edges take over; an expanded
  // aggregate's virtual node dropped — the real member products take over).
  // 主干任务链（next 边 BFS：ResearchGoal ─next→ Task/ToolCall ─next→ ...）。
  // overlay 化后链路不再替换画布——mainChain 始终从 subgraph 算，链路态也
  // 保留主脊可见（链路叠在骨架上，主脊是骨架的一部分）。无 ResearchGoal
  // 时回退为所有 Task+ToolCall+ResearchGoal，避免空脊把整图折叠掉。
  const mainChain = useMemo(() => mainChainNodeIds(subgraph), [subgraph]);
  // 链路 overlay：chain.graph 只用来算高亮集，不再替换画布。chainEdgeKeys
  // 直接取 fetched chain 的所有边 key——后端按按钮 kind 已返回精确短链，
  // 前端不再切片/不再 expand/不再按边类型过滤（删了 buttonEdgeKeys）。
  // chainNodeIds 从这些边的两端节点推出（+ 源节点 + selected），而非用整条
  // 链的全部节点——只亮切片实际涉及的节点，其余链上节点仍雾化。两者都作
  // extraKeepIds 传 projectToCanvas，让折叠成员临时保留。
  // chainEdgeKeys：fetched chain 每条边的 key（`source>target:type`）。
  // chainSlice 切换按钮重拉该按钮的 kind（不再「同 kind 不重拉」，因每按钮
  // 一个独立 kind）。
  const chainEdgeKeys = useMemo<ReadonlySet<string> | undefined>(() => {
    if (!chain) return undefined;
    const s = new Set<string>();
    for (const e of chain.graph.edges) s.add(`${e.source}>${e.target}:${e.type}`);
    return s;
  }, [chain]);
  // chainNodeIds：只亮短链实际涉及的节点——chainEdgeKeys 里每条边的两端 +
  // 源节点 + 当前选中节点。源节点是链路锚点永远亮；当前选中节点也并入，让
  // 用户点哪个链上节点它本身也亮（即使该节点不在边端点里，如点 Claim 后
  // Claim 仍亮）。
  const chainNodeIds = useMemo<ReadonlySet<string> | undefined>(() => {
    if (!chain || !chainEdgeKeys || chainEdgeKeys.size === 0) return undefined;
    const ids = new Set<string>();
    ids.add(chain.sourceId);
    if (selectedId) ids.add(selectedId);
    // NOTE: read node ids off the edge OBJECTS, not by parsing the
    // `source>target:type` key string. Node ids are not URL-safe — Paper ids
    // are full URLs (e.g. https://pubmed.ncbi.nlm.nih.gov/41892301) which
    // contain `:`, so indexOf(":") on the key lands inside the Paper id's
    // `https:` and yields the target id as "" — the Evidence endpoint of the
    // chain never enters matchIds and gets fogged. The key string is fine for
    // the Set-based whole-key match in Canvas (isChainEdge), but not for
    // splitting back into ids.
    for (const e of chain.graph.edges) {
      if (e.source) ids.add(e.source);
      if (e.target) ids.add(e.target);
    }
    return ids;
  }, [chain, chainEdgeKeys, selectedId]);
  // 叠加主干投影：默认只保留主干 + 已展开的 produces 成员，砍掉其余节点
  // （规则1+3）。先 mergeExpansions 合并 scope 子树 + aggregate 成员，再
  // projectToCanvas 叠加主干折叠。链路态额外传 chainNodeIds 作 extraKeepIds
  // 临时保留链上成员。produces 方向（ToolCall→Paper, Paper→Evidence, ...）
  // 默认折叠，双击展开一层。scope 子树节点靠 contains 连接、不在 produces
  // 成员里，所以主干 ∪ produces 成员的保留集不会误砍 scope 展开带进来的子树。
  // （mergeChainScopeExpansions 保留导出但 graph memo 不再调用——overlay
  // 化后链子图只用于算高亮集，不再渲染画布。）
  // extraKeepIds = 短链节点 ∪ 入口焦点节点。链路态只 keep 短链需要高亮的
  // 节点（chainNodeIds）——让被主干投影砍掉的短链节点临时出现在画布上，
  // 再由 matchIds 高亮它们、雾化其余。**不单独算「连回主干的桥」**：
  // 能被点中按钮的节点本身就在画布上、已连着主干（画布只渲染 keep 集里的
  // 节点，能渲染就说明它的连接路径都在 keep）；短链节点若已在画布上则无需
  // 桥，若被投影砍了 keep 它后也会通过自身已有的 produces/citation 边连上
  // 画布上已有的相邻节点。之前 bridgeIds 反走到主干曾把短链外的支线
  // （如 Claim←supports←Evidence←extracts←Paper←produces←ToolCall 里的
  // Evidence/Paper）也当桥拉进来多展示，违背「只展示短链」。
  const extraKeepIds = useMemo<ReadonlySet<string> | undefined>(() => {
    const ids = chainNodeIds;
    if (ids && focusNodeId) { const s = new Set(ids); s.add(focusNodeId); return s; }
    if (ids) return ids;
    // 入口焦点态：keep 入口节点（focusNodeId）恒在；若选中别的节点（点过去
    // 浏览），也 keep 它——否则点中的若是 produces 成员被主干投影折叠了，
    // 节点看不见，高亮集里也看不到它。
    if (focusNodeId) {
      if (selectedId && selectedId !== focusNodeId) return new Set([focusNodeId, selectedId]);
      return new Set([focusNodeId]);
    }
    return undefined;
  }, [chainNodeIds, focusNodeId, selectedId]);
  const graph = useMemo(
    () => projectToCanvas(
      mergeExpansions(subgraph, expansionGraphs, expandedScopes, groupGraphs, expandedGroups),
      mainChain,
      expandedNodeMap,
      appearedIds,
      expandedScopes,
      expansionGraphs,
      extraKeepIds,
    ),
    [subgraph, expansionGraphs, expandedScopes, groupGraphs, expandedGroups, mainChain, expandedNodeMap, appearedIds, extraKeepIds],
  );
  // 入口态 + 链路态：把焦点/短链节点**永久展开**进 appearedIds——这样关掉
  // 链路/入口、或切到另一个按钮后，这些节点仍可见（用户铁律「已展开节点不
  // 收回」；之前 claim 靠 extraKeepIds 临时 keep，切按钮就掉了）。同时沿
  // produces 入边反走到主干的中间 owner（如 Code）也永久化——produces 成员
  // 借 owner 连主干不悬空（入口进来 Artifact 不会再是孤儿）。
  // **只走 produces 反走 owner，不反走 citation(supports/extracts/...)**——
  // 否则 Claim 反走 supports 会把 Evidence/Paper 支线也拉进来多展示（用户反馈
  // 「把 claim→evidence→paper→toolcall 也展示了」）。但短链切片本身含的节点
  // （如 Claim、Evidence）是用户**显式点按钮要看**的，永久化它们不越界——
  // chainNodeIds 只含当前激活按钮切片的节点，不含该按钮没切片的支线。
  // 用 extraKeepIds 不够：它是临时的、随当前 chainNodeIds 变，切按钮就换集 →
  // 旧链节点掉出 keep 被砍。改用 appearedIds 永久 keep 解决。
  // 入口态起点 = {focusNodeId}；链路态起点 = chainNodeIds。
  useEffect(() => {
    const starts = new Set<string>();
    if (focusNodeId) starts.add(focusNodeId);
    else if (chain && chainNodeIds) for (const id of chainNodeIds) starts.add(id);
    else return;
    // 把焦点/短链节点本身全部永久化（「已展开不收回」）。
    const toAdd = new Set<string>(starts);
    const visited = new Set<string>(starts);
    // 再沿 produces 入边反走到主干，把中间 owner（如 Code）也永久化，
    // 让 produces 成员借 owner 连主干不悬空。Evidence 没有 produces 入边
    // （它经 extracts 连 Paper），所以 produces 没命中时再试 extracts 入边
    // —— 让 Evidence → Paper → produces → ToolCall(主干) 也连上，不再孤儿。
    // 只反走 produces + extracts，**不反走 citation（supports/stated_in）**：
    // 否则 Claim 反走 supports 会把 Evidence/Paper 支线也拉进来多展示（用户
    // 反馈过「把 claim→evidence→paper→toolcall 也展示了」）。extracts 只拉 Paper
    // 一跳，不拉 Claim 支线，安全。
    for (const start of starts) {
      let cur: string | undefined = start;
      for (let i = 0; i < 8 && cur; i++) {
        const inEdge = subgraph.edges.find((e) => e.target === cur && e.type === "produces")
          ?? subgraph.edges.find((e) => e.target === cur && e.type === "extracts");
        if (!inEdge) break;
        cur = inEdge.source;
        if (mainChain.has(cur)) break; // 到主干为止（主干本就可见）
        if (visited.has(cur)) break; // 环保护
        visited.add(cur);
        toAdd.add(cur);
      }
    }
    if (toAdd.size === 0) return;
    setAppearedIds((prev) => {
      let changed = false;
      const n = new Set(prev);
      for (const id of toAdd) {
        if (!n.has(id)) { n.add(id); changed = true; }
      }
      return changed ? n : prev;
    });
  }, [focusNodeId, chain, chainNodeIds, subgraph, mainChain]);

  // Per-scope true child counts, built once from the raw folded subgraph
  // (the full session read — children included, pre-fold). The canvas reads
  // this for the "▸ N" badge so the count is stable across collapse/expand
  // (counting visible contains edges reads 0 while collapsed). Memoised on
  // the raw node set so it does not flip on every expansion toggle.
  const scopeChildCounts = useMemo(() => buildScopeChildCounts(subgraph.nodes), [subgraph]);
  // 可见性感知的「已折叠（不可见）produces 相邻成员数」，按当前投影 `graph`
  // 的可见 id 集计算。>0 才说明双击还能拉出新节点：驱动 canvas tooltip
  // 是否显「双击展开节点」、toggleProduces 是否弹 toast。比原始边计数
  // `buildProducesMemberCounts` 更准——后者不分可见性，会把「相邻成员都已可见」
  // 的节点（如 sub_analysis2.txt Artifact、ResearchGoal）误报成可展开。
  // 仅对当前可见的非 scope/aggregate 节点算（折叠的看不见、无需 tooltip）。
  const foldedProducesCounts = useMemo(() => {
    const visibleIds = new Set(graph.nodes.map((n) => n.id));
    const counts = new Map<string, number>();
    for (const n of graph.nodes) {
      // scope/aggregate 的展开态各自由 expandedScopes/expandedGroups 管，
      // 不走 produces toggle——跳过，避免给它们算出一个无意义的数。
      if (isScopeNode(n) || isAggregateNode(n)) continue;
      counts.set(n.id, countFoldedProducesMembers(subgraph, n.id, visibleIds));
    }
    return counts;
  }, [graph, subgraph]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Entry focus (autoChain path): when opened from the artifact/evidence modals
  // the explorer mounts with ``selectedId = initialNodeId`` (the entry node is
  // pre-selected and visible in the skeleton). Rather than fetching a chain —
  // which landed a narrow single-edge highlight that read as "just a ring" —
  // the entry now simply highlights the selected node and dims everything else
  // (the "fog" effect the user asked for). ``focusNodeId`` carries the entry
  // node id; it's used as matchIds when no chain/search is active. The user
  // picks the chain themselves by clicking a per-node button (clearing the
  // focus first), so the full-graph → chain-overlay transition is explicit.
  useEffect(() => {
    if (!autoChain || !initialNodeId || autoChainDone) return;
    // Mark done the moment we've decided what to do, whether the entry node is
    // in the folded view (focus it) or not (abort). Aborting without marking
    // done would re-fire this on every graph change.
    setAutoChainDone(true);
    // Look up the entry node in the RAW subgraph, NOT the projected ``graph``:
    // the entry node is often a produces member that ``projectToCanvas`` folds
    // away (so it's absent from ``graph.nodes`` until ``focusNodeId`` keeps it
    // via extraKeepIds). Reading ``graph.nodes`` here would create a chicken-
    // and-egg loop — focus never set because the node isn't in the projected
    // set, and the node isn't kept because focus isn't set. The raw subgraph
    // always contains it, so anchor the lookup there.
    const node = subgraph.nodes.find((n) => n.id === initialNodeId);
    if (!node) return;
    setFocusNodeId(initialNodeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoChain, initialNodeId, autoChainDone, subgraph]);

  // Only offer categories that actually occur, with their counts.
  const labelCounts = useMemo(() => {
    const present = new Set<MemoryGraphNodeLabel>();
    for (const node of graph.nodes) present.add(node.label);
    return NODE_LABELS.filter((label) => present.has(label)).map((label) => ({ label }));
  }, [graph]);

  const edgeCounts = useMemo(() => {
    const present = new Set<MemoryGraphEdgeType>();
    for (const edge of graph.edges) present.add(edge.type);
    return EDGE_TYPES.filter((type) => present.has(type)).map((type) => ({ type }));
  }, [graph]);

  const selected = graph.nodes.find((node) => node.id === selectedId);
  // availableButtons：当前选中节点实际「有内容」的按钮——按钮显不显不靠
  // 前端从 subgraph 抓同类型边预判（那会误显：如无 stated_in 的 Evidence 也
  // 显示「查看引用该证据的产物」，因为全图有 supports），而是问后端：
  // POST /query/chain-exists 把该节点所有按钮的 kind 一次送过去，后端用和
  // 点击完全相同的 _BUTTON_CHAIN_HOPS hop 表走一遍，返回每个 kind 是否能从
  // 源走到 ≥1 个新节点。False 的按钮（短链走不通）隐藏。同一 hop 表保证：
  // 显示的按钮点下去一定有非空短链。
  // selected 切换时 version 也变（Artifact 源带 version），随依赖一起重判。
  const [buttonExists, setButtonExists] = useState<Record<string, boolean>>({});
  const selectedVersion = selected?.extra?.version as number | undefined;
  useEffect(() => {
    if (!selected) { setButtonExists({}); return; }
    const btns = CHAIN_BUTTONS[selected.label] ?? [];
    if (btns.length === 0) { setButtonExists({}); return; }
    const kinds = btns.map((b) => b.kind);
    let active = true;
    void client.chainExists(selected.id, sessionId, selectedVersion, kinds)
      .then((r) => { if (active) setButtonExists(r ?? {}); })
      // On failure do NOT wipe the map — the BFF returns all-false when the
      // sidecar is down or a kind 400s, which is indistinguishable here from
      // "no chain exists". Clearing would hide the whole button group (the bar
      // stays mounted for height stability but shows zero buttons), making the
      // node look chain-less during a transient sidecar blip. Keep the previous
      // verdict so the buttons stay until a real result lands.
      .catch(() => { /* keep previous buttonExists */ });
    return () => { active = false; };
    // Depend on selected?.id (not the `selected` object): the graph is polled,
    // each snapshot yields a fresh node object with the same id, so depending
    // on `selected` re-fires chainExists on every poll and flickers the button
    // bar with an empty gap. selectedVersion still varies for Artifact sources.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, selected?.id, selected?.label, sessionId, selectedVersion]);
  const availableButtons = useMemo<ChainButton[]>(() => {
    if (!selected) return [];
    return (CHAIN_BUTTONS[selected.label] ?? []).filter((b) => buttonExists[b.kind]);
  }, [selected, buttonExists]);
  // Repeated names are numbered on the canvas; the status line has to agree
  // with what the user is looking at.
  const displayNames = useMemo(() => graphNodeDisplayNames(graph.nodes), [graph]);

  // --- First-open tour + meaning bubbles (doc16 §1.5 redesign) ------------
  // Lives AFTER labelCounts/edgeCounts/graph/selected are declared (these are
  // block-scoped consts the effects below read), so there is no use-before-
  // declare. All localStorage reads/writes are guarded for SSR (typeof window)
  // so the node test path (tsx --test imports pure functions only, never
  // renders this component) and any non-DOM environment degrade to "no
  // tour/bubble" rather than throwing on `localStorage is not defined`.
  const TOUR_SEEN_KEY = "memoryGraphTourSeen";
  // DEBUG: when false the tour pops on EVERY open (ignores the seen flag) so the
  // tour itself can be iterated on. Flip back to true before opening the PR so
  // end users only see it once per session.
  const TOUR_ONCE = true;
  const storage = typeof window !== "undefined" ? window.localStorage : undefined;

  const [tourOpen, setTourOpen] = useState(false);
  // The entry path decides step-1 copy: card (right-rail, no autoChain) lands
  // on the spine; chain (product/evidence modal, autoChain) lands on a chain.
  const tourEntry: "card" | "chain" = autoChain ? "chain" : "card";

  // Pop the tour on first open only (no localStorage flag), but for the chain
  // entry wait until autoChain has settled (the chain fetch landed / found
  // nothing) so step-1 copy matches what's on screen — otherwise the tour
  // overlays the spine→chain transition. deps mirror the autoChain effect's
  // settle signals (autoChainDone / chainLoading).
  useEffect(() => {
    if (TOUR_ONCE && storage?.getItem(TOUR_SEEN_KEY)) return;
    if (autoChain && (!autoChainDone || chainLoading)) return;
    setTourOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoChain, autoChainDone, chainLoading]);

  const closeTour = useCallback(() => {
    storage?.setItem(TOUR_SEEN_KEY, "1");
    setTourOpen(false);
  }, [storage]);

  // A — always-on hover lookup. Hovering a filter chip shows its one-line
  // meaning in a bubble; leaving hides it. The canvas is NOT animated (no
  // highlight/dim). Click still toggles the filter (unchanged) — hover is a
  // passive layer over the existing chip, not a new click target.
  const [hoverMeaning, setHoverMeaning] = useState<FirstSeenState | null>(null);
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);

  // A parent-file click in the embedded provenance panel both switches the
  // left artifact (handled inside ArtifactModal) AND drives the right graph
  // to follow along: find the matching Artifact node and select it, which the
  // canvas reads as "highlight + pan/zoom into view". When the parent isn't
  // in the current view (typical for a chain, which carries the
  // Artifact itself plus its Task/ToolCall/Code/ResearchGoal spine but not the
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
      // Search and chain/focus are mutually exclusive highlight modes (all
      // reuse matchIds for dim/highlight). A new search clears any active
      // chain overlay + entry focus so the modes never compete for matchIds.
      setChain(undefined);
      setChainSlice(undefined);
      setFocusNodeId(undefined);
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

  // Walk one node's chain and overlay it as a highlight on the full-graph
  // skeleton (chain no longer replaces the canvas — see graph memo). The node
  // to walk defaults to ``selected`` (the chain-bar buttons walk whatever is
  // selected) but the auto-chain path passes ``nodeId`` explicitly: by the time
  // auto-chain fires, ``selected`` may have moved on (the user can click a
  // scope node during the render cycle between mount and the auto-chain
  // effect, and a scope node's "artifact" chain is a degenerate 1-node result).
  // Taking the id as an argument — rather than reading ``selected`` from the
  // closure — keeps auto-chain anchored to the entry node the modal asked for.
  //
  // ``button`` carries the walk kind + the edge-type slice + pick that tell
  // chainEdgeKeys which edges to bold (and chainNodeIds reuses the whole chain
  // node set for matchIds). Switching between buttons of the SAME kind on one
  // node re-fetches (the slice differs but the backend walk is identical — a
  // future optimization could cache per (nodeId, kind); for now the simplicity
  // of always fetching keeps the overlay in sync with any graph change).
  async function showChain(
    button: ChainButton,
    opts?: { nodeId?: string; version?: number },
  ): Promise<void> {
    const { nodeId, version } = opts ?? {};
    const source = nodeId ? graph.nodes.find((n) => n.id === nodeId) ?? selected : selected;
    if (!source) return;
    setChainLoading(true);
    try {
      const result = await client.getMemoryChain(source.id, sessionId, version, button.kind);
      if (!result.nodes.length) { onError("No chain was found for this node."); return; }
      setChain({
        graph: { edges: result.edges, nodes: result.nodes, total: result.total, truncated: result.truncated },
        sourceName: graphNodeName(source),
        sourceId: source.id,
      });
      setChainSlice(button);
      // Chain overlay takes over the highlight — drop the entry focus so the
      // two matchIds sources never compete.
      setFocusNodeId(undefined);
      clearSearch();
      // The chain overlay highlights a slice of one node's chain on top of the
      // full skeleton. Any previously-active node-label or edge-type filter
      // would silently hide members of that chain (they're dimmed by matchIds,
      // not removed — but a label filter *removes* them). Drop both filters so
      // the chain renders in full; clearing here (not at click time) means a
      // failed fetch leaves the prior overlay intact.
      setActiveLabels(new Set());
      setActiveEdges(new Set());
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not load the chain");
    } finally {
      setChainLoading(false);
    }
  }

  // Toggle a subagent scope's expansion. Collapsed → fetch the scope's child
  // subtree (getScopeExpansion), cache it, merge it in (the surrogate edges
  // for this scope are dropped by mergeExpansions). Expanded → drop the scope
  // from the expanded set; the surrogates reappear and the children vanish
  // (one relation, one visible edge, in either state — §3.3). A 404 / unreachable
  // scope leaves it collapsed with a "scope gone" notice rather than crashing.
  const toggleScope = useCallback(async (scopeTaskId: string) => {
    // Folding: remove the expansion + its note; surrogates come back via the
    // merge filter no longer dropping this scope's edges.
    if (expandedScopes.has(scopeTaskId)) {
      setExpandedScopes((current) => {
        const next = new Set(current);
        next.delete(scopeTaskId);
        return next;
      });
      setScopeNotes((current) => {
        if (!current.has(scopeTaskId)) return current;
        const next = new Map(current);
        next.delete(scopeTaskId);
        return next;
      });
      return;
    }
    if (expandingScopes.has(scopeTaskId)) return;
    setExpandingScopes((current) => new Set(current).add(scopeTaskId));
    try {
      const expansion = await client.getScopeExpansion(scopeTaskId, sessionId);
      setExpansionGraphs((current) => {
        const next = new Map(current);
        next.set(scopeTaskId, expansion);
        return next;
      });
      // An expansion with no children/products is a "no products yet" scope:
      // surface a notice instead of a blank expansion (doc16 §2.5). node_not_found
      // (scope deleted between fold + expand) and memory_graph_unreachable get
      // their own notices so the user knows the scope is gone, not empty.
      // Such a scope is NOT added to expandedScopes — it has nothing to expand,
      // so leaving it "collapsed" means every subsequent double-click re-fetches
      // and re-shows the notice (rather than the second click silently folding
      // an empty expansion with no notice, which read as "the hint disappeared").
      if (expansion.reason === "node_not_found") {
        setScopeNotes((current) => new Map(current).set(scopeTaskId, t("scope.gone")));
      } else if (expansion.reason === "memory_graph_unreachable") {
        setScopeNotes((current) => new Map(current).set(scopeTaskId, t("memory.unreachable")));
      } else if (!expansion.nodes.length && !expansion.edges.length) {
        setScopeNotes((current) => new Map(current).set(scopeTaskId, t("scope.noProducts")));
      } else {
        // Non-empty: actually expand. Only here does the scope enter the
        // expanded set (a subsequent double-click then folds it for real).
        setExpandedScopes((current) => new Set(current).add(scopeTaskId));
        setScopeNotes((current) => {
          if (!current.has(scopeTaskId)) return current;
          const next = new Map(current);
          next.delete(scopeTaskId);
          return next;
        });
      }
    } catch (error) {
      // The request layer rejects on 404 (scope absent / not a subagent) and
      // on transport errors. Keep the scope collapsed; the notice tells the
      // user why rather than silently doing nothing.
      const message = error instanceof Error ? error.message : "";
      setScopeNotes((current) => new Map(current).set(
        scopeTaskId,
        /not found|404/i.test(message) ? t("scope.gone") : t("scope.expandFailed"),
      ));
    } finally {
      setExpandingScopes((current) => {
        const next = new Set(current);
        next.delete(scopeTaskId);
        return next;
      });
    }
  }, [client, sessionId, expandingScopes, expandedScopes, t]);

  // Aggregate expansion (需求3): clicking an Artifacts/Papers aggregate node
  // unpacks its member products into the on-screen graph (a separate fetch +
  // merge from scope expansion — this only unpacks the members of one kind,
  // NOT the scope's child subtree). Folding removes the members + the
  // surrogate scope→member edges; the virtual aggregate node reappears.
  // Idempotent against the 8s poll: the cached payload re-merges without
  // re-fetching. A 404 (malformed id / scope gone) leaves it collapsed with
  // a notice rather than crashing.
  const toggleGroup = useCallback(async (groupId: string) => {
    if (expandedGroups.has(groupId)) {
      setExpandedGroups((current) => {
        const next = new Set(current);
        next.delete(groupId);
        return next;
      });
      return;
    }
    if (expandingGroups.has(groupId)) return;
    setExpandingGroups((current) => new Set(current).add(groupId));
    try {
      const expansion = await client.getGroupExpansion(groupId, sessionId);
      setGroupGraphs((current) => {
        const next = new Map(current);
        next.set(groupId, expansion);
        return next;
      });
      setExpandedGroups((current) => new Set(current).add(groupId));
    } catch {
      // 404 (malformed id / scope gone) or transport error: leave the
      // aggregate collapsed. No notice row keyed by group id — aggregates are
      // transient view nodes, so a failed expand just no-ops visually.
    } finally {
      setExpandingGroups((current) => {
        const next = new Set(current);
        next.delete(groupId);
        return next;
      });
    }
  }, [client, sessionId, expandingGroups, expandedGroups]);

  // produces 成员折叠（规则3）：双击非 scope/aggregate 节点 → 展开其直接
  // 相邻的 produces/citation 成员（一层，只拉当前不可见的）；已展开时再
  // 双击 → 折叠它亲手拉进来的子树。纯客户端，不 fetch——成员已在 subgraph
  // 里（后端 get_subgraph 返回全图，折叠是前端投影）。「谁展开谁折叠」模型
  // （仿 Neo4j，边为中心）：展开记新成员到 owner 名下，折叠只删 owner 名下
  // 的 + 递归。对端节点若被别的 owner 拉进来，折叠当前 owner 不碰它。
  const toggleProduces = useCallback((ownerId: string) => {
    setExpandedNodeMap((current) => {
      // 判定「已展开」只看 expandedNodeMap 里有没有这个 key（对齐 Neo4j
      // nodeDblClicked 的 `if (d.expanded)`——节点级布尔标志，展开过即 true，
      // 与名下当前记了多少子节点无关）。Neo4j 折叠后把 expandedNodeMap[id]
      // 置空数组（key 仍在），我们折叠时 delete key，所以「key 在不在」等价于
      // 「展开过没有」。这样 report2.md 这类展开过但名下已被清空的节点，双击
      // 走折叠分支：collapseProducesOwner 对空/不存在的子集返回空，静默 no-op，
      // 不弹「无可展开子节点」toast（对齐 Neo4j collapseNode 对空 map 的 return）。
      if (current.has(ownerId)) {
        // 浅层折叠（仿新版 Neo4j Browser）：collapseProducesOwner 只返回 owner
        // 亲手拉进来的**直接子**（不递归孙）。从 appearedIds 移除这些直接子 →
        // 它们从 keep 消失（节点 + 触边一起没，因为两端不齐）。孙辈留在
        // appearedIds → 仍可见（脱离被删的 owner 也留，Neo4j nodeMap 语义）。
        // 例：report2 名下 Claim、Claim 名下 Evidence；折叠 report2 移除
        // Claim（直接子），Evidence 留（孙，不在 remove）→ Claim 消失、
        // report2↔Claim 边断、Evidence 留着连 Paper。
        const remove = collapseProducesOwner(current, ownerId);
        const next = new Map(current);
        next.delete(ownerId);  // 清 owner 的条目（折叠后不再是展开态）
        // 从 appearedIds 移除直接子（浅层——只 remove 里的，不含孙）。
        setAppearedIds((prev) => {
          if (remove.size === 0) return prev;
          const n = new Set(prev);
          for (const r of remove) n.delete(r);
          return n;
        });
        // 对 toRemove 的每个 id：从**所有** owner 的列表清引用（防御残留）。
        for (const [oid, children] of next) {
          if (remove.size === 0) break;
          let changed = false;
          const filtered = new Set<string>();
          for (const c of children) {
            if (remove.has(c)) changed = true;
            else filtered.add(c);
          }
          if (changed) next.set(oid, filtered);
        }
        // 折叠后清掉这个 owner 上可能挂着的"无可展开子节点"toast。
        setScopeNotes((notes) => {
          if (!notes.has(ownerId)) return notes;
          const nextNotes = new Map(notes);
          nextNotes.delete(ownerId);
          return nextNotes;
        });
        return next;
      }
      // 展开：算 owner 当前还能拉进来的**新**成员（仿 Neo4j addExpandedNodes
      // 的 if findNode==null，只记当前不可见的）。visibleIds = 当前投影图节点集。
      const visibleIds = new Set(graph.nodes.map((n) => n.id));
      const fresh = expandProducesOwner(subgraph, ownerId, visibleIds);
      if (fresh.size === 0) {
        // 拉不出新成员，分两种情况（沿用可见性感知的两层判定）：
        //  (a) owner 本就无任何 produces 相邻成员（如 ResearchGoal 子节点走
        //      next）→ 静默 no-op，不弹 toast。
        //  (b) 有成员但都已可见（如 sub_analysis2.txt Artifact 相邻 Code/Task
        //      随别的展开已可见）→ 弹 toast「无可展开子节点」。
        if (producesMembersOf(subgraph, ownerId).size > 0) {
          setScopeNotes((notes) => new Map(notes).set(ownerId, t("scope.noProducts")));
        }
        return current;
      }
      const next = new Map(current);
      next.set(ownerId, fresh);
      // 拉进来的新成员进 appearedIds（等价 Neo4j addExpandedNodes 把新节点加进
      // nodeMap——永久在，除非显式折叠移除）。折叠时只移除直接子，这些节点
      // 脱离 owner 仍可见。
      setAppearedIds((prev) => {
        const n = new Set(prev);
        for (const f of fresh) n.add(f);
        return n;
      });
      return next;
    });
  }, [subgraph, graph, t]);

  // Clicking a surrogate edge (scope→product) jumps to the responsible child:
  // expand the owning scope and select the child that via_child points at
  // (the real child→product edge then renders in the merged graph). This is
  // the core reason the surrogate exists — the folded view is navigable into
  // the expanded subtree (总方案 §2.4). Falls back to selecting the product
  // when via_child is missing (older payloads) so the click is never a dead end.
  const handleEdgeClick = useCallback((edge: { surrogate: boolean; viaChild?: string; source: string; target: string; type: MemoryGraphEdgeType }) => {
    if (!edge.surrogate) return;
    const scopeId = edge.source;
    const selectAfter = (id: string | undefined) => {
      if (id) setSelectedId(id);
    };
    if (edge.viaChild) {
      // Ensure the scope is expanded (idempotent if already open), then pick
      // the child. The expansion merge is synchronous once cached; a fresh
      // fetch lands on the next render, but we can still select by id now —
      // the selection pans once the merged graph rebuilds.
      void toggleScope(scopeId).finally(() => selectAfter(edge.viaChild));
      return;
    }
    selectAfter(edge.target);
  }, [toggleScope]);
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

  return <div className="memory-explorer-backdrop" onMouseDown={(event) => {
    // A scope notice is a one-shot center toast: clicking ANYWHERE outside the
    // toast itself (backdrop, canvas, header, any panel) clears it. The toast
    // has no dismiss button — the whole backdrop acts as the dismiss target.
    if (scopeNotes.size > 0 && !(event.target as Element | null)?.closest(".memory-explorer-scope-toast")) {
      setScopeNotes(new Map());
    }
    if (event.target === event.currentTarget) onClose();
  }}>
    <section aria-label="ScienceMemory explorer" aria-modal="true" className="memory-explorer-panel" role="dialog">
      <header className="memory-explorer-header">
        <div>
          <span className="eyebrow">Session knowledge</span>
          <h2>ScienceMemory</h2>
        </div>
        <div className="memory-explorer-stats">
          <form className="memory-explorer-search" onSubmit={(event) => void runSearch(event)} role="search">
            <input
              aria-label="Search the ScienceMemory"
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
          <button aria-label="Close ScienceMemory" className="icon-button" onClick={onClose} title="Close ScienceMemory" type="button"><CloseIcon size={20} /></button>
        </div>
      </header>

      {chain ? <div className="memory-chain-banner">
        <span>{t("chain.for", { name: chain.sourceName })}</span>
        <button onClick={() => { setChain(undefined); setChainSlice(undefined); setFocusNodeId(undefined); clearSearch(); }} type="button">{t("chain.backToFullGraph")}</button>
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
            onOpenEvolveRun={onOpenEvolveRun}
            onSelectNode={setSelectedId}
            resolveState={resolveState}
            sessionId={sessionId}
            subgraph={graph}
            scopeChildCounts={scopeChildCounts}
          />}
        </div>

        <div className="memory-explorer-right">
          {/* Above the canvas: the filters are a control, and controls belong
              where the eye lands first. Below the graph they read as a legend
              and were easy to miss entirely. */}
          <div className="memory-explorer-filters">
            <div className="memory-filter-block">
              <span className="memory-filter-title">Nodes ({graph.nodes.length})</span>
              <div className="memory-filter-chips">
                {/* Node-label chips render as Neo4j-Browser-style pill/capsule
                    tags: a single rounded button whose border-radius is exactly
                    half its height (24px / 2 = 12px), so both ends form complete
                    semicircles. No SVG, no point caps — unlike the relationship
                    chips' hexagon. Background stays per-label (NODE_COLORS). */}
                {labelCounts.map(({ label }) => <span
                  className="memory-chip-wrap"
                  data-legend-id={label}
                  data-legend-kind="node"
                  key={label}
                  onMouseEnter={(e) => { setHoverMeaning({ kind: "node", id: label }); setHoverRect(e.currentTarget.getBoundingClientRect()); }}
                  onMouseLeave={() => setHoverMeaning(null)}
                ><button
                  aria-pressed={activeLabels.has(label)}
                  className={activeLabels.has(label) ? "memory-chip node-chip active" : "memory-chip node-chip"}
                  onClick={() => toggleLabel(label)}
                  style={{ background: NODE_COLORS[label], color: "#1a1b1d" }}
                  type="button"
                >{label}</button></span>)}
              </div>
            </div>
            <div className="memory-filter-block">
              <span className="memory-filter-title">Relationships ({graph.edges.length})</span>
              <div className="memory-filter-chips">
                {/* Relationship chips render as Neo4j-Browser-style double-pointed
                    hexagon tags: a flat body flanked by left/right SVG point caps.
                    The same path is used for both caps; the right cap is mirrored
                    via scaleX(-1). Background colour is carried on --chip-bg so all
                    three pieces share one fill; typography is untouched. */}
                {edgeCounts.map(({ type }) => <span
                  className="memory-chip-wrap"
                  data-legend-id={type}
                  data-legend-kind="edge"
                  key={type}
                  onMouseEnter={(e) => { setHoverMeaning({ kind: "edge", id: type }); setHoverRect(e.currentTarget.getBoundingClientRect()); }}
                  onMouseLeave={() => setHoverMeaning(null)}
                ><button
                  aria-pressed={activeEdges.has(type)}
                  className={activeEdges.has(type) ? "memory-chip rel-chip active" : "memory-chip rel-chip"}
                  onClick={() => toggleEdge(type)}
                  style={{ ["--chip-bg" as string]: "#e2e3e5", color: "#1a1b1d" }}
                  type="button"
                ><span className="rel-chip-cap" aria-hidden="true"><svg width="9" height="24" viewBox="0 0 9 24" preserveAspectRatio="none"><path d="M5.73024 1.03676C6.08165 0.397331 6.75338 0 7.48301 0H9V24H7.483C6.75338 24 6.08165 23.6027 5.73024 22.9632L0.315027 13.1094C-0.105009 12.4376 -0.105009 11.5624 0.315026 10.8906L5.73024 1.03676Z" /></svg></span><span className="rel-chip-body">{type}</span><span className="rel-chip-cap rel-chip-cap-right" aria-hidden="true"><svg width="9" height="24" viewBox="0 0 9 24" preserveAspectRatio="none"><path d="M5.73024 1.03676C6.08165 0.397331 6.75338 0 7.48301 0H9V24H7.483C6.75338 24 6.08165 23.6027 5.73024 22.9632L0.315027 13.1094C-0.105009 12.4376 -0.105009 11.5624 0.315026 10.8906L5.73024 1.03676Z" /></svg></span></button></span>)}
                {filtered ? <button className="memory-chip reset" onClick={() => { setActiveLabels(new Set()); setActiveEdges(new Set()); }} type="button">Clear filters</button> : null}
              </div>
            </div>
          </div>

          {/* Per-node chain buttons sit directly under the filter chips, above
              the canvas — along the graph's top edge so the buttons that drive
              the chain overlay sit where the eye lands (with the other graph
              controls), not buried under the left-side detail card. Each button
              overlays one semantic slice of the selected node's chain on the
              skeleton (nodes via matchIds, edges via chainEdgeKeys) and dims
              the rest. ResearchGoal/ToolCall get no buttons (spine root/leaf). */}
          {/* The bar is mounted whenever a node is selected — not gated on
              availableButtons.length. chainExists is async: gating the bar on
              a non-empty result made the bar unmount during the fetch gap
              (length 0 -> null), which collapsed its 66px min-height and jolted
              the canvas below (canvas is flex:1, so it reflows on any bar
              height change). Mounting the bar for every selection keeps its
              height stable across node switches; while the new chain-exists
              result hasn't arrived, availableButtons is empty and the bar
              simply shows no buttons rather than disappearing. */}
          {selected ? <div className="memory-chain-bar">
            {availableButtons.map((btn) => (
              <button
                aria-pressed={chainSlice?.key === btn.key}
                className={chainSlice?.key === btn.key ? "active" : undefined}
                disabled={chainLoading}
                key={btn.key}
                onClick={() => void showChain(btn, {
                  nodeId: selected.id,
                  version: selected.extra?.version as number | undefined,
                })}
                type="button"
              >
                {chainLoading && chainSlice?.key === btn.key ? t("chain.loading") : t(btn.key)}
              </button>
            ))}
          </div> : null}

          <div className="memory-explorer-canvas">
            <MemoryGraphCanvas
              interactive
              matchIds={chainNodeIds ?? (focusNodeId ? new Set([focusNodeId, ...(selectedId && selectedId !== focusNodeId ? [selectedId] : [])]) : matchIds)}
              chainEdgeKeys={chainEdgeKeys}
              onSelect={(id) => { setSelectedId(id); }}
              selectedId={selectedId}
              subgraph={graph}
              visibleEdgeTypes={visibleEdgeTypes}
              visibleLabels={visibleLabels}
              expandedScopes={expandedScopes}
              scopeChildCounts={scopeChildCounts}
              onToggleScope={(id) => void toggleScope(id)}
              expandedGroups={expandedGroups}
              onToggleGroup={(id) => void toggleGroup(id)}
              onEdgeClick={handleEdgeClick}
              scopeHints={{ expand: t("scope.clickExpand"), collapse: t("scope.clickCollapse") }}
              expandedNodeMap={expandedNodeMap}
              onToggleProduces={(id) => toggleProduces(id)}
              producesHints={{ expand: t("scope.clickExpand"), collapse: t("scope.clickCollapse") }}
              foldedProducesCounts={foldedProducesCounts}
            />
            {scopeNotes.size > 0 ? (
              // Grey scrim + center notice, scoped to the GRAPH area only (not
              // the whole Science Memory panel — the header/filters/product
              // panel stay clear). The scrim greys out the graph to focus the
              // notice; clicking anywhere outside the notice (scrim, backdrop,
              // canvas, any panel) clears it. stopPropagation on the notice so
              // the backdrop's dismiss handler doesn't fire when clicking it.
              <>
                <div
                  className="memory-explorer-scope-scrim"
                  onMouseDown={(event) => { event.stopPropagation(); setScopeNotes(new Map()); }}
                />
                <div
                  className="memory-explorer-scope-toast"
                  role="status"
                  aria-live="polite"
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  <span className="memory-explorer-scope-toast-msg">{[...scopeNotes.values()].join(" · ")}</span>
                </div>
              </>
            ) : null}
            <p className="memory-explorer-hint">
              {selected ? `Selected: ${displayNames.get(selected.id) ?? graphNodeName(selected)}` : "Click a node to inspect its product"} · drag to pan · scroll to zoom
            </p>
          </div>

          {/* First-open tour (doc16 §1.5). Scrim covers the canvas area only;
              any close path writes the localStorage seen-flag via closeTour so
              it never re-pops. Esc is captured locally by the tour so it does
              not collide with this explorer's global Escape→onClose. */}
          <MemoryGraphTour
            entry={tourEntry}
            nodeName={selected ? graphNodeName(selected) : undefined}
            onClose={closeTour}
            open={tourOpen}
            t={t}
          />

          {/* Meaning bubble — A (hover lookup). Hovering a filter chip shows
              its one-line meaning; leaving hides it. The canvas is not
              animated. */}
          {hoverMeaning && hoverRect ? (
            <MeaningBubble
              anchorRect={hoverRect}
              id={hoverMeaning.id}
              kind={hoverMeaning.kind}
              t={t}
            />
          ) : null}
        </div>
      </div>
    </section>
  </div>;
}
