import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";


import { reviewerQualityMetrics } from "@sciencediscovery/provenance";
import type { ArtifactReviewRun } from "@sciencediscovery/schema";

test("Reviewer quality metrics expose locator safety and Deep P95 without source text", () => {
  const review = {
    createdAt: "2026-09-10T00:00:00.000Z", finishedAt: "2026-09-10T00:00:02.000Z", reviewLevel: "deep",
    sourceAssessments: [{
      assessment: { assessment: "CONTRADICTED", claimId: "c", locatorIds: ["l"], policyVersion: "1", rationale: "bounded" },
      claim: { artifactVersionId: "v", citationKeys: [], id: "c", kind: "computation", requiredEvidenceLevel: "E4", text: "claim" },
      locators: [{ id: "l" }], snapshots: [],
    }, {
      assessment: { assessment: "INCONCLUSIVE", claimId: "d", locatorIds: [], policyVersion: "1", rationale: "missing" },
      claim: { artifactVersionId: "v", citationKeys: [], id: "d", kind: "citation", requiredEvidenceLevel: "E2", text: "claim" }, locators: [], snapshots: [],
    }],
  } as unknown as ArtifactReviewRun;
  assert.deepEqual(reviewerQualityMetrics([review]), {
    deepP95Ms: 2_000, deepReviewCount: 1, inconclusiveAssessmentCount: 1,
    locatorCoverage: 0.5, strongAssessmentCount: 1, strongAssessmentWithoutLocatorCount: 0, unverifiableContradictionCount: 0,
  });
});
