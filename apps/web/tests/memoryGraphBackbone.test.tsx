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

import type { MemoryGraphEdge, MemoryGraphNode, MemoryGraphNodeLabel, MemorySubgraph } from "@sciencediscovery/schema";

import { buildProducesMemberCounts, collapseProducesOwner, countFoldedProducesMembers, expandProducesOwner, mainChainNodeIds, producesMembersOf, projectToCanvas } from "../src/memoryGraphBackbone.js";

// Helpers to build a subgraph without the verbose schema fields.
function node(id: string, label: MemoryGraphNodeLabel): MemoryGraphNode {
  return { id, label };
}
function edge(source: string, target: string, type: MemoryGraphEdge["type"]): MemoryGraphEdge {
  return { source, target, type };
}
function subgraph(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): MemorySubgraph {
  return { nodes, edges, total: nodes.length, truncated: false };
}

test("mainChainNodeIds: BFS along `next` from ResearchGoal", () => {
  const g = subgraph(
    [
      node("rg", "ResearchGoal"),
      node("t1", "Task"),
      node("tc1", "ToolCall"),
      node("t2", "Task"),
      node("p1", "Paper"),   // off-spine: attached via produces, NOT next
      node("e1", "Evidence"), // off-spine via extracts
    ],
    [
      edge("rg", "t1", "next"),
      edge("t1", "tc1", "next"),
      edge("tc1", "t2", "next"),
      edge("tc1", "p1", "produces"),
      edge("p1", "e1", "extracts"),
    ],
  );
  const ids = mainChainNodeIds(g);
  assert.ok(ids.has("rg"));
  assert.ok(ids.has("t1"));
  assert.ok(ids.has("tc1"));
  assert.ok(ids.has("t2"));
  // Paper/Evidence are off the spine — must NOT be in the main chain.
  assert.ok(!ids.has("p1"));
  assert.ok(!ids.has("e1"));
});

test("mainChainNodeIds: no ResearchGoal falls back to all Task+ToolCall+ResearchGoal", () => {
  const g = subgraph(
    [
      node("t1", "Task"),
      node("tc1", "ToolCall"),
      node("p1", "Paper"),
      node("e1", "Evidence"),
    ],
    [edge("t1", "tc1", "next"), edge("tc1", "p1", "produces")],
  );
  const ids = mainChainNodeIds(g);
  assert.ok(ids.has("t1"));
  assert.ok(ids.has("tc1"));
  assert.ok(!ids.has("p1"));
  assert.ok(!ids.has("e1"));
});

test("mainChainNodeIds: next edges that drag in non-spine labels are filtered out", () => {
  // If a Paper is wired via next (shouldn't happen, but data-driven), the
  // spine filter drops it — only ResearchGoal/Task/ToolCall stay.
  const g = subgraph(
    [node("rg", "ResearchGoal"), node("p1", "Paper"), node("tc1", "ToolCall")],
    [edge("rg", "p1", "next"), edge("p1", "tc1", "next")],
  );
  const ids = mainChainNodeIds(g);
  assert.ok(ids.has("rg"));
  assert.ok(ids.has("tc1"));
  assert.ok(!ids.has("p1"));
});

test("producesMembersOf: bidirectional — both endpoints are members", () => {
  const g = subgraph(
    [node("tc1", "ToolCall"), node("p1", "Paper"), node("e1", "Evidence"), node("c1", "Claim")],
    [
      edge("tc1", "p1", "produces"),   // tc1 produces p1
      edge("p1", "e1", "extracts"),    // p1 extracts e1
      edge("e1", "c1", "supports"),    // e1 supports c1
    ],
  );
  // ToolCall's adjacent member = Paper.
  assert.deepEqual([...producesMembersOf(g, "tc1")].sort(), ["p1"]);
  // Paper's members = BOTH ToolCall (backward produces) AND Evidence (forward extracts).
  assert.deepEqual([...producesMembersOf(g, "p1")].sort(), ["e1", "tc1"]);
  // Evidence's members = BOTH Paper (backward extracts) AND Claim (forward supports).
  assert.deepEqual([...producesMembersOf(g, "e1")].sort(), ["c1", "p1"]);
  // Claim has only an IN-edge (Evidence supports Claim) — bidirectional now finds Evidence.
  // This is the core fix for "double-clicking Claim can't expand Evidence".
  assert.deepEqual([...producesMembersOf(g, "c1")].sort(), ["e1"]);
});

