// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import {
  citationSourceSnapshot,
  citationSourceUrl,
  hasExplicitLiteratureCitation,
} from "./citation-review.js";
import { reviewerQualityMetrics } from "./review-quality-metrics.js";

const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});

test("citation review resolves supported identifiers and bounds source snapshots", () => {
  assert.equal(citationSourceUrl({ key: "doi:10.1000/example", reference: "paper" } as never), "https://doi.org/10.1000/example");
  assert.equal(citationSourceUrl({ key: "pmid:12345", reference: "paper" } as never), "https://pubmed.ncbi.nlm.nih.gov/12345/");
  assert.equal(citationSourceUrl({ key: "url:https://example.test/a", reference: "paper" } as never), "https://example.test/a");
  assert.equal(citationSourceUrl({ key: "unknown:value", reference: "paper" } as never), undefined);
  const snapshot = citationSourceSnapshot("https://example.test", "x".repeat(20_000));
  assert.equal(snapshot.content!.length, 12_000);
  assert.equal(snapshot.status, "available");
  assert.equal(hasExplicitLiteratureCitation("See DOI: 10.1000/example"), true);
  assert.equal(hasExplicitLiteratureCitation("No source identifier"), false);
});

test("reviewer quality metrics distinguish located, inconclusive and unverifiable assessments", () => {
  const reviews = [
    {
      reviewLevel: "deep",
      createdAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      sourceAssessments: [
        { locators: [{ id: "loc-1" }], assessment: { assessment: "SUPPORTED", locatorIds: ["loc-1"] } },
        { locators: [], assessment: { assessment: "INCONCLUSIVE", locatorIds: [] } },
        { locators: [{ id: "loc-2" }], assessment: { assessment: "CONTRADICTED", locatorIds: ["missing"] } },
      ],
    },
    {
      reviewLevel: "deep",
      createdAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:03.000Z",
      sourceAssessments: [],
    },
  ] as never;
  assert.deepEqual(reviewerQualityMetrics(reviews), {
    deepP95Ms: 3000,
    deepReviewCount: 2,
    inconclusiveAssessmentCount: 1,
    locatorCoverage: 1 / 3,
    strongAssessmentCount: 2,
    strongAssessmentWithoutLocatorCount: 1,
    unverifiableContradictionCount: 1,
  });
});
