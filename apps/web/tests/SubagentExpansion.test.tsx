// Copyright (C) 2026-2026 Huawei Technologies Co, Ltd
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

import assert from "node:assert/strict";
import test from "node:test";

import type { MemorySubgraph } from "@sciencediscovery/schema";

import { buildScopeChildCounts, countScopeChildren, mergeChainScopeExpansions, mergeExpansions } from "../src/MemoryGraphExplorer.js";
import { isNodeCancelled, isNodeCompleted } from "../src/MemoryGraphView.js";

// A minimal folded subgraph: one subagent scope, its surrogate edge to an
// artifact, plus the artifact node. Mirrors the shape get_subgraph returns
// after PR2 (folded surrogate edges synthesised scope→product).
const SCOPE = "subtask:subagent:sub1";
const CHILD = "subtask:subagent:sub1:exec:e1";
const ART = "art1#v1";

function foldedGraph(): MemorySubgraph {
  return {
    nodes: [
      { id: SCOPE, label: "Task", extra: { task_type: "subagent", status: "completed" } },
      { id: ART, label: "Artifact", extra: { artifact_id: "art1", version: 1 } },
    ],
    edges: [
      // Folded surrogate: scope→artifact, type=produces, surrogate+via_child.
      { source: SCOPE, target: ART, type: "produces", extra: { surrogate: true, via_child: CHILD } },
    ],
    total: 2,
    truncated: false,
  };
}

// The expansion getScopeExpansion returns for the scope: the child + its
// real produces edge to the artifact (no surrogate marker). The child and
// the contains spine are the real edges that take over from the surrogate.
function expansionGraph(): MemorySubgraph {
  return {
    nodes: [
      { id: CHILD, label: "ToolCall", extra: { task_type: "code_execution", parent_subtask_id: SCOPE } },
      { id: ART, label: "Artifact", extra: { artifact_id: "art1", version: 1 } },
    ],
    edges: [
      { source: SCOPE, target: CHILD, type: "contains", extra: {} },
      { source: CHILD, target: ART, type: "produces", extra: {} },
    ],
    total: 2,
    truncated: false,
  };
}

test("mergeExpansions with no expanded scopes returns the folded graph's surrogate-only view", () => {
  const folded = foldedGraph();
  const merged = mergeExpansions(folded, new Map(), new Set());
  // The minimal folded fixture is surrogate-only (no child spine), so the
  // collapsed view is content-equal to it — the overlay is a no-op when
  // nothing is expanded and no child subtree needs folding. The merge
  // always rebuilds the object (stability is by content, not identity) so we
  // assert deep-equal content, not reference identity.
  assert.deepEqual(merged.nodes.map((n) => n.id).sort(), folded.nodes.map((n) => n.id).sort());
  assert.equal(merged.edges.length, 1);
  assert.equal(merged.edges[0].extra?.surrogate, true, "folded surrogate stays");
});

test("mergeExpansions drops a folded scope's surrogate when that scope is expanded", () => {
  const folded = foldedGraph();
  const expansions = new Map([[SCOPE, expansionGraph()]]);
  const merged = mergeExpansions(folded, expansions, new Set([SCOPE]));
  // The surrogate scope→artifact must be gone; the real child→artifact edge
  // takes over. One relation, one visible edge — never both (总方案 §2.4).
  const surrogates = merged.edges.filter((e) => e.extra?.surrogate === true);
  assert.equal(surrogates.length, 0, "expanded scope's surrogate must be filtered out");
  const realProduces = merged.edges.filter((e) => e.type === "produces" && e.source === CHILD);
  assert.equal(realProduces.length, 1, "real child→artifact edge is merged in");
  const contains = merged.edges.filter((e) => e.type === "contains");
  assert.equal(contains.length, 1, "contains spine scope→child is merged in");
});

test("mergeExpansions folds back: removing a scope from the set restores its surrogate", () => {
  const folded = foldedGraph();
  const expansions = new Map([[SCOPE, expansionGraph()]]);
  const expanded = mergeExpansions(folded, expansions, new Set([SCOPE]));
  assert.equal(expanded.edges.some((e) => e.extra?.surrogate === true), false);
  // Collapse: the scope is no longer in the set → surrogate reappears, child
  // + real edges vanish (they came only from the expansion overlay).
  const collapsed = mergeExpansions(folded, expansions, new Set());
  assert.equal(collapsed.edges.some((e) => e.extra?.surrogate === true), true, "surrogate restored on collapse");
  assert.equal(collapsed.edges.some((e) => e.source === CHILD), false, "child edges gone on collapse");
  assert.equal(collapsed.nodes.some((n) => n.id === CHILD), false, "child node gone on collapse");
});

test("mergeExpansions keeps a *folded* scope's surrogate when a *different* scope is expanded", () => {
  // Only the surrogates of expanded scopes are dropped; a sibling folded
  // scope keeps its surrogate so the collapsed view still navigates into it.
  const folded = foldedGraph();
  const expansions = new Map([["subtask:subagent:other", expansionGraph()]]);
  const merged = mergeExpansions(folded, expansions, new Set(["subtask:subagent:other"]));
  assert.equal(merged.edges.some((e) => e.source === SCOPE && e.extra?.surrogate === true), true, "unrelated scope's surrogate stays");
});

