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

import type { MemoryGraphEdgeType, MemoryGraphNodeLabel } from "@sciencediscovery/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { LocaleProvider } from "../src/i18n/LocaleProvider.js";
import { MemoryGraphNodeDetail } from "../src/MemoryGraphProduct.js";

import {
  EDGE_COLORS,
  NODE_COLORS,
  graphNodeDisplayNames,
  graphNodeName,
  isCancelledNode,
  isChildNode,
  isScopeNode,
  isSurrogateEdge,
} from "../src/MemoryGraphCanvas.js";

// The schema union is the single source of truth for which node labels and
// edge types exist. EDGE_COLORS / NODE_COLORS are Record<UnionType, string>,
// so a key mismatch is a compile error — but only when the canvas is rebuilt
// against the current schema. These tests guard the runtime contract so a
// canvas that drifted from the schema (the exact regression PR #25 shipped:
// extracted_from/cites/states left over after the schema renamed them to
// extracts/supports/stated_in) fails loudly here instead of silently dropping
// arrow markers and filter-chip swatches.
const EDGE_TYPES: MemoryGraphEdgeType[] = [
  "next", "produces", "extracts", "supports", "stated_in", "supersedes", "input", "contains",
  // /evolve search graph.
  "searches", "root", "expands", "inspires", "elected", "occupies",
];
const NODE_LABELS: MemoryGraphNodeLabel[] = [
  "ResearchGoal", "Task", "ToolCall", "Paper", "Evidence", "Claim", "Code", "Artifact",
  // /evolve search graph.
  "SearchRun", "SearchNode", "SearchCell",
];

test("EDGE_COLORS has exactly the schema edge types as keys", () => {
  assert.deepEqual(
    Object.keys(EDGE_COLORS).sort(),
    [...EDGE_TYPES].sort(),
  );
  // Every entry paints the same slate fallback; assert the shape, not a hue.
  for (const type of EDGE_TYPES) {
    assert.equal(typeof EDGE_COLORS[type], "string");
    assert.ok(EDGE_COLORS[type].startsWith("#"), `EDGE_COLORS[${type}] is not a hex colour`);
  }
});

test("NODE_COLORS has exactly the schema node labels as keys", () => {
  assert.deepEqual(
    Object.keys(NODE_COLORS).sort(),
    [...NODE_LABELS].sort(),
  );
  for (const label of NODE_LABELS) {
    assert.equal(typeof NODE_COLORS[label], "string");
    assert.ok(NODE_COLORS[label].startsWith("#"), `NODE_COLORS[${label}] is not a hex colour`);
  }
});

test("graphNodeName truncates names longer than 30 characters with an ellipsis", () => {
  const long = "x".repeat(40);
  const name = graphNodeName({ label: "ToolCall", id: "t1", extra: { task_type: long } });
  assert.equal(name.length, 30);
  assert.ok(name.endsWith("…"));
});

test("graphNodeName takes the basename of long path-like names before truncating", () => {
  // A 60-char path: the basename is the final segment, then truncated.
  const path = "/workspace/sessions/s1/artifacts/" + "a".repeat(40) + ".csv";
  const name = graphNodeName({ label: "Artifact", id: "a1", extra: { path } });
  // Basename is the part after the last "/", then truncated to 30 chars.
  const basename = path.slice(path.lastIndexOf("/") + 1);
  const expected = basename.length > 30 ? `${basename.slice(0, 29)}…` : basename;
  assert.equal(name, expected);
});

test("graphNodeName keeps short paths intact (basename logic only triggers past 28 chars)", () => {
  // graphNodeName only takes the basename when the resolved name is longer
  // than 28 chars *and* contains a slash; a short path is returned verbatim.
  assert.equal(
    graphNodeName({ label: "Artifact", id: "a1", extra: { path: "/x/y.csv" } }),
    "/x/y.csv",
  );
});

test("graphNodeName falls back to the node id when no extra field resolves", () => {
  const name = graphNodeName({ label: "Paper", id: "paper-42", extra: {} });
  assert.equal(name, "paper-42");
});

