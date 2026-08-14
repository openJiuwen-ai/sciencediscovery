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

import type {
  ArtifactReviewRun,
  ScientificArtifact,
  ScientificArtifactVersion,
} from "@science-agent/schema";

import type { CasStore } from "@science-agent/cas";
import type { SessionStore } from "../store.js";
import {
  cancelReviewerCheckpoints,
  reviewerCheckpointPromptContent,
  runReviewerCheckpoint,
} from "./review-checkpoint.js";

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
  assert.match(content, /correct applicable findings/);
  const partial = reviewerCheckpointPromptContent(result.reviews, undefined, true);
  assert.match(partial, /Status: PARTIAL/);
  assert.match(partial, /available for the next main-Agent action/);
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
      return JSON.stringify({ citation: {
        findings: [{
          code: "CITATION_CLAIM_NOT_SUPPORTED",
          evidenceAliases: [],
          message: "The cited paper metadata does not establish the stated measurement.",
          severity: "warning",
        }],
        status: "COMPLETED",
      } });
    },
    modelIdentity: "model-1",
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

test("Deep review keeps structured source Artifacts on Quick checks", async () => {
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
  assert.equal(provenanceTraces, 1);
  assert.equal(result.reviews[0]?.reviewLevel, "quick");
  assert.deepEqual(result.reviews[0]?.checks, ["structure", "computation"]);
  assert.deepEqual(result.reviews[0]?.findings, []);
});

test("Quick review reports malformed JSON without running narrative checks", async () => {
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

  assert.deepEqual(result.reviews[0]?.checks, ["structure"]);
  assert.equal(result.reviews[0]?.decision, "REVISE_AND_RETRY");
  assert.deepEqual(result.reviews[0]?.findings.map((finding) => finding.code), ["ARTIFACT_JSON_INVALID"]);
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
        return JSON.stringify({ citation: { findings: [], status: "COMPLETED" } });
      },
      modelIdentity: "model-1",
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
