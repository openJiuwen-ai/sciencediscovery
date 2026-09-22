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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";


import type {
  ArtifactReviewRun,
  ScientificArtifact,
  ScientificArtifactVersion,
} from "@sciencediscovery/schema";

import type { CasStore } from "@sciencediscovery/cas";
import type { SessionStore } from "../store.js";
import {
  cancelReviewerCheckpoints,
  citationReviewClaim,
  isReviewerReportCandidate,
  reviewerCheckpointPromptContent,
  runReviewerCheckpoint,
} from "@sciencediscovery/provenance";

function fixture(contentText = "分析结果支持该结论 [1].\n[1] Study. arXiv:1706.03762") {
  const content = Buffer.from(contentText);
  const artifact: ScientificArtifact = {
    createdAt: "2026-08-03T00:00:00.000Z",
    createdInSessionId: "session-1",
    createdInSessionTitle: "Session 1",
    currentVersion: 1,
    id: "artifact-1",
    kind: "markdown",
    logicalName: "analysis.md",
    name: "analysis.md",
    origin: "llm_declared",
    projectId: "project-1",
    sessionId: "session-1",
    updatedAt: "2026-08-03T00:00:00.000Z",
  };
  const version: ScientificArtifactVersion = {
    artifactId: artifact.id,
    content: { hash: "content-hash-1", size: content.length },
    createdAt: artifact.createdAt,
    executionRunIds: [],
    id: "artifact-version-1",
    inputArtifactVersionIds: [],
    mediaType: "text/markdown",
    projectId: artifact.projectId,
    sessionId: artifact.sessionId,
    turnId: "run-1",
    version: 1,
  };
  const saved: ArtifactReviewRun[] = [];
  let casReads = 0;
  const store = {
    appendArtifactReview: async (review: ArtifactReviewRun) => { saved.push(review); },
    getArtifact: () => artifact,
    getArtifactVersion: () => version,
    listArtifactReviews: async () => saved,
    listArtifacts: () => [artifact],
    listArtifactVersions: () => [version],
  } as unknown as SessionStore;
  const cas = {
    read: async () => {
      casReads += 1;
      return content;
    },
    verify: async () => true,
  } as unknown as CasStore;
  return { artifact, cas, casReadCount: () => casReads, content, saved, store, version };
}

test("report candidate policy requires an approved report extension and matching media type", () => {
  const { artifact, version } = fixture();
  const reportFiles: Array<readonly [string, string]> = [
    ["analysis.md", "text/markdown"],
    ["report.html", "text/html"],
    ["paper.tex", "application/x-tex"],
    ["methods.qmd", "text/markdown"],
  ];
  for (const [name, mediaType] of reportFiles) {
    artifact.logicalName = name;
    version.mediaType = mediaType;
    assert.equal(isReviewerReportCandidate(artifact, version), true, `${name} is a report candidate`);
  }
  const nonReportFiles: Array<readonly [string, string]> = [
    ["execution.log", "text/plain"],
    ["appendix.txt", "text/plain"],
    ["GSEA_gmt.gmt", "text/plain"],
    ["g2m_enrichment_analysis.py", "text/x-python"],
    ["enrichment_results.csv", "text/csv"],
    ["summary.md", "text/plain"],
  ];
  for (const [name, mediaType] of nonReportFiles) {
    artifact.logicalName = name;
    version.mediaType = mediaType;
    assert.equal(isReviewerReportCandidate(artifact, version), false, `${name} is not a report candidate`);
  }
});

test("citation claim planner requires E3 evidence for exact numeric results", () => {
  const { content, version } = fixture("The response rate was 42% [1].\n[1] Example et al. (2024). PMID: 12345678");
  const claim = citationReviewClaim(content.toString("utf8"), version, {
    key: "pmid:12345678", label: "PMID: 12345678", marker: "[1]", reference: "[1] Example et al. (2024). PMID: 12345678",
  });
  assert.equal(claim.requiredEvidenceLevel, "E3");
});

test("Quick checkpoint normalizes media type parameters before narrative checks", async () => {
  const { cas, saved, store, version } = fixture("The study reports a result. DOI: 10.1234/example");
  version.mediaType = "text/markdown; charset=utf-8";
  const result = await runReviewerCheckpoint({
    cas,
    parentRunId: "run-1",
    reason: "Quick review",
    sessionId: "session-1",
    store,
  });

  assert.equal(saved.length, 1);
  assert.ok(result.reviews[0]?.checks?.includes("citation"));
  assert.ok(result.reviews[0]?.findings.some((finding) => finding.code === "CITATION_MARKER_MISSING"));
});