test("graphNodeName picks label-specific fields in priority order", () => {
  // Artifact prefers `path` over `artifact_id`; a short path is kept verbatim
  // (basename extraction only kicks in past 28 chars — see the previous test).
  assert.equal(
    graphNodeName({ label: "Artifact", id: "a1", extra: { artifact_id: "aid", path: "/x/y.csv" } }),
    "/x/y.csv",
  );
  // Code prefers `tool` over `code_id`.
  assert.equal(
    graphNodeName({ label: "Code", id: "c1", extra: { code_id: "cid", tool: "run_python" } }),
    "run_python",
  );
  // ToolCall prefers `task_type` over `tool_type` over `task_id`.
  assert.equal(
    graphNodeName({ label: "ToolCall", id: "s1", extra: { task_id: "tid", task_type: "analyze" } }),
    "analyze",
  );
  // Task (subagent scope) prefers `objective` over `task_type` over `task_id`.
  assert.equal(
    graphNodeName({ label: "Task", id: "s2", extra: { task_id: "tid2", task_type: "subagent", objective: "find a cure" } }),
    "find a cure",
  );
  // Paper prefers `title` over `link`.
  assert.equal(
    graphNodeName({ label: "Paper", id: "p1", extra: { link: "http://x", title: "My Paper" } }),
    "My Paper",
  );
  // ResearchGoal prefers `core_objective` over `goal_id`.
  assert.equal(
    graphNodeName({ label: "ResearchGoal", id: "g1", extra: { goal_id: "gid", core_objective: "find X" } }),
    "find X",
  );
  // Evidence/Claim fall through to `title` then `name`.
  assert.equal(
    graphNodeName({ label: "Evidence", id: "e1", extra: { name: "n", title: "T" } }),
    "T",
  );
});

test("graphNodeName ignores non-string or blank extra fields", () => {
  // A number value, an empty string, and whitespace should all be skipped,
  // falling through to the next candidate or the id.
  const name = graphNodeName({
    label: "Paper",
    id: "p1",
    extra: { title: "   ", link: 123, },
  });
  assert.equal(name, "p1");
});

test("graphNodeDisplayNames leaves unique names unchanged", () => {
  const nodes = [
    { label: "ToolCall" as const, id: "s1", extra: { task_type: "analyze" } },
    { label: "Paper" as const, id: "p1", extra: { title: "My Paper" } },
  ];
  const display = graphNodeDisplayNames(nodes);
  assert.equal(display.get("s1"), "analyze");
  assert.equal(display.get("p1"), "My Paper");
});

test("graphNodeDisplayNames suffixes repeated names with #n in graph order", () => {
  // Six run_python nodes: each gets a #1..#6 suffix in the order they appear.
  const nodes = Array.from({ length: 6 }, (_, i) => ({
    label: "Code" as const,
    id: `c${i + 1}`,
    extra: { tool: "run_python" },
  }));
  const display = graphNodeDisplayNames(nodes);
  assert.equal(display.get("c1"), "run_python #1");
  assert.equal(display.get("c2"), "run_python #2");
  assert.equal(display.get("c6"), "run_python #6");
});

test("graphNodeDisplayNames does not suffixed names that appear only once", () => {
  // Two distinct tools: no suffix even though they share a label.
  const nodes = [
    { label: "Code" as const, id: "c1", extra: { tool: "run_python" } },
    { label: "Code" as const, id: "c2", extra: { tool: "run_shell" } },
  ];
  const display = graphNodeDisplayNames(nodes);
  assert.equal(display.get("c1"), "run_python");
  assert.equal(display.get("c2"), "run_shell");
});

test("图谱的 evolve 节点展示搜索内容并能跳到演进面板", () => {
  // The evolve ToolCall used to render a bare status + a raw "program_evolution"
  // string: the run's substance lives one edge away on the SearchRun, and the
  // panel that could explain it was unreachable from the graph.
  const subtask = {
    extra: { status: "completed", task_type: "program_evolution" },
    id: "subtask:evolve:23601271-4db3-4774-bf69-b2c8bb9b81e5",
    label: "ToolCall" as const,
  };
  const searchRun = {
    extra: {
      algorithm: "puct", baseline_score: 0.6626, best_test_score: 0.7666,
      candidates: 17, search_id: "23601271-4db3-4774-bf69-b2c8bb9b81e5",
      status: "succeeded", tokens: 56834,
    },
    id: "23601271-4db3-4774-bf69-b2c8bb9b81e5",
    label: "SearchRun" as const,
  };
  const subgraph = {
    edges: [{ source: subtask.id, target: searchRun.id, type: "searches" as const }],
    nodes: [subtask, searchRun],
  };

  const opened: string[] = [];
  const html = renderToStaticMarkup(createElement(
    LocaleProvider, { initialLocale: "zh-CN" as const },
    createElement(MemoryGraphNodeDetail as never, {
      client: {} as never,
      node: subtask as never,
      onOpenEvolveRun: (runId: string) => opened.push(runId),
      resolveState: { names: {}, states: {} } as never,
      sessionId: "s1",
      subgraph: subgraph as never,
    }),
  ));

  assert.match(html, /程序演进/, "task_type 要有译名，不能裸串");
  assert.match(html, /0\.6626/, "SubTask 详情要透出 SearchRun 的基线");
  assert.match(html, /0\.7666/, "以及留出测试分");
  assert.match(html, /打开演进面板/, "以及去面板的按钮");

  // SearchRun 自己的详情也一样能看、能跳。
  const runHtml = renderToStaticMarkup(createElement(
    LocaleProvider, { initialLocale: "zh-CN" as const },
    createElement(MemoryGraphNodeDetail as never, {
      client: {} as never,
      node: searchRun as never,
      onOpenEvolveRun: () => {},
      resolveState: { names: {}, states: {} } as never,
      sessionId: "s1",
      subgraph: subgraph as never,
    }),
  ));
  assert.match(runHtml, /打开演进面板/);
  assert.match(runHtml, /0\.7666/);
});