test("mergeExpansions de-dupes nodes + edges by id / (source,target,type)", () => {
  // The artifact node appears in both the folded set and the expansion; the
  // contains spine is in the expansion only. The merge must not double the
  // artifact or emit a duplicate edge when both carry the same key.
  const folded = foldedGraph();
  const expansions = new Map([[SCOPE, expansionGraph()]]);
  const merged = mergeExpansions(folded, expansions, new Set([SCOPE]));
  const artNodes = merged.nodes.filter((n) => n.id === ART);
  assert.equal(artNodes.length, 1, "artifact node de-duped to one");
  const keys = merged.edges.map((e) => `${e.source}>${e.target}:${e.type}`);
  assert.equal(new Set(keys).size, keys.length, "no duplicate edge keys");
});

test("mergeExpansions is stable: same folded + same expansions → identical content", () => {
  // The 8s poll re-pulls the folded subgraph; the merge must produce a
  // byte-identical result when nothing changed so the canvas signature does
  // not flip and re-layout on every poll (§3.3 "stable expansion subgraph").
  const folded = foldedGraph();
  const expansions = new Map([[SCOPE, expansionGraph()]]);
  const a = mergeExpansions(folded, expansions, new Set([SCOPE]));
  const b = mergeExpansions(folded, expansions, new Set([SCOPE]));
  assert.deepEqual(
    a.nodes.map((n) => n.id).sort(),
    b.nodes.map((n) => n.id).sort(),
  );
  assert.deepEqual(
    a.edges.map((e) => `${e.source}>${e.target}:${e.type}`).sort(),
    b.edges.map((e) => `${e.source}>${e.target}:${e.type}`).sort(),
  );
});

// --- expanded child chain: persisted scope_chain next edges pass through (§2.4) ---

const CHILD2 = "subtask:subagent:sub1:exec:e2";

// An expansion with two children. The backend now persists the scope-internal
// ``next`` chain (persistence.py's ``_link_scope_children`` writes contains→
// first child + next between consecutive children, method='scope_chain') and
// ``get_scope_expansion`` returns those ``next`` edges. The frontend no longer
// synthesises the chain — it merges the persisted edge through (de-duped).
function twoChildExpansion(): MemorySubgraph {
  return {
    nodes: [
      { id: CHILD, label: "ToolCall", extra: { task_type: "code_execution", parent_subtask_id: SCOPE, seq: 5 } },
      { id: CHILD2, label: "ToolCall", extra: { task_type: "mcp_search", parent_subtask_id: SCOPE, seq: 7 } },
    ],
    edges: [
      // contains → first child only (需求1); the rest link via next.
      { source: SCOPE, target: CHILD, type: "contains", extra: {} },
      // Persisted scope-internal next (first → second), method='scope_chain'.
      { source: CHILD, target: CHILD2, type: "next", extra: { inferred: true, basis: "seq", method: "scope_chain" } },
    ],
    total: 2, truncated: false,
  };
}

test("mergeExpansions merges the persisted scope_chain next edge between an expanded scope's children", () => {
  const folded = foldedGraph();
  const expansions = new Map([[SCOPE, twoChildExpansion()]]);
  const merged = mergeExpansions(folded, expansions, new Set([SCOPE]));
  // The persisted CHILD → CHILD2 next edge survives the merge (both endpoints
  // visible once the scope is expanded) — no frontend synthesis.
  const nexts = merged.edges.filter((e) => e.type === "next");
  assert.equal(nexts.length, 1, "one next edge between the two children");
  assert.equal(nexts[0].source, CHILD, "chain runs CHILD → CHILD2");
  assert.equal(nexts[0].target, CHILD2);
  assert.equal(nexts[0].extra?.method, "scope_chain", "persisted scope_chain marker preserved");
});

test("mergeExpansions passes through the persisted child next regardless of expansion-node order", () => {
  // The expansion lists CHILD2 before CHILD; the persisted edge CHILD→CHILD2
  // is carried verbatim (its source/target already encode the order), so the
  // merge does not depend on node-list order.
  const folded = foldedGraph();
  const expansions = new Map<string, MemorySubgraph>([[
    SCOPE,
    {
      nodes: [
        { id: CHILD2, label: "ToolCall", extra: { parent_subtask_id: SCOPE, seq: 7 } },
        { id: CHILD, label: "ToolCall", extra: { parent_subtask_id: SCOPE, seq: 5 } },
      ],
      edges: [
        { source: SCOPE, target: CHILD, type: "contains", extra: {} },
        { source: CHILD, target: CHILD2, type: "next", extra: { method: "scope_chain" } },
      ],
      total: 2, truncated: false,
    },
  ]]);
  const merged = mergeExpansions(folded, expansions, new Set([SCOPE]));
  const nexts = merged.edges.filter((e) => e.type === "next");
  assert.equal(nexts.length, 1);
  assert.equal(nexts[0].source, CHILD, "persisted edge source carried verbatim");
  assert.equal(nexts[0].target, CHILD2);
});

test("mergeExpansions does not surface child-chain next edges for a folded scope", () => {
  // The child ``next`` edge lives in the expansion overlay: a *folded* scope
  // (children hidden) must not gain phantom next edges to invisible nodes.
  const folded = foldedGraph();
  const expansions = new Map([[SCOPE, twoChildExpansion()]]);
  const merged = mergeExpansions(folded, expansions, new Set());
  assert.equal(merged.edges.some((e) => e.type === "next"), false, "no next while folded");
  assert.equal(merged.nodes.some((n) => n.id === CHILD), false, "children hidden while folded");
});

