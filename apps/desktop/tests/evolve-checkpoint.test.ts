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
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";

import {
  parseEvolveCheckpoint,
  splitEvolveCheckpoints,
} from "../src/evolve/checkpoint.js";

/** A checkpoint as the skill writes it: a short header, a rule, then prose. */
function card(lines: readonly string[], body: string): string {
  return ["```evolve-checkpoint", ...lines, "---", body, "```"].join("\n");
}

test("a checkpoint block becomes a card, and the prose around it stays prose", () => {
  const answer = [
    "先说结论。",
    "",
    card(
      ["step: 1", "total: 4", "pace: confirm", "title: 什么算“更好”"],
      "**度量：** 压缩比\n\n**冻结：** 不许用现成库",
    ),
  ].join("\n");

  const segments = splitEvolveCheckpoints(answer);
  assert.equal(segments.length, 2);
  const [prose, checkpoint] = segments;
  assert.equal(prose!.kind, "markdown");
  if (prose!.kind !== "markdown") return;
  assert.equal(prose!.text, "先说结论。\n");
  assert.equal(checkpoint!.kind, "checkpoint");
  if (checkpoint!.kind !== "checkpoint") return;
  assert.deepEqual(checkpoint!.checkpoint, {
    body: "**度量：** 压缩比\n\n**冻结：** 不许用现成库",
    pace: "confirm",
    step: 1,
    title: "什么算“更好”",
    total: 4,
  });
});

test("a block the model tagged with the skill's name is still a card", () => {
  // Observed in a live run: the model wrote the fence as `evolve-design`,
  // the skill's own name, and the card rendered as a code block instead.
  const answer = ["```evolve-design", "step: 1", "total: 4", "---", "**度量：** 压缩比", "```"].join("\n");

  const segments = splitEvolveCheckpoints(answer);
  assert.deepEqual(segments.map((segment) => segment.kind), ["checkpoint"]);
});

test("an absent pace is a checkpoint that waits, and an absent total prints the step alone", () => {
  const parsed = parseEvolveCheckpoint(["step: 2", "---", "只有一句话"].join("\n"));
  assert.deepEqual(parsed, { body: "只有一句话", pace: "confirm", step: 2, title: undefined });
});

test("auto is the one pace the card can record", () => {
  const parsed = parseEvolveCheckpoint(
    ["step: 3", "total: 4", "pace: auto", "---", "…"].join("\n"),
  );
  assert.equal(parsed?.pace, "auto");
});

test("a title is enough on its own, and it may be the only card content", () => {
  const parsed = parseEvolveCheckpoint(["step: 4", "title: 启动"].join("\n"));
  assert.deepEqual(parsed, { body: "", pace: "confirm", step: 4, title: "启动" });
});

test("a malformed card stays in the answer as a code block instead of disappearing", () => {
  const broken = card(["step: one"], "…");
  const answer = `一段说明\n\n${broken}\n\n后面还有话。`;

  const segments = splitEvolveCheckpoints(answer);
  assert.equal(segments.length, 1);
  assert.equal(segments[0]!.kind, "markdown");
  if (segments[0]!.kind !== "markdown") return;
  assert.equal(segments[0]!.text, answer);
});

test("a fence that has not finished streaming is prose, not a half card", () => {
  const streaming = [
    "正在总结。",
    "",
    "```evolve-checkpoint",
    "step: 1",
    "title: 什么算“更好”",
    "---",
    "还没有写完",
  ].join("\n");

  const segments = splitEvolveCheckpoints(streaming);
  assert.equal(segments.length, 1);
  assert.equal(segments[0]!.kind, "markdown");
  if (segments[0]!.kind !== "markdown") return;
  assert.equal(segments[0]!.text, streaming);
});

test("a fence with no info string is an ordinary code block", () => {
  const answer = "```\nstep: 1\n```";
  const segments = splitEvolveCheckpoints(answer);
  assert.equal(segments.length, 1);
  assert.equal(segments[0]!.kind, "markdown");
});

test("two cards in one answer keep their order and their own steps", () => {
  const answer = [
    card(["step: 1", "total: 4"], "第一步"),
    "",
    "中间的说明。",
    "",
    card(["step: 2", "total: 4"], "第二步"),
  ].join("\n");

  const segments = splitEvolveCheckpoints(answer);
  assert.deepEqual(
    segments.map((segment) => (segment.kind === "checkpoint" ? segment.checkpoint.step : "prose")),
    [1, "prose", 2],
  );
});