test("producesMembersOf: next and contains edges are NOT produces members", () => {
  const g = subgraph(
    [node("t1", "Task"), node("tc1", "ToolCall"), node("tc2", "ToolCall")],
    [
      edge("t1", "tc1", "next"),
      edge("t1", "tc2", "contains"),
    ],
  );
  // next/contains are excluded from produces membership.
  assert.equal(producesMembersOf(g, "t1").size, 0);
});

test("collapseProducesOwner: does NOT include the owner", () => {
  // "谁展开谁折叠" 模型：折叠 c 只删 c 名下记录的子节点，c 自身不在
  // toRemove（owner 去留由调用方按主干/引用决定）。
  const m = new Map<string, Set<string>>([["c", new Set(["a"])]]);
  const remove = collapseProducesOwner(m, "c");
  assert.ok(!remove.has("c"), "owner not in its own collapse set");
  assert.ok(remove.has("a"), "c's recorded child a is collected");
});

test("collapseProducesOwner: shallow — only the owner's direct children, NOT the grandchildren", () => {
  // 仿新版 Neo4j Browser：折叠只删 owner 亲手拉进来的**直接子**，不递归孙。
  // 链 tc1→p1→e1→c1：tc1 名下记 p1，p1 名下记 e1，e1 名下记 c1。折叠 tc1
  // 只删 p1（直接子），e1/c1（孙辈，记在 p1/e1 名下）不碰——它们因还连着
  // p1 之外的边 / 别的 owner 而留下（对齐：折叠 report2 断 report2↔Claim 边、
  // Evidence 不动）。经典版会递归删整棵，新版只删一层。
  const m = new Map<string, Set<string>>([
    ["tc1", new Set(["p1"])],
    ["p1", new Set(["e1"])],
    ["e1", new Set(["c1"])],
  ]);
  const remove = collapseProducesOwner(m, "tc1");
  assert.ok(remove.has("p1"), "direct child p1 is collected");
  assert.ok(!remove.has("e1"), "grandchild e1 is NOT touched (shallow collapse)");
  assert.ok(!remove.has("c1"), "great-grandchild c1 is NOT touched (shallow collapse)");
  assert.ok(!remove.has("tc1"), "owner not in its own collapse set");
});

test("collapseProducesOwner: only collapses the owner's recorded children — edge-centric", () => {
  // 「边为中心、对端不收」的核心回归：p1 由 tc1 拉进来（记 tc1 名下）；
  // 再双击 p1 拉进 e1（记 p1 名下）。折叠 p1 只删 p1 名下的 e1，
  // **不碰 tc1**（tc1 不在 p1 名下，是 p1 的展开者/对端）。
  // 旧前向 BFS 模型会沿反向边把 tc1 也拽进折叠集 → p1 失去保留者消失
  // （"双击 Paper 退回 ToolCall 名下不见了"）。新模型只动归属记录，不碰拓扑。
  const m = new Map<string, Set<string>>([
    ["tc1", new Set(["p1"])],   // tc1 拉进了 p1
    ["p1", new Set(["e1"])],    // p1 拉进了 e1
  ]);
  const remove = collapseProducesOwner(m, "p1");
  assert.ok(!remove.has("tc1"), "collapsing p1 must NOT touch its expander tc1 (edge-centric)");
  assert.ok(!remove.has("p1"), "owner not in its own collapse set (caller drops it)");
  assert.ok(remove.has("e1"), "p1's recorded child e1 is collected");
});

test("collapseProducesOwner: a node brought in by another owner is untouched when collapsing this owner", () => {
  // 第二个「对端不收」场景：X 同时被 ownerA 和 ownerB 连到，但只记在
  // ownerA 名下（按 expandProducesOwner「只记新节点」规则——B 展开时 X
  // 已可见，不重复记到 B）。折叠 ownerB 不碰 X；折叠 ownerA 才删 X。
  const m = new Map<string, Set<string>>([
    ["ownerA", new Set(["X"])],  // A 拉进了 X
    ["ownerB", new Set()],       // B 名下空（X 没记到 B 名下）
  ]);
  const removeB = collapseProducesOwner(m, "ownerB");
  assert.ok(!removeB.has("X"), "collapsing B must not touch X (X belongs to A)");
  const removeA = collapseProducesOwner(m, "ownerA");
  assert.ok(removeA.has("X"), "collapsing A removes X (X belongs to A)");
});