// --- scope child count: stable across collapse/expand (§3.3) ---

test("countScopeChildren counts children from the raw folded node set, not visible edges", () => {
  // The raw folded read carries the child ToolCalls (the backend returns the
  // whole session graph); the count must reflect them even though the merge
  // later hides the children + their contains spine in the collapsed view.
  // This is the value the "▸ N" badge reads so it stays correct before
  // expansion.
  const folded: MemorySubgraph = {
    nodes: [
      { id: SCOPE, label: "Task", extra: { task_type: "subagent" } },
      { id: CHILD, label: "ToolCall", extra: { parent_subtask_id: SCOPE, seq: 5 } },
      { id: CHILD2, label: "ToolCall", extra: { parent_subtask_id: SCOPE, seq: 7 } },
      { id: ART, label: "Artifact", extra: {} },
    ],
    edges: [],
    total: 4, truncated: false,
  };
  assert.equal(countScopeChildren(SCOPE, folded.nodes), 2, "two children attributed to the scope");
  assert.equal(countScopeChildren(ART, folded.nodes), 0, "an artifact owns no children");
});

test("buildScopeChildCounts is stable across expansion state (badge never flips 0→N)", () => {
  // The count map is built from the raw folded node set and is a function of
  // the nodes alone, so toggling expandedScopes must not change it. This is
  // the regression guard for "▸ 0 before expand, ▾ N after expand" — the
  // badge used to count visible contains edges, which read 0 while collapsed.
  const folded: MemorySubgraph = {
    nodes: [
      { id: SCOPE, label: "Task", extra: { task_type: "subagent" } },
      { id: CHILD, label: "ToolCall", extra: { parent_subtask_id: SCOPE, seq: 5 } },
      { id: CHILD2, label: "ToolCall", extra: { parent_subtask_id: SCOPE, seq: 7 } },
    ],
    edges: [],
    total: 3, truncated: false,
  };
  const collapsed = buildScopeChildCounts(folded.nodes);
  const expansions = new Map([[SCOPE, twoChildExpansion()]]);
  const expandedGraph = mergeExpansions(folded, expansions, new Set([SCOPE]));
  const expanded = buildScopeChildCounts(expandedGraph.nodes);
  // The count map is keyed on the *raw folded* set, so even though the merged
  // graph for an expanded scope surfaces the children, the per-scope count is
  // invariant — the badge is sourced from the raw set, not the merged view.
  assert.equal(collapsed.get(SCOPE), 2);
  assert.equal(expanded.get(SCOPE), 2, "count is identical collapsed vs expanded");
  assert.equal(collapsed.size, expanded.size, "same set of scopes");
});


// session graph — the scope, its child ToolCalls, the contains spine, the
// real child→Code→Artifact / child→Paper chain, *and* the synthesised
// surrogates.
// The folded *view* must collapse the child subtree back out so the canvas
// shows only scope→product hints; expanding swaps the surrogate for the real
// chain. These tests exercise the filter against the real backend shape.

const CODE = "code1";

// Mirrors get_subgraph's actual folded payload for one subagent scope that
// produced one artifact via one child: scope + child + Code + Artifact nodes,
// contains + child→Code + Code→Artifact real edges, plus the surrogate. This
// is what the explorer receives before any scope is expanded.
function foldedGraphWithSpine(): MemorySubgraph {
  return {
    nodes: [
      { id: SCOPE, label: "Task", extra: { task_type: "subagent", status: "completed" } },
      { id: CHILD, label: "ToolCall", extra: { task_type: "code_execution", parent_subtask_id: SCOPE } },
      { id: CODE, label: "Code", extra: { code_id: "code1" } },
      { id: ART, label: "Artifact", extra: { artifact_id: "art1", version: 1 } },
    ],
    edges: [
      { source: SCOPE, target: CHILD, type: "contains", extra: {} },
      { source: CHILD, target: CODE, type: "produces", extra: {} },
      { source: CODE, target: ART, type: "produces", extra: {} },
      // Folded surrogate on top of the real chain: scope→artifact.
      { source: SCOPE, target: ART, type: "produces", extra: { surrogate: true, via_child: CHILD } },
    ],
    total: 4,
    truncated: false,
  };
}

test("mergeExpansions folded view hides the child subtree and keeps only the surrogate", () => {
  // The raw folded read carries child + contains + child→Code→Artifact + the
  // surrogate. Collapsed (nothing expanded) the view must show scope + artifact
  // and the surrogate edge only — the child, Code, contains, and the real
  // produces chain all fold away. The artifact survives because the surrogate
  // still reaches it; Code does not, because its only producer was the child.
  const merged = mergeExpansions(foldedGraphWithSpine(), new Map(), new Set());
  const ids = new Set(merged.nodes.map((n) => n.id));
  assert.equal(ids.has(SCOPE), true, "scope stays");
  assert.equal(ids.has(ART), true, "artifact reached by surrogate, stays");
  assert.equal(ids.has(CHILD), false, "child hidden in folded view");
  assert.equal(ids.has(CODE), false, "Code orphaned by fold (child was its only producer), hidden");
  const types = merged.edges.map((e) => `${e.source}>${e.target}:${e.type}${e.extra?.surrogate ? "#" : ""}`);
  assert.deepEqual(types.sort(), [`${SCOPE}>${ART}:produces#`], "only the surrogate edge remains");
});

