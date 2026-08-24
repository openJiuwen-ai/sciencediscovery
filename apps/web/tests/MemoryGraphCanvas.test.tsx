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

import {
  EDGE_COLORS,
  NODE_COLORS,
  graphNodeDisplayNames,
  graphNodeName,
} from "../src/MemoryGraphCanvas.js";

// The schema union is the single source of truth for which node labels and
// edge types exist. EDGE_COLORS / NODE_COLORS are Record<UnionType, string>,
// so a key mismatch is a compile error — but only when the canvas is rebuilt
// against the current schema. These tests guard the runtime contract so a
// canvas that drifted from the schema (the exact regression PR #25 shipped:
// extracted_from/cites/states left over after the schema renamed them to
// extracts/supports/stated_in) fails loudly here instead of silently dropping
// arrow markers and filter-chip swatches.
const EDGE_TYPES: MemoryGraphEdgeType[] = ["next", "produces", "extracts", "supports", "stated_in", "supersedes", "input"];
const NODE_LABELS: MemoryGraphNodeLabel[] = ["ResearchGoal", "SubTask", "Paper", "Evidence", "Claim", "Code", "Artifact"];

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
  const name = graphNodeName({ label: "SubTask", id: "t1", extra: { task_type: long } });
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
  // SubTask prefers `task_type` over `task_id`.
  assert.equal(
    graphNodeName({ label: "SubTask", id: "s1", extra: { task_id: "tid", task_type: "analyze" } }),
    "analyze",
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
    { label: "SubTask" as const, id: "s1", extra: { task_type: "analyze" } },
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
