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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import {
  buildGrowDirectives,
  formatDirectivesForPrompt,
  NARROW_PATCH_QUERY_CAP,
} from "./directives.js";

const emptyCounts = { total: 0, pending: 0, done: 0, failed: 0, skipped: 0 };

void test("buildGrowDirectives deprioritizes sources with high failure rates", () => {
  const directives = buildGrowDirectives({
    counts: { ...emptyCounts, total: 12, done: 2, failed: 10 },
    sources: [
      // 9/10 failures — clearly dead.
      { source: "backward_citation", items: 10, done: 1, failed: 9, skipped: 0, encounters: 10 },
      // Below the minimum encounter count — no verdict.
      { source: "forward_citation", items: 2, done: 0, failed: 2, skipped: 0, encounters: 2 },
    ],
    duplicates: 0,
    converged: false,
  });
  const deprioritized = directives.filter((directive) => directive.kind === "deprioritize-source");
  assert.equal(deprioritized.length, 1);
  assert.match(deprioritized[0]!.text, /Deprioritize backward_citation: 9\/10 attempted/);
});

void test("buildGrowDirectives failure verdicts ignore never-attempted skipped candidates", () => {
  // 90 skipped items must neither dilute the failure rate nor be worded as
  // "resolved no full text" — only the 10 attempted items carry a verdict.
  const directives = buildGrowDirectives({
    counts: { ...emptyCounts, total: 100, done: 1, failed: 9, skipped: 90 },
    sources: [{ source: "entity_query", items: 100, done: 1, failed: 9, skipped: 90, encounters: 100 }],
    duplicates: 0,
    converged: false,
  });
  const deprioritized = directives.filter((directive) => directive.kind === "deprioritize-source");
  assert.equal(deprioritized.length, 1);
  assert.match(deprioritized[0]!.text, /9\/10 attempted candidates failed to reach full text/);
});

void test("buildGrowDirectives narrows patch queries under dedup saturation", () => {
  const directives = buildGrowDirectives({
    counts: { ...emptyCounts, total: 4, done: 4 },
    sources: [{ source: "backward_citation", items: 4, done: 4, failed: 0, skipped: 0, encounters: 4 }],
    duplicates: 8, // 8/(8+4) = 0.67 re-find rate
    converged: false,
  });
  const narrow = directives.find((directive) => directive.kind === "narrow-queries");
  assert.ok(narrow);
  assert.equal(narrow.patchQueryCap, NARROW_PATCH_QUERY_CAP);
  assert.match(narrow.text, /8 of 12 encounters were re-finds/);
});

void test("buildGrowDirectives broadens when the frontier exhausts without saturation", () => {
  const directives = buildGrowDirectives({
    counts: { ...emptyCounts, total: 12, done: 12 },
    sources: [{ source: "backward_citation", items: 12, done: 12, failed: 0, skipped: 0, encounters: 13 }],
    duplicates: 1,
    converged: false,
  });
  const broaden = directives.find((directive) => directive.kind === "broaden-queries");
  assert.ok(broaden);
  assert.match(broaden.text, /broaden entity patch queries/);
  assert.equal(broaden.patchQueryCap, undefined);
  // Converged cycles never ask for breadth.
  const convergedRun = buildGrowDirectives({
    counts: { ...emptyCounts, total: 12, done: 12 },
    sources: [],
    duplicates: 1,
    converged: true,
  });
  assert.ok(convergedRun.some((directive) => directive.kind === "converged-hold"));
  assert.ok(!convergedRun.some((directive) => directive.kind === "broaden-queries"));
});

void test("buildGrowDirectives stays silent on an unremarkable cycle", () => {
  const directives = buildGrowDirectives({
    counts: { ...emptyCounts, total: 6, done: 5, failed: 1 },
    sources: [{ source: "backward_citation", items: 6, done: 5, failed: 1, skipped: 0, encounters: 7 }],
    duplicates: 1,
    converged: false,
  });
  assert.deepEqual(directives, []);
});

void test("formatDirectivesForPrompt renders an injectable block", () => {
  assert.equal(formatDirectivesForPrompt([]), "");
  const block = formatDirectivesForPrompt(buildGrowDirectives({
    counts: emptyCounts,
    sources: [],
    duplicates: 0,
    converged: true,
  }));
  assert.match(block, /^GROWTH DIRECTIVES/);
  assert.match(block, /- Convergence signals fired/);
});