test("Quick checkpoint combines Citation and Artifact computation checks", async () => {
  const { cas, saved, store, version } = fixture();
  const result = await runReviewerCheckpoint({
    cas,
    parentRunId: "run-1",
    reason: "Quick review",
    sessionId: "session-1",
    store,
    toolCallId: "tool-1",
    traceArtifactProvenance: async (reference) => {
      assert.equal(reference.provenanceRef, "artifact-1#v1");
      return {
        broken: false,
        chain: [{
          hop: 1,
          isTerminal: true,
          node: { excerpt: "Goal", id: "goal-1", label: "ResearchGoal" },
          viaEdge: "next",
        }],
        reason: "reached terminal node ResearchGoal",
        startNode: {
          contentHash: version.content.hash,
          excerpt: "analysis.md",
          id: "artifact-1#v1",
          label: "Artifact",
        },
        truncated: false,
      };
    },
  });

  assert.equal(result.checkpoint.status, "completed");
  assert.deepEqual(result.checkpoint.reviewedArtifactVersionIds, [version.id]);
  assert.equal(result.reviews[0]?.decision, "ACCEPT_AND_PROCEED");
  assert.deepEqual(result.reviews[0]?.checks, ["citation", "computation"]);
  assert.deepEqual(result.reviews[0]?.provenanceRefs, ["artifact-1#v1"]);
  assert.equal(result.reviews[0]?.reviewLevel, "quick");
  assert.equal(saved.length, 1);
});

test("Quick checkpoint skips graph-linked checks when the graph is disabled", async () => {
  const { cas, store } = fixture();
  const result = await runReviewerCheckpoint({
    cas,
    parentRunId: "run-1",
    reason: "Quick review",
    sessionId: "session-1",
    store,
  });

  assert.equal(result.checkpoint.status, "completed");
  assert.equal(result.reviews[0]?.decision, "ACCEPT_AND_PROCEED");
  assert.deepEqual(result.reviews[0]?.checks, ["citation"]);
  assert.deepEqual(result.reviews[0]?.findings, []);
});

test("Reviewer checkpoint excludes Artifacts and versions created by another Session in the same Project", async () => {
  const { artifact, cas, store, version } = fixture();
  const foreignArtifact: ScientificArtifact = {
    ...artifact,
    createdInSessionId: "session-2",
    createdInSessionTitle: "Session 2",
    id: "artifact-2",
    logicalName: "other-session.md",
    name: "other-session.md",
    sessionId: "session-2",
  };
  const foreignVersion: ScientificArtifactVersion = {
    ...version,
    artifactId: foreignArtifact.id,
    id: "artifact-version-2",
    sessionId: "session-2",
  };
  const scopedStore = {
    ...store,
    getArtifact: (_sessionId: string, artifactId: string) => artifactId === artifact.id ? artifact : foreignArtifact,
    getArtifactVersion: (_sessionId: string, versionId: string) => versionId === version.id ? version : foreignVersion,
    listArtifacts: () => [artifact, foreignArtifact],
    listArtifactVersions: (_sessionId: string, artifactId: string) => artifactId === artifact.id ? [version] : [foreignVersion],
  } as unknown as SessionStore;

  const result = await runReviewerCheckpoint({
    cas,
    parentRunId: "run-1",
    reason: "Review current Session only",
    sessionId: "session-1",
    store: scopedStore,
  });

  assert.deepEqual(result.checkpoint.candidateArtifactVersionIds, [version.id]);
  assert.deepEqual(result.checkpoint.reviewedArtifactVersionIds, [version.id]);
  await assert.rejects(
    runReviewerCheckpoint({
      artifactVersionIds: [foreignVersion.id],
      cas,
      parentRunId: "run-1",
      reason: "Reject another Session Artifact",
      sessionId: "session-1",
      store: scopedStore,
    }),
    /Artifact version not found in this Session: artifact-version-2/,
  );
});

test("Quick checkpoint keeps Citation findings available when the graph is disabled", async () => {
  const { cas, store } = fixture("The result supports this claim [1].");
  const result = await runReviewerCheckpoint({
    cas,
    parentRunId: "run-1",
    reason: "Citation-only review",
    sessionId: "session-1",
    store,
  });

  assert.deepEqual(result.reviews[0]?.checks, ["citation"]);
  assert.ok(result.reviews[0]?.findings.some(
    (finding) => finding.code === "CITATION_REFERENCE_MISSING",
  ));
});

