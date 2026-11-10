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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import type { EvolveEventRecord, EvolveRun } from "@sciencediscovery/schema";

import type { RunStreamEvent } from "../src/api/types.js";
import {
  composeEvolveMessage,
  evolveCommand,
  evolveCommandAlgorithm,
  evolveCommandCheckpointMode,
  evolveCommandGoal,
  isEvolveCommand,
  isEvolveSkill,
  splitEvolveCommand,
} from "../src/evolve/command.js";
import {
  adoptRunStatus,
  bestCandidate,
  emptyRunView,
  evolveTargetNotice,
  evolveShortTitle,
  formatElapsed,
  formatScore,
  formatTokens,
  headlineScore,
  isPlaceholderGoal,
  reduceEvolveRecord,
  verdictOf,
  type EvolveCandidateView,
  type EvolveRunView,
} from "../src/evolve/model.js";
import { collapseContext, diffLines } from "../src/evolve/text-diff.js";
import { emptyRunStream } from "../src/run-stream/model.js";
import { reduceRunStream } from "../src/run-stream/reducer.js";

function record(sequence: number, event: EvolveEventRecord["event"]): EvolveEventRecord {
  return { createdAt: "2026-01-01T00:00:00.000Z", event, sequence };
}

/** The smallest log that produces one accepted expansion over a baseline. */
function runWithOneWinner(): EvolveRunView {
  const events: EvolveEventRecord[] = [
    record(1, { algorithm: "puct", scorecardHash: "sha256:card", type: "search_started" }),
    record(2, { baselineScore: 0.4, codeHash: "sha256:root", nodeIndex: 0, type: "seeded" }),
    record(3, {
      ancestorVisits: [{ nodeIndex: 0, visits: 1 }],
      nodeIndex: 1,
      type: "selected",
    }),
    record(4, {
      changeSummary: "Memoize the fit",
      codeHash: "sha256:a",
      depth: 1,
      nodeIndex: 1,
      parentIndex: 0,
      score: 0.55,
      valid: true,
      type: "expanded",
    }),
    record(5, { gateScore: 0.6, nodeIndex: 1, rolloutScore: 0.55, type: "evaluated" }),
    record(6, { accepted: true, nodeIndex: 1, type: "merged" }),
  ];
  return events.reduce(reduceEvolveRecord, emptyRunView());
}

test("a search's log folds into one candidate table", () => {
  const view = runWithOneWinner();
  assert.equal(view.status, "running");
  assert.equal(view.baselineScore, 0.4);
  assert.equal(view.expansions, 1);
  assert.equal(view.candidates.length, 2);
  const winner = view.candidates.find((candidate) => candidate.nodeIndex === 1);
  assert.equal(winner?.accepted, true);
  assert.equal(winner?.gateScore, 0.6);
  assert.equal(winner?.rolloutScore, 0.55);
  assert.equal(winner?.parentIndex, 0);
  assert.equal(winner?.codeHash, "sha256:a");
  assert.equal(view.rootVisits, 1);
});

test("a candidate whose expanded record has not arrived keeps its place", () => {
  const view = [
    record(1, { baselineScore: 0.2, nodeIndex: 0, type: "seeded" }),
    record(2, { gateScore: 0.9, nodeIndex: 7, type: "evaluated" }),
    record(3, {
      depth: 2,
      nodeIndex: 7,
      parentIndex: 3,
      score: 0.9,
      valid: true,
      type: "expanded",
    }),
  ].reduce(reduceEvolveRecord, emptyRunView());
  const candidate = view.candidates.find((entry) => entry.nodeIndex === 7);
  assert.equal(candidate?.gateScore, 0.9);
  assert.equal(candidate?.parentIndex, 3);
  assert.equal(candidate?.depth, 2);
});

test("the watermark makes a replayed prefix free", () => {
  const view = runWithOneWinner();
  const replayed = reduceEvolveRecord(view, record(3, {
    ancestorVisits: [{ nodeIndex: 0, visits: 99 }],
    nodeIndex: 1,
    type: "selected",
  }));
  assert.equal(replayed, view);
});