test("mergeExpansions expanded view surfaces the real chain and drops the surrogate", () => {
  // Expanding swaps the surrogate for the real child spine. The expansion
  // overlay carries child + contains + child→Code→Artifact; the surrogate is
  // dropped; Code reappears because it is now reached by a visible real edge.
  const expansions = new Map<string, MemorySubgraph>([
    [SCOPE, {
      nodes: [
        { id: CHILD, label: "ToolCall", extra: { task_type: "code_execution", parent_subtask_id: SCOPE } },
        { id: CODE, label: "Code", extra: { code_id: "code1" } },
        { id: ART, label: "Artifact", extra: { artifact_id: "art1", version: 1 } },
      ],
      edges: [
        { source: SCOPE, target: CHILD, type: "contains", extra: {} },
        { source: CHILD, target: CODE, type: "produces", extra: {} },
        { source: CODE, target: ART, type: "produces", extra: {} },
      ],
      total: 3, truncated: false,
    }],
  ]);
  const merged = mergeExpansions(foldedGraphWithSpine(), expansions, new Set([SCOPE]));
  const ids = new Set(merged.nodes.map((n) => n.id));
  assert.equal(ids.has(CHILD), true, "child surfaced on expand");
  assert.equal(ids.has(CODE), true, "Code reached by real edge, visible");
  assert.equal(merged.edges.some((e) => e.extra?.surrogate === true), false, "surrogate dropped on expand");
  assert.equal(merged.edges.some((e) => e.type === "contains" && e.source === SCOPE), true, "contains spine visible");
  assert.equal(merged.edges.some((e) => e.source === CHILD && e.target === CODE), true, "real child→Code edge visible");
});

test("mergeExpansions folded view keeps a product still reached by a non-subagent producer", () => {
  // An artifact produced by *both* a hidden subagent child and a visible
  // top-level ToolCall must stay visible in the folded view — the top-level
  // edge keeps it on the canvas; only the child's real edge folds away.
  const TOP = "subtask:top:1";
  const folded: MemorySubgraph = {
    nodes: [
      { id: SCOPE, label: "Task", extra: { task_type: "subagent" } },
      { id: CHILD, label: "ToolCall", extra: { parent_subtask_id: SCOPE } },
      { id: TOP, label: "ToolCall", extra: { task_type: "code_execution" } },
      { id: ART, label: "Artifact", extra: { artifact_id: "art1", version: 1 } },
    ],
    edges: [
      { source: SCOPE, target: CHILD, type: "contains", extra: {} },
      { source: CHILD, target: ART, type: "produces", extra: {} },
      { source: TOP, target: ART, type: "produces", extra: {} },
      { source: SCOPE, target: ART, type: "produces", extra: { surrogate: true, via_child: CHILD } },
    ],
    total: 4, truncated: false,
  };
  const merged = mergeExpansions(folded, new Map(), new Set());
  const ids = new Set(merged.nodes.map((n) => n.id));
  assert.equal(ids.has(ART), true, "artifact kept — still reached by the top-level ToolCall");
  assert.equal(ids.has(CHILD), false, "child hidden");
  assert.equal(merged.edges.some((e) => e.source === TOP && e.target === ART), true, "top-level real edge stays");
  assert.equal(merged.edges.some((e) => e.source === CHILD), false, "child's real edge folded away");
  assert.equal(merged.edges.some((e) => e.extra?.surrogate === true), true, "surrogate stays as the scope→product hint");
});

