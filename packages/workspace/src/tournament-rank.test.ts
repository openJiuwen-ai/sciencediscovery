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
import test from "node:test";

import {
  computeDivergence,
  eloTournament,
  rankFromVerdicts,
  tokenizeForDivergence,
} from "./tournament-rank.js";

test("eloTournament: round-robin ranks a dominant item first", async () => {
  // "a" beats everything, "b" beats "c", ties nowhere.
  const wins: Record<string, number> = { "a:b": 1, "a:c": 1, "b:c": 1 };
  const ranked = await eloTournament(["a", "b", "c"], async (x, y) => wins[`${x}:${y}`] ?? 0);
  assert.deepEqual(ranked.map((entry) => entry.item), ["a", "b", "c"]);
  assert.equal(ranked[0]!.matches, 2);
  assert.equal(ranked[0]!.winRate, 1);
  assert.equal(ranked[2]!.winRate, 0);
  // Dominant item gains Elo, weakest loses it.
  assert.ok(ranked[0]!.elo > 1000);
  assert.ok(ranked[2]!.elo < 1000);
});

test("eloTournament: exact arithmetic — one decisive win from equal ratings", async () => {
  // K=32, both at 1000 → expected 0.5 → winner 1000 + 32*(1-0.5) = 1016,
  // loser 1000 - 16 = 984. Pins the update formula against sign/factor errors.
  const ranked = await eloTournament(["w", "l"], async () => 1);
  assert.equal(ranked[0]!.item, "w");
  assert.equal(ranked[0]!.elo, 1016);
  assert.equal(ranked[1]!.elo, 984);
});

test("eloTournament: a tie increments matches but credits no win", async () => {
  // a beats b, a ties c → a's winRate is 1/2, not 1.
  const verdicts: Record<string, number> = { "a:b": 1, "a:c": 0.5, "b:c": 0.5 };
  const ranked = await eloTournament(["a", "b", "c"], async (x, y) => verdicts[`${x}:${y}`] ?? 0);
  const a = ranked.find((entry) => entry.item === "a")!;
  assert.equal(a.matches, 2);
  assert.equal(a.winRate, 0.5);
});

test("eloTournament: all ties keep everyone at the initial rating", async () => {
  const ranked = await eloTournament(["x", "y", "z"], async () => 0.5);
  for (const entry of ranked) assert.equal(entry.elo, 1000);
  for (const entry of ranked) assert.equal(entry.winRate, 0);
});

test("rankFromVerdicts: orientation-free pairs, missing pairs become counted ties", async () => {
  const result = await rankFromVerdicts(
    ["alpha", "beta", "gamma"],
    [
      // Reversed orientation: beta's score against alpha = 0 → alpha beats beta.
      { a: "beta", b: "alpha", scoreA: 0 },
      { a: "alpha", b: "gamma", scoreA: 1 },
      // beta vs gamma intentionally missing → auto tie.
    ],
  );
  assert.equal(result.totalPairs, 3);
  assert.equal(result.judgedPairs, 2);
  assert.equal(result.autoTies, 1);
  assert.equal(result.duplicatePairs, 0);
  assert.equal(result.ranking[0]!.item, "alpha");
});

test("rankFromVerdicts: duplicate pair — later submission wins, counted", async () => {
  const result = await rankFromVerdicts(
    ["a", "b"],
    [
      { a: "a", b: "b", scoreA: 1 },
      { a: "b", b: "a", scoreA: 1 }, // reversed duplicate: now b beats a
    ],
  );
  assert.equal(result.duplicatePairs, 1);
  assert.equal(result.ranking[0]!.item, "b");
});

test("rankFromVerdicts: rejects unknown items, self-pairs, bad scores, dup labels", async () => {
  await assert.rejects(() => rankFromVerdicts(["a"], []), /at least 2/);
  await assert.rejects(() => rankFromVerdicts(["a", "a"], []), /duplicate/);
  await assert.rejects(
    () => rankFromVerdicts(["a", "b"], [{ a: "a", b: "zzz", scoreA: 1 }]),
    /not in items/,
  );
  await assert.rejects(
    () => rankFromVerdicts(["a", "b"], [{ a: "a", b: "a", scoreA: 1 }]),
    /self-pair/,
  );
  await assert.rejects(
    () => rankFromVerdicts(["a", "b"], [{ a: "a", b: "b", scoreA: 1.5 }]),
    /\[0,1\]/,
  );
});

test("computeDivergence: identical texts converge, disjoint texts diverge", async () => {
  assert.equal(computeDivergence(["hello world", "hello world"]), 0);
  assert.equal(computeDivergence(["alpha beta", "gamma delta"]), 1);
  assert.equal(computeDivergence(["single"]), 0);
});

test("tokenizeForDivergence: CJK runs fall back to char bigrams", async () => {
  // A whitespace-free Chinese sentence longer than 8 chars must not collapse
  // into one giant token (DA review finding M2).
  const tokens = tokenizeForDivergence("这是一个没有空白的中文句子用于测试");
  assert.ok(tokens.length > 5);
  assert.ok(tokens.every((token) => token.length === 2));
  // Mixed text keeps short words intact.
  assert.deepEqual(tokenizeForDivergence("hi there"), ["hi", "there"]);
});