test("the headline prefers the gate score, and the baseline before any winner", () => {
  const running = runWithOneWinner();
  assert.equal(headlineScore(running), 0.6);

  const seeded = [record(1, { baselineScore: 0.25, nodeIndex: 0, type: "seeded" })]
    .reduce(reduceEvolveRecord, emptyRunView());
  assert.equal(headlineScore(seeded), 0.25);
  assert.equal(bestCandidate(seeded)?.nodeIndex, 0);
});

test("a failed candidate never wins, even above the field", () => {
  const view = [
    record(1, { baselineScore: 0.1, nodeIndex: 0, type: "seeded" }),
    record(2, {
      depth: 1,
      nodeIndex: 1,
      parentIndex: 0,
      score: null,
      valid: false,
      type: "expanded",
    }),
  ].reduce(reduceEvolveRecord, emptyRunView());
  assert.equal(bestCandidate(view)?.nodeIndex, 0);
});

test("the four verdicts stay apart", () => {
  const candidate = (over: Partial<EvolveCandidateView>): EvolveCandidateView => ({
    depth: 1,
    nodeIndex: 1,
    parentIndex: 0,
    score: 0.5,
    valid: true,
    visits: 0,
    ...over,
  });
  assert.equal(verdictOf(candidate({ accepted: true })), "accepted");
  assert.equal(verdictOf(candidate({ valid: false })), "failed");
  assert.equal(verdictOf(candidate({ category: "constraint-violated" })), "violated");
  assert.equal(verdictOf(candidate({ accepted: false })), "rejected");
});

test("a finished search keeps its stop reason, planned count and test score", () => {
  const view = [
    record(1, { baselineScore: 0.3, nodeIndex: 0, type: "seeded" }),
    record(2, {
      bestNodeIndex: 0,
      bestTestScore: 0.28,
      expansionsPlanned: 40,
      status: "budget_exhausted",
      stopReason: "budget",
      type: "search_finished",
    }),
  ].reduce(reduceEvolveRecord, emptyRunView());
  assert.equal(view.status, "budget_exhausted");
  assert.equal(view.bestTestScore, 0.28);
  assert.equal(view.expansionsPlanned, 40);
  assert.equal(view.stopReason, "budget");
});

test("a target-reached stop is not a shortfall", () => {
  const view = [
    record(1, { baselineScore: 0.3, nodeIndex: 0, type: "seeded" }),
    record(2, {
      depth: 1, nodeIndex: 1, parentIndex: 0, score: 1, type: "expanded", valid: true,
    }),
    record(3, {
      bestNodeIndex: 1,
      candidates: 2,
      expansionsPlanned: 24,
      status: "succeeded",
      stopReason: "target_reward",
      type: "search_finished",
    }),
  ].reduce(reduceEvolveRecord, emptyRunView());
  assert.deepEqual(evolveTargetNotice(view), { made: 1, planned: 24 });

  const shortfall = [
    record(1, { baselineScore: 0.3, nodeIndex: 0, type: "seeded" }),
    record(2, {
      bestNodeIndex: 0,
      candidates: 2,
      expansionsPlanned: 24,
      status: "succeeded",
      stopReason: "max_iters",
      type: "search_finished",
    }),
  ].reduce(reduceEvolveRecord, emptyRunView());
  assert.equal(evolveTargetNotice(shortfall), null);
});

test("scores, tokens and spans are written for reading, not as raw numbers", () => {
  assert.equal(formatScore(0.51234), "0.5123");
  assert.equal(formatScore(null), "—");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(12_400), "12k");
  assert.equal(formatTokens(1_234_567), "1.23M");
  assert.equal(formatElapsed(42), "42s");
  assert.equal(formatElapsed(125), "2m 05s");
  assert.equal(formatElapsed(3_720), "1h 02m");
});

test("a goal's title keeps the first sentence and cuts at the column budget", () => {
  assert.equal(evolveShortTitle("任务：让压缩比更高。其余细节。"), "让压缩比更高");
  assert.equal(evolveShortTitle("   "), "");
  const long = "这".repeat(50);
  assert.equal(evolveShortTitle(long).endsWith("…"), true);
  assert.equal(evolveShortTitle(long).length, 33);
});

test("a placeholder scorecard is recognisable", () => {
  assert.equal(isPlaceholderGoal({ scorecard: { hash: "sha256:placeholder" } }), true);
  assert.equal(isPlaceholderGoal({ scorecard: { hash: "sha256:real" } }), false);
});

