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

/**
 * Turning the main agent's proposal into a run.
 *
 * What is worth testing here is the asymmetry: the agent designs, and this side
 * decides what a run *is*. So the tests are about the gates — a proposal that
 * would produce an unrankable search is refused with a sentence its author can
 * act on, and nothing reaches the store before the shape is known good.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { EvolveRunProposal } from "@sciencediscovery/schema";

import { EvolveSidecarError } from "./sidecar.js";
import { startProposedRun, summariseRun, type ProposalDeps } from "./proposal.js";

const SPLIT = {
  gateShards: 8, rolloutShards: 4, seed: 0, shardRows: 20, testShards: 2, trainRows: null,
};

function proposal(over: Partial<EvolveRunProposal> = {}): EvolveRunProposal {
  return {
    datasetPath: "data.csv",
    direction: "minimize",
    expansions: 12,
    howScored: "在留出的 6 片上算 MAE 取均值，越低分越高。",
    metric: "mae",
    mode: "dataset_metric",
    split: SPLIT,
    startingPointPath: "baseline.py",
    statement: "把误差降下来",
    targetColumn: "y",
    workers: 2,
    ...over,
  };
}

/** A world where every gate passes, so a test can isolate one that does not. */
function deps(over: Partial<ProposalDeps> = {}) {
  const stored: Array<{ content?: string; path?: string }> = [];
  const base: ProposalDeps = {
    casHas: async () => true,
    model: () => ({ hasApiToken: true, id: "m1", name: "M" }),
    modelId: "m1",
    orchestrator: {
      probe: async () => ({ baseline: 0.4, flat: false, label: "把返回值换成常数", worsened: 0.1 }),
      sandboxCapability: async () => ({ available: true, backend: "bwrap" }),
      start: async () => ({ id: "run-1", status: "running" }),
    } as never,
    sessionId: "s1",
    store: async (input) => {
      stored.push(input);
      return `sha256:${"a".repeat(64)}`;
    },
    ...over,
  };
  return { deps: base, stored };
}

test("a coherent proposal becomes a run, and the probe's numbers come back with it", async () => {
  const { deps: d } = deps();
  const result = await startProposedRun(proposal(), d);

  assert.equal(result.run?.id, "run-1");
  assert.equal(result.probe?.baseline, 0.4);
  assert.equal(result.refusedBecause, undefined);
});

test("the probe's own verdict reaches the agent unwrapped", async () => {
  // A 4xx from the sidecar is what the probe found, not a failure to probe.
  // Wrapping it in "the probe could not be carried out" contradicts the
  // sentence inside it and sends the agent looking at the environment when the
  // thing to fix is its own starting point.
  const { deps: d } = deps({
    orchestrator: {
      probe: async () => {
        throw new EvolveSidecarError("评测脚本连起点都跑不完：NameError: name 'foo' is not defined", 400);
      },
      sandboxCapability: async () => ({ available: true, backend: "bwrap" }),
      start: async () => ({ id: "run-1", status: "running" }),
    } as never,
  });
  const result = await startProposedRun(proposal(), d);

  assert.equal(result.run, undefined);
  assert.equal(result.refusedBecause, "评测脚本连起点都跑不完：NameError: name 'foo' is not defined");
  assert.ok(!result.refusedBecause?.startsWith("判别力探针没能进行"));
});

test("a probe that genuinely could not run is reported as the incident it is", async () => {
  const { deps: d } = deps({
    orchestrator: {
      probe: async () => {
        throw new EvolveSidecarError("connect ECONNREFUSED 127.0.0.1:4313", 503);
      },
      sandboxCapability: async () => ({ available: true, backend: "bwrap" }),
      start: async () => ({ id: "run-1", status: "running" }),
    } as never,
  });
  const result = await startProposedRun(proposal(), d);

  assert.ok(result.refusedBecause?.startsWith("判别力探针没能进行"));
  assert.ok(result.refusedBecause?.includes("ECONNREFUSED"));
});