test("Quick checkpoint reuses an unchanged complete review without running checks again", async () => {
  const { cas, casReadCount, saved, store, version } = fixture();
  let provenanceTraces = 0;
  const traceArtifactProvenance = async () => {
    provenanceTraces += 1;
    return {
      broken: false,
      chain: [],
      reason: "reached terminal node ResearchGoal",
      startNode: {
        contentHash: version.content.hash,
        excerpt: "analysis.md",
        id: "artifact-1#v1",
        label: "Artifact" as const,
      },
      truncated: false,
    };
  };
  const first = await runReviewerCheckpoint({
    cas,
    parentRunId: "run-1",
    reason: "First review",
    sessionId: "session-1",
    store,
    toolCallId: "tool-1",
    traceArtifactProvenance,
  });
  const second = await runReviewerCheckpoint({
    artifactVersionIds: [version.id],
    cas,
    parentRunId: "run-2",
    reason: "Repeat review",
    sessionId: "session-1",
    store,
    toolCallId: "tool-2",
    traceArtifactProvenance,
  });

  assert.equal(casReadCount(), 1);
  assert.equal(provenanceTraces, 1);
  assert.deepEqual(second.checkpoint.reviewedArtifactVersionIds, []);
  assert.deepEqual(second.checkpoint.skippedArtifactVersionIds, [version.id]);
  assert.equal(second.reviews[0]?.reusedFromReviewId, first.reviews[0]?.id);
  assert.equal(second.reviews[0]?.toolCallId, "tool-2");
  assert.equal(saved.length, 2);
});

test("Reviewer checkpoint feedback exposes findings to the next model context", async () => {
  const { cas, store } = fixture();
  const result = await runReviewerCheckpoint({
    cas,
    parentRunId: "run-1",
    reason: "Quick review",
    sessionId: "session-1",
    store,
  });
  const content = reviewerCheckpointPromptContent(result.reviews);

  assert.match(content, /Reviewer Specialist feedback \(internal review record\)/);
  assert.match(content, /Status: PASSED/);
  assert.match(content, /Artifact: analysis\.md/);
  assert.match(content, /No findings\./);
  assert.match(content, /read-only diagnostic context/);
  const partial = reviewerCheckpointPromptContent(result.reviews, undefined, true);
  assert.match(partial, /Status: PARTIAL/);
  assert.match(partial, /available for the next main-Agent action/);
});

test("Reviewer checkpoint sends only source contradictions to the main-Agent context", () => {
  const review = {
    artifactContentHash: "hash",
    artifactId: "artifact-1",
    artifactLogicalName: "analysis.md",
    artifactVersionId: "version-1",
    checkpointId: "checkpoint-1",
    createdAt: "2026-08-05T00:00:00.000Z",
    decision: "ACCEPT_AND_PROCEED",
    findings: [],
    finishedAt: "2026-08-05T00:00:01.000Z",
    id: "review-1",
    reviewerSpecialistVersion: "deep",
    reviewLevel: "deep" as const,
    sessionId: "session-1",
    sourceAssessments: [
      {
        assessment: { assessment: "SUPPORTED" as const, claimId: "claim-supported", locatorIds: ["locator-supported"], policyVersion: "2", rationale: "Supported." },
        claim: { artifactVersionId: "version-1", citationKeys: ["pmid:1"], id: "claim-supported", kind: "citation" as const, requiredEvidenceLevel: "E1" as const, text: "Supported claim" },
        locators: [],
        snapshots: [],
      },
      {
        assessment: { assessment: "INCONCLUSIVE" as const, claimId: "claim-inconclusive", locatorIds: [], policyVersion: "2", rationale: "Abstract was unavailable." },
        claim: { artifactVersionId: "version-1", citationKeys: ["pmid:2"], id: "claim-inconclusive", kind: "citation" as const, requiredEvidenceLevel: "E1" as const, text: "Unverified claim" },
        locators: [],
        snapshots: [],
      },
    ],
    status: "completed" as const,
  } satisfies ArtifactReviewRun;

  const content = reviewerCheckpointPromptContent([review]);
  assert.doesNotMatch(content, /Source verification notes/);
  assert.doesNotMatch(content, /pmid:2 is INCONCLUSIVE/);
  assert.doesNotMatch(content, /pmid:1/);
});

test("Reviewer checkpoint failure is context, not an Artifact defect", () => {
  const content = reviewerCheckpointPromptContent([], "memory graph unavailable");
  assert.match(content, /Status: FAILED/);
  assert.match(content, /memory graph unavailable/);
  assert.match(content, /Do not treat this failure as an Artifact defect/);
});

test("Reviewer checkpoint keeps an operationally incomplete Deep stage out of main-Agent feedback", () => {
  const review = {
    artifactContentHash: "hash",
    artifactId: "artifact-1",
    artifactLogicalName: "analysis.md",
    artifactVersionId: "version-1",
    checkpointId: "checkpoint-1",
    checks: ["citation", "computation"],
    createdAt: "2026-08-05T00:00:00.000Z",
    decision: "ACCEPT_AND_PROCEED",
    findings: [],
    finishedAt: "2026-08-05T00:00:01.000Z",
    id: "review-1",
    reviewerSpecialistVersion: "smart",
    reviewLevel: "deep" as const,
    sessionId: "session-1",
    smartStatus: "inconclusive",
    status: "completed",
  } satisfies ArtifactReviewRun;
  const content = reviewerCheckpointPromptContent([review]);

  assert.match(content, /Status: PASSED/);
  assert.doesNotMatch(content, /incomplete|semantically verified/i);
});