test("mergeExpansions folded subtree does not cross argumentation edges (supports/stated_in)", () => {
  // A child's product (artA) supporting a Claim that is stated_in a *different*
  // artifact (artB) must NOT pull artB into the scope's folded subtree. The
  // subtree walk follows only structural edges (produces/contains/next/input);
  // supports/stated_in/extracts are cross-claim semantics, not subtree
  // composition. artB stays visible only via its own real producer edge (the
  // top-level ToolCall), and the Claim stays (it has its own incoming edge from
  // artA which folds away — but the Claim node is not in the subtree, so the
  // surrogate-to-artA relation and the top-level artB edge both survive).
  // Regression guard for session db799384: g2m script (artA, in scope subtree)
  // --supports--> Claim --stated_in--> trace.md (artB, top-level product) was
  // wrongly pulling trace.md under the G2M scope's folded view.
  const CLAIM = "claim:f1";
  const ART_B = "artB#v1";       // trace.md analogue
  const TOP = "subtask:top:1";   // trace.md's real (top-level) producer
  const folded: MemorySubgraph = {
    nodes: [
      { id: SCOPE, label: "Task", extra: { task_type: "subagent" } },
      { id: CHILD, label: "ToolCall", extra: { parent_subtask_id: SCOPE } },
      { id: CODE, label: "Code", extra: {} },
      { id: ART, label: "Artifact", extra: { artifact_id: "art1", version: 1 } },        // g2m script (artA)
      { id: CLAIM, label: "Claim", extra: {} },
      { id: ART_B, label: "Artifact", extra: { artifact_id: "artB", version: 1 } },      // trace.md
      { id: TOP, label: "ToolCall", extra: { task_type: "code_execution" } },
    ],
    edges: [
      { source: SCOPE, target: CHILD, type: "contains", extra: {} },
      { source: CHILD, target: CODE, type: "produces", extra: {} },
      { source: CODE, target: ART, type: "produces", extra: {} },
      { source: SCOPE, target: ART, type: "produces", extra: { surrogate: true, via_child: CHILD } },
      // Argumentation chain that must NOT be followed into the subtree:
      { source: ART, target: CLAIM, type: "supports", extra: {} },
      { source: CLAIM, target: ART_B, type: "stated_in", extra: {} },
      // artB's own real producer (top-level, unrelated to the scope):
      { source: TOP, target: ART_B, type: "produces", extra: {} },
    ],
    total: 7, truncated: false,
  };
  const merged = mergeExpansions(folded, new Map(), new Set());
  const ids = new Set(merged.nodes.map((n) => n.id));
  // Scope + its surrogate product (artA) stay as the folded hint.
  assert.equal(ids.has(SCOPE), true, "scope stays");
  assert.equal(ids.has(ART), true, "scope's product artA kept by its surrogate");
  assert.equal(merged.edges.some((e) => e.source === SCOPE && e.target === ART && e.extra?.surrogate), true, "surrogate to artA stays");
  // The subtree folded away: child, Code, contains spine, child→Code→artA chain.
  assert.equal(ids.has(CHILD), false, "child hidden");
  assert.equal(ids.has(CODE), false, "Code hidden (only producer was the child)");
  assert.equal(merged.edges.some((e) => e.type === "contains"), false, "contains spine folded away");
  // artB (trace.md) is NOT pulled into the scope subtree via supports→stated_in.
  // It stays visible only because its own top-level producer edge reaches it,
  // and there is no scope→artB surrogate (artB was never a subtree member).
  assert.equal(ids.has(ART_B), true, "artB kept — reached by its own top-level producer, not by the argumentation chain");
  assert.equal(merged.edges.some((e) => e.source === SCOPE && e.target === ART_B), false, "no surrogate/scope edge to artB — it was never part of this scope's subtree");
  assert.equal(merged.edges.some((e) => e.source === TOP && e.target === ART_B), true, "artB's real top-level producer edge stays");
  // The Claim and its argumentation edges stay visible: the Claim was never a
  // subtree member (the walk does not cross supports to reach it), so it is not
  // hidden; with artA (kept by surrogate) and artB (kept by its producer) both
  // visible, both argumentation edges survive. The fix is not "hide the
  // argumentation chain" — it is "don't let it pull artB into the subtree".
  assert.equal(ids.has(CLAIM), true, "Claim stays visible — never a subtree member, reached by artA's supports edge");
  assert.equal(merged.edges.some((e) => e.source === ART && e.target === CLAIM && e.type === "supports"), true, "supports edge survives (both endpoints visible)");
  assert.equal(merged.edges.some((e) => e.source === CLAIM && e.target === ART_B && e.type === "stated_in"), true, "stated_in edge survives (both endpoints visible)");
});

