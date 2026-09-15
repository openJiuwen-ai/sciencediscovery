// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createWorkspaceTools } from "./workspace.js";

// executePython is a required option; these tools never call it.
const unusedPython = async (): Promise<never> => {
  throw new Error("executePython is not used by research_state/tournament_rank");
};

test("research_state tool: registered, end-to-end set-goal → mark-tried → summary", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "workspace-research-state-"));
  context.after(() => rm(root, { force: true, recursive: true }));

  const tools = createWorkspaceTools(root, { enabledConnectorIds: [], executePython: unusedPython });
  const tool = tools.find((candidate) => candidate.name === "research_state");
  assert.ok(tool, "research_state must be registered unconditionally");
  // Read-modify-write on one JSON file → must serialize same-turn calls.
  assert.equal(tool.isConcurrencySafe?.({} as never), false);

  const invoke = async (params: Record<string, unknown>) => {
    const result = await tool.execute("tc", params as never, undefined);
    const text = result.content[0];
    assert.equal(text?.type, "text");
    return JSON.parse((text as { text: string }).text) as Record<string, unknown>;
  };

  const goal = await invoke({ action: "set-goal", goal: "Map Ebola GP breadth" });
  assert.equal(goal.goal, "Map Ebola GP breadth");

  await invoke({ action: "mark-tried", tried: "kb_search 'mAb114 IC50'", tool: "kb_search", result: "3 hits" });
  const repeat = await invoke({ action: "check-tried", tried: "KB_SEARCH 'mab114 ic50'" });
  assert.equal(repeat.tried, true);

  const summary = await invoke({ action: "summary" });
  assert.equal(summary.goal, "Map Ebola GP breadth");
  assert.deepEqual(summary.triedActions, { total: 1, repeated: 0 });

  // Unknown action is a structured, fixable error.
  await assert.rejects(() => invoke({ action: "bogus" }), /Unknown action/);
});

test("tournament_rank tool: registered, rank + divergence round-trip", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "workspace-tournament-"));
  context.after(() => rm(root, { force: true, recursive: true }));

  const tools = createWorkspaceTools(root, { enabledConnectorIds: [], executePython: unusedPython });
  const tool = tools.find((candidate) => candidate.name === "tournament_rank");
  assert.ok(tool, "tournament_rank must be registered unconditionally");
  // Pure computation → safe to run concurrently.
  assert.equal(tool.isConcurrencySafe?.({} as never), true);

  const invoke = async (params: Record<string, unknown>) => {
    const result = await tool.execute("tc", params as never, undefined);
    const text = result.content[0];
    assert.equal(text?.type, "text");
    return JSON.parse((text as { text: string }).text) as Record<string, unknown>;
  };

  const ranked = await invoke({
    action: "rank",
    items: ["h1", "h2"],
    matches: [{ a: "h1", b: "h2", scoreA: 1 }],
  });
  const ranking = ranked.ranking as Array<{ item: string; elo: number }>;
  assert.equal(ranking[0]!.item, "h1");
  assert.equal(ranking[0]!.elo, 1016);

  // Bad verdicts surface a structured error payload (not a throw).
  const bad = await invoke({ action: "rank", items: ["h1", "h2"], matches: [{ a: "h1", b: "nope", scoreA: 1 }] });
  assert.match(String(bad.error), /not in items/);

  const divergence = await invoke({ action: "divergence", texts: ["alpha beta", "gamma delta"] });
  assert.equal(divergence.divergence, 1);
});