test("projectToCanvas: default shows only the main chain, folds produces", () => {
  const g = subgraph(
    [
      node("rg", "ResearchGoal"),
      node("tc1", "ToolCall"),
      node("p1", "Paper"),
      node("e1", "Evidence"),
      node("a1", "Artifact"),
    ],
    [
      edge("rg", "tc1", "next"),
      edge("tc1", "p1", "produces"),
      edge("p1", "e1", "extracts"),
      edge("tc1", "a1", "produces"),
    ],
  );
  const mainChain = mainChainNodeIds(g); // {rg, tc1}
  const projected = projectToCanvas(g, mainChain, new Map(), new Set());
  const ids = new Set(projected.nodes.map((n) => n.id));
  assert.ok(ids.has("rg"));
  assert.ok(ids.has("tc1"));
  // p1/e1/a1 are produces descendants — folded by default.
  assert.ok(!ids.has("p1"));
  assert.ok(!ids.has("e1"));
  assert.ok(!ids.has("a1"));
  // Edges between surviving nodes stay; edges to folded nodes drop.
  assert.ok(projected.edges.some((e) => e.source === "rg" && e.target === "tc1"));
  assert.ok(!projected.edges.some((e) => e.type === "produces"));
});

test("projectToCanvas: expanding a node surfaces its produces members", () => {
  const g = subgraph(
    [
      node("rg", "ResearchGoal"),
      node("tc1", "ToolCall"),
      node("p1", "Paper"),
      node("e1", "Evidence"),
    ],
    [
      edge("rg", "tc1", "next"),
      edge("tc1", "p1", "produces"),
      edge("p1", "e1", "extracts"),
    ],
  );
  const mainChain = mainChainNodeIds(g); // {rg, tc1}
  // Expand tc1 → tc1 名下记它拉进来的 p1（一层；e1 仍未拉进来，折叠）。
  const projected = projectToCanvas(g, mainChain, new Map([["tc1", new Set(["p1"])]]), new Set(["p1"]));
  const ids = new Set(projected.nodes.map((n) => n.id));
  assert.ok(ids.has("tc1"));
  assert.ok(ids.has("p1"));     // tc1's recorded child
  assert.ok(!ids.has("e1"));   // not yet pulled in by anyone
  // The tc1→p1 edge now renders.
  assert.ok(projected.edges.some((e) => e.source === "tc1" && e.target === "p1" && e.type === "produces"));
});

test("projectToCanvas: expanding a non-spine node keeps the node itself visible", () => {
  // After expanding tc1, p1 is visible. Expanding p1 must keep p1 AND surface e1
  // (record e1 under p1's name).
  const g = subgraph(
    [
      node("rg", "ResearchGoal"),
      node("tc1", "ToolCall"),
      node("p1", "Paper"),
      node("e1", "Evidence"),
    ],
    [edge("rg", "tc1", "next"), edge("tc1", "p1", "produces"), edge("p1", "e1", "extracts")],
  );
  const mainChain = mainChainNodeIds(g);
  const projected = projectToCanvas(g, mainChain, new Map([
    ["tc1", new Set(["p1"])],
    ["p1", new Set(["e1"])],
  ]), new Set(["p1", "e1"]));
  const ids = new Set(projected.nodes.map((n) => n.id));
  assert.ok(ids.has("p1"));  // the expanded owner stays
  assert.ok(ids.has("e1")); // its recorded child surfaces
  assert.ok(ids.has("tc1"));
  assert.ok(ids.has("rg"));
});

test("projectToCanvas: collapsing (removing the owner's entry) drops the members", () => {
  const g = subgraph(
    [
      node("rg", "ResearchGoal"),
      node("tc1", "ToolCall"),
      node("p1", "Paper"),
      node("e1", "Evidence"),
    ],
    [edge("rg", "tc1", "next"), edge("tc1", "p1", "produces"), edge("p1", "e1", "extracts")],
  );
  const mainChain = mainChainNodeIds(g);
  // Expanded: p1 + e1 visible.
  const open = projectToCanvas(g, mainChain, new Map([
    ["tc1", new Set(["p1"])],
    ["p1", new Set(["e1"])],
  ]), new Set(["p1", "e1"]));
  assert.ok(new Set(open.nodes.map((n) => n.id)).has("p1"));
  assert.ok(new Set(open.nodes.map((n) => n.id)).has("e1"));
  // Collapse both: back to the spine (empty map).
  const closed = projectToCanvas(g, mainChain, new Map(), new Set());
  const ids = new Set(closed.nodes.map((n) => n.id));
  assert.ok(ids.has("rg"));
  assert.ok(ids.has("tc1"));
  assert.ok(!ids.has("p1"));
  assert.ok(!ids.has("e1"));
});

