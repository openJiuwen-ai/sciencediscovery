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
  buildCommunityReportPrompt,
  normalizeCommunityReport,
  REPORT_MAX_FINDINGS,
  type CommunityReportContext,
} from "./community-report.js";

function ctx(overrides: Partial<CommunityReportContext> = {}): CommunityReportContext {
  return {
    kbId: "kb-1",
    fingerprint: "e10:x0",
    communityId: 3,
    communityName: "Antibody response",
    memberCount: 2,
    members: [
      { name: "mAb114", type: "antibody", support: 5, definition: "A human monoclonal antibody" },
      { name: "Ebola virus glycoprotein", type: "protein", support: 9, definition: null },
    ],
    relations: [
      {
        source: "mAb114",
        target: "Ebola virus glycoprotein",
        type: "neutralizes",
        support: 4,
        evidence: "localized on the virus spike glycoprotein leading to neutralization",
      },
    ],
    ...overrides,
  };
}

test("buildCommunityReportPrompt renders members, relations and the JSON contract", () => {
  const prompt = buildCommunityReportPrompt(ctx());
  assert.match(prompt, /Community #3 \(Antibody response\)/);
  assert.match(prompt, /Total members: 2/);
  assert.match(prompt, /- mAb114 \| antibody \| 5 \| A human monoclonal antibody/);
  assert.match(prompt, /- mAb114 -> Ebola virus glycoprotein \| neutralizes \| 4/);
  assert.match(prompt, /"localized on the virus spike glycoprotein leading to neutralization"/);
  assert.match(prompt, /"rating": integer 0-10/);
  assert.match(prompt, /VERBATIM/);
});

test("buildCommunityReportPrompt clamps to the member and relation budgets", () => {
  const members = Array.from({ length: 80 }, (_, i) => ({ name: `E${i}`, type: "gene", support: i }));
  const relations = Array.from({ length: 90 }, (_, i) => ({
    source: `E${i}`,
    target: `E${i + 1}`,
    type: "interacts",
    support: 1,
    evidence: null,
  }));
  const prompt = buildCommunityReportPrompt(ctx({ members, relations, memberCount: 80 }));
  const memberLines = prompt.split("\n").filter((l) => l.startsWith("- E"));
  // 40 members + 50 relations max — and the header discloses the truncation.
  assert.ok(memberLines.length <= 90);
  assert.match(prompt, /top 40 listed by support/);
  assert.doesNotMatch(prompt, /- E79 \|/);
});

test("buildCommunityReportPrompt says so when the community has no relations", () => {
  const prompt = buildCommunityReportPrompt(ctx({ relations: [] }));
  assert.match(prompt, /- \(none recorded\)/);
});

test("normalizeCommunityReport clamps, coerces and drops junk findings", () => {
  const draft = normalizeCommunityReport(
    {
      title: "x".repeat(400),
      summary: "This community groups the antibody-response entities around the Ebola glycoprotein.",
      rating: 42,
      rating_explanation: "hub protein present",
      findings: [
        { summary: "mAb114 neutralizes GP", explanation: "e".repeat(1000), evidence: "localized on the virus spike" },
        { summary: "", explanation: "junk" },
        "not an object",
        null,
        { summary: "thin support", explanation: "" },
      ],
    },
    ctx(),
  );
  assert.ok(draft);
  assert.equal(draft.rating, 10);
  assert.equal(draft.title.length, 120);
  assert.equal(draft.findings.length, 2);
  assert.equal(draft.findings[0]!.explanation.length, 800);
  assert.equal(draft.findings[0]!.evidence, "localized on the virus spike");
  assert.equal(draft.findings[1]!.evidence, undefined);
});

test("normalizeCommunityReport caps the findings array and falls back the title", () => {
  const findings = Array.from({ length: REPORT_MAX_FINDINGS + 5 }, (_, i) => ({
    summary: `finding ${i}`,
    explanation: "why",
  }));
  const draft = normalizeCommunityReport(
    { summary: "A long enough summary to be accepted.".repeat(2), rating: 3, findings },
    ctx({ communityName: null }),
  );
  assert.ok(draft);
  assert.equal(draft.findings.length, REPORT_MAX_FINDINGS);
  assert.equal(draft.title, "Community #3");
});

test("normalizeCommunityReport rejects unusable output", () => {
  assert.equal(normalizeCommunityReport(null, ctx()), null);
  assert.equal(normalizeCommunityReport({ summary: "too short" }, ctx()), null);
  assert.equal(normalizeCommunityReport({ findings: [] }, ctx()), null);
});