test("Deep computation accepts a generated Artifact claim only with issued E4 locators", async () => {
  const { cas, store, version } = fixture("Response rate was 42% [artifact1].");
  version.references = [{ id: "generated-data-1", kind: "artifact", label: "artifact1", version: 1 }];
  let issuedLocators: string[] = [];
  const result = await runReviewerCheckpoint({
    cas,
    parentRunId: "run-1",
    reason: "Deep computation evidence",
    reviewLevel: "deep",
    semanticReview: {
      citationSkillHash: "citation-v1",
      computationSkillHash: "computation-v1",
      execute: async (request) => {
        if (request.prompt.includes("Issued E4 computation evidence")) {
          issuedLocators = [...request.prompt.matchAll(/locator:[a-f0-9]+/gu)].map((match) => match[0]);
          return JSON.stringify({ computation: {
            assessment: "SUPPORTED", findings: [], locatorIds: issuedLocators, rationale: "The output data records 42%.", status: "COMPLETED",
          } });
        }
        return JSON.stringify({ computation: { findings: [], status: "COMPLETED" } });
      },
      modelIdentity: "model-1",
      probeComputation: async () => ({
        materials: [
          { content: "response_rate,42%", locator: { executionId: "execution-1", field: "artifact_content", outputPath: "outputs/result.csv" }, sourceId: "artifact-version:data-1", sourceType: "artifact" },
          { content: "print('42%')", locator: { executionId: "execution-1", field: "source_code" }, sourceId: "execution:execution-1", sourceType: "code" },
          { content: "42%", locator: { executionId: "execution-1", field: "stdout" }, sourceId: "execution:execution-1", sourceType: "execution" },
        ],
        status: "available" as const,
      }),
    },
    sessionId: "session-1",
    store,
  });
  assert.equal(issuedLocators.length, 3);
  assert.equal(result.reviews[0]?.smartStatus, "completed");
  assert.equal(result.reviews[0]?.sourceAssessments?.[0]?.assessment.assessment, "SUPPORTED");
  assert.equal(result.reviews[0]?.sourceAssessments?.[0]?.claim.requiredEvidenceLevel, "E4");
});

test("Deep checkpoint reuses an identical locked Artifact without rereading CAS or graph", async () => {
  const { cas, casReadCount, saved, store, version } = fixture();
  let executions = 0;
  let provenanceQueries = 0;
  const semanticReview = {
    citationSkillHash: "citation-v1",
    computationSkillHash: "computation-v1",
    execute: async (request: { prompt: string; stage: "computation" | "citation" }) => {
      executions += 1;
      if (request.stage === "computation") {
        assert.match(request.prompt, /before citation review/i);
        return JSON.stringify({ computation: { findings: [], status: "COMPLETED" } });
      }
      assert.match(request.prompt, /verify paper identity, then \(2\) check whether the nearby Artifact claim is supported/i);
      assert.match(request.prompt, /CITATION_CLAIM_NOT_SUPPORTED/i);
      const locatorId = request.prompt.match(/locator:[a-f0-9]+/u)?.[0];
      assert.ok(locatorId);
      return JSON.stringify({ citation: {
        assessment: "CONTRADICTED",
        findings: [{
          code: "CITATION_CLAIM_NOT_SUPPORTED",
          evidenceAliases: [],
          message: "The cited paper metadata does not establish the stated measurement.",
          severity: "warning",
        }],
        locatorIds: [locatorId],
        rationale: "The issued source snapshot does not support the stated measurement.",
        status: "COMPLETED",
      } });
    },
    modelIdentity: "model-1",
    probeCitation: async () => ({ content: "Verified source metadata.", sourceId: "arxiv:1706.03762", status: "available" as const }),
  };
  const traceArtifactProvenance = async () => {
    provenanceQueries += 1;
    return {
      broken: false,
      chain: [],
      startNode: {
        contentHash: version.content.hash,
        excerpt: "analysis.md",
        id: "artifact-1#v1",
        label: "Artifact" as const,
      },
      truncated: false,
    };
  };
  const first = await runReviewerCheckpoint({
    cas,
    parentRunId: "run-1",
    reason: "Deep review",
    reviewLevel: "deep",
    sessionId: "session-1",
    semanticReview,
    store,
    traceArtifactProvenance,
  });
  const second = await runReviewerCheckpoint({
    artifactVersionIds: [version.id],
    cas,
    parentRunId: "run-2",
    reason: "Repeat Deep review",
    reviewLevel: "deep",
    sessionId: "session-1",
    semanticReview,
    store,
    traceArtifactProvenance,
  });

  assert.equal(executions, 1);
  assert.equal(casReadCount(), 1);
  assert.equal(provenanceQueries, 1);
  assert.equal(first.reviews[0]?.reviewLevel, "deep");
  assert.equal(first.reviews[0]?.smartStatus, "completed");
  assert.equal(first.reviews[0]?.findings.at(-1)?.code, "CITATION_CLAIM_NOT_SUPPORTED");
  assert.equal(second.reviews[0]?.reusedFromReviewId, first.reviews[0]?.id);
  assert.deepEqual(second.checkpoint.skippedArtifactVersionIds, [version.id]);
  assert.equal(saved.length, 2);
});