test("projectToCanvas: scope expansion shows only the contains layer (child ToolCalls)", () => {
  // Regression guard for the "double-click Task expands nothing" bug
  // (docs/mg-fold-produces-invisibility §2 层二) + the layered-expansion
  // requirement: double-clicking a scope must show only its direct contains
  // children (child ToolCalls), NOT the whole subtree at once. The produces
  // descendants (Code/Artifact) come via later double-click on ToolCall/Code
  // walking expandedIds (Task→ToolCall→Code→Artifact, one layer each).
  //
  // Graph shape mirrors session 166856ed's subagent scope:
  //   rg ─next→ mcp_tc ─next→ exec_tc ─next→ scope(Task, task_type=subagent)
  //   scope ─contains→ child_tc (:exec:..., parent_subtask_id===scope)
  //   scope ─produces→ a1  (surrogate, in folded read)
  //   child_tc ─produces→ code1
  //   code1 ─produces→ a1  (real chain; produces edge in child's name, not scope's)
  const childWithParent = (id: string, parent: string): MemoryGraphNode => ({
    id, label: "ToolCall", extra: { parent_subtask_id: parent },
  });
  const g = subgraph(
    [
      node("rg", "ResearchGoal"),
      node("mcp_tc", "ToolCall"),
      node("exec_tc", "ToolCall"),
      node("scope", "Task"),
      childWithParent("child_tc", "scope"),
      node("code1", "Code"),
      node("a1", "Artifact"),
    ],
    [
      edge("rg", "mcp_tc", "next"),
      edge("mcp_tc", "exec_tc", "next"),
      edge("exec_tc", "scope", "next"),
      edge("scope", "child_tc", "contains"),
      edge("scope", "a1", "produces"),        // surrogate (folded view)
      edge("child_tc", "code1", "produces"),  // real chain (child's name)
      edge("code1", "a1", "produces"),         // real chain
    ],
  );
  const mainChain = mainChainNodeIds(g); // {rg, mcp_tc, exec_tc, scope}

  // The scope-expansion payload (what getScopeExpansion returns): child_tc,
  // code1, a1 + the real edges (child→code→artifact). The surrogate scope→a1
  // is dropped by mergeExpansions once the scope is expanded.
  const expansion = subgraph(
    [childWithParent("child_tc", "scope"), node("code1", "Code"), node("a1", "Artifact")],
    [edge("child_tc", "code1", "produces"), edge("code1", "a1", "produces")],
  );
  const expansionGraphs = new Map([["scope", expansion]]);
  const expandedScopes = new Set(["scope"]);

  // BEFORE the fix (expandedScopes/expansionGraphs omitted): the scope's
  // contains child + the real-chain Code drop. a1 may survive via the scope's
  // surrogate produces edge (still in this folded test graph), but child_tc
  // and code1 — reached via contains and a produces edge in the child's name —
  // are NOT in mainChain and NOT recorded under the scope in expandedNodeMap, so
  // they drop. (scope 名下只记它的 produces 成员 a1，child_tc/code1 不在。)
  const before = projectToCanvas(g, mainChain, new Map([["scope", new Set(["a1"])]]), new Set(["a1"]));
  const beforeIds = new Set(before.nodes.map((n) => n.id));
  assert.ok(!beforeIds.has("child_tc"), "child ToolCall must be dropped before the fix");
  assert.ok(!beforeIds.has("code1"), "Code must be dropped before the fix");

  // LAYER 1 — double-click scope: scope enters expandedScopes (toggleScope),
  // NOT expandedNodeMap. projectToCanvas keeps only the scope's contains members
  // (child ToolCalls). Produces descendants (code1/a1) do NOT appear — they
  // need a later double-click on child_tc/code1 recording them under their owner.
  // Note: expandedNodeMap is EMPTY here — scope expansion goes through
  // expandedScopes, the produces-layer is only touched by double-clicking
  // non-scope nodes.
  const layer1 = projectToCanvas(g, mainChain, new Map(), new Set(), expandedScopes, expansionGraphs);
  const layer1Ids = new Set(layer1.nodes.map((n) => n.id));
  assert.ok(layer1Ids.has("scope"));
  assert.ok(layer1Ids.has("child_tc"), "child ToolCall must survive scope expansion (layer 1)");
  assert.ok(!layer1Ids.has("code1"), "Code must NOT appear at layer 1 (needs double-click child ToolCall)");
  assert.ok(!layer1Ids.has("a1"), "Artifact must NOT appear at layer 1");

  // LAYER 2 — double-click child_tc → record code1 under child_tc → code1
  // appears. a1 still hidden (needs double-click code1).
  const layer2 = projectToCanvas(g, mainChain, new Map([["child_tc", new Set(["code1"])]]), new Set(["code1"]), expandedScopes, expansionGraphs);
  const layer2Ids = new Set(layer2.nodes.map((n) => n.id));
  assert.ok(layer2Ids.has("code1"), "Code appears after double-clicking child ToolCall (layer 2)");
  assert.ok(!layer2Ids.has("a1"), "Artifact still hidden at layer 2");

  // LAYER 3 — double-click code1 → record a1 under code1 → a1 appears.
  // Full chain now visible.
  const layer3 = projectToCanvas(g, mainChain, new Map([
    ["child_tc", new Set(["code1"])],
    ["code1", new Set(["a1"])],
  ]), new Set(["code1", "a1"]), expandedScopes, expansionGraphs);
  const layer3Ids = new Set(layer3.nodes.map((n) => n.id));
  assert.ok(layer3Ids.has("a1"), "Artifact appears after double-clicking Code (layer 3)");
  // The real chain edges survive once both endpoints are visible.
  assert.ok(layer3.edges.some((e) => e.source === "child_tc" && e.target === "code1"));
  assert.ok(layer3.edges.some((e) => e.source === "code1" && e.target === "a1"));
});

