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

import assert from "node:assert/strict";
import test from "node:test";

import type { ScientificArtifactVersion } from "@sciencediscovery/schema";

import {
  SMART_CITATION_REVIEW_INSTRUCTIONS,
  citationSourceSnapshot,
  citationSourceUrl,
  offlineCitationPrecheck,
  hasExplicitLiteratureCitation,
  parseSmartCitationReview,
  reviewerSpecialistAvailable,
  reviewerSpecialistRequested,
} from "./citation-review.js";

const semanticVersion = {
  artifactId: "artifact-1",
  content: { hash: "hash", size: 1 },
  createdAt: "2026-08-05T00:00:00.000Z",
  executionRunIds: [],
  id: "version-1",
  inputArtifactVersionIds: [],
  mediaType: "text/markdown",
  projectId: "project-1",
  sessionId: "session-1",
  version: 1,
} satisfies ScientificArtifactVersion;

test("Reviewer Specialist is disabled unless explicitly named", () => {
  assert.equal(reviewerSpecialistRequested("Create a cited report."), false);
  assert.equal(reviewerSpecialistRequested("请调用 Reviewer Specialist 审核报告。"), true);
  assert.equal(reviewerSpecialistRequested("run reviewer-specialist"), true);
});

test("Reviewer Specialist requires both the system switch and an explicit request", () => {
  assert.equal(reviewerSpecialistAvailable(false, "请调用 Reviewer Specialist 审核报告。"), false);
  assert.equal(reviewerSpecialistAvailable(true, "Create a cited report."), false);
  assert.equal(reviewerSpecialistAvailable(true, "请调用 Reviewer Specialist 审核报告。"), true);
});

test("offline MVP accepts a recognizable citation identifier", () => {
  const result = offlineCitationPrecheck(
    Buffer.from("Transformers use attention [1].\n[1] Vaswani et al., 2017. arXiv:1706.03762"),
    "version-1",
  );
  assert.equal(result.decision, "ACCEPT_AND_PROCEED");
  assert.deepEqual(result.findings, []);
});

test("offline MVP reports a source without an inline citation marker", () => {
  const result = offlineCitationPrecheck(
    Buffer.from("Transformers use attention.\nSource identifier: arXiv:1706.03762"),
    "version-1",
  );
  assert.equal(result.decision, "REVISE_AND_RETRY");
  assert.equal(result.findings[0]?.code, "CITATION_MARKER_MISSING");
});

test("Deep citation candidate requires an explicit literature reference", () => {
  assert.equal(hasExplicitLiteratureCitation("Claim supported by [1].\n[1] Author et al., 2024."), true);
  assert.equal(hasExplicitLiteratureCitation("A graph Evidence marker [ev1] is present."), false);
});

test("Quick citation review accepts a standard author-year citation without requiring a persistent identifier", () => {
  const result = offlineCitationPrecheck(
    Buffer.from("Treatment improved survival (Doe et al., 2024)."),
    "version-1",
  );
  assert.equal(result.decision, "ACCEPT_AND_PROCEED");
  assert.deepEqual(result.findings, []);
});

test("Quick citation review accepts Markdown footnotes and Chinese numeric markers", () => {
  const footnote = offlineCitationPrecheck(
    Buffer.from("Transformers use attention.[^vaswani]\n\n[^vaswani]: Vaswani et al. Attention Is All You Need, 2017."),
    "version-1",
  );
  assert.equal(footnote.decision, "ACCEPT_AND_PROCEED");

  const chinese = offlineCitationPrecheck(
    Buffer.from("该方法使用注意力机制【1】。\n\n参考文献\n[1] Vaswani 等，Attention Is All You Need，2017。"),
    "version-1",
  );
  assert.equal(chinese.decision, "ACCEPT_AND_PROCEED");
});