test("Reviewer checkpoint ignores structured source Artifacts instead of treating them as reports", async () => {
  const { artifact, cas, store, version } = fixture(JSON.stringify({
    claim: "TP53 mutation frequency was 39.7% [ev1].",
    references: ["[1] Study. arXiv:1706.03762"],
  }));
  artifact.logicalName = "sources.json";
  version.mediaType = "application/json";
  version.references = [{ id: "evidence-1", kind: "evidence", label: "ev1" }];
  let executions = 0;
  let evidenceTraces = 0;
  let provenanceTraces = 0;
  const result = await runReviewerCheckpoint({
    cas,
    parentRunId: "run-1",
    reason: "Deep review",
    reviewLevel: "deep",
    semanticReview: {
      citationSkillHash: "citation-v1",
      computationSkillHash: "computation-v1",
      execute: async () => {
        executions += 1;
        return JSON.stringify({});
      },
      modelIdentity: "model-1",
    },
    sessionId: "session-1",
    store,
    traceArtifactProvenance: async () => {
      provenanceTraces += 1;
      return {
        broken: false,
        chain: [],
        startNode: {
          contentHash: version.content.hash,
          excerpt: "sources.json",
          id: "artifact-1#v1",
          label: "Artifact",
        },
        truncated: false,
      };
    },
    traceEvidenceReference: async () => {
      evidenceTraces += 1;
      return { evidenceFound: true, paperLinked: true };
    },
  });

  assert.equal(executions, 0);
  assert.equal(evidenceTraces, 0);
  assert.equal(provenanceTraces, 0);
  assert.deepEqual(result.reviews, []);
  assert.deepEqual(result.checkpoint.reviewedArtifactVersionIds, []);
});

test("Reviewer checkpoint ignores malformed JSON rather than reporting it as a report defect", async () => {
  const { artifact, cas, store, version } = fixture("{ not-json");
  artifact.logicalName = "sources.json";
  version.mediaType = "application/json";
  const result = await runReviewerCheckpoint({
    cas,
    parentRunId: "run-1",
    reason: "Quick source-list review",
    sessionId: "session-1",
    store,
  });

  assert.deepEqual(result.reviews, []);
  assert.deepEqual(result.checkpoint.reviewedArtifactVersionIds, []);
});

test("Deep review runs Computation for an Evidence-backed report without a bibliography", async () => {
  const { cas, store, version } = fixture("TP53 mutation frequency was 39.7% [ev1].");
  version.references = [{ id: "evidence-1", kind: "evidence", label: "ev1" }];
  let executions = 0;
  const result = await runReviewerCheckpoint({
    cas,
    parentRunId: "run-1",
    reason: "Deep Evidence review",
    reviewLevel: "deep",
    semanticReview: {
      citationSkillHash: "citation-v1",
      computationSkillHash: "computation-v1",
      execute: async (request) => {
        executions += 1;
        assert.equal(request.stage, "computation");
        return JSON.stringify({ computation: { findings: [], status: "COMPLETED" } });
      },
      modelIdentity: "model-1",
    },
    sessionId: "session-1",
    store,
    traceArtifactProvenance: async () => ({
      broken: false,
      chain: [],
      startNode: { contentHash: version.content.hash, excerpt: "analysis.md", id: "artifact-1#v1", label: "Artifact" },
      truncated: false,
    }),
    traceEvidenceReference: async () => ({
      evidence: { content: "TP53 mutation frequency was 39.7%." },
      evidenceFound: true,
      paperLinked: true,
    }),
  });

  assert.equal(executions, 1);
  assert.equal(result.reviews[0]?.reviewLevel, "deep");
  assert.equal(result.reviews[0]?.smartStatus, "completed");
});