test("buildProducesMemberCounts: bidirectional — counts both endpoints per edge", () => {
  // Drives the canvas tooltip "no expandable children" guard: a node with 0
  // bidirectional produces/citation edges must NOT show the "双击展开节点" hint.
  // Bidirectional so a node with only IN-edges (e.g. Claim with Evidence
  // supports→Claim) still reads >0 and shows the hint. Counts EDGES (not unique
  // members) — the guard only needs >0, and counting edges is one pass over the
  // edge list with no per-node Set allocation.
  const g = subgraph(
    [
      node("rg", "ResearchGoal"),
      node("tc1", "ToolCall"),
      node("tc2", "ToolCall"),
      node("p1", "Paper"),
      node("p2", "Paper"),
      node("e1", "Evidence"),
      node("c1", "Claim"),
    ],
    [
      edge("rg", "tc1", "next"),          // next: NOT a produces edge — excluded
      edge("tc1", "p1", "produces"),      // tc1 +1, p1 +1
      edge("tc1", "p2", "produces"),      // tc1 +1, p2 +1
      edge("p1", "e1", "extracts"),      // p1 +1, e1 +1
      edge("e1", "c1", "supports"),       // e1 +1, c1 +1
      // tc2 owns NO produces/citation edges — must be ABSENT from the map (not 0).
    ],
  );
  const counts = buildProducesMemberCounts(g);
  assert.equal(counts.get("tc1"), 2);
  assert.equal(counts.get("p1"), 2);   // forward extracts + backward produces
  assert.equal(counts.get("e1"), 2);   // forward supports + backward extracts
  assert.equal(counts.get("c1"), 1);   // IN-edge only — bidirectional now counts it
  assert.equal(counts.get("p2"), 1);
  // tc2 has no produces edges — absent from the map (callers treat absent as 0).
  assert.equal(counts.get("tc2"), undefined);
  // rg only has a `next` edge — not a produces/citation edge, so not counted.
  assert.equal(counts.get("rg"), undefined);
});

