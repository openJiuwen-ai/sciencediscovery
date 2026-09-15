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

import {
  cosineScan,
  cosineSimilarity,
  embeddingFromBlob,
  embeddingToBlob,
} from "./cosine-scan.js";

void test("identical vectors score 1", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
});

void test("orthogonal vectors score 0", () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

void test("opposite vectors score -1", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 1], [-1, -1]) + 1) < 1e-9);
});

void test("zero vectors score 0 instead of NaN", () => {
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  assert.equal(cosineSimilarity([], []), 0);
});

void test("mismatched lengths score 0", () => {
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
});

void test("cosineScan ranks by score and respects topK", () => {
  const items = [
    { item: "far", embedding: [0, 1] },
    { item: "near", embedding: [0.9, 0.1] },
    { item: "same", embedding: [1, 0] },
  ];
  const ranked = cosineScan([1, 0], items, { topK: 2 });
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0]?.item, "same");
  assert.equal(ranked[1]?.item, "near");
});

void test("cosineScan applies threshold", () => {
  const items = [
    { item: "high", embedding: [1, 0] },
    { item: "low", embedding: [0, 1] },
  ];
  const ranked = cosineScan([1, 0], items, { threshold: 0.5 });
  assert.deepEqual(ranked.map((entry) => entry.item), ["high"]);
});

void test("embedding blob round-trip preserves values", () => {
  const source = new Float32Array([0.1, -2.5, 3.75, 1024]);
  const blob = embeddingToBlob(source);
  const restored = embeddingFromBlob(blob);
  assert.equal(restored.length, 4);
  for (let index = 0; index < source.length; index += 1) {
    assert.equal(restored[index], source[index]);
  }
});

void test("embedding blob round-trip works from plain arrays", () => {
  const blob = embeddingToBlob([1.5, 2.5]);
  const restored = embeddingFromBlob(blob);
  assert.deepEqual([...restored], [1.5, 2.5]);
});