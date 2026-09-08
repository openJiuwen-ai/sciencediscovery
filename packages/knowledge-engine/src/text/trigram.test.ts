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

import { test } from "node:test";
import assert from "node:assert/strict";

import { rankByTrigram, trigramSimilarity, trigrams } from "./trigram.js";

void test("identical strings score 1", () => {
  assert.equal(trigramSimilarity("ebola virus", "ebola virus"), 1);
  assert.equal(trigramSimilarity("GP", "GP"), 1);
});

void test("case is ignored", () => {
  assert.equal(trigramSimilarity("Ebola Virus", "ebola virus"), 1);
});

void test("punctuation variants score 1 (pg_trgm word-splitting semantics)", () => {
  // pg_trgm splits on non-alphanumerics and pads each word separately, so
  // these pairs have IDENTICAL trigram sets. Biomedical names are full of
  // hyphens/commas — whole-string padding scored these 0.29-0.33 instead.
  assert.equal(trigramSimilarity("SARS-CoV-2", "SARS CoV 2"), 1);
  assert.equal(trigramSimilarity("GP1,2", "GP1.2"), 1);
});

void test("empty strings are dissimilar", () => {
  assert.equal(trigramSimilarity("", ""), 0);
  assert.equal(trigramSimilarity("ebola", ""), 0);
  assert.equal(trigramSimilarity("", "ebola"), 0);
});

void test("singular/plural variants land in the pg_trgm 0.85-0.88 band", () => {
  // Measured on the DeepAnalyze PostgreSQL deployment (pg_trgm): singular/
  // plural entity-name variants score ≈ 0.85–0.88. The JS port must
  // reproduce that band so the ported thresholds keep their meaning.
  const score = trigramSimilarity("lasso peptide", "lasso peptides");
  assert.ok(score >= 0.8 && score <= 0.92, `expected 0.80-0.92, got ${score}`);
});

void test("abbreviation vs full name stays far below the decision line", () => {
  // pg_trgm measured ≈ 0.05 for abbreviation↔full-name pairs — trigram alone
  // must NOT merge these (alias/LLM layers handle them).
  const score = trigramSimilarity("EBOV", "ebola virus");
  assert.ok(score < 0.3, `expected < 0.3, got ${score}`);
});

void test("unrelated strings score near zero", () => {
  assert.ok(trigramSimilarity("ebola virus", "perovskite solar cell") < 0.15);
});

void test("rankByTrigram filters by threshold and sorts descending", () => {
  const candidates = ["ebola virus", "ebola viruses", "marburg virus", "zebra"];
  const ranked = rankByTrigram("ebola virus", candidates, (value) => value, { threshold: 0.3 });
  assert.equal(ranked[0]?.item, "ebola virus");
  assert.equal(ranked[0]?.score, 1);
  assert.ok(ranked[1]?.item === "ebola viruses");
  assert.ok(!ranked.some((entry) => entry.item === "zebra"));
});

void test("rankByTrigram respects topK", () => {
  const candidates = ["aaaa", "aaab", "aabb", "abbb"];
  const ranked = rankByTrigram("aaaa", candidates, (value) => value, { topK: 2 });
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0]?.item, "aaaa");
});

void test("trigrams pads each word with two leading and one trailing space", () => {
  // "ab" → word "ab" padded = "  ab " → grams {"  a", " ab", "ab "}
  assert.deepEqual([...trigrams("ab")].sort(), ["  a", " ab", "ab "]);
  // Multi-word: no cross-word grams ("ab cd" must not contain "b c").
  const grams = trigrams("ab cd");
  assert.ok(!grams.has("b c"));
  assert.ok(grams.has(" cd"));
});
