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
  artifactEvidenceAliases,
  buildEvidenceBundle,
  citationClaimExcerpt,
  literatureCitationCandidates,
  quantitativeEvidenceClaims,
  semanticReviewFingerprint,
} from "./review-policy.js";

test("Literature candidates split a bibliography into stable individual tasks", () => {
  const candidates = literatureCitationCandidates([
    "The method is established [1, 2].",
    "[1] Vaswani et al. (2017). Attention Is All You Need. doi:10.48550/arXiv.1706.03762",
    "[2] Example et al. (2020). Follow-up. PMID: 12345678",
  ].join("\n"));

  assert.deepEqual(candidates.map((candidate) => candidate.label), [
    "DOI: 10.48550/arxiv.1706.03762",
    "PMID: 12345678",
  ]);
  assert.equal(citationClaimExcerpt([
    "The method is established [1, 2].",
    "[1] Vaswani et al. (2017). Attention Is All You Need. doi:10.48550/arXiv.1706.03762",
    "[2] Example et al. (2020). Follow-up. PMID: 12345678",
  ].join("\n"), candidates[0]!), "The method is established [1, 2].");
});

test("Deep Citation queues every identifiable reference", () => {
  const count = 55;
  const content = Array.from({ length: count }, (_, index) => (
    `[${index + 1}] Example et al. (2020). PMID: ${String(10_000_000 + index)}`
  )).join("\n");

  assert.equal(literatureCitationCandidates(content).length, count);
});

test("Deep Citation recognizes Europe PMC identifiers used inline with a claim", () => {
  const content = "TP53 is the most frequently altered gene in LUAD [ev2]. Citation: Europe-pmc:PMC13210248.";
  const candidates = literatureCitationCandidates(content);

  assert.deepEqual(candidates.map((candidate) => candidate.label), ["PMCID: pmc13210248"]);
  assert.equal(citationClaimExcerpt(content, candidates[0]!), content);
});

test("Deep Citation normalizes canonical literature URLs to stable identifiers", () => {
  const candidates = literatureCitationCandidates([
    "## 引用及来源清单",
    "| Evidence | PMID | PMCID | 链接 |",
    "| --- | --- | --- | --- |",
    "| [ev1] | 42136763 | PMC13171259 | https://europepmc.org/article/PMC/PMC13171259 |",
    "| 2 | 42353631 | — | https://pubmed.ncbi.nlm.nih.gov/42353631/ |",
    "| 3 | legacy | — | https://www.ncbi.nlm.nih.gov/pubmed/39129089?report=abstract |",
    "| 4 | — | — | https://doi.org/10.1000/example |",
  ].join("\n"));

  assert.deepEqual(candidates.map(({ key, label }) => ({ key, label })), [
    { key: "pmcid:pmc13171259", label: "PMCID: pmc13171259" },
    { key: "pmid:42353631", label: "PMID: 42353631" },
    { key: "pmid:39129089", label: "PMID: 39129089" },
    { key: "doi:10.1000/example", label: "DOI: 10.1000/example" },
  ]);
});

test("Deep Citation resolves table short citations through a descriptive Chinese bibliography heading", () => {
  const content = [
    "| 研究 | 体系 |",
    "| --- | --- |",
    "| Krüger et al. 2023, Pharmaceuticals 16(2):190 | Calu-3 |",
    "| Matsumoto et al. 2026, Sci Rep | pseudovirus assay |",
    "| Zhu et al. 2026, BMC Cancer 26:235 | Phase II |",
    "## 参考文献（本报告引用的核心证据）",
    "1. Krüger N, et al. Discovery of Polyphenolic Natural Products as SARS-CoV-2 Mpro Inhibitors for COVID-19. Pharmaceuticals 2023, 16(2):190. DOI: 10.3390/ph16020190",
    "2. Matsumoto F, et al. Pyrogallol B-ring enhances catechin binding to the SARS-CoV-2 spike receptor-binding domain. Sci Rep 2026. PMC13057188",
    "3. Zhu W, et al. Efficacy and safety of aerosolized EGCG in oncologic patients with COVID-19 pneumonia. BMC Cancer 2026, 26:235. PMID 39907399",
  ].join("\n");
  const candidates = literatureCitationCandidates(content);

  assert.deepEqual(candidates.map((candidate) => candidate.label), [
    "DOI: 10.3390/ph16020190",
    "PMCID: pmc13057188",
    "PMID: 39907399",
  ]);
  assert.equal(candidates.some((candidate) => candidate.key.startsWith("author-year:")), false);
  assert.match(citationClaimExcerpt(content, candidates[0]!), /Krüger et al\. 2023, Pharmaceuticals/);
});

test("Deep Citation retains a full unidentifiable bibliography entry instead of querying only author-year", () => {
  const candidates = literatureCitationCandidates([
    "## References (core evidence)",
    "1. Owegie OC, et al. Thiol Isomerases: Enzymatic Mechanisms, Models of Oxidation, and Antagonism by Galloylated Polyphenols. Antioxidants 2025, 14:1193.",
  ].join("\n"));

  assert.equal(candidates.length, 1);
  assert.match(candidates[0]!.key, /^reference:1:/u);
  assert.match(candidates[0]!.reference, /Thiol Isomerases/u);
  assert.equal(candidates[0]!.authorYearKey, "owegie:2025");
});