test("evolve 相关节点的标题要能读", () => {
  // Two circles both reading "evolve/e…" and one reading just "puct" told the
  // user nothing: which artifact the search started from, which it produced,
  // and what the mystery word meant.
  assert.equal(
    graphNodeName({ label: "Artifact", id: "a#v9",
      extra: { path: "evolve/e71c20c5/candidate.py", version: 9 } }),
    "candidate.py v9",
  );
  assert.equal(
    graphNodeName({ label: "SearchRun", id: "r1",
      extra: { algorithm: "puct", best_test_score: 0.766605 } }),
    "puct · 0.77",
  );
  // Still running: no score yet, the algorithm alone.
  assert.equal(
    graphNodeName({ label: "SearchRun", id: "r2", extra: { algorithm: "puct" } }),
    "puct",
  );
});

// --- subagent surrogate edges, scope/child/cancelled classification (PR3) ---

test("isSurrogateEdge keys on extra.surrogate === true only", () => {
  // A folded surrogate edge carries the marker + the via_child hop. The
  // render pass dashes/lightens the line and skips the label only when this
  // returns true; a real produces edge (no marker) must read false.
  assert.equal(isSurrogateEdge({ extra: { surrogate: true, via_child: "c1" } }), true);
  assert.equal(isSurrogateEdge({ extra: { surrogate: 1 } }), false, "truthy-but-not-true must not match");
  assert.equal(isSurrogateEdge({ extra: { surrogate: false } }), false);
  assert.equal(isSurrogateEdge({ extra: {} }), false);
  assert.equal(isSurrogateEdge({}), false, "missing extra must not match");
});

test("isScopeNode keys on extra.task_type === 'subagent'", () => {
  // Scope and child share the SubTask label — the scope is distinguished by
  // task_type, never by label. A plain SubTask or an exec child must read
  // false so they don't get the expandable ring + ▸N badge.
  assert.equal(isScopeNode({ id: "s", extra: { task_type: "subagent" } }), true);
  assert.equal(isScopeNode({ id: "s", extra: { task_type: "code_execution" } }), false);
  assert.equal(isScopeNode({ id: "s", extra: {} }), false);
  assert.equal(isScopeNode({ id: "s" }), false);
});

test("isChildNode keys on parent_subtask_id or an :exec: task_id", () => {
  // PR1's child task_id shape is `subtask:subagent:<id>:exec:<execId>`; the
  // child also carries parent_subtask_id pointing back at the scope. Either
  // marks a node as a child of an expanded scope.
  assert.equal(isChildNode({ id: "subtask:subagent:sub1:exec:e1", extra: {} }), true);
  assert.equal(isChildNode({ id: "x", extra: { parent_subtask_id: "scope" } }), true);
  assert.equal(isChildNode({ id: "subtask:subagent:sub1", extra: { task_type: "subagent" } }), false, "a scope is not a child");
  assert.equal(isChildNode({ id: "plain", extra: {} }), false);
});

test("isCancelledNode keys on status === 'cancelled' (case-insensitive)", () => {
  // cancelled is terminal-but-failed — distinct from pending (unfinished)
  // and completed (succeeded/…). PR1 writes it on aborted subagents.
  assert.equal(isCancelledNode({ extra: { status: "cancelled" } }), true);
  assert.equal(isCancelledNode({ extra: { status: "Cancelled" } }), true);
  assert.equal(isCancelledNode({ extra: { status: "succeeded" } }), false);
  assert.equal(isCancelledNode({ extra: { status: "running" } }), false);
  assert.equal(isCancelledNode({ extra: {} }), false);
  assert.equal(isCancelledNode({}), false);
});