test("mergeExpansions folded subtree does not cross `input` edges (Artifact→Code consumer)", () => {
  // A scope's own artifact (artA, in the subtree) may be read as `input` by a
  // Code that belongs to a DIFFERENT scope or the top-level chain. The `input`
  // edge points from the artifact out to that consuming Code — it is a consumer
  // link, not subtree composition. Following it forward would pull the outside
  // Code (and whatever it produces) into this scope's folded subtree and HIDE
  // the outside producer's own products when the scope is folded. Regression
  // guard for session db799384: G2M artifact →input→ top-level Code
  // →produces→ `_methodology_ref.md` wrongly hid the methodology artifact under
  // G2M when G2M was folded — which then hid the auto-chain entry node and
  // caused the double-click-collapse crash.
  const OUT_CODE = "code:outside";      // top-level ToolCall's Code (consumer)
  const OUT_ART = "artOut#v1";          // _methodology_ref.md analogue (top-level product)
  const OUT_PRODUCER = "subtask:top:1"; // the top-level ToolCall that produces OUT_CODE
  const folded: MemorySubgraph = {
    nodes: [
      { id: SCOPE, label: "Task", extra: { task_type: "subagent" } },
      { id: CHILD, label: "ToolCall", extra: { parent_subtask_id: SCOPE } },
      { id: CODE, label: "Code", extra: {} },
      { id: ART, label: "Artifact", extra: { artifact_id: "art1", version: 1 } },   // the scope's own artifact (artA)
      { id: OUT_CODE, label: "Code", extra: {} },                                    // outside consumer
      { id: OUT_ART, label: "Artifact", extra: { artifact_id: "artOut", version: 1 } },
      { id: OUT_PRODUCER, label: "ToolCall", extra: { task_type: "code_execution" } },
    ],
    edges: [
      { source: SCOPE, target: CHILD, type: "contains", extra: {} },
      { source: CHILD, target: CODE, type: "produces", extra: {} },
      { source: CODE, target: ART, type: "produces", extra: {} },
      { source: SCOPE, target: ART, type: "produces", extra: { surrogate: true, via_child: CHILD } },
      // The cross-scope `input` link: scope's artifact → outside Code.
      { source: ART, target: OUT_CODE, type: "input", extra: {} },
      // The outside Code produces a top-level artifact (NOT part of this scope).
      { source: OUT_CODE, target: OUT_ART, type: "produces", extra: {} },
      { source: OUT_PRODUCER, target: OUT_CODE, type: "produces", extra: {} },
    ],
    total: 7, truncated: false,
  };
  const merged = mergeExpansions(folded, new Map(), new Set());
  const ids = new Set(merged.nodes.map((n) => n.id));
  // Scope + its surrogate product (artA) stay as the folded hint.
  assert.equal(ids.has(SCOPE), true, "scope stays");
  assert.equal(ids.has(ART), true, "scope's product artA kept by its surrogate");
  assert.equal(merged.edges.some((e) => e.source === SCOPE && e.target === ART && e.extra?.surrogate), true, "surrogate to artA stays");
  // The subtree folded away: child, scope's own Code, contains spine.
  assert.equal(ids.has(CHILD), false, "child hidden");
  assert.equal(ids.has(CODE), false, "scope's own Code hidden");
  assert.equal(merged.edges.some((e) => e.type === "contains"), false, "contains spine folded away");
  // The outside Code + the artifact it produces are NOT pulled into the subtree
  // via the `input` edge. They stay visible via their own top-level producer.
  assert.equal(ids.has(OUT_CODE), true, "outside Code kept — reached by its own top-level producer, not by the input edge");
  assert.equal(ids.has(OUT_ART), true, "outside artifact kept — reached by its own top-level producer");
  assert.equal(merged.edges.some((e) => e.source === OUT_PRODUCER && e.target === OUT_CODE), true, "outside Code's real top-level producer edge stays");
  assert.equal(merged.edges.some((e) => e.source === OUT_CODE && e.target === OUT_ART), true, "outside Code→artifact produces edge stays");
  // The `input` edge survives only if both endpoints are visible — artA is kept
  // by the surrogate, OUT_CODE by its producer, so the input edge stays too.
  assert.equal(merged.edges.some((e) => e.source === ART && e.target === OUT_CODE && e.type === "input"), true, "input edge survives (both endpoints visible)");
  // No surrogate/scope edge to the outside artifact — it was never a subtree member.
  assert.equal(merged.edges.some((e) => e.source === SCOPE && e.target === OUT_ART), false, "no surrogate/scope edge to the outside artifact");
});

// --- done badge split: completed vs cancelled (§3.4) ---

test("isNodeCompleted matches the done status set only", () => {
  assert.equal(isNodeCompleted({ extra: { status: "succeeded" } }), true);
  assert.equal(isNodeCompleted({ extra: { status: "completed" } }), true);
  assert.equal(isNodeCompleted({ extra: { status: "done" } }), true);
  assert.equal(isNodeCompleted({ extra: { status: "running" } }), false);
  assert.equal(isNodeCompleted({ extra: { status: "cancelled" } }), false, "cancelled is not completed");
  assert.equal(isNodeCompleted({ extra: {} }), false);
  assert.equal(isNodeCompleted({}), false);
});

test("isNodeCancelled keys on status === 'cancelled' and is disjoint from completed", () => {
  assert.equal(isNodeCancelled({ extra: { status: "cancelled" } }), true);
  assert.equal(isNodeCancelled({ extra: { status: "Cancelled" } }), true);
  assert.equal(isNodeCancelled({ extra: { status: "succeeded" } }), false);
  assert.equal(isNodeCancelled({ extra: { status: "completed" } }), false);
  // The two predicates never agree on the same node: a cancelled scope is
  // terminal-but-failed, so it falls out of completed and into cancelled.
  const cancelled = { extra: { status: "cancelled" } };
  assert.equal(isNodeCompleted(cancelled), false);
  assert.equal(isNodeCancelled(cancelled), true);
});

test("badge split counts completed and cancelled independently", () => {
  // Mirrors MemoryGraphView's counting: completed = isNodeCompleted, cancelled
  // = isNodeCancelled. A session with 3 succeeded, 1 cancelled, 1 running
  // → badge reads "✓ 3 done · ⊘ 1 cancelled" (running counts toward neither).
  const nodes = [
    { id: "a", extra: { status: "succeeded" } },
    { id: "b", extra: { status: "completed" } },
    { id: "c", extra: { status: "done" } },
    { id: "d", extra: { status: "cancelled" } },
    { id: "e", extra: { status: "running" } },
    { id: "f", extra: {} }, // statusless (artifact) — not counted
  ];
  const completed = nodes.filter(isNodeCompleted).length;
  const cancelled = nodes.filter(isNodeCancelled).length;
  assert.equal(completed, 3);
  assert.equal(cancelled, 1);
});

// --- aggregate virtual node (需求3): fold >1 same-kind products into one node ---

const GROUP_ID = `_group:${SCOPE}:Artifact`;
const ART2 = "art2#v1";