test("Deep Citation ignores numbered action lists and recognizes PPR preprints in References", () => {
  const content = [
    "## Next steps",
    "1. Read TCGA flagship papers from 2012/2014 for subtype percentages.",
    "## References",
    "3. Vijayaraj J, Bala J. TP53 analysis [Preprint]. Research Square, 2026. PPR1188087.",
  ].join("\n");
  const candidates = literatureCitationCandidates(content);

  assert.deepEqual(candidates.map((candidate) => candidate.label), ["PPR: ppr1188087"]);
  assert.equal(candidates[0]?.marker, "[3]");
  assert.match(citationClaimExcerpt(`${content}\nTP53 was highest [3].`, candidates[0]!), /TP53 was highest \[3\]/);
});

function version(): ScientificArtifactVersion {
  return {
    artifactId: "artifact-1",
    content: { hash: "content-hash", size: 32 },
    createdAt: "2026-08-05T00:00:00.000Z",
    executionRunIds: [],
    id: "artifact-version-1",
    inputArtifactVersionIds: [],
    mediaType: "text/markdown",
    projectId: "project-1",
    references: [{ id: "evidence-1", kind: "evidence", label: "ev1" }],
    sessionId: "session-1",
    version: 1,
  };
}

test("Evidence Bundle resolves only aliases present in the locked Artifact", async () => {
  const calls: string[] = [];
  const bundle = await buildEvidenceBundle(
    "TP53 frequency was 39.7% [ev1]. Missing [ev2].",
    version(),
    async ({ alias }) => {
      calls.push(alias);
      return {
        evidence: { content: "TP53 frequency was 39.7%.", locator: "Results" },
        evidenceFound: true,
        paper: { identifier: "12345678", identifierType: "PMID", title: "TP53 in NSCLC" },
        paperLinked: true,
      };
    },
  );

  assert.deepEqual(calls, ["ev1"]);
  assert.equal(bundle.length, 1);
  assert.equal(bundle[0]?.evidenceId, "evidence-1");
  assert.equal(bundle[0]?.paper?.identifier, "12345678");
});

test("Quantitative claim extraction ignores bare Evidence chips", () => {
  assert.deepEqual(quantitativeEvidenceClaims("See supporting evidence [ev1]."), []);
  assert.deepEqual(quantitativeEvidenceClaims("TP53 frequency was 39.7% [ev1]."), [{
    alias: "ev1",
    excerpt: "TP53 frequency was 39.7% [ev1].",
    values: ["39.7%"],
  }]);
});

test("Quantitative claim extraction accepts the full-name [evidenceN] alias format", () => {
  assert.deepEqual(quantitativeEvidenceClaims("TP53 frequency was 39.7% [evidence1]."), [{
    alias: "evidence1",
    excerpt: "TP53 frequency was 39.7% [evidence1].",
    values: ["39.7%"],
  }]);
  // Mixed formats coexist within one excerpt.
  assert.deepEqual(quantitativeEvidenceClaims("Rate 39.7% [ev1], also [evidence2]."), [
    { alias: "ev1", excerpt: "Rate 39.7% [ev1], also [evidence2].", values: ["39.7%"] },
    { alias: "evidence2", excerpt: "Rate 39.7% [ev1], also [evidence2].", values: ["39.7%"] },
  ]);
});

test("artifactEvidenceAliases accepts both [evN] and [evidenceN] formats", () => {
  assert.deepEqual(artifactEvidenceAliases("See [ev1] and [evidence2]."), ["ev1", "evidence2"]);
});

test("Quantitative claim extraction keeps Markdown table Evidence aliases in their own cells", () => {
  const claims = quantitativeEvidenceClaims([
    "| Cohort | TP53 frequency | Evidence |",
    "| --- | --- | --- |",
    "| A | 39.7% [ev1] | [ev2] |",
  ].join("\n"));
  assert.deepEqual(claims, [{
    alias: "ev1",
    excerpt: "39.7% [ev1]",
    values: ["39.7%"],
  }]);
});

test("Quantitative claim extraction ignores years and stable identifiers", () => {
  const claims = quantitativeEvidenceClaims([
    "In 2026, 119 cases had a 61% rate (n=82; P > 0.05) [ev1]. PMID: 42092972.",
    "The heading 3.1 and Europe-pmc:PMC13210248 are references, not claims [ev2].",
  ].join("\n"));
  assert.deepEqual(claims, [{
    alias: "ev1",
    excerpt: "In 2026, 119 cases had a 61% rate (n=82; P > 0.05) [ev1].",
    values: ["119 cases", "61%", "n=82", "P > 0.05"],
  }]);
});

test("Deep Computation queues every numeric Evidence claim", () => {
  const count = 25;
  const content = Array.from({ length: count }, (_, index) => (
    `Measurement ${index + 1} was ${index + 1}% [ev${index + 1}].`
  )).join("\n");

  assert.equal(quantitativeEvidenceClaims(content).length, count);
});

test("Semantic fingerprint changes when Evidence content changes", () => {
  const metadata = {
    citationSkillHash: "citation-v1",
    computationSkillHash: "computation-v1",
    modelIdentity: "model-1",
  };
  const first = semanticReviewFingerprint("content-hash", version(), [{
    alias: "ev1",
    evidence: { content: "39.7%" },
    evidenceId: "evidence-1",
  }], metadata);
  const second = semanticReviewFingerprint("content-hash", version(), [{
    alias: "ev1",
    evidence: { content: "61%" },
    evidenceId: "evidence-1",
  }], metadata);

  assert.notEqual(first, second);
});