test("a created search is counted as a reason to re-read the list, not as a message", () => {
  const event = {
    run: { id: "run-1" } as EvolveRun,
    type: "evolve_run.created",
  } as RunStreamEvent;
  const next = reduceRunStream(emptyRunStream(), event);
  assert.equal(next.evolveRunsCreated, 1);
  assert.equal(next.unknownEvents, 0);
  assert.equal(next.turns.length, 0);
});

test("only the skill the command names opens the setup dialog", () => {
  // `/api/skills` reports the design skill under the id the command uses, so
  // the palette pick is the same skill the composer would have written.
  assert.equal(isEvolveSkill({ id: "evolve-design" }), true);
  assert.equal(isEvolveSkill({ id: "skill-creator" }), false);
  assert.equal(isEvolveSkill({ id: "evolve-designer" }), false);
});

test("the command parses only as the first word", () => {
  assert.equal(isEvolveCommand("/evolve-design --algorithm puct fewer bytes"), true);
  assert.equal(isEvolveCommand("please /evolve-design"), false);
  assert.equal(isEvolveCommand("/evolve-designer"), false);
  assert.equal(evolveCommandGoal("/evolve-design --algorithm openevolve faster"), "faster");
  assert.equal(evolveCommandGoal("/evolve-design"), "");
  assert.equal(evolveCommandGoal("hello"), undefined);
  assert.equal(
    evolveCommand("puct", "compress better"),
    "/evolve-design --algorithm puct compress better",
  );
});

test("the pace flag is read as a flag, not as part of the goal", () => {
  // The dialog and a typed command produce the flags in the same order, but a
  // person may type them the other way round; both have to reach the agent
  // cleanly, and neither flag belongs in the goal the setup detour seeds.
  assert.equal(
    evolveCommandGoal("/evolve-design --algorithm puct --no-confirm fewer bytes"),
    "fewer bytes",
  );
  assert.equal(
    evolveCommandGoal("/evolve-design --no-confirm --algorithm openevolve faster"),
    "faster",
  );
  assert.equal(evolveCommandGoal("/evolve-design --no-confirm"), "");
  // A goal that merely mentions the phrase keeps it.
  assert.equal(
    evolveCommandGoal("/evolve-design explain --no-confirm elsewhere"),
    "explain --no-confirm elsewhere",
  );

  assert.equal(evolveCommandCheckpointMode("/evolve-design --no-confirm faster"), "auto");
  assert.equal(evolveCommandCheckpointMode("/evolve-design faster"), "confirm");
  assert.equal(evolveCommandCheckpointMode("hello"), undefined);

  assert.equal(evolveCommandAlgorithm("/evolve-design --algorithm openevolve faster"), "openevolve");
  assert.equal(evolveCommandAlgorithm("/evolve-design --no-confirm --algorithm puct faster"), "puct");
  // A goal that mentions the flag keeps it as text, and text is not a choice.
  assert.equal(evolveCommandAlgorithm("/evolve-design explain --algorithm openevolve"), undefined);
  assert.equal(evolveCommandAlgorithm("/evolve-design faster"), undefined);
  assert.equal(evolveCommandAlgorithm("hello"), undefined);

  assert.equal(
    evolveCommand("openevolve", "faster", "auto"),
    "/evolve-design --algorithm openevolve --no-confirm faster",
  );
  assert.equal(
    evolveCommand("puct", "faster", "confirm"),
    "/evolve-design --algorithm puct faster",
  );
});

test("a goal that starts with a flag keeps its own text", () => {
  // The dialog hands the goal to the command, and the setup detour reads it
  // back: a goal whose first word is a flag must not flip the pace or lose
  // that word. The line break the command writes is what ends its flags.
  const command = evolveCommand("puct", "--no-confirm 是守护进程的参数，不是节奏开关");
  assert.equal(
    command,
    "/evolve-design --algorithm puct\n--no-confirm 是守护进程的参数，不是节奏开关",
  );
  assert.equal(evolveCommandGoal(command), "--no-confirm 是守护进程的参数，不是节奏开关");
  assert.equal(evolveCommandCheckpointMode(command), "confirm");

  // The dialog's own pace is still read from the flags it wrote.
  const auto = evolveCommand("puct", "--algorithm is the goal here", "auto");
  assert.equal(evolveCommandCheckpointMode(auto), "auto");
  assert.equal(evolveCommandGoal(auto), "--algorithm is the goal here");

  // A typed goal that merely mentions a flag on one line keeps it too — and
  // mentioning it is not the same as carrying it.
  assert.equal(
    evolveCommandGoal("/evolve-design explain --allow-direct elsewhere"),
    "explain --allow-direct elsewhere",
  );
});