// A folded graph where the scope's children produced two artifacts. The
// backend's get_subgraph collapses the two into ONE virtual aggregate node
// (``_group:<scopeId>:Artifact``, extra.aggregated=true) with one surrogate
// scope→aggregate produces edge. The members list is carried in extra.members.
function foldedGraphWithAggregate(): MemorySubgraph {
  return {
    nodes: [
      { id: SCOPE, label: "Task", extra: { task_type: "subagent", status: "completed" } },
      {
        id: GROUP_ID,
        label: "Artifact",
        extra: { aggregated: true, count: 2, kind: "Artifact", scope: SCOPE, members: [ART, ART2] },
      },
    ],
    edges: [
      { source: SCOPE, target: GROUP_ID, type: "produces", extra: { surrogate: true, aggregated: true, via_child: CHILD } },
    ],
    total: 2, truncated: false,
  };
}

// getGroupExpansion returns the two member artifacts + one surrogate
// scope→member produces edge each (the shape the folded view would have drawn
// had it not collapsed them).
function groupExpansion(): MemorySubgraph {
  return {
    nodes: [
      { id: ART, label: "Artifact", extra: { artifact_id: "art1", version: 1 } },
      { id: ART2, label: "Artifact", extra: { artifact_id: "art2", version: 1 } },
    ],
    edges: [
      { source: SCOPE, target: ART, type: "produces", extra: { surrogate: true, via_child: CHILD } },
      { source: SCOPE, target: ART2, type: "produces", extra: { surrogate: true, via_child: CHILD } },
    ],
    total: 2, truncated: false,
  };
}

test("mergeExpansions keeps the virtual aggregate node + its surrogate while folded", () => {
  const folded = foldedGraphWithAggregate();
  const merged = mergeExpansions(folded, new Map(), new Set(), new Map(), new Set());
  const ids = new Set(merged.nodes.map((n) => n.id));
  assert.equal(ids.has(GROUP_ID), true, "aggregate virtual node stays while folded");
  assert.equal(merged.edges.some((e) => e.source === SCOPE && e.target === GROUP_ID), true, "scope→aggregate surrogate stays");
  assert.equal(merged.edges.some((e) => e.source === SCOPE && e.target === ART), false, "members not yet unpacked");
});

test("mergeExpansions unpacks an expanded aggregate into its members, drops the virtual node", () => {
  const folded = foldedGraphWithAggregate();
  const groups = new Map([[GROUP_ID, groupExpansion()]]);
  const merged = mergeExpansions(folded, new Map(), new Set(), groups, new Set([GROUP_ID]));
  const ids = new Set(merged.nodes.map((n) => n.id));
  assert.equal(ids.has(GROUP_ID), false, "virtual aggregate dropped on expand");
  assert.equal(ids.has(ART), true, "member artifact unpacked");
  assert.equal(ids.has(ART2), true, "second member unpacked");
  // The scope→aggregate surrogate is gone; two scope→member surrogates take over.
  assert.equal(merged.edges.some((e) => e.target === GROUP_ID), false, "no edge to the dropped aggregate");
  const memberEdges = merged.edges.filter((e) => e.source === SCOPE && (e.target === ART || e.target === ART2));
  assert.equal(memberEdges.length, 2, "one surrogate scope→member edge per member");
});

test("mergeExpansions folds an expanded aggregate back: members gone, virtual node restored", () => {
  const folded = foldedGraphWithAggregate();
  const groups = new Map([[GROUP_ID, groupExpansion()]]);
  const expanded = mergeExpansions(folded, new Map(), new Set(), groups, new Set([GROUP_ID]));
  assert.equal(new Set(expanded.nodes.map((n) => n.id)).has(ART), true);
  const collapsed = mergeExpansions(folded, new Map(), new Set(), groups, new Set());
  const ids = new Set(collapsed.nodes.map((n) => n.id));
  assert.equal(ids.has(ART), false, "members folded away on collapse");
  assert.equal(ids.has(GROUP_ID), true, "virtual aggregate restored on collapse");
});

test("mergeExpansions hides an aggregate whose owning scope is expanded (real members take over)", () => {
  // Expanding the scope drops its surrogate edges (incl. the one to the
  // aggregate), so the aggregate becomes an orphan — hide it too, since the
  // real members now show via the child subtree from the scope expansion.
  const folded = foldedGraphWithAggregate();
  const expansions = new Map([[SCOPE, expansionGraph()]]);
  const merged = mergeExpansions(folded, expansions, new Set([SCOPE]), new Map(), new Set());
  const ids = new Set(merged.nodes.map((n) => n.id));
  assert.equal(ids.has(GROUP_ID), false, "aggregate hidden when its scope is expanded");
  assert.equal(merged.edges.some((e) => e.target === GROUP_ID), false, "no edge to the hidden aggregate");
});

// --- chain-view scope expansion overlay (链内就地展开) ---

test("mergeChainScopeExpansions is a no-op when no scope is expanded", () => {
  const chain: MemorySubgraph = {
    nodes: [
      { id: SCOPE, label: "Task", extra: { task_type: "subagent" } },
      { id: CHILD, label: "ToolCall", extra: { parent_subtask_id: SCOPE } },
    ],
    edges: [{ source: SCOPE, target: CHILD, type: "contains", extra: {} }],
    total: 2, truncated: false,
  };
  const merged = mergeChainScopeExpansions(chain, new Map(), new Set());
  assert.equal(merged.nodes.length, 2);
  assert.equal(merged.edges.length, 1);
  assert.equal(merged, chain, "returns the same reference when nothing to overlay");
});

