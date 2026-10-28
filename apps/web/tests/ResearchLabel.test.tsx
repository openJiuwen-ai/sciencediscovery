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


import { compactStatus, evidencePreview, isExploration, reasoningStatus, reportedFailure, researchLabel, returnedPaperCount } from "../src/timeline/research-label.js";

test("research labels promote only short explicit fields and tolerate legacy input", () => {
  assert.equal(researchLabel({ name: "task", args: { description: " ", query: " CRISPR\n SCD " } }), "CRISPR SCD");
  assert.equal(researchLabel({ name: "task", input: '{"description":"Clinical evidence"}' }), "Clinical evidence");
  for (const input of [undefined, "legacy prompt", "null", "{}", '{"description":3}', '{"query":" "}']) {
    assert.equal(researchLabel({ name: "task", input }), "task");
  }
  assert.equal(compactStatus("x".repeat(161)), "x".repeat(157) + "…");
  assert.equal(compactStatus("x".repeat(160)), "x".repeat(160));
});

test("evidence previews retain bounded head and tail without promoting reasoning prose", () => {
  assert.equal(evidencePreview("a\nb\nc\nd\ne"), "a\nb\nc\nd\ne");
  assert.equal(evidencePreview("a\nb\nc\nd\ne\nf"), "a\nb\n…\ne\nf");
  const long = "h".repeat(100) + "t".repeat(100);
  assert.equal(evidencePreview(long), "h".repeat(80) + "…" + "t".repeat(77));
  assert.equal(reasoningStatus("private prose"), undefined);
  assert.equal(reasoningStatus("**Searching**\nprivate\n### Synthesizing 5 papers"), "Synthesizing 5 papers");
  assert.equal(reasoningStatus("**Searching**"), "Searching");
  assert.equal(reportedFailure("ordinary result\n Permission denied: connector"), "Permission denied: connector");
  assert.equal(reportedFailure("Paper about error correction"), undefined);
  assert.equal(isExploration("mcp.search_pubmed"), true);
  assert.equal(isExploration("research_task"), false);
});

test("paper counts use returned search records and reject estimates and other tools", () => {
  for (const sourceId of ["arxiv", "pubmed", "europe-pmc"]) {
    assert.equal(returnedPaperCount(JSON.stringify({ sourceId, toolId: "search", records: [], total: 1000 })), 0);
    assert.equal(returnedPaperCount(JSON.stringify({ sourceId, toolId: "search", records: [{}, {}] })), 2);
  }
  for (const value of ["invalid", "null", "{}", '{"sourceId":"other","toolId":"search","records":[]}', '{"sourceId":"pubmed","toolId":"read","records":[]}', '{"sourceId":"pubmed","toolId":"search","records":5}']) {
    assert.equal(returnedPaperCount(value), undefined);
  }
});