test("buildProducesMemberCounts: bidirectional counts IN-edge-only nodes", () => {
  // A node that only appears as a TARGET must still accrue a count, so the
  // tooltip shows the "双击展开节点" hint for it. stated_in is Claim→Artifact,
  // input is Artifact→Code — bidirectional means each edge counts toward BOTH
  // endpoints.
  const g = subgraph(
    [node("cl", "Claim"), node("a", "Artifact"), node("c", "Code")],
    [
      edge("cl", "a", "stated_in"),  // cl +1, a +1
      edge("a", "c", "input"),      // a +1, c +1
    ],
  );
  const counts = buildProducesMemberCounts(g);
  assert.equal(counts.get("cl"), 1);
  assert.equal(counts.get("a"), 2);   // stated_in target + input source
  // c now counts (IN-edge from input) — this is the fix that lets nodes with
  // only incoming citation edges show the expand tooltip.
  assert.equal(counts.get("c"), 1);
});

test("countFoldedProducesMembers: 0 for a node whose adjacent members are all visible", () => {
  // Regression guard for the "sub_analysis2.txt Artifact shows 双击展开节点
  // tooltip but double-click expands nothing" bug. The Artifact's two adjacent
  // produces members (Code + Task scope) are ALREADY visible (Code surfaced via
  // the scope expansion, Task on the main chain) → folded count must be 0, so
  // the tooltip is suppressed and toggleProduces is a no-op.
  const g = subgraph(
    [
      node("rg", "ResearchGoal"),
      node("tc1", "ToolCall"),
      node("scope", "Task"),
      node("code1", "Code"),
      node("art", "Artifact"),
    ],
    [
      edge("rg", "tc1", "next"),
      edge("tc1", "scope", "next"),
      // Artifact has only IN produces edges (both members already elsewhere):
      edge("code1", "art", "produces"),   // Code produces Artifact
      edge("scope", "art", "produces"),   // scope produces Artifact (surrogate)
    ],
  );
  // Visible = main chain {rg, tc1, scope} ∪ Code (say scope expanded it).
  const visible = new Set(["rg", "tc1", "scope", "code1", "art"]);
  assert.equal(countFoldedProducesMembers(g, "art", visible), 0,
    "Artifact with both adjacent members visible → folded count 0");
  // Hiding Code makes the Artifact's code1 member folded again → count 1.
  const visibleNoCode = new Set(["rg", "tc1", "scope", "art"]);
  assert.equal(countFoldedProducesMembers(g, "art", visibleNoCode), 1);
});

test("countFoldedProducesMembers: 0 for a node with no produces members (ResearchGoal)", () => {
  // Regression guard for the "ResearchGoal double-click shows 无可展开子节点
  // toast even though its children are visible" bug. ResearchGoal's children
  // ride next edges (always visible on the main chain) — it has ZERO produces/
  // citation adjacent members, so folded count is 0: no tooltip, no toast.
  const g = subgraph(
    [
      node("rg", "ResearchGoal"),
      node("t1", "Task"),
      node("p1", "Paper"),   // attached to tc via produces, NOT to rg
    ],
    [
      edge("rg", "t1", "next"),          // next: not a produces edge
      edge("t1", "p1", "produces"),
    ],
  );
  // rg is visible (main chain); its produces adjacent set is empty.
  assert.equal(countFoldedProducesMembers(g, "rg", new Set(["rg", "t1"])), 0);
  // Contrast: t1 has a folded produces member (p1 not visible) → count 1.
  assert.equal(countFoldedProducesMembers(g, "t1", new Set(["rg", "t1"])), 1);
  // Surfacing p1 (visible) drops t1's folded count to 0.
  assert.equal(countFoldedProducesMembers(g, "t1", new Set(["rg", "t1", "p1"])), 0);
});

