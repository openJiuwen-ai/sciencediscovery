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

import type { MemoryGraphTraceResult, ScientificArtifactVersion } from "@sciencediscovery/schema";
import type { MemoryGraphClient } from "../memory-graph.js";

import {
  artifactProvenanceReference,
  createEvidenceReferenceTracer,
  evidenceAliases,
  parseSmartComputationReview,
  quickComputationReview,
  quickEvidenceReferenceReview,
  quickNumericEvidenceCoverageReview,
  type EvidenceReferenceTraceResult,
} from "./computation-review.js";

function version(overrides: Partial<ScientificArtifactVersion> = {}): ScientificArtifactVersion {
  return {
    artifactId: "artifact-1",
    content: { hash: "content-hash-1", size: 32 },
    createdAt: "2026-08-03T00:00:00.000Z",
    executionRunIds: [],
    id: "artifact-version-1",
    inputArtifactVersionIds: [],
    mediaType: "text/markdown",
    projectId: "project-1",
    sessionId: "session-1",
    version: 3,
    ...overrides,
  };
}

function completeTrace(overrides: Partial<MemoryGraphTraceResult> = {}): MemoryGraphTraceResult {
  return {
    broken: false,
    chain: [{
      hop: 1,
      isTerminal: true,
      node: { excerpt: "Research goal", id: "goal-1", label: "ResearchGoal" },
      viaEdge: "next",
    }],
    reason: "reached terminal node ResearchGoal",
    startNode: {
      contentHash: "content-hash-1",
      excerpt: "report.md",
      id: "artifact-1#v3",
      label: "Artifact",
    },
    truncated: false,
    ...overrides,
  };
}

test("Quick computation review derives a version-pinned reference from the Artifact", () => {
  assert.deepEqual(artifactProvenanceReference(version()), {
    artifactId: "artifact-1",
    artifactVersion: 3,
    provenanceRef: "artifact-1#v3",
  });
});

test("Quick computation review checks every Artifact without classifying its content", async () => {
  let reference: unknown;
  const result = await quickComputationReview(
    version({ mediaType: "image/png" }),
    async (input) => {
      reference = input;
      return completeTrace();
    },
  );
  assert.deepEqual(reference, {
    artifactId: "artifact-1",
    artifactVersion: 3,
    provenanceRef: "artifact-1#v3",
  });
  assert.deepEqual(result.findings, []);
});

test("Quick computation review reports numeric claims cited without an Evidence mapping", () => {
  const findings = quickNumericEvidenceCoverageReview(
    Buffer.from("TP53 mutation frequency was 39.7% [1].\n\n[1] Example et al. (2024). PMID: 12345678"),
    version(),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.code, "COMPUTATION_NUMERIC_CLAIM_EVIDENCE_MISSING");
  assert.match(findings[0]?.message ?? "", /39\.7%/u);
});

test("Quick computation review accepts a numeric claim with a local Evidence mapping", () => {
  const findings = quickNumericEvidenceCoverageReview(
    Buffer.from("TP53 mutation frequency was 39.7% [1] [ev1]."),
    version(),
  );
  assert.deepEqual(findings, []);
});

test("Quick computation review accepts a numeric claim carrying the full-name [evidenceN] alias", () => {
  // The evidenceMarker regex must recognize [evidenceN] as well as [evN],
  // otherwise a sentence that already carries its Evidence mapping is
  // misreported as COMPUTATION_NUMERIC_CLAIM_EVIDENCE_MISSING.
  const findings = quickNumericEvidenceCoverageReview(
    Buffer.from("TP53 mutation frequency was 39.7% [evidence1]."),
    version(),
  );
  assert.deepEqual(findings, []);
});

test("Quick computation review accepts a numeric claim linked to a generated-data Artifact", () => {
  const findings = quickNumericEvidenceCoverageReview(
    Buffer.from("TP53 mutation frequency was 39.7% [artifact1]."),
    version({ references: [{ id: "generated-data-1", kind: "artifact", label: "artifact1" }] }),
  );
  assert.deepEqual(findings, []);
});

test("Quick computation review reports a numeric claim without any traceable support", () => {
  const findings = quickNumericEvidenceCoverageReview(
    Buffer.from("TP53 mutation frequency was 39.7%."),
    version(),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.code, "COMPUTATION_NUMERIC_CLAIM_UNSUPPORTED");
});