test("a flat scoring is refused with the numbers that make the refusal checkable", async () => {
  // The one thing the control plane cannot learn by reading the proposal, and
  // the failure the whole design exists to prevent: a search that emits every
  // event and finds nothing.
  const { deps: d } = deps({
    orchestrator: {
      probe: async () => ({ baseline: 0.5, flat: true, label: "把返回值换成常数", worsened: 0.4999 }),
      sandboxCapability: async () => ({ available: true, backend: "bwrap" }),
      start: async () => assert.fail("a flat scoring must never reach start()"),
    } as never,
  });

  const result = await startProposedRun(proposal(), d);
  assert.match(result.refusedBecause!, /0\.5000 vs 0\.4999/);
  assert.match(result.refusedBecause!, /分不出好坏/);
});

test("a refusal names what to change, because its reader is the designer", async () => {
  const { deps: d } = deps();
  const cases: Array<[Partial<EvolveRunProposal>, RegExp]> = [
    [{ startingPointPath: undefined }, /没有起点/],
    [{ expansions: 4, workers: 2 }, /树是平的/],
    [{ split: { ...SPLIT, gateShards: 2 } }, /判不出/],
    [{ mode: "custom_script", evaluatorSource: undefined }, /要给评测脚本/],
    [{ mode: "custom_script", evaluatorSource: "print(1)" }, /SCIENCE_AGENT_SHARDS/],
    [{ mode: "llm_judge", rubric: undefined }, /要写评分细则/],
    [{ mode: "test_gate", testCmd: "pytest -q", frozenGlobs: [] }, /必须冻结测试路径/],
  ];
  for (const [over, expected] of cases) {
    const result = await startProposedRun(proposal(over), d);
    assert.match(result.refusedBecause ?? "", expected, JSON.stringify(over));
  }
});

test("nothing is stored until the shape is known good", async () => {
  // A half-written proposal that already put an evaluator in the content store
  // leaves a blob nobody chose, addressed by a hash nothing references.
  const { deps: d, stored } = deps();
  await startProposedRun(proposal({ startingPointPath: undefined }), d);
  assert.deepEqual(stored, []);
});

test("the scoring definition is frozen, whichever language it is written in", async () => {
  // A rubric and an evaluator are the same thing in different languages: the
  // scoring. A search that can rewrite what marks it learns to do that instead
  // of getting better, so both land in `frozen`.
  for (const over of [
    { mode: "llm_judge" as const, rubric: "分项细则…", scaleMax: 10 },
    {
      evaluatorSource: 'import os\nos.environ["SCIENCE_AGENT_SHARDS"]\nos.environ["SCIENCE_AGENT_RESULT"]',
      mode: "custom_script" as const,
    },
  ]) {
    let captured: { frozen: string[] } | undefined;
    const { deps: d } = deps({
      orchestrator: {
        probe: async () => ({ baseline: 0.4, flat: false, label: "x", worsened: 0.1 }),
        sandboxCapability: async () => ({ available: true, backend: "bwrap" }),
        start: async (input: { goal: { frozen: string[] } }) => {
          captured = input.goal;
          return { id: "run-1", status: "running" };
        },
      } as never,
    });
    await startProposedRun(proposal(over), d);
    assert.equal(captured?.frozen.length, 1, over.mode);
  }
});

test("a run that learned nothing says so, rather than reporting a status", async () => {
  // `succeeded` is a claim that the search searched. When every score matched
  // the seed the engine says so in a log line, and that line is the most
  // important thing about such a run.
  const summary = summariseRun(
    { candidates: 9, id: "r", status: "succeeded", tokens: 42_972 },
    [
      { event: { baselineScore: 0.667, type: "seeded" } },
      { event: { score: 0.667, type: "expanded", valid: true } },
      { event: { level: "warn", message: "9 个候选的分数全都一样（0.6670）", type: "log" } },
      { event: { type: "search_finished" } },
    ],
  );

  assert.match(summary.note!, /分数全都一样/);
  assert.equal(summary.bestTestScore, null);
});

