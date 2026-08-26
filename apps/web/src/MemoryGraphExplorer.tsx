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
import { aggregateOwnerScope, EDGE_COLORS, graphNodeDisplayNames, graphNodeName, isAggregateNode, isChildNode, isScopeNode, isSurrogateEdge, MemoryGraphCanvas, NODE_COLORS } from "./MemoryGraphCanvas.js";
import { MemoryGraphNodeDetail, useResolvedArtifactName } from "./MemoryGraphProduct.js";
import { ArtifactModal } from "./ScientificArtifacts.js";

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
  const { t } = useLocale();

  // The graph actually on screen: a chain when one is open, else the
  // session subgraph with every expanded scope's child subtree + every
  // expanded aggregate's member products merged in (an expanded scope's
  // surrogate edges dropped — the real edges take over; an expanded
  // aggregate's virtual node dropped — the real member products take over).
  // In the chain view, ``mergeExpansions`` is NOT used — a chain is itself a
  // folded read whose child nodes are already visible (no subtree to
  // subtract), so scope expansion is overlaid via ``mergeChainScopeExpansions``
  // instead: each expanded scope's child subtree nodes + real edges are unioned
  // onto the chain (self-loops + surrogates skipped). Letting a user expand a
  // scope inside a chain is the "链内就地展开" choice — the chain keeps its
  // spine shape and the scope's children light up connected to it.
  const graph = (chain
    ? mergeChainScopeExpansions(chain.graph, expansionGraphs, expandedScopes)
    : mergeExpansions(subgraph, expansionGraphs, expandedScopes, groupGraphs, expandedGroups));

  // Per-scope true child counts, built once from the raw folded subgraph
  // (the full session read — children included, pre-fold). The canvas reads
  // this for the "▸ N" badge so the count is stable across collapse/expand
  // (counting visible contains edges reads 0 while collapsed). Memoised on
  // the raw node set so it does not flip on every expansion toggle.
  const scopeChildCounts = useMemo(() => buildScopeChildCounts(subgraph.nodes), [subgraph]);

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
    // Mark the auto-chain attempt done the moment we've decided what to do —
    // whether the entry node is in the folded view (walk its chain now) or not
    // (abort). The entry node is a top-level Artifact/Paper/Claim/Evidence
    // surfaced by the artifact/evidence modal; it is visible in the folded read
    // (a scope's folded subtree never swallows a node that isn't its own
    // descendant). Aborting without marking done would re-fire this effect on
    // every graph change (the `graph` dep), and a later expand that surfaced
    // the node would then auto-chain against whatever ``selected`` had become
    // in the meantime — a stale closure that walked the wrong node's chain.
    setAutoChainDone(true);
    if (!node) return;
    const autoKind: "full" | "task" | "artifact" = initialChainKind ?? (
      node.label === "Paper" || node.label === "Evidence" || node.label === "Claim" || node.label === "Artifact"
        ? "artifact"
        : "full"
    );
    // Pass initialNodeId explicitly: by the time this fires, ``selected`` may
    // have moved to a scope node the user clicked during the render cycle, and
    // a scope node's "artifact" chain is a degenerate 1-node result.
    void showChain(initialVersion, autoKind, initialNodeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoChain, initialNodeId, autoChainDone, chain, chainLoading, graph]);

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
  // Repeated names are numbered on the canvas; the status line has to agree
  // with what the user is looking at.
  const displayNames = useMemo(() => graphNodeDisplayNames(graph.nodes), [graph]);

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

  // Walk one node's upstream/downstream chain and replace the on-screen graph
  // with it. The node to walk defaults to ``selected`` (the chain-bar buttons
  // "View chain" / "View task chain" / "View artifact chain" walk whatever is
  // selected) but the auto-chain path passes ``initialNodeId`` explicitly: by
  // the time auto-chain fires, ``selected`` may have moved on (the user can
  // click a scope node during the render cycle between mount and the auto-chain
  // effect, and a scope node's "artifact" chain is a degenerate 1-node result).
  // Taking the id as an argument — rather than reading ``selected`` from the
  // closure — keeps auto-chain anchored to the entry node the modal asked for.
  async function showChain(
    version?: number,
    chainKind: "full" | "task" | "artifact" = "full",
    nodeId?: string,
  ): Promise<void> {
    const source = nodeId ? graph.nodes.find((n) => n.id === nodeId) ?? selected : selected;
    if (!source) return;
    setChainLoading(true);
    try {
      const result = await client.getMemoryChain(source.id, sessionId, version, chainKind);
      if (!result.nodes.length) { onError("No chain was found for this node."); return; }
      setChain({
        graph: { edges: result.edges, nodes: result.nodes, total: result.total, truncated: result.truncated },
        sourceName: graphNodeName(source),
      });
      clearSearch();
      // The chain view replaces the visible graph with one node's upstream /
      // downstream chain, which is fixed in shape (the backend already
      // resolved it). Any previously-active node-label or edge-type filter
      // would silently hide members of that chain and leave the user looking
      // at a partial view with no obvious cause. Drop both filters so the
      // chain renders in full; clearing here (not at click time) means a
      // failed fetch leaves the prior view intact.
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
            scopeChildCounts={scopeChildCounts}
          />}
          {selected ? <div className="memory-chain-bar">
            {/* Artifact nodes get two buttons (task chain + artifact chain);
                every other node gets a single "View chain" button. ResearchGoal/
                Task/ToolCall/Code walk the full joint subgraph; Paper/Evidence/Claim
                walk the directed artifact chain (report anchor → selected node). */}
            {(selected.label === "ResearchGoal" || selected.label === "Task" || selected.label === "ToolCall" || selected.label === "Code") && (
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
                {/* Node-label chips render as Neo4j-Browser-style pill/capsule
                    tags: a single rounded button whose border-radius is exactly
                    half its height (24px / 2 = 12px), so both ends form complete
                    semicircles. No SVG, no point caps — unlike the relationship
                    chips' hexagon. Background stays per-label (NODE_COLORS). */}
                {labelCounts.map(({ label }) => <button
                  aria-pressed={activeLabels.has(label)}
                  className={activeLabels.has(label) ? "memory-chip node-chip active" : "memory-chip node-chip"}
                  key={label}
                  onClick={() => toggleLabel(label)}
                  style={{ background: NODE_COLORS[label], color: "#1a1b1d" }}
                  type="button"
                >{label}</button>)}
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
                {edgeCounts.map(({ type }) => <button
                  aria-pressed={activeEdges.has(type)}
                  className={activeEdges.has(type) ? "memory-chip rel-chip active" : "memory-chip rel-chip"}
                  key={type}
                  onClick={() => toggleEdge(type)}
                  style={{ ["--chip-bg" as string]: "#e2e3e5", color: "#1a1b1d" }}
                  type="button"
                ><span className="rel-chip-cap" aria-hidden="true"><svg width="9" height="24" viewBox="0 0 9 24" preserveAspectRatio="none"><path d="M5.73024 1.03676C6.08165 0.397331 6.75338 0 7.48301 0H9V24H7.483C6.75338 24 6.08165 23.6027 5.73024 22.9632L0.315027 13.1094C-0.105009 12.4376 -0.105009 11.5624 0.315026 10.8906L5.73024 1.03676Z" /></svg></span><span className="rel-chip-body">{type}</span><span className="rel-chip-cap rel-chip-cap-right" aria-hidden="true"><svg width="9" height="24" viewBox="0 0 9 24" preserveAspectRatio="none"><path d="M5.73024 1.03676C6.08165 0.397331 6.75338 0 7.48301 0H9V24H7.483C6.75338 24 6.08165 23.6027 5.73024 22.9632L0.315027 13.1094C-0.105009 12.4376 -0.105009 11.5624 0.315026 10.8906L5.73024 1.03676Z" /></svg></span></button>)}
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
              expandedScopes={expandedScopes}
              scopeChildCounts={scopeChildCounts}
              onToggleScope={(id) => void toggleScope(id)}
              expandedGroups={expandedGroups}
              onToggleGroup={(id) => void toggleGroup(id)}
              onEdgeClick={handleEdgeClick}
              scopeHints={{ expand: t("scope.clickExpand"), collapse: t("scope.clickCollapse") }}
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
        </div>
      </div>
    </section>
  </div>;
}