test("Deep Citation remains independently verifiable when ScienceMemory is disabled", async () => {
  const { cas, store, version } = fixture([
    "The reported intervention improved the endpoint [1].",
    "[1] Example et al. (2024). PMID: 12345678",
  ].join("\n"));
  const result = await runReviewerCheckpoint({
    artifactVersionIds: [version.id],
    cas,
    parentRunId: "run-1",
    reason: "Citation review without ScienceMemory",
    reviewLevel: "deep",
    semanticReview: {
      citationSkillHash: "citation-v2",
      computationSkillHash: "computation-v2",
      execute: async (request) => {
        assert.equal(request.stage, "citation");
        const locatorId = request.prompt.match(/locator:[a-f0-9]+/u)?.[0];
        assert.ok(locatorId, "the model receives only issued source locators");
        return JSON.stringify({ citation: {
          assessment: "SUPPORTED",
          findings: [],
          locatorIds: [locatorId],
          rationale: "The governed metadata identifies the cited record; available abstract text is consistent with the bounded claim.",
          status: "COMPLETED",
        } });
      },
      modelIdentity: "model-1",
      probeCitation: async () => ({
        content: JSON.stringify({ abstract: "The intervention improved the endpoint.", identifier: "12345678", title: "Example study" }),
        sourceId: "pmid:12345678",
        sourceType: "abstract",
        status: "available",
      }),
    },
    sessionId: "session-1",
    store,
    // Deliberately omit graph tracers: Citation must not depend on ScienceMemory.
  });

  const record = result.reviews[0]?.sourceAssessments?.[0];
  assert.equal(result.reviews[0]?.smartStatus, "completed");
  assert.equal(record?.assessment.assessment, "SUPPORTED");
  assert.equal(record?.assessment.locatorIds.length, 1);
  assert.equal(record?.snapshots[0]?.sourceId, "pmid:12345678");
  assert.equal(record?.snapshots[0]?.availability, "available");
});

test("Deep Citation discards a strong model verdict without an issued locator", async () => {
  const { cas, store, version } = fixture("The claim is contradicted [1].\n[1] Example et al. (2024). PMID: 12345678");
  const result = await runReviewerCheckpoint({
    artifactVersionIds: [version.id],
    cas,
    parentRunId: "run-1",
    reason: "Reject unanchored citation verdict",
    reviewLevel: "deep",
    semanticReview: {
      citationSkillHash: "citation-v2",
      computationSkillHash: "computation-v2",
      execute: async () => JSON.stringify({ citation: {
        assessment: "CONTRADICTED",
        findings: [{ code: "CITATION_CLAIM_NOT_SUPPORTED", evidenceAliases: [], message: "The model says this is contradicted.", severity: "warning" }],
        locatorIds: ["locator:not-issued"],
        rationale: "Untrusted locator.",
        status: "COMPLETED",
      } }),
      modelIdentity: "model-1",
      probeCitation: async () => ({ content: "Verified metadata.", sourceId: "pmid:12345678", status: "available" }),
    },
    sessionId: "session-1",
    store,
  });

  assert.equal(result.reviews[0]?.smartStatus, "inconclusive");
  assert.deepEqual(result.reviews[0]?.smartFindings, []);
  assert.equal(result.reviews[0]?.sourceAssessments?.[0]?.assessment.assessment, "INCONCLUSIVE");
});

test("Deep Citation rejects an E1 verdict for a numeric claim that requires E3 evidence", async () => {
  const { cas, store, version } = fixture("The response rate was 42% [1].\n[1] Example et al. (2024). PMID: 12345678");
  let executions = 0;
  const result = await runReviewerCheckpoint({
    artifactVersionIds: [version.id], cas, parentRunId: "run-1", reason: "Numeric evidence gate", reviewLevel: "deep",
    semanticReview: {
      citationSkillHash: "citation-v2", computationSkillHash: "computation-v2", modelIdentity: "model-1",
      execute: async () => { executions += 1; return JSON.stringify({}); },
      probeCitation: async () => ({ content: "Verified abstract metadata.", sourceId: "pmid:12345678", status: "available" }),
    },
    sessionId: "session-1", store,
  });
  const record = result.reviews[0]?.sourceAssessments?.[0];
  assert.equal(record?.claim.requiredEvidenceLevel, "E3");
  assert.equal(record?.assessment.assessment, "INCONCLUSIVE");
  assert.match(record?.assessment.rationale ?? "", /No issued E3 source locator/u);
  assert.equal(executions, 0);
});

test("Deep review does not duplicate Quick missing Evidence mapping as semantic unavailable", async () => {
  const { cas, store, version } = fixture("The rate was 39.7% [ev1].");
  let executions = 0;
  const result = await runReviewerCheckpoint({
    cas,
    parentRunId: "run-1",
    reason: "Deep Evidence review",
    reviewLevel: "deep",
    semanticReview: {
      citationSkillHash: "citation-v1",
      computationSkillHash: "computation-v1",
      execute: async () => { executions += 1; return JSON.stringify({}); },
      modelIdentity: "model-1",
    },
    sessionId: "session-1",
    store,
    traceArtifactProvenance: async () => ({
      broken: false, chain: [],
      startNode: { contentHash: version.content.hash, excerpt: "analysis.md", id: "artifact-1#v1", label: "Artifact" },
      truncated: false,
    }),
  });

  assert.equal(executions, 0);
  assert.deepEqual(result.reviews[0]?.smartFindings, []);
  assert.deepEqual(result.reviews[0]?.findings.map((finding) => finding.code), ["CITATION_EVIDENCE_ALIAS_UNRESOLVED"]);
});

