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
  trailingAutoStep,
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

test("an untagged code block in the body does not end the card early", () => {
  // Observed in a live run: the model opened a bare fence inside the card and
  // never wrote the card's own close. The first bare fence used to become the
  // card's end, so the field list leaked out as prose and the text after it
  // was swallowed by an unterminated code block.
  const answer = [
    "说明。",
    "",
    "```evolve-checkpoint",
    "step: 3",
    "total: 4",
    "pace: confirm",
    "title: 启动前的字段清单",
    "---",
    "**字段：**",
    "",
    "```",
    "mode: confirm",
    "risks: []",
    "```",
    "",
    "**两处要你裁决：**",
    "",
    "回复即可。",
  ].join("\n");

  const segments = splitEvolveCheckpoints(answer);
  assert.deepEqual(segments.map((segment) => segment.kind), ["markdown", "checkpoint", "markdown"]);
  const checkpoint = segments[1]!;
  if (checkpoint.kind !== "checkpoint") return;
  assert.match(checkpoint.checkpoint.body, /mode: confirm/);
  // The lines after the block are the reader's again, as Markdown rather than
  // as the inside of a code fence.
  const tail = segments[2]!;
  if (tail.kind !== "markdown") return;
  assert.match(tail.text, /\*\*两处要你裁决：\*\*\n\n回复即可。$/);
  // The card did not eat the fence that closed its body's block.
  assert.doesNotMatch(tail.text, /mode: confirm/);
});

test("a tagged code block in the body stays inside the card", () => {
  const answer = card(
    ["step: 2", "total: 4"],
    ["**字段：**", "", "```text", "mode: confirm", "```", "", "**答复：** 好"].join("\n"),
  );

  const segments = splitEvolveCheckpoints(answer);
  assert.deepEqual(segments.map((segment) => segment.kind), ["checkpoint"]);
  const checkpoint = segments[0]!;
  if (checkpoint.kind !== "checkpoint") return;
  assert.match(checkpoint.checkpoint.body, /\*\*答复：\*\* 好$/);
});

test("a tagged block the model never closed keeps the card around it", () => {
  // Observed in a live run: the body opened a ```yaml block and then used the
  // card's own fence to end it, so no fence was left at depth zero. Treating
  // the message as prose dropped the card entirely.
  const answer = [
    "所以重发第 3 步。",
    "",
    "```evolve-checkpoint",
    "step: 3",
    "total: 4",
    "pace: confirm",
    "title: 修订：评测器改用固定种子复刻数据",
    "---",
    "**为什么改：** 评测器读不到文件。",
    "",
    "```yaml",
    "mode: custom_script",
    "expansions: 24",
    "```",
    "",
    "预算不变：24 次。",
  ].join("\n");

  const segments = splitEvolveCheckpoints(answer);
  assert.deepEqual(segments.map((segment) => segment.kind), ["markdown", "checkpoint", "markdown"]);
  const checkpoint = segments[1]!;
  if (checkpoint.kind !== "checkpoint") return;
  assert.match(checkpoint.checkpoint.body, /mode: custom_script/);
  const tail = segments[2]!;
  if (tail.kind !== "markdown") return;
  assert.match(tail.text, /预算不变：24 次。$/);
});

test("a turn that ends on an auto card is one the client carries forward", () => {
  // `--no-confirm`: the skill says go on, and the model ends the turn on the
  // card anyway. The card has no buttons, so without this the design stops at
  // step 1 with nothing to press.
  const answer = ["第 1 步做完了。", "", card(["step: 1", "total: 4", "pace: auto"], "度量……")].join("\n");
  assert.deepEqual(trailingAutoStep(answer), { step: 1, total: 4 });
});

test("nothing is carried forward when the turn ended for a reason", () => {
  // A confirm card is waiting for the reader, not for the client.
  const confirm = card(["step: 2", "total: 4", "pace: confirm"], "度量……");
  assert.equal(trailingAutoStep(confirm), undefined);
  // The last step's card reports a search that is already running.
  const final = card(["step: 4", "total: 4", "pace: auto"], "探针结果……");
  assert.equal(trailingAutoStep(final), undefined);
  // Prose after the card means the model did not end on it.
  assert.equal(trailingAutoStep(`${card(["step: 1", "total: 4", "pace: auto"], "度量……")}\n\n还有一句。`), undefined);
  // And an answer with no card at all is an ordinary conversation.
  assert.equal(trailingAutoStep("普通回答。"), undefined);
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