test("Quick computation review reports an unresolved generated-data alias", () => {
  const findings = quickNumericEvidenceCoverageReview(
    Buffer.from("TP53 mutation frequency was 39.7% [artifact1]."),
    version(),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.code, "COMPUTATION_NUMERIC_CLAIM_PROVENANCE_UNRESOLVED");
});

test("Quick computation review does not treat a publication year as a numeric claim", () => {
  const findings = quickNumericEvidenceCoverageReview(
    Buffer.from("The 2024 study reported this association [1]."),
    version(),
  );
  assert.deepEqual(findings, []);
});

test("Quick computation review ignores Markdown headings and quoted source text", () => {
  const findings = quickNumericEvidenceCoverageReview(
    Buffer.from([
      "### 3.1 Direct frequency values",
      "> \"TP53 is frequently mutated in about 60% of cancers.\"",
      "The measured TP53 mutation frequency was 39.7%.",
    ].join("\n")),
    version(),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.code, "COMPUTATION_NUMERIC_CLAIM_UNSUPPORTED");
  assert.match(findings[0]?.message ?? "", /39\.7%/u);
});

test("Quick computation review reports missing and broken Artifact provenance", async () => {
  const missing = await quickComputationReview(
    version(),
    async () => completeTrace({
      broken: true,
      chain: [],
      reason: "start_node_not_found",
      startNode: null,
    }),
  );
  assert.equal(missing.findings[0]?.code, "COMPUTATION_PROVENANCE_MARKER_MISSING");

  const broken = await quickComputationReview(
    version(),
    async () => completeTrace({ broken: true, reason: "no upstream of Code #code-1" }),
  );
  assert.equal(broken.findings[0]?.code, "COMPUTATION_PROVENANCE_CHAIN_INCOMPLETE");
  assert.equal(broken.findings[0]?.severity, "critical");
});

test("Quick computation review distinguishes graph unavailability from a bad Artifact", async () => {
  const result = await quickComputationReview(
    version(),
    async () => completeTrace({
      broken: true,
      chain: [],
      reason: "memory_graph_unreachable",
      startNode: null,
    }),
  );
  assert.equal(result.findings[0]?.code, "COMPUTATION_PROVENANCE_QUERY_FAILED");
  assert.equal(result.findings[0]?.severity, "warning");

  const thrown = await quickComputationReview(
    version(),
    async () => { throw new Error("temporary graph failure"); },
  );
  assert.equal(thrown.findings[0]?.code, "COMPUTATION_PROVENANCE_QUERY_FAILED");
});

test("Quick computation review accepts an older node from the same Artifact version lineage", async () => {
  const result = await quickComputationReview(
    version(),
    async () => completeTrace({
      startNode: {
        contentHash: "older-content-hash",
        excerpt: "report.md",
        id: "artifact-1#v2",
        label: "Artifact",
      },
    }),
  );
  assert.deepEqual(result.findings, []);
});

test("Quick computation review rejects a trace for a different Artifact", async () => {
  const result = await quickComputationReview(
    version(),
    async () => completeTrace({
      startNode: {
        contentHash: "content-hash-1",
        excerpt: "other-report.md",
        id: "artifact-2#v3",
        label: "Artifact",
      },
    }),
  );
  assert.equal(result.findings[0]?.code, "COMPUTATION_PROVENANCE_MARKER_INVALID");
});

test("Quick computation review still validates the exact Artifact version hash", async () => {
  const wrongContent = await quickComputationReview(
    version(),
    async () => completeTrace({
      startNode: {
        contentHash: "older-content-hash",
        excerpt: "report.md",
        id: "artifact-1#v3",
        label: "Artifact",
      },
    }),
  );
  assert.equal(wrongContent.findings[0]?.code, "COMPUTATION_RESULT_VERSION_MISMATCH");
});

test("Quick computation review stops before graph access when cancelled", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    quickComputationReview(
      version(),
      async () => completeTrace(),
      controller.signal,
    ),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
});

test("Quick computation review stops promptly when cancellation happens during graph access", async () => {
  const controller = new AbortController();
  const pending = quickComputationReview(
    version(),
    async () => new Promise<MemoryGraphTraceResult>(() => {}),
    controller.signal,
  );
  controller.abort();
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
});

const evidenceContent = Buffer.from("Claim [ev1], repeated [EV1], and another source [ev2].");

test("Quick computation review extracts unique case-insensitive Evidence aliases", () => {
  assert.deepEqual(evidenceAliases(evidenceContent), ["ev1", "ev2"]);
});