test("Malformed semantic output is retryable and does not invent a finding", async () => {
  const { cas, store, version } = fixture();
  let executions = 0;
  const options = {
    artifactVersionIds: [version.id],
    cas,
    parentRunId: "run-1",
    reason: "Deep review",
    reviewLevel: "deep" as const,
    semanticReview: {
      citationSkillHash: "citation-v1",
      computationSkillHash: "computation-v1",
      execute: async () => {
        executions += 1;
        return "not-json";
      },
      modelIdentity: "model-1",
    },
    sessionId: "session-1",
    store,
    traceArtifactProvenance: async () => ({
      broken: false,
      chain: [],
      startNode: {
        contentHash: version.content.hash,
        excerpt: "analysis.md",
        id: "artifact-1#v1",
        label: "Artifact" as const,
      },
      truncated: false,
    }),
  };
  const result = await runReviewerCheckpoint(options);
  const retried = await runReviewerCheckpoint({ ...options, parentRunId: "run-2" });

  assert.equal(result.reviews[0]?.smartStatus, "inconclusive");
  assert.equal(result.reviews[0]?.smartDetail?.code, "SMART_AGENT_OUTPUT_INVALID");
  assert.deepEqual(result.reviews[0]?.smartFindings, []);
  // Each malformed citation result receives one bounded automatic retry; a
  // later manual run retries that single reference again.
  assert.equal(executions, 4);
  assert.equal(retried.reviews[0]?.reusedFromReviewId, undefined);
});

test("Deep Citation timeout preserves completed local Computation findings", async () => {
  const { cas, store, version } = fixture("The value was 13.7 mg/L [ev1] [1].\n[1] Study. arXiv:1706.03762");
  version.references = [{ id: "evidence-1", kind: "evidence", label: "ev1" }];
  const result = await runReviewerCheckpoint({
    artifactVersionIds: [version.id],
    cas,
    parentRunId: "run-1",
    reason: "Deep review with a Citation timeout",
    reviewLevel: "deep",
    semanticReview: {
      citationSkillHash: "citation-v1",
      computationSkillHash: "computation-v1",
      execute: async (request) => {
        if (request.stage === "computation") {
          return JSON.stringify({ computation: {
            findings: [{
              code: "COMPUTATION_EVIDENCE_VALUE_MISMATCH",
              evidenceAliases: [],
              message: "The reported value conflicts with the local Evidence Bundle.",
              severity: "warning",
            }],
            status: "COMPLETED",
          } });
        }
        throw new Error("Agent run timeout: gateway turn exceeded 90000 ms");
      },
      modelIdentity: "model-1",
    },
    sessionId: "session-1",
    store,
    traceEvidenceReference: async () => ({
      evidenceFound: true,
      evidence: { content: "The observed concentration was 12.0 mg/L." },
      paperLinked: true,
    }),
    traceArtifactProvenance: async () => ({
      broken: false,
      chain: [],
      startNode: { contentHash: version.content.hash, excerpt: "analysis.md", id: "artifact-1#v1", label: "Artifact" },
      truncated: false,
    }),
  });

  assert.equal(result.reviews[0]?.smartStatus, "inconclusive");
  assert.equal(result.reviews[0]?.smartDetail?.code, "SMART_EXECUTION_FAILED");
  assert.match(result.reviews[0]?.smartDetail?.message ?? "", /Deep Citation could not complete/);
  assert.equal(result.reviews[0]?.smartFindings?.[0]?.code, "COMPUTATION_EVIDENCE_VALUE_MISMATCH");
  assert.equal(result.reviews[0]?.citationTasks?.[0]?.attempts, 2);
});

test("Deep Citation queues every identifiable reference and retries only the failed one", async () => {
  const { cas, store, version } = fixture([
    "The first claim uses [1]; the second claim uses [2].",
    "[1] Alpha et al. (2020). PMID: 11111111",
    "[2] Beta et al. (2021). PMID: 22222222",
  ].join("\n"));
  const seen: string[] = [];
  const progress: Array<{ completed: number; failed: number; queued: number; running?: string; total: number }> = [];
  const attempts = new Map<string, number>();
  const result = await runReviewerCheckpoint({
    artifactVersionIds: [version.id],
    cas,
    onProgress: (item) => { progress.push(item); },
    parentRunId: "run-1",
    reason: "Queued citation review",
    reviewLevel: "deep",
    semanticReview: {
      citationSkillHash: "citation-v1",
      computationSkillHash: "computation-v1",
      execute: async (request) => {
        if (request.stage === "computation") return JSON.stringify({ computation: { findings: [], status: "COMPLETED" } });
        const key = request.citation!.key;
        const count = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, count);
        seen.push(`${key}:${count}`);
        if (key === "pmid:11111111" && count === 1) throw new Error("temporary gateway error");
        const locatorId = request.prompt.match(/locator:[a-f0-9]+/u)?.[0];
        assert.ok(locatorId);
        return JSON.stringify({ citation: {
          assessment: "SUPPORTED",
          findings: [],
          locatorIds: [locatorId],
          rationale: "The governed metadata matches the bounded citation claim.",
          status: "COMPLETED",
        } });
      },
      modelIdentity: "model-1",
      probeCitation: async (request) => ({ content: `Verified source ${request.citation?.key}.`, sourceId: request.citation?.key, status: "available" as const }),
    },
    sessionId: "session-1",
    store,
  });

  assert.deepEqual(seen, ["pmid:11111111:1", "pmid:11111111:2", "pmid:22222222:1"]);
  assert.equal(result.reviews[0]?.citationTasks?.length, 2);
  assert.equal(result.reviews[0]?.citationTasks?.[0]?.attempts, 2);
  assert.equal(progress.at(-1)?.completed, 2);
  assert.equal(progress.at(-1)?.failed, 0);
});