test("a command placed in the composer splits into the token and the sentence", () => {
  // The dialog's message is not sent: its flags become a token in the input
  // and its goal becomes the first draft after it.
  assert.deepEqual(
    splitEvolveCommand("/evolve-design --algorithm openevolve --no-confirm 让压缩比更高"),
    { command: "/evolve-design --algorithm openevolve --no-confirm", goal: "让压缩比更高" },
  );
  assert.deepEqual(
    splitEvolveCommand("/evolve-design --algorithm puct --allow-direct"),
    { command: "/evolve-design --algorithm puct --allow-direct", goal: "" },
  );
  // The token and the sentence rejoin into the same message, including the
  // line break that keeps a flag-looking goal from being read as a flag.
  const split = splitEvolveCommand("/evolve-design --algorithm puct --no-confirm 更少字节");
  assert.equal(composeEvolveMessage(split.command, split.goal), "/evolve-design --algorithm puct --no-confirm 更少字节");
  assert.equal(
    composeEvolveMessage("/evolve-design --algorithm puct", "--no-confirm 是参数"),
    "/evolve-design --algorithm puct\n--no-confirm 是参数",
  );
});

test("the direct-execution flag is a flag, not part of the goal", () => {
  // The dialog writes it only after the warning is answered, so the client
  // never reads it back as an approval; it is still flags, not goal text, and
  // the detour carries the goal without it.
  assert.equal(
    evolveCommandGoal("/evolve-design --algorithm puct --allow-direct fewer bytes"),
    "fewer bytes",
  );
  // A goal that merely mentions the phrase keeps it.
  assert.equal(
    evolveCommandGoal("/evolve-design explain --allow-direct elsewhere"),
    "explain --allow-direct elsewhere",
  );

  assert.equal(
    evolveCommand("puct", "faster", "confirm", true),
    "/evolve-design --algorithm puct --allow-direct faster",
  );
  assert.equal(
    evolveCommand("openevolve", "faster", "auto", true),
    "/evolve-design --algorithm openevolve --no-confirm --allow-direct faster",
  );
  // Off by default: only the dialog's switch writes it.
  assert.equal(evolveCommand("puct", "faster"), "/evolve-design --algorithm puct faster");
});

test("the diff shows an insertion as an insertion, not as a rewritten file", () => {
  const rows = diffLines("a\nb\nc", "a\nnew\nb\nc");
  assert.deepEqual(
    rows.map((row) => [row.kind, row.text]),
    [["context", "a"], ["added", "new"], ["context", "b"], ["context", "c"]],
  );
  assert.equal(rows[1]?.rightLine, 2);
  assert.equal(rows[2]?.leftLine, 2);
});

test("a run whose stream ended without an event still learns it failed", () => {
  // A failed run used to keep showing 运行中: its error banner came from the
  // run record the cards poll, but the header only ever read statuses off
  // events, and a run the control plane settles emits no terminal event.
  const running = { ...emptyRunView(), status: "running" as const };
  const failed = adoptRunStatus(running, "failed");
  assert.equal(failed.status, "failed");
  assert.notEqual(failed, running, "the record's status wins");
  // Nothing new is nothing to redraw: the panel re-renders on every poll.
  assert.equal(adoptRunStatus(failed, "failed"), failed);
});

test("an empty before-side reads as all new", () => {
  const rows = diffLines("", "x\ny");
  assert.deepEqual(rows.map((row) => row.kind), ["added", "added"]);
});

test("context folding keeps the changed rows and their neighbours", () => {
  const before = Array.from({ length: 20 }, (_unused, at) => `line ${at}`).join("\n");
  const after = before.replace("line 10", "line ten");
  const folded = collapseContext(diffLines(before, after), 1);
  assert.equal(folded.hidden, 17);
  assert.deepEqual(
    folded.rows.map((row) => row.text),
    ["line 9", "line 10", "line ten", "line 11"],
  );
});