test("Quick computation review extracts full-name [evidenceN] aliases alongside legacy [evN]", () => {
  assert.deepEqual(evidenceAliases(Buffer.from("Claim [evidence1], legacy [ev2], mixed [EV3].")), ["evidence1", "ev2", "ev3"]);
});

test("Quick computation review reports an Artifact alias without a persisted Evidence mapping", async () => {
  const result = await quickEvidenceReferenceReview(
    Buffer.from("Claim [ev1]."),
    version(),
  );
  assert.equal(result.findings[0]?.code, "CITATION_EVIDENCE_ALIAS_UNRESOLVED");
});

test("Quick computation review distinguishes missing Evidence nodes and broken Paper links", async () => {
  const artifactVersion = version({
    references: [
      { id: "evidence-1", kind: "evidence", label: "ev1" },
      { id: "evidence-2", kind: "evidence", label: "ev2" },
    ],
  });
  const traces: Record<string, EvidenceReferenceTraceResult> = {
    "evidence-1": { evidenceFound: false, paperLinked: false },
    "evidence-2": { evidenceFound: true, paperLinked: false },
  };
  const result = await quickEvidenceReferenceReview(
    evidenceContent,
    artifactVersion,
    async ({ evidenceId }) => traces[evidenceId]!,
  );

  assert.deepEqual(result.findings.map((item) => item.code), [
    "CITATION_EVIDENCE_NODE_MISSING",
    "CITATION_EVIDENCE_CHAIN_BROKEN",
  ]);
});

test("Quick computation review passes Evidence nodes linked to Papers", async () => {
  const artifactVersion = version({
    references: [{ id: "evidence-1", kind: "evidence", label: "ev1" }],
  });
  const result = await quickEvidenceReferenceReview(
    Buffer.from("Claim [ev1]."),
    artifactVersion,
    async () => ({ evidenceFound: true, paperLinked: true }),
  );

  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.evidenceIds, ["evidence-1"]);
});

test("Quick computation review marks unavailable or truncated Evidence queries as inconclusive", async () => {
  const artifactVersion = version({
    references: [{ id: "evidence-1", kind: "evidence", label: "ev1" }],
  });
  const result = await quickEvidenceReferenceReview(
    Buffer.from("Claim [ev1]."),
    artifactVersion,
    async () => ({
      evidenceFound: true,
      paperLinked: false,
      reason: "memory_graph_unreachable",
      truncated: true,
    }),
  );

  assert.equal(result.findings[0]?.code, "CITATION_EVIDENCE_QUERY_FAILED");
});

test("Quick computation Evidence tracer reuses one extracts edge query", async () => {
  let edgeQueries = 0;
  const client = {
    byEdgeType: async () => {
      edgeQueries += 1;
      return {
        // extracts runs Paper → Evidence: Paper is the source, Evidence the
        // target (the inverse of the old extracted_from direction).
        edges: [
          { source: "paper-1", target: "evidence-1", type: "extracts" as const },
          { source: "paper-1", target: "evidence-2", type: "extracts" as const },
        ],
        // Both Evidence endpoints + the Paper endpoint are returned by the
        // by-edge-type query (it de-dups both edge endpoints), so the tracer
        // finds each Evidence node here instead of a separate getNode call.
        nodes: [
          { id: "evidence-1", label: "Evidence" as const },
          { id: "evidence-2", label: "Evidence" as const },
          { id: "paper-1", label: "Paper" as const },
        ],
        total: 2,
        truncated: false,
      };
    },
  } as unknown as MemoryGraphClient;
  const trace = createEvidenceReferenceTracer(client, "session-1");

  assert.equal((await trace({ alias: "ev1", evidenceId: "evidence-1" })).paperLinked, true);
  assert.equal((await trace({ alias: "ev2", evidenceId: "evidence-2" })).paperLinked, true);
  assert.equal(edgeQueries, 1);
});

test("Deep computation review validates value mismatches inside the Computation capability", () => {
  const result = parseSmartComputationReview({
    findings: [{
      code: "COMPUTATION_VALUE_MISMATCH",
      evidenceAliases: ["ev1", "unknown"],
      message: "The Artifact states 61%, while the linked Evidence states 39.7%.",
      severity: "critical",
    }],
    status: "COMPLETED",
  }, version({ id: "version-1" }), new Set(["ev1"]));

  assert.equal(result.inconclusive, false);
  assert.equal(result.findings[0]?.code, "COMPUTATION_VALUE_MISMATCH");
  assert.deepEqual(result.findings[0]?.evidenceRefs, ["artifact:version-1", "evidence-alias:ev1"]);
});