test("Deep Citation opens one provider cooldown circuit after a 429", async () => {
  const { cas, store, version } = fixture([
    "The first claim uses [1]; the second claim uses [2].",
    "[1] Alpha et al. (2020). PMID: 11111111",
    "[2] Beta et al. (2021). PMID: 22222222",
  ].join("\n"));
  let probes = 0;
  const result = await runReviewerCheckpoint({
    artifactVersionIds: [version.id],
    cas,
    parentRunId: "run-1",
    reason: "Citation provider cooldown",
    reviewLevel: "deep",
    semanticReview: {
      citationSkillHash: "citation-v1",
      computationSkillHash: "computation-v1",
      execute: async (request) => request.stage === "computation"
        ? JSON.stringify({ computation: { findings: [], status: "COMPLETED" } })
        : assert.fail("citation model must not run while provider is rate-limited"),
      modelIdentity: "model-1",
      probeCitation: async () => {
        probes += 1;
        throw new Error("Brave returned HTTP 429 Retry after the provider cooldown.");
      },
    },
    sessionId: "session-1",
    store,
  });

  assert.equal(probes, 1);
  assert.equal(result.reviews[0]?.smartStatus, "inconclusive");
  assert.deepEqual(result.reviews[0]?.citationTasks?.map((task) => task.status), ["inconclusive", "inconclusive"]);
  assert.deepEqual(result.reviews[0]?.citationTasks?.map((task) => task.attempts), [1, 0]);
});

test("Deep checkpoints serialize per Session and avoid concurrent duplicate model calls", async () => {
  const { cas, store, version } = fixture();
  let active = 0;
  let maximumActive = 0;
  let executions = 0;
  const semanticReview = {
    citationSkillHash: "citation-v1",
    computationSkillHash: "computation-v1",
    execute: async () => {
      executions += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      return JSON.stringify({
        citation: { findings: [], status: "COMPLETED" },
        computation: { findings: [], status: "COMPLETED" },
      });
    },
    modelIdentity: "model-1",
  };
  const options = {
    artifactVersionIds: [version.id],
    cas,
    parentRunId: "run-1",
    reason: "Concurrent Deep review",
    reviewLevel: "deep" as const,
    sessionId: "session-1",
    semanticReview,
    store,
    traceArtifactProvenance: async () => ({
      broken: false,
      chain: [],
      startNode: {
        contentHash: version.content.hash,
        excerpt: "analysis.md",
        id: "artifact-1#v1",
        label: "Artifact" as const,
      },
      truncated: false,
    }),
  };
  const [first, second] = await Promise.all([
    runReviewerCheckpoint(options),
    runReviewerCheckpoint({ ...options, parentRunId: "run-2" }),
  ]);

  assert.equal(executions, 1);
  assert.equal(maximumActive, 1);
  assert.equal(second.reviews[0]?.reusedFromReviewId, first.reviews[0]?.id);
});

test("Session cancellation aborts an active Deep Reviewer", async () => {
  const { cas, store, version } = fixture();
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  const review = runReviewerCheckpoint({
    artifactVersionIds: [version.id],
    cas,
    parentRunId: "run-1",
    reason: "Cancellable Deep review",
    reviewLevel: "deep",
    sessionId: "session-1",
    semanticReview: {
      citationSkillHash: "citation-v1",
      computationSkillHash: "computation-v1",
      execute: async (_input, signal) => {
        resolveStarted();
        return await new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("Review cancelled", "AbortError")), { once: true });
        });
      },
      modelIdentity: "model-1",
    },
    store,
    traceArtifactProvenance: async () => ({
      broken: false,
      chain: [],
      startNode: {
        contentHash: version.content.hash,
        excerpt: "analysis.md",
        id: "artifact-1#v1",
        label: "Artifact" as const,
      },
      truncated: false,
    }),
  });
  await started;
  assert.equal(cancelReviewerCheckpoints("session-1"), true);
  await assert.rejects(review, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  assert.equal(cancelReviewerCheckpoints("session-1"), false);
});
