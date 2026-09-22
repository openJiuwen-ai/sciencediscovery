// Entry-focus wiring for the memory-graph explorer.
//
// A caller that names an entry node (`initialNodeId`) must land on a canvas
// where that node is VISIBLE and selected. The projection (`projectToCanvas`)
// keeps only the spine + already-unfolded nodes, so any non-spine entry node —
// which is every chip jump: DbRecord, Evidence, SourceFile, a folded Artifact —
// is dropped unless the explorer marks it as the entry focus.
//
// The regression this file pins: the focus effect used to require `autoChain`
// (the modal-entry marker) on top of `initialNodeId`. App.tsx's chip jump
// passes `initialNodeId` alone, so the node was selected-but-folded —
// `graph.nodes.find(id === selectedId)` was undefined and the detail card never
// rendered, reading as "the chip click did nothing" (reported for [dbrecord1]
// in the report body and in an assistant message).
//
// The decision is a pure predicate so it can be tested without mounting the
// explorer (the canvas is a WebGL island the SSR test harness cannot run).

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";


import { countVisibleAndTotal, shouldFocusEntryNode } from "../src/MemoryGraphExplorer.js";

test("an entry node is focused without any modal-entry marker", () => {
  // The chip-jump shape: initialNodeId set, autoChain unset. Before the fix
  // this returned false, so a [dbrecord1] click opened the explorer with the
  // node selected but folded out of the canvas.
  assert.equal(shouldFocusEntryNode("P38398", false), true);
});

test("no entry node → nothing to focus (right-rail card entry)", () => {
  // Opened from the right-rail card: no entry node, so the explorer must stay
  // on the full backbone and not dim everything behind a phantom focus.
  assert.equal(shouldFocusEntryNode(undefined, false), false);
});

test("the re-fire guard holds once the entry has been decided", () => {
  // The effect marks itself done on every decision, including "abort — the
  // entry node is not in the subgraph". Without this, a graph poll would
  // re-enter the effect forever.
  assert.equal(shouldFocusEntryNode("P38398", true), false);
  assert.equal(shouldFocusEntryNode(undefined, true), false);
});

test("an entry completed for one node still allows the next chip click", () => {
  // Clicking [dbrecord-1] then [dbrecord-2] with the explorer already open:
  // the prop-change effect clears the done flag, so the new entry node is
  // focused instead of the canvas staying pinned to the first one.
  assert.equal(shouldFocusEntryNode("P38398", true), false);
  assert.equal(shouldFocusEntryNode("Q92731", false), true);
});

// --- header visible / total counts ---------------------------------------

test("countVisibleAndTotal counts the drawn graph against the whole session", () => {
  const all = {
    nodes: [
      { id: "g", label: "ResearchGoal" },
      { id: "t1", label: "ToolCall" },
      { id: "c1", label: "Code" },
      { id: "a1", label: "Artifact" },
    ],
    edges: [
      { source: "g", target: "t1", type: "next" },
      { source: "t1", target: "c1", type: "produces" },
      { source: "c1", target: "a1", type: "produces" },
    ],
  } as const;
  const spine = {
    nodes: all.nodes.slice(0, 2),
    edges: all.edges.slice(0, 1),
  };
  assert.deepEqual(countVisibleAndTotal(spine as never, all as never), {
    visibleNodes: 2, totalNodes: 4, visibleEdges: 1, totalEdges: 3,
  });
  // Fully expanded reads N / N.
  assert.deepEqual(countVisibleAndTotal(all as never, all as never), {
    visibleNodes: 4, totalNodes: 4, visibleEdges: 3, totalEdges: 3,
  });
});

test("countVisibleAndTotal ignores aggregate stacks and surrogate edges", () => {
  const all = {
    nodes: [
      { id: "t1", label: "ToolCall" },
      { id: "_group:t1:Paper", label: "Paper", extra: { aggregated: true, count: 5 } },
    ],
    edges: [
      { source: "t1", target: "_group:t1:Paper", type: "produces", extra: { surrogate: true } },
    ],
  };
  assert.deepEqual(countVisibleAndTotal(all as never, all as never), {
    visibleNodes: 1, totalNodes: 1, visibleEdges: 0, totalEdges: 0,
  });
});