test("the summary quotes the split the search never saw", async () => {
  const summary = summariseRun(
    { candidates: 12, id: "r", status: "succeeded", tokens: 11_000 },
    [
      { event: { baselineScore: 0.155, type: "seeded" } },
      { event: { changeSummary: "换成弹性网络", score: 0.56, type: "expanded", valid: true } },
      { event: { changeSummary: "加二阶交互项", score: 0.6, type: "expanded", valid: true } },
      { event: { score: null, type: "expanded", valid: false } },
      { event: { bestTestScore: 0.58, type: "search_finished" } },
    ],
  );

  assert.equal(summary.baselineScore, 0.155);
  assert.equal(summary.bestScore, 0.6);
  assert.equal(summary.bestChange, "加二阶交互项");
  // The only number quotable outside the run: everything else was optimised
  // against, so an improvement measured on it is inflated by construction.
  assert.equal(summary.bestTestScore, 0.58);
});



test("a workspace-absolute path is accepted, because that is what the agent saw", async () => {
  // The sandbox mounts the workspace at /workspace, so every path the agent
  // reads out of a tool result is absolute. Writing it back verbatim is the
  // natural thing to do, and refusing it with "paths must be relative" reads as
  // a bug in the tool rather than a fixable mistake.
  const { deps: d, stored } = deps();
  const result = await startProposedRun({
    ...proposal(), startingPointPath: "/workspace/evolve_ode/baseline.py",
  }, d);

  assert.equal(result.run?.id, "run-1");
  assert.ok(stored.some((entry) => entry.path === "evolve_ode/baseline.py"));
});

test("a path that cannot be read names the field it came from", async () => {
  const { deps: d } = deps({
    store: async () => { throw new Error("Path escapes the workspace: ../etc/passwd"); },
  });
  const result = await startProposedRun({
    ...proposal(), startingPointPath: "../etc/passwd",
  }, d);

  assert.equal(result.run, undefined);
  assert.match(result.refusedBecause!, /startingPointPath/);
  assert.match(result.refusedBecause!, /escapes the workspace/);
});

test("a rollout too thin to compare on is refused", async () => {
  // Observed live — rolloutShards 1, five candidates, every one scoring exactly
  // 0.6000, the whole budget spent and nothing to tell them apart.
  const { deps: d } = deps();
  const result = await startProposedRun({
    ...proposal(),
    split: { gateShards: 8, rolloutShards: 1, seed: 0, shardRows: 20, testShards: 2, trainRows: 200 },
  }, d);

  assert.equal(result.run, undefined);
  assert.match(result.refusedBecause!, /rollout/);
});

test("a gate smaller than the rollout is refused", async () => {
  // Every candidate's score — the number the tree ranks, selects and reports on
  // — is measured on the gate alone. Real runs kept making it the *smallest* of
  // the three (gate 4 against rollout 16), which spends the measurements on the
  // split that does not decide anything.
  const { deps: d } = deps();
  const result = await startProposedRun({
    ...proposal(),
    split: { gateShards: 8, rolloutShards: 16, seed: 0, shardRows: 20, testShards: 4, trainRows: 200 },
  }, d);

  assert.equal(result.run, undefined);
  assert.match(result.refusedBecause!, /留出门/);
  assert.match(result.refusedBecause!, /最大/);
});

test("a rollout at the floor is accepted", async () => {
  const { deps: d } = deps();
  const result = await startProposedRun({
    ...proposal(),
    split: { gateShards: 8, rolloutShards: 4, seed: 0, shardRows: 20, testShards: 2, trainRows: 200 },
  }, d);

  assert.equal(result.run?.id, "run-1");
});