test("Quick citation review accepts an Evidence chip as an inline marker", () => {
  const result = offlineCitationPrecheck(
    Buffer.from("The reported result is supported by graph evidence [ev1].\nDOI: 10.1000/example"),
    "version-1",
  );
  assert.equal(result.findings.some((finding) => finding.code === "CITATION_MARKER_MISSING"), false);
});

test("Quick citation review reports only obvious dangling or unfinished references", () => {
  const dangling = offlineCitationPrecheck(
    Buffer.from("Transformers use attention.[^missing]"),
    "version-1",
  );
  assert.equal(dangling.findings[0]?.code, "CITATION_REFERENCE_MISSING");

  const unfinished = offlineCitationPrecheck(
    Buffer.from("Transformers use attention [1].\n[1] Vaswani et al. DOI: TODO"),
    "version-1",
  );
  assert.equal(unfinished.findings[0]?.code, "CITATION_IDENTIFIER_MISSING");
});

test("offline MVP skips content without a literature citation", () => {
  const result = offlineCitationPrecheck(Buffer.from("The analysis is complete."), "version-1");
  assert.equal(result.decision, "SKIPPED");
});

test("Deep citation review validates Citation findings inside the Citation capability", () => {
  const result = parseSmartCitationReview({
    findings: [{
      code: "CITATION_CLAIM_NOT_SUPPORTED",
      evidenceAliases: ["ev1", "unknown"],
      message: "The verified source contradicts the Artifact claim.",
      severity: "warning",
    }],
    status: "COMPLETED",
  }, semanticVersion, new Set(["ev1"]));

  assert.equal(result.inconclusive, false);
  assert.equal(result.findings[0]?.code, "CITATION_CLAIM_NOT_SUPPORTED");
  assert.deepEqual(result.findings[0]?.evidenceRefs, ["artifact:version-1", "evidence-alias:ev1"]);
});

test("Deep citation discards model identifier findings without an exact verified source", () => {
  const result = parseSmartCitationReview({
    findings: [{
      code: "CITATION_IDENTIFIER_NOT_RESOLVED",
      evidenceAliases: [],
      message: "A ranked search result did not match the target PMID.",
      severity: "critical",
    }],
    status: "COMPLETED",
  }, semanticVersion, new Set());

  assert.deepEqual(result.findings, []);
  assert.equal(result.inconclusive, true);
});

test("Deep Citation protocol verifies paper identity before lightweight claim support", () => {
  assert.match(SMART_CITATION_REVIEW_INSTRUCTIONS, /\(1\) verify paper identity, then \(2\) check/i);
  assert.match(SMART_CITATION_REVIEW_INSTRUCTIONS, /nearby Artifact claim/i);
  assert.match(SMART_CITATION_REVIEW_INSTRUCTIONS, /CITATION_CLAIM_NOT_SUPPORTED/i);
  assert.match(SMART_CITATION_REVIEW_INSTRUCTIONS, /INCONCLUSIVE without inventing a finding/i);
});

test("Deep Citation recognizes Europe PMC citation aliases", () => {
  assert.equal(hasExplicitLiteratureCitation("Citation: Europe-pmc:PMC13210248"), true);
  assert.equal(hasExplicitLiteratureCitation("Citation: Europe-pmc:42092972"), true);
});

test("Citation source preflight resolves stable identifiers and keeps provider output bounded", () => {
  assert.equal(citationSourceUrl({
    key: "pmid:12345678",
    label: "PMID: 12345678",
    reference: "PMID:12345678",
  }), "https://pubmed.ncbi.nlm.nih.gov/12345678/");
  assert.equal(citationSourceUrl({
    key: "doi:10.1000/example",
    label: "DOI: 10.1000/example",
    reference: "[source](https://example.org/article)",
  }), "https://example.org/article");
  const source = citationSourceSnapshot("https://example.org/article", { content: "x".repeat(20_000) });
  assert.equal(source.status, "available");
  assert.equal(source.content?.length, 12_000);
});