test("projectToCanvas + collapseProducesOwner: shallow collapse breaks the owner's edge but leaves the grandchild", () => {
  // 回归：浅层折叠（仿新版 Neo4j Browser）对齐用户验证的真实行为。
  // 真实 session 0bf3c7bd 的拓扑（简化）：ToolCall──produces→Code──produces→
  // Artifact(report2)──supports→Claim←supports──Evidence←extracts──Paper。
  // 用户展开链 lit→code_exec→Code→report2→Claim（Claim 展 Evidence）后再双击
  // report2 折叠。期望：Claim 消失、report2↔Claim 边断、Evidence **留下**
  // （它是 Claim 名下的孙，浅层不删；且在 appearedIds 里，脱离被删的 Claim 仍可见）。
  // 经典版会递归删整棵（Claim+Evidence 都没），新版只删直接子——本测试锁定新版行为。
  const g = subgraph(
    [
      node("rg", "ResearchGoal"),
      node("tc", "ToolCall"),
      node("code", "Code"),
      node("report2", "Artifact"),
      node("claim", "Claim"),
      node("evidence", "Evidence"),
      node("paper", "Paper"),
    ],
    [
      edge("rg", "tc", "next"),
      edge("tc", "code", "produces"),
      edge("code", "report2", "produces"),
      edge("report2", "claim", "supports"),   // report2 ──supports→ claim
      edge("evidence", "claim", "supports"),  // evidence ──supports→ claim
      edge("paper", "evidence", "extracts"),  // paper ──extracts→ evidence
    ],
  );
  const mainChain = mainChainNodeIds(g); // {rg, tc}

  // 展开链：tc→code→report2→claim→evidence，每步拉一层。
  // expandedNodeMap 记「谁展开过谁」；appearedIds 记所有曾出现节点。
  const expandedNodeMap = new Map<string, Set<string>>([
    ["tc", new Set(["code"])],
    ["code", new Set(["report2"])],
    ["report2", new Set(["claim"])],     // report2 拉进 claim（直接子）
    ["claim", new Set(["evidence"])],   // claim 拉进 evidence（report2 的孙）
  ]);
  // paper 也假设已被别的展开（如 lit_search 展 Paper）拉进 appearedIds——
  // 真实 session 里 paper 是 evidence 的相邻节点，由 lit_search 展开拉入。
  const appearedIds = new Set(["code", "report2", "claim", "evidence", "paper"]);

  // 全展开态：claim + evidence 都可见。
  const open = projectToCanvas(g, mainChain, expandedNodeMap, appearedIds);
  const openIds = new Set(open.nodes.map((n) => n.id));
  assert.ok(openIds.has("claim"), "claim visible after full expand");
  assert.ok(openIds.has("evidence"), "evidence visible after full expand");
  assert.ok(open.edges.some((e) => e.source === "report2" && e.target === "claim"),
    "report2→claim edge visible when both endpoints present");

  // 折叠 report2：collapseProducesOwner 浅层只返回 report2 的直接子 = {claim}
  // （不递归 claim 名下的 evidence）。toggleProduces 会：删 report2 的 key、
  // 从 appearedIds 移除 {claim}（直接子，不含孙 evidence）。
  const remove = collapseProducesOwner(expandedNodeMap, "report2");
  assert.deepEqual([...remove].sort(), ["claim"],
    "shallow collapse of report2 returns only its direct child claim, not the grandchild evidence");

  // 模拟 toggleProduces 后的状态：删 report2 key + 从 appearedIds 移除 remove。
  const collapsedMap = new Map(expandedNodeMap);
  collapsedMap.delete("report2");
  // 清引用：从所有 owner 的 children 里清 remove（防御残留）。
  for (const [oid, children] of collapsedMap) {
    const filtered = new Set<string>();
    for (const c of children) { if (!remove.has(c)) filtered.add(c); }
    collapsedMap.set(oid, filtered);
  }
  const collapsedAppeared = new Set(appearedIds);
  for (const r of remove) collapsedAppeared.delete(r);  // 只删直接子 claim，evidence 留

  const collapsed = projectToCanvas(g, mainChain, collapsedMap, collapsedAppeared);
  const colIds = new Set(collapsed.nodes.map((n) => n.id));
  assert.ok(!colIds.has("claim"), "claim gone after collapsing report2 (direct child removed)");
  assert.ok(colIds.has("evidence"), "evidence STAYS after collapsing report2 (grandchild, shallow)");
  assert.ok(colIds.has("report2"), "report2 itself stays (it's in appearedIds via code's expansion)");
  // report2→claim 边因 claim 消失而断。
  assert.ok(!collapsed.edges.some((e) => e.source === "report2" && e.target === "claim"),
    "report2→claim edge broken (claim endpoint gone)");
  // evidence→claim 边也因 claim 消失而断。
  assert.ok(!collapsed.edges.some((e) => e.source === "evidence" && e.target === "claim"),
    "evidence→claim edge broken (claim endpoint gone)");
  // evidence↔paper 边两端都在（evidence 留、paper 在 appearedIds）→ 留。
  assert.ok(collapsed.edges.some((e) => e.source === "paper" && e.target === "evidence"),
    "paper→evidence edge stays (both endpoints still visible)");
});