test("mergeChainScopeExpansions overlays an expanded scope's children onto the chain", () => {
  // Chain shape: scope + one contains spine edge to first child + the scope's
  // child ToolCalls scattered as free nodes (no edges to the Code they ran).
  // The scope expansion carries the Code nodes + the scope→Code produces edges
  // that connect them. Overlaying must add the Code nodes and the connecting
  // edges, de-duped, without touching the chain's own edges.
  const CHILD2 = "subtask:subagent:sub1:exec:e2";
  const CODE1 = "code:1";
  const CODE2 = "code:2";
  const chain: MemorySubgraph = {
    nodes: [
      { id: SCOPE, label: "Task", extra: { task_type: "subagent" } },
      { id: CHILD, label: "ToolCall", extra: { parent_subtask_id: SCOPE } },
      { id: CHILD2, label: "ToolCall", extra: { parent_subtask_id: SCOPE } },
    ],
    edges: [
      { source: SCOPE, target: CHILD, type: "contains", extra: {} },
      { source: SCOPE, target: CHILD, type: "produces", extra: { surrogate: true, via_child: CHILD } },
    ],
    total: 3, truncated: false,
  };
  const expansion: MemorySubgraph = {
    nodes: [
      { id: SCOPE, label: "Task", extra: { task_type: "subagent" } },
      { id: CHILD, label: "ToolCall", extra: { parent_subtask_id: SCOPE } },
      { id: CHILD2, label: "ToolCall", extra: { parent_subtask_id: SCOPE } },
      { id: CODE1, label: "Code", extra: {} },
      { id: CODE2, label: "Code", extra: {} },
    ],
    edges: [
      { source: SCOPE, target: CHILD, type: "contains", extra: {} },                 // dup of chain edge
      { source: SCOPE, target: CODE1, type: "produces", extra: {} },                 // new
      { source: SCOPE, target: CODE2, type: "produces", extra: {} },                 // new
      { source: SCOPE, target: SCOPE, type: "next", extra: {} },                     // self-loop (noise)
      { source: SCOPE, target: CHILD, type: "produces", extra: { surrogate: true, via_child: CHILD } }, // surrogate
    ],
    total: 5, truncated: false,
  };
  const merged = mergeChainScopeExpansions(chain, new Map([[SCOPE, expansion]]), new Set([SCOPE]));
  const ids = new Set(merged.nodes.map((n) => n.id));
  // Code nodes added; chain's own nodes preserved.
  assert.equal(ids.has(CODE1), true, "Code1 overlaid");
  assert.equal(ids.has(CODE2), true, "Code2 overlaid");
  assert.equal(ids.has(SCOPE), true);
  assert.equal(ids.has(CHILD), true);
  // The chain's own edges survive.
  assert.equal(merged.edges.some((e) => e.source === SCOPE && e.target === CHILD && e.type === "contains"), true, "chain's contains spine kept");
  // New scope→Code edges added, de-duped.
  assert.equal(merged.edges.some((e) => e.source === SCOPE && e.target === CODE1 && e.type === "produces" && !e.extra?.surrogate), true, "Code1 produces edge overlaid");
  assert.equal(merged.edges.some((e) => e.source === SCOPE && e.target === CODE2 && e.type === "produces" && !e.extra?.surrogate), true, "Code2 produces edge overlaid");
  // Self-loops and surrogates from the expansion are NOT added.
  assert.equal(merged.edges.some((e) => e.source === SCOPE && e.target === SCOPE), false, "self-loop dropped");
  // The duplicate contains edge from the expansion did not double the chain's.
  const containsCount = merged.edges.filter((e) => e.source === SCOPE && e.target === CHILD && e.type === "contains").length;
  assert.equal(containsCount, 1, "contains edge de-duped (one copy from the chain)");
});

test("mergeChainScopeExpansions drops an expanded scope's overlay when it is collapsed again", () => {
  // Expanding then collapsing (removing from expandedScopes) must yield the
  // original chain — the overlay contributes nothing when the scope isn't in
  // the expanded set.
  const CODE1 = "code:1";
  const chain: MemorySubgraph = {
    nodes: [
      { id: SCOPE, label: "Task", extra: { task_type: "subagent" } },
      { id: CHILD, label: "ToolCall", extra: { parent_subtask_id: SCOPE } },
    ],
    edges: [{ source: SCOPE, target: CHILD, type: "contains", extra: {} }],
    total: 2, truncated: false,
  };
  const expansion: MemorySubgraph = {
    nodes: [
      { id: SCOPE, label: "Task", extra: { task_type: "subagent" } },
      { id: CHILD, label: "ToolCall", extra: { parent_subtask_id: SCOPE } },
      { id: CODE1, label: "Code", extra: {} },
    ],
    edges: [{ source: SCOPE, target: CODE1, type: "produces", extra: {} }],
    total: 3, truncated: false,
  };
  const collapsed = mergeChainScopeExpansions(chain, new Map([[SCOPE, expansion]]), new Set());
  assert.equal(collapsed.nodes.length, 2, "collapsed = chain's own nodes only");
  assert.equal(collapsed.edges.length, 1, "collapsed = chain's own edges only");
  assert.equal(collapsed.nodes.some((n) => n.id === CODE1), false, "Code gone when scope collapsed");
});
